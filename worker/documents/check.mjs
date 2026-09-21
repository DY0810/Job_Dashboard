import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { zipSync, strToU8 } from 'fflate';
import { createTemplateManifest, DocumentRuntimeError, tailorDocument } from './runtime.ts';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PDF = 'application/pdf';
const hasSoffice = spawnSync('soffice', ['--version'], { stdio: 'ignore' }).status === 0;
const evidence = () => ({ id: crypto.randomUUID(), confirmed: true, excerpt: 'Confirmed synthetic evidence.' });

function syntheticDocx() {
  return zipSync({
    '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Build APIs</w:t></w:r></w:p><w:p><w:r><w:t>Proven </w:t></w:r><w:r><w:t>facts</w:t></w:r></w:p></w:body></w:document>'),
  });
}

function syntheticPdf() {
  const bodies = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R /Annots [6 0 R] >>\nendobj\n',
  ];
  const stream = 'BT /F1 12 Tf 50 700 Td (Build APIs) Tj 0 -20 Td (Proven facts) Tj ET';
  bodies.push(`4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`);
  bodies.push('5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n');
  bodies.push('6 0 obj\n<< /Type /Annot /Subtype /Link /Rect [50 700 150 720] /A << /S /URI /URI (https://example.test/job) >> >>\nendobj\n');
  let output = '%PDF-1.4\n';
  const offsets = [0];
  for (const body of bodies) { offsets.push(output.length); output += body; }
  const xref = output.length;
  output += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) output += `${String(offset).padStart(10, '0')} 00000 n \n`;
  output += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output, 'ascii');
}

test('DOCX manifest and tailoring preserve frozen text and bind edits to confirmed evidence', async () => {
  const bytes = syntheticDocx(), manifest = await createTemplateManifest(bytes, DOCX, 'software engineering');
  const item = evidence();
  const result = await tailorDocument({ bytes, mime: DOCX, manifest, request: {
    role: 'software engineering', masterHash: manifest.sourceHash, evidence: [item],
    edits: [{ anchorId: manifest.anchors[0].id, replacement: 'Build SDKs', evidenceIds: [item.id] }],
  } });
  assert.notDeepEqual(Buffer.from(result.bytes), Buffer.from(bytes));
  assert.equal(result.checks.frozenTextPreserved, true);
  assert.equal(result.manifest.sourceHash, manifest.sourceHash);
  assert.equal(result.manifest.textHash.length, 64);
});

test('DOCX edits reject missing evidence, overflow and stale masters before invoking the tool', async () => {
  const bytes = syntheticDocx(), manifest = await createTemplateManifest(bytes, DOCX, 'role');
  const item = evidence();
  const base = { role: 'role', masterHash: manifest.sourceHash, evidence: [item], edits: [{ anchorId: manifest.anchors[0].id, replacement: 'A'.repeat(100), evidenceIds: [item.id] }] };
  await assert.rejects(tailorDocument({ bytes, mime: DOCX, manifest, request: base }), /EDIT_OVERFLOW/);
  await assert.rejects(tailorDocument({ bytes, mime: DOCX, manifest, request: { ...base, masterHash: 'a'.repeat(64) } }), /MASTER_HASH_MISMATCH/);
  await assert.rejects(tailorDocument({ bytes, mime: DOCX, manifest, request: { ...base, edits: [{ ...base.edits[0], replacement: 'Build SDKs', evidenceIds: [crypto.randomUUID()] }] } }), /UNCONFIRMED_EVIDENCE/);
  await assert.rejects(tailorDocument({ bytes, mime: DOCX, manifest, request: { ...base, edits: [{ ...base.edits[0], replacement: 'Build APIs' }] } }), /NO_SUBSTANTIVE_EDIT/);
});

test('DOCX tailoring rejects a source that does not match its reference PDF', { skip: !hasSoffice }, async () => {
  const bytes = syntheticDocx(), manifest = await createTemplateManifest(bytes, DOCX, 'role');
  const item = evidence();
  await assert.rejects(tailorDocument({ bytes, mime: DOCX, manifest, referenceBytes: syntheticPdf(), request: {
    role: 'role', masterHash: manifest.sourceHash, evidence: [item],
    edits: [{ anchorId: manifest.anchors[0].id, replacement: 'Build SDKs', evidenceIds: [item.id] }],
  } }), /DOCX source does not match reference PDF/);
});

test('fixed PDF editing preserves the exact byte width, page count and active link targets', async () => {
  const bytes = syntheticPdf(), manifest = await createTemplateManifest(bytes, PDF, 'software engineering');
  const item = evidence();
  const result = await tailorDocument({ bytes, mime: PDF, manifest, request: {
    role: 'software engineering', masterHash: manifest.sourceHash, evidence: [item],
    edits: [{ anchorId: manifest.anchors.find((item) => item.text === 'Build APIs').id, replacement: 'Build SDKs', evidenceIds: [item.id] }],
  } });
  assert.equal(result.checks.pageCount, 1);
  assert.deepEqual(result.manifest.links, ['https://example.test/job']);
  assert.notDeepEqual(Buffer.from(result.bytes), Buffer.from(bytes));
});

test('fixed PDF editing rejects geometry-changing replacements', async () => {
  const bytes = syntheticPdf(), manifest = await createTemplateManifest(bytes, PDF, 'role');
  const item = evidence();
  await assert.rejects(tailorDocument({ bytes, mime: PDF, manifest, request: {
    role: 'role', masterHash: manifest.sourceHash, evidence: [item],
    edits: [{ anchorId: manifest.anchors[0].id, replacement: 'Longer replacement', evidenceIds: [item.id] }],
  } }), (error) => error instanceof DocumentRuntimeError && error.code === 'EDIT_OVERFLOW');
});

test('parallel attempts use separate scratch directories and do not cross-read outputs', async () => {
  const bytes = syntheticDocx(), manifest = await createTemplateManifest(bytes, DOCX, 'role');
  const item = evidence();
  const request = { role: 'role', masterHash: manifest.sourceHash, evidence: [item], edits: [{ anchorId: manifest.anchors[0].id, replacement: 'Build SDKs', evidenceIds: [item.id] }] };
  const results = await Promise.all([tailorDocument({ bytes, mime: DOCX, manifest, request }), tailorDocument({ bytes, mime: DOCX, manifest, request })]);
  assert.equal(results[0].sha256, results[1].sha256);
});
