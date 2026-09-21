import { parentPort, workerData } from 'node:worker_threads';
import { posix } from 'node:path';
import { crc32 } from 'node:zlib';
import pdf from 'pdf-lib';
import pdfPackage from 'pdf-lib/package.json' with { type: 'json' };
import decodeStreamModule from 'pdf-lib/cjs/core/streams/DecodeStream.js';
import flateStreamModule from 'pdf-lib/cjs/core/streams/FlateStream.js';
import decodeModule from 'pdf-lib/cjs/core/streams/decode.js';
import byteStreamModule from 'pdf-lib/cjs/core/parser/ByteStream.js';
import objectParserModule from 'pdf-lib/cjs/core/parser/PDFObjectParser.js';
import xrefParserModule from 'pdf-lib/cjs/core/parser/PDFXRefStreamParser.js';
import zip from 'yauzl';
import sax from 'sax';

// Static, traced worker: no document-controlled code, imports, filesystem reads,
// network requests or rendering. Worker resourceLimits bound V8, NOT ArrayBuffers
// or RSS. These pre-allocation limits bound the pinned parser's binary expansion.
export function installPdfBounds() {
  if (pdfPackage.version !== '1.17.1') throw new Error('Unqualified PDF parser version');
  const { default: DecodeStream } = decodeStreamModule;
  const { default: FlateStream } = flateStreamModule;
  const { default: ByteStream } = byteStreamModule;
  const { default: ObjectParser } = objectParserModule;
  const { default: XRefParser } = xrefParserModule;
  let allocated = 0, decoders = 0, objects = 0, depth = 0;
  const reserve = (size) => {
    if (!Number.isSafeInteger(size) || size < 0 || allocated + size > 32 * 1024 * 1024) {
      throw new Error('PDF allocation budget exceeded');
    }
    allocated += size;
  };
  // pdf-lib 1.17.1 contract (hash-pinned in tests): Flate, LZW, ASCII85,
  // ASCIIHex and RunLength ALL grow output through this inherited method,
  // including chained filters, ObjStm and XRef during PDFDocument.load().
  // Charge full replacement buffers, not deltas: GC is never part of the bound.
  const ensureBuffer = DecodeStream.prototype.ensureBuffer;
  DecodeStream.prototype.ensureBuffer = function (requested) {
    if (!Number.isSafeInteger(requested) || requested < 0 || requested > 8 * 1024 * 1024 ||
      this.minBufferLength !== 512) throw new Error('PDF stream limit exceeded');
    if (requested > this.buffer.byteLength) {
      let size = 512;
      while (size < requested) size *= 2;
      reserve(size);
    }
    return ensureBuffer.call(this, requested);
  };
  // The only variable auxiliary typed-array allocation in these decoders is
  // Flate's Huffman table (max 15-bit codes). Include per-block scratch arrays.
  const huffman = FlateStream.prototype.generateHuffmanTable;
  FlateStream.prototype.generateHuffmanTable = function (lengths) {
    let max = 0;
    for (const length of lengths) {
      if (length > 15) throw new Error('Invalid PDF Huffman code');
      max = Math.max(max, length);
    }
    reserve(4 * 2 ** max + 512);
    return huffman.call(this, lengths);
  };
  const decode = decodeModule.decodePDFRawStream;
  decodeModule.decodePDFRawStream = (raw) => {
    const filter = raw.dict.lookup(pdf.PDFName.of('Filter'));
    const count = filter instanceof pdf.PDFArray ? filter.size() : filter ? 1 : 0;
    decoders += Math.max(1, count);
    if (count > 8 || decoders > 128) throw new Error('PDF decoder limit exceeded');
    // LZW's fixed dictionaries total 24 KiB; ASCII85 uses 5 bytes.
    reserve(count * 32 * 1024);
    if (raw.dict.lookup(pdf.PDFName.of('Type')) === pdf.PDFName.of('ObjStm')) {
      const n = raw.dict.lookup(pdf.PDFName.of('N'), pdf.PDFNumber).asNumber();
      if (!Number.isSafeInteger(n) || n < 0 || n > 200_000) throw new Error('PDF object limit exceeded');
    }
    return decode(raw);
  };
  // Raw streams are copied from input/decoded bytes, including nested streams.
  const slice = ByteStream.prototype.slice;
  ByteStream.prototype.slice = function (start, end) {
    reserve(this.bytes.subarray(start, end).byteLength);
    return slice.call(this, start, end);
  };
  const parseObject = ObjectParser.prototype.parseObject;
  ObjectParser.prototype.parseObject = function () {
    if (++objects > 200_000 || ++depth > 64) throw new Error('PDF object limit exceeded');
    try { return parseObject.call(this); } finally { depth--; }
  };
  const parseEntries = XRefParser.prototype.parseEntries;
  XRefParser.prototype.parseEntries = function () {
    for (const { length } of this.subsections) {
      if (!Number.isSafeInteger(length) || length < 0 || (objects += length) > 200_000) {
        throw new Error('PDF xref limit exceeded');
      }
    }
    if (this.byteWidths.some((n) => !Number.isInteger(n) || n < 0 || n > 8)) throw new Error('Invalid PDF xref width');
    return parseEntries.call(this);
  };
  return () => ({ allocated, decoders, objects });
}

async function inspectDocument(bytes, mime, modules) {
  const fail = () => { throw new Error('Unsafe or unsupported document.'); };
  const safeLink = (value) => {
    if (/[\x00-\x20\x7f\\]/.test(value)) return false;
    try {
      const url = new URL(value);
      return !url.username && !url.password && ((url.protocol === 'https:' && Boolean(url.hostname)) ||
        (url.protocol === 'mailto:' && Boolean(url.pathname) && !url.search && !url.hash));
    } catch { return false; }
  };
  if (mime === 'application/pdf') {
    const { PDFDocument, PDFDict, PDFArray, PDFName, PDFRawStream, PDFInvalidObject, PDFString, PDFHexString } = modules.pdf;
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: false, throwOnInvalidObject: true, updateMetadata: false });
    if (pdf.isEncrypted || pdf.getPageCount() < 1 || pdf.getPageCount() > 100) fail();
    const forbidden = new Set(['JS', 'JavaScript', 'OpenAction', 'AA', 'Launch', 'RichMedia', 'EmbeddedFiles',
      'EF', 'XFA', 'AcroForm', 'Collection', 'Sound', 'Movie', '3D', 'SubmitForm', 'ImportData', 'GoToR', 'GoToE']);
    const pending = pdf.context.enumerateIndirectObjects().map(([, object]) => object);
    const visited = new Set();
    let nodes = 0;
    while (pending.length) {
      const item = pending.pop();
      if (!item || visited.has(item)) continue;
      visited.add(item);
      if (++nodes > 200_000) fail();
      if (item instanceof PDFInvalidObject) fail();
      if (item instanceof PDFRawStream) {
        if (item.dict.has(PDFName.of('F'))) fail();
        pending.push(item.dict);
      } else if (item instanceof PDFDict) {
        for (const [key, value] of item.entries()) {
          const name = key.decodeText();
          if (forbidden.has(name)) fail();
          const resolved = pdf.context.lookup(value);
          if (name === 'URI') {
            if (!(resolved instanceof PDFString || resolved instanceof PDFHexString) ||
              resolved.asString().length > 8192 || !safeLink(resolved.decodeText())) fail();
          }
          if (name === 'Type' && resolved instanceof PDFName && resolved.decodeText() === 'Filespec') fail();
          if (name === 'Subtype' && resolved instanceof PDFName &&
            ['Widget', 'FileAttachment', 'RichMedia', 'Screen', 'Movie', 'Sound', '3D'].includes(resolved.decodeText())) fail();
          if (name === 'S' && resolved instanceof PDFName && forbidden.has(resolved.decodeText())) fail();
          pending.push(resolved);
        }
      } else if (item instanceof PDFArray) {
        for (const child of item.asArray()) pending.push(pdf.context.lookup(child));
      }
    }
    return;
  }
  if (mime !== 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') fail();
  const files = new Map();
  const names = new Set();
  let expanded = 0;
  let completed = 0;
  // Read the authoritative central directory first. Actual data is streamed
  // one entry at a time through bounded zlib chunks, never fflate's eager output.
  const archive = await modules.zip.fromBufferPromise(
    Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
  );
  try {
    if (archive.entryCount < 3 || archive.entryCount > 256) fail();
    for await (const file of archive.eachEntry()) {
      const name = file.fileName;
      // Supported-format limit: no Unicode-path aliases, even if an alias agrees.
      // Use yauzl's raw-name decoder and local-header reader, not ZIP offsets.
      if (file.extraFields.some((field) => field.id === 0x7075) ||
        modules.zip.getFileNameLowLevel(file.generalPurposeBitFlag, file.fileNameRaw, [], true) !== name) fail();
      const local = await archive.readLocalFileHeaderPromise(file);
      if (modules.zip.parseExtraFields(local.extraField).some((field) => field.id === 0x7075) ||
        !local.fileName.equals(file.fileNameRaw) ||
        local.generalPurposeBitFlag !== file.generalPurposeBitFlag ||
        local.compressionMethod !== file.compressionMethod ||
        modules.zip.getFileNameLowLevel(local.generalPurposeBitFlag, local.fileName, [], true) !== name) fail();
      const folded = name.normalize('NFC').toLowerCase();
      if (++completed > 256 || !name || names.has(folded) || name !== name.normalize('NFC') ||
        name.startsWith('/') || /[\\:%\x00-\x1f\x7f]/.test(name) ||
        name.split('/').some((part) => !part || part === '.' || part === '..') ||
        /(?:vbaproject|macros|embeddings|activex|customui)/i.test(name) ||
        !/\.(xml|rels|png|jpe?g|gif|webp|odttf)$/i.test(name) ||
        (file.compressionMethod !== 0 && file.compressionMethod !== 8) || file.isEncrypted() ||
        file.uncompressedSize > 8 * 1024 * 1024 ||
        file.uncompressedSize > Math.max(1024 * 1024, file.compressedSize * 200)) fail();
      names.add(folded);
      const chunks = [];
      let size = 0, checksum = 0;
      const stream = await archive.openReadStreamPromise(file);
      for await (const data of stream) {
        size += data.length;
        expanded += data.length;
        if (size > 8 * 1024 * 1024 || expanded > 30 * 1024 * 1024 ||
          expanded > Math.max(1024 * 1024, bytes.length * 200) ||
          size > Math.max(1024 * 1024, file.compressedSize * 200)) fail();
        checksum = crc32(data, checksum);
        chunks.push(data);
      }
      if (size !== file.uncompressedSize || checksum !== file.crc32) fail();
      files.set(name, Buffer.concat(chunks, size));
    }
  } finally { archive.close(); }
  if (!completed || files.size !== completed || !files.has('[Content_Types].xml') ||
    !files.has('_rels/.rels') || !files.has('word/document.xml')) fail();

  const nsRel = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const nsContent = 'http://schemas.openxmlformats.org/package/2006/content-types';
  const nsWord = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const relationshipPrefix = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
  const relationshipKinds = new Set(['officeDocument', 'styles', 'numbering', 'settings', 'webSettings',
    'fontTable', 'theme', 'image', 'header', 'footer', 'footnotes', 'endnotes', 'comments', 'hyperlink', 'extended-properties']);
  let mainType = false;
  let mainRelationship = false;
  for (const [name, content] of files) {
    const folded = name.toLowerCase();
    if (!/\.(xml|rels)$/.test(folded)) continue;
    const xml = new TextDecoder('utf-8', { fatal: true }).decode(content);
    const options = { xmlns: true, strictEntities: true };
    const parser = modules.sax.parser(true, options);
    let depth = 0;
    let count = 0;
    const relationshipIds = new Set();
    parser.onerror = fail;
    parser.ondoctype = fail;
    parser.onsgmldeclaration = fail;
    parser.onprocessinginstruction = (instruction) => { if (instruction.name.toLowerCase() !== 'xml') fail(); };
    parser.onopentag = (node) => {
      if (++depth > 64 || ++count > 100_000) fail();
      const tag = node;
      const attrs = tag.attributes;
      const attr = (key) => attrs[key]?.value ?? '';
      if (Object.keys(attrs).length > 128) fail();
      if (depth === 1) {
        if (folded.endsWith('.rels') && (tag.local !== 'Relationships' || tag.uri !== nsRel)) fail();
        if (name === '[Content_Types].xml' && (tag.local !== 'Types' || tag.uri !== nsContent)) fail();
        if (name === 'word/document.xml' && (tag.local !== 'document' || tag.uri !== nsWord)) fail();
      }
      if (['altChunk', 'object', 'oleObject', 'control', 'instrText', 'fldSimple'].includes(tag.local)) fail();
      if (folded.endsWith('.rels') && tag.local === 'Relationship') {
        if (tag.uri !== nsRel || depth !== 2) fail();
        const id = attr('Id'), type = attr('Type'), target = attr('Target'), mode = attr('TargetMode');
        if (!id || relationshipIds.has(id) || !target || /[\\%\x00-\x1f\x7f]/.test(target)) fail();
        relationshipIds.add(id);
        const kind = type.startsWith(relationshipPrefix) ? type.slice(relationshipPrefix.length) : '';
        if (!relationshipKinds.has(kind) && type !== 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties') fail();
        if (mode === 'External') {
          if (kind !== 'hyperlink' || !safeLink(target)) fail();
        } else {
          if (mode || target.includes(':') || target.startsWith('//')) fail();
          const base = name === '_rels/.rels' ? '' : modules.path.dirname(modules.path.dirname(name));
          const resolved = modules.path.normalize(target.startsWith('/') ? target.slice(1) : modules.path.join(base, target));
          if (resolved.startsWith('../') || resolved === '..' || !files.has(resolved.split('#')[0])) fail();
          if (name === '_rels/.rels' && kind === 'officeDocument' && resolved === 'word/document.xml') mainRelationship = true;
        }
      }
      if (name === '[Content_Types].xml' && ['Default', 'Override'].includes(tag.local)) {
        const type = attr('ContentType');
        if (tag.uri !== nsContent || /macro|ole|activex|executable/i.test(type)) fail();
        if (tag.local === 'Override' && attr('PartName') === '/word/document.xml' &&
          type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml') mainType = true;
      }
    };
    parser.onclosetag = () => { depth--; };
    parser.write(xml).close();
    if (depth !== 0 || count === 0) fail();
  }
  if (!mainType || !mainRelationship) fail();
}

if (parentPort) {
  installPdfBounds();
  inspectDocument(workerData.bytes, workerData.mime, { pdf, zip, sax, path: posix })
    .then(() => parentPort.postMessage('passed'), () => parentPort.postMessage('rejected'));
}
