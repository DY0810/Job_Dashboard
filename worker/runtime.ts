import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  HEARTBEAT_MS, WORKER_PROTOCOL_VERSION, EventRequestSchema, EventResponseSchema,
  PollResponseSchema,
} from "../lib/applications/worker-protocol.ts";
import type { Lease, EventRequest } from "../lib/applications/worker-protocol.ts";
import { SAFE_STAGES, canTransition } from "../lib/applications/state.ts";
import { createLeaseGuard, systemClock } from "./guard.ts";
import type { ClockSample, LeaseGuard } from "./guard.ts";
import { ScopeSchema, sameScope } from "./pairing.ts";
import type { WorkerScope } from "./credentials.ts";
import type { PrivateStore } from "./storage.ts";
import { TransportError } from "./transport.ts";
import type { WorkerTransport } from "./transport.ts";
import { QuestionBatchSchema } from "../lib/applications/question-protocol.ts";
import { questionClient, QuestionDispatchSchema, abortable, oversized } from "./question-client.ts";
import type { StructuredGenerationResult, StructuredTaskInput } from "./providers.ts";

const transient = (error: unknown) => error instanceof TransportError && (error.message === "NETWORK_UNAVAILABLE" || error.status >= 500);
// Worker-wide: offline, revoked or refused, a server answering in a shape this worker does not know (deployed ahead
// of it), a lost lease (or application), or the local disk. Any other stage error is its application's.
const workerWide = (error: unknown) => transient(error) || (error instanceof Error && "syscall" in error) ||
  (error instanceof TransportError && ([401, 403, 404, 426, 429].includes(error.status) || error.code === "LEASE_LOST" ||
    error.message === "INVALID_RESPONSE"));
/** A bounded reason that never carries a private value: Workie's own UPPER_SNAKE codes, else the error's type. */
const failureReason = (error: unknown) => `worker_${error instanceof TransportError ? `${error.message}${error.code ? `_${error.code}` : ""}`
  : error instanceof z.ZodError ? "schema_invalid"
  : error instanceof Error ? /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(error.message) ? error.message : error.name : "failed"}`
  .toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 80);
// ponytail: one budget for every stage, well past fill plus the 30-minute code or captcha wait at submit.
const STAGE_MS = 60 * 60_000;
// The adapters' wait for the applicant to type a verification code or solve a captcha in the window.
const VERIFICATION_MS = 30 * 60_000;
// ponytail: applications failing one after another for the same reason are not bad postings but the worker (a code
// bug every posting hits). Past this many in a row it stops, as before containment, and the rest of the queue waits.
// The count is kept on disk so a restart does not fail more; any other outcome resets it.
const CONTAINED_LIMIT = 3;
const StreakSchema = z.strictObject({ reasonCode: z.string().nullable(), count: z.number().int().min(0) });

const JournalSchema = z.strictObject({
  version: z.literal(1), scope: ScopeSchema,
  pending: z.strictObject({ applicationId: z.uuid(), event: EventRequestSchema }).nullable(),
  acknowledged: EventResponseSchema.nullable(),
});
const DispatchResultSchema = z.union([QuestionDispatchSchema, z.strictObject({
  state: z.enum(["screening", "tailoring", "filling", "ready", "needs_answer", "needs_document",
    "needs_policy_decision", "needs_login", "needs_verification", "provider_unavailable",
    "retryable_failure", "blocked_unsupported", "failed", "skipped"]),
  // A screening skip lists every failed requirement, comma-separated, for the skipped card.
  reasonCode: z.string().max(80).regex(/^[a-z][a-z0-9_]*(?:,[a-z][a-z0-9_]*)*$/).nullable(),
  evidence: z.strictObject({ artifactVerified: z.boolean().optional(), formVerified: z.boolean().optional(), submitPermit: z.boolean().optional() }).optional(),
}), z.strictObject({
  state: z.enum(["submitted", "submission_unknown"]), reasonCode: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/), durable: z.literal(true),
})]);
type DispatchResult = z.infer<typeof DispatchResultSchema>;
export type StructuredGenerator = (input: StructuredTaskInput, options?: { signal?: AbortSignal; runId?: string }) => Promise<StructuredGenerationResult>;
export type StageDispatchContext = {
  signal: AbortSignal; generate?: StructuredGenerator;
  /** Record a server transition made under this lease (a submission intent) so heartbeats keep it alive. */
  advance?: (value: Pick<Lease, "revision" | "fence" | "state">) => void;
};
export type StageDispatch = (lease: Lease, guard: LeaseGuard, context: StageDispatchContext) => Promise<DispatchResult>;
export type WorkerSetup = (transport: WorkerTransport, signal: AbortSignal) => Promise<{ generate?: StructuredGenerator; dispatch?: StageDispatch }>;
export const unsupportedStage: StageDispatch = async () => ({
  state: "blocked_unsupported", reasonCode: "adapter_unavailable",
});

export async function runWorker(options: {
  scope: WorkerScope; store: PrivateStore;
  transport: WorkerTransport | (() => Promise<WorkerTransport>); signal: AbortSignal;
  dispatch?: StageDispatch; generate?: StructuredGenerator; configure?: WorkerSetup;
  clock?: () => ClockSample;
  status?: (status: "idle" | "active" | "waiting" | "reconciliation-required" | "stopped") => void;
}) {
  const { scope, store } = options;
  const clock = options.clock ?? systemClock;
  const shutdown = new AbortController();
  const signal = AbortSignal.any([options.signal, shutdown.signal]);
  let active: { lease: Lease; guard: LeaseGuard } | null = null;
  let fatal: unknown;
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(action: () => Promise<T>): Promise<T> => {
    const next = queue.then(action);
    queue = next.catch(() => {});
    return next;
  };
  const stop = () => active?.guard.revoke("STOPPED");
  const unlock = await store.lock();
  signal.addEventListener("abort", stop);
  let journal: z.infer<typeof JournalSchema>;
  let streak: z.infer<typeof StreakSchema>;
  let transport: WorkerTransport;
  let generate = options.generate;
  let dispatch = options.dispatch ?? unsupportedStage;
  try {
    signal.throwIfAborted();
    transport = typeof options.transport === "function" ? await options.transport() : options.transport;
    if (options.configure) {
      const configured = await options.configure(transport, signal);
      generate = configured.generate ?? generate;
      dispatch = configured.dispatch ?? dispatch;
    }
    signal.throwIfAborted();
    journal = JournalSchema.parse(await store.read("checkpoint") ?? {
      version: 1, scope, pending: null, acknowledged: null,
    });
    sameScope(scope, journal.scope);
    streak = StreakSchema.parse(await store.read("contained-streak") ?? { reasonCode: null, count: 0 });
  } catch (error) {
    await unlock();
    signal.removeEventListener("abort", stop);
    throw error;
  }
  const fail = (error: unknown) => {
    fatal ??= error;
    active?.guard.revoke("LEASE_LOST");
    shutdown.abort();
  };
  async function acknowledge(applicationId: string, event: EventRequest) {
    const response = EventResponseSchema.parse(await abortable(transport.event(applicationId, event, signal), signal));
    if (response.applicationId !== applicationId || response.eventId !== event.eventId ||
      response.state !== event.state || response.revision !== event.expectedRevision + 1) {
      throw new Error("INVALID_ACKNOWLEDGEMENT");
    }
    journal = { ...journal, pending: null, acknowledged: { ...response, lease: null } };
    await store.write("checkpoint", journal);
    // Even a current acknowledgement never extends mutation authority here. Poll for a fresh fence.
    active?.guard.revoke("CHECKPOINTED");
    active = null;
  }
  const watchdog = setInterval(() => {
    try { active?.guard.check(); } catch (error) { fail(error); }
  }, 1000);
  const heartbeats = (async () => {
    while (!signal.aborted) {
      await delay(HEARTBEAT_MS, undefined, { signal });
      await exclusive(async () => {
        if (signal.aborted) return;
        active?.guard.check();
        const started = clock();
        const lease = active?.lease;
        let response;
        // A missed beat is retried on the next one. Holding a lease, the watchdog still stops work once the
        // last renewed deadline passes (fail closed); a refused beat (revoked, lease lost) stops it now.
        try {
          response = PollResponseSchema.parse(await abortable(transport.heartbeat(lease ? {
            applicationId: lease.applicationId, fence: lease.fence, expectedRevision: lease.revision,
          } : null, signal), signal));
        } catch (error) { if (transient(error)) return; throw error; }
        if (!active) {
          if (response.lease) throw new Error("UNEXPECTED_ASSIGNMENT");
          return;
        }
        if (!response.lease || JSON.stringify(response.lease.checkpoint) !== JSON.stringify(active.lease.checkpoint)) {
          throw new Error("LEASE_LOST");
        }
        active.guard.renew(response.lease, response.serverTime, started);
        active.lease = response.lease;
      });
    }
  })().catch(error => { if (!signal.aborted) fail(error); });
  const questions = questionClient({ scope, store, transport, signal });
  let interventions = Promise.resolve();
  let stage: Promise<unknown> | undefined, submitting = false;
  try {
    await questions.recoverBatch();
    await questions.recoverIntervention();
    if (journal.pending) {
      // No external action is replayed: only the exact previously persisted checkpoint request.
      const { applicationId, event } = journal.pending;
      try { await exclusive(() => acknowledge(applicationId, event)); }
      catch (error) {
        if (!(error instanceof TransportError) || error.status !== 409) throw error;
        // A stale, never-accepted checkpoint gives no authority. Keep a diagnostic, then re-poll.
        await store.write("rejected-checkpoint", journal);
        journal = { ...journal, pending: null };
        await store.write("checkpoint", journal);
      }
    }
    // Independent of dispatch and its lease mutex, after exact pending recovery.
    interventions = (async () => {
      if (!transport.interventions) return; // Existing compiled control-v1 transports remain usable.
      while (!signal.aborted) {
        await questions.pollInterventions();
        await delay(HEARTBEAT_MS, undefined, { signal });
      }
    })().catch(error => { if (!signal.aborted) fail(error); });
    while (!signal.aborted) {
      await exclusive(async () => {
        if (signal.aborted) return;
        const started = clock();
        let response;
        // A poll holds no lease, and the server hands a lost assignment back first, so retry after a blip.
        try { response = PollResponseSchema.parse(await abortable(transport.poll(signal), signal)); }
        catch (error) { if (transient(error)) return; throw error; }
        if (signal.aborted) return;
        if (!response.lease) { options.status?.("idle"); return; }
        active = { lease: response.lease,
          guard: createLeaseGuard(response.lease, scope, response.serverTime, started, clock) };
      });
      if (signal.aborted) break;
      const current = active as { lease: Lease; guard: LeaseGuard } | null;
      if (!current) { await delay(HEARTBEAT_MS, undefined, { signal }); continue; }
      const { lease, guard } = current;
      if (lease.mode === "reconcile" || ["submitting", "submission_unknown"].includes(lease.state)) {
        guard.revoke("RECONCILIATION_ONLY");
        active = null;
        options.status?.("reconciliation-required");
        await delay(HEARTBEAT_MS, undefined, { signal });
        continue;
      }
      if (!SAFE_STAGES.includes(lease.state as typeof SAFE_STAGES[number])) throw new Error("INVALID_STAGE");
      options.status?.("active");
      // A wedged stage would otherwise hold the only lease forever while heartbeats keep the worker Online.
      const budget = setTimeout(() => fail(new Error("STAGE_TIMEOUT")), STAGE_MS);
      let result: DispatchResult, contained: string | null = null;
      submitting = false;
      try {
        stage = guard.boundary(() => dispatch(lease, guard, { signal, generate, advance: value => {
          guard.advance(value);
          submitting = true;
          if (active?.guard === guard) active.lease = { ...active.lease, ...value };
        } }));
        result = DispatchResultSchema.parse(await abortable(stage, signal));
        if (!("kind" in result) && !("durable" in result) &&
          !canTransition(lease.state, result.state, "evidence" in result ? result.evidence ?? {} : {})) throw new Error("EXECUTION_DISABLED");
      } catch (error) {
        // The server hands a restarted worker this same lease first, so a crash here would stop every application.
        // Past a submission intent (a newer revision) only reconciliation may touch the application.
        const reasonCode = failureReason(error);
        if (signal.aborted || workerWide(error) || (active as { lease: Lease; guard: LeaseGuard } | null)?.lease.revision !== lease.revision ||
          (streak.reasonCode === reasonCode && streak.count >= CONTAINED_LIMIT)) throw error;
        result = { state: "retryable_failure", reasonCode };
        contained = reasonCode;
      } finally { clearTimeout(budget); }
      if (!contained && streak.count) {
        streak = { reasonCode: null, count: 0 };
        await store.write("contained-streak", streak);
      }
      guard.check();
      if ("kind" in result) {
        const ask = result;
        const refused = await exclusive(async () => {
          guard.check();
          const batch = QuestionBatchSchema.parse({
            expectedProfileRevision: ask.expectedProfileRevision, company: ask.company,
            role: ask.role, questions: ask.questions,
            questionProtocolVersion: 1, eventId: randomUUID(), fence: lease.fence,
            expectedRevision: lease.revision,
            checkpoint: { stage: lease.state, sequence: (lease.checkpoint?.sequence ?? 0) + 1 },
          });
          // A form too large to journal or register is this application's alone, and nothing reached the server.
          try { await questions.register(lease.applicationId, batch, () => guard.check()); }
          catch (error) { if (oversized(error)) return failureReason(error); throw error; }
          guard.revoke("CHECKPOINTED");
          active = null;
          options.status?.("waiting");
        });
        if (!refused) continue;
        result = { state: "retryable_failure", reasonCode: refused };
      }
      if ("durable" in result && result.durable) {
        // Submission intent/receipt already fenced the server-side state. An old lease
        // cannot emit a second event after that external boundary.
        guard.revoke("DURABLY_CHECKPOINTED");
        active = null;
        options.status?.("waiting");
        continue;
      }
      await exclusive(async () => {
        guard.check();
        const stage = SAFE_STAGES.includes(result.state as typeof SAFE_STAGES[number]) ? result.state : lease.state;
        const event = EventRequestSchema.parse({
          protocolVersion: WORKER_PROTOCOL_VERSION, eventId: randomUUID(), fence: lease.fence,
          expectedRevision: lease.revision, state: result.state,
          checkpoint: { stage, sequence: (lease.checkpoint?.sequence ?? 0) + 1 }, reasonCode: result.reasonCode,
          ...( "evidence" in result && result.evidence ? { evidence: result.evidence } : {}),
        });
        journal = { ...journal, pending: { applicationId: lease.applicationId, event } };
        await guard.boundary(() => store.write("checkpoint", journal));
        await acknowledge(lease.applicationId, event);
        if (contained) {
          streak = { reasonCode: contained, count: streak.reasonCode === contained ? streak.count + 1 : 1 };
          await store.write("contained-streak", streak);
        }
        options.status?.("waiting");
      });
    }
  } catch (error) {
    if (!signal.aborted) fatal ??= error;
  } finally {
    (active as { lease: Lease; guard: LeaseGuard } | null)?.guard.revoke("STOPPED");
    shutdown.abort();
    clearInterval(watchdog);
    await heartbeats;
    await interventions;
    await queue;
    // Past a submission intent the applicant may still be typing a verification code or solving a captcha in the
    // window, and main exits (closing it) once this returns. That wait ignores the signal, so let it end first.
    if (submitting) await Promise.race([stage?.catch(() => {}), delay(VERIFICATION_MS, undefined, { ref: false })]);
    await unlock();
    signal.removeEventListener("abort", stop);
    options.status?.("stopped");
  }
  if (fatal) throw fatal;
}
