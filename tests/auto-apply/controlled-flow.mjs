import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { BrowserEgressError, createBrowserRuntime } from '../../worker/browser.ts';
import { runAtsApplication } from '../../worker/application-runner.ts';
import { lever } from '../../worker/ats/lever.ts';
import { jobvite } from '../../worker/ats/jobvite.ts';
import { workday } from '../../worker/ats/workday.ts';
import { oracle } from '../../worker/ats/oracle.ts';
import { icims } from '../../worker/ats/icims.ts';

const browserReady = existsSync(chromium.executablePath());
const facts = {
  countries: { state: 'confirmed', values: ['US'] }, degreeLevels: { state: 'confirmed', values: ['bachelor'] },
  majors: { state: 'confirmed', values: ['computer science'] }, availableTerms: { state: 'confirmed', values: ['summer 2027'] },
  expectedGraduation: { state: 'confirmed', month: '2028-12' },
  workAuthorization: { state: 'confirmed', values: ['authorized'] },
  pay: { state: 'unknown', currency: null, amount: null, period: null },
};
const requirements = {
  sourceUrl: 'https://fixture.example/jobs/123', officialDescription: 'Synthetic paid US role.',
  excerpts: ['Synthetic paid US role.'], countries: ['US'], degreeLevels: ['bachelor'], majors: ['computer science'],
  terms: ['summer 2027'], authorizationRequired: true, paid: true,
  graduationWindow: null,
  payFloor: { currency: 'USD', amount: 20, period: 'hour' },
};
const choices = {
  work_authorization: ['Yes', 'No'], degree_status: ['In progress', 'Completed'],
  graduation_month: ['May', 'December'], graduation_year: ['2027', '2028'],
};
const adapterCases = [
  ['lever', lever, { first_name: 'Test', last_name: 'Applicant', email: 'test@example.com', work_authorization: 'Yes' }],
  ['jobvite', jobvite, { first_name: 'Test', last_name: 'Applicant', email: 'test@example.com', start_date: '2027-05-17', work_authorization: 'Yes' }],
  ['workday', workday, { first_name: 'Test', last_name: 'Applicant', email: 'test@example.com', graduation_month: 'May', graduation_year: '2027', work_authorization: 'Yes' }],
  ['oracle', oracle, { first_name: 'Test', last_name: 'Applicant', email: 'test@example.com', degree_status: 'In progress', previous_employer: 'Synthetic Co', work_authorization: 'Yes' }],
  ['icims', icims, { first_name: 'Test', last_name: 'Applicant', email: 'test@example.com', work_authorization: 'Yes' }],
];

function fieldMarkup(key, label) {
  if (key === 'resume') return `<label>${label}<input type="file" name="${key}"></label>`;
  if (key === 'start_date') return `<label>${label}<input type="date" name="${key}"></label>`;
  if (choices[key]) return `<label>${label}<select name="${key}">${choices[key].map(value => `<option value="${value}">${value}</option>`).join('')}</select></label>`;
  return `<label>${label}<input name="${key}"></label>`;
}

function pageMarkup(ats, accountRequired = false) {
  const fields = adapterCases.find(([id]) => id === ats)?.[2] ?? {};
  const labels = {
    first_name: 'First name', last_name: 'Last name', email: 'Email', work_authorization: 'Work authorization',
    start_date: 'Available start date', graduation_month: 'Graduation month', graduation_year: 'Graduation year',
    degree_status: 'Degree status', previous_employer: 'Previous employer', resume: 'Resume',
  };
  const fieldHtml = Object.keys(fields).map(key => fieldMarkup(key, labels[key])).join('') + fieldMarkup('resume', 'Resume');
  return `<!doctype html><form data-ats="${ats}" data-tenant="fixture" data-requisition="123" data-company="Fixture Co" data-role="Software Engineering Intern" data-account-required="${accountRequired}">
    ${fieldHtml}<button type="button">Submit application</button>
    <script>document.querySelector('button').onclick=()=>document.querySelector('form').insertAdjacentHTML('beforeend','<div data-receipt="application" data-ats="${ats}" data-tenant="fixture" data-requisition="123" data-company="Fixture Co" data-role="Software Engineering Intern" data-receipt-id="${ats}-receipt-123" data-submitted-at="${Date.now()}">Application received</div>')</script>
  </form>`;
}

async function fixtureServer() {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const ats = url.pathname.split('/').filter(Boolean)[0];
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(pageMarkup(ats, url.searchParams.get('account') === '1'));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

test('five additional ATS adapters complete a synthetic fill, upload, submit and exact receipt', { skip: !browserReady }, async () => {
  const fixture = await fixtureServer();
  const directory = await mkdtemp(join(tmpdir(), 'workie-auto-apply-'));
  const resume = join(directory, 'resume.pdf');
  await writeFile(resume, '%PDF-1.4 synthetic resume', { mode: 0o600 });
  try {
    for (const [ats, adapter, answers] of adapterCases) {
      const runtime = await createBrowserRuntime({ userDataDir: join(directory, ats), approvedOrigins: [fixture.origin], allowLoopback: true });
      try {
        const application = {
          identity: { ats, tenant: 'fixture', requisition: '123' }, company: 'Fixture Co', role: 'Software Engineering Intern',
          applicationUrl: `${fixture.origin}/${ats}`, answers, documents: { resume },
        };
        const result = await runAtsApplication({ runtime, adapter, application, facts, requirements });
        assert.equal(result.state, 'submitted');
        assert.equal(result.receipt.identity.ats, ats);
        assert.equal(result.receipt.role, application.role);
        if (ats === 'jobvite') assert.equal(await runtime.context.pages()[0].locator('[name="start_date"]').inputValue(), '2027-05-17');
        if (ats === 'workday') {
          assert.equal(await runtime.context.pages()[0].locator('[name="graduation_month"]').inputValue(), 'May');
          assert.equal(await runtime.context.pages()[0].locator('[name="graduation_year"]').inputValue(), '2027');
        }
      } finally { await runtime.close(); }
    }
  } finally {
    await new Promise(resolve => fixture.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('iCIMS account creation and unapproved browser egress fail closed', { skip: !browserReady }, async () => {
  const fixture = await fixtureServer();
  const directory = await mkdtemp(join(tmpdir(), 'workie-auto-apply-blocked-'));
  const resume = join(directory, 'resume.pdf');
  await writeFile(resume, '%PDF-1.4 synthetic resume', { mode: 0o600 });
  try {
    const runtime = await createBrowserRuntime({ userDataDir: join(directory, 'icims'), approvedOrigins: [fixture.origin], allowLoopback: true });
    try {
      await assert.rejects(runAtsApplication({
        runtime,
        adapter: icims,
        application: {
          identity: { ats: 'icims', tenant: 'fixture', requisition: '123' }, company: 'Fixture Co', role: 'Software Engineering Intern',
          applicationUrl: `${fixture.origin}/icims?account=1`, answers: adapterCases[4][2], documents: { resume },
        }, facts, requirements,
      }), /ACCOUNT_CREATION_BLOCKED/);
      await assert.rejects(runtime.navigate(await runtime.page(), 'https://example.com/'), error => error instanceof BrowserEgressError);
    } finally { await runtime.close(); }
  } finally {
    await new Promise(resolve => fixture.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
