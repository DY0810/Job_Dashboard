import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { serveStagingFixture } from './ats/greenhouse-fixture.ts';

const BASE = 'https://job-boards.greenhouse.io/workie-staging-fixture';

test('the staging fixture tenant is served locally, never by Greenhouse', { skip: !existsSync(chromium.executablePath()) }, async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    // Anything that slips past the fixture route fails instead of reaching the network (later routes win).
    await context.route('**/*', route => route.abort());
    await serveStagingFixture(context);
    const page = await context.newPage();
    await page.goto(`${BASE}/jobs/4000001`);
    assert.match(await page.title(), /Software Engineering Intern at Fixture Co/);
    await page.goto(`${BASE}/jobs/4000001/confirmation`);
    assert.equal(await page.getAttribute('a', 'href'), '/workie-staging-fixture/jobs/4000001');
    assert.equal(await page.evaluate(async () => (await fetch(location.pathname.replace('/confirmation', '/capture'), { method: 'POST' })).status), 204);
    assert.equal((await page.goto(`${BASE}/other`)).status(), 404);
  } finally {
    await browser.close();
  }
});
