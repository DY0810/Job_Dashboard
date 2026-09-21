import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { BrowserEgressError, createBrowserRuntime } from './browser.ts';
import { ashby } from './ats/ashby.ts';
import { greenhouse } from './ats/greenhouse.ts';
import { createJevActionSelector } from './jev.ts';
import { runAtsApplication } from './application-runner.ts';

const browserReady = existsSync(chromium.executablePath());
const facts = {
  countries: { state: 'confirmed', values: ['US'] }, degreeLevels: { state: 'confirmed', values: ['bachelor'] },
  majors: { state: 'confirmed', values: ['computer science'] }, availableTerms: { state: 'confirmed', values: ['summer 2027'] },
  workAuthorization: { state: 'confirmed', values: ['authorized'] },
  pay: { state: 'confirmed', currency: 'USD', amount: 30, period: 'hour' },
};
const requirements = {
  sourceUrl: 'https://boards.greenhouse.io/fixture/jobs/123', officialDescription: 'US work authorization required.', excerpts: ['US work authorization required.'],
  countries: ['US'], degreeLevels: ['bachelor'], majors: ['computer science'], terms: ['summer 2027'],
  authorizationRequired: true, paid: true, payFloor: { currency: 'USD', amount: 20, period: 'hour' },
};

function pageMarkup(ats, wrongRole = false) {
  const role = wrongRole ? 'Other role' : 'Software Engineering Intern';
  const authorized = ats === 'greenhouse'
    ? '<label>Work authorization<select><option value="Yes">Yes</option><option value="No">No</option></select></label>'
    : '<fieldset><legend>Are you authorized to work?</legend><label><input type="radio" name="authorized" value="Yes">Yes</label><label><input type="radio" name="authorized" value="No">No</label></fieldset>';
  return `<!doctype html><form data-ats="${ats}" data-tenant="fixture" data-requisition="123" data-company="Fixture Co" data-role="${role}">
    <label>First name<input name="firstName"></label><label>Last name<input name="lastName"></label><label>Email<input type="email" name="email"></label>
    ${authorized}<label>Resume<input type="file" name="resume"></label>
    <button type="button">Submit application</button>
    <script>document.querySelector('button').onclick=()=>{document.querySelector('form').insertAdjacentHTML('beforeend', '<div data-receipt="application" data-ats="${ats}" data-tenant="fixture" data-requisition="123" data-company="Fixture Co" data-role="${role}" data-receipt-id="receipt-123" data-submitted-at="1727000000000">Application received</div>')}</script>
  </form>`;
}

async function fixtureServer() {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const ats = url.pathname.includes('ashby') ? 'ashby' : 'greenhouse';
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(pageMarkup(ats, url.searchParams.get('wrong') === '1'));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.equal(typeof address, 'object');
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

function application(origin, ats, query = '') {
  return {
    identity: { ats, tenant: 'fixture', requisition: '123' }, company: 'Fixture Co', role: 'Software Engineering Intern',
    applicationUrl: `${origin}/${ats}${query}`,
    answers: { first_name: 'Test', last_name: 'Applicant', email: 'test@example.com', work_authorization: 'Yes', authorized: 'Yes' },
    documents: {},
  };
}

test('Greenhouse and Ashby fixtures fill an uploaded document and verify exact-role receipts', { skip: !browserReady }, async () => {
  const fixture = await fixtureServer();
  const directory = await mkdtemp(join(tmpdir(), 'workie-ats-'));
  const resume = join(directory, 'resume.pdf');
  await writeFile(resume, '%PDF-1.4 synthetic resume', { mode: 0o600 });
  try {
    for (const [ats, adapter] of [['greenhouse', greenhouse], ['ashby', ashby]]) {
      const runtime = await createBrowserRuntime({ userDataDir: join(directory, ats), approvedOrigins: [fixture.origin], allowLoopback: true });
      const input = application(fixture.origin, ats);
      input.documents.resume = resume;
      const chooseAction = createJevActionSelector({
        evaluate: async () => ({ model: 'jev-1.0.0', answers: { select_action: {
          type: 'choice', choice: 'fill', probabilities: { fill: 1, inspect: 0 }, confidence: 1,
        } }, usage: { input_tokens: 1, output_tokens: 1 } }),
      });
      try {
        const result = await runAtsApplication({ runtime, adapter, application: input, facts, requirements, chooseAction });
        assert.equal(result.state, 'submitted');
        assert.equal(result.receipt.identity.ats, ats);
        assert.equal(result.receipt.identity.requisition, '123');
        assert.equal(result.receipt.role, input.role);
      } finally { await runtime.close(); }
    }
  } finally {
    await new Promise((resolve) => fixture.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('screening and receipt binding refuse ineligible or wrong-role applications', { skip: !browserReady }, async () => {
  const fixture = await fixtureServer();
  const directory = await mkdtemp(join(tmpdir(), 'workie-ats-negative-'));
  const resume = join(directory, 'resume.pdf');
  await writeFile(resume, '%PDF-1.4 synthetic resume', { mode: 0o600 });
  try {
    const blockedRuntime = await createBrowserRuntime({ userDataDir: join(directory, 'blocked'), approvedOrigins: [fixture.origin], allowLoopback: true });
    const ineligible = await runAtsApplication({
      runtime: blockedRuntime,
      adapter: greenhouse, application: application(fixture.origin, 'greenhouse'), facts: { ...facts, countries: { state: 'confirmed', values: ['CA'] } }, requirements,
    });
    assert.equal(ineligible.state, 'skipped');
    await blockedRuntime.close();
    const runtime = await createBrowserRuntime({ userDataDir: join(directory, 'wrong'), approvedOrigins: [fixture.origin], allowLoopback: true });
    const input = application(fixture.origin, 'greenhouse', '?wrong=1'); input.documents.resume = resume;
    try { await assert.rejects(runAtsApplication({ runtime, adapter: greenhouse, application: input, facts, requirements }), /ATS_IDENTITY_MISMATCH/); }
    finally { await runtime.close(); }
  } finally {
    await new Promise((resolve) => fixture.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('submission uses one deterministic intent and an inspect decision cannot fall through to filling', { skip: !browserReady }, async () => {
  const fixture = await fixtureServer();
  const directory = await mkdtemp(join(tmpdir(), 'workie-ats-submit-'));
  const resume = join(directory, 'resume.pdf');
  await writeFile(resume, '%PDF-1.4 synthetic resume', { mode: 0o600 });
  try {
    const runtime = await createBrowserRuntime({ userDataDir: join(directory, 'browser'), approvedOrigins: [fixture.origin], allowLoopback: true });
    const input = application(fixture.origin, 'greenhouse');
    input.documents.resume = resume;
    input.manifestHash = 'a'.repeat(64);
    input.artifactHashes = ['b'.repeat(64)];
    input.submissionIntentId = crypto.randomUUID();
    const calls = [];
    try {
      const result = await runAtsApplication({ runtime, adapter: greenhouse, application: input, facts, requirements,
        submission: {
          begin: async (value) => { calls.push({ kind: 'begin', value }); return { intentId: value.intentId }; },
          receipt: async (value) => { calls.push({ kind: 'receipt', value }); },
        },
      });
      assert.equal(result.state, 'submitted');
      assert.equal(calls[0].value.intentId, input.submissionIntentId);
      assert.equal(calls[1].value.intentId, input.submissionIntentId);
    } finally { await runtime.close(); }
    const inspectRuntime = await createBrowserRuntime({ userDataDir: join(directory, 'inspect-browser'), approvedOrigins: [fixture.origin], allowLoopback: true });
    try {
      const chooseInspect = createJevActionSelector({ evaluate: async () => ({ model: 'jev-1.13.0', answers: { select_action: {
        type: 'choice', choice: 'inspect', probabilities: { fill: 0, inspect: 1 }, confidence: 1,
      } }, usage: { input_tokens: 1, output_tokens: 0 } }) });
      await assert.rejects(runAtsApplication({ runtime: inspectRuntime, adapter: greenhouse, application: input, facts, requirements,
        chooseAction: chooseInspect,
      }), /PROVIDER_INSPECT_SELECTED/);
    } finally { await inspectRuntime.close(); }
  } finally {
    await new Promise((resolve) => fixture.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('persistent browser egress rejects unapproved origins before navigation', { skip: !browserReady }, async () => {
  const fixture = await fixtureServer();
  const directory = await mkdtemp(join(tmpdir(), 'workie-ats-egress-'));
  try {
    const runtime = await createBrowserRuntime({ userDataDir: join(directory, 'browser'), approvedOrigins: [fixture.origin], allowLoopback: true });
    try {
      const page = await runtime.page();
      await assert.rejects(runtime.navigate(page, 'https://example.com/'), (error) => error instanceof BrowserEgressError);
    } finally { await runtime.close(); }
  } finally {
    await new Promise((resolve) => fixture.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
