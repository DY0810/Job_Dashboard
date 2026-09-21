import { readFileSync } from "node:fs";
import { runWorker } from "../runtime.ts";
import { privateStore } from "../storage.ts";
import { workerTransport } from "../transport.ts";

// Fixed synthetic process fixture, never loaded by the production CLI.
const config = JSON.parse(readFileSync(0, "utf8"));
if (process.versions.node.split(".")[0] !== "22" || config.fixture !== "question-integration" ||
    !/^http:\/\/127\.0\.0\.1:\d+$/.test(config.scope.origin)) throw new Error("FIXTURE_ONLY");
const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  if (new URL(url instanceof Request ? url.url : url).origin !== config.scope.origin) throw new Error("FIXTURE_ONLY");
  return nativeFetch(url, init);
};
const stop = new AbortController();
process.once("SIGTERM", () => stop.abort());
process.once("SIGINT", () => stop.abort());
const store = await privateStore(config.directory, config.scope);
try {
  await runWorker({
    scope: config.scope, store, signal: stop.signal,
    transport: workerTransport({ origin: config.scope.origin, token: config.token, allowLoopback: true }),
    status: status => process.stdout.write(JSON.stringify({ status }) + "\n"),
    dispatch: config.mode === "register" ? async lease => lease.requisition === "ask" && !lease.checkpoint
      ? { kind: "questions", expectedProfileRevision: 0, company: "Synthetic", role: "Engineer", questions: [config.descriptor] }
      : { state: "blocked_unsupported", reasonCode: "adapter_unavailable" } : undefined,
    observeFocus: config.mode === "observe" ? async command => ({
      result: "observed", reason: null, observation: {
        kind: command.descriptor.kind === "needs_login" ? "login_complete" : "verification_complete",
        ats: "fixture", tenant: "synthetic", requisition: "ask", observedAt: Date.now(),
      },
    }) : undefined,
  });
} catch {
  process.stderr.write('{"error":"fixture_worker_failed"}\n');
  process.exitCode = 1;
}
