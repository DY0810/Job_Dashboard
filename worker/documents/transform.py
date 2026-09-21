#!/usr/bin/env python3
"""Bounded document transform helper. Paths are created by the Node caller."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

MAX_BYTES = 10 * 1024 * 1024
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def fail(message: str) -> None:
    raise RuntimeError(message)


def safe_path(value: Any) -> Path:
    if not isinstance(value, str) or not os.path.isabs(value) or "\x00" in value:
        fail("invalid path")
    path = Path(value)
    if path.is_symlink():
        fail("symlink path")
    return path


def safe_zip_name(name: str) -> None:
    folded = name.lower()
    if (
        not name
        or name.startswith("/")
        or "\\" in name
        or any(part in ("", ".", "..") for part in name.split("/"))
        or "\x00" in name
        or any(token in folded for token in ("vbaproject", "macros", "embeddings", "activex"))
        or not re.search(r"\.(xml|rels|png|jpe?g|gif|webp|odttf)$", folded)
    ):
        fail("unsafe OOXML package")


def read_zip(path: Path) -> dict[str, bytes]:
    try:
        with zipfile.ZipFile(path) as archive:
            infos = archive.infolist()
            if len(infos) < 3 or len(infos) > 256:
                fail("unsupported OOXML package")
            files: dict[str, bytes] = {}
            for info in infos:
                safe_zip_name(info.filename)
                if info.filename in files or info.flag_bits & 1 or info.file_size > 8 * 1024 * 1024:
                    fail("unsafe OOXML entry")
                if info.compress_size and info.file_size > max(1024 * 1024, info.compress_size * 200):
                    fail("compressed OOXML expansion")
                value = archive.read(info)
                if len(value) != info.file_size:
                    fail("truncated OOXML entry")
                files[info.filename] = value
    except (zipfile.BadZipFile, OSError) as error:
        fail(f"invalid OOXML package: {error}")
    if "[Content_Types].xml" not in files or "_rels/.rels" not in files or "word/document.xml" not in files:
        fail("missing OOXML document parts")
    return files


def xml_root(data: bytes) -> ET.Element:
    if b"<!DOCTYPE" in data or b"<!ENTITY" in data or b"<?xml-stylesheet" in data:
        fail("unsafe XML")
    try:
        return ET.fromstring(data)
    except ET.ParseError as error:
        fail(f"invalid XML: {error}")


def relationships(files: dict[str, bytes]) -> list[str]:
    targets: list[str] = []
    for name, data in files.items():
        if not name.lower().endswith(".rels"):
            continue
        root = xml_root(data)
        for rel in root.findall("{http://schemas.openxmlformats.org/package/2006/relationships}Relationship"):
            target = rel.attrib.get("Target", "")
            mode = rel.attrib.get("TargetMode")
            if mode == "External":
                if not (target.startswith("https://") or target.startswith("mailto:")) or any(c in target for c in "\x00\r\n"):
                    fail("unsafe external relationship")
                targets.append(target)
            elif ":" in target or target.startswith("//") or "\\" in target:
                fail("unsafe OOXML relationship")
    return targets


def document_text(root: ET.Element) -> tuple[str, list[dict[str, Any]]]:
    paragraphs: list[dict[str, Any]] = []
    for index, paragraph in enumerate(root.iter(f"{W}p")):
        text_nodes = list(paragraph.iter(f"{W}t"))
        text = "".join(node.text or "" for node in text_nodes)
        if not text:
            continue
        if any(node.tag in {f"{W}fldSimple", f"{W}instrText", f"{W}object", f"{W}altChunk"} for node in paragraph.iter()):
            fail("unsupported OOXML field")
        paragraphs.append({"id": f"paragraph-{index}", "text": text, "kind": "paragraph", "maxChars": len(text)})
    return "\n".join(item["text"] for item in paragraphs), paragraphs


def inspect_docx(path: Path) -> dict[str, Any]:
    files = read_zip(path)
    links = relationships(files)
    root = xml_root(files["word/document.xml"])
    text, anchors = document_text(root)
    fonts: list[str] = []
    if "word/fontTable.xml" in files:
        font_root = xml_root(files["word/fontTable.xml"])
        fonts = sorted({value for element in font_root.iter() if element.tag == f"{W}font" for value in [element.attrib.get(f"{W}name", "")] if value})
    return {
        "format": "docx", "text": text, "anchors": anchors, "links": links,
        "fonts": fonts, "fontDetails": fonts, "pageGeometry": ["docx:1"], "pageCount": 1,
    }


def command(name: str, args: list[str], timeout: float = 8.0) -> str:
    with tempfile.TemporaryDirectory(prefix="workie-doc-home-") as home:
        try:
            result = subprocess.run([name, *args], check=True, capture_output=True, timeout=timeout, env={
                "PATH": os.environ.get("PATH", ""), "HOME": home,
                "LC_ALL": "C", "LANG": "C",
            })
        except (OSError, subprocess.SubprocessError) as error:
            fail(f"{name} unavailable: {error}")
    return result.stdout.decode("utf-8", "replace")


def inspect_pdf(path: Path) -> dict[str, Any]:
    info = command("pdfinfo", [str(path)])
    pages_match = re.search(r"^Pages:\s+(\d+)$", info, re.MULTILINE)
    if not pages_match:
        fail("PDF page count unavailable")
    text = command("pdftotext", ["-layout", str(path), "-"])
    links: list[str] = []
    font_details = []
    for line in command("pdffonts", [str(path)]).splitlines()[2:]:
        parts = line.split()
        if parts:
            font_details.append(" ".join(parts))
    fonts = sorted({line.split()[0] for line in font_details})
    if not text.strip() or not fonts:
        fail("unsupported PDF: missing extracted text or fonts")
    anchors = []
    for index, line in enumerate(text.splitlines()):
        clean = line.strip()
        if clean:
            anchors.append({"id": f"line-{index}", "text": clean, "kind": "line", "maxChars": len(clean)})
    return {
        "format": "pdf", "text": text, "anchors": anchors, "links": links,
        "fonts": fonts, "fontDetails": font_details,
        "pageGeometry": [line.strip() for line in info.splitlines() if line.startswith("Page size:")],
        "pageCount": int(pages_match.group(1)),
    }


def inspect(path: Path, fmt: str) -> dict[str, Any]:
    if not path.is_file() or path.stat().st_size < 1 or path.stat().st_size > MAX_BYTES:
        fail("document size is outside the supported bound")
    if fmt == "docx":
        return inspect_docx(path)
    if fmt == "pdf":
        return inspect_pdf(path)
    fail("unsupported document format")


def replace_paragraph(root: ET.Element, anchor: str, replacement: str) -> bool:
    for paragraph in root.iter(f"{W}p"):
        nodes = list(paragraph.iter(f"{W}t"))
        full = "".join(node.text or "" for node in nodes)
        start = full.find(anchor)
        if start < 0:
            continue
        end = start + len(anchor)
        position = 0
        first = True
        for node in nodes:
            value = node.text or ""
            node_start, node_end = position, position + len(value)
            if node_end <= start or node_start >= end:
                position = node_end
                continue
            before = value[:max(0, start - node_start)] if first else ""
            after = value[min(len(value), end - node_start):] if node_end >= end else ""
            if first:
                node.text = before + replacement + after
                first = False
            else:
                node.text = after
            position = node_end
        return True
    return False


def normalized_text(value: str) -> str:
    return " ".join(value.split())


def pdf_signature(value: dict[str, Any]) -> tuple[Any, ...]:
    return (
        value["pageCount"], value["pageGeometry"], value["fonts"],
        value["fontDetails"], value["links"],
    )


def render_docx(input_path: Path, render_dir: Path) -> Path:
    render_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    command("soffice", [
        "--headless", "--norestore", "--nofirststartwizard", "--nodefault", "--nolockcheck",
        "--convert-to", "pdf", "--outdir", str(render_dir), str(input_path),
    ], 12.0)
    candidate = render_dir / f"{input_path.stem}.pdf"
    if not candidate.is_file():
        fail("DOCX render did not produce a PDF")
    return candidate


def transform_docx(input_path: Path, output_path: Path, edits: list[dict[str, Any]], reference: str | None) -> dict[str, Any]:
    files = read_zip(input_path)
    root = xml_root(files["word/document.xml"])
    if reference:
        source_pdf = render_docx(input_path, output_path.parent / "source-rendered")
        source_info = inspect_pdf(source_pdf)
        reference_info = inspect_pdf(safe_path(reference))
        if (
            pdf_signature(source_info) != pdf_signature(reference_info)
            or normalized_text(source_info["text"]) != normalized_text(reference_info["text"])
        ):
            fail("DOCX source does not match reference PDF")
    for edit in edits:
        anchor = edit["anchorText"]
        replacement = edit["replacement"]
        if len(replacement) > len(anchor) or "\n" in replacement or "\r" in replacement:
            fail("DOCX edit does not fit its allocated anchor")
        if not replace_paragraph(root, anchor, replacement):
            fail("DOCX anchor was not found")
    files["word/document.xml"] = ET.tostring(root, encoding="utf-8", xml_declaration=True)
    output_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with zipfile.ZipFile(output_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in files.items():
            archive.writestr(name, data)
    rendered = None
    if reference:
        candidate = render_docx(output_path, output_path.parent / "rendered")
        output_info = inspect_pdf(candidate)
        source_info = inspect_pdf(output_path.parent / "source-rendered" / f"{input_path.stem}.pdf")
        if pdf_signature(output_info) != pdf_signature(source_info):
            fail("DOCX output changed fixed layout resources")
        rendered = str(candidate)
    return {"rendered": rendered}


def pdf_literal(value: str) -> bytes:
    if any(ord(char) < 32 or ord(char) > 126 for char in value):
        fail("PDF edit requires printable ASCII")
    return value.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)").encode("ascii")


def transform_pdf(input_path: Path, output_path: Path, edits: list[dict[str, Any]]) -> dict[str, Any]:
    data = input_path.read_bytes()
    for edit in edits:
        anchor = pdf_literal(edit["anchorText"])
        replacement = pdf_literal(edit["replacement"])
        if len(anchor) != len(replacement):
            fail("PDF edit changes literal width")
        needle = b"(" + anchor + b")"
        offset = data.find(needle)
        if offset < 0:
            fail("PDF anchor was not found")
        data = data[: offset + 1] + replacement + data[offset + 1 + len(anchor):]
    output_path.write_bytes(data)
    return {"rendered": None}


def main() -> None:
    request = json.load(sys.stdin)
    operation = request.get("operation")
    input_path = safe_path(request.get("input"))
    fmt = request.get("format")
    if operation == "inspect":
        result = inspect(input_path, fmt)
    elif operation == "transform":
        output_path = safe_path(request.get("output"))
        edits = request.get("edits")
        if not isinstance(edits, list) or len(edits) > 64:
            fail("invalid edit list")
        if fmt == "docx":
            result = transform_docx(input_path, output_path, edits, request.get("reference"))
        elif fmt == "pdf":
            result = transform_pdf(input_path, output_path, edits)
        else:
            fail("unsupported document format")
    else:
        fail("invalid operation")
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # JSON-in/result-out: errors are nonzero and never include document bytes.
        print(json.dumps({"error": str(error)}, separators=(",", ":")), file=sys.stderr)
        sys.exit(1)
