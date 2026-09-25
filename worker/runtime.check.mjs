import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { privateStore } from "./storage.ts";
import { credentials } from "./credentials.ts";
import { pairWorker } from "./pairing.ts";
import { runWorker } from "./runtime.ts";
import { TransportError } from "./transport.ts";

const scope = () => ({ origin: "https://workie.example", ownerId: "synthetic-owner-a", workerId: randomUUID() });
const clockResponse = (lease = null) => ({ protocolVersion: 1, serverTime: Date.now(), heartbeatMs: 20000, leaseMs: 120000, lease });
const pairResponse = s => ({ protocolVersion: 1, serverTime: Date.now(), heartbeatMs: 20000,
  leaseMs: 120000, workerId: s.workerId, ownerId: s.ownerId, revision: 1 });
const assignment = s => ({ applicationId: randomUUID(), runId: randomUUID(), workerId: s.workerId,
  ownerId: s.ownerId, policyRevision: 1, ats: "fixture", tenant: "tenant", requisition: "role",
  state: "screening", revision: 1, fence: 1, leaseUntil: Date.now() + 120000, checkpoint: null, mode: "safe" });
const directories = [];
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });
async function storeFor(s) {
  const directory = await mkdtemp(join(tmpdir(), "worker-runtime-"));
  directories.push(directory);
  return privateStore(directory, s);
}
function backend() {
  const items = new Map();
  return (service, account) => {
    const key = JSON.stringify([service, account]);
    return { getPassword: () => items.get(key) ?? null, setPassword: value => items.set(key, value),
      deletePassword: () => items.delete(key) };
  };
}

test("pairing saves credential before registration and reconciles identical request after lost response", async () => {
  const s = scope(), store = await storeFor(s), vault = credentials(s, backend());
  const calls = [];
  const transport = { pair: async request => {
    assert(vault.get("worker"));
    calls.push(request);
    if (calls.length === 1) throw new Error("NETWORK_UNAVAILABLE");
    return pairResponse(s);
  } };
  await assert.rejects(pairWorker({ scope: s, store, vault, transport, readGrant: async () => "G".repeat(43) }));
  await pairWorker({ scope: s, store, vault, transport, readGrant: async () => { throw new Error("must not prompt again"); } });
  assert.deepEqual(calls[0], calls[1]);
  const metadata = await readFile(store.path("pairing"), "utf8");
  assert(!metadata.includes(calls[0].workerToken));
  assert(!metadata.includes(calls[0].grant));
  assert.equal(JSON.parse(metadata).status, "paired");
  assert(!vault.get("worker").includes('"grant"'));
});

test("wrong owner pairing response never marks local metadata paired", async () => {
  const s = scope(), store = await storeFor(s), vault = credentials(s, backend());
  await assert.rejects(pairWorker({ scope: s, store, vault, readGrant: async () => "G".repeat(43),
    transport: { pair: async () => ({ ...pairResponse(s), ownerId: "synthetic-owner-b" }) } }), /BINDING_CHANGED/);
  assert.equal((await store.read("pairing")).status, "pending");
});

test("default dispatch releases waiting slot, emits no submitted state, and runs unrelated work", async () => {
  const s = scope(), store = await storeFor(s), controller = new AbortController();
  const jobs = [assignment(s), assignment(s)], events = [];
  const transport = {
    poll: async () => clockResponse(jobs.shift() ?? null), heartbeat: async () => clockResponse(),
    event: async (id, input) => {
      events.push(input);
      if (events.length === 2) setTimeout(() => controller.abort(), 10);
      return { applicationId: id, eventId: input.eventId, revision: input.expectedRevision + 1,
        state: input.state, replayed: false, lease: null, serverTime: Date.now() };
    },
  };
  await runWorker({ scope: s, store, transport, signal: controller.signal });
  assert.equal(events.length, 2);
  assert(events.every(e => e.state === "blocked_unsupported" && e.reasonCode === "adapter_unavailable"));
  assert.equal((await store.read("checkpoint")).pending, null);
});

test("a network blip on poll keeps the worker running; an unexpected transport error still stops it", async () => {
  const s = scope(), store = await storeFor(s), controller = new AbortController();
  let polls = 0;
  const running = runWorker({ scope: s, store, signal: controller.signal, transport: {
    poll: async () => { polls += 1; throw new TransportError("NETWORK_UNAVAILABLE"); }, heartbeat: async () => clockResponse(),
  } });
  const stopped = await Promise.race([running.then(() => "exited", error => error.message), sleep(300).then(() => "running")]);
  assert.equal(stopped, "running", "a failed poll used to end the worker with NETWORK_UNAVAILABLE");
  assert.equal(polls, 1);
  controller.abort();
  await running;
  const s2 = scope();
  await assert.rejects(runWorker({ scope: s2, store: await storeFor(s2), signal: new AbortController().signal, transport: {
    poll: async () => { throw new TransportError("HTTP_409", 409); }, heartbeat: async () => clockResponse(),
  } }), /HTTP_409/);
});

test("safe-stage dispatch receives the owner-selected Jev action selector", async () => {
  const s = scope(), store = await storeFor(s), controller = new AbortController();
  const chooseAction = async (input, options) => {
    assert.equal(input.state.ats, "fixture");
    assert.equal(options.signal.aborted, false);
    assert.equal(options.isCurrent(["fill_name"]), true);
    return { actionId: "fill_name", confidence: 1, probabilities: { fill_name: 1 }, model: "jev-1.13.0", usage: { input_tokens: 1, output_tokens: 0 } };
  };
  let selected = false;
  await runWorker({ scope: s, store, signal: controller.signal, chooseAction,
    transport: { poll: async () => clockResponse(assignment(s)), heartbeat: async () => clockResponse(),
      event: async (id, event) => {
        controller.abort();
        return { applicationId: id, eventId: event.eventId, revision: event.expectedRevision + 1,
          state: event.state, replayed: false, lease: null, serverTime: Date.now() };
      } },
    dispatch: async (lease, guard, context) => {
      assert.equal(context.signal.aborted, false);
      assert.equal(context.chooseAction, chooseAction);
      const decision = await context.chooseAction({
        state: { company: "Synthetic", role: "role", ats: lease.ats, tenant: lease.tenant,
          fields: [{ label: "Name", kind: "text" }], observedActions: ["fill_name"] },
        actions: [{ id: "fill_name", label: "Fill the observed name field" }],
      }, { signal: context.signal, isCurrent: ids => ids.length === 1 && ids[0] === "fill_name" });
      assert.equal(decision.actionId, "fill_name");
      selected = true;
      guard.check();
      return { state: "blocked_unsupported", reasonCode: "fixture" };
    } });
  assert.equal(selected, true);
});

test("checkpoint survives failed acknowledgement; restart replays same key before a new poll", async () => {
  const s = scope(), store = await storeFor(s), job = assignment(s);
  let first;
  await assert.rejects(runWorker({ scope: s, store, signal: new AbortController().signal,
    transport: { poll: async () => clockResponse(job), heartbeat: async () => clockResponse(),
      event: async (id, input) => { first = input; throw new Error("NETWORK_UNAVAILABLE"); } } }), /NETWORK_UNAVAILABLE/);
  const pending = (await store.read("checkpoint")).pending;
  assert.deepEqual(pending.event, first);
  const controller = new AbortController(), order = [];
  await runWorker({ scope: s, store, signal: controller.signal, transport: {
    event: async (id, input) => {
      order.push("event"); assert.deepEqual(input, first);
      return { applicationId: id, eventId: input.eventId, revision: 2, state: input.state,
        replayed: true, lease: null, serverTime: Date.now() };
    },
    poll: async () => { order.push("poll"); controller.abort(); return clockResponse(); },
    heartbeat: async () => clockResponse(),
  } });
  assert.deepEqual(order, ["event", "poll"]);
  assert.equal((await store.read("checkpoint")).pending, null);
});

test("stop during awaited stage revokes mutation ability and does not report cancelled/submitted", async () => {
  const s = scope(), store = await storeFor(s), controller = new AbortController();
  let writes = 0, events = 0, stageFinished;
  const finished = new Promise(resolve => stageFinished = resolve);
  await runWorker({ scope: s, store, signal: controller.signal,
    transport: { poll: async () => clockResponse(assignment(s)), heartbeat: async () => clockResponse(),
      event: async () => { events++; } },
    dispatch: async (lease, guard) => {
      controller.abort();
      await sleep(10);
      await assert.rejects(guard.mutate(() => { writes++; }));
      stageFinished();
      return { state: "blocked_unsupported", reasonCode: "adapter_unavailable" };
    } });
  await finished;
  assert.equal(writes, 0); assert.equal(events, 0);
});

test("submission_unknown has no mutable dispatch or event", async () => {
  const s = scope(), store = await storeFor(s), controller = new AbortController();
  let dispatches = 0, events = 0;
  await runWorker({ scope: s, store, signal: controller.signal,
    transport: { poll: async () => {
      setTimeout(() => controller.abort(), 20);
      return clockResponse({ ...assignment(s), state: "submission_unknown", mode: "reconcile" });
    }, heartbeat: async () => clockResponse(), event: async () => { events++; } },
    dispatch: async () => { dispatches++; } });
  assert.equal(dispatches, 0); assert.equal(events, 0);
});

test("every safe-stage checkpoint restarts with its exact event ID, sequence and revision", async () => {
  for (const stage of ["screening", "tailoring", "filling", "ready"]) {
    const s = scope(), store = await storeFor(s), job = { ...assignment(s),
      state: stage, checkpoint: { stage, sequence: 4 } };
    const transport = {
      poll: async () => clockResponse(job), heartbeat: async () => clockResponse(),
      event: async () => { throw new Error("NETWORK_UNAVAILABLE"); },
    };
    await assert.rejects(runWorker({ scope: s, store, signal: new AbortController().signal, transport }));
    const pending = (await store.read("checkpoint")).pending;
    assert.deepEqual(pending.event.checkpoint, { stage, sequence: 5 });
    const controller = new AbortController();
    await runWorker({ scope: s, store, signal: controller.signal, transport: {
      ...transport,
      event: async (id, event) => {
        assert.deepEqual(event, pending.event);
        return { applicationId: id, eventId: event.eventId, revision: 2, state: event.state,
          replayed: true, lease: null, serverTime: Date.now() };
      },
      poll: async () => { controller.abort(); return clockResponse(); },
    } });
    assert.equal((await store.read("checkpoint")).pending, null);
  }
});

test("cross-owner, wrong-worker and changed-protocol assignments never dispatch or write events", async () => {
  const s = scope();
  for (const change of [{ ownerId: "synthetic-owner-b" }, { workerId: randomUUID() }, { policyRevision: 0 }]) {
    let writes = 0;
    const job = { ...assignment(s), ...change };
    await assert.rejects(runWorker({ scope: s, store: await storeFor(s), signal: new AbortController().signal,
      transport: { poll: async () => clockResponse(job), heartbeat: async () => clockResponse(),
        event: async () => { writes++; } },
      dispatch: async () => { writes++; },
    }));
    assert.equal(writes, 0);
  }
  await assert.rejects(runWorker({ scope: s, store: await storeFor(s), signal: new AbortController().signal,
    transport: { poll: async () => ({ ...clockResponse(), protocolVersion: 2 }), heartbeat: async () => clockResponse() },
  }));
});

test("failed durable checkpoint write sends no event; invalid acknowledgements remain pending", async () => {
  for (const fault of ["write", "event-id", "application-id", "revision", "state"]) {
    const s = scope(), store = await storeFor(s), job = assignment(s);
    let sent = 0;
    const guardedStore = fault === "write" ? { ...store, write: async () => { throw new Error("SYNTHETIC_DISK_FAILURE"); } } : store;
    await assert.rejects(runWorker({ scope: s, store: guardedStore, signal: new AbortController().signal,
      transport: {
        poll: async () => clockResponse(job), heartbeat: async () => clockResponse(),
        event: async (id, event) => {
          sent++;
          return { applicationId: fault === "application-id" ? randomUUID() : id,
            eventId: fault === "event-id" ? randomUUID() : event.eventId,
            revision: fault === "revision" ? 99 : event.expectedRevision + 1,
            state: fault === "state" ? "submitted" : event.state, replayed: false, lease: null, serverTime: Date.now() };
        },
      },
    }), fault === "write" ? /SYNTHETIC_DISK_FAILURE/ : /INVALID_ACKNOWLEDGEMENT/);
    assert.equal(sent, fault === "write" ? 0 : 1);
    assert.equal(Boolean((await store.read("checkpoint"))?.pending), fault !== "write");
    assert.equal(await store.read("lock"), null);
  }
});

test("stale pending checkpoint is retained diagnostically and re-polled without dispatching its old lease", async () => {
  const s = scope(), store = await storeFor(s), job = assignment(s);
  await assert.rejects(runWorker({ scope: s, store, signal: new AbortController().signal,
    transport: { poll: async () => clockResponse(job), heartbeat: async () => clockResponse(),
      event: async () => { throw new TransportError("HTTP_503", 503); } } }));
  const journal = await store.read("checkpoint"), order = [], controller = new AbortController();
  await runWorker({ scope: s, store, signal: controller.signal,
    dispatch: async () => assert.fail("Old assignment is not mutation authority"),
    transport: {
      event: async (_id, event) => {
        order.push("event"); assert.deepEqual(event, journal.pending.event);
        throw new TransportError("HTTP_409", 409);
      },
      poll: async () => { order.push("poll"); controller.abort(); return clockResponse(); },
      heartbeat: async () => clockResponse(),
    },
  });
  assert.deepEqual(order, ["event", "poll"]);
  assert.equal((await store.read("checkpoint")).pending, null);
  assert.deepEqual(await store.read("rejected-checkpoint"), journal);
});
