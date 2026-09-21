import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Entry, AsyncEntry } from "@napi-rs/keyring";

const require = createRequire(import.meta.url);
assert.equal(require("@napi-rs/keyring/package.json").version, "2.1.0");
assert.equal(typeof Entry, "function");
assert.equal(typeof AsyncEntry, "function");
for (const name of ["setPassword", "getPassword", "deletePassword"]) {
  assert.equal(typeof Entry.prototype[name], "function");
}
process.stdout.write(JSON.stringify({
  version: "2.1.0", node: process.version, platform: process.platform, arch: process.arch,
  nativeBindingLoaded: true, keychainConstructed: false, keychainRead: false,
  keychainWritten: false, credentialsEnumerated: false,
}) + "\n");
