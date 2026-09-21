import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projects = ['mobile390-light', 'desktop1440-light', 'mobile390-dark', 'desktop1440-dark'];
export const cases = [
  'all nine sections render native fields with responsive labels and keyboard focus',
  'optional states and candidates remain distinct; invalid values are editable',
  'encrypted reload recovery retains failed request ID and newest input',
  'conflict keeps edits, shows server values, and saves only after review',
  'an original retry acknowledgement never replaces a newer server revision',
  'a switch after the client owner check locks the pane before the draft can be written',
  'same-principal reauthentication preserves edits and principal change clears them',
  'an account change during key unlock never reveals the prior profile',
  'saving policy stays disabled; enable accepts its saved version exactly once',
  'private uploads retain input after error and quarantine is not availability',
  'unconfigured storage is actionable and does not clear the selected file',
  'historical policy enable acknowledgement cannot override a newer disabled head',
  ...['enable', 'disable'].map(action => `retried policy ${action} acknowledgement preserves a newer editable draft`),
  ...['enable', 'save'].map(action => `explicit disable cancels uncertain ${action} intent without replaying it`),
  ...['before commit', 'after commit'].map(timing => `disable fences a delayed enable ${timing} and cannot stomp a newer save`),
  'disable retries only its CAS when an older enable commits between head read and disable',
  ...['actions', 'destinations', 'countries'].map(field => `enable rejects a saved policy with empty ${field}`),
  'clearing optional address line 2 saves an empty string while nullable facts clear to null',
  'nullable policy pay floor has a typed clear control and saves null',
  'reversed employment dates show the exact entry error with focus links until corrected',
  'weekly onsite and remote days show the exact section error with keyboard focus links',
  ...['Retry upload', 'Refresh documents'].map(action =>
    `successful PUT and failed list refresh reconcile through ${action} without reusing a consumed grant`),
  'lost PUT acknowledgement reconciles the known document without resending bytes',
  'unknown upload outcome retains the file and waits for its own status before a fresh expired grant',
  'lost grant response retries the same idempotent request before uploading once',
  'consumed rejected upload retires pending intent but retains the selected file',
];
const required = projects.flatMap(project => cases.map(title => `${project}::profile.pw.ts::${title}`)).sort();

export function validateReport(report) {
  assert.equal(report.config.forbidOnly, true, 'forbidOnly is mandatory');
  assert.deepEqual(report.errors, [], 'No runner errors allowed');
  assert.deepEqual(report.config.projects.map(project => project.name).sort(), [...projects].sort());
  for (const project of report.config.projects) {
    assert.equal(project.retries, 0);
    assert.equal(project.repeatEach, 1);
  }
  const identities = [];
  function visit(suite, parents = []) {
    assert.notEqual(suite.only, true);
    for (const spec of suite.specs ?? []) {
      assert.notEqual(spec.only, true);
      assert.equal(spec.ok, true);
      for (const test of spec.tests) {
        identities.push(`${test.projectName}::${spec.file}::${[...parents, spec.title].join(' > ')}`);
        assert.equal(test.expectedStatus, 'passed', 'Expected failures and skips are not passes');
        assert.equal(test.status, 'expected', 'Flaky, skipped or unexpected result');
        assert.equal(test.results.length, 1);
        const result = test.results[0];
        assert.equal(result.status, 'passed');
        assert.equal(result.retry, 0);
        assert.deepEqual(result.errors, []);
        assert.equal(result.error, undefined);
        for (const annotation of [...test.annotations, ...(result.annotations ?? [])]) {
          assert.ok(!['skip', 'fixme', 'only', 'fail'].includes(annotation.type));
        }
      }
    }
    for (const child of suite.suites ?? []) visit(child, [...parents, child.title]);
  }
  for (const suite of report.suites) visit(suite);
  assert.deepEqual(identities.sort(), required, 'Every required case identity must appear exactly once');
  for (const [name, expected] of Object.entries({ expected: required.length, skipped: 0, flaky: 0, unexpected: 0 })) {
    assert.equal(report.stats[name], expected, `Invalid ${name} count`);
  }
  return { casesPerProject: cases.length, projects, passed: identities.length, identities };
}

function selfTest() {
  const fixture = {
    config: { forbidOnly: true, projects: projects.map(name => ({ name, retries: 0, repeatEach: 1 })) },
    errors: [], stats: { expected: required.length, skipped: 0, flaky: 0, unexpected: 0 },
    suites: [{ specs: cases.map(title => ({ title, file: 'profile.pw.ts', ok: true,
      tests: projects.map(projectName => ({ projectName, expectedStatus: 'passed', status: 'expected', annotations: [],
        results: [{ status: 'passed', retry: 0, errors: [] }] })),
    })) }],
  };
  assert.equal(validateReport(fixture).passed, 128);
  const negatives = {
    missing: report => { report.suites[0].specs.pop(); },
    duplicate: report => { report.suites[0].specs.push(report.suites[0].specs[0]); },
    renamed: report => { report.suites[0].specs[0].title = 'Unrelated passing case'; },
    only: report => { report.suites[0].specs[0].only = true; },
    'forbidOnly-disabled': report => { report.config.forbidOnly = false; },
    'wrong-project': report => { report.config.projects[0].name = 'other'; },
    'wrong-count': report => { report.stats.expected--; },
    'runner-error': report => { report.errors.push({ message: 'Runner failed' }); },
    skipped: report => { report.suites[0].specs[0].tests[0].expectedStatus = 'skipped'; },
    flaky: report => { report.suites[0].specs[0].tests[0].status = 'flaky'; },
    failed: report => { report.suites[0].specs[0].tests[0].results[0].status = 'failed'; },
    retry: report => { report.suites[0].specs[0].tests[0].results[0].retry = 1; },
    fixme: report => { report.suites[0].specs[0].tests[0].annotations.push({ type: 'fixme' }); },
  };
  for (const [name, mutate] of Object.entries(negatives)) {
    const report = structuredClone(fixture);
    mutate(report);
    assert.throws(() => validateReport(report), { name: 'AssertionError' }, name);
  }
  console.log(JSON.stringify({ passed: true, identities: required.length, negativeChecks: Object.keys(negatives) }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--self-test') selfTest();
  else console.log(JSON.stringify(validateReport(JSON.parse(readFileSync(process.argv[2], 'utf8'))), null, 2));
}
