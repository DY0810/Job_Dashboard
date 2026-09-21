import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateStore } from "./storage.ts";
import { runWorker } from "./runtime.ts";
import { questionClient } from "./question-client.ts";
import { workerTransport, TransportError } from "./transport.ts";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

const descriptor = {
  key: "hours", kind: "needs_answer", originalWording: "Can you work these hours?",
  reason: "Confirmation needed.", required: true, meaning: { id: "hours", reviewId: null },
  schemaVersion: 1, scope: { kind: "applicant", country: null, employer: null, applicationId: null,
    includesSubsidiaries: false, timeframe: "current", validFrom: null, validUntil: null,
    ats: "fixture", tenant: "synthetic", version: 1 },
  provenance: { source: "user", sourceId: null, sourceVersion: null, excerpt: null },
  field: { type: "boolean", allowBlank: false, declineValue: null, units: null, precision: null },
  factIds: [], sensitive: false,
};
const response = (lease = null) => ({
  protocolVersion: 1, serverTime: Date.now(), heartbeatMs: 20000, leaseMs: 120000, lease,
});

const directories = [];
after(async () => { for (const dir of directories) await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "focus-runtime-")); directories.push(dir);
  const scope = { origin: "https://workie.example", ownerId: "synthetic", workerId: randomUUID() };
  const store = await privateStore(dir, scope), stop = new AbortController();
  const command = { id: randomUUID(), questionId: randomUUID(), applicationId: randomUUID(), workerId: scope.workerId,
    revision: 1, status: "pending", reason: null, expectedApplicationRevision: 2, fence: 3, checkpoint: { stage: "screening", sequence: 1 },
    descriptor: { ...descriptor, kind: "needs_login", field: { ...descriptor.field, type: "intervention" } } };
  const calls = [];
  const transport = {
    interventions: async () => ({ questionProtocolVersion: 1, commands: [command] }),
    ackIntervention: async (id, ack) => {
      calls.push({ id, ack });
      assert.deepEqual((await store.read("intervention-checkpoint")).pending, { command, ack });
      return { id, questionId: command.questionId, applicationId: command.applicationId, workerId: scope.workerId,
        revision: ack.expectedRevision + 1, status: ack.result, reason: ack.reason };
    },
  };
  return { scope, store, signal: stop.signal, stop, command, calls, transport };
}

test("default observer acknowledges unavailable durably, never observed", async () => {
  const f = await fixture();
  await questionClient(f).pollInterventions();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].ack.result, "unavailable");
  assert.equal(f.calls[0].ack.reason, "browser_not_implemented");
  assert.equal(f.calls[0].ack.observation, null);
  assert.equal((await f.store.read("intervention-checkpoint")).pending, null);
});

test("pending ack is replayed byte-for-byte without running the compiled observer again", async () => {
  const f = await fixture();
  let original;
  await assert.rejects(questionClient({ ...f, transport: { ...f.transport, ackIntervention: async (_id, ack) => {
    original = ack; throw new TransportError("NETWORK_UNAVAILABLE");
  } } }).pollInterventions(), /NETWORK_UNAVAILABLE/);
  await questionClient({ ...f, observeFocus: async () => assert.fail("Do not observe a pending acknowledgement twice"),
    transport: { ...f.transport, interventions: async () => ({ questionProtocolVersion: 1, commands: [] }) },
  }).pollInterventions();
  assert.deepEqual(f.calls[0].ack, original);
  assert.equal((await f.store.read("intervention-checkpoint")).pending, null);
});

test("startup completes durable intervention recovery before polling for fresh work", async () => {
  const f = await fixture();
  await assert.rejects(questionClient({ ...f, transport: { ...f.transport, ackIntervention: async () => {
    throw new TransportError("NETWORK_UNAVAILABLE");
  } } }).pollInterventions());
  let recovered = false;
  await runWorker({ ...f, transport: { ...f.transport,
    interventions: async () => ({ questionProtocolVersion: 1, commands: [] }),
    ackIntervention: async (id, ack) => {
      await delay(20);
      const result = await f.transport.ackIntervention(id, ack);
      recovered = true; return result;
    },
    poll: async () => { assert(recovered, "Pending ack must precede fresh work"); f.stop.abort(); return response(); },
    heartbeat: async () => response(),
  } });
  assert.equal((await f.store.read("intervention-checkpoint")).pending, null);
});

test("wrong worker and wrong login/tenant observation do not post or persist an acknowledgement", async () => {
  for (const fault of ["worker", "kind", "tenant"]) {
    const f = await fixture();
    if (fault === "worker") f.command.workerId = randomUUID();
    await assert.rejects(questionClient({ ...f, observeFocus: async () => ({
      result: "observed", reason: null, observation: { kind: fault === "kind" ? "verification_complete" : "login_complete",
        ats: "fixture", tenant: fault === "tenant" ? "other" : "synthetic", requisition: "role", observedAt: Date.now() },
    }) }).pollInterventions(), /BINDING_CHANGED/);
    assert.equal(f.calls.length, 0);
    assert.equal(await f.store.read("intervention-checkpoint"), null);
  }
});

test("observer results cannot supply runtime-owned event keys or revision fences", async () => {
  const f = await fixture();
  await assert.rejects(questionClient({ ...f, observeFocus: async () => ({
    result: "focused", reason: null, observation: null, eventId: randomUUID(), expectedRevision: 99,
  }) }).pollInterventions());
  assert.equal(f.calls.length, 0);
  assert.equal(await f.store.read("intervention-checkpoint"), null);
});

test("failed local persistence prevents ack; mismatched response leaves exact pending ack", async () => {
  for (const fault of ["disk", "response"]) {
    const f = await fixture();
    let sent = 0;
    const client = questionClient({ ...f,
      store: fault === "disk" ? { ...f.store, write: async () => { throw new Error("SYNTHETIC_DISK_FAILURE"); } } : f.store,
      transport: { ...f.transport, ackIntervention: async (id, ack) => {
        sent++; return { ...await f.transport.ackIntervention(id, ack), questionId: randomUUID() };
      } },
    });
    await assert.rejects(client.pollInterventions(), fault === "disk" ? /SYNTHETIC_DISK_FAILURE/ : /INVALID_ACKNOWLEDGEMENT/);
    assert.equal(sent, fault === "disk" ? 0 : 1);
    assert.equal(Boolean((await f.store.read("intervention-checkpoint"))?.pending), fault === "response");
  }
});

test("compiled observer deadline reports unavailable and ignores a late observation", async t => {
  const f = await fixture();
  let started, complete, callbackSignal;
  const called = new Promise(resolve => { started = resolve; });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const polling = questionClient({ ...f, observeFocus: (_command, signal) => {
    callbackSignal = signal; started();
    return new Promise(resolve => { complete = resolve; });
  } }).pollInterventions();
  await called;
  t.mock.timers.tick(8000);
  await polling;
  assert.equal(callbackSignal.aborted, true);
  assert.equal(f.calls[0].ack.result, "unavailable");
  assert.equal(f.calls[0].ack.reason, "focus_observer_unavailable");
  complete({ result: "observed", reason: null, observation: {
    kind: "login_complete", ats: "fixture", tenant: "synthetic", requisition: "role", observedAt: Date.now(),
  } });
  await Promise.resolve();
  assert.equal(f.calls.length, 1);
});

test("stop during observation exits without acknowledgement and stale server denial never grants authority", async () => {
  const f = await fixture();
  await assert.rejects(questionClient({ ...f, observeFocus: async () => {
    f.stop.abort();
    return { result: "focused", reason: null, observation: null };
  } }).pollInterventions());
  assert.equal(f.calls.length, 0);
  const stale = await fixture();
  await questionClient({ ...stale, transport: { ...stale.transport, ackIntervention: async () => {
    throw new TransportError("HTTP_409", 409);
  } } }).pollInterventions();
  assert.equal((await stale.store.read("intervention-checkpoint")).pending, null);
  assert.equal((await stale.store.read("rejected-intervention")).pending.command.id, stale.command.id);
});

test("question transport uses exact bearer-only routes and byte-identical idempotent retry keys", async t => {
  const requests = [], f = await fixture();
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString(), input = JSON.parse(body);
    requests.push({ path: req.url, body, cookie: req.headers.cookie, authorization: req.headers.authorization });
    if (req.url.endsWith("/questions") && requests.filter(r => r.path === req.url).length === 1) return res.destroy();
    if (req.url.endsWith("/ack") && requests.filter(r => r.path === req.url).length === 1) return res.destroy();
    const value = req.url.endsWith("/questions") ? { applicationId: f.command.applicationId, eventId: input.eventId,
      revision: 2, questionIds: [f.command.questionId], replayed: true, lease: null } :
      req.url.endsWith("/ack") ? { id: f.command.id, questionId: f.command.questionId, applicationId: f.command.applicationId,
        workerId: f.scope.workerId, revision: 2, status: input.result, reason: input.reason } :
        { questionProtocolVersion: 1, commands: [] };
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(value));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const token = "F".repeat(43);
  const client = workerTransport({ origin: `http://127.0.0.1:${server.address().port}`, token, allowLoopback: true });
  await client.interventions();
  const batch = { questionProtocolVersion: 1, eventId: randomUUID(), fence: 1, expectedRevision: 1, expectedProfileRevision: 0,
    checkpoint: { stage: "screening", sequence: 1 }, company: "Synthetic", role: "Engineer", questions: [descriptor] };
  await client.questionBatch(f.command.applicationId, batch);
  await client.ackIntervention(f.command.id, { questionProtocolVersion: 1, eventId: randomUUID(), expectedRevision: 1,
    expectedApplicationRevision: 2, fence: 3, result: "unavailable", reason: "browser_not_implemented", observation: null });
  assert.equal(requests.length, 5);
  assert(requests.every(r => r.cookie === undefined && r.authorization === `Bearer ${token}`));
  assert.equal(requests[1].body, requests[2].body);
  assert.equal(requests[3].body, requests[4].body);
  assert.equal(requests[0].path, "/api/worker/interventions");
  assert.equal(requests[1].path, `/api/worker/applications/${f.command.applicationId}/questions`);
  assert.equal(requests[3].path, `/api/worker/interventions/${f.command.id}/ack`);
});
test("typed question dispatch durably registers a fenced checkpoint and releases the slot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "question-runtime-"));
  try {
    const scope = { origin: "https://workie.example", ownerId: "synthetic", workerId: randomUUID() };
    const store = await privateStore(dir, scope), stop = new AbortController();
    const lease = { applicationId: randomUUID(), runId: randomUUID(), workerId: scope.workerId,
      ownerId: scope.ownerId, policyRevision: 1, ats: "fixture", tenant: "synthetic", requisition: "role",
      state: "screening", revision: 1, fence: 1, leaseUntil: Date.now() + 120000, checkpoint: null, mode: "safe" };
    let registered = 0, polled = 0;
    await runWorker({ scope, store, signal: stop.signal,
      dispatch: async () => ({ kind: "questions", expectedProfileRevision: 0,
        company: "Synthetic", role: "Engineer", questions: [descriptor] }),
      transport: {
        poll: async () => {
          if (++polled > 1) { stop.abort(); return response(); }
          return response(lease);
        },
        heartbeat: async () => response(),
        interventions: async () => ({ questionProtocolVersion: 1, commands: [] }),
        event: async () => assert.fail("Question waiting is not an ordinary event"),
        questionBatch: async (applicationId, batch) => {
          registered++;
          assert.deepEqual((await store.read("question-checkpoint")).pending, { applicationId, batch });
          assert.equal(batch.fence, lease.fence);
          assert.equal(batch.expectedRevision, lease.revision);
          assert.deepEqual(batch.checkpoint, { stage: "screening", sequence: 1 });
          return { applicationId, eventId: batch.eventId, revision: 2, questionIds: [randomUUID()], replayed: false, lease: null };
        },
      },
    });
    assert.equal(registered, 1);
    assert.equal(polled, 2);
    assert.equal((await store.read("question-checkpoint")).pending, null);
    assert.equal(await store.read("lock"), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
