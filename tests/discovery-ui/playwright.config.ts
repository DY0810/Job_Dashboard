import { defineConfig } from '@playwright/test';
import { resolve, sep } from 'node:path';

const baseURL = process.env.DISCOVERY_UI_BASE_URL;
const output = process.env.DISCOVERY_UI_OUTPUT_DIR;
if (!baseURL || !/^http:\/\/127\.0\.0\.1:\d+$/.test(baseURL) ||
    !output || !resolve(output).startsWith(`${resolve('logs/auto-apply-gate')}${sep}`)) {
  throw new Error('Use the parent-verified loopback build and a logs/auto-apply-gate output directory.');
}

// Parent owns build freshness, sanitized server, external-network blocking and cleanup.
export default defineConfig({
  testDir: '.', testMatch: '**/*.pw.ts', outputDir: `${output}/test-results`,
  reporter: [['list'], ['json', { outputFile: `${output}/results.json` }]],
  forbidOnly: true, failOnFlakyTests: true, workers: 1, retries: 0, timeout: 30_000,
  use: { baseURL, browserName: 'chromium', serviceWorkers: 'block', trace: 'off', screenshot: 'only-on-failure' },
  projects: ['light', 'dark'].flatMap((colorScheme) => [
    { name: `mobile390-${colorScheme}`, use: { colorScheme: colorScheme as 'light' | 'dark', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: `desktop1440-${colorScheme}`, use: { colorScheme: colorScheme as 'light' | 'dark', viewport: { width: 1440, height: 1000 } } },
  ]),
});
