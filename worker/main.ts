import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { credentials, nativeCredentialBackend } from "./credentials.ts";
import { privateStore } from "./storage.ts";
import { controlOrigin, workerTransport, TransportError } from "./transport.ts";
import { PairingMetadataSchema, WorkerCredentialSchema, pairWorker, sameScope, ScopeSchema } from "./pairing.ts";
import { readMaskedGrant } from "./input.ts";
import { runWorker } from "./runtime.ts";

const ERROR_CODES = new Set([
  "NODE_22_REQUIRED", "UNSUPPORTED_PLATFORM", "CONFIGURATION_REQUIRED", "INVALID_ORIGIN",
  "LOOPBACK_DISABLED", "TLS_BYPASS_FORBIDDEN", "PRIVATE_DIRECTORY_REQUIRED", "UNSAFE_DIRECTORY",
  "DATA_DIRECTORY_IN_REPOSITORY", "NOT_PAIRED", "WORKER_LOCKED", "CREDENTIAL_UNAVAILABLE",
  "CREDENTIAL_MISSING", "PAIRING_INCOMPLETE", "BINDING_CHANGED", "TTY_REQUIRED", "INVALID_GRANT",
  "INPUT_TIMEOUT", "INPUT_CLOSED", "STOPPED", "CLOCK_UNSAFE", "LEASE_LOST", "LEASE_EXPIRED",
  "INVALID_RESPONSE", "INVALID_ACKNOWLEDGEMENT", "NETWORK_UNAVAILABLE",
  "UNSAFE_STATE_FILE", "LOCAL_STATE_UNREADABLE", "LOCAL_STATE_LIMIT", "EXECUTION_DISABLED",
]);

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
    await runWorker({
      scope, store,
      transport: async () => {
        const metadata = PairingMetadataSchema.parse(await store.read("pairing"));
        sameScope(scope, metadata.scope);
        if (metadata.status !== "paired") throw new Error("NOT_PAIRED");
        const vault = credentials(scope, await nativeCredentialBackend());
        const saved = vault.get("worker");
        if (!saved) throw new Error("CREDENTIAL_MISSING");
        const credential = WorkerCredentialSchema.parse(JSON.parse(saved));
        return workerTransport({ origin, token: credential.workerToken, allowLoopback });
      },
      signal: controller.signal, status: status => process.stdout.write(JSON.stringify({ status }) + "\n"),
    });
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
