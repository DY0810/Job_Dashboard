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
import { questionClient, QuestionDispatchSchema, abortable, type FocusObserver } from "./question-client.ts";
import type { JevActionSelector } from "./jev.ts";

const JournalSchema = z.strictObject({
  version: z.literal(1), scope: ScopeSchema,
  pending: z.strictObject({ applicationId: z.uuid(), event: EventRequestSchema }).nullable(),
  acknowledged: EventResponseSchema.nullable(),
});
const DispatchResultSchema = z.union([QuestionDispatchSchema, z.strictObject({
  state: z.enum(["screening", "tailoring", "filling", "ready", "needs_answer", "needs_document",
    "needs_policy_decision", "needs_login", "needs_verification", "provider_unavailable",
    "retryable_failure", "blocked_unsupported", "failed", "skipped"]),
  reasonCode: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/).nullable(),
  evidence: z.strictObject({ artifactVerified: z.boolean().optional(), formVerified: z.boolean().optional(), submitPermit: z.boolean().optional() }).optional(),
}), z.strictObject({
  state: z.enum(["submitted", "submission_unknown"]), reasonCode: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/), durable: z.literal(true),
})]);
type DispatchResult = z.infer<typeof DispatchResultSchema>;
export type StageDispatchContext = { signal: AbortSignal; chooseAction?: JevActionSelector };
export type StageDispatch = (lease: Lease, guard: LeaseGuard, context: StageDispatchContext) => Promise<DispatchResult>;
export type WorkerSetup = (transport: WorkerTransport, signal: AbortSignal) => Promise<{ chooseAction?: JevActionSelector; dispatch?: StageDispatch }>;
export const unsupportedStage: StageDispatch = async () => ({
  state: "blocked_unsupported", reasonCode: "adapter_unavailable",
});

export async function runWorker(options: {
  scope: WorkerScope; store: PrivateStore;
  transport: WorkerTransport | (() => Promise<WorkerTransport>); signal: AbortSignal;
  dispatch?: StageDispatch; chooseAction?: JevActionSelector; configure?: WorkerSetup;
  clock?: () => ClockSample; observeFocus?: FocusObserver;
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
  let transport: WorkerTransport;
  let chooseAction = options.chooseAction;
  let dispatch = options.dispatch ?? unsupportedStage;
  try {
    signal.throwIfAborted();
    transport = typeof options.transport === "function" ? await options.transport() : options.transport;
    if (options.configure) {
      const configured = await options.configure(transport, signal);
      chooseAction = configured.chooseAction ?? chooseAction;
      dispatch = configured.dispatch ?? dispatch;
    }
    signal.throwIfAborted();
    journal = JournalSchema.parse(await store.read("checkpoint") ?? {
      version: 1, scope, pending: null, acknowledged: null,
    });
    sameScope(scope, journal.scope);
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
        const response = PollResponseSchema.parse(await abortable(transport.heartbeat(lease ? {
          applicationId: lease.applicationId, fence: lease.fence, expectedRevision: lease.revision,
        } : null, signal), signal));
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
  const questions = questionClient({ scope, store, transport, signal, observeFocus: options.observeFocus });
  let interventions = Promise.resolve();
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
        const response = PollResponseSchema.parse(await abortable(transport.poll(signal), signal));
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
      const result = DispatchResultSchema.parse(await abortable(
        guard.boundary(() => dispatch(lease, guard, { signal, chooseAction })), signal,
      ));
      guard.check();
      if ("kind" in result) {
        await exclusive(async () => {
          guard.check();
          const batch = QuestionBatchSchema.parse({
            expectedProfileRevision: result.expectedProfileRevision, company: result.company,
            role: result.role, questions: result.questions,
            questionProtocolVersion: 1, eventId: randomUUID(), fence: lease.fence,
            expectedRevision: lease.revision,
            checkpoint: { stage: lease.state, sequence: (lease.checkpoint?.sequence ?? 0) + 1 },
          });
          await questions.register(lease.applicationId, batch, () => guard.check());
          guard.revoke("CHECKPOINTED");
          active = null;
          options.status?.("waiting");
        });
        continue;
      }
      if ("durable" in result && result.durable) {
        // Submission intent/receipt already fenced the server-side state. An old lease
        // cannot emit a second event after that external boundary.
        guard.revoke("DURABLY_CHECKPOINTED");
        active = null;
        options.status?.("waiting");
        continue;
      }
      if (!canTransition(lease.state, result.state, "evidence" in result ? result.evidence ?? {} : {})) throw new Error("EXECUTION_DISABLED");
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
    await unlock();
    signal.removeEventListener("abort", stop);
    options.status?.("stopped");
  }
  if (fatal) throw fatal;
}
