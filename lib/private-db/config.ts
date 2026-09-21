import { lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export class PrivateConfigurationError extends Error {
  constructor() {
    super('Private storage unavailable: configure a separate WORKIE_PRIVATE_DATABASE_URL and auth token.');
    this.name = 'PrivateConfigurationError';
  }
}

export type PrivateConfig = { url: string; authToken?: string };
export type CorpusGuards = { corpusUrl?: string; corpusPath?: string };

function fileIdentity(path: string, depth = 0): string {
  if (depth > 40) throw new PrivateConfigurationError();
  try {
    return realpathSync.native(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // Resolve dangling links and existing parents before comparing future files.
    const entry = lstatSync(path, { throwIfNoEntry: false });
    if (entry?.isSymbolicLink()) {
      const destination = readlinkSync(path);
      return fileIdentity(isAbsolute(destination) ? destination : `${dirname(path)}/${destination}`, depth + 1);
    }
    return join(fileIdentity(dirname(path), depth + 1), basename(path));
  }
}

function target(raw: string) {
  if (!raw || /[\s\\\x00-\x1f\x7f]/.test(raw)) throw new PrivateConfigurationError();
  // libSQL and HTTPS address the same database host; normalize before comparing.
  const url = /^file:[^/]/i.test(raw)
    ? new URL(raw.slice(5), pathToFileURL(`${process.cwd()}/`))
    : new URL(raw.replace(/^libsql:/i, 'https:'));
  if (url.username || url.password || url.search || url.hash) throw new PrivateConfigurationError();
  if (url.protocol === 'file:') {
    if (raw.toLowerCase().startsWith('file::memory:')) throw new PrivateConfigurationError();
    fileURLToPath(url); // Validate authority/encoding, without losing symlink/.. semantics.
    const decoded = decodeURIComponent(raw.slice(5).replace(/^\/\/[^/]*/, ''));
    const path = fileIdentity(isAbsolute(decoded) ? decoded : `${process.cwd()}/${decoded}`);
    const entry = statSync(path, { throwIfNoEntry: false });
    if (entry && !entry.isFile()) throw new PrivateConfigurationError();
    return { url: pathToFileURL(path).href, path, host: undefined, local: true };
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const loopback = host === '127.0.0.1' || host === '[::1]';
  if (!host || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new PrivateConfigurationError();
  }
  return { url: url.href, path: undefined, host, local: false };
}

function sameFile(left: string, right: string): boolean {
  if (left === right) return true;
  // Conservative on case-insensitive desktop filesystems, including absent files.
  if (process.platform === 'darwin' || process.platform === 'win32') {
    if (left.normalize('NFC').toLowerCase() === right.normalize('NFC').toLowerCase()) return true;
  }
  const a = statSync(left, { throwIfNoEntry: false });
  const b = statSync(right, { throwIfNoEntry: false });
  return Boolean(a && b && a.dev === b.dev && a.ino === b.ino);
}

/** Metadata inspection only. No client, database file, or network is opened here. */
export function validatePrivateConfig(config: PrivateConfig, guards: CorpusGuards = {}): PrivateConfig {
  try {
    if (!config || typeof config.url !== 'string' ||
      (config.authToken !== undefined && (typeof config.authToken !== 'string' || /[\s\x00-\x1f\x7f]/.test(config.authToken)))) {
      throw new PrivateConfigurationError();
    }
    const privateTarget = target(config.url);
    if (privateTarget.path && ((statSync(privateTarget.path, { throwIfNoEntry: false })?.mode ?? 0) & 0o077)) {
      throw new PrivateConfigurationError();
    }
    if (!privateTarget.local && new URL(privateTarget.url).protocol === 'https:' && !config.authToken) {
      throw new PrivateConfigurationError();
    }
    const corpusPaths = ['workie.db', process.env.WORKIE_DB, guards.corpusPath].filter((path): path is string => Boolean(path));
    const corpusUrls = [process.env.TURSO_DATABASE_URL, guards.corpusUrl].filter((url): url is string => Boolean(url));
    const corpus = [
      ...corpusPaths.map((path) => ({
        path: fileIdentity(isAbsolute(path) ? path : `${process.cwd()}/${path}`), host: undefined,
      })),
      ...corpusUrls.map(target),
    ];
    if (corpus.some((entry) => privateTarget.path && entry.path
      ? sameFile(privateTarget.path, entry.path)
      : privateTarget.host && entry.host && privateTarget.host === entry.host)) {
      throw new PrivateConfigurationError();
    }
    return { url: privateTarget.url, ...(config.authToken ? { authToken: config.authToken } : {}) };
  } catch {
    // Parser/filesystem/driver messages can contain paths, credentials, or URL parameters.
    throw new PrivateConfigurationError();
  }
}
