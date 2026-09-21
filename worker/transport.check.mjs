import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { workerTransport } from "./transport.ts";

const token = "S".repeat(43);
const poll = { protocolVersion: 1, serverTime: 1000, heartbeatMs: 20000, leaseMs: 120000, lease: null };
async function fixture(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
const json = (res, value, status = 200) => {
  res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value));
};

test("transport timeout is a finite positive integer bounded by eight seconds", () => {
  for (const timeoutMs of [NaN, Infinity, -1, 0, 0.5, 8001]) {
    assert.throws(() => workerTransport({ origin: "https://workie.example", timeoutMs }), /INVALID_TIMEOUT/);
  }
});

test("real loopback transport binds bearer to configured origin and exact routes", async t => {
  const requests = [];
  const origin = await fixture(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push({ path: req.url, auth: req.headers.authorization, cookie: req.headers.cookie,
      body: JSON.parse(Buffer.concat(chunks).toString()) });
    json(res, poll);
  });
  const client = workerTransport({ origin, token, allowLoopback: true });
  assert.deepEqual(await client.poll(), poll);
  await client.heartbeat(null);
  assert.deepEqual(requests.map(r => r.path), ["/api/worker/poll", "/api/worker/heartbeat"]);
  assert(requests.every(r => r.auth === `Bearer ${token}` && r.cookie === undefined));
  assert.deepEqual(requests[1].body, { protocolVersion: 1, lease: null });
});

test("provider config uses the versioned worker contract and does not expose credentials", async t => {
  const origin = await fixture(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.deepEqual(body, { protocolVersion: 1, providerProtocolVersion: 1 });
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    json(res, {
      providerProtocolVersion: 1, ownerId: "synthetic-owner", profileRevision: 2,
      policyRevision: 3, policyVersion: 1, policyHash: null, enabled: false, provider: "none",
      model: null, endpoint: null, privacy: "local_inference_only", remoteProviderConsent: false,
      allowedProviders: [], fallbackOrder: [], maxUsd: 0,
    });
  });
  const result = await workerTransport({ origin, token, allowLoopback: true }).providerConfig();
  assert.equal(result.enabled, false);
  assert(!JSON.stringify(result).toLowerCase().includes("password"));
});

test("redirects, malformed/versioned/oversized bodies, slow streams and HTTP errors fail closed without secrets", async t => {
  let mode = "redirect", calls = 0;
  const origin = await fixture(t, (req, res) => {
    calls++;
    if (mode === "redirect") { res.writeHead(302, { Location: `${origin}/leaked` }); res.end(); }
    if (mode === "html") { res.writeHead(200, { "Content-Type": "text/html" }); res.end(token); }
    if (mode === "invalid") json(res, { ...poll, protocolVersion: 2, error: token });
    if (mode === "large") { res.writeHead(200, { "Content-Type": "application/json" }); res.end('"'+ "x".repeat(140000) +'"'); }
    if (mode === "slow") { res.writeHead(200, { "Content-Type": "application/json" }); res.write("{"); }
    if (mode === "error") json(res, { error: token }, 401);
  });
  const client = workerTransport({ origin, token, allowLoopback: true, timeoutMs: 60 });
  for (mode of ["redirect", "html", "invalid", "large", "slow", "error"]) {
    const before = calls;
    await assert.rejects(client.poll(), error => !error.message.includes(token));
    assert.equal(calls, before + 1);
  }
});

test("only checkpoint retries reuse byte-identical events; pair and poll are never retried", async t => {
  const appId = randomUUID(), eventId = randomUUID(), bodies = [];
  const request = { protocolVersion: 1, eventId, fence: 1, expectedRevision: 1,
    state: "blocked_unsupported", checkpoint: { stage: "screening", sequence: 1 }, reasonCode: "adapter_unavailable" };
  const origin = await fixture(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    bodies.push(Buffer.concat(chunks).toString());
    if (bodies.length === 1) return req.socket.destroy();
    json(res, { applicationId: appId, eventId, revision: 2, state: "blocked_unsupported",
      replayed: true, lease: null, serverTime: 1000 });
  });
  const result = await workerTransport({ origin, token, allowLoopback: true }).event(appId, request);
  assert.equal(result.replayed, true);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
  let pairCalls = 0;
  const pairOrigin = await fixture(t, (req) => { pairCalls++; req.socket.destroy(); });
  const client = workerTransport({ origin: pairOrigin, allowLoopback: true });
  await assert.rejects(client.pair({ protocolVersion: 1, requestId: randomUUID(), workerId: randomUUID(),
    workerToken: token, grant: "G".repeat(43), workerVersion: "0.1.0", capabilities: ["control-v1"] }));
  assert.equal(pairCalls, 1);
});

test("caller abort stops an in-flight response and never retries an aborted checkpoint", async t => {
  let calls = 0, opened;
  const received = new Promise(resolve => opened = resolve);
  const origin = await fixture(t, (_req, res) => {
    calls++;
    res.writeHead(200, { "Content-Type": "application/json" }); res.write("{");
    opened();
  });
  const controller = new AbortController();
  const client = workerTransport({ origin, token, allowLoopback: true });
  const request = { protocolVersion: 1, eventId: randomUUID(), fence: 1, expectedRevision: 1,
    state: "blocked_unsupported", checkpoint: { stage: "screening", sequence: 1 }, reasonCode: "adapter_unavailable" };
  const started = performance.now();
  const result = client.event(randomUUID(), request, controller.signal);
  await received;
  controller.abort();
  await assert.rejects(result, /STOPPED/);
  assert(performance.now() - started < 2000);
  assert.equal(calls, 1);
  await assert.rejects(client.poll(controller.signal), /STOPPED/);
  assert.equal(calls, 1);
});

test("checkpoint retries have a finite total deadline and do not retry authorization or stale-fence denials", async t => {
  let status = 200, calls = 0;
  const origin = await fixture(t, (_req, res) => {
    calls++;
    res.writeHead(status, { "Content-Type": "application/json" });
    if (status === 200) res.write("{");
    else res.end(JSON.stringify({ error: token }));
  });
  const client = workerTransport({ origin, token, allowLoopback: true, timeoutMs: 60 });
  const request = { protocolVersion: 1, eventId: randomUUID(), fence: 1, expectedRevision: 1,
    state: "blocked_unsupported", checkpoint: { stage: "screening", sequence: 1 }, reasonCode: "adapter_unavailable" };
  const started = performance.now();
  await assert.rejects(client.event(randomUUID(), request), /NETWORK_UNAVAILABLE/);
  assert.equal(calls, 1);
  assert(performance.now() - started < 1000);
  for (status of [401, 403, 409, 426, 429]) {
    const before = calls;
    await assert.rejects(client.event(randomUUID(), request), error => error.message === `HTTP_${status}`);
    assert.equal(calls, before + 1);
  }
});
