export const DOCUMENT_KINDS = [
  'resume_master', 'resume_source', 'resume_artifact', 'transcript', 'certificate', 'supporting', 'portfolio', 'artwork',
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const PDF_MIME = 'application/pdf';
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const PNG_MIME = 'image/png';
export const JPEG_MIME = 'image/jpeg';
export const DOCUMENT_MIMES = [PDF_MIME, DOCX_MIME, PNG_MIME, JPEG_MIME] as const;
export type DocumentMime = (typeof DOCUMENT_MIMES)[number];

const mimesByKind: Record<DocumentKind, readonly DocumentMime[]> = {
  resume_master: [PDF_MIME, DOCX_MIME],
  resume_source: [PDF_MIME, DOCX_MIME],
  resume_artifact: [PDF_MIME, DOCX_MIME],
  transcript: [PDF_MIME, DOCX_MIME],
  certificate: [PDF_MIME, DOCX_MIME],
  supporting: [PDF_MIME, DOCX_MIME],
  portfolio: [PDF_MIME, PNG_MIME, JPEG_MIME],
  artwork: [PDF_MIME, PNG_MIME, JPEG_MIME],
};

export function allowedDocumentMimes(kind: DocumentKind) {
  return mimesByKind[kind];
}

export function documentMimeForFilename(name: string): DocumentMime | null {
  const suffix = name.trim().toLowerCase().split('.').pop();
  if (suffix === 'pdf') return PDF_MIME;
  if (suffix === 'docx') return DOCX_MIME;
  if (suffix === 'png') return PNG_MIME;
  if (suffix === 'jpg' || suffix === 'jpeg') return JPEG_MIME;
  return null;
}
