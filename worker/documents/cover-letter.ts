import { PDFDocument, StandardFonts, type PDFFont } from 'pdf-lib';
import type { StructuredGenerationResult } from '../providers.ts';

type Letter = Extract<StructuredGenerationResult, { task: 'cover_letter' }>;

// Helvetica draws only WinAnsi characters: spell out symbols a model tends to use and drop any other, so one stray
// character cannot fail the application.
const symbols: Record<string, string> = { '\u2018': "'", '\u2019': "'", '\u201c': '"', '\u201d': '"', '\u2192': '->', '\u2190': '<-',
  '\u2265': '>=', '\u2264': '<=', '\u2212': '-', '\u2010': '-', '\u2011': '-', '\u2012': '-', '\u2248': '~' };
function drawable(text: string, font: PDFFont) {
  const set = new Set(font.getCharacterSet());
  return Array.from(text.replace(/[^\S\n]+/g, ' '), c => symbols[c] ?? (c === '\n' || set.has(c.codePointAt(0)!) ? c : '')).join('');
}
/** Each line and its baseline at one type size. */
function layout(paragraphs: string[], font: PDFFont, size: number) {
  const lines: { text: string; y: number }[] = [];
  let y = 738;
  for (const paragraph of paragraphs) {
    let line = '';
    const flush = () => { if (line) { lines.push({ text: line, y }); y -= size * 4 / 3; line = ''; } };
    for (const word of paragraph.split(/(\s+)/)) {
      if (word.includes('\n')) { flush(); continue; }
      if (font.widthOfTextAtSize(line + word, size) > 504) flush();
      line += word;
    }
    flush(); y -= size * 6 / 7;
  }
  return lines;
}

export async function renderCoverLetter(letter: Letter, applicant: string): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const paragraphs = ['Dear Hiring Manager,', letter.introduction, ...letter.body.map(item => item.text),
    letter.companyParagraph, letter.conclusion, `Sincerely,\n${applicant}`].map(text => drawable(text, font));
  // A long letter steps the type down until it fits one page; the longest letter the schema allows fits at 8.5 pt.
  for (const size of [10.5, 10, 9.5, 9, 8.5]) {
    const lines = layout(paragraphs, font, size);
    if (lines.some(line => line.y < 54)) continue;
    for (const line of lines) page.drawText(line.text, { x: 54, y: line.y, size, font });
    return document.save();
  }
  throw new Error('COVER_LETTER_EXCEEDS_ONE_PAGE');
}
