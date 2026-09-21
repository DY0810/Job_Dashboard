import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projects = ['mobile390', 'desktop1440'];
const cases = [
  'reset survives reload and failure; only success removes the token',
  'reset uses current search params after same-document navigation',
  'expired verification and arbitrary flags do not assert verification',
  'mode changes clear errors, success notices, and credentials',
  'late reset responses cannot replace a different mode or leave stale success',
  "delayed reset success cannot change a newer token's draft",
  "delayed reset success cannot change a newer token's pending",
  "delayed reset error cannot change a newer token's draft",
  "delayed reset error cannot change a newer token's pending",
  'sign-in has keyboard-accessible labels and fits the viewport',
  'sign-up has keyboard-accessible labels and fits the viewport',
  'forgot has keyboard-accessible labels and fits the viewport',
  'verify has keyboard-accessible labels and fits the viewport',
  'reset has keyboard-accessible labels and fits the viewport',
];
const required = projects.flatMap(project => cases.map(title => `${project}::sign-in.pw.ts::${title}`)).sort();

export function validateReport(report) {
  assert.equal(report.config.forbidOnly, true, 'forbidOnly must be enabled');
  assert.deepEqual(report.errors, [], 'No runner errors allowed (including .only)');
  assert.deepEqual(report.config.projects.map(p => p.name).sort(), [...projects].sort(), 'Exact projects required');
  for (const project of report.config.projects) {
    assert.equal(project.retries, 0);
    assert.equal(project.repeatEach, 1);
  }
  const identities = [];
  function visit(suite, parents = []) {
    assert.notEqual(suite.only, true, 'No focused suites');
    for (const spec of suite.specs) {
      assert.notEqual(spec.only, true, 'No focused cases');
      assert.equal(spec.ok, true, 'Every spec must pass');
      for (const test of spec.tests) {
        identities.push(`${test.projectName}::${spec.file}::${[...parents, spec.title].join(' > ')}`);
        assert.equal(test.expectedStatus, 'passed', 'No skipped or expected-failure cases');
        assert.equal(test.status, 'expected', 'No skipped, flaky or unexpected cases');
        assert.equal(test.results.length, 1, 'Exactly one attempt per case');
        const result = test.results[0];
        assert.equal(result.status, 'passed');
        assert.equal(result.retry, 0);
        assert.deepEqual(result.errors, []);
        assert.equal(result.error, undefined);
        for (const annotation of [...test.annotations, ...(result.annotations ?? [])]) {
          assert.ok(!['skip', 'fixme', 'only', 'fail'].includes(annotation.type), 'No skip/fixme/only/fail annotations');
        }
      }
    }
    for (const child of suite.suites ?? []) visit(child, [...parents, child.title]);
  }
  for (const suite of report.suites) visit(suite);
  assert.deepEqual(identities.sort(), required, 'Exact required case identities/counts');
  for (const [name, expected] of Object.entries({ expected: required.length, skipped: 0, flaky: 0, unexpected: 0 })) {
    assert.equal(report.stats[name], expected, `Invalid ${name} count`);
  }
  return { casesPerProject: cases.length, projects, passed: identities.length, identities };
}

function selfTest() {
  const fixture = {
    config: { forbidOnly: true, projects: projects.map(name => ({ name, retries: 0, repeatEach: 1 })) },
    errors: [], stats: { expected: required.length, skipped: 0, flaky: 0, unexpected: 0 },
    suites: [{ specs: cases.map(title => ({
      title, file: 'sign-in.pw.ts', ok: true,
      tests: projects.map(projectName => ({
        projectName, expectedStatus: 'passed', status: 'expected', annotations: [],
        results: [{ status: 'passed', retry: 0, errors: [], annotations: [] }],
      })),
    })) }],
  };
  assert.equal(validateReport(fixture).passed, 28);
  const negatives = {
    skipped: r => { r.suites[0].specs[0].tests[0].expectedStatus = 'skipped'; },
    missing: r => { r.suites[0].specs.pop(); },
    only: r => { r.errors.push({ message: 'test.only forbidden' }); },
    'forbidOnly-disabled': r => { r.config.forbidOnly = false; },
    'focused-spec': r => { r.suites[0].specs[0].only = true; },
    fixme: r => { r.suites[0].specs[0].tests[0].annotations.push({ type: 'fixme' }); },
    flaky: r => { r.suites[0].specs[0].tests[0].status = 'flaky'; },
    unexpected: r => { r.suites[0].specs[0].tests[0].status = 'unexpected'; },
    retry: r => { r.suites[0].specs[0].tests[0].results[0].retry = 1; },
    duplicate: r => { r.suites[0].specs[0].tests.push(r.suites[0].specs[0].tests[0]); },
    'wrong-project': r => { r.config.projects[0].name = 'other'; },
    'wrong-count': r => { r.stats.expected = 20; },
  };
  for (const [name, mutate] of Object.entries(negatives)) {
    const report = structuredClone(fixture);
    mutate(report);
    assert.throws(() => validateReport(report), { name: 'AssertionError' }, `${name} must fail`);
  }

  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  assert.equal(process.cwd(), root);
  const out = mkdtempSync(join(root, 'logs/auto-apply-gate/phase1-harness-'));
  for (const name of ['home', 'tmp']) mkdirSync(join(out, name));
  // Generate a disposable .only fixture; it is never part of the required UI suite.
  writeFileSync(join(out, 'only.pw.ts'),
    "import { test } from '@playwright/test';\ntest.only('forbidden focus', () => { throw Error('Must not execute'); });\n");
  writeFileSync(join(out, 'only.config.ts'),
    `import base from ${JSON.stringify(join(root, 'playwright.auth.config.ts'))};\nexport default { ...base, testDir: ${JSON.stringify(out)} };\n`);
  const env = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: join(out, 'home'), TMPDIR: join(out, 'tmp'), CI: '1',
    AUTH_UI_BASE_URL: 'http://127.0.0.1:1', AUTH_UI_OUTPUT_DIR: out,
  };
  const policy = `(version 1) (allow default) (deny network*) (deny file-write*)
    (allow file-write* (subpath ${JSON.stringify(out)}) (literal "/dev/null"))`;
  const args = ['node_modules/@playwright/test/cli.js', 'test', `--config=${join(out, 'only.config.ts')}`];
  const result = spawnSync('/usr/bin/sandbox-exec', ['-p', policy, process.execPath, ...args],
    { cwd: root, env, encoding: 'utf8', timeout: 30000 });
  writeFileSync(join(out, 'only.log'), `${result.stdout ?? ''}${result.stderr ?? ''}`);
  assert.equal(result.status, 1, 'Real Playwright must reject .only');
  assert.match(`${result.stdout}${result.stderr}`, /forbidOnly|--forbid-only/);
  const report = JSON.parse(readFileSync(join(out, 'results.json'), 'utf8'));
  assert.equal(report.config.forbidOnly, true);
  assert.ok(report.errors.some(e => /only/.test(e.message)));
  assert.throws(() => validateReport(report));
  const proof = { reportNegatives: Object.keys(negatives), realOnlyRejected: true, exitCode: result.status,
    command: [process.execPath, ...args], env, policy, output: out };
  writeFileSync(join(out, 'proof.json'), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--self-test') selfTest();
  else console.log(JSON.stringify(validateReport(JSON.parse(readFileSync(process.argv[2], 'utf8'))), null, 2));
}
