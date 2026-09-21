import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { crc32, deflateSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { validateDocumentBytes } from './documents-validation';

const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const require = createRequire(import.meta.url);
export async function syntheticPdf(action?: string) {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]);
  if (action === 'encrypted') pdf.context.trailerInfo.Encrypt = pdf.context.register(pdf.context.obj({ Filter: 'Standard' }));
  else if (action) {
    pdf.catalog.set(PDFName.of('OpenAction'), pdf.context.obj({ S: PDFName.of(action), JS: PDFString.of('synthetic') }));
  }
  return pdf.save();
}
export function syntheticDocx(extra: Record<string, Uint8Array> = {}) {
  return zipSync({
    '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Synthetic resume</w:t></w:r></w:p></w:body></w:document>'),
    ...extra,
  });
}

describe('bounded parsed document validation (synthetic only)', () => {
  it('pins the inspected pdf-lib allocation/dispatch contract; upgrades require requalification', () => {
    expect(require('pdf-lib/package.json').version).toBe('1.17.1');
    const hashes = {
      'streams/decode': 'd9a689fe9004122c9b96c5e331defa1a22a7c27f2591f42033ccdcb562e1d689',
      'streams/DecodeStream': '666dc30139cceee5ef849a09a990d761c2de801e0aaa264178b93cf99640adcb',
      'streams/FlateStream': 'e5e279bd3642c8fd52582605f61514162cdff563523ae0963664a7aa05ff4f03',
      'streams/LZWStream': '95a7269f43aa4f4a9658aefff678696eef12c33b0cf64f5f616270f3c1ec8d73',
      'streams/Ascii85Stream': 'd08c5358acedbc23735a192ceb11e9bf4a1fd2897907e343fa694033d97d5de0',
      'streams/AsciiHexStream': 'b9b5eaeadb15010c15643e87e0d35512aacae183d0329d4bcda9c10dda332435',
      'streams/RunLengthStream': 'f9b5750a1048611740c50d15e4f3426615edf8537cdef1841661aa93fd00adc0',
      'streams/Stream': '64854a09f25c4ab400459fb678213db41a1988f3e1620555332c44c3d3867634',
      'parser/ByteStream': 'f7489621ec58792b4c6c4d1e8b38ce5fcd17d997b0f9d2c0b7d81176e55cbf12',
      'parser/PDFParser': '390fc8e6464b2938e9e8726b3ae23649514dc157beed55f333e58a0bc6899c58',
      'parser/PDFObjectStreamParser': '55a12aa6d4ccc5af18286abc9e264e0b219e90129404f83645d248badbf3fb7a',
      'parser/PDFXRefStreamParser': '3bfc5d5afd99549c4739ac788b7465c753625fe6f53b972ab4832d33eab1342b',
      'parser/PDFObjectParser': '627b964fae4377458e0eaff03862aba6994747b0d49a5dfccd85fb71ae3d4547',
    };
    for (const [file, hash] of Object.entries(hashes)) {
      expect(createHash('sha256').update(readFileSync(require.resolve(`pdf-lib/cjs/core/${file}.js`))).digest('hex')).toBe(hash);
    }
  });
  it('qualifies all five decoders, filter chains, scratch tables and aggregate pre-allocation rejection', () => {
    // Separate process: patches must never change pdf-lib in the app/test parent.
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { deflateSync, constants } from 'node:zlib';
      import pdf from 'pdf-lib';
      import decode from 'pdf-lib/cjs/core/streams/decode.js';
      import DS from 'pdf-lib/cjs/core/streams/DecodeStream.js';
      import FS from 'pdf-lib/cjs/core/streams/FlateStream.js';
      import { installPdfBounds } from './lib/applications/documents-parse-worker.mjs';
      const metrics = installPdfBounds();
      const doc = await pdf.PDFDocument.create();
      const plain = Buffer.from('synthetic');
      const bits = [256, ...plain, 257].map(n => n.toString(2).padStart(9, '0')).join('');
      const padded = bits.padEnd(Math.ceil(bits.length / 8) * 8, '0');
      const lzw = Buffer.from(padded.match(/.{8}/g).map(n => parseInt(n, 2)));
      const cases = [
        ['FlateDecode', deflateSync(plain), plain],
        ['FlateDecode', deflateSync(plain, { level: 0 }), plain],
        ['FlateDecode', deflateSync(plain, { strategy: constants.Z_FIXED }), plain],
        ['LZWDecode', lzw, plain],
        ['ASCIIHexDecode', Buffer.from(plain.toString('hex') + '>'), plain],
        ['ASCII85Decode', Buffer.from('zz~>'), Buffer.alloc(8)],
        ['RunLengthDecode', Buffer.from([129, 32, 128, 0]), Buffer.alloc(128, 32)],
        [['FlateDecode', 'FlateDecode'], deflateSync(deflateSync(plain)), plain],
        [undefined, plain, plain],
      ];
      for (const [filter, encoded, expected] of cases) {
        const raw = doc.context.stream(encoded, filter ? { Filter: filter } : {});
        const stream = decode.decodePDFRawStream(raw);
        assert.deepEqual(Buffer.from(stream.decode()), expected);
        if (filter && !Array.isArray(filter)) {
          assert.equal(stream.ensureBuffer, DS.default.prototype.ensureBuffer);
          const before = metrics().allocated;
          stream.eof = false; stream.bufferLength = 8 * 1024 * 1024;
          // Use a fresh decoder input so every real readBlock hits ensureBuffer.
          const next = decode.decodePDFRawStream(raw);
          next.bufferLength = 8 * 1024 * 1024;
          assert.throws(() => next.readBlock(), /PDF stream limit/);
          assert.ok(metrics().allocated <= before + 32768 + 200000);
          assert.equal(next.buffer.byteLength, 0, 'No oversized allocation happened');
        }
      }
      const bad = doc.context.stream(plain, { Filter: Array(9).fill('ASCIIHexDecode') });
      assert.throws(() => decode.decodePDFRawStream(bad), /decoder limit/);
      const h = new FS.default({ getByte: (() => { const bytes = [120, 156]; return () => bytes.shift(); })() });
      assert.throws(() => h.generateHuffmanTable(new Uint8Array([16])), /Huffman/);
      const before = metrics().allocated;
      const table = h.generateHuffmanTable(new Uint8Array([15]));
      assert.equal(table[0].byteLength, 131072);
      assert.equal(metrics().allocated - before, 131072 + 512);
      const buffers = Array.from({ length: 5 }, () => new DS.default());
      let rejected = false;
      for (const stream of buffers) {
        const before = metrics().allocated;
        try { stream.ensureBuffer(8 * 1024 * 1024); }
        catch (error) {
          assert.match(error.message, /allocation budget/);
          assert.equal(stream.buffer.byteLength, 0);
          assert.equal(metrics().allocated, before, 'Reject before charging or allocating');
          rejected = true; break;
        }
      }
      assert.equal(rejected, true);
      assert.ok(metrics().allocated <= 32 * 1024 * 1024);
      console.log(JSON.stringify(metrics()));
    `], { cwd: process.cwd(), env: { NODE_ENV: 'test' }, encoding: 'utf8', timeout: 10000 });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout).allocated).toBeLessThanOrEqual(32 * 1024 * 1024);
  });
  it('rejects compressed object streams before expanding beyond the budget; parent stays usable', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    // A valid, unused ObjStm with a small dictionary followed by compressible whitespace.
    const content = Buffer.concat([Buffer.from('99 0 << /Synthetic true >>'), Buffer.alloc(9 * 1024 * 1024, 32)]);
    doc.context.register(doc.context.stream(deflateSync(content), {
      Type: 'ObjStm', N: 1, First: 5, Filter: 'FlateDecode',
    }));
    const bytes = await doc.save({ useObjectStreams: false });
    expect(bytes.length).toBeLessThan(20_000);
    expect((await validateDocumentBytes(bytes, PDF)).status).toBe('rejected');
    expect((await validateDocumentBytes(await syntheticPdf(), PDF)).status).toBe('passed');
  });
  it('keeps valid tagged PDFs and benign URI annotations', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    doc.catalog.set(PDFName.of('MarkInfo'), doc.context.obj({ Marked: true }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(doc.context.obj({
      Type: 'StructTreeRoot', K: [],
    })));
    page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(doc.context.obj({
      Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 100, 20],
      A: { S: 'URI', URI: PDFString.of('https://example.test/resume') },
    }))]));
    expect((await validateDocumentBytes(await doc.save(), PDF)).status).toBe('passed');
  });
  it('rejects cumulative ObjStm expansion and XRef expansion before allocating the next buffer', async () => {
    for (const type of ['ObjStm', 'XRef']) {
      const doc = await PDFDocument.create();
      doc.addPage([200, 200]);
      const count = type === 'ObjStm' ? 3 : 1;
      for (let i = 0; i < count; i++) {
        const content = type === 'ObjStm'
          ? Buffer.concat([Buffer.from(`${99 + i} 0 << /Synthetic true >>`), Buffer.alloc(5 * 1024 * 1024, 32)])
          : Buffer.alloc(9 * 1024 * 1024);
        doc.context.register(doc.context.stream(deflateSync(content), {
          Type: type, N: 1, First: 5, Size: 1, W: [1, 1, 1], Filter: 'FlateDecode',
        }));
      }
      expect((await validateDocumentBytes(await doc.save({ useObjectStreams: false }), PDF)).status).toBe('rejected');
    }
    expect((await validateDocumentBytes(await syntheticPdf(), PDF)).status).toBe('passed');
  });
  it('rejects missing central directory and EOCD even with complete local ZIP entries', async () => {
    const bytes = Buffer.from(syntheticDocx());
    const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(central).toBeGreaterThan(0);
    for (const truncated of [bytes.subarray(0, central), bytes.subarray(0, bytes.length - 22)]) {
      expect((await validateDocumentBytes(truncated, DOCX)).status).toBe('rejected');
    }
  });
  it('rejects forged ZIP size metadata, damaged CRC and excess entries', async () => {
    const complete = Buffer.from(syntheticDocx({ 'word/padding.xml': strToU8(`<x>${'a'.repeat(200_000)}</x>`) }));
    // Fixture mutations only; production parsing uses yauzl, never these offsets.
    const firstCentral = complete.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    const understated = Buffer.from(complete);
    understated.writeUInt32LE(1, firstCentral + 24);
    const badCrc = Buffer.from(complete);
    badCrc.writeUInt32LE(0, firstCentral + 16);
    const missingEntry = Buffer.from(complete);
    missingEntry.writeUInt32LE(complete.length + 100, firstCentral + 42);
    const tooMany = syntheticDocx(Object.fromEntries(Array.from({ length: 254 }, (_, i) => [`word/part${i}.xml`, strToU8('<x/>')])));
    for (const bytes of [understated, badCrc, missingEntry, tooMany]) {
      expect((await validateDocumentBytes(bytes, DOCX)).status).toBe('rejected');
    }
    expect((await validateDocumentBytes(complete, DOCX)).status).toBe('passed');
  });
  it.each(['both', 'central', 'local'])('rejects Unicode path aliases in %s ZIP headers', async (location) => {
    for (const disguiseXml of [true, false]) {
      const files = unzipSync(syntheticDocx());
      const raw = disguiseXml ? 'word/hidden.xml' : 'word/media/image.png';
      const alias = disguiseXml ? 'word/media/image.png' : 'word/document.xml';
      const content = disguiseXml
        ? strToU8('<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:fldSimple w:instr="DDEAUTO synthetic"/></w:hdr>')
        : files['word/document.xml'];
      if (!disguiseXml) delete files['word/document.xml'];
      const field = Buffer.alloc(5 + Buffer.byteLength(alias));
      field[0] = 1;
      field.writeUInt32LE(crc32(Buffer.from(raw)), 1);
      field.write(alias, 5);
      const bytes = Buffer.from(zipSync({ ...files, [raw]: [content, { extra: { 0x7075: field } }] }));
      // Fixture-only mutation: fflate emits the extra field in both headers.
      const central = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
      const local = bytes.readUInt32LE(central + 42);
      if (location === 'local') bytes.writeUInt16LE(0xffff, central + 46 + Buffer.byteLength(raw));
      if (location === 'central') bytes.writeUInt16LE(0xffff, local + 30 + Buffer.byteLength(raw));
      expect((await validateDocumentBytes(bytes, DOCX)).status).toBe('rejected');
    }
  });
  it('rejects local/central name, encoding, compression and flag mismatches; keeps benign UTF-8 names', async () => {
    const valid = Buffer.from(syntheticDocx({ 'word/r\u00e9sum\u00e9.xml': strToU8('<x/>') }));
    const central = valid.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    const local = valid.readUInt32LE(central + 42);
    expect((await validateDocumentBytes(valid, DOCX)).status).toBe('passed');
    for (const change of ['name', 'encoding', 'compression', 'encryption', 'descriptor']) {
      const bytes = Buffer.from(valid);
      if (change === 'name') bytes[local + 30] = 'W'.charCodeAt(0);
      else if (change === 'compression') bytes.writeUInt16LE(0, local + 8);
      else bytes.writeUInt16LE(bytes.readUInt16LE(local + 6) ^ (
        change === 'encoding' ? 0x800 : change === 'encryption' ? 1 : 8
      ), local + 6);
      expect((await validateDocumentBytes(bytes, DOCX)).status).toBe('rejected');
    }
  });
  it('rejects local-only Unicode aliases on an otherwise benign PNG', async () => {
    const raw = 'word/media/image.png', alias = 'word/document.xml';
    const field = Buffer.alloc(5 + Buffer.byteLength(alias));
    field[0] = 1;
    field.writeUInt32LE(crc32(Buffer.from(raw)), 1);
    field.write(alias, 5);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1sAAAAASUVORK5CYII=', 'base64');
    expect((await validateDocumentBytes(syntheticDocx({ [raw]: png }), DOCX)).status).toBe('passed');
    const bytes = Buffer.from(zipSync({
      ...unzipSync(syntheticDocx()), [raw]: [png, { extra: { 0x7075: field } }],
    }));
    const central = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bytes.writeUInt16LE(0xffff, central + 46 + Buffer.byteLength(raw));
    expect((await validateDocumentBytes(bytes, DOCX)).status).toBe('rejected');
  });
  it('scans referenced uppercase XML and RELS, rejecting fields and preserving legitimate links', async () => {
    const rel = (target: string, mode = '', kind = 'header') => strToU8(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${kind}" Target="${target}"${mode ? ` TargetMode="${mode}"` : ''}/></Relationships>`);
    for (const extension of ['XML', 'XmL']) {
      const name = `word/header1.${extension}`;
      const header = (content: string) => strToU8(`<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${content}</w:hdr>`);
      const extra = { 'word/_rels/document.xml.rels': rel(`header1.${extension}`) };
      expect((await validateDocumentBytes(syntheticDocx({ ...extra, [name]: header('<w:p/>') }), DOCX)).status).toBe('passed');
      expect((await validateDocumentBytes(syntheticDocx({ ...extra, [name]: header('<w:fldSimple w:instr="DDEAUTO synthetic"/>') }), DOCX)).status).toBe('rejected');
    }
    for (const extension of ['RELS', 'ReLs']) {
      const name = `word/_rels/relationship.${extension}`;
      for (const [target, expected] of [['https://example.test/resume', 'passed'], ['file:///etc/passwd', 'rejected']]) {
        expect((await validateDocumentBytes(syntheticDocx({
          'word/_rels/document.xml.rels': rel(`_rels/relationship.${extension}`),
          [name]: rel(target, 'External', 'hyperlink'),
        }), DOCX)).status).toBe(expected);
      }
    }
  });
  it('computes byte count and hash from a parsed minimal PDF', async () => {
    const bytes = await syntheticPdf();
    const result = await validateDocumentBytes(bytes, PDF);
    expect(result).toMatchObject({ status: 'passed', size: bytes.length, mime: PDF });
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each(['JavaScript', 'Launch', 'encrypted'])('rejects %s PDF', async (action) => {
    expect((await validateDocumentBytes(await syntheticPdf(action), PDF)).status).toBe('rejected');
  });
  it('rejects malformed, mismatched and oversized input', async () => {
    for (const [bytes, mime] of [[strToU8('%PDF-1.7 invalid'), PDF], [await syntheticPdf(), DOCX], [new Uint8Array(10 * 1024 * 1024 + 1), PDF]] as const) {
      expect((await validateDocumentBytes(bytes, mime)).status).toBe('rejected');
    }
  });
  it('parses DOCX and preserves benign https/mailto links', async () => {
    const rels = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.test/resume" TargetMode="External"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="mailto:synthetic@example.test" TargetMode="External"/></Relationships>';
    expect((await validateDocumentBytes(syntheticDocx({ 'word/_rels/document.xml.rels': strToU8(rels) }), DOCX)).status).toBe('passed');
  });
  it('defers bounded worker timeout and permits a subsequent retry', async () => {
    const bytes = await syntheticPdf();
    expect((await validateDocumentBytes(bytes, PDF, 0)).status).toBe('deferred');
    expect((await validateDocumentBytes(bytes, PDF)).status).toBe('passed');
  });
  it('defers a third concurrent parser and releases both worker slots', async () => {
    const bytes = await syntheticPdf();
    const results = await Promise.all(Array.from({ length: 3 }, () => validateDocumentBytes(bytes, PDF)));
    expect(results.map((result) => result.status)).toEqual(['passed', 'passed', 'deferred']);
    expect((await validateDocumentBytes(bytes, PDF)).status).toBe('passed');
  });
  it('rejects truncated ZIP, duplicate folded names and unsafe external hyperlinks', async () => {
    const complete = syntheticDocx();
    const rels = strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="file:///etc/passwd" TargetMode="External"/></Relationships>');
    for (const bytes of [complete.subarray(0, 80), syntheticDocx({ 'word/DOCUMENT.xml': strToU8('<x/>') }),
      syntheticDocx({ 'word/_rels/document.xml.rels': rels })]) {
      expect((await validateDocumentBytes(bytes, DOCX)).status).toBe('rejected');
    }
  });
  it.each<Record<string, Uint8Array>>([
    { '../escape.xml': strToU8('x') },
    { 'word/vbaProject.bin': strToU8('x') },
    { 'word/embeddings/oleObject1.bin': strToU8('x') },
    { 'word/bomb.xml': new Uint8Array(12 * 1024 * 1024) },
    { 'word/entity.xml': strToU8('<!DOCTYPE x [<!ENTITY a SYSTEM "file:///etc/passwd">]><x>&a;</x>') },
    { 'word/_rels/document.xml.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="https://example.test/evil" TargetMode="External"/></Relationships>') },
  ])('rejects hostile ZIP/XML package %#', async (extra) => {
    expect((await validateDocumentBytes(syntheticDocx(extra), DOCX)).status).toBe('rejected');
  });
});
