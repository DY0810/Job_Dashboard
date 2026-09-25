import { AtsError, AtsObservationSchema, type AtsAdapter, type AtsApplication, type AtsField, observeReceipt, fillField, verifyField } from './protocol.ts';

export type FormAdapterConfig = {
  id: Exclude<AtsAdapter['id'], 'greenhouse' | 'ashby'>;
  fields: AtsField[];
  accountGate?: boolean;
};

async function pageFor(input: AtsApplication, runtime: Parameters<AtsAdapter['observe']>[0]) {
  const page = runtime.context.pages()[0] ?? await runtime.page();
  return runtime.navigate(page, input.applicationUrl);
}

/**
 * Adapter facts are deliberately per-ATS. The helper only owns the repeated
 * observed-form plumbing; it does not invent selectors or submit paths.
 */
export function createFormAdapter(config: FormAdapterConfig): AtsAdapter {
  return {
    id: config.id,
    async observe(runtime, input, signal) {
      signal?.throwIfAborted();
      const page = await pageFor(input, runtime);
      const form = page.locator(`form[data-ats="${config.id}"]`).first();
      if (!await form.count()) throw new AtsError(`${config.id.toUpperCase()}_FORM_NOT_FOUND`);
      if (config.accountGate && await form.getAttribute('data-account-required') === 'true' && input.accountPolicy !== 'allow_new_with_consent') {
        throw new AtsError('ACCOUNT_CREATION_BLOCKED');
      }
      const identity = {
        ats: config.id,
        tenant: await form.getAttribute('data-tenant') ?? input.identity.tenant,
        requisition: await form.getAttribute('data-requisition') ?? input.identity.requisition,
      };
      const observation = AtsObservationSchema.parse({
        identity,
        company: await form.getAttribute('data-company') ?? input.company,
        role: await form.getAttribute('data-role') ?? input.role,
        fields: config.fields,
        actions: ['fill'],
      });
      if (JSON.stringify(observation.identity) !== JSON.stringify(input.identity) ||
          observation.company !== input.company || observation.role !== input.role) {
        throw new AtsError('ATS_IDENTITY_MISMATCH');
      }
      return observation;
    },
    async fill(runtime, input, observation, signal) {
      signal?.throwIfAborted();
      const page = runtime.context.pages()[0] ?? await runtime.page();
      for (const field of observation.fields) {
        await fillField(page, field, input.answers[field.key], input.documents);
        if (!await verifyField(page, field, input.answers[field.key])) {
          throw new AtsError('FIELD_RECONCILIATION_FAILED', field.key);
        }
      }
    },
    async submit(runtime, _input, signal) {
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
}
