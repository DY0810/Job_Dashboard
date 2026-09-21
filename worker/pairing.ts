import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { PairResponseSchema, WORKER_PROTOCOL_VERSION, WORKER_CAPABILITIES } from "../lib/applications/worker-protocol.ts";
import type { WorkerScope, credentials } from "./credentials.ts";
import type { PrivateStore } from "./storage.ts";
import type { WorkerTransport } from "./transport.ts";

export const ScopeSchema = z.strictObject({ origin: z.string(), ownerId: z.string().min(1).max(256), workerId: z.uuid() });
export const PairingMetadataSchema = z.strictObject({
  version: z.literal(1), scope: ScopeSchema, requestId: z.uuid(), workerVersion: z.literal("0.1.0"),
  status: z.enum(["pending", "paired"]), revision: z.number().int().nonnegative(),
});
const secret = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const WorkerCredentialSchema = z.strictObject({ workerToken: secret, grant: secret.optional() });

export function sameScope(a: WorkerScope, b: WorkerScope) {
  if (a.origin !== b.origin || a.ownerId !== b.ownerId || a.workerId !== b.workerId) throw new Error("BINDING_CHANGED");
}

export async function pairWorker(options: {
  scope: WorkerScope; store: PrivateStore; vault: ReturnType<typeof credentials>;
  transport: Pick<WorkerTransport, "pair">; readGrant: () => Promise<string>; signal?: AbortSignal;
}) {
  const { scope, store, vault, transport, signal } = options;
  let metadata = PairingMetadataSchema.parse(await store.read("pairing") ?? {
    version: 1, scope, requestId: randomUUID(), workerVersion: "0.1.0", status: "pending", revision: 0,
  });
  sameScope(scope, metadata.scope);
  await store.write("pairing", metadata);
  signal?.throwIfAborted();
  const saved = vault.get("worker");
  let credential = saved === null ? null : WorkerCredentialSchema.parse(JSON.parse(saved));
  if (metadata.status === "paired") {
    if (!credential) throw new Error("CREDENTIAL_MISSING");
    // A crash after saving paired metadata can leave a consumed grant in the keychain.
    if (credential.grant) vault.set("worker", JSON.stringify({ workerToken: credential.workerToken }));
    return metadata;
  }
  if (!credential) {
    const grant = secret.parse(await options.readGrant());
    signal?.throwIfAborted();
    credential = { workerToken: randomBytes(32).toString("base64url"), grant };
    vault.set("worker", JSON.stringify(credential));
    // Do not register if the store failed to durably return the exact saved credential.
    if (vault.get("worker") !== JSON.stringify(credential)) throw new Error("CREDENTIAL_UNAVAILABLE");
  }
  if (!credential.grant) throw new Error("PAIRING_INCOMPLETE");
  signal?.throwIfAborted();
  const response = PairResponseSchema.parse(await transport.pair({
    protocolVersion: WORKER_PROTOCOL_VERSION, requestId: metadata.requestId,
    workerId: scope.workerId, workerVersion: metadata.workerVersion,
    capabilities: [...WORKER_CAPABILITIES], grant: credential.grant, workerToken: credential.workerToken,
  }, signal));
  signal?.throwIfAborted();
  if (response.ownerId !== scope.ownerId || response.workerId !== scope.workerId) throw new Error("BINDING_CHANGED");
  metadata = { ...metadata, status: "paired", revision: response.revision };
  await store.write("pairing", metadata);
  vault.set("worker", JSON.stringify({ workerToken: credential.workerToken }));
  return metadata;
}
