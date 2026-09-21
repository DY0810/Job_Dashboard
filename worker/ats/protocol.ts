import { z } from 'zod';
import type { Page } from 'playwright';
import type { BrowserRuntime } from '../browser.ts';

export const AtsIdentitySchema = z.strictObject({
  ats: z.enum(['greenhouse', 'ashby', 'lever', 'jobvite', 'workday', 'oracle', 'icims']), tenant: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  requisition: z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/),
});
export type AtsIdentity = z.infer<typeof AtsIdentitySchema>;
export const AtsFieldSchema = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), label: z.string().trim().min(1).max(160),
  kind: z.enum(['text', 'email', 'date', 'select', 'radio', 'checkbox', 'file']), required: z.boolean(),
  name: z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/).optional(),
  options: z.array(z.string().trim().min(1).max(120)).max(32).optional(),
});
export type AtsField = z.infer<typeof AtsFieldSchema>;
export const AtsObservationSchema = z.strictObject({
  identity: AtsIdentitySchema, company: z.string().trim().min(1).max(200), role: z.string().trim().min(1).max(300),
  fields: z.array(AtsFieldSchema).min(1).max(64), actions: z.array(z.enum(['fill', 'inspect'])).min(1).max(2),
});
export type AtsObservation = z.infer<typeof AtsObservationSchema>;
export const AtsReceiptSchema = z.strictObject({
  identity: AtsIdentitySchema, company: z.string().trim().min(1).max(200), role: z.string().trim().min(1).max(300),
  receiptId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/), submittedAt: z.number().int().positive(),
});
export type AtsReceipt = z.infer<typeof AtsReceiptSchema>;
export type AtsValue = string | boolean;
export type AtsApplication = {
  identity: AtsIdentity; company: string; role: string; applicationUrl: string;
  answers: Record<string, AtsValue>; documents: Record<string, string>;
  accountPolicy?: 'skip_new_accounts' | 'existing_only' | 'allow_new_with_consent';
  manifestHash?: string; artifactHashes?: string[]; submissionIntentId?: string;
};

export class AtsError extends Error {
  readonly code: string;
  constructor(code: string, message = code) { super(message); this.code = code; }
}

export type AtsAdapter = {
  readonly id: AtsIdentity['ats'];
  observe(runtime: BrowserRuntime, input: AtsApplication, signal?: AbortSignal): Promise<AtsObservation>;
  fill(runtime: BrowserRuntime, input: AtsApplication, observation: AtsObservation, signal?: AbortSignal): Promise<void>;
  submit(runtime: BrowserRuntime, input: AtsApplication, signal?: AbortSignal): Promise<void>;
  receipt(runtime: BrowserRuntime, input: AtsApplication, signal?: AbortSignal): Promise<AtsReceipt>;
};

export async function locateField(page: Page, field: AtsField) {
  const byLabel = page.getByLabel(field.label, { exact: false }).first();
  if (await byLabel.count()) return byLabel;
  if (field.name) {
    const byName = page.locator(`[name="${field.name}"]`).first();
    if (await byName.count()) return byName;
  }
  throw new AtsError('FIELD_NOT_FOUND', field.key);
}

export async function fillField(page: Page, field: AtsField, value: AtsValue | undefined, documents: Record<string, string>) {
  if (field.required && value === undefined && field.kind !== 'file') throw new AtsError('REQUIRED_ANSWER_MISSING', field.key);
  const locator = await locateField(page, field);
  if (field.kind === 'file') {
    const path = documents[field.key];
    if (!path) throw new AtsError('REQUIRED_DOCUMENT_MISSING', field.key);
    await locator.setInputFiles(path);
    return;
  }
  if (value === undefined) return;
  if (field.kind === 'checkbox') {
    if (typeof value !== 'boolean') throw new AtsError('ANSWER_TYPE_MISMATCH', field.key);
    if (value) await locator.check(); else await locator.uncheck();
  } else if (field.kind === 'select') {
    if (typeof value !== 'string' || !field.options?.includes(value)) throw new AtsError('ANSWER_OPTION_INVALID', field.key);
    await locator.selectOption({ label: value });
  } else if (field.kind === 'radio') {
    if (typeof value !== 'string' || !field.options?.includes(value)) throw new AtsError('ANSWER_OPTION_INVALID', field.key);
    const option = page.getByLabel(value, { exact: true }).first();
    if (!await option.count()) throw new AtsError('ANSWER_OPTION_NOT_FOUND', field.key);
    await option.check();
  } else {
    if (typeof value !== 'string') throw new AtsError('ANSWER_TYPE_MISMATCH', field.key);
    await locator.fill(value);
  }
}

export async function verifyField(page: Page, field: AtsField, value: AtsValue | undefined) {
  const locator = await locateField(page, field);
  if (field.kind === 'file') return await locator.evaluate((node) => node instanceof HTMLInputElement && Boolean(node.files?.length));
  if (field.kind === 'checkbox') return typeof value === 'boolean' && (await locator.isChecked()) === value;
  if (field.kind === 'radio') {
    if (typeof value !== 'string') return false;
    const option = page.getByLabel(value, { exact: true }).first();
    return await option.count() > 0 && await option.isChecked();
  }
  if (field.kind === 'select') return typeof value === 'string' && (await locator.inputValue()) === value;
  return typeof value === 'string' && (await locator.inputValue()) === value;
}

export async function observeReceipt(page: Page, expected: AtsApplication) {
  const receipt = page.locator('[data-receipt="application"]').first();
  if (!await receipt.count() || !await receipt.isVisible()) throw new AtsError('RECEIPT_NOT_VERIFIED');
  const actual = AtsReceiptSchema.safeParse({
    identity: {
      ats: await receipt.getAttribute('data-ats'), tenant: await receipt.getAttribute('data-tenant'),
      requisition: await receipt.getAttribute('data-requisition'),
    },
    company: await receipt.getAttribute('data-company'), role: await receipt.getAttribute('data-role'),
    receiptId: await receipt.getAttribute('data-receipt-id'), submittedAt: Number(await receipt.getAttribute('data-submitted-at')),
  });
  if (!actual.success || JSON.stringify(actual.data.identity) !== JSON.stringify(expected.identity) ||
      actual.data.company !== expected.company || actual.data.role !== expected.role) {
    throw new AtsError('RECEIPT_IDENTITY_MISMATCH');
  }
  return actual.data;
}
