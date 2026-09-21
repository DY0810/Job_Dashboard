import { defineConfig } from '@playwright/test';
import { resolve, sep } from 'node:path';

const baseURL = process.env.AUTH_UI_BASE_URL;
const output = process.env.AUTH_UI_OUTPUT_DIR;
if (!baseURL || !/^http:\/\/127\.0\.0\.1:\d+$/.test(baseURL) ||
    !output || !resolve(output).startsWith(`${resolve('logs/auto-apply-gate')}${sep}`)) {
  throw new Error('Run node tests/auth-ui/run.mjs against a completed local build.');
}

export default defineConfig({
  testDir: './tests/auth-ui',
  testMatch: '**/*.pw.ts',
  outputDir: `${output}/test-results`,
  reporter: [
    ['list'],
    ['json', { outputFile: `${output}/results.json` }],
  ],
  forbidOnly: true,
  failOnFlakyTests: true,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  use: {
    baseURL,
    browserName: 'chromium',
    serviceWorkers: 'block',
    trace: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'mobile390', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: 'desktop1440', use: { viewport: { width: 1440, height: 1000 } } },
  ],
});
