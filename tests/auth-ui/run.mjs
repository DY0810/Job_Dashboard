import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { validateReport } from './validate-report.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
assert.equal(process.cwd(), root, 'Run from the Workie worktree root');
assert.equal(process.version, 'v22.23.2', 'Use the qualified Node 22 runtime');
const gate = join(root, 'logs/auto-apply-gate');
const ready = JSON.parse(readFileSync(join(gate, 'phase1-build-ready.json'), 'utf8'));
assert.equal(ready.buildReady, true, 'Builder must publish buildReady:true before this runner starts');
assert.ok(existsSync(join(root, '.next/BUILD_ID')), 'A completed production build is required');
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
assert.equal(readFileSync(join(root, '.next/BUILD_ID'), 'utf8').trim(), ready.buildId, 'Stale build marker');
assert.equal(hash(join(root, '.next/server/app-paths-manifest.json')), ready.buildManifestHash, 'Stale build manifest');
const inputs = JSON.parse(readFileSync(ready.inputs, 'utf8'));
assert.equal(createHash('sha256').update(JSON.stringify(inputs.files)).digest('hex'), ready.sourceHash);
for (const [file, expected] of Object.entries(inputs.files)) {
  assert.equal(hash(join(root, file)), expected, `Source changed since build: ${file}`);
}
assert.deepEqual(readdirSync(root).filter((name) => /^\.env(?:$|\.)/.test(name) && name !== '.env.example'), [],
  'Refuse to let Next load local credentials');
const out = mkdtempSync(join(gate, 'phase1-ui-'));
for (const name of ['home', 'tmp', 'screenshots']) mkdirSync(join(out, name), { recursive: true });

const reservation = createServer();
await new Promise((resolve, reject) => {
  reservation.once('error', reject);
  reservation.listen(0, '127.0.0.1', resolve);
});
const { port } = reservation.address();
await new Promise((resolve) => reservation.close(resolve));
const baseURL = `http://127.0.0.1:${port}`;
// Allowlist, never copy process.env: no credentials, providers, SMTP, or auth config.
const env = {
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
  HOME: join(out, 'home'),
  TMPDIR: join(out, 'tmp'),
  NODE_ENV: 'production',
  NEXT_TELEMETRY_DISABLED: '1',
  CI: '1',
  AUTH_UI_BASE_URL: baseURL,
  AUTH_UI_OUTPUT_DIR: out,
  PLAYWRIGHT_BROWSERS_PATH: join(gate, 'playwright'),
  WORKIE_DB: join(out, 'must-not-create.db'),
};
const policy = `(version 1) (allow default)
  (deny network*)
  (allow network-bind (local ip "localhost:*"))
  (allow network-inbound (local ip "localhost:*"))
  (allow network-outbound (remote ip "localhost:*"))
  (deny file-write*)
  (allow file-write* (subpath "${out}") (literal "/dev/null"))`;
const children = new Set();
const logs = [];
function launch(name, args) {
  const fd = openSync(join(out, `${name}.log`), 'w');
  logs.push(fd);
  const child = spawn('/usr/bin/sandbox-exec', ['-p', policy, process.execPath, ...args],
    { cwd: root, env, detached: true, stdio: ['ignore', fd, fd] });
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}
function kill(child, signal) {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}
const result = { evidence: 'UI-controller proof with explicitly simulated auth responses', baseURL,
  output: out, buildId: ready.buildId, sourceHash: ready.sourceHash, passed: false, serverStopped: false };
const timer = setTimeout(() => {
  for (const child of children) kill(child, 'SIGKILL');
}, 180_000);
let server;
let serverExit;
try {
  server = launch('server', ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(port)]);
  serverExit = once(server, 'exit');
  for (let attempt = 0; attempt < 150; attempt++) {
    assert.equal(server.exitCode, null, 'Next exited before readiness; see server.log');
    if (readFileSync(join(out, 'server.log'), 'utf8').includes('Ready in')) break;
    await delay(200);
  }
  assert.match(readFileSync(join(out, 'server.log'), 'utf8'), /Ready in/, 'Next did not become ready');
  const args = ['node_modules/@playwright/test/cli.js', 'test', '--config=playwright.auth.config.ts', 'tests/auth-ui/sign-in.pw.ts'];
  writeFileSync(join(out, 'command.json'), JSON.stringify({
    command: [process.execPath, ...args], env, serverPolicy: policy, evidence: result.evidence,
  }, null, 2));
  const tests = launch('playwright', args);
  const [code, signal] = await once(tests, 'exit');
  result.testExitCode = code;
  result.testSignal = signal;
  result.matrix = validateReport(JSON.parse(readFileSync(join(out, 'results.json'), 'utf8')));
  assert.equal(code, 0, `Rendered tests failed; see ${out}/playwright.log and results.json`);
  assert.equal(existsSync(env.WORKIE_DB), false, 'UI must not create a corpus database');
  result.passed = true;
} catch (error) {
  result.error = error.message;
  process.exitCode = 1;
} finally {
  for (const child of children) kill(child, 'SIGTERM');
  const force = setTimeout(() => {
    for (const child of children) kill(child, 'SIGKILL');
  }, 5000);
  if (serverExit) {
    const [code, signal] = await serverExit;
    result.serverStopped = true;
    result.serverExitCode = code;
    result.serverSignal = signal;
  }
  for (const child of children) await once(child, 'exit');
  clearTimeout(force);
  clearTimeout(timer);
  for (const fd of logs) closeSync(fd);
  const listener = spawnSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { env, encoding: 'utf8' });
  result.portHasNoListener = listener.status === 1 && listener.stdout === '';
  if (!result.portHasNoListener || !result.serverStopped) {
    result.passed = false;
    process.exitCode = 1;
  }
  writeFileSync(join(out, 'summary.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
