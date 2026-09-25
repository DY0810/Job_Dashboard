import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  QuestionBatchSchema, QuestionBatchResultSchema, InterventionCommandSchema, InterventionAckSchema,
  InterventionPageSchema, FocusResultSchema,
} from "../lib/applications/question-protocol.ts";
import type { QuestionBatch, InterventionCommand, InterventionAck } from "../lib/applications/question-protocol.ts";
import { ScopeSchema, sameScope } from "./pairing.ts";
import type { WorkerScope } from "./credentials.ts";
import type { PrivateStore } from "./storage.ts";
import { TransportError, type WorkerTransport } from "./transport.ts";

export const QuestionDispatchSchema = z.strictObject({
  kind: z.literal("questions"),
  expectedProfileRevision: QuestionBatchSchema.shape.expectedProfileRevision,
  company: QuestionBatchSchema.shape.company, role: QuestionBatchSchema.shape.role,
  questions: QuestionBatchSchema.shape.questions,
});
export type QuestionDispatch = z.infer<typeof QuestionDispatchSchema>;
// Compiled integration only. No module paths, model code, or UI completion assertions.
export type FocusObserver = (command: InterventionCommand, signal: AbortSignal) =>
  Promise<Pick<InterventionAck, "result" | "reason" | "observation">>;
const ObservationSchema = z.strictObject({
  result: InterventionAckSchema.shape.result, reason: InterventionAckSchema.shape.reason,
  observation: InterventionAckSchema.shape.observation,
});
const BatchJournalSchema = z.strictObject({
  version: z.literal(1), scope: ScopeSchema,
  pending: z.strictObject({ applicationId: z.uuid(), batch: QuestionBatchSchema }).nullable(),
});
const InterventionJournalSchema = z.strictObject({
  version: z.literal(1), scope: ScopeSchema,
  pending: z.strictObject({ command: InterventionCommandSchema, ack: InterventionAckSchema }).nullable(),
});

export async function abortable<T>(action: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void action.catch(() => {}); throw new Error("STOPPED"); }
  let abort = () => {};
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(new Error("STOPPED"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([action, stopped]); }
  finally { signal.removeEventListener("abort", abort); }
}

export function questionClient(options: {
  scope: WorkerScope; store: PrivateStore; transport: WorkerTransport; signal: AbortSignal;
  observeFocus?: FocusObserver;
}) {
  const { scope, store, transport, signal } = options;
  const empty = { version: 1 as const, scope, pending: null };
  let lastCommand: string | undefined;
  async function register(applicationId: string, batch: QuestionBatch) {
    const response = QuestionBatchResultSchema.parse(await abortable(transport.questionBatch(applicationId, batch, signal), signal));
    if (response.applicationId !== applicationId || response.eventId !== batch.eventId ||
        response.revision !== batch.expectedRevision + 1 || response.questionIds.length !== batch.questions.length ||
        new Set(response.questionIds).size !== response.questionIds.length) throw new Error("INVALID_ACKNOWLEDGEMENT");
    await store.write("question-checkpoint", empty);
    return response;
  }
  async function acknowledge(command: InterventionCommand, ack: InterventionAck) {
    if (command.workerId !== scope.workerId) throw new Error("BINDING_CHANGED");
    const response = FocusResultSchema.parse(await abortable(transport.ackIntervention(command.id, ack, signal), signal));
    if (response.id !== command.id || response.questionId !== command.questionId ||
        response.applicationId !== command.applicationId || response.workerId !== scope.workerId ||
        response.revision !== ack.expectedRevision + 1 || response.status !== ack.result) {
      throw new Error("INVALID_ACKNOWLEDGEMENT");
    }
    await store.write("intervention-checkpoint", empty);
  }
  async function stale(error: unknown, name: string, value: unknown) {
    if (!(error instanceof TransportError) || ![404, 409].includes(error.status)) throw error;
    await store.write(`rejected-${name}`, value);
    await store.write(`${name}-checkpoint`, empty);
  }
  async function recoverIntervention() {
    const journal = InterventionJournalSchema.parse(await store.read("intervention-checkpoint") ?? empty);
    sameScope(scope, journal.scope);
    if (journal.pending) {
      try { await acknowledge(journal.pending.command, journal.pending.ack); }
      catch (error) { await stale(error, "intervention", journal); }
    }
  }
  return {
    recoverIntervention,
    async recoverBatch() {
      const journal = BatchJournalSchema.parse(await store.read("question-checkpoint") ?? empty);
      sameScope(scope, journal.scope);
      if (journal.pending) {
        try { await register(journal.pending.applicationId, journal.pending.batch); }
        catch (error) { await stale(error, "question", journal); }
      }
    },
    async register(applicationId: string, batch: QuestionBatch, check: () => void) {
      const journal = BatchJournalSchema.parse({ ...empty, pending: { applicationId, batch } });
      check(); signal.throwIfAborted();
      await store.write("question-checkpoint", journal);
      check(); signal.throwIfAborted();
      return register(applicationId, journal.pending!.batch);
    },
    async pollInterventions() {
      await recoverIntervention();
      signal.throwIfAborted();
      let page;
      // Fetching the page changes nothing, so a network blip skips this beat; a failed acknowledgement still stops
      // the worker so its journaled acknowledgement is replayed, never observed twice.
      try { page = InterventionPageSchema.parse(await abortable(transport.interventions(signal), signal)); }
      catch (error) {
        if (error instanceof TransportError && (error.message === "NETWORK_UNAVAILABLE" || error.status >= 500)) return;
        throw error;
      }
      if (page.commands.some(c => c.workerId !== scope.workerId ||
        !["pending", "focused", "unavailable"].includes(c.status) ||
        !["needs_login", "needs_verification"].includes(c.descriptor.kind))) throw new Error("BINDING_CHANGED");
      // One bounded observation per poll; round-robin avoids one focused job monopolizing the worker.
      const command = page.commands[(page.commands.findIndex(c => c.id === lastCommand) + 1) % page.commands.length];
      if (!command) return;
      lastCommand = command.id;
      let result: Awaited<ReturnType<FocusObserver>> = {
        result: "unavailable", reason: "browser_not_implemented", observation: null,
      };
      if (options.observeFocus) {
        const observerStop = new AbortController();
        const observerSignal = AbortSignal.any([signal, observerStop.signal]);
        const timer = setTimeout(() => observerStop.abort(), 8000);
        try { result = await abortable(Promise.resolve().then(() => options.observeFocus!(command, observerSignal)), observerSignal); }
        catch {
          signal.throwIfAborted();
          result = { result: "unavailable", reason: "focus_observer_unavailable", observation: null };
        } finally { clearTimeout(timer); observerStop.abort(); }
      }
      signal.throwIfAborted();
      const ack = InterventionAckSchema.parse({
        questionProtocolVersion: 1, eventId: randomUUID(), expectedRevision: command.revision,
        expectedApplicationRevision: command.expectedApplicationRevision, fence: command.fence, ...ObservationSchema.parse(result),
      });
      if (ack.observation && (ack.observation.ats !== command.descriptor.scope.ats ||
        ack.observation.tenant !== command.descriptor.scope.tenant ||
        ack.observation.kind !== (command.descriptor.kind === "needs_login" ? "login_complete" : "verification_complete"))) {
        throw new Error("BINDING_CHANGED");
      }
      // Server checks exact requisition, freshness, policy, owner, fence and stop/revoke state.
      const pending = { ...empty, pending: { command, ack } };
      await store.write("intervention-checkpoint", pending);
      signal.throwIfAborted();
      try { await acknowledge(command, ack); }
      catch (error) { await stale(error, "intervention", pending); }
    },
  };
}
