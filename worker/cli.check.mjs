import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { privateStore } from "./storage.ts";
import { keychainAddress } from "./credentials.ts";
import { SAFE_STAGES } from "../lib/applications/state.ts";
import {
  PairRequestSchema, PollRequestSchema, EventRequestSchema, PollResponseSchema,
  PairResponseSchema, EventResponseSchema,
} from "../lib/applications/worker-protocol.ts";
import { InterventionPollSchema, InterventionPageSchema } from "../lib/applications/question-protocol.ts";

const ownerId = "synthetic-cli-owner";
const clock = () => ({ protocolVersion: 1, serverTime: Date.now(), heartbeatMs: 20000, leaseMs: 120000 });
async function fixture(t, handler) {
  const directory = await mkdtemp(join(tmpdir(), "worker-cli-"));
  const errors = [];
  const server = createServer((req, res) => {
    Promise.resolve().then(async () => {
      if (req.url === "/api/worker/interventions") {
        assert.match(req.headers.authorization ?? "", /^Bearer [A-Za-z0-9_-]{43}$/);
        assert.equal(req.headers.cookie, undefined);
        InterventionPollSchema.parse(await body(req));
        return json(res, InterventionPageSchema, { questionProtocolVersion: 1, commands: [] });
      }
      return handler(req, res);
    }).catch(error => { errors.push(error); res.destroy(); });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  return { directory, origin: `http://127.0.0.1:${server.address().port}` };
}
function cli(t, scope, command, config = {}, onOutput = () => {}) {
  const child = spawn(process.execPath, [
    "--import", fileURLToPath(new URL("./fixtures/cli-keychain.mjs", import.meta.url)),
    fileURLToPath(new URL("./main.ts", import.meta.url)), command,
  ], {
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    env: {
      HOME: scope.directory, TMPDIR: scope.directory, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      WORKIE_DB: join(scope.directory, "unused.db"), WORKIE_WORKER_ORIGIN: scope.origin,
      WORKIE_WORKER_OWNER: ownerId, WORKIE_WORKER_DIRECTORY: scope.directory, WORKIE_WORKER_ALLOW_LOOPBACK: "1",
    },
  });
  let stdout = "", stderr = "", vault;
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr, vault }));
  });
  child.stdout.on("data", chunk => { stdout += chunk; onOutput(stdout, child); });
  child.stderr.on("data", chunk => stderr += chunk);
  child.on("message", message => { vault = message; });
  child.stdin.end(JSON.stringify(config));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await done;
  });
  return done;
}
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}
function json(res, schema, value) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(schema.parse(value)));
}
async function seed(scope) {
  const identity = { origin: scope.origin, ownerId, workerId: randomUUID() };
  const configStore = await privateStore(scope.directory, { ...identity, workerId: "identity" });
  await configStore.write("identity", identity);
  const store = await privateStore(scope.directory, identity);
  await store.write("pairing", { version: 1, scope: identity, requestId: randomUUID(),
    workerVersion: "0.1.0", status: "paired", revision: 1 });
  const { service, account } = keychainAddress(identity, "worker");
  return { identity, store, items: [[JSON.stringify([service, account]), JSON.stringify({ workerToken: "K".repeat(43) })]] };
}

test("actual CLI pairs across lost response, reports local status and dispatches only unsupported protocol events", { timeout: 10000 }, async t => {
  const pairs = [], events = [], jobs = [];
  const scope = await fixture(t, async (req, res) => {
    const input = await body(req);
    assert.equal(req.headers.cookie, undefined);
    if (req.url === "/api/worker/pair") {
      assert.equal(req.headers.authorization, undefined);
      pairs.push(PairRequestSchema.parse(input));
      if (pairs.length === 1) return req.socket.destroy();
      return json(res, PairResponseSchema, { ...clock(), ownerId, workerId: input.workerId, revision: 1 });
    }
    assert.equal(req.headers.authorization, `Bearer ${pairs[0].workerToken}`);
    if (req.url === "/api/worker/poll") {
      PollRequestSchema.parse(input);
      return json(res, PollResponseSchema, { ...clock(), lease: jobs.shift() ?? null });
    }
    const match = req.url.match(/^\/api\/worker\/applications\/([^/]+)\/events$/);
    assert(match, "Only the published control endpoints may be called");
    events.push(EventRequestSchema.parse(input));
    return json(res, EventResponseSchema, { applicationId: match[1], eventId: input.eventId,
      revision: input.expectedRevision + 1, state: input.state, replayed: false, lease: null, serverTime: Date.now() });
  });
  const first = await cli(t, scope, "pair", { grant: "G".repeat(43) });
  assert.equal(first.code, 1);
  assert.match(first.stderr, /NETWORK_UNAVAILABLE/);
  const paired = await cli(t, scope, "pair", { items: first.vault.items });
  assert.equal(paired.code, 0, paired.stderr);
  assert.deepEqual(pairs[0], pairs[1]);
  assert.equal(JSON.parse(paired.stdout).status, "paired");
  assert(!paired.vault.items[0][1].includes('"grant"'));
  const status = await cli(t, scope, "status");
  assert.equal(status.code, 0, status.stderr);
  assert.equal(status.vault.operations, 0);
  assert.equal(JSON.parse(status.stdout).online, "not-checked");
  for (let i = 0; i < 2; i++) jobs.push({ applicationId: randomUUID(), runId: randomUUID(),
    workerId: pairs[0].workerId, ownerId, policyRevision: 1, ats: "fixture", tenant: "tenant",
    requisition: `role-${i}`, state: "screening", revision: 2, fence: 1,
    leaseUntil: Date.now() + 120000, checkpoint: null, mode: "safe" });
  let stopping = false;
  const started = await cli(t, scope, "start", { items: paired.vault.items }, (output, child) => {
    if (!stopping && (output.match(/"waiting"/g) ?? []).length === 2) {
      stopping = true;
      child.kill("SIGTERM");
    }
  });
  assert.equal(started.code, 0, started.stderr);
  assert.equal(events.length, 2);
  assert(events.every(event => event.state === "blocked_unsupported" && event.reasonCode === "adapter_unavailable"));
  for (const result of [first, paired, status, started]) {
    assert(!(result.stdout + result.stderr).includes(pairs[0].workerToken));
    assert(!(result.stdout + result.stderr).includes(pairs[0].grant));
  }
  for (const name of await readdir(scope.directory)) {
    const content = await readFile(join(scope.directory, name), "utf8");
    assert(!content.includes(pairs[0].workerToken));
    assert(!content.includes(pairs[0].grant));
  }
});

test("start and pair contenders do not read or change credentials while the worker store is locked", { timeout: 5000 }, async t => {
  const scope = await fixture(t, () => assert.fail("Locked CLI must not use the network"));
  const { store, items } = await seed(scope);
  const unlock = await store.lock();
  try {
    for (const command of ["start", "pair"]) {
      const result = await cli(t, scope, command, { items });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /WORKER_LOCKED/);
      assert.equal(result.vault.operations, 0, "Credential access must follow the exclusive lock");
    }
  } finally { await unlock(); }
});

test("SIGKILL after each safe-stage checkpoint replays one durable event before polling with a fresh process", { timeout: 15000 }, async t => {
  for (const stage of SAFE_STAGES) {
    const order = [], requests = [];
    let job, accepted, kill = true, childReady;
    const launched = new Promise(resolve => childReady = resolve);
    const scope = await fixture(t, async (req, res) => {
      assert.equal(req.headers.authorization, `Bearer ${"K".repeat(43)}`);
      const input = await body(req);
      if (req.url === "/api/worker/poll") {
        PollRequestSchema.parse(input);
        order.push("poll");
        return json(res, PollResponseSchema, { ...clock(), lease: accepted ? null : job });
      }
      assert.equal(req.url, `/api/worker/applications/${job.applicationId}/events`);
      order.push("event");
      requests.push(EventRequestSchema.parse(input));
      if (!accepted) accepted = input;
      assert.deepEqual(input, accepted);
      if (kill) {
        kill = false;
        (await launched).kill("SIGKILL");
        return res.destroy();
      }
      json(res, EventResponseSchema, { applicationId: job.applicationId, eventId: input.eventId,
        revision: job.revision + 1, state: input.state, replayed: true, lease: null, serverTime: Date.now() });
    });
    const { identity, store, items } = await seed(scope);
    job = { ...identity, applicationId: randomUUID(), runId: randomUUID(), policyRevision: 3,
      ats: "fixture", tenant: "tenant", requisition: "role", state: stage, revision: 7, fence: 4,
      leaseUntil: Date.now() + 120000, checkpoint: { stage, sequence: 8 }, mode: "safe" };
    delete job.origin;
    const crashed = await cli(t, scope, "start", { items }, (_output, child) => childReady(child));
    assert.equal(crashed.signal, "SIGKILL");
    assert.deepEqual((await store.read("checkpoint")).pending.event, accepted);
    assert.deepEqual(accepted.checkpoint, { stage, sequence: 9 });
    assert.equal(accepted.expectedRevision, 7);
    let stopping = false;
    const restarted = await cli(t, scope, "start", { items }, (output, child) => {
      if (!stopping && output.includes('"idle"')) { stopping = true; child.kill("SIGTERM"); }
    });
    assert.equal(restarted.code, 0, restarted.stderr);
    assert.deepEqual(order, ["poll", "event", "event", "poll"]);
    assert.equal(requests.length, 2);
    assert.equal((await store.read("checkpoint")).pending, null);
    assert.equal(await store.read("lock"), null);
  }
});

test("actual CLI rejects piped grants without registering or writing a credential", { timeout: 5000 }, async t => {
  const scope = await fixture(t, () => assert.fail("Piped grant must not register"));
  const result = await cli(t, scope, "pair", { tty: false });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /TTY_REQUIRED/);
  assert.deepEqual(result.vault.items, []);
});
