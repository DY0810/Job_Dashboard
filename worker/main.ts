import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { credentials, nativeCredentialBackend, type CredentialBackend, type WorkerScope } from "./credentials.ts";
import { privateStore } from "./storage.ts";
import { controlOrigin, workerTransport, TransportError } from "./transport.ts";
import { PairingMetadataSchema, WorkerCredentialSchema, pairWorker, sameScope, ScopeSchema } from "./pairing.ts";
import { readMaskedGrant } from "./input.ts";
import { runWorker, type WorkerSetup } from "./runtime.ts";
import { createBrowserRuntime } from "./browser.ts";
import { ashby } from "./ats/ashby.ts";
import { greenhouse } from "./ats/greenhouse.ts";
import { runAtsApplication, fillAtsApplication } from "./application-runner.ts";
import { screenApplication } from "./screening.ts";
import { AtsError } from "./ats/protocol.ts";
import type { StageDispatch } from "./runtime.ts";
import { createJevActionSelector, type JevActionSelector } from "./jev.ts";
import {
  createTypesafeProvider, ProviderError, TYPESAFE_ENDPOINT, typesafeBudgetLedger,
} from "./providers.ts";
import type { ProviderConfig } from "../lib/applications/provider-protocol.ts";
import type { ApplicationContext } from "../lib/applications/application-context-protocol.ts";
import type { PrivateStore } from "./storage.ts";

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
  "PROVIDER_RESERVATION_MISSING", "INVALID_PROVIDER_ENDPOINT", "FETCH_UNAVAILABLE",
]);

export function createConfiguredJevActionSelector(
  scope: WorkerScope, config: ProviderConfig, providerStore: PrivateStore, credentialBackend: CredentialBackend,
  fetchImpl?: typeof fetch,
) {
  if (!config.enabled || config.provider !== "typesafe_jev") return undefined;
  const provider = createTypesafeProvider({
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
  return createJevActionSelector(provider);
}

export function hasVerifiedTailoredArtifact(context: Pick<ApplicationContext, "documents" | "tailoredArtifact" | "manifestHash" | "artifactHashes">) {
  const output = context.documents.resume, source = context.documents.resumeMaster, artifact = context.tailoredArtifact;
  return Boolean(output && source && artifact && artifact.documentId === output.documentId && artifact.version === output.version &&
    artifact.sourceDocumentId === source.documentId && artifact.sourceVersion === source.version && artifact.sourceHash === source.sha256 &&
    artifact.outputHash === output.sha256 && context.manifestHash === artifact.verificationManifestHash &&
    context.artifactHashes.includes(artifact.outputHash));
}

export async function main(args = process.argv.slice(2)) {
  if (process.versions.node.split(".")[0] !== "22") throw new Error("NODE_22_REQUIRED");
  if (!["darwin", "linux"].includes(process.platform)) throw new Error("UNSUPPORTED_PLATFORM");
  if (args.length !== 1 || !["pair", "start", "status"].includes(args[0])) {
    process.stdout.write("Usage: npm run worker -- pair|start|status\n");
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
      if (!providerConfig.enabled || providerConfig.provider !== "typesafe_jev") return {};
      const providerStore = await privateStore(directory, { ...scope, workerId: `${scope.workerId}:provider` });
      const chooseAction: JevActionSelector = async (input, options) => {
        const current = await control.providerConfig(options?.signal);
        if (!current.enabled || current.provider !== "typesafe_jev") throw new ProviderError("PROVIDER_DISABLED");
        const selector = createConfiguredJevActionSelector(scope, current, providerStore, backend);
        if (!selector) throw new ProviderError("PROVIDER_DISABLED");
        return selector(input, options);
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
        const adapter = applicationContext.identity.ats === "greenhouse" ? greenhouse :
          applicationContext.identity.ats === "ashby" ? ashby : undefined;
        if (!adapter) return { state: "blocked_unsupported" as const, reasonCode: "adapter_unavailable" };
        const identity = applicationContext.identity as { ats: "greenhouse" | "ashby"; tenant: string; requisition: string };
        const requirement = screenApplication(applicationContext.facts, applicationContext.requirements);
        if (lease.state === "screening") {
          if (requirement.status === "blocked") return { state: "skipped" as const, reasonCode: "screening_ineligible" };
          if (requirement.status === "needs_question") return { state: "needs_answer" as const, reasonCode: "screening_question" };
          return { state: "tailoring" as const, reasonCode: "screened" };
        }
        if (lease.state === "tailoring") {
          return hasVerifiedTailoredArtifact(applicationContext)
            ? { state: "filling" as const, reasonCode: "artifact_verified", evidence: { artifactVerified: true } }
            : { state: "needs_document" as const, reasonCode: "tailored_artifact_required" };
        }
        const workDirectory = await mkdtemp(join(directory, "application-"));
        let runtime: Awaited<ReturnType<typeof createBrowserRuntime>> | undefined;
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
          const application = {
            identity, company: applicationContext.company, role: applicationContext.role,
            applicationUrl: applicationContext.applicationUrl, answers: applicationContext.answers, documents: localDocuments,
            manifestHash: applicationContext.manifestHash!, artifactHashes: applicationContext.artifactHashes,
            submissionIntentId: lease.applicationId,
          };
          const hostname = new URL(application.applicationUrl).hostname;
          runtime = await createBrowserRuntime({
            userDataDir: join(directory, "browser", `${application.identity.ats}-${application.identity.tenant.replace(/[^A-Za-z0-9_-]/g, "_")}`),
            approvedOrigins: [new URL(application.applicationUrl).origin], allowLoopback: /^127\./.test(hostname), headless: true,
          });
          if (lease.state === "filling") {
            const result = await fillAtsApplication({ runtime, adapter, application, facts: applicationContext.facts,
              requirements: applicationContext.requirements, chooseAction: context.chooseAction, signal });
            if (result.state === "needs_answer") return { state: "needs_answer" as const, reasonCode: "form_question" };
            if (result.state === "skipped") return { state: "skipped" as const, reasonCode: "form_ineligible" };
            return { state: "ready" as const, reasonCode: "form_verified", evidence: { formVerified: true } };
          }
          const result = await runAtsApplication({ runtime, adapter, application, facts: applicationContext.facts,
            requirements: applicationContext.requirements, chooseAction: context.chooseAction, signal, submission: {
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
          if (error instanceof AtsError && /REQUIRED_ANSWER|ANSWER_/.test(error.code)) {
            return { state: "needs_answer" as const, reasonCode: "profile_answer_required" };
          }
          if (submissionStarted) return { state: "submission_unknown" as const, reasonCode: "submission_response_lost", durable: true };
          return { state: "retryable_failure" as const, reasonCode: "ats_execution_failed" };
        } finally {
          if (runtime) await runtime.close().catch(() => {});
          await rm(workDirectory, { recursive: true, force: true });
        }
      };
      return { chooseAction, dispatch };
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
