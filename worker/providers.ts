import { randomUUID } from "node:crypto";
import { z } from "zod";
import { nativeCredentialBackend, type CredentialBackend, type WorkerScope } from "./credentials.ts";
import type { PrivateStore } from "./storage.ts";

export const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const TYPESAFE_MODEL = "jev-latest";
export const TYPESAFE_PROVIDER_ID = "typesafe:jev";
export const TYPESAFE_KEYCHAIN_SERVICE = "Workie TypeSafe API";
export const TYPESAFE_KEYCHAIN_ACCOUNT = "dongyeop0810@gmail.com";
export const TYPESAFE_INPUT_PRICE_USD_PER_BILLION = 42;
export const TYPESAFE_MAX_USD = 10;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const RESERVATION_TTL_MS = 10 * 60_000;
const LEDGER_NAME = "typesafe-budget";

export class ProviderError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}

const label = z.string().trim().min(1).max(200);
const action = z.string().trim().regex(/^[a-z][a-z0-9:_-]{0,63}$/);
const field = z.strictObject({
  label, kind: z.enum(["text", "textarea", "number", "date", "choice", "document", "boolean", "intervention"]),
  options: z.array(label).max(32).optional(),
});

/** State that can cross the provider boundary. It has labels and choices, never form values. */
export const ProviderStateSchema = z.strictObject({
  company: label, role: label, ats: z.string().trim().min(1).max(80), tenant: z.string().trim().min(1).max(80),
  fields: z.array(field).max(64), observedActions: z.array(action).max(16),
}).refine((value) => new Set(value.observedActions).size === value.observedActions.length, 'Duplicate observed actions.');
export type ProviderState = z.infer<typeof ProviderStateSchema>;

const sensitiveLabel = /\b(?:password|passcode|one[- ]time|otp|ssn|social security|tax id|credit card|routing number|bank account|resume|cover letter)\b/i;
const email = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const phone = /(?<!\d)(?:\+?\d[\d .()\-]{7,}\d)(?!\d)/g;
const longNumber = /(?<!\d)\d{9,}(?!\d)/g;

function redact(value: string) {
  const text = value.trim();
  if (sensitiveLabel.test(text)) return "[redacted label]";
  return text.replace(email, "[redacted]").replace(phone, "[redacted]").replace(longNumber, "[redacted]");
}

/** Normalize caller input before Zod validation so values cannot be smuggled as labels. */
export function redactedProviderState(input: unknown): ProviderState {
  const parsed = ProviderStateSchema.parse(input);
  return ProviderStateSchema.parse({
    ...parsed,
    company: redact(parsed.company), role: redact(parsed.role),
    fields: parsed.fields.map((item) => ({ ...item, label: redact(item.label),
      ...(item.options ? { options: item.options.map(redact) } : {}) })),
  });
}

export const ProviderPolicySchema = z.strictObject({
  enabled: z.boolean(), privacy: z.enum(["local_inference_only", "fully_local", "approved_remote"]),
  remoteProviderConsent: z.boolean(), allowedProviders: z.array(z.string().trim().min(1).max(100)).max(20),
  fallbackOrder: z.array(z.string().trim().min(1).max(100)).max(20),
  budget: z.strictObject({ currency: z.literal("USD"), maxUsd: z.number().finite().min(0).max(TYPESAFE_MAX_USD) }),
});
export type ProviderPolicy = z.infer<typeof ProviderPolicySchema>;

export function assertProviderPolicy(policyInput: unknown) {
  const policy = ProviderPolicySchema.parse(policyInput);
  if (!policy.enabled) throw new ProviderError("PROVIDER_DISABLED");
  if (policy.privacy !== "approved_remote" || !policy.remoteProviderConsent) {
    throw new ProviderError("REMOTE_PROVIDER_DENIED");
  }
  if (!policy.allowedProviders.includes(TYPESAFE_PROVIDER_ID)) throw new ProviderError("PROVIDER_NOT_ALLOWED");
  if (policy.fallbackOrder.length > 0) throw new ProviderError("REMOTE_FALLBACK_DENIED");
  return policy;
}

export function maxInputTokensForUsd(usd: number) {
  if (!Number.isFinite(usd) || usd < 0 || usd > TYPESAFE_MAX_USD) throw new ProviderError("BUDGET_POLICY_INVALID");
  return Math.floor((usd * 1_000_000_000) / TYPESAFE_INPUT_PRICE_USD_PER_BILLION);
}

export async function readTypesafeApiKey(
  scope: WorkerScope, approvedOwnerId: string, backend?: CredentialBackend,
  address: { service: string; account: string } = { service: TYPESAFE_KEYCHAIN_SERVICE, account: TYPESAFE_KEYCHAIN_ACCOUNT },
) {
  if (scope.ownerId !== approvedOwnerId) throw new ProviderError("PROVIDER_OWNER_UNBOUND");
  const get = backend ?? await nativeCredentialBackend();
  let value: string | null;
  try { value = get(address.service, address.account, { linux: { store: "secret-service" } }).getPassword(); }
  catch { throw new ProviderError("PROVIDER_CREDENTIAL_UNAVAILABLE"); }
  if (!value || Buffer.byteLength(value) > 16_384) throw new ProviderError("PROVIDER_CREDENTIAL_MISSING");
  return value;
}

const questionId = z.string().regex(/^[a-z][a-z0-9_:-]{0,63}$/);
const instructions = z.string().trim().min(1).max(2_000);
const criteriaValue = z.union([z.string().max(2_000), z.null()]);
const choiceQuestion = z.strictObject({ type: z.literal("choice"), instructions,
  criteria: z.record(questionId, criteriaValue).refine((value) => Object.keys(value).length >= 2 && Object.keys(value).length <= 16) });
const noulQuestion = z.strictObject({ type: z.literal("noul"), instructions,
  criteria: z.strictObject({ true: z.string().max(2_000).optional(), false: z.string().max(2_000).optional() }).optional() });
const scoreQuestion = z.strictObject({ type: z.literal("score"), instructions,
  criteria: z.array(z.string().max(2_000)).min(2).max(10) });
export const ProviderQuestionSchema = z.discriminatedUnion("type", [choiceQuestion, noulQuestion, scoreQuestion]);
export const ProviderQuestionsSchema = z.record(questionId, ProviderQuestionSchema)
  .refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= 8);
export type ProviderQuestion = z.infer<typeof ProviderQuestionSchema>;

export const TypesafeRequestSchema = z.strictObject({
  state: ProviderStateSchema, model: z.literal(TYPESAFE_MODEL), questions: ProviderQuestionsSchema,
});

const usage = z.strictObject({ input_tokens: z.number().int().nonnegative().max(100_000_000), output_tokens: z.number().int().nonnegative().max(100_000_000) });
const probabilities = z.record(z.string(), z.number().finite().min(0).max(1));
const responseEnvelope = z.strictObject({ model: z.string().trim().min(1).max(100), answers: z.record(z.string(), z.unknown()), usage });
const choiceAnswer = z.strictObject({ type: z.literal("choice"), choice: questionId, probabilities, confidence: z.number().finite().min(0).max(1) });
const noulAnswer = z.strictObject({ type: z.literal("noul"), noul: z.number().finite().min(0).max(1) });
const scoreAnswer = z.strictObject({ type: z.literal("score"), score: z.number().finite(), legend: z.record(z.string(), z.string()), probabilities, confidence: z.number().finite().min(0).max(1) });
export type ProviderAnswer = z.infer<typeof choiceAnswer> | z.infer<typeof noulAnswer> | z.infer<typeof scoreAnswer>;
export type TypesafeResult = { model: string; answers: Record<string, ProviderAnswer>; usage: z.infer<typeof usage> };

function responseFailure(): never { throw new ProviderError("PROVIDER_INVALID_RESPONSE"); }
const VERSIONED_JEV_MODEL = /^jev-\d+\.\d+\.\d+$/;
function sameKeys(actual: Record<string, unknown>, expected: string[]) {
  const keys = Object.keys(actual).sort(), wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
}
function probabilityKeys(answer: { probabilities: Record<string, number> }, expected: string[]) {
  if (!sameKeys(answer.probabilities, expected)) responseFailure();
  const sum = Object.values(answer.probabilities).reduce((total, value) => total + value, 0);
  if (Math.abs(sum - 1) > 0.001) responseFailure();
}

/** Parse every response field against the exact question sent; never trust model-selected keys. */
export function parseTypesafeResponse(input: unknown, request: z.infer<typeof TypesafeRequestSchema>): TypesafeResult {
  const envelope = responseEnvelope.safeParse(input);
  if (!envelope.success || !VERSIONED_JEV_MODEL.test(envelope.data.model) ||
      !sameKeys(envelope.data.answers, Object.keys(request.questions))) responseFailure();
  const answers: Record<string, ProviderAnswer> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    const raw = envelope.data.answers[id];
    if (question.type === "choice") {
      const answer = choiceAnswer.safeParse(raw);
      if (!answer.success || !question.criteria || !Object.hasOwn(question.criteria, answer.data.choice)) responseFailure();
      probabilityKeys(answer.data, Object.keys(question.criteria));
      answers[id] = answer.data;
    } else if (question.type === "noul") {
      const answer = noulAnswer.safeParse(raw);
      if (!answer.success) responseFailure();
      answers[id] = answer.data;
    } else {
      const answer = scoreAnswer.safeParse(raw);
      if (!answer.success || !sameKeys(answer.data.legend, question.criteria.map((_level, index) => String(index)))) responseFailure();
      if (question.criteria.some((level, index) => answer.data.legend[String(index)] !== level)) responseFailure();
      probabilityKeys(answer.data, question.criteria.map((_level, index) => String(index)));
      answers[id] = answer.data;
    }
  }
  return { model: envelope.data.model, answers, usage: envelope.data.usage };
}

const reservation = z.strictObject({ inputTokens: z.number().int().positive(), expiresAt: z.number().int().positive() });
const ledger = z.strictObject({ version: z.literal(1), spentInputTokens: z.number().int().nonnegative(), requests: z.number().int().nonnegative(),
  reservations: z.record(z.uuid(), reservation), last: z.strictObject({ model: z.string(), chargedInputTokens: z.number().int().positive(), reportedInputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), recordedAt: z.number().int().positive() }).nullable() });
const emptyLedger = { version: 1 as const, spentInputTokens: 0, requests: 0, reservations: {}, last: null };
export type TypesafeBudgetLedger = ReturnType<typeof typesafeBudgetLedger>;

/** A second store is required: the worker's main lock is held during runtime execution. */
export function typesafeBudgetLedger(store: PrivateStore) {
  async function read() {
    try { return ledger.parse(await store.read(LEDGER_NAME) ?? emptyLedger); }
    catch { throw new ProviderError("PROVIDER_LEDGER_INVALID"); }
  }
  async function withLock<T>(action: () => Promise<T>) {
    let unlock;
    try { unlock = await store.lock(); } catch { throw new ProviderError("PROVIDER_LEDGER_LOCKED"); }
    try { return await action(); } finally { await unlock(); }
  }
  return {
    async snapshot() { return withLock(read); },
    async reserve(inputTokens: number, maxTokens: number) {
      if (!Number.isSafeInteger(inputTokens) || inputTokens < 1 || !Number.isSafeInteger(maxTokens) || maxTokens < 1) {
        throw new ProviderError("BUDGET_POLICY_INVALID");
      }
      return withLock(async () => {
        const current = await read(), now = Date.now();
        for (const [id, item] of Object.entries(current.reservations)) if (item.expiresAt <= now) delete current.reservations[id];
        const reserved = Object.values(current.reservations).reduce((total, item) => total + item.inputTokens, 0);
        if (current.spentInputTokens + reserved + inputTokens > maxTokens) throw new ProviderError("PROVIDER_BUDGET_EXCEEDED");
        const id = randomUUID();
        current.reservations[id] = { inputTokens, expiresAt: now + RESERVATION_TTL_MS };
        await store.write(LEDGER_NAME, current);
        return id;
      });
    },
    async settle(id: string, reportedInputTokens: number, outputTokens: number, model: string) {
      if (!Number.isSafeInteger(reportedInputTokens) || reportedInputTokens < 0 ||
          !Number.isSafeInteger(outputTokens) || outputTokens < 0) throw new ProviderError("PROVIDER_USAGE_INVALID");
      return withLock(async () => {
        const current = await read(), item = current.reservations[id];
        if (!item) throw new ProviderError("PROVIDER_RESERVATION_MISSING");
        delete current.reservations[id];
        const chargedInputTokens = Math.max(item.inputTokens, reportedInputTokens);
        current.spentInputTokens += chargedInputTokens;
        current.requests += 1;
        current.last = { model, chargedInputTokens, reportedInputTokens, outputTokens, recordedAt: Date.now() };
        await store.write(LEDGER_NAME, current);
        return { chargedInputTokens };
      });
    },
    async release(id: string) {
      return withLock(async () => {
        const current = await read();
        if (current.reservations[id]) { delete current.reservations[id]; await store.write(LEDGER_NAME, current); }
      });
    },
  };
}

function endpointAllowed(endpoint: string, allowLoopback: boolean) {
  const parsed = new URL(endpoint);
  if (parsed.protocol === "https:" && parsed.origin === TYPESAFE_ENDPOINT.replace("/v1/systemone", "")) return;
  if (allowLoopback && parsed.protocol === "http:" && parsed.hostname === "127.0.0.1") return;
  throw new ProviderError("INVALID_PROVIDER_ENDPOINT");
}

async function readProviderResponse(response: Response) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new ProviderError("PROVIDER_RESPONSE_TOO_LARGE");
  }
  if (response.body) {
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        total += chunk.value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => {});
          throw new ProviderError("PROVIDER_RESPONSE_TOO_LARGE");
        }
        chunks.push(Buffer.from(chunk.value));
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new ProviderError("PROVIDER_RESPONSE_TOO_LARGE");
  return text;
}

export function createTypesafeProvider(options: {
  scope: WorkerScope; approvedOwnerId: string; policy: unknown; ledger: TypesafeBudgetLedger;
  credential?: () => Promise<string | null>; credentialBackend?: CredentialBackend;
  fetchImpl?: typeof fetch; endpoint?: string; allowLoopback?: boolean;
}) {
  if (options.scope.ownerId !== options.approvedOwnerId) throw new ProviderError("PROVIDER_OWNER_UNBOUND");
  const endpoint = options.endpoint ?? TYPESAFE_ENDPOINT;
  endpointAllowed(endpoint, options.allowLoopback === true);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) throw new ProviderError("FETCH_UNAVAILABLE");
  return {
    async evaluate(stateInput: unknown, questionsInput: unknown, callerSignal?: AbortSignal): Promise<TypesafeResult> {
      const policy = assertProviderPolicy(options.policy);
      const request = TypesafeRequestSchema.parse({ state: redactedProviderState(stateInput), model: TYPESAFE_MODEL, questions: questionsInput });
      const body = JSON.stringify(request);
      const inputEstimate = Buffer.byteLength(body);
      if (inputEstimate < 1 || inputEstimate > MAX_REQUEST_BYTES) throw new ProviderError("PROVIDER_REQUEST_TOO_LARGE");
      const key = options.credential ? await options.credential() :
        await readTypesafeApiKey(options.scope, options.approvedOwnerId, options.credentialBackend);
      if (!key) throw new ProviderError("PROVIDER_CREDENTIAL_MISSING");
      const id = await options.ledger.reserve(inputEstimate, maxInputTokensForUsd(policy.budget.maxUsd));
      let settled = false;
      try {
        const requestSignal = callerSignal
          ? AbortSignal.any([callerSignal, AbortSignal.timeout(10_000)])
          : AbortSignal.timeout(10_000);
        let response: Response;
        try {
          response = await fetchImpl(endpoint, { method: "POST", redirect: "error", cache: "no-store",
            headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body,
            signal: requestSignal });
        } catch { await options.ledger.settle(id, inputEstimate, 0, "network-error"); settled = true; throw new ProviderError("PROVIDER_NETWORK_UNAVAILABLE"); }
        if (!response.ok) {
          await options.ledger.settle(id, inputEstimate, 0, `http-${response.status}`); settled = true;
          throw new ProviderError(`PROVIDER_HTTP_${response.status}`);
        }
        let raw: unknown;
        try { raw = JSON.parse(await readProviderResponse(response)); } catch (error) {
          await options.ledger.settle(id, inputEstimate, 0, "invalid-json"); settled = true;
          if (error instanceof ProviderError && error.code === "PROVIDER_RESPONSE_TOO_LARGE") throw error;
          throw new ProviderError("PROVIDER_INVALID_RESPONSE");
        }
        let result: TypesafeResult;
        try { result = parseTypesafeResponse(raw, request); } catch (error) {
          await options.ledger.settle(id, inputEstimate, 0, "invalid-response"); settled = true;
          throw error;
        }
        await options.ledger.settle(id, result.usage.input_tokens, result.usage.output_tokens, result.model);
        settled = true;
        return result;
      } catch (error) {
        if (!settled) await options.ledger.settle(id, inputEstimate, 0, "provider-error").catch(() => {});
        throw error;
      }
    },
  };
}
