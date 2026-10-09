import { z } from 'zod';
import type { BrowserRuntime } from './browser.ts';
import { AtsError, type AtsAdapter, type AtsApplication, type AtsReceipt } from './ats/protocol.ts';
import { screenApplication, type ScreeningFacts, type ScreeningRequirements } from './screening.ts';

const resultState = z.enum(['submitted', 'submission_unknown', 'needs_answer', 'skipped', 'blocked_unsupported']);
export const ApplicationRunResultSchema = z.strictObject({
  state: resultState, reasons: z.array(z.string()).max(16), receipt: z.unknown().nullable(), reconciled: z.boolean(),
});
export type ApplicationRunResult = z.infer<typeof ApplicationRunResultSchema> & { receipt: AtsReceipt | null };

async function observeAndFill(input: { runtime: BrowserRuntime; adapter: AtsAdapter; application: AtsApplication; signal?: AbortSignal }) {
  const { runtime, adapter, application, signal } = input;
  await adapter.fill(runtime, application, await adapter.observe(runtime, application, signal), signal);
}

export async function fillAtsApplication(input: {
  runtime: BrowserRuntime; adapter: AtsAdapter; application: AtsApplication;
  facts: ScreeningFacts; requirements: ScreeningRequirements; signal?: AbortSignal; runId?: string;
}) {
  input.signal?.throwIfAborted();
  const decision = screenApplication(input.facts, input.requirements);
  if (decision.status === 'blocked') return { state: 'skipped' as const, reasons: decision.reasons };
  if (decision.status === 'needs_question') return { state: 'needs_answer' as const, reasons: decision.reasons };
  await observeAndFill(input);
  return { state: 'ready' as const, reasons: ['form_verified'] };
}

export async function runAtsApplication(input: {
  runtime: BrowserRuntime; adapter: AtsAdapter; application: AtsApplication;
  facts: ScreeningFacts; requirements: ScreeningRequirements; signal?: AbortSignal; runId?: string;
  submission?: {
    begin: (value: { intentId: string; identity: AtsApplication['identity']; company: string; role: string; manifestHash: string; artifactHashes: string[] }) => Promise<{ intentId: string }>;
    receipt: (value: { intentId: string; receipt: AtsReceipt; evidence: { source: 'confirmation_page'; pageUrl: string; observedText: string } }) => Promise<unknown>;
  };
}): Promise<ApplicationRunResult> {
  const { runtime, adapter, application, signal } = input;
  signal?.throwIfAborted();
  const decision = screenApplication(input.facts, input.requirements);
  if (decision.status === 'blocked') return { state: 'skipped', reasons: decision.reasons, receipt: null, reconciled: false };
  if (decision.status === 'needs_question') return { state: 'needs_answer', reasons: decision.reasons, receipt: null, reconciled: false };
  await observeAndFill(input);
  let submission: { intentId: string } | undefined;
  if (input.submission) {
    if (!application.manifestHash || !application.artifactHashes?.length) throw new AtsError('SUBMISSION_MANIFEST_MISSING');
    const intentId = application.submissionIntentId;
    if (!intentId || !z.uuid().safeParse(intentId).success) throw new AtsError('SUBMISSION_INTENT_ID_MISSING');
    submission = await input.submission.begin({ intentId, identity: application.identity, company: application.company, role: application.role,
      manifestHash: application.manifestHash, artifactHashes: application.artifactHashes });
  }
  const persist = async (receipt: AtsReceipt) => {
    if (input.submission) {
      try {
        const page = runtime.context.pages()[0];
        if (!page) throw new AtsError('RECEIPT_NOT_VERIFIED');
        const confirmation = page.locator('[data-receipt="application"]').first();
        const observedText = (await (await confirmation.count() ? confirmation : page.locator('body')).innerText()).trim().slice(0, 2000);
        if (!observedText) throw new AtsError('RECEIPT_NOT_VERIFIED');
        await input.submission.receipt({ intentId: submission!.intentId, receipt, evidence: {
          source: 'confirmation_page', pageUrl: page.url(), observedText,
        } });
      } catch { return { state: 'submission_unknown' as const, reasons: ['receipt_persistence_failed'], receipt: null, reconciled: false }; }
    }
    return { state: 'submitted' as const, reasons: ['exact_role_receipt'], receipt, reconciled: false };
  };
  try {
    await adapter.submit(runtime, application, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    try {
      const receipt = await adapter.receipt(runtime, application, signal);
      const result = await persist(receipt);
      return { ...result, reasons: result.state === 'submitted' ? ['receipt_reconciled_after_submit_error'] : result.reasons, reconciled: true };
    }
    catch { return { state: 'submission_unknown', reasons: [error instanceof AtsError ? error.code : 'submission_response_lost'], receipt: null, reconciled: false }; }
  }
  try {
    return await persist(await adapter.receipt(runtime, application, signal));
  } catch (error) {
    if (error instanceof AtsError && error.code === 'RECEIPT_NOT_VERIFIED') {
      return { state: 'submission_unknown', reasons: ['receipt_not_verified'], receipt: null, reconciled: false };
    }
    throw error;
  }
}
