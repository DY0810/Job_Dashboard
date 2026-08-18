/**
 * Recorded-response fixtures, so the connector suite runs with the network unplugged
 * (plan Phase 3 gate: "offline suite passes against the recorded fixtures").
 *
 * A fixture is `{ url: raw response body }`, recorded from a real live run with
 * `npm run ingest -- --record` and trimmed on the way in so the committed files stay small.
 *
 * A replayed URL that was never recorded THROWS. That is deliberate: the ATS connectors
 * iterate the whole registry, only the first target of each is recorded, and the rest have to
 * fail exactly the way a dead token fails in production. The fixture suite therefore also
 * exercises per-target isolation for free.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FetchOptions, Runtime } from '../../lib/runtime.ts';

export type Fixture = Record<string, string>;

export const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');

export function fixturePath(name: string): string {
  return join(FIXTURE_DIR, `${name}.json`);
}

export function loadFixture(name: string): Fixture {
  return JSON.parse(readFileSync(fixturePath(name), 'utf8')) as Fixture;
}

export function saveFixture(name: string, fixture: Fixture): void {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(fixturePath(name), `${JSON.stringify(fixture, null, 2)}\n`);
}

export function hasFixture(name: string): boolean {
  return existsSync(fixturePath(name));
}

const KEEP = 2;

const CREDENTIAL_IN_URL = /\b(app_?id|app_?key|api[-_]?key|key|token|affid|secret)=/i;

function truncateArrays(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, KEEP).map(truncateArrays);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, truncateArrays(v)]),
    );
  }
  return value;
}

function truncateBlocks(body: string, tag: string): string {
  let seen = 0;
  return body.replace(new RegExp(`<${tag}>[^]*?</${tag}>`, 'gi'), (match) => {
    seen += 1;
    return seen <= KEEP + 1 ? match : '';
  });
}

/**
 * Shrink a recorded body without changing its shape: JSON arrays down to two elements, RSS
 * `<item>` and README `<tr>` blocks down to the first few. A full Greenhouse board is ~2MB;
 * this is what keeps the committed fixture at a few kB while still exercising every field
 * the mapper reads.
 */
export function trimFixture(body: string): string {
  try {
    return JSON.stringify(truncateArrays(JSON.parse(body)));
  } catch {
    return truncateBlocks(truncateBlocks(body, 'item'), 'tr');
  }
}

/** Replay: serves recorded bodies, refuses everything else, never touches the network. */
export function fixtureRuntime(fixture: Fixture): Runtime {
  const fetchText = async (url: string): Promise<string> => {
    const body = fixture[url];
    if (body === undefined) throw new Error(`fixture miss: ${url}`);
    return body;
  };
  return {
    fetchText,
    fetchJson: async <T,>(url: string): Promise<T> => JSON.parse(await fetchText(url)) as T,
    isAllowed: async () => true,
  };
}

/**
 * Record: passes through to the live runtime and captures a trimmed copy of each body.
 *
 * `limit` caps how many URLs one connector contributes. The ATS connectors walk all 74
 * registry entries; recording every board would commit megabytes to prove a mapper that one
 * board already proves. Two is enough to cover SmartRecruiters' list-then-detail pair.
 */
export function recordingRuntime(inner: Runtime, sink: Fixture, limit = 2): Runtime {
  const fetchText = async (url: string, options?: FetchOptions): Promise<string> => {
    const body = await inner.fetchText(url, options);
    if (Object.keys(sink).length >= limit && !(url in sink)) return body;
    // A fixture file is COMMITTED, so a recorded URL must never carry a credential.
    // `redactUrl` is set by exactly the sources whose key is not a query param and so cannot
    // be spotted by inspecting the URL — Jooble puts its key in the path. Both checks drop
    // the entry outright rather than trying to rewrite a URL that would then not replay.
    if (!options?.redactUrl && !CREDENTIAL_IN_URL.test(url)) sink[url] = trimFixture(body);
    return body;
  };
  return {
    fetchText,
    fetchJson: async <T,>(url: string, options?: FetchOptions): Promise<T> =>
      JSON.parse(await fetchText(url, options)) as T,
    isAllowed: (url) => inner.isAllowed(url),
  };
}
