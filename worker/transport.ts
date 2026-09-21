import { z } from "zod";
import {
  PairRequestSchema, PairResponseSchema, PollRequestSchema, PollResponseSchema,
  HeartbeatRequestSchema, EventRequestSchema, EventResponseSchema, WORKER_PROTOCOL_VERSION,
} from "../lib/applications/worker-protocol.ts";
import type { PairRequest, HeartbeatRequest, EventRequest } from "../lib/applications/worker-protocol.ts";

export function controlOrigin(input: string, allowLoopback = false) {
  let url;
  try { url = new URL(input); } catch { throw new Error("INVALID_ORIGIN"); }
  if (input !== url.origin || url.username || url.password || url.search || url.hash) throw new Error("INVALID_ORIGIN");
  const loopback = ["127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.hostname === "localhost" || url.hostname.endsWith(".localhost") ||
    (!loopback && (url.hostname.startsWith("127.") || url.hostname.startsWith("[::ffff:")))) {
    throw new Error("INVALID_ORIGIN");
  }
  if (loopback && !allowLoopback) throw new Error("LOOPBACK_DISABLED");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback && allowLoopback)) throw new Error("INVALID_ORIGIN");
  return url.origin;
}

export class TransportError extends Error {
  status: number;
  constructor(code: string, status = 0) { super(code); this.status = status; }
}

export function workerTransport(options: {
  origin: string; token?: string; allowLoopback?: boolean; timeoutMs?: number;
}) {
  const origin = controlOrigin(options.origin, options.allowLoopback);
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") throw new Error("TLS_BYPASS_FORBIDDEN");
  if (options.token !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(options.token)) throw new Error("INVALID_CREDENTIAL");
  const timeout = options.timeoutMs ?? 8000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 8000) throw new Error("INVALID_TIMEOUT");
  async function post<T>(
    path: string, body: unknown, schema: z.ZodType<T>, signal?: AbortSignal, checkpoint = false,
  ): Promise<T> {
    const payload = JSON.stringify(body);
    if (Buffer.byteLength(payload) > 128 * 1024) throw new TransportError("REQUEST_LIMIT");
    // Only idempotent checkpoint events retry automatically, with the same serialized body/key.
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetch(`${origin}${path}`, {
          method: "POST", redirect: "error", cache: "no-store", credentials: "omit",
          headers: {
            "Content-Type": "application/json", Accept: "application/json",
            ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
          },
          body: payload,
          signal: AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]),
        });
        const reader = response.body?.getReader();
        try {
          if (!response.ok) throw new TransportError(`HTTP_${response.status}`, response.status);
          if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "") || !reader) {
            throw new TransportError("INVALID_RESPONSE");
          }
          const length = Number(response.headers.get("content-length"));
          if (!Number.isFinite(length) || length > 128 * 1024) throw new TransportError("RESPONSE_LIMIT");
          const chunks: Uint8Array[] = [];
          let size = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 128 * 1024) throw new TransportError("RESPONSE_LIMIT");
            chunks.push(value);
          }
          let parsed;
          try { parsed = schema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
          catch { throw new TransportError("INVALID_RESPONSE"); }
          if (!parsed.success) throw new TransportError("INVALID_RESPONSE");
          return parsed.data;
        } finally { await reader?.cancel().catch(() => {}); }
      } catch (error) {
        const safe = error instanceof TransportError ? error : new TransportError(signal?.aborted ? "STOPPED" : "NETWORK_UNAVAILABLE");
        if (!checkpoint || attempt >= 2 || signal?.aborted ||
          !(safe.message === "NETWORK_UNAVAILABLE" || safe.status >= 500)) throw safe;
      }
    }
  }
  const version = { protocolVersion: WORKER_PROTOCOL_VERSION };
  return {
    pair: (input: PairRequest, signal?: AbortSignal) =>
      post("/api/worker/pair", PairRequestSchema.parse(input), PairResponseSchema, signal),
    poll: (signal?: AbortSignal) =>
      post("/api/worker/poll", PollRequestSchema.parse(version), PollResponseSchema, signal),
    heartbeat: (lease: HeartbeatRequest["lease"], signal?: AbortSignal) =>
      post("/api/worker/heartbeat", HeartbeatRequestSchema.parse({ ...version, lease }), PollResponseSchema, signal),
    event: (applicationId: string, input: EventRequest, signal?: AbortSignal) => {
      if (!z.uuid().safeParse(applicationId).success) throw new TransportError("INVALID_APPLICATION");
      return post(`/api/worker/applications/${applicationId}/events`,
        EventRequestSchema.parse(input), EventResponseSchema, signal, true);
    },
  };
}
export type WorkerTransport = ReturnType<typeof workerTransport>;
