import { z } from 'zod';
import { AnswerCommandSchema, validQuestionAnswer, type AnswerCommand, type AnswerValue, type QuestionDetail } from '../../lib/applications/question-protocol';
import type { Edit } from './control';

export const DocumentSchema = z.object({
  id: z.uuid(), version: z.number().int().positive(), name: z.string(), state: z.string(),
  kind: z.string(), mime: z.string(), size: z.number().nonnegative(), sha256: z.string().nullable(),
});
export type Document = z.infer<typeof DocumentSchema>;
export function eligibleDocuments(question: QuestionDetail, documents: Document[]) {
  const field = question.descriptor.field;
  return field.type !== 'document' ? [] : documents.filter((doc) => doc.state === 'available' &&
    /^[a-f0-9]{64}$/.test(doc.sha256 ?? '') && field.documentKinds.some((kind) => kind === doc.kind) &&
    field.mimeTypes.some((mime) => mime === doc.mime) && doc.size <= field.maxBytes);
}
export function answerCommand(q: QuestionDetail, edit: Edit, documents: Document[]): AnswerCommand {
  const field = q.descriptor.field;
  let answer: AnswerValue;
  if (!q.allowedReuse.includes(edit.reuse)) throw new Error('Choose a permitted reuse scope.');
  if (edit.mode === 'blank') {
    if (!q.canBlank) throw new Error('This question cannot be left blank.');
    answer = { type: 'blank' };
  } else if (edit.mode === 'decline') {
    if (!q.canDecline || field.declineValue === null) throw new Error('Decline is not permitted.');
    answer = { type: 'decline', value: field.declineValue };
  } else {
    switch (field.type) {
      case 'text':
      case 'textarea':
        answer = { type: 'text', value: edit.input };
        break;
      case 'radio':
      case 'select':
        answer = { type: 'choice', value: edit.input };
        break;
      case 'multiselect':
        answer = { type: 'choices', value: edit.choices };
        break;
      case 'boolean':
        if (!['true', 'false'].includes(edit.input)) throw new Error('Choose yes or no.');
        answer = { type: 'boolean', value: edit.input === 'true' };
        break;
      case 'number': {
        if (!edit.input.trim()) throw new Error('Enter a number.');
        answer = { type: 'number', value: Number(edit.input), units: field.units, precision: field.precision };
        break;
      }
      case 'date':
        answer = { type: 'date', value: edit.input, precision: field.precision };
        break;
      case 'document': {
        const doc = eligibleDocuments(q, documents).find((doc) => doc.id === edit.input);
        if (!doc?.sha256) throw new Error('Choose an available document that meets the required kind, format and size.');
        answer = { type: 'document', documentId: doc.id, version: doc.version, sha256: doc.sha256 };
        break;
      }
      default: throw new Error('This item requires intervention, not a factual answer.');
    }
  }
  if (!validQuestionAnswer(q.descriptor, answer, edit.mode === 'blank' ? q.canBlank : q.canDecline)) {
    throw new Error('Check the answer against the original options, requiredness, units, precision and bounds.');
  }
  return AnswerCommandSchema.parse({
    requestId: crypto.randomUUID(), expectedRevision: q.revision, expectedProfileRevision: q.expectedProfileRevision,
    expectedPolicyRevision: q.expectedPolicyRevision, expectedScopeHash: q.expectedScopeHash,
    factVersions: q.factVersions, reuse: edit.reuse, answer,
  });
}
