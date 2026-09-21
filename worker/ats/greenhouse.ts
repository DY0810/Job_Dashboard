import { AtsError, AtsObservationSchema, type AtsAdapter, type AtsApplication, type AtsField, observeReceipt, fillField, verifyField } from './protocol.ts';

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

export const greenhouse: AtsAdapter = {
  id: 'greenhouse',
  async observe(runtime, input, signal) {
    signal?.throwIfAborted();
    const page = await pageFor(input, runtime);
    const form = page.locator('form[data-ats="greenhouse"]').first();
    if (!await form.count()) throw new AtsError('GREENHOUSE_FORM_NOT_FOUND');
    const identity = {
      ats: 'greenhouse' as const,
      tenant: await form.getAttribute('data-tenant') ?? input.identity.tenant,
      requisition: await form.getAttribute('data-requisition') ?? input.identity.requisition,
    };
    const company = await form.getAttribute('data-company') ?? input.company;
    const role = await form.getAttribute('data-role') ?? input.role;
    const observation = AtsObservationSchema.parse({ identity, company, role, fields, actions: ['fill', 'inspect'] });
    if (JSON.stringify(observation.identity) !== JSON.stringify(input.identity) || observation.company !== input.company || observation.role !== input.role) {
      throw new AtsError('ATS_IDENTITY_MISMATCH');
    }
    return observation;
  },
  async fill(runtime, input, observation, signal) {
    signal?.throwIfAborted();
    const page = runtime.context.pages()[0] ?? await runtime.page();
    for (const field of observation.fields) {
      await fillField(page, field, input.answers[field.key], input.documents);
      if (!await verifyField(page, field, input.answers[field.key])) throw new AtsError('FIELD_RECONCILIATION_FAILED', field.key);
    }
  },
  async submit(runtime, input, signal) {
    signal?.throwIfAborted();
    const page = runtime.context.pages()[0] ?? await runtime.page();
    const button = page.getByRole('button', { name: 'Submit application', exact: true });
    if (!await button.count()) throw new AtsError('SUBMIT_CONTROL_NOT_FOUND');
    await button.click();
  },
  async receipt(runtime, input, signal) {
    signal?.throwIfAborted();
    const page = runtime.context.pages()[0] ?? await runtime.page();
    return observeReceipt(page, input);
  },
};
