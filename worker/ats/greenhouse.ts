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
  if (field.key === 'end-month--0' && field.label === 'End date month' && typeof input.answers.expected_graduation_month === 'string') {
    return new Date(`${input.answers.expected_graduation_month}-01T00:00:00Z`).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  }
  if (input.identity.tenant === 'figma' && input.identity.requisition === '6143238004') {
    if (field.key === 'country' && field.label === 'Country' && input.answers.phone_country === 'US') return 'United States +1';
    if (field.key === 'question_19438735004' && field.label === 'LinkedIn Profile') return input.answers.linkedin;
    if (field.key === 'question_19438736004' && field.label === 'Other Website') return input.answers.portfolio;
    if (field.key === 'question_19438730004' && field.label === 'If you are currently enrolled in university or a program, what is your expected graduation date?' &&
        input.answers.expected_graduation_month === '2028-12') return 'Fall 2028';
    if (field.key === 'question_19438728004' && field.label === 'Pronouns') return input.answers.voluntary_pronouns;
    if (field.key === 'gender' && field.label === 'Gender') return input.answers.voluntary_gender;
    if (field.key === 'hispanic_ethnicity' && field.label === 'Are you Hispanic/Latino?') return input.answers.voluntary_hispanic;
    if (field.key === 'veteran_status' && field.label === 'Veteran Status') return input.answers.voluntary_veteran;
  }
  return commonAnswer(input, field);
}

// Questions most employers ask in their own words, answered only from confirmed profile facts.
// Anything ambiguous (negations, combined questions, unrecognized wording) still goes to the inbox.
function commonAnswer(input: AtsApplication, field: AtsField) {
  const text = field.label.toLowerCase().replace(/\s+/g, ' ').trim();
  if (/\bnot\b|\bhear\b/.test(text)) return undefined;
  if (field.kind === 'text') {
    if (/^linkedin\b|\blinkedin (profile|url|link)\b/.test(text)) return input.answers.linkedin;
    if (/^github\b|\bgithub (profile|url|link|username)\b/.test(text)) return input.answers.github;
    if (/^(personal |other )?(website|portfolio)( url| link)?( \(optional\))?$/.test(text)) return input.answers.portfolio;
    if (/^((current|most recent) )?(school|university|college)( name)?$|^(what|which) (school|university|college) (do|did) you (currently )?attend\??$/.test(text)) {
      return input.answers['school--0'];
    }
  }
  const authorization = /\bauthori[sz]ed to work\b/.test(text), sponsorship = /\bsponsorship\b/.test(text);
  if (authorization === sponsorship) return undefined;
  // Uppercase US only: "work with us" is not a country.
  const us = /united states|\bh-?1b\b/.test(text) || /(^|[^A-Za-z])(U\.S\.A?\.?|USA|US)(?![A-Za-z])/.test(field.label);
  const postingCountry = /\bthe country\b/.test(text) && /\b(appl(y|ying|ied)|this (job|role|position))\b/.test(text);
  if (authorization) return us ? input.answers.us_authorized : postingCountry ? input.answers.posting_authorized : undefined;
  return input.answers[`${us ? 'us' : 'posting'}_sponsorship_${/\bfuture\b/.test(text) ? 'ever' : 'now'}`];
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
    const observation = AtsObservationSchema.parse({ identity, company, role, fields: live ? await hostedFields(form) : fields, actions: ['fill'] });
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
