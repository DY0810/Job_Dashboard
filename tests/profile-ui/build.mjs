// UI-owned integration build. No parser-ready markers, messaging or nested agents.
// Reuses the prepared Phase 1 font proxy and Phase 2 isolated build environment.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';

const root = process.cwd();
assert.equal(root, '/Users/dyl/.codex/worktrees/workie-auto-apply/Workie');
assert.equal(process.version, 'v22.23.2');
assert.deepEqual(readdirSync(root).filter(name => /^\.env(?:$|\.)/.test(name) && name !== '.env.example'), []);
const gate = join(root, 'logs/auto-apply-gate');
const out = mkdtempSync(join(gate, 'phase2-ui-build-'));
const scratch = mkdtempSync('/private/tmp/workie-phase2-ui-build-');
mkdirSync(join(scratch, 'home'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (path, data) => writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
function sourceState() {
  const listed = spawnSync('/usr/bin/git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, env: {}, encoding: 'utf8' });
  assert.equal(listed.status, 0);
  const files = Object.fromEntries([...new Set(listed.stdout.split('\0').filter(Boolean))].sort()
    .map(file => [file, hash(readFileSync(join(root, file)))]));
  return { hash: hash(JSON.stringify(files)), files };
}
const processes = spawnSync('/bin/ps', ['-axo', 'pid=,command='], { env: {}, encoding: 'utf8' });
for (const row of processes.stdout.split('\n')) {
  if (!/next-server|next(?:\/dist\/bin\/next)? (?:build|dev|start)/.test(row)) continue;
  const pid = row.trim().split(/\s+/)[0];
  const cwd = spawnSync('/usr/sbin/lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], { env: {}, encoding: 'utf8' });
  assert.ok(!cwd.stdout.split('\n').includes(`n${root}`), `Stop existing Next process ${pid} before building`);
}
const source = sourceState();
const env = {
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
  HOME: join(scratch, 'home'), TMPDIR: scratch, TMP: scratch, TEMP: scratch,
  NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', CI: '1',
  WORKIE_DB: join(scratch, 'must-not-create.db'), WORKIE_ALLOW_LOCAL_REFRESH: '0',
};
const offline = `(version 1) (allow default) (deny network*) (deny file-write*)
  (allow file-write* (subpath "${out}") (subpath "${scratch}")
    (subpath "${root}/node_modules/.vite") (subpath "${root}/node_modules/.vite-temp") (literal "/dev/null"))`;
const commands = [];
async function run(name, args, policy = offline, overrides = {}) {
  const fd = openSync(join(out, `${name}.log`), 'w', 0o600);
  const child = spawn('/usr/bin/sandbox-exec', ['-p', policy, process.execPath, ...args],
    { cwd: root, env: { ...env, ...overrides }, detached: true, stdio: ['ignore', fd, fd] });
  const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 600_000);
  const [code, signal] = await once(child, 'exit');
  clearTimeout(timer); closeSync(fd);
  commands.push({ name, command: [process.execPath, ...args], policy, overrides, code, signal });
  save(join(out, 'commands.json'), commands);
  console.log(JSON.stringify({ name, code, log: join(out, `${name}.log`) }));
  assert.equal(code, 0, `${name} failed`);
}
const requests = [];
const sockets = new Set();
const proxy = createServer((_req, res) => res.writeHead(403).end());
proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
proxy.on('connect', (req, socket, head) => {
  const allowed = ['fonts.googleapis.com:443', 'fonts.gstatic.com:443'].includes(req.url);
  requests.push({ host: allowed ? req.url : 'blocked-other-host', allowed });
  if (!allowed) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  const remote = connect(443, req.url.split(':')[0], () => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) remote.write(head);
    remote.pipe(socket); socket.pipe(remote);
  });
  sockets.add(remote);
  remote.on('close', () => sockets.delete(remote));
  remote.on('error', () => socket.destroy());
  socket.on('error', () => remote.destroy());
  socket.on('close', () => remote.destroy());
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
const port = proxy.address().port;
const marker = join(gate, 'phase2-ui-rendered-build.json');
const result = { mode: 'build', buildReady: false, phaseAccepted: false, root, node: process.version,
  source, output: out, env, commands: join(out, 'commands.json'), priorBuildId: readFileSync('.next/BUILD_ID', 'utf8').trim() };
save(marker, result);
save(join(out, 'inputs.json'), result);
try {
  rmSync(join(root, '.next'), { recursive: true, force: true });
  const policy = `${offline}
    (allow network-bind (local ip "localhost:*"))
    (allow network-inbound (local ip "localhost:*"))
    (allow network-outbound (remote ip "localhost:${port}"))
    (allow file-write* (subpath "${root}/.next") (literal "${root}/next-env.d.ts"))`;
  const proxyURL = `http://127.0.0.1:${port}`;
  await run('webpack-build', ['node_modules/next/dist/bin/next', 'build'], policy, { HTTPS_PROXY: proxyURL, HTTP_PROXY: proxyURL });
  await run('types', ['node_modules/typescript/bin/tsc', '--noEmit', '--incremental', 'false', '--pretty', 'false']);
  await run('lint', ['node_modules/eslint/bin/eslint.js', 'app/profile', 'lib/profile-drafts.ts',
    'lib/profile-drafts.test.ts', 'tests/profile-ui', 'playwright.profile.config.ts', '--max-warnings=0']);
  await run('draft-tests', ['node_modules/vitest/vitest.mjs', 'run', 'lib/profile-drafts.test.ts', '--maxWorkers=1',
    '--reporter=default', '--reporter=json', `--outputFile=${join(out, 'draft-tests.json')}`]);
  await run('validator', ['tests/profile-ui/validate-report.mjs', '--self-test']);
  assert.deepEqual(sourceState(), source, 'Source changed during build/checks');
  assert.equal(existsSync(env.WORKIE_DB), false);
  result.buildId = readFileSync(join(root, '.next/BUILD_ID'), 'utf8').trim();
  result.buildManifestHash = hash(readFileSync(join(root, '.next/server/app-paths-manifest.json')));
  result.buildReady = true;
} catch (error) {
  result.error = error.message;
  process.exitCode = 1;
} finally {
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => proxy.close(resolve));
  const listener = spawnSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { env: {}, encoding: 'utf8' });
  result.cleanup = { proxyStopped: true, portHasNoListener: listener.status === 1 && listener.stdout === '',
    corpusNotCreated: !existsSync(env.WORKIE_DB) };
  rmSync(scratch, { recursive: true, force: true });
  result.cleanup.scratchRemoved = !existsSync(scratch);
  if (!Object.values(result.cleanup).every(Boolean)) { result.buildReady = false; process.exitCode = 1; }
  save(join(out, 'font-network.json'), { allowedHosts: ['fonts.googleapis.com', 'fonts.gstatic.com'], requests, port, ...result.cleanup });
  save(join(out, 'summary.json'), result);
  save(marker, result);
  console.log(JSON.stringify({ output: out, buildReady: result.buildReady, buildId: result.buildId, cleanup: result.cleanup }));
}
