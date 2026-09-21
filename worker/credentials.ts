import { createHash } from "node:crypto";
import type { EntryOptions } from "@napi-rs/keyring";

export type WorkerScope = { origin: string; ownerId: string; workerId: string };
export type CredentialEntry = {
  getPassword(): string | null;
  setPassword(value: string): void;
  deletePassword(): boolean;
};
export type CredentialBackend = (service: string, account: string, options: EntryOptions) => CredentialEntry;

export function keychainAddress(scope: WorkerScope, purpose: string) {
  if (!scope.origin || !scope.ownerId || !scope.workerId || !/^[a-z][a-z0-9:_-]{0,79}$/.test(purpose)) {
    throw new Error("INVALID_CREDENTIAL_SCOPE");
  }
  const digest = (values: string[]) => createHash("sha256").update(JSON.stringify(values)).digest("hex");
  return {
    service: `workie.worker.v1.${digest([scope.origin])}`,
    account: digest([scope.origin, scope.ownerId, scope.workerId, purpose]),
  };
}

export async function nativeCredentialBackend(): Promise<CredentialBackend> {
  try {
    const { Entry } = await import("@napi-rs/keyring");
    return (service, account, options) => new Entry(service, account, options);
  } catch {
    throw new Error("CREDENTIAL_UNAVAILABLE");
  }
}

export function credentials(scope: WorkerScope, backend: CredentialBackend, platform: string = process.platform) {
  if (!["darwin", "linux", "win32"].includes(platform)) throw new Error("UNSUPPORTED_PLATFORM");
  const withEntry = <T>(purpose: string, action: (entry: CredentialEntry) => T): T => {
    const { service, account } = keychainAddress(scope, purpose);
    try {
      // Pin even on other OSes: a Linux deployment must never choose volatile keyutils.
      return action(backend(service, account, { linux: { store: "secret-service" } }));
    } catch {
      throw new Error("CREDENTIAL_UNAVAILABLE");
    }
  };
  return {
    get: (purpose: string) => withEntry(purpose, entry => entry.getPassword()),
    set: (purpose: string, value: string) => {
      if (!value || Buffer.byteLength(value) > 16384) throw new Error("INVALID_CREDENTIAL");
      withEntry(purpose, entry => entry.setPassword(value));
    },
    remove: (purpose: string) => withEntry(purpose, entry => entry.deletePassword()),
  };
}
