#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const scratch = join(root, 'logs', 'auto-apply-gate');
const integrationScripts = ['test:worker', 'test:documents', 'test:e2e'];
const baseline = [
  ['npm', ['test', '--', '--passWithNoTests=false']],
  ['npx', ['tsc', '--noEmit']],
  ['npm', ['run', 'lint']],
  ['npm', ['run', 'build']],
  ['git', ['diff', '--check']],
];

function focusedFile(value) {
  const path = resolve(root, value);
  const local = relative(root, path);
  if (value.startsWith('-') || local.startsWith('-') || local.startsWith('..') || isAbsolute(local) ||
      !/\.(test|spec)\.[cm]?[jt]sx?$/.test(local) || !existsSync(path) ||
      !statSync(path).isFile() || relative(root, realpathSync(path)).startsWith('..')) {
    throw new Error(`Not an existing in-worktree test file: ${value}`);
  }
  return local;
}

function commandsFor(args, scripts) {
  if (args.length === 1 && args[0] === 'baseline') return baseline;
  if (args.length === 1 && args[0] === 'full') {
    const missing = integrationScripts.filter((name) => !scripts[name]?.trim());
    if (missing.length) throw new Error(`Missing required npm scripts: ${missing.join(', ')}. Full gate NOT RUN.`);
    return [...baseline, ...integrationScripts.map((name) => ['npm', ['run', name]])];
  }
  if (args[0] === 'phase' && /^(?:[0-9]|1[0-2])$/.test(args[1] ?? '') && args.length > 2) {
    return [
      ['npm', ['test', '--', '--passWithNoTests=false', ...args.slice(2).map(focusedFile)]],
      baseline[1],
      baseline[2],
      baseline[4],
    ];
  }
  throw new Error('Usage: node scripts/auto-apply-gate.mjs baseline | full | phase <0..12> <test-file...> | --self-test');
}

function cleanEnvironment(directory) {
  return {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: join(directory, 'home'),
    TMPDIR: join(directory, 'tmp'),
    CI: '1',
    NEXT_TELEMETRY_DISABLED: '1',
    GIT_OPTIONAL_LOCKS: '0',
    WORKIE_DB: join(directory, 'unconfigured.db'),
    WORKIE_ALLOW_LOCAL_REFRESH: '0',
    npm_config_cache: join(scratch, 'npm-cache'),
    npm_config_userconfig: join(directory, 'user.npmrc'),
    npm_config_globalconfig: join(directory, 'global.npmrc'),
    npm_config_offline: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
  };
}

function passed(result) {
  return result.status === 0 && !result.error;
}

function sandboxPolicy(compilerLoopback = false) {
  // ponytail: compiler loopback is host-wide; qualify isolated fixture ports before adding service tests.
  const loopback = compilerLoopback
    ? '(allow network-bind (local ip "localhost:*")) (allow network-inbound (local ip "localhost:*")) (allow network-outbound (remote ip "localhost:*"))'
    : '';
  return `(version 1) (allow default) (deny network*) ${loopback} (deny file-write*) (allow file-write* (subpath ${JSON.stringify(root)}) (literal "/dev/null"))`;
}

function selfTest() {
  assert.deepEqual(commandsFor(['baseline'], {}), baseline);
  assert.ok(commandsFor(['baseline'], {})[0][1].includes('--passWithNoTests=false'));
  assert.throws(() => commandsFor(['full'], {}), /Missing required npm scripts/);
  assert.throws(() => commandsFor(['phase', '1'], {}), /Usage/);
  assert.throws(() => commandsFor(['phase', '13', 'lib/query.test.ts'], {}), /Usage/);
  assert.throws(() => focusedFile('../outside.test.ts'), /in-worktree/);
  assert.throws(() => focusedFile('--passWithNoTests'), /in-worktree/);
  assert.throws(() => focusedFile('lib/not-implemented.test.ts'), /in-worktree/);
  const optionFile = `--config=${randomUUID()}.test.ts`;
  writeFileSync(join(root, optionFile), '', { flag: 'wx' });
  try {
    assert.throws(() => commandsFor(['phase', '0', `./${optionFile}`], {}), /in-worktree/);
  } finally {
    unlinkSync(join(root, optionFile));
  }
  assert.ok(commandsFor(['phase', '0', 'lib/query.test.ts'], {})[0][1].includes('--passWithNoTests=false'));
  const scripts = Object.fromEntries(integrationScripts.map((name) => [name, 'fixture-check']));
  assert.ok(commandsFor(['full'], scripts)[0][1].includes('--passWithNoTests=false'));
  assert.equal(commandsFor(['full'], scripts).length, baseline.length + integrationScripts.length);
  const env = cleanEnvironment(scratch);
  for (const key of ['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN', 'WORKIE_GMAIL_APP_PASSWORD', 'OPENAI_API_KEY', 'NODE_OPTIONS']) {
    assert.equal(env[key], undefined);
  }
  assert.equal(env.npm_config_offline, 'true');
  const failure = spawnSync(process.execPath, ['-e', 'process.exit(7)'], { cwd: root, env });
  assert.equal(failure.status, 7);
  assert.equal(passed(failure), false);
  assert.equal(passed({ status: null, signal: 'SIGTERM' }), false);
  const probe = `
    const net = require('node:net');
    const assert = require('node:assert/strict');
    const server = net.createServer(socket => socket.end('fixture'));
    server.listen(0, '127.0.0.1', () => {
      const client = net.connect(server.address().port, '127.0.0.1');
      client.on('error', error => { throw error; });
      client.on('data', data => assert.equal(data.toString(), 'fixture'));
      client.on('end', () => server.close(() => {
        const denied = net.connect(443, '192.0.2.1');
        denied.setTimeout(2000, () => { throw new Error('External network denial not enforced'); });
        denied.on('connect', () => { throw new Error('External network unexpectedly allowed'); });
        denied.on('error', error => assert.equal(error.code, 'EPERM'));
      }));
    });
  `;
  const isolation = spawnSync('/usr/bin/sandbox-exec', ['-p', sandboxPolicy(true), process.execPath, '-e', probe], {
    cwd: root, env, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(passed(isolation), true, isolation.stderr || isolation.error?.message);
  console.log('PASS self-test: selection, missing checks, file boundaries, clean env, child failures, compiler loopback and external network denial.');
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--self-test') return selfTest();
  const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts ?? {};
  const commands = commandsFor(args, scripts);
  const unsafeFiles = readdirSync(root).filter((name) => (name.startsWith('.env') && name !== '.env.example') || name === '.npmrc');
  if (unsafeFiles.length) throw new Error(`Refusing local environment/config files: ${unsafeFiles.join(', ')}. Do not load or remove them; use a clean worktree.`);
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) {
    throw new Error('This task-local gate requires macOS sandbox-exec. No unsandboxed fallback.');
  }
  if (!existsSync(join(root, 'node_modules', 'vitest', 'package.json'))) {
    throw new Error('Dependencies missing; run the isolated npm ci documented in docs/auto-apply-workflow.md.');
  }
  mkdirSync(scratch, { recursive: true });
  const run = mkdtempSync(join(scratch, `${args[0]}-`));
  const env = cleanEnvironment(run);
  mkdirSync(env.HOME);
  mkdirSync(env.TMPDIR);
  console.log(`Gate: ${args.join(' ')}\nRoot: ${root}\nLogs: ${run}`);
  console.log('Clean environment; external network denied; build-only compiler loopback; worktree-only writes. Checks run sequentially.');
  const results = [];
  for (const [command, argv] of commands) {
    const label = [command, ...argv].join(' ');
    const scriptName = command === 'npm' ? (argv[0] === 'test' ? 'test' : argv[1]) : undefined;
    console.log(`RUN ${label}${scriptName ? ` [${scripts[scriptName]}]` : ''}`);
    const started = Date.now();
    const result = spawnSync('/usr/bin/sandbox-exec', ['-p', sandboxPolicy(scriptName === 'build'), command, ...argv], {
      cwd: root, env, shell: false, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? `${result.error.message}\n` : ''}`;
    const log = `${results.length + 1}-${command}.log`;
    writeFileSync(join(run, log), output);
    process.stdout.write(output);
    const ok = passed(result);
    results.push({ command: label, ok, exit: result.status, signal: result.signal, log, seconds: (Date.now() - started) / 1000 });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label} (exit=${result.status}, signal=${result.signal ?? 'none'})`);
  }
  writeFileSync(join(run, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  const ok = results.every((result) => result.ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${args[0]} command gate. Independent phase review still required; no commit, push, or release performed.`);
  process.exitCode = ok ? 0 : 1;
}

try {
  main();
} catch (error) {
  console.error(`BLOCKED: ${error.message}`);
  process.exitCode = 1;
}
