import { createHash } from 'node:crypto';
import { disclosureAnswerKey } from '../../lib/applications/application-context-protocol.ts';
import { AtsError, AtsObservationSchema, type AtsAdapter, type AtsApplication, type AtsField, formQuestionKey, observeReceipt, fillField, verifyField } from './protocol.ts';

const fields: AtsField[] = [
  { key: 'first_name', label: 'First name', kind: 'text', required: true },
  { key: 'last_name', label: 'Last name', kind: 'text', required: true },
  { key: 'email', label: 'Email', kind: 'email', required: true },
  { key: 'work_authorization', label: 'Work authorization', kind: 'select', required: true, options: ['Yes', 'No'] },
  { key: 'resume', label: 'Resume', kind: 'file', required: true },
];

async function pageFor(input: AtsApplication, runtime: Parameters<AtsAdapter['observe']>[0]) {
  const page = runtime.context.pages()[0] ?? await runtime.page();
  return runtime.navigate(page, input.applicationUrl);
}

function hosted(input: AtsApplication) {
  const url = new URL(input.applicationUrl);
  return url.origin === 'https://job-boards.greenhouse.io' &&
    url.pathname === `/${input.identity.tenant}/jobs/${input.identity.requisition}`;
}

export function greenhouseAnswer(input: AtsApplication, field: AtsField) {
  if (input.answers[formQuestionKey(field)] !== undefined) return input.answers[formQuestionKey(field)];
  if (input.answers[field.key] !== undefined) return input.answers[field.key];
  if (input.answers[disclosureAnswerKey(field.label)] !== undefined) return input.answers[disclosureAnswerKey(field.label)];
  if (field.key === 'candidate-location' && field.label === 'Location (City)') return input.answers.current_location;
  if (field.key === 'country' && field.label === 'Country' && input.answers.phone_country === 'US') return 'United States +1';
  if (input.identity.tenant === 'figma' && input.identity.requisition === '6143238004') {
    if (field.key === 'question_19438728004' && field.label === 'Pronouns') return input.answers.voluntary_pronouns;
    if (field.key === 'gender' && field.label === 'Gender') return input.answers.voluntary_gender;
    if (field.key === 'hispanic_ethnicity' && field.label === 'Are you Hispanic/Latino?') return input.answers.voluntary_hispanic;
    if (field.key === 'veteran_status' && field.label === 'Veteran Status') return input.answers.voluntary_veteran;
  }
  if (field.label === 'Are you legally authorized to work in the United States?') return input.answers.work_authorization;
  if (field.label === 'Do you require sponsorship for employment visa status?') return input.answers.sponsorship_now;
  return undefined;
}

async function hostedFields(form: import('playwright').Locator): Promise<AtsField[]> {
  const raw = await form.evaluate(element => [...element.querySelectorAll('input[id],textarea[id],select[id]')].filter(node => {
    const input = node as HTMLInputElement;
    return input.type !== 'hidden' && !input.disabled && !input.id.endsWith('-search');
  }).map(node => {
    const input = node as HTMLInputElement;
    const label = document.getElementById(`${input.id}-label`)?.textContent ??
      document.querySelector(`label[for="${CSS.escape(input.id)}"]`)?.textContent ?? input.getAttribute('aria-label') ?? input.id;
    return { key: input.id, label: label.trim().replace(/\*\s*$/, '').trim(),
      kind: input.type === 'file' ? 'file' : input.getAttribute('role') === 'combobox' ? 'combobox' :
        input.tagName === 'SELECT' ? 'select' : input.type === 'checkbox' ? 'checkbox' : input.type === 'radio' ? 'radio' :
          input.type === 'email' ? 'email' : 'text',
      required: input.id === 'resume' || input.getAttribute('aria-required') === 'true' || input.required,
      options: node instanceof HTMLSelectElement ? [...node.options].map(option => option.label).filter(Boolean) : undefined,
    };
  }));
  if (raw.some(item => !/^[a-z][a-z0-9_-]{0,63}$/.test(item.key)) || raw.length > 64) throw new AtsError('GREENHOUSE_FIELD_UNSUPPORTED');
  return raw.map(item => ({ ...item, kind: item.kind as AtsField['kind'] }));
}

export const greenhouse: AtsAdapter = {
  id: 'greenhouse',
  async observe(runtime, input, signal) {
    signal?.throwIfAborted();
    const page = await pageFor(input, runtime);
    const form = page.locator('form[data-ats="greenhouse"], form#application-form').first();
    if (!await form.count()) throw new AtsError('GREENHOUSE_FORM_NOT_FOUND');
    const live = hosted(input) && await form.getAttribute('id') === 'application-form';
    if (!live && await form.getAttribute('id') === 'application-form') throw new AtsError('ATS_IDENTITY_MISMATCH');
    if (live) await page.waitForLoadState('load', { timeout: 5_000 });
    if (live && await page.title() !== `Job Application for ${input.role} at ${input.company}`) throw new AtsError('ATS_IDENTITY_MISMATCH');
    const identity = {
      ats: 'greenhouse' as const,
      tenant: await form.getAttribute('data-tenant') ?? input.identity.tenant,
      requisition: await form.getAttribute('data-requisition') ?? input.identity.requisition,
    };
    const company = await form.getAttribute('data-company') ?? input.company;
    const role = await form.getAttribute('data-role') ?? input.role;
    const observation = AtsObservationSchema.parse({ identity, company, role, fields: live ? await hostedFields(form) : fields, actions: ['fill', 'inspect'] });
    if (JSON.stringify(observation.identity) !== JSON.stringify(input.identity) || observation.company !== input.company || observation.role !== input.role) {
      throw new AtsError('ATS_IDENTITY_MISMATCH');
    }
    return observation;
  },
  async fill(runtime, input, observation, signal) {
    signal?.throwIfAborted();
    const page = runtime.context.pages()[0] ?? await runtime.page();
    for (const field of observation.fields) {
      const value = greenhouseAnswer(input, field);
      if (field.key === 'resume' || (field.key === 'cover_letter' && input.documents.cover_letter) || value !== undefined || field.required) {
        await fillField(page, field, value, input.documents);
        if (!await verifyField(page, field, value)) throw new AtsError('FIELD_RECONCILIATION_FAILED', field.key);
      }
    }
  },
  async submit(runtime, input, signal) {
    signal?.throwIfAborted();
    const page = runtime.context.pages()[0] ?? await runtime.page();
    const button = page.getByRole('button', { name: 'Submit application', exact: true });
    if (!await button.count()) throw new AtsError('SUBMIT_CONTROL_NOT_FOUND');
    await button.click();
    if (hosted(input)) {
      try { await page.waitForURL(`https://job-boards.greenhouse.io/${input.identity.tenant}/jobs/${input.identity.requisition}/confirmation`, { timeout: 15_000 }); }
      catch { throw new AtsError('SUBMISSION_CONFIRMATION_TIMEOUT'); }
    }
  },
  async receipt(runtime, input, signal) {
    signal?.throwIfAborted();
    const page = runtime.context.pages()[0] ?? await runtime.page();
    if (!hosted(input)) return observeReceipt(page, input);
    const url = new URL(page.url());
    if (url.origin !== 'https://job-boards.greenhouse.io' ||
        url.pathname !== `/${input.identity.tenant}/jobs/${input.identity.requisition}/confirmation`) {
      throw new AtsError('RECEIPT_NOT_VERIFIED');
    }
    const heading = await page.getByRole('heading', { name: 'Thank you for applying.', exact: true }).count();
    const message = await page.getByText('Your application has been received.', { exact: false }).count();
    const backlink = page.getByRole('link', { name: 'Back to job post', exact: true });
    if (!heading || !message || !await backlink.count() ||
        new URL(await backlink.getAttribute('href') ?? '', url).pathname !== `/${input.identity.tenant}/jobs/${input.identity.requisition}`) {
      throw new AtsError('RECEIPT_NOT_VERIFIED');
    }
    return { identity: input.identity, company: input.company, role: input.role,
      receiptId: `gh-${createHash('sha256').update(url.href).digest('hex').slice(0, 32)}`, submittedAt: Date.now() };
  },
};
