import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { credentials, nativeCredentialBackend, type CredentialBackend, type WorkerScope } from "./credentials.ts";
import { privateStore } from "./storage.ts";
import { controlOrigin, workerTransport, TransportError } from "./transport.ts";
import { PairingMetadataSchema, WorkerCredentialSchema, pairWorker, sameScope, ScopeSchema } from "./pairing.ts";
import { readMaskedGrant, readMaskedSecret } from "./input.ts";
import { runWorker, type WorkerSetup } from "./runtime.ts";
import { createBrowserRuntime } from "./browser.ts";
import { ashby } from "./ats/ashby.ts";
import { greenhouse, greenhouseAnswer } from "./ats/greenhouse.ts";
import { runAtsApplication, fillAtsApplication } from "./application-runner.ts";
import { screenApplication, screeningQuestions, formQuestions } from "./screening.ts";
import { AtsError } from "./ats/protocol.ts";
import { AtsIdentitySchema, formQuestionKey, type AtsApplication } from "./ats/protocol.ts";
import { lever } from "./ats/lever.ts";
import { jobvite } from "./ats/jobvite.ts";
import { workday } from "./ats/workday.ts";
import { oracle } from "./ats/oracle.ts";
import { icims } from "./ats/icims.ts";
import type { StageDispatch, StructuredGenerator } from "./runtime.ts";
import type { StructuredGenerationResult } from "./providers.ts";
import { createJevActionSelector, type JevActionSelector } from "./jev.ts";
import {
  createStructuredProvider, createTypesafeProvider, ProviderError, StructuredTaskInputSchema, storeProviderApiKey,
  typesafeBudgetLedger, structuredBudgetLedger, type TypesafeProvider,
} from "./providers.ts";
import type { StructuredProvider } from "./providers.ts";
import {
  BYOK_PROVIDER_ID, LOCAL_OLLAMA_PROVIDER_ID, OMNIROUTE_PROVIDER_ID, TYPESAFE_ENDPOINT,
  ProviderCapabilitySchema, type ProviderCapability, type ProviderConfig,
} from "../lib/applications/provider-protocol.ts";
import type { ApplicationContext } from "../lib/applications/application-context-protocol.ts";
import type { PrivateStore } from "./storage.ts";
import { ApplicationArtifactManifestSchema, artifactRequestId } from "../lib/applications/artifact-protocol.ts";
import { createTemplateManifest, DocumentRuntimeError, tailorDocument } from "./documents/runtime.ts";
import { renderCoverLetter } from "./documents/cover-letter.ts";

const ERROR_CODES = new Set([
  "NODE_22_REQUIRED", "UNSUPPORTED_PLATFORM", "CONFIGURATION_REQUIRED", "INVALID_ORIGIN",
  "LOOPBACK_DISABLED", "TLS_BYPASS_FORBIDDEN", "PRIVATE_DIRECTORY_REQUIRED", "UNSAFE_DIRECTORY",
  "DATA_DIRECTORY_IN_REPOSITORY", "NOT_PAIRED", "WORKER_LOCKED", "CREDENTIAL_UNAVAILABLE",
  "CREDENTIAL_MISSING", "PAIRING_INCOMPLETE", "BINDING_CHANGED", "TTY_REQUIRED", "INVALID_GRANT",
  "INPUT_TIMEOUT", "INPUT_CLOSED", "STOPPED", "CLOCK_UNSAFE", "LEASE_LOST", "LEASE_EXPIRED",
  "INVALID_RESPONSE", "INVALID_ACKNOWLEDGEMENT", "NETWORK_UNAVAILABLE",
  "UNSAFE_STATE_FILE", "LOCAL_STATE_UNREADABLE", "LOCAL_STATE_LIMIT", "EXECUTION_DISABLED",
  "PROVIDER_DISABLED", "REMOTE_PROVIDER_DENIED", "PROVIDER_NOT_ALLOWED", "REMOTE_FALLBACK_DENIED",
  "PROVIDER_OWNER_UNBOUND", "PROVIDER_CREDENTIAL_UNAVAILABLE", "PROVIDER_CREDENTIAL_MISSING",
  "PROVIDER_LEDGER_INVALID", "PROVIDER_LEDGER_LOCKED", "PROVIDER_BUDGET_EXCEEDED", "PROVIDER_NETWORK_UNAVAILABLE",
  "PROVIDER_INVALID_RESPONSE", "PROVIDER_RESPONSE_TOO_LARGE", "PROVIDER_REQUEST_TOO_LARGE", "PROVIDER_USAGE_INVALID",
  "PROVIDER_RESERVATION_MISSING", "PROVIDER_LOW_CONFIDENCE", "PROVIDER_POLICY_INVALID", "PROVIDER_CAPABILITY_MISMATCH", "INVALID_PROVIDER_ENDPOINT", "FETCH_UNAVAILABLE",
  "PROVIDER_FALLBACK_UNSUPPORTED", "PROVIDER_UNKNOWN_COST", "PROVIDER_AUTH_UNAVAILABLE", "PROVIDER_QUOTA_EXCEEDED",
  "PROVIDER_CREDENTIAL_INVALID", "PROVIDER_MODEL_INVALID", "PROVIDER_ID_INVALID", "LOCAL_PROVIDER_POLICY_INVALID", "LOCAL_PROVIDER_ENDPOINT_REQUIRED",
  "REMOTE_PROVIDER_ENDPOINT_INVALID", "ACCOUNT_CREATION_BLOCKED",
]);

export function createConfiguredJevActionSelector(
  scope: WorkerScope, config: ProviderConfig, providerStore: PrivateStore, credentialBackend: CredentialBackend,
  fetchImpl?: typeof fetch,
) {
  const provider = createConfiguredJevProvider(scope, config, providerStore, credentialBackend, fetchImpl);
  return provider ? createJevActionSelector(provider) : undefined;
}

export function createConfiguredJevProvider(
  scope: WorkerScope, config: ProviderConfig, providerStore: PrivateStore, credentialBackend: CredentialBackend,
  fetchImpl?: typeof fetch,
): TypesafeProvider | undefined {
  if (!config.enabled || config.provider !== "typesafe_jev") return undefined;
  return createTypesafeProvider({
    scope, approvedOwnerId: config.ownerId,
    policy: {
      enabled: config.enabled, privacy: config.privacy,
      remoteProviderConsent: config.remoteProviderConsent,
      allowedProviders: config.allowedProviders, fallbackOrder: config.fallbackOrder,
      budget: { currency: "USD", maxUsd: config.maxUsd },
    },
    ledger: typesafeBudgetLedger(providerStore), credentialBackend,
    endpoint: config.endpoint ?? TYPESAFE_ENDPOINT, fetchImpl,
  });
}

export function createStructuredActionSelector(provider: StructuredProvider): JevActionSelector {
  return async (input, options = {}) => {
    const ids = input.actions.map((item) => item.id);
    if (ids.length === 1) {
      if (options.isCurrent && !options.isCurrent(ids)) throw new ProviderError("PROVIDER_DECISION_STALE");
      return { actionId: ids[0], confidence: 1, probabilities: { [ids[0]]: 1 }, model: "deterministic", usage: { input_tokens: 0, output_tokens: 0 } };
    }
    const result = await provider.generate(StructuredTaskInputSchema.parse({
      task: "interpret_form", fields: input.state.fields, observedActions: ids,
    }), { signal: options.signal, runId: options.runId });
    if (options.isCurrent && !options.isCurrent(ids)) throw new ProviderError("PROVIDER_DECISION_STALE");
    if (result.task !== "interpret_form" || !ids.includes(result.actionId)) throw new ProviderError("PROVIDER_INVALID_DECISION");
    const minConfidence = options.minConfidence ?? 0.75;
    if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) throw new ProviderError("PROVIDER_POLICY_INVALID");
    if (result.confidence < minConfidence) throw new ProviderError("PROVIDER_LOW_CONFIDENCE");
    return { actionId: result.actionId, confidence: result.confidence, probabilities: { [result.actionId]: 1 }, model: result.model, usage: result.usage };
  };
}

const PROVIDER_CAPABILITY_CACHE = "provider-capability";
const PROVIDER_CAPABILITY_TTL_MS = 24 * 60 * 60_000;
const CapabilityCacheSchema = z.strictObject({
  configHash: z.string().regex(/^[a-f0-9]{64}$/), checkedAt: z.iso.datetime(), capability: z.unknown(),
});
type CapabilityChecker = { check(signal?: AbortSignal): Promise<ProviderCapability> };

function providerConfigHash(config: ProviderConfig) {
  const withoutCapability = Object.fromEntries(Object.entries(config).filter(([key]) => key !== "capability"));
  return createHash("sha256").update(JSON.stringify(withoutCapability)).digest("hex");
}

/** Cache the explicit synthetic check locally; a worker restart must not spend a new request for the same config. */
export async function ensureProviderCapability(
  config: ProviderConfig, provider: CapabilityChecker, store: PrivateStore, signal?: AbortSignal,
) {
  const configHash = providerConfigHash(config);
  const cached = CapabilityCacheSchema.safeParse(await store.read(PROVIDER_CAPABILITY_CACHE));
  if (cached.success && cached.data.configHash === configHash && Date.parse(cached.data.checkedAt) > Date.now() - PROVIDER_CAPABILITY_TTL_MS) {
    return ProviderCapabilitySchema.parse(cached.data.capability);
  }
  const capability = ProviderCapabilitySchema.parse(await provider.check(signal));
  if (!capability || capability.protocol !== config.protocol || capability.locality !== config.locality || !capability.structuredOutput || capability.tools) {
    throw new ProviderError("PROVIDER_CAPABILITY_MISMATCH");
  }
  await store.write(PROVIDER_CAPABILITY_CACHE, { configHash, checkedAt: capability.checkedAt, capability });
  return capability;
}

export function createConfiguredStructuredProvider(
  scope: WorkerScope, config: ProviderConfig, providerStore: PrivateStore, credentialBackend: CredentialBackend,
  fetchImpl?: typeof fetch,
) {
  if (!config.enabled || !["local_ollama", "omniroute", "byok"].includes(config.provider)) return undefined;
  const providerId = config.provider === "local_ollama" ? LOCAL_OLLAMA_PROVIDER_ID : config.provider === "omniroute" ? OMNIROUTE_PROVIDER_ID : BYOK_PROVIDER_ID;
  const protocol = config.protocol === "ollama_native" || config.protocol === "openai_compatible" ? config.protocol : null;
  const locality = config.locality === "local" || config.locality === "remote" ? config.locality : null;
  if (!protocol || !locality || !config.endpoint || !config.model) throw new ProviderError("PROVIDER_POLICY_INVALID");
  const provider = createStructuredProvider({
    scope, approvedOwnerId: config.ownerId, providerId, protocol, locality, endpoint: config.endpoint, model: config.model,
    policy: { enabled: config.enabled, privacy: config.privacy, remoteProviderConsent: config.remoteProviderConsent,
      allowedProviders: config.allowedProviders, fallbackOrder: config.fallbackOrder, budget: { currency: "USD", ...config.budget } },
    pricing: config.pricing, ledger: structuredBudgetLedger(providerStore), credentialBackend, credentialRequired: config.credential !== "none", fetchImpl,
  });
  return provider;
}

export function providerFailureResult(error: unknown) {
  if (!(error instanceof ProviderError)) return null;
  return {
    state: "provider_unavailable" as const,
    reasonCode: `${error.code}${error.diagnostic ? `_${error.diagnostic}` : ""}`.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 80),
  };
}

export function hasVerifiedTailoredArtifact(context: Pick<ApplicationContext, "documents" | "tailoredArtifact" | "manifestHash" | "artifactHashes">) {
  const output = context.documents.resume, source = context.documents.resumeMaster, artifact = context.tailoredArtifact;
  return Boolean(output && source && artifact && artifact.documentId === output.documentId && artifact.version === output.version &&
    artifact.sourceDocumentId === source.documentId && artifact.sourceVersion === source.version && artifact.sourceHash === source.sha256 &&
    artifact.outputHash === output.sha256 && context.manifestHash === artifact.verificationManifestHash &&
    context.artifactHashes.includes(artifact.outputHash));
}

type TailorGenerated = Extract<StructuredGenerationResult, { task: "tailor" }>;
export function createApplicationArtifactManifest(input: {
  applicationId: string; source: ApplicationContext["documents"][string];
  template: Awaited<ReturnType<typeof createTemplateManifest>>; evidence: { id: string; confirmed: true; excerpt: string }[];
  generated: TailorGenerated; tailored: Awaited<ReturnType<typeof tailorDocument>>;
}) {
  const request = { role: input.template.role, masterHash: input.template.sourceHash, evidence: input.evidence, edits: input.generated.edits };
  const manifest = ApplicationArtifactManifestSchema.parse({
    schemaVersion: 1, applicationId: input.applicationId,
    source: { documentId: input.source.documentId, version: input.source.version, sha256: input.source.sha256 },
    output: { sha256: input.tailored.sha256, mime: input.source.mime, size: input.tailored.bytes.length },
    template: input.tailored.manifest, request, checks: input.tailored.checks,
    tool: { name: "workie-document-runtime", version: "1" },
  });
  return { manifest, request };
}

export async function main(args = process.argv.slice(2)) {
  if (process.versions.node.split(".")[0] !== "22") throw new Error("NODE_22_REQUIRED");
  if (!["darwin", "linux"].includes(process.platform)) throw new Error("UNSUPPORTED_PLATFORM");
  if (args.length !== 1 || !["pair", "start", "status", "stop", "recover", "set-provider-key"].includes(args[0])) {
    process.stdout.write("Usage: npm run worker -- pair|start|status|stop|recover|set-provider-key\n");
    return;
  }
  const allowLoopback = process.env.WORKIE_WORKER_ALLOW_LOOPBACK === "1";
  const origin = controlOrigin(process.env.WORKIE_WORKER_ORIGIN ?? "", allowLoopback);
  const ownerId = z.string().min(1).max(256).parse(process.env.WORKIE_WORKER_OWNER);
  const directory = process.env.WORKIE_WORKER_DIRECTORY;
  if (!directory || !isAbsolute(directory)) throw new Error("CONFIGURATION_REQUIRED");
  const repo = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  const inside = (path: string) => { const rel = relative(repo, path); return !rel || (!rel.startsWith("..") && !isAbsolute(rel)); };
  if (inside(resolve(directory))) throw new Error("DATA_DIRECTORY_IN_REPOSITORY");
  const configStore = await privateStore(directory, { origin, ownerId, workerId: "identity" });
  if (inside(await realpath(directory))) throw new Error("DATA_DIRECTORY_IN_REPOSITORY");
  const unlockConfig = await configStore.lock();
  let scope;
  try {
    scope = await configStore.read("identity");
    if (!scope) {
      if (args[0] !== "pair") throw new Error("NOT_PAIRED");
      scope = { origin, ownerId, workerId: randomUUID() };
      await configStore.write("identity", scope);
    }
    scope = ScopeSchema.parse(scope);
    sameScope(scope, { origin, ownerId, workerId: scope.workerId });
  } finally { await unlockConfig(); }
  const store = await privateStore(directory, scope);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    if (args[0] === "status") {
      const metadata = await store.read("pairing");
      if (!metadata) throw new Error("NOT_PAIRED");
      const parsed = PairingMetadataSchema.parse(metadata);
      sameScope(scope, parsed.scope);
      // Local status does not consult the keychain or falsely claim online/server validity.
      process.stdout.write(JSON.stringify({ ...scope, status: parsed.status, online: "not-checked" }) + "\n");
      return;
    }
    if (args[0] === "stop") {
      const lock = await store.read("lock") as { pid?: number } | null;
      if (!lock) {
        process.stdout.write(JSON.stringify({ ...scope, status: "not-running" }) + "\n");
        return;
      }
      if (!Number.isSafeInteger(lock.pid) || lock.pid! <= 0) throw new Error("WORKER_LOCKED");
      try { process.kill(lock.pid!, "SIGTERM"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw new Error("WORKER_LOCKED");
      }
      process.stdout.write(JSON.stringify({ ...scope, status: "stop-requested" }) + "\n");
      return;
    }
    if (args[0] === "recover") {
      const unlock = await store.lock();
      await unlock();
      process.stdout.write(JSON.stringify({ ...scope, status: "recovered" }) + "\n");
      return;
    }
    if (args[0] === "pair") {
      const unlock = await store.lock();
      try {
        const vault = credentials(scope, await nativeCredentialBackend());
        const metadata = await pairWorker({
          scope, store, vault, transport: workerTransport({ origin, allowLoopback }),
          readGrant: () => readMaskedGrant(process.stdin, process.stderr, controller.signal), signal: controller.signal,
        });
        process.stdout.write(JSON.stringify({ ...scope, status: metadata.status }) + "\n");
      } finally { await unlock(); }
      return;
    }
    if (args[0] === "set-provider-key") {
      const configuredProviderId = process.env.WORKIE_PROVIDER_ID;
      const providerId = configuredProviderId === BYOK_PROVIDER_ID || configuredProviderId === OMNIROUTE_PROVIDER_ID ? configuredProviderId : null;
      if (!providerId) throw new Error("PROVIDER_ID_INVALID");
      const value = await readMaskedSecret(process.stdin, process.stderr, `API key for ${providerId} (hidden): `, undefined, controller.signal);
      await storeProviderApiKey(scope, scope.ownerId, providerId, value, await nativeCredentialBackend());
      process.stdout.write(JSON.stringify({ ...scope, status: "provider-key-saved", providerId }) + "\n");
      return;
    }
    const backend = await nativeCredentialBackend();
    const transport = async () => {
      const metadata = PairingMetadataSchema.parse(await store.read("pairing"));
      sameScope(scope, metadata.scope);
      if (metadata.status !== "paired") throw new Error("NOT_PAIRED");
      const vault = credentials(scope, backend);
      const saved = vault.get("worker");
      if (!saved) throw new Error("CREDENTIAL_MISSING");
      const credential = WorkerCredentialSchema.parse(JSON.parse(saved));
      return workerTransport({ origin, token: credential.workerToken, allowLoopback });
    };
    const setup: WorkerSetup = async (control, signal) => {
      let providerConfig;
      try { providerConfig = await control.providerConfig(signal); }
      catch (error) {
        // Older control-v1 servers fail closed to deterministic execution until upgraded.
        if (!(error instanceof TransportError) || error.status !== 404) throw error;
        return {};
      }
      if (!providerConfig.enabled) return {};
      const providerStore = await privateStore(directory, { ...scope, workerId: `${scope.workerId}:provider` });
      const configuredFor = (current: ProviderConfig): { chooseAction?: JevActionSelector; generate?: StructuredGenerator; check?: CapabilityChecker } | null => {
        if (!current.enabled) return null;
        if (current.provider === "typesafe_jev") {
          const provider = createConfiguredJevProvider(scope, current, providerStore, backend);
          return provider ? { chooseAction: createJevActionSelector(provider), check: provider } : null;
        }
        const provider = createConfiguredStructuredProvider(scope, current, providerStore, backend);
        return provider ? { chooseAction: createStructuredActionSelector(provider), generate: provider.generate, check: provider } : null;
      };
      const configuredForChecked = async (current: ProviderConfig, checkSignal?: AbortSignal) => {
        const configured = configuredFor(current);
        if (!configured) return null;
        if (configured.check) await ensureProviderCapability(current, configured.check, providerStore, checkSignal);
        return configured;
      };
      const chooseAction: JevActionSelector = async (input, options) => {
        const current = await control.providerConfig(options?.signal);
        const configured = input.actions.length > 1
          ? await configuredForChecked(current, options?.signal)
          : configuredFor(current);
        if (!configured?.chooseAction) throw new ProviderError("PROVIDER_DISABLED");
        return configured.chooseAction(input, options);
      };
      const generate: StructuredGenerator = async (input, options) => {
        const current = await control.providerConfig(options?.signal);
        const configured = await configuredForChecked(current, options?.signal);
        if (!configured?.generate) throw new ProviderError("PROVIDER_DISABLED");
        return configured.generate(input, options);
      };
      const dispatch: StageDispatch = async (lease, guard, context) => {
        let applicationContext;
        try {
          applicationContext = await control.applicationContext(lease.applicationId, {
            protocolVersion: 1, applicationId: lease.applicationId, fence: lease.fence, expectedRevision: lease.revision,
          }, signal);
          guard.check();
        } catch (error) {
          if (error instanceof TransportError && error.status === 409 && /NEEDS_DOCUMENT/.test(error.message)) {
            return { state: "needs_document" as const, reasonCode: "resume_required" };
          }
          throw error;
        }
        const adapters = { greenhouse, ashby, lever, jobvite, workday, oracle, icims } as const;
        const adapter = adapters[applicationContext.identity.ats as keyof typeof adapters];
        if (!adapter) return { state: "blocked_unsupported" as const, reasonCode: "adapter_unavailable" };
        const identity = AtsIdentitySchema.parse(applicationContext.identity);
        const requirement = screenApplication(applicationContext.facts, applicationContext.requirements);
        if (lease.state === "screening") {
          if (requirement.status === "blocked") return { state: "skipped" as const, reasonCode: "screening_ineligible" };
          if (requirement.status === "needs_question") return screeningQuestions(applicationContext, requirement.reasons);
          return { state: "tailoring" as const, reasonCode: "screened" };
        }
        if (lease.state === "tailoring") {
          if (hasVerifiedTailoredArtifact(applicationContext)) return { state: "filling" as const, reasonCode: "artifact_verified", evidence: { artifactVerified: true } };
          const source = applicationContext.documents.resumeMaster;
          if (!context.generate || !source) return { state: "needs_document" as const, reasonCode: "tailored_artifact_required" };
          try {
            guard.check();
            const bytes = await control.downloadDocument(lease.applicationId, source.documentId, source.path, signal);
            if (bytes.length !== source.size || createHash("sha256").update(bytes).digest("hex") !== source.sha256) throw new DocumentRuntimeError("DOCUMENT_RECONCILIATION_FAILED");
            const template = await createTemplateManifest(bytes, source.mime, applicationContext.role);
            const evidence = template.anchors.slice(0, 32).map((anchor, index) => ({
              id: artifactRequestId({ applicationId: lease.applicationId, sourceHash: source.sha256, anchorId: anchor.id, index }),
              confirmed: true as const, excerpt: anchor.text.slice(0, 1000),
            }));
            const editableAnchors = [...template.anchors].sort((a, b) => b.maxChars - a.maxChars).slice(0, 5);
            const generated = await context.generate({ task: "tailor", role: template.role,
              jobSummary: applicationContext.requirements.officialDescription.slice(0, 12_000),
              evidence: evidence.map(({ id, excerpt }) => ({ id, excerpt })),
              anchors: editableAnchors.map(({ id, text, maxChars }) => ({ id, text, maxChars })),
            }, { signal, runId: lease.runId });
            if (generated.task !== "tailor" || generated.confidence < 0.75) throw new ProviderError("PROVIDER_LOW_CONFIDENCE");
            const request = { role: template.role, masterHash: template.sourceHash, evidence, edits: generated.edits };
            const tailored = await tailorDocument({ bytes, mime: source.mime, manifest: template, request });
            const requestId = artifactRequestId({ applicationId: lease.applicationId, sourceHash: source.sha256, policyRevision: applicationContext.policyRevision });
            const artifact = createApplicationArtifactManifest({ applicationId: lease.applicationId, source, template,
              evidence, generated, tailored });
            guard.check();
            const intent = await control.artifactIntent(lease.applicationId, { protocolVersion: 1, requestId, fence: lease.fence,
              expectedRevision: lease.revision, manifest: artifact.manifest }, signal);
            await control.uploadArtifact(lease.applicationId, intent.artifactId, intent.uploadPath,
              { protocolVersion: 1, requestId, fence: lease.fence, expectedRevision: lease.revision }, tailored.bytes, source.mime, signal);
            return { state: "filling" as const, reasonCode: "artifact_verified", evidence: { artifactVerified: true } };
          } catch (error) {
            if (signal.aborted) throw error;
            const providerFailure = providerFailureResult(error);
            if (providerFailure) return providerFailure;
            if (error instanceof DocumentRuntimeError) return { state: "needs_document" as const, reasonCode: "document_tailoring_unavailable" };
            return { state: "retryable_failure" as const, reasonCode: error instanceof TransportError ? `tailoring_transport_${error.status}` :
              error instanceof z.ZodError ? "tailoring_schema_invalid" : "tailoring_failed" };
          }
        }
        const workDirectory = await mkdtemp(join(directory, "application-"));
        let runtime: Awaited<ReturnType<typeof createBrowserRuntime>> | undefined;
        let application: AtsApplication | null = null;
        let submissionStarted = false;
        try {
          const localDocuments: Record<string, string> = {};
          for (const [key, document] of Object.entries(applicationContext.documents)) {
            guard.check();
            const bytes = await control.downloadDocument(lease.applicationId, document.documentId, document.path, signal);
            if (bytes.length !== document.size || createHash("sha256").update(bytes).digest("hex") !== document.sha256) {
              throw new Error("DOCUMENT_RECONCILIATION_FAILED");
            }
            const extension = document.mime === "application/pdf" ? ".pdf" : ".docx";
            const path = join(workDirectory, `${key}${extension}`);
            await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
            localDocuments[key] = path;
          }
          if (!localDocuments.resume || !hasVerifiedTailoredArtifact(applicationContext)) {
            return { state: "needs_document" as const, reasonCode: "tailored_artifact_required" };
          }
          application = {
            identity, company: applicationContext.company, role: applicationContext.role,
            applicationUrl: applicationContext.applicationUrl, answers: applicationContext.answers, documents: localDocuments,
            manifestHash: applicationContext.manifestHash!, artifactHashes: applicationContext.artifactHashes,
            submissionIntentId: lease.applicationId,
          };
          const hostname = new URL(application.applicationUrl).hostname;
          runtime = await createBrowserRuntime({
            userDataDir: join(directory, "browser", `${application.identity.ats}-${application.identity.tenant.replace(/[^A-Za-z0-9_-]/g, "_")}`),
            approvedOrigins: [new URL(application.applicationUrl).origin,
              ...(hostname === "job-boards.greenhouse.io" ? ["https://job-boards.cdn.greenhouse.io", "https://s4-recruiting.cdn.greenhouse.io", "https://my.greenhouse.io", "https://boards.greenhouse.io"] : [])],
            allowLoopback: /^127\./.test(hostname), headless: true,
          });
          const observed = await adapter.observe(runtime, application, signal);
          const currentApplication = application;
          for (const field of observed.fields) {
            const reviewed = currentApplication.answers[formQuestionKey(field)];
            if (reviewed !== undefined) currentApplication.answers[field.key] = reviewed;
          }
          const missing = observed.fields.filter(field => field.required && field.kind !== 'file' &&
            (adapter === greenhouse ? greenhouseAnswer(currentApplication, field) :
              currentApplication.answers[formQuestionKey(field)] ?? currentApplication.answers[field.key]) === undefined);
          if (missing.length) return formQuestions(applicationContext, missing);
          if (observed.fields.some(field => field.key === 'cover_letter' && field.kind === 'file')) {
            if (!applicationContext.coverLetterAllowed || !context.generate || !localDocuments.resumeMaster) {
              return { state: "needs_document" as const, reasonCode: "cover_letter_unavailable" };
            }
            const source = await readFile(localDocuments.resumeMaster);
            const template = await createTemplateManifest(source, applicationContext.documents.resumeMaster.mime, applicationContext.role);
            const evidence = template.anchors.slice(0, 32).map((anchor, index) => ({
              id: artifactRequestId({ applicationId: lease.applicationId, sourceHash: template.sourceHash, anchorId: anchor.id, index }),
              excerpt: anchor.text.slice(0, 1000),
            }));
            const letter = await context.generate({ task: 'cover_letter', company: applicationContext.company, role: applicationContext.role,
              jobSummary: applicationContext.requirements.officialDescription.slice(0, 12_000), evidence }, { signal, runId: lease.runId });
            if (letter.task !== 'cover_letter' || letter.confidence < 0.75) throw new ProviderError('PROVIDER_LOW_CONFIDENCE');
            const applicant = [application.answers.first_name, application.answers.last_name].filter((item): item is string => typeof item === 'string').join(' ');
            if (!applicant) throw new AtsError('REQUIRED_ANSWER_MISSING', 'first_name');
            const path = join(workDirectory, 'cover_letter.pdf');
            await writeFile(path, await renderCoverLetter(letter, applicant), { mode: 0o600, flag: 'wx' });
            application.documents.cover_letter = path;
          }
          if (lease.state === "filling") {
            const result = await fillAtsApplication({ runtime, adapter, application, facts: applicationContext.facts,
              requirements: applicationContext.requirements, chooseAction: context.chooseAction, signal, runId: lease.runId });
            if (result.state === "needs_answer") return { state: "needs_answer" as const, reasonCode: "form_question" };
            if (result.state === "skipped") return { state: "skipped" as const, reasonCode: "form_ineligible" };
            return { state: "ready" as const, reasonCode: "form_verified", evidence: { formVerified: true } };
          }
          const result = await runAtsApplication({ runtime, adapter, application, facts: applicationContext.facts,
            requirements: applicationContext.requirements, chooseAction: context.chooseAction, signal, runId: lease.runId, submission: {
              begin: async ({ intentId, identity, company, role, manifestHash, artifactHashes }) => {
                submissionStarted = true;
                return control.submissionIntent(lease.applicationId, { protocolVersion: 1, intentId, fence: lease.fence,
                  expectedRevision: lease.revision, identity, company, role, manifestHash, artifactHashes }, signal);
              },
              receipt: async ({ intentId, receipt, evidence }) => control.receipt(lease.applicationId, {
                protocolVersion: 1, intentId, identity: receipt.identity, company: receipt.company, role: receipt.role,
                receiptId: receipt.receiptId, submittedAt: receipt.submittedAt, evidence,
              }, signal),
            } });
          if (result.state === "submitted" || result.state === "submission_unknown") {
            return { state: result.state, reasonCode: result.reasons[0]?.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 80) || "submission_unknown", durable: true };
          }
          if (result.state === "needs_answer") return { state: "needs_answer" as const, reasonCode: "form_question" };
          if (result.state === "skipped") return { state: "skipped" as const, reasonCode: "screening_ineligible" };
          return { state: "retryable_failure" as const, reasonCode: "application_failed" };
        } catch (error) {
          if (signal.aborted) throw error;
          if (error instanceof AtsError && error.code === "PROVIDER_INSPECT_SELECTED") {
            return { state: "needs_verification" as const, reasonCode: "provider_inspect_required" };
          }
          const providerFailure = providerFailureResult(error);
          if (providerFailure) return providerFailure;
          if (error instanceof AtsError && /REQUIRED_ANSWER|ANSWER_/.test(error.code)) {
            if (runtime && application && !submissionStarted) {
              const observed = await adapter.observe(runtime, application, signal).catch(() => null);
              const field = observed?.fields.find(item => item.key === error.message);
              if (field) return formQuestions(applicationContext, [field]);
            }
            return { state: "needs_answer" as const, reasonCode: "profile_answer_required" };
          }
          if (submissionStarted) return { state: "submission_unknown" as const, reasonCode: "submission_response_lost", durable: true };
          return { state: "retryable_failure" as const, reasonCode: "ats_execution_failed" };
        } finally {
          if (runtime) await runtime.close().catch(() => {});
          await rm(workDirectory, { recursive: true, force: true });
        }
      };
      return { chooseAction, generate, dispatch };
    };
    await runWorker({ scope, store, transport, configure: setup,
      signal: controller.signal, status: status => process.stdout.write(JSON.stringify({ status }) + "\n") });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const code = error instanceof TransportError ? error.message :
      error instanceof Error && ERROR_CODES.has(error.message) ? error.message : "WORKER_FAILED";
    process.stderr.write(JSON.stringify({ error: code }) + "\n");
    process.exitCode = 1;
  });
}
