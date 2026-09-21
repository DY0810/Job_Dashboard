import { chmod, mkdir } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';

export class BrowserEgressError extends Error {
  readonly code = 'BROWSER_EGRESS_BLOCKED';
}

type BrowserOptions = {
  userDataDir: string;
  approvedOrigins: readonly string[];
  headless?: boolean;
  allowLoopback?: boolean;
  timeoutMs?: number;
};

function privateAddress(value: string) {
  const normalized = value.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(normalized) === 4) {
    const parts = normalized.split('.').map(Number);
    const first = parts[0], second = parts[1];
    return first === 0 || first === 10 || first === 127 || (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && (second === 0 || second === 168)) || (first === 198 && (second === 18 || second === 19)) || first >= 224;
  }
  if (isIP(normalized) === 6) {
    return normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') ||
      normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb') ||
      normalized.startsWith('2001:db8:') || normalized.startsWith('::ffff:');
  }
  return true;
}

async function publicHost(hostname: string, allowLoopback: boolean) {
  const literal = isIP(hostname) !== 0;
  if (literal) return !privateAddress(hostname) || (allowLoopback && privateAddress(hostname) && /^127\./.test(hostname));
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.length > 0 && answers.every(({ address }) => !privateAddress(address));
}

function canonicalOrigins(origins: readonly string[]) {
  const values = origins.map((value) => {
    let url: URL;
    try { url = new URL(value); } catch { throw new BrowserEgressError('Invalid approved origin.'); }
    if (url.username || url.password || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && /^127\.0\.0\.1$/.test(url.hostname)))) {
      throw new BrowserEgressError('Invalid approved origin.');
    }
    return url.origin;
  });
  return new Set(values);
}

async function assertUrl(value: string, origins: ReadonlySet<string>, allowLoopback: boolean) {
  let url: URL;
  try { url = new URL(value); } catch { throw new BrowserEgressError('Invalid browser URL.'); }
  if (!origins.has(url.origin) || !['http:', 'https:'].includes(url.protocol) ||
    url.username || url.password || url.hash || !(await publicHost(url.hostname, allowLoopback))) {
    throw new BrowserEgressError('Browser egress is outside the approved public origin.');
  }
  return url;
}

export type BrowserRuntime = {
  context: BrowserContext;
  page(): Promise<Page>;
  navigate(page: Page, url: string): Promise<Page>;
  close(): Promise<void>;
};

export async function createBrowserRuntime(options: BrowserOptions): Promise<BrowserRuntime> {
  if (!isAbsolute(options.userDataDir)) throw new BrowserEgressError('Persistent browser directory is required.');
  const origins = canonicalOrigins(options.approvedOrigins);
  if (!origins.size) throw new BrowserEgressError('At least one approved origin is required.');
  await mkdir(options.userDataDir, { recursive: true, mode: 0o700 });
  await chmod(options.userDataDir, 0o700);
  const allowLoopback = options.allowLoopback === true;
  const context = await chromium.launchPersistentContext(options.userDataDir, {
    headless: options.headless ?? true,
    serviceWorkers: 'block',
    timeout: options.timeoutMs ?? 15_000,
  });
  await context.route('**/*', async (route) => {
    try {
      await assertUrl(route.request().url(), origins, allowLoopback);
      await route.continue();
    } catch {
      await route.abort('blockedbyclient');
    }
  });
  return {
    context,
    page: () => context.newPage(),
    navigate: async (page, url) => {
      await assertUrl(url, origins, allowLoopback);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs ?? 15_000 });
      await assertUrl(page.url(), origins, allowLoopback);
      return page;
    },
    close: () => context.close(),
  };
}
