import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import { readMaskedGrant } from "./input.ts";

test("grant is entered from masked TTY stdin, never echoed, and raw mode is restored", async () => {
  const input = new PassThrough(), output = new PassThrough(), modes = [], chunks = [];
  Object.assign(input, { isTTY: true, isRaw: false, setRawMode(value) { modes.push(value); this.isRaw = value; } });
  output.on("data", bytes => chunks.push(bytes));
  const result = readMaskedGrant(input, output);
  input.write("G".repeat(43) + "\r");
  assert.equal(await result, "G".repeat(43));
  assert(!Buffer.concat(chunks).toString().includes("G"));
  assert.deepEqual(modes, [true, false]);
  assert.equal(input.listenerCount("data"), 0);
});

test("masked input restores terminal state on interruption and rejects pipes and oversized paste", async () => {
  await assert.rejects(readMaskedGrant(new PassThrough(), new PassThrough()), /TTY_REQUIRED/);
  const input = new PassThrough();
  Object.assign(input, { isTTY: true, isRaw: false, setRawMode(value) { this.isRaw = value; } });
  let result = readMaskedGrant(input, new PassThrough());
  input.write("\u0003");
  await assert.rejects(result, /STOPPED/);
  assert.equal(input.isRaw, false);
  result = readMaskedGrant(input, new PassThrough());
  input.write("G".repeat(44));
  await assert.rejects(result, /INVALID_GRANT/);
  assert.equal(input.isRaw, false);
});

test("TTY close settles immediately and restores raw mode and listeners", async () => {
  const input = new PassThrough(), controller = new AbortController();
  Object.assign(input, { isTTY: true, isRaw: false, setRawMode(value) { this.isRaw = value; } });
  const result = readMaskedGrant(input, new PassThrough(), controller.signal);
  const timeout = setTimeout(() => controller.abort(), 50);
  input.emit("close");
  try { await assert.rejects(result, /INPUT_CLOSED/); }
  finally { clearTimeout(timeout); }
  assert.equal(input.isRaw, false);
  assert.equal(input.listenerCount("data"), 0);
});

test("masked input deadline and raw-mode failure clean up without exposing entered values", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const input = new PassThrough();
  Object.assign(input, { isTTY: true, isRaw: false, setRawMode(value) { this.isRaw = value; } });
  const pending = readMaskedGrant(input, new PassThrough());
  input.write("G".repeat(20));
  t.mock.timers.tick(120000);
  await assert.rejects(pending, /INPUT_TIMEOUT/);
  assert.equal(input.isRaw, false);
  assert.equal(input.listenerCount("data"), 0);
  input.setRawMode = () => { throw new Error("synthetic-terminal-failure"); };
  await assert.rejects(readMaskedGrant(input, new PassThrough()), /INPUT_CLOSED/);
});
