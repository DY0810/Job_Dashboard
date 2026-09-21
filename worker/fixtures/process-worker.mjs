import { readFileSync, existsSync } from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import { runWorker } from "../runtime.ts";
import { privateStore } from "../storage.ts";
import { workerTransport } from "../transport.ts";

// Fixed synthetic harness only. Production CLI has no executable/adapter/path injection.
const config = JSON.parse(readFileSync(0, "utf8"));
if (!config.scope.origin.startsWith("http://127.0.0.1:") || config.scope.ownerId !== "synthetic-process-owner") {
  throw new Error("FIXTURE_ONLY");
}
const controller = new AbortController();
process.once("SIGTERM", () => controller.abort());
process.once("SIGINT", () => controller.abort());
const store = await privateStore(config.directory, config.scope);
let outcome = "stopped";
try {
  await runWorker({
    scope: config.scope, store, signal: controller.signal,
    transport: workerTransport({ origin: config.scope.origin, token: "F".repeat(43), allowLoopback: true }),
    clock: () => ({ mono: performance.now(), wall: Date.now() + (existsSync(join(config.directory, "jump")) ? 60000 : 0) }),
    dispatch: async (lease, guard) => {
      while (!controller.signal.aborted) {
        await guard.boundary(() => sleep(100, undefined, { signal: guard.signal }));
        await guard.mutate(() => appendFile(join(config.directory, "mutations"), "synthetic\n", { mode: 0o600 }));
      }
      return { state: "blocked_unsupported", reasonCode: "fixture_finished" };
    },
  });
} catch (error) {
  outcome = ["CLOCK_UNSAFE", "HTTP_401", "NETWORK_UNAVAILABLE", "BINDING_CHANGED"].includes(error.message) ? error.message : "fixture_failed";
  process.exitCode = 1;
}
await writeFile(join(config.directory, "done"), JSON.stringify({ outcome }), { mode: 0o600 });
