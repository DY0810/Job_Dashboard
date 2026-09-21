// Adapted from the auth UI runner: no build, real credentials, external network,
// nested agents or send_message_to_thread in any namespace/wrapper.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { validateReport } from './validate-report.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
assert.equal(process.cwd(), root);
assert.equal(root, '/Users/dyl/.codex/worktrees/workie-auto-apply/Workie');
assert.equal(process.version, 'v22.23.2');
const gate = join(root, 'logs/auto-apply-gate');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const args = process.argv.slice(2);
const uiBuild = args[0] === '--ui-build';
if (uiBuild) args.shift();
const diagnostic = args[0] === '--diagnostic';
if (diagnostic) args.shift();
else assert.equal(args.length, 0, 'Project/filter overrides are diagnostic only');
const built = json(join(gate, uiBuild ? 'phase2-ui-rendered-build.json' : 'phase2-parser-last-build.json'));
if (!uiBuild) {
  const ready = json(join(gate, 'phase2-build-ready.json'));
  assert.equal(ready.buildReady, true, 'Wait for the parser-owned final build gate');
  assert.equal(ready.buildId, built.buildId);
} else assert.equal(built.buildReady, true, 'UI-owned integration build must pass its checks');
assert.equal(built.mode, 'build', 'An early build is not the final integration build');
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
function verifyBuild() {
  assert.equal(readFileSync(join(root, '.next/BUILD_ID'), 'utf8').trim(), built.buildId, 'Stale build');
  assert.ok(Object.keys(built.source.files).length > 0);
  assert.equal(createHash('sha256').update(JSON.stringify(built.source.files)).digest('hex'), built.source.hash);
  if (!diagnostic) {
    const listed = spawnSync('/usr/bin/git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, env: {}, encoding: 'utf8' });
    assert.equal(listed.status, 0);
    assert.deepEqual([...new Set(listed.stdout.split('\0').filter(Boolean))].sort(), Object.keys(built.source.files).sort(),
      'Source file set changed since final build');
  }
  for (const [file, expected] of Object.entries(built.source.files)) {
    if (diagnostic && (file.startsWith('tests/profile-ui/') || file === 'playwright.profile.config.ts')) continue;
    assert.equal(hash(join(root, file)), expected, `Source changed since final build: ${file}`);
  }
}
verifyBuild();
assert.deepEqual(readdirSync(root).filter(name => /^\.env(?:$|\.)/.test(name) && name !== '.env.example'), [],
  'Next must not load local credentials');
const out = mkdtempSync(join(gate, 'phase2-ui-fixes-'));
for (const name of ['home', 'tmp']) mkdirSync(join(out, name));
const reservation = createServer();
await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
const { port } = reservation.address();
await new Promise(resolve => reservation.close(resolve));
const baseURL = `http://127.0.0.1:${port}`;
const env = {
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: join(out, 'home'), TMPDIR: join(out, 'tmp'),
  NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', CI: '1',
  PROFILE_UI_BASE_URL: baseURL, PROFILE_UI_OUTPUT_DIR: out,
  PLAYWRIGHT_BROWSERS_PATH: join(gate, 'playwright'), WORKIE_DB: join(out, 'must-not-create.db'),
};
const policy = `(version 1) (allow default) (deny network*)
  (allow network-bind (local ip "localhost:*"))
  (allow network-inbound (local ip "localhost:*"))
  (allow network-outbound (remote ip "localhost:*"))
  (deny file-write*) (allow file-write* (subpath "${out}") (literal "/dev/null"))`;
const children = new Set();
const logs = [];
function launch(name, args) {
  const fd = openSync(join(out, `${name}.log`), 'w', 0o600);
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
const result = { evidence: 'Real Next production UI, simulated applicant/profile/policy/document APIs',
  output: out, baseURL, diagnostic, uiBuild, buildId: built.buildId, sourceHash: built.source.hash,
  buildManifestHash: hash(join(root, '.next/server/app-paths-manifest.json')), passed: false, serverStopped: false };
const timer = setTimeout(() => { for (const child of children) kill(child, 'SIGKILL'); }, 900_000);
let serverExit;
try {
  const server = launch('server', ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(port)]);
  serverExit = once(server, 'exit');
  for (let attempt = 0; attempt < 150; attempt++) {
    assert.equal(server.exitCode, null, 'Next exited before readiness; inspect server.log');
    if (readFileSync(join(out, 'server.log'), 'utf8').includes('Ready in')) break;
    await delay(200);
  }
  assert.match(readFileSync(join(out, 'server.log'), 'utf8'), /Ready in/);
  const command = ['node_modules/@playwright/test/cli.js', 'test', '--config=playwright.profile.config.ts', ...args];
  writeFileSync(join(out, 'command.json'), JSON.stringify({ command: [process.execPath, ...command], env, policy }, null, 2));
  console.log(JSON.stringify({ output: out, command: [process.execPath, ...command] }));
  const [code, signal] = await once(launch('playwright', command), 'exit');
  result.testExitCode = code; result.testSignal = signal;
  const report = json(join(out, 'results.json'));
  result.counts = report.stats;
  if (!diagnostic) result.matrix = validateReport(report);
  assert.equal(code, 0, 'Rendered tests failed; inspect playwright.log and results.json');
  assert.equal(existsSync(env.WORKIE_DB), false, 'The corpus must remain unopened');
  verifyBuild();
  result.passed = !diagnostic;
  if (diagnostic) result.diagnosticPassed = true;
} catch (error) {
  result.error = error.message;
  process.exitCode = 1;
} finally {
  for (const child of children) kill(child, 'SIGTERM');
  const force = setTimeout(() => { for (const child of children) kill(child, 'SIGKILL'); }, 5000);
  if (serverExit) {
    const [code, signal] = await serverExit;
    result.serverStopped = true; result.serverExitCode = code; result.serverSignal = signal;
  }
  for (const child of children) await once(child, 'exit');
  clearTimeout(force); clearTimeout(timer);
  for (const fd of logs) closeSync(fd);
  const listener = spawnSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { env, encoding: 'utf8' });
  result.portHasNoListener = listener.status === 1 && listener.stdout === '';
  result.corpusNotCreated = !existsSync(env.WORKIE_DB);
  for (const name of ['home', 'tmp']) rmSync(join(out, name), { recursive: true, force: true });
  result.scratchRemoved = ['home', 'tmp'].every(name => !existsSync(join(out, name)));
  if (!result.portHasNoListener || !result.serverStopped || !result.corpusNotCreated || !result.scratchRemoved) {
    result.passed = false;
    if (diagnostic) result.diagnosticPassed = false;
    process.exitCode = 1;
  }
  writeFileSync(join(out, 'summary.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
