import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('only increases source batch size for an explicit manual catch-up run', () => {
  const workflow = readFileSync('.github/workflows/refresh.yml', 'utf8');
  expect(workflow).toContain("WORKIE_CATCH_UP_PAGES: ${{ inputs.catch_up && '1000' || '100' }}");
});

it.each([
  { ingest: 0, enrich: 0, push: 0, expected: 0, mirrored: true },
  { ingest: 0, enrich: 2, push: 0, expected: 2, mirrored: false },
  { ingest: 0, enrich: 0, push: 1, expected: 1, mirrored: true },
  { ingest: 1, enrich: 0, push: 0, expected: 1, mirrored: true },
])('propagates refresh failure: $ingest/$enrich/$push', (test) => {
  const root = mkdtempSync(join(tmpdir(), 'workie-refresh-test-'));
  try {
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'logs'));
    mkdirSync(join(root, 'bin'));
    copyFileSync('scripts/refresh.sh', join(root, 'scripts/refresh.sh'));
    writeFileSync(join(root, 'logs/.linkcheck-stamp'), '');
    const node = join(root, 'bin/node');
    writeFileSync(node, `#!/bin/sh
case "$1" in
  scripts/ingest.ts) exit ${test.ingest};;
  scripts/enrich.ts) exit ${test.enrich};;
  scripts/push-remote.ts) touch mirrored; exit ${test.push};;
  *) exit 99;;
esac
`);
    chmodSync(node, 0o700);
    const run = spawnSync('bash', ['scripts/refresh.sh'], {
      cwd: root,
      env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, TURSO_DATABASE_URL: 'file:unused.db' },
    });
    expect(run.status).toBe(test.expected);
    if (test.mirrored) expect(readFileSync(join(root, 'mirrored'), 'utf8')).toBe('');
    else expect(() => readFileSync(join(root, 'mirrored'))).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
