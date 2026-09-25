import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, lstat, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { credentials, keychainAddress } from "./credentials.ts";
import { privateStore } from "./storage.ts";
import { createLeaseGuard } from "./guard.ts";
import { controlOrigin } from "./transport.ts";

const scope = { origin: "https://workie.example", ownerId: "synthetic-owner-a", workerId: randomUUID() };
const directories = [];
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });
async function scratch(prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}
const lease = () => ({
  applicationId: randomUUID(), runId: randomUUID(), workerId: scope.workerId,
  ownerId: scope.ownerId, policyRevision: 1,
  ats: "fixture", tenant: "tenant", requisition: "role", state: "screening",
  revision: 1, fence: 1, leaseUntil: 120000, checkpoint: null, mode: "safe",
});

test("credential addresses isolate owner, worker, origin and purpose; native failures do not fall back", async () => {
  const saved = new Map();
  const backend = (service, account, options) => {
    assert.deepEqual(options, { linux: { store: "secret-service" } });
    const key = JSON.stringify([service, account]);
    return { setPassword: value => saved.set(key, value), getPassword: () => saved.get(key) ?? null,
      deletePassword: () => saved.delete(key) };
  };
  const a = credentials(scope, backend, "linux");
  a.set("worker", "synthetic-secret");
  assert.equal(a.get("worker"), "synthetic-secret");
  for (const other of [
    { ...scope, ownerId: "synthetic-owner-b" }, { ...scope, workerId: randomUUID() },
    { ...scope, origin: "https://other.example" },
  ]) assert.equal(credentials(other, backend, "linux").get("worker"), null);
  assert.equal(a.get("provider:future"), null);
  assert.notDeepEqual(keychainAddress(scope, "worker"), keychainAddress(scope, "provider:future"));
  assert.throws(() => credentials(scope, () => { throw new Error("secret-service unavailable"); }, "linux").get("worker"), /CREDENTIAL_UNAVAILABLE/);
  assert.throws(() => credentials(scope, backend, "freebsd"), /UNSUPPORTED_PLATFORM/);
  a.remove("worker");
  assert.equal(a.get("worker"), null);
});

test("private JSON is atomic, restrictive, scoped, bounded and rejects symlinks", async () => {
  const dir = await scratch("worker-store-");
  const store = await privateStore(dir, scope);
  const event = { version: 1, scope, pending: { eventId: randomUUID() } };
  await store.write("checkpoint", event);
  assert.deepEqual(await store.read("checkpoint"), event);
  assert.equal((await lstat(store.path("checkpoint"))).mode & 0o777, 0o600);
  assert.equal((await lstat(dir)).mode & 0o777, 0o700);
  const other = await privateStore(dir, { ...scope, ownerId: "synthetic-owner-b" });
  assert.equal(await other.read("checkpoint"), null);
  await assert.rejects(store.write("checkpoint", { text: "x".repeat(140000) }), /LOCAL_STATE_LIMIT/);
  await assert.rejects(store.write("../escape", event), /INVALID_STATE_NAME/);
  await store.remove("checkpoint");
  await symlink(join(dir, "outside"), store.path("checkpoint"));
  await assert.rejects(store.read("checkpoint"));
  assert.equal((await readFile(join(dir, "outside")).catch(() => null)), null);
});

test("only one process-store lock wins, including concurrent recovery of a terminated fixture PID", async () => {
  const store = await privateStore(await scratch("worker-lock-"), scope);
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore", env: { PATH: process.env.PATH } });
  await new Promise(resolve => child.once("exit", resolve));
  await store.write("lock", { pid: child.pid, nonce: randomUUID() });
  const attempts = await Promise.allSettled([store.lock(), store.lock()]);
  assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
  await attempts.find(result => result.status === "fulfilled").value();
  const unlock = await store.lock();
  await assert.rejects(store.lock(), /WORKER_LOCKED/);
  await unlock();
});

test("origin accepts HTTPS or explicit numeric loopback only, never URL credentials or TLS bypass", () => {
  assert.equal(controlOrigin("https://workie.example"), scope.origin);
  assert.equal(controlOrigin("http://127.0.0.1:5011", true), "http://127.0.0.1:5011");
  for (const origin of ["http://workie.example", "http://localhost:5000", "http://127.1:5000",
    "https://user:secret@workie.example", "https://workie.example/?token=x",
    "https://workie.example/#x", "https://workie.example/path",
    "https://localhost", "https://127.0.0.2", "https://[::ffff:127.0.0.1]"]) {
    assert.throws(() => controlOrigin(origin, true), /INVALID_ORIGIN/);
  }
  assert.throws(() => controlOrigin("http://127.0.0.1:5000"), /LOOPBACK_DISABLED/);
});

test("lease expires using monotonic time even with regular checks and cannot be renewed back to life", () => {
  let time = 0;
  const clock = () => ({ mono: time, wall: time });
  const value = lease(), guard = createLeaseGuard(value, scope, 0, clock(), clock);
  for (time = 20000; time <= 100000; time += 20000) guard.check();
  time = 119000;
  assert.throws(() => guard.check(), /LEASE_EXPIRED/);
  assert.throws(() => guard.renew({ ...value, leaseUntil: 239000 }, 119000, clock()), /LEASE_EXPIRED/);
});

test("a lease from a slow discovery poll is kept, with its deadline counted from the request start", () => {
  let time = 24000; // the poll ran a discovery scan before assigning this lease
  const clock = () => ({ mono: time, wall: time });
  const guard = createLeaseGuard({ ...lease(), leaseUntil: 24000 + 120000 }, scope, 24000, { mono: 0, wall: 0 }, clock);
  for (time = 40000; time <= 100000; time += 20000) guard.check();
  time = 119000;
  assert.throws(() => guard.check(), /LEASE_EXPIRED/, "expiry is measured from when the poll was sent");
});

test("monotonic lease guard rejects sleep, wall jumps, expired leases, identity and changed policy", async () => {
  let mono = 0, wall = 0;
  const clock = () => ({ mono, wall });
  const value = lease();
  const guard = createLeaseGuard(value, scope, 0, clock(), clock);
  guard.check();
  let mutations = 0;
  await guard.mutate(() => { mutations++; });
  assert.equal(mutations, 1);
  wall += 3000;
  assert.throws(() => guard.check(), /CLOCK_UNSAFE/);
  await assert.rejects(guard.mutate(() => { mutations++; }));
  assert.equal(mutations, 1);
  for (const delta of [31000, 121000]) {
    mono = 0; wall = 0;
    const g = createLeaseGuard(value, scope, 0, clock(), clock);
    mono = delta; wall = delta;
    assert.throws(() => g.check());
  }
  mono = 0; wall = 0;
  assert.throws(() => createLeaseGuard({ ...value, workerId: randomUUID() }, scope, 0, clock(), clock));
  assert.throws(() => createLeaseGuard({ ...value, ownerId: "synthetic-owner-b" }, scope, 0, clock(), clock));
  const g = createLeaseGuard(value, scope, 0, clock(), clock);
  assert.throws(() => g.renew({ ...value, policyRevision: 2 }, 0, clock()), /BINDING_CHANGED/);
});

test("guard revocation after an await prevents the following mutation and reconciliation is read-only", async () => {
  const g = createLeaseGuard(lease(), scope, 0, { mono: 0, wall: 0 }, () => ({ mono: 0, wall: 0 }));
  let writes = 0;
  await assert.rejects(g.boundary(async () => { g.revoke("STOPPED"); }));
  await assert.rejects(g.mutate(() => { writes++; }));
  assert.equal(writes, 0);
  const readOnly = createLeaseGuard({ ...lease(), mode: "reconcile", state: "submission_unknown" },
    scope, 0, { mono: 0, wall: 0 }, () => ({ mono: 0, wall: 0 }));
  await assert.rejects(readOnly.mutate(() => { writes++; }), /RECONCILIATION_ONLY/);
  assert.equal(writes, 0);
});
