import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

async function eventually(check, timeout = 5000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (await check()) return;
    await sleep(40);
  }
  assert.fail("Synthetic process condition timed out");
}
const read = path => readFile(path, "utf8").catch(() => "");

test("child survives client exit; real heartbeat, revocation, disconnect, SIGTERM, policy change and process sleep close guards", { timeout: 45000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "worker-process-"));
  const jobs = new Map(), heartbeats = new Map(), firstPoll = new Map(), firstHeartbeat = new Map(), children = new Set();
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${"F".repeat(43)}`) { res.writeHead(401); res.end(); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const now = Date.now();
    let lease = null;
    if (req.url === "/api/worker/poll") {
      lease = [...jobs.values()].find(value => !value.claimed);
      if (lease) firstPoll.set(lease.workerId, performance.now());
    }
    else if (req.url === "/api/worker/heartbeat" && body.lease) {
      lease = jobs.get(body.lease.applicationId);
      heartbeats.set(lease.workerId, (heartbeats.get(lease.workerId) ?? 0) + 1);
      if (!firstHeartbeat.has(lease.workerId)) firstHeartbeat.set(lease.workerId, performance.now());
      if (lease.tenant === "revoked") { res.writeHead(401); res.end(); return; }
      if (lease.tenant === "disconnected") { req.socket.destroy(); return; }
      if (lease.tenant === "policy-changed") lease.policyRevision++;
    }
    if (lease) lease.claimed = true;
    const wire = lease ? Object.fromEntries(Object.entries(lease).filter(([key]) => key !== "claimed")) : null;
    if (wire) wire.leaseUntil = now + 120000;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ protocolVersion: 1, serverTime: now, heartbeatMs: 20000, leaseMs: 120000, lease: wire }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const pid of children) {
      try { process.kill(pid, "SIGKILL"); } catch {}
      await eventually(() => {
        try { process.kill(pid, 0); return false; }
        catch (error) { return error.code === "ESRCH"; }
      });
    }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function launch(name) {
    const directory = join(root, name);
    await mkdir(directory, { mode: 0o700 });
    const scope = { origin, ownerId: "synthetic-process-owner", workerId: randomUUID() };
    const applicationId = randomUUID();
    jobs.set(applicationId, { applicationId, runId: randomUUID(), ...scope,
      ats: "fixture", tenant: name, requisition: "role", policyRevision: 1,
      state: "screening", revision: 1, fence: 1, leaseUntil: Date.now() + 120000, checkpoint: null, mode: "safe" });
    delete jobs.get(applicationId).origin;
    const launcher = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/client-launcher.mjs", import.meta.url))], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { HOME: root, TMPDIR: root, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, WORKIE_DB: join(root, "unused.db") },
    });
    let stdout = "", stderr = "";
    launcher.stdout.on("data", chunk => stdout += chunk);
    launcher.stderr.on("data", chunk => stderr += chunk);
    launcher.stdin.end(JSON.stringify({ scope, directory }));
    const exit = await new Promise(resolve => launcher.once("exit", resolve));
    assert.equal(exit, 0, stderr);
    const { pid } = JSON.parse(stdout);
    children.add(pid);
    await eventually(async () => (await read(join(directory, "mutations"))).length > 0);
    process.kill(pid, 0);
    return { scope, directory, pid };
  }
  const normal = await launch("normal");
  const jumping = await launch("jumping");
  const revoked = await launch("revoked");
  const disconnected = await launch("disconnected");
  const changed = await launch("policy-changed");
  const suspended = await launch("suspended");
  process.kill(suspended.pid, "SIGSTOP");
  const suspendedAt = performance.now();
  await sleep(100);
  const suspendedMutations = await read(join(suspended.directory, "mutations"));
  const before = await read(join(normal.directory, "mutations"));
  await sleep(250);
  assert((await read(join(normal.directory, "mutations"))).length > before.length);
  await writeFile(join(jumping.directory, "jump"), "synthetic", { mode: 0o600 });
  await eventually(async () => (await read(join(jumping.directory, "done"))).includes("CLOCK_UNSAFE"));
  const frozen = await read(join(jumping.directory, "mutations"));
  await sleep(250);
  assert.equal(await read(join(jumping.directory, "mutations")), frozen);
  await eventually(() => (heartbeats.get(normal.scope.workerId) ?? 0) > 0, 23000);
  const heartbeatDelay = firstHeartbeat.get(normal.scope.workerId) - firstPoll.get(normal.scope.workerId);
  assert(heartbeatDelay >= 19000 && heartbeatDelay < 26000, "Must observe the real 20-second heartbeat");
  t.diagnostic(`first heartbeat after ${Math.round(heartbeatDelay)}ms; process suspension 31000ms`);
  await eventually(async () => (await read(join(revoked.directory, "done"))).includes("HTTP_401"));
  await eventually(async () => (await read(join(disconnected.directory, "done"))).includes("NETWORK_UNAVAILABLE"));
  await eventually(async () => (await read(join(changed.directory, "done"))).includes("BINDING_CHANGED"));
  process.kill(normal.pid, "SIGTERM");
  await eventually(async () => (await read(join(normal.directory, "done"))).includes("stopped"));
  const stopped = await read(join(normal.directory, "mutations"));
  await sleep(250);
  assert.equal(await read(join(normal.directory, "mutations")), stopped);
  await sleep(Math.max(0, 31000 - (performance.now() - suspendedAt)));
  assert.equal(await read(join(suspended.directory, "mutations")), suspendedMutations);
  assert.equal(heartbeats.get(suspended.scope.workerId) ?? 0, 0);
  process.kill(suspended.pid, "SIGCONT");
  await eventually(async () => (await read(join(suspended.directory, "done"))).includes("CLOCK_UNSAFE"));
  assert.equal(await read(join(suspended.directory, "mutations")), suspendedMutations);
  for (const processInfo of [normal, jumping, revoked, disconnected, changed, suspended]) {
    const finalMutations = await read(join(processInfo.directory, "mutations"));
    await sleep(100);
    assert.equal(await read(join(processInfo.directory, "mutations")), finalMutations);
    await eventually(() => {
      try { process.kill(processInfo.pid, 0); return false; }
      catch (error) { return error.code === "ESRCH"; }
    });
    children.delete(processInfo.pid);
  }
});
