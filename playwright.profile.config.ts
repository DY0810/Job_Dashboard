import { defineConfig } from '@playwright/test';
import { resolve, sep } from 'node:path';

const baseURL = process.env.PROFILE_UI_BASE_URL;
const output = process.env.PROFILE_UI_OUTPUT_DIR;
if (!baseURL || !/^http:\/\/127\.0\.0\.1:\d+$/.test(baseURL) ||
    !output || !resolve(output).startsWith(`${resolve('logs/auto-apply-gate')}${sep}`)) {
  throw new Error('Use the parent-verified local production build and a logs/auto-apply-gate output directory.');
}
export default defineConfig({
  testDir: './tests/profile-ui', testMatch: '**/*.pw.ts', outputDir: `${output}/test-results`,
  reporter: [['list'], ['json', { outputFile: `${output}/results.json` }]],
  forbidOnly: true, failOnFlakyTests: true, workers: 1, retries: 0, timeout: 45_000,
  use: { baseURL, browserName: 'chromium', serviceWorkers: 'block', trace: 'off', screenshot: 'only-on-failure' },
  projects: ['light', 'dark'].flatMap((colorScheme) => [
    { name: `mobile390-${colorScheme}`, use: { colorScheme: colorScheme as 'light' | 'dark', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: `desktop1440-${colorScheme}`, use: { colorScheme: colorScheme as 'light' | 'dark', viewport: { width: 1440, height: 1000 } } },
  ]),
});
