import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { StructuredGenerationResult } from '../providers.ts';

type Letter = Extract<StructuredGenerationResult, { task: 'cover_letter' }>;

export async function renderCoverLetter(letter: Letter, applicant: string): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const paragraphs = ['Dear Hiring Manager,', letter.introduction, ...letter.body.map(item => item.text),
    letter.conclusion, letter.companyParagraph, `Sincerely,\n${applicant}`];
  let y = 738;
  for (const paragraph of paragraphs) {
    let line = '';
    const flush = () => { if (line) { page.drawText(line, { x: 54, y, size: 10.5, font }); y -= 14; line = ''; } };
    for (const word of paragraph.replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').split(/(\s+)/)) {
      if (word.includes('\n')) { flush(); continue; }
      if (font.widthOfTextAtSize(line + word, 10.5) > 504) flush();
      line += word;
    }
    flush(); y -= 9;
    if (y < 54) throw new Error('COVER_LETTER_EXCEEDS_ONE_PAGE');
  }
  return document.save();
}
