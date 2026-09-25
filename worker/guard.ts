import { HEARTBEAT_MS, LEASE_MS, POLL_TIMEOUT_MS } from "../lib/applications/worker-protocol.ts";
import type { Lease } from "../lib/applications/worker-protocol.ts";
import type { WorkerScope } from "./credentials.ts";

export type ClockSample = { mono: number; wall: number };
export const systemClock = (): ClockSample => ({ mono: performance.now(), wall: Date.now() });
export function createLeaseGuard(
  initial: Lease, scope: WorkerScope, serverTime: number, started: ClockSample,
  clock: () => ClockSample = systemClock,
) {
  let lease = initial, previous = started, deadline = 0, revoked = "";
  const controller = new AbortController();
  const identity = (value: Lease) => JSON.stringify([
    value.applicationId, value.runId, value.workerId, value.ownerId, value.policyRevision,
    value.ats, value.tenant, value.requisition, value.fence, value.mode, value.state,
  ]);
  function revoke(reason = "LEASE_LOST") {
    revoked ||= reason;
    controller.abort();
  }
  function fail(reason: string): never { revoke(reason); throw new Error(revoked); }
  function sample() {
    const now = clock(), elapsed = now.mono - previous.mono, wallElapsed = now.wall - previous.wall;
    if (![now.mono, now.wall, elapsed, wallElapsed].every(Number.isFinite) || elapsed < 0 ||
      elapsed > HEARTBEAT_MS + 10000 || Math.abs(elapsed - wallElapsed) > 2000) fail("CLOCK_UNSAFE");
    previous = now;
    return now;
  }
  function check() {
    if (revoked) throw new Error(revoked);
    if (sample().mono >= deadline) fail("LEASE_EXPIRED");
  }
  function setDeadline(value: Lease, time: number, requestStart: ClockSample) {
    const now = sample();
    const elapsed = now.mono - requestStart.mono;
    const remaining = value.leaseUntil - time;
    // The deadline counts from the request start, so a slow reply only shortens it; allow any reply the poll waits for.
    if (!Number.isSafeInteger(time) || !Number.isSafeInteger(value.policyRevision) || value.policyRevision < 1 ||
      !Number.isFinite(remaining) || remaining <= 1000 || remaining > LEASE_MS ||
      elapsed < 0 || elapsed > POLL_TIMEOUT_MS || Math.abs(now.wall - requestStart.wall - elapsed) > 2000) fail("INVALID_LEASE");
    deadline = requestStart.mono + remaining - 1000;
    check();
  }
  if (initial.ownerId !== scope.ownerId || initial.workerId !== scope.workerId) fail("BINDING_CHANGED");
  setDeadline(initial, serverTime, started);
  return {
    check, revoke, signal: controller.signal,
    renew(value: Lease, time: number, requestStart: ClockSample) {
      check();
      if (identity(value) !== identity(lease) || value.revision !== lease.revision) fail("BINDING_CHANGED");
      setDeadline(value, time, requestStart);
      lease = value;
    },
    // A submission intent moves the application on under this same lease; renewals must carry its new revision.
    advance(value: Pick<Lease, "revision" | "fence" | "state">) {
      check();
      if (value.revision === lease.revision && value.state === lease.state) return; // a replayed intent
      if (value.fence !== lease.fence || value.revision < lease.revision) fail("BINDING_CHANGED");
      lease = { ...lease, revision: value.revision, state: value.state };
    },
    async boundary<T>(action: () => T | Promise<T>): Promise<T> {
      check();
      const result = await action();
      check();
      return result;
    },
    async mutate<T>(action: () => T | Promise<T>): Promise<T> {
      check();
      if (lease.mode !== "safe") fail("RECONCILIATION_ONLY");
      const result = await action();
      check();
      return result;
    },
  };
}
export type LeaseGuard = ReturnType<typeof createLeaseGuard>;
