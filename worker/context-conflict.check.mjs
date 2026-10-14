import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { workerTransport, TransportError } from "./transport.ts";
import { createStageDispatch } from "./main.ts";

// 2026-10-14: a posting re-crawled after discovery made /context return 409 CONTEXT_UNAVAILABLE.
// The worker threw, launchd restarted it, the server handed the same lease back, and May's queue stalled.

test("an error response keeps the server's code so the worker can tell conflicts apart", async (t) => {
  const server = createServer((req, res) => {
    res.writeHead(409, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "Official posting content changed.",
        code: "CONTEXT_UNAVAILABLE",
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const client = workerTransport({
    origin: `http://127.0.0.1:${server.address().port}`,
    token: "S".repeat(43),
    allowLoopback: true,
  });
  const applicationId = randomUUID();
  await assert.rejects(
    client.applicationContext(applicationId, {
      protocolVersion: 1,
      applicationId,
      fence: 1,
      expectedRevision: 1,
    }),
    (error) =>
      error instanceof TransportError &&
      error.message === "HTTP_409" &&
      error.status === 409 &&
      error.code === "CONTEXT_UNAVAILABLE",
  );
});

test("a context conflict parks that application instead of stopping the worker", async () => {
  const signal = new AbortController().signal;
  for (const code of ["CONTEXT_UNAVAILABLE", "IDENTITY_MISMATCH"]) {
    const control = {
      applicationContext: async () => {
        throw new TransportError("HTTP_409", 409, code);
      },
    };
    const dispatch = createStageDispatch(control, "/nonexistent", signal);
    const result = await dispatch(
      {
        applicationId: randomUUID(),
        runId: randomUUID(),
        fence: 1,
        revision: 1,
        state: "screening",
        checkpoint: null,
      },
      { check() {} },
      {
        signal,
        generate: async () => {
          throw new Error("unused");
        },
        advance() {},
      },
    );
    assert.deepEqual(result, {
      state: "retryable_failure",
      reasonCode: code.toLowerCase(),
    });
  }
});

test("other context failures still stop the worker", async () => {
  const signal = new AbortController().signal;
  const control = {
    applicationContext: async () => {
      throw new TransportError("HTTP_401", 401, "UNAUTHORIZED");
    },
  };
  await assert.rejects(
    createStageDispatch(control, "/nonexistent", signal)(
      {
        applicationId: randomUUID(),
        runId: randomUUID(),
        fence: 1,
        revision: 1,
        state: "screening",
        checkpoint: null,
      },
      { check() {} },
      {
        signal,
        generate: async () => {
          throw new Error("unused");
        },
        advance() {},
      },
    ),
    /HTTP_401/,
  );
});
