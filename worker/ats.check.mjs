import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { BrowserEgressError, createBrowserRuntime, openApplicationTab } from './browser.ts';
import { greenhouse, hostedFields, hostedTitle } from './ats/greenhouse.ts';
import { lever, matchOption } from './ats/lever.ts';
import { fillField, formQuestionKey as leverQuestionKey, locateField, undergraduateTranscript, verifyField } from './ats/protocol.ts';
import { fillAtsApplication, runAtsApplication } from './application-runner.ts';
import { AtsIdentitySchema, AtsObservationSchema } from './ats/protocol.ts';
import { resolveApplicationIdentity } from '../lib/applications/application-identity.ts';
import { formQuestions } from './screening.ts';

const browserReady = existsSync(chromium.executablePath());
test('hosted fields resolve their exact ID when visible labels collide', { skip: !browserReady }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<label for="other">Attach</label><input id="other"><label for="resume">Attach</label><input id="resume" type="file">');
    assert.equal(await (await locateField(page, { key: 'resume', label: 'Attach', kind: 'file', required: true })).getAttribute('id'), 'resume');
  } finally { await browser.close(); }
});
test('a hosted upload marked required only by its label asterisk is required', { skip: !browserReady }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    // Verkada's live markup: the input carries no required attribute; only the upload label's asterisk says so.
    await page.setContent('<form id="application-form">' +
      '<div id="upload-label-question_1">Undergraduate Transcript<span class="required">*</span></div><input id="question_1" type="file">' +
      '<div id="upload-label-question_2">Graduate Transcript</div><input id="question_2" type="file"></form>');
    const fields = await hostedFields(page.locator('form'));
    assert.deepEqual(fields.map(field => [field.key, field.label, field.required]),
      [['question_1', 'Undergraduate Transcript', true], ['question_2', 'Graduate Transcript', false]]);
  } finally { await browser.close(); }
});
test('the applicant transcript fits an undergraduate or plain transcript upload, never a graduate one', () => {
  for (const label of ['Undergraduate Transcript', 'Transcript', 'Unofficial Transcript']) assert.equal(undergraduateTranscript(label), true, label);
  for (const label of ['Graduate Transcript', 'Resume/CV', 'Cover Letter']) assert.equal(undergraduateTranscript(label), false, label);
});
test('every identity the server derives parses on the worker, including hostname tenants', () => {
  for (const url of ['https://acme.wd5.myworkdayjobs.com/en-US/External/job/Software-Intern_R12345',
    'https://abc.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/12345',
    'https://careers-acme.icims.com/jobs/1234/job', 'https://jobs.eu.lever.co/acme/0b2c3d4e-1111-4222-8333-944455566677',
    'https://job-boards.greenhouse.io/figma/jobs/6143238004']) {
    const { identity } = resolveApplicationIdentity(url, []);
    assert.ok(identity, url);
    assert.deepEqual(AtsIdentitySchema.parse(identity), identity, url);
  }
});
test('a role title with a double space matches the page title the browser collapses', { skip: !browserReady }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const role = 'Software Engineering Intern, Product & Developer Productivity  (Summer 2027)';
    await page.setContent(`<title>Job Application for ${role.replace('&', '&amp;')} at HP IQ</title>`);
    assert.equal(await page.title(), hostedTitle(role, 'HP IQ'));
  } finally { await browser.close(); }
});
test('a renamed Greenhouse board passes on the exact role and job URL; a wrong role or job URL still fails', { skip: !browserReady }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const role = 'Spring 2027 Software Engineering Internship/Co-op', job = 'https://job-boards.greenhouse.io/xai/jobs/5252108007';
    // Seen live on 2026-10-05: xAI's board now titles its pages "at SpaceXAI".
    const observe = (title, redirect) => {
      context.route(redirect ?? job, route => route.fulfill({ contentType: 'text/html',
        body: `<title>${title}</title><form id="application-form"><label for="first_name">First name</label><input id="first_name"></form>` }), { times: 1 });
      return greenhouse.observe({ context, page: async () => context.pages()[0] ?? context.newPage(), navigate: async (page, url) => { await page.goto(redirect ?? url); return page; } },
        { identity: { ats: 'greenhouse', tenant: 'xai', requisition: '5252108007' }, company: 'xAI', role, applicationUrl: job });
    };
    const observation = await observe(`Job Application for ${role} at SpaceXAI`);
    assert.deepEqual([observation.company, observation.role, observation.fields.map(field => field.key)], ['xAI', role, ['first_name']]);
    await assert.rejects(observe(`Job Application for Other Internship at SpaceXAI`), /ATS_IDENTITY_MISMATCH/);
    await assert.rejects(observe(`Job Application for ${role} at Night at SpaceXAI`), /ATS_IDENTITY_MISMATCH/);
    await assert.rejects(observe(`Job Application for ${role} at SpaceXAI`, 'https://job-boards.greenhouse.io/xai/jobs/1'), /ATS_IDENTITY_MISMATCH/);
  } finally { await browser.close(); }
});
test('an unanswered required Greenhouse dropdown reaches the inbox as a choice of the options its menu lists', { skip: !browserReady }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const role = 'Software Engineering Intern', job = 'https://job-boards.greenhouse.io/riotgamesup/jobs/8222015';
    // Riot's live form (2026-10-05): every choice question, acknowledgements included, is a react-select whose
    // options exist only while its menu is open. The location box is an autocomplete with no menu until typed into.
    await context.route(job, route => route.fulfill({ contentType: 'text/html', body: `<title>Job Application for ${role} at Riot Games</title>
      <form id="application-form">
      <label id="question_1-label" for="question_1">Please select the year you anticipate graduating from your academic program.*</label>
      <div class="select__control"><input id="question_1" role="combobox" aria-required="true"></div>
      <label id="question_2[]-label" for="question_2[]">I acknowledge the Riot Games Candidate Privacy Notice.*</label>
      <div class="select__control"><input id="question_2[]" role="combobox" aria-required="true"></div>
      <label id="candidate-location-label" for="candidate-location">Location (City)*</label>
      <div class="select__control"><input id="candidate-location" role="combobox" aria-required="true"></div>
      <div id="menu"></div></form><script>
      const choices = { question_1: ['2028', '2027', 'Already Graduated'], 'question_2[]': ['Yes'], 'candidate-location': [] };
      const menu = document.getElementById('menu');
      for (const input of document.querySelectorAll('input')) {
        input.addEventListener('click', () => { menu.innerHTML = ''; for (const choice of choices[input.id]) {
          const item = document.createElement('div'); item.setAttribute('role', 'option'); item.textContent = choice; menu.append(item); } });
        input.addEventListener('keydown', event => { if (event.key === 'Escape') menu.innerHTML = ''; });
      }
    </script>` }));
    const observation = await greenhouse.observe({ context, page: async () => context.pages()[0] ?? context.newPage(), navigate: async (page, url) => { await page.goto(url); return page; } },
      { identity: { ats: 'greenhouse', tenant: 'riotgamesup', requisition: '8222015' }, company: 'Riot Games', role, applicationUrl: job, answers: {} });
    assert.deepEqual(observation.fields.map(field => [field.key, field.options]),
      [['question_1', ['2028', '2027', 'Already Graduated']], ['question_2[]', ['Yes']], ['candidate-location', undefined]]);
    const { questions } = formQuestions({ profileRevision: 1, company: 'Riot Games', role, applicationUrl: job, applicationId: crypto.randomUUID(),
      identity: observation.identity }, observation.fields);
    assert.deepEqual(questions.map(question => [question.field.type, question.field.options?.map(option => option.value)]),
      [['select', ['2028', '2027', 'Already Graduated']], ['multiselect', ['Yes']], ['text', undefined]]);
  } finally { await browser.close(); }
});
test('a Riot-like form hydrated after load asks its dropdowns as choices and its multi-select as several, then fills every pick', { skip: !browserReady }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const role = 'Software Engineering Intern - Summer 2027 (Remote)', job = 'https://job-boards.greenhouse.io/riotgamesup/jobs/8222015';
    // Riot's live form (2026-10-06) is server-rendered; React attaches the menus after the load event, so an early click opens nothing.
    await context.route(job, route => route.fulfill({ contentType: 'text/html', body: `<title>Job Application for ${role} at Riot Games</title>
      <form id="application-form">
      <label id="question_1-label" for="question_1">Please indicate your gender.*</label>
      <div class="select__control"><input id="question_1" role="combobox" aria-required="true" aria-expanded="false"></div>
      <label id="question_2[]-label" for="question_2[]">In which language(s) are you business fluent?*</label>
      <div class="select__control"><span id="chips"></span><input id="question_2[]" role="combobox" aria-required="true" aria-expanded="false"></div>
      <div id="menu"></div></form><script>
      const choices = { question_1: ['Male', 'Female', 'Decline to state'], 'question_2[]': ['English', 'French', 'Korean'] };
      const menu = document.getElementById('menu'), chips = document.getElementById('chips');
      addEventListener('load', () => setTimeout(() => { for (const input of document.querySelectorAll('input')) {
        const render = () => { menu.innerHTML = ''; input.setAttribute('aria-expanded', 'true');
          for (const choice of choices[input.id].filter(c => c.toLowerCase().includes(input.value.toLowerCase()))) {
            const item = document.createElement('div'); item.setAttribute('role', 'option'); item.textContent = choice;
            item.addEventListener('click', () => { const chip = document.createElement('div'); chip.className = 'select__multi-value__label';
              chip.textContent = choice; chips.append(chip); input.value = ''; menu.innerHTML = ''; input.setAttribute('aria-expanded', 'false'); });
            menu.append(item); } };
        input.addEventListener('click', render); input.addEventListener('input', render);
        input.addEventListener('keydown', event => { if (event.key === 'Escape') { menu.innerHTML = ''; input.setAttribute('aria-expanded', 'false'); } });
      } }, 1_500));
    </script>` }));
    const runtime = { context, page: async () => context.pages()[0] ?? context.newPage(), navigate: async (page, url) => { await page.goto(url); return page; } };
    const observation = await greenhouse.observe(runtime,
      { identity: { ats: 'greenhouse', tenant: 'riotgamesup', requisition: '8222015' }, company: 'Riot Games', role, applicationUrl: job, answers: {} });
    const { questions } = formQuestions({ profileRevision: 1, company: 'Riot Games', role, applicationUrl: job, applicationId: crypto.randomUUID(),
      identity: observation.identity }, observation.fields);
    assert.deepEqual(questions.map(question => [question.field.type, question.field.options?.map(option => option.value), question.field.maxSelections]),
      [['select', ['Male', 'Female', 'Decline to state'], 1], ['multiselect', ['English', 'French', 'Korean'], 3]]);
    const page = context.pages()[0], languages = observation.fields[1];
    await fillField(page, languages, ['English', 'Korean'], {});
    assert.equal(await verifyField(page, languages, ['English', 'Korean']), true);
    assert.equal(await verifyField(page, languages, ['English']), false);
  } finally { await browser.close(); }
});
test('a dropdown answer the form does not offer fails with every choice the form does offer', { skip: !browserReady }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    // Like a react-select dropdown: typing filters the choices; an empty search lists them all.
    await page.setContent(`<div class="select__control"><input id="school" role="combobox"></div><div id="menu"></div><script>
      const choices = ['University of California, Los Angeles', 'Binghamton University', 'Other'];
      const input = document.getElementById('school'), menu = document.getElementById('menu');
      const render = () => { menu.innerHTML = ''; for (const choice of choices.filter(c => c.toLowerCase().includes(input.value.toLowerCase()))) {
        const item = document.createElement('div'); item.setAttribute('role', 'option'); item.textContent = choice; menu.append(item); } };
      input.addEventListener('input', render); input.addEventListener('click', render);
    </script>`);
    const field = { key: 'school', label: 'Which college or university do you currently attend?', kind: 'combobox', required: true };
    const error = await fillField(page, field, 'UCLA', {}).then(() => null, error => error);
    assert.equal(error?.code, 'ANSWER_OPTION_INVALID');
    assert.deepEqual(error.options, ['University of California, Los Angeles', 'Binghamton University', 'Other']);
  } finally { await browser.close(); }
});
test('a hosted multi-select question (id ending in []) is observed and filled like a single dropdown', { skip: !browserReady }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    // Riot's live markup (2026-10-05): react-select multi input id="question_69351151[]"; a pick becomes a chip and closes the menu.
    await page.setContent(`<form id="application-form"><label id="question_1[]-label" for="question_1[]">In which language(s) are you business fluent?*</label>
      <div class="select__control"><div id="chips"></div><input id="question_1[]" role="combobox" aria-required="true"></div><div id="menu"></div></form><script>
      const choices = ['English', 'French', 'Korean'];
      const input = document.getElementById('question_1[]'), menu = document.getElementById('menu'), chips = document.getElementById('chips');
      const render = () => { menu.innerHTML = ''; for (const choice of choices.filter(c => c.toLowerCase().includes(input.value.toLowerCase()))) {
        const item = document.createElement('div'); item.setAttribute('role', 'option'); item.textContent = choice;
        item.addEventListener('click', () => { const chip = document.createElement('div'); chip.textContent = choice; chips.append(chip); input.value = ''; menu.innerHTML = ''; });
        menu.append(item); } };
      input.addEventListener('input', render); input.addEventListener('click', render);
    </script>`);
    const fields = await hostedFields(page.locator('form'));
    assert.deepEqual(fields, [{ key: 'question_1[]', label: 'In which language(s) are you business fluent?', kind: 'combobox', required: true, options: undefined }]);
    const [field] = AtsObservationSchema.parse({ identity: { ats: 'greenhouse', tenant: 'riotgamesup', requisition: '8222015' },
      company: 'Riot Games', role: 'Intern', fields, actions: ['fill'] }).fields;
    await fillField(page, field, 'English', {});
    assert.equal(await verifyField(page, field, 'English'), true);
    assert.equal(await verifyField(page, field, 'French'), false);
  } finally { await browser.close(); }
});
test('a radio question fills and verifies the exact option the answer names', { skip: !browserReady }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<fieldset><legend>Are you authorized to work?</legend><label><input type="radio" name="authorized" value="Yes">Yes</label>' +
      '<label><input type="radio" name="authorized" value="No">No</label></fieldset>');
    const field = { key: 'authorized', label: 'Are you authorized to work?', kind: 'radio', required: true, name: 'authorized', options: ['Yes', 'No'] };
    await fillField(page, field, 'Yes', {});
    assert.equal(await verifyField(page, field, 'Yes'), true);
    assert.equal(await verifyField(page, field, 'No'), false);
    await assert.rejects(fillField(page, field, 'Maybe', {}), error => error.code === 'ANSWER_OPTION_INVALID');
  } finally { await browser.close(); }
});
test('an uploaded Greenhouse file verifies by the name shown in place of its input', { skip: !browserReady }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    // The live form after a successful upload: no #resume input, only the uploaded file's name.
    await page.setContent('<div role="group" aria-labelledby="upload-label-resume"><div id="upload-label-resume">Resume/CV</div>' +
      '<div class="file-upload__filename"><p>resume.docx</p><button aria-label="Remove file"></button></div></div>');
    const field = { key: 'resume', label: 'Resume/CV', kind: 'file', required: true };
    assert.equal(await verifyField(page, field, undefined, { resume: '/tmp/application-x/resume.docx' }), true);
    assert.equal(await verifyField(page, field, undefined, { resume: '/tmp/application-x/other.docx' }), false);
  } finally { await browser.close(); }
});
const facts = {
  countries: { state: 'confirmed', values: ['US'] }, degreeLevels: { state: 'confirmed', values: ['bachelor'] },
  majors: { state: 'confirmed', values: ['computer science'] }, availableTerms: { state: 'confirmed', values: ['summer 2027'] },
  expectedGraduation: { state: 'confirmed', month: '2028-12' },
  workAuthorization: { state: 'confirmed', values: ['authorized'] },
  pay: { state: 'unknown', currency: null, amount: null, period: null },
};
const requirements = {
  sourceUrl: 'https://boards.greenhouse.io/fixture/jobs/123', officialDescription: 'US work authorization required.', excerpts: ['US work authorization required.'],
  countries: ['US'], degreeLevels: ['bachelor'], majors: ['computer science'], terms: ['summer 2027'],
  graduationWindow: null,
  authorizationRequired: true, paid: true, payFloor: { currency: 'USD', amount: 20, period: 'hour' },
};

test('long official questions retain exact wording and fill without a model choosing the action', async () => {
  const label = 'Export controls: '.repeat(20);
  const observation = AtsObservationSchema.parse({
    identity: { ats: 'greenhouse', tenant: 'fixture', requisition: '123' },
    company: 'Fixture Co', role: 'Software Engineering Intern',
    fields: [{ key: 'question_123', label, kind: 'combobox', required: true }], actions: ['fill', 'inspect'],
  });
  let selected = false;
  const result = await fillAtsApplication({ runtime: {}, adapter: {
    observe: async () => observation,
    fill: async () => { selected = true; },
  }, application: {}, facts, requirements });
  assert.equal(result.state, 'ready');
  assert.equal(selected, true);
  assert.equal(observation.fields[0].label, label.trim());
});

test('a confirmation reached after the worker stopped is still read and handed on to be kept', async () => {
  const controller = new AbortController(), handed = [];
  const page = { url: () => 'https://job-boards.greenhouse.io/fixture/jobs/123/confirmation',
    locator: () => ({ first: () => ({ count: async () => 0 }), innerText: async () => 'Thank you for applying.' }) };
  const receipt = { identity: { ats: 'greenhouse', tenant: 'fixture', requisition: '123' }, company: 'Fixture Co',
    role: 'Software Engineering Intern', receiptId: 'gh-1', submittedAt: Date.now() };
  const result = await runAtsApplication({ runtime: { page: async () => page }, signal: controller.signal, facts, requirements,
    application: { ...application('https://job-boards.greenhouse.io', 'greenhouse'), manifestHash: 'a'.repeat(64),
      artifactHashes: ['b'.repeat(64)], submissionIntentId: crypto.randomUUID() },
    adapter: { observe: async () => ({ fields: [] }), fill: async () => {},
      // The worker stops (a lost heartbeat) while the applicant types the emailed code; then the employer confirms.
      submit: async () => { controller.abort(); },
      receipt: async (_runtime, _input, signal) => { signal?.throwIfAborted(); return receipt; } },
    submission: { begin: async (value) => ({ intentId: value.intentId }),
      receipt: async (value) => { handed.push(value.receipt); throw new Error('STOPPED'); } } });
  assert.deepEqual(handed, [receipt]);
  assert.deepEqual(result, { state: 'submission_unknown', reasons: ['receipt_persistence_failed'], receipt: null, reconciled: false });
});

function pageMarkup(ats, wrongRole = false) {
  const role = wrongRole ? 'Other role' : 'Software Engineering Intern';
  const authorized = '<label>Work authorization<select><option value="Yes">Yes</option><option value="No">No</option></select></label>';
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
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(pageMarkup('greenhouse', url.searchParams.get('wrong') === '1'));
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
    answers: { first_name: 'Test', last_name: 'Applicant', email: 'test@example.com', work_authorization: 'Yes' },
    documents: {},
  };
}

test('the Greenhouse fixture fills an uploaded document and verifies an exact-role receipt', { skip: !browserReady }, async () => {
  const fixture = await fixtureServer();
  const directory = await mkdtemp(join(tmpdir(), 'workie-ats-'));
  const resume = join(directory, 'resume.pdf');
  await writeFile(resume, '%PDF-1.4 synthetic resume', { mode: 0o600 });
  try {
    const runtime = await createBrowserRuntime({ userDataDir: join(directory, 'greenhouse'), approvedOrigins: [fixture.origin], allowLoopback: true });
    const input = application(fixture.origin, 'greenhouse');
    input.documents.resume = resume;
    try {
      const result = await runAtsApplication({ runtime, adapter: greenhouse, application: input, facts, requirements });
      assert.equal(result.state, 'submitted');
      assert.equal(result.receipt.identity.ats, 'greenhouse');
      assert.equal(result.receipt.identity.requisition, '123');
      assert.equal(result.receipt.role, input.role);
    } finally { await runtime.close(); }
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

test('submission uses one deterministic intent', { skip: !browserReady }, async () => {
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
      assert.equal(calls[1].value.evidence.pageUrl, input.applicationUrl);
      assert.equal(calls[1].value.evidence.observedText, 'Application received');
    } finally { await runtime.close(); }
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

// Ashby: the hosted form's own markup (observed on OpenAI, Ramp and Notion postings, 2026-10-12), served on loopback.
const { ashby } = await import('./ats/ashby.ts');
const { formQuestionKey } = await import('./ats/protocol.ts');
const ashbyPosting = '3813977e-5940-456d-bf5a-16efcdc3a6dc';
const ashbyEntry = (path, label, input, required = true) => `<div class="ashby-application-form-field-entry"><label class="ashby-application-form-question-title${required ? ' _required_f7cvd_91' : ''}" for="${path}">${label}</label>${input}</div>`;
const ashbyYesNo = (path) => `<div class="ashby-application-form-input-yesno"><button type="button" aria-pressed="false">Yes</button><button type="button" aria-pressed="false">No</button><input type="checkbox" tabindex="-1" name="${path}"></div>`;
function ashbyMarkup(title) {
  const group = ['Product', 'Infra', 'AI'].map((option, index) => `<div class="ashby-application-form-input-checkbox-group-option"><input type="checkbox" id="g-${index}" name="${option}"><label for="g-${index}" class="ashby-application-form-input-checkbox-group-option-label">${option}</label></div>`).join('');
  return `<!doctype html><title>${title}</title><div class="ashby-application-form-container">
    ${ashbyEntry('_systemfield_name', 'Legal Name', '<input class="ashby-application-form-input-text" name="_systemfield_name" id="_systemfield_name">')}
    ${ashbyEntry('_systemfield_email', 'Email', '<input class="ashby-application-form-input-text" type="email" name="_systemfield_email" id="_systemfield_email">')}
    ${ashbyEntry('_systemfield_resume', 'Resume', '<div class="ashby-application-form-input-file"><input type="file" id="_systemfield_resume"><button>Upload File</button></div>')}
    ${ashbyEntry('09a328e0-8d57-4f88-86ab-688de1657b17', 'What are you most proud of?', '<textarea class="ashby-application-form-input-textarea" name="09a328e0-8d57-4f88-86ab-688de1657b17"></textarea>')}
    ${ashbyEntry('bed95633-1b6e-4cd0-9eaf-c5a9f75ac35d', 'Are you authorized to work lawfully in the United States?', ashbyYesNo('bed95633-1b6e-4cd0-9eaf-c5a9f75ac35d'))}
    ${ashbyEntry('d33e2a8f-3742-4e5e-b91c-b7607d3cdf63', 'Are you able to work from our office three days per week?', ashbyYesNo('d33e2a8f-3742-4e5e-b91c-b7607d3cdf63'))}
    <fieldset class="ashby-application-form-input-checkbox-group"><label class="ashby-application-form-question-title _required_f7cvd_91" for="5f7757f0-b2ee-41b2-b9d0-0212461ed5a2">What type of engineering role are you interested in?</label>${group}</fieldset>
    <button type="button" class="ashby-application-form-submit-button">Submit Application</button></div>
    <script>
      document.querySelectorAll('.ashby-application-form-input-yesno button').forEach(button => button.onclick = () => {
        for (const other of button.parentElement.querySelectorAll('button')) other.setAttribute('aria-pressed', String(other === button));
      });
      document.getElementById('_systemfield_resume').onchange = (event) => event.target.insertAdjacentHTML('afterend',
        '<p class="ashby-application-form-input-file-item-name"><span>' + event.target.files[0].name + '</span></p>');
      document.querySelector('.ashby-application-form-submit-button').onclick = () => { document.querySelector('.ashby-application-form-container').outerHTML =
        '<div class="ashby-application-form-success-container" role="status"><h2>Success</h2><p>Your application was successfully submitted. We\\'ll contact you if there are next steps.</p></div>'; };
    </script>`;
}
async function ashbyFixture(title = 'Product Designer @ Fixture Co') {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(ashbyMarkup(title));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const input = { identity: { ats: 'ashby', tenant: 'fixture', requisition: ashbyPosting }, company: 'Fixture Co', role: 'Product Designer',
    applicationUrl: `${origin}/fixture/${ashbyPosting}`, documents: {},
    answers: { first_name: 'Test', last_name: 'Applicant', email: 'test@example.com', us_authorized: 'Yes' } };
  return { server, origin, input };
}

test('the Ashby fixture is observed, answered from the profile and the inbox, filled, submitted and receipted', { skip: !browserReady }, async () => {
  const { server, origin, input } = await ashbyFixture();
  const directory = await mkdtemp(join(tmpdir(), 'workie-ats-ashby-'));
  input.documents.resume = join(directory, 'resume.pdf');
  await writeFile(input.documents.resume, '%PDF-1.4 synthetic resume', { mode: 0o600 });
  const runtime = await createBrowserRuntime({ userDataDir: join(directory, 'browser'), approvedOrigins: [origin], allowLoopback: true });
  try {
    const observed = await ashby.observe(runtime, input);
    assert.deepEqual(observed.fields.map(({ key, kind, required, options }) => ({ key, kind, required, options })), [
      { key: observed.fields[0].key, kind: 'text', required: true, options: undefined },
      { key: observed.fields[1].key, kind: 'email', required: true, options: undefined },
      { key: 'resume', kind: 'file', required: true, options: undefined },
      { key: observed.fields[3].key, kind: 'text', required: true, options: undefined },
      { key: observed.fields[4].key, kind: 'radio', required: true, options: ['Yes', 'No'] },
      { key: observed.fields[5].key, kind: 'radio', required: true, options: ['Yes', 'No'] },
      { key: observed.fields[6].key, kind: 'select', required: true, options: ['Product', 'Infra', 'AI'] },
    ]);
    assert.match(observed.fields[3].key, /^f-[0-9a-f]{24}$/); // a bare UUID cannot be a key
    assert.match(observed.fields[6].key, /^f-[0-9a-f]{24}\[\]$/);
    const [name, email, , proud, authorized, office, roles] = observed.fields;
    assert.equal(ashby.answer(input, name), 'Test Applicant');
    assert.equal(ashby.answer(input, email), 'test@example.com');
    assert.equal(ashby.answer(input, authorized), 'Yes');
    // Unrecognized questions go to the inbox; their answers come back under the question's own key.
    assert.deepEqual([proud, office, roles].map(field => ashby.answer(input, field)), [undefined, undefined, undefined]);
    input.answers[formQuestionKey(proud)] = 'A payments redesign.';
    input.answers[formQuestionKey(office)] = 'No';
    input.answers[formQuestionKey(roles)] = ['Product', 'AI'];
    const result = await runAtsApplication({ runtime, adapter: ashby, application: input, facts, requirements });
    assert.equal(result.state, 'submitted');
    assert.match(result.receipt.receiptId, /^ab-[0-9a-f]{32}$/);
    assert.equal(result.receipt.identity.requisition, ashbyPosting);
  } finally {
    await runtime.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('an Ashby form for another role is refused, and an unanswered required question stops the fill', { skip: !browserReady }, async () => {
  const wrong = await ashbyFixture('Other role @ Fixture Co');
  const directory = await mkdtemp(join(tmpdir(), 'workie-ats-ashby-negative-'));
  try {
    const runtime = await createBrowserRuntime({ userDataDir: join(directory, 'wrong'), approvedOrigins: [wrong.origin], allowLoopback: true });
    try { await assert.rejects(ashby.observe(runtime, wrong.input), /ATS_IDENTITY_MISMATCH/); }
    finally { await runtime.close(); }
    const right = await ashbyFixture();
    const runtime2 = await createBrowserRuntime({ userDataDir: join(directory, 'right'), approvedOrigins: [right.origin], allowLoopback: true });
    try {
      right.input.documents.resume = join(directory, 'resume.pdf');
      await writeFile(right.input.documents.resume, '%PDF-1.4 synthetic resume', { mode: 0o600 });
      const observed = await ashby.observe(runtime2, right.input);
      await assert.rejects(ashby.fill(runtime2, right.input, observed), (error) => error.code === 'REQUIRED_ANSWER_MISSING' && error.message === observed.fields[3].key);
    } finally {
      await runtime2.close();
      await new Promise((resolve) => right.server.close(resolve));
    }
  } finally {
    await new Promise((resolve) => wrong.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

// Lever's live markup (Palantir, Shield AI, Ro; 2026-10-12): standard inputs by name, custom questions as "cards[<uuid>][fieldN]"
// (a checkbox group shares one name), a location box that accepts only a picked suggestion, and a POST that redirects to /thanks.
const leverJob = 'https://jobs.lever.co/fixture/0b2c3d4e-1111-4222-8333-944455566677';
const leverRole = 'Software Engineer Intern';
const leverForm = (role) => `<title>Fixture Co - ${role}</title><form id="application-form" method="POST" enctype="multipart/form-data"><ul>
  <li class="application-question resume"><label><div class="application-label">Resume/CV <span class="required">✱</span></div><input type="file" name="resume" id="resume-upload-input"></label></li>
  <li class="application-question"><label><div class="application-label">Full name<span class="required">✱</span></div><input type="text" name="name" required></label></li>
  <li class="application-question"><label><div class="application-label">Email<span class="required">✱</span></div><input type="email" name="email" required></label></li>
  <li class="application-question"><label><div class="application-label">Current location <span class="required">✱</span></div><input id="location-input" name="location" required>
    <input id="selected-location" type="hidden" name="selectedLocation"><div class="dropdown-results"></div></label></li>
  <li class="application-question"><label><div class="application-label">LinkedIn URL</div><input type="text" name="urls[LinkedIn]"></label></li>
  <li class="application-question custom-question"><div class="application-label"><div class="text">Language Skill(s) (Check all that apply)<span class="required">✱</span></div></div><ul>
    <li><label><input type="checkbox" name="cards[c1][field0]" value="English" required>English</label></li><li><label><input type="checkbox" name="cards[c1][field0]" value="Korean" required>Korean</label></li>
    <li><label><input type="checkbox" name="cards[c1][field0]" value="French" required>French</label></li></ul></li>
  <li class="application-question custom-question"><div class="application-label"><div class="text">Are you authorized to work in the United States?<span class="required">✱</span></div></div><ul>
    <li><label><input type="radio" name="cards[c1][field1]" value="Yes" required>Yes</label></li><li><label><input type="radio" name="cards[c1][field1]" value="No" required>No</label></li></ul></li>
  <li class="application-question custom-question"><div class="application-label"><div class="text">Why this team?<span class="required">✱</span></div></div><textarea name="cards[c1][field2]" required></textarea></li></ul>
  <div class="application-question"><label><div class="application-label">Gender</div><select name="eeo[gender]"><option value="">Select ...</option><option value="Male">Male</option><option value="Female">Female</option></select></label></div>
  <div class="application-question"><label><div class="application-label">Veteran status</div><select name="eeo[veteran]"><option value="">Select ...</option><option value="I am not a veteran">I am not a veteran</option></select></label></div>
  <input type="hidden" name="cards[c1][baseTemplate]" value="{}"><button type="button" id="btn-submit">Submit application</button></form><script>
  const input = document.getElementById('location-input'), results = document.querySelector('.dropdown-results');
  input.addEventListener('input', () => { results.replaceChildren(); for (const place of ['San Francisco, CA, USA', 'San Francisco, Córdoba, ARG'].filter(p => p.toLowerCase().startsWith(input.value.toLowerCase()))) {
    const item = document.createElement('div'); item.className = 'dropdown-location'; item.textContent = place;
    item.addEventListener('click', () => { input.value = place; document.getElementById('selected-location').value = JSON.stringify({ name: place }); results.replaceChildren(); });
    results.append(item); } });
  document.getElementById('btn-submit').onclick = () => document.querySelector('form').submit();
  </script>`;
async function leverFixture(browser, title = leverRole) {
  const context = await browser.newContext();
  const posted = [];
  await context.route(`${leverJob}/apply`, route => {
    if (route.request().method() !== 'POST') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: leverForm(title) });
    posted.push(route.request().postData() ?? '');
    // Lever answers with a redirect; a fulfilled redirect would leave the routed context, so the fixture navigates itself.
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<script>location.replace('${leverJob}/thanks')</script>` });
  });
  await context.route(`${leverJob}/thanks`, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<title>Fixture Co - ${title}</title>
    <div class="posting-headline"><h2>${title}</h2></div><div class="confirmation-message"><h3 data-qa="msg-submit-success">Application submitted!</h3></div>` }));
  return { posted, runtime: { context, page: async () => context.pages()[0] ?? context.newPage(), navigate: async (page, url) => { await page.goto(url); return page; } } };
}
const leverApplication = (answers = {}) => ({ identity: { ats: 'lever', tenant: 'fixture', requisition: '0b2c3d4e-1111-4222-8333-944455566677' },
  company: 'Fixture Co', role: leverRole, applicationUrl: leverJob, documents: {},
  answers: { first_name: 'Test', last_name: 'Applicant', email: 'test@example.com', current_location: 'San Francisco, CA', us_authorized: 'Yes',
    voluntary_gender: 'Male', voluntary_veteran: 'I am not a protected veteran', ...answers } });

test('a Lever form is observed, answered from the profile, filled, submitted and receipted', { skip: !browserReady }, async () => {
  const browser = await chromium.launch({ headless: true });
  const directory = await mkdtemp(join(tmpdir(), 'workie-lever-'));
  try {
    const resume = join(directory, 'resume.pdf');
    await writeFile(resume, '%PDF-1.4 synthetic resume', { mode: 0o600 });
    const { runtime, posted } = await leverFixture(browser);
    const input = leverApplication();
    input.documents.resume = resume;
    const observation = await lever.observe(runtime, input);
    assert.deepEqual(observation.fields.map(field => [field.name, field.kind, field.required, field.options, field.key.endsWith('[]')]), [
      ['resume', 'file', true, undefined, false], ['name', 'text', true, undefined, false], ['email', 'email', true, undefined, false],
      ['location', 'text', true, undefined, false], ['urls[LinkedIn]', 'text', false, undefined, false],
      ['cards[c1][field0]', 'radio', true, ['English', 'Korean', 'French'], true], ['cards[c1][field1]', 'radio', true, ['Yes', 'No'], false],
      ['cards[c1][field2]', 'text', true, undefined, false], ['eeo[gender]', 'select', false, ['Male', 'Female'], false],
      ['eeo[veteran]', 'select', false, ['I am not a veteran'], false]]);
    // The veteran wording differs from the profile's, so it is left blank rather than guessed.
    assert.deepEqual(observation.fields.map(field => lever.answer(input, field)),
      [undefined, 'Test Applicant', 'test@example.com', 'San Francisco, CA', undefined, undefined, 'Yes', undefined, 'Male', undefined]);
    const [languages, why] = [observation.fields[5], observation.fields[7]];
    // An unanswered required question stops the fill so the worker can ask the applicant.
    await assert.rejects(lever.fill(runtime, input, observation), error => error.code === 'REQUIRED_ANSWER_MISSING' && error.message === languages.key);
    input.answers[leverQuestionKey(languages)] = ['English', 'Korean'];
    input.answers[leverQuestionKey(why)] = 'Because of the fixture.';
    const result = await runAtsApplication({ runtime, adapter: lever, application: input, facts, requirements });
    assert.equal(result.state, 'submitted');
    assert.match(result.receipt.receiptId, /^lv-[0-9a-f]{32}$/);
    assert.deepEqual(result.receipt.identity, input.identity);
    for (const value of ['Test Applicant', 'San Francisco, CA, USA', 'English', 'Korean', 'Because of the fixture.', 'Male', 'filename="resume.pdf"']) assert.ok(posted[0].includes(value), value);
    assert.ok(!posted[0].includes('French') && !posted[0].includes('I am not a veteran'));
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test('a Lever location not among the suggestions asks the applicant to pick one of them', { skip: !browserReady }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const { runtime } = await leverFixture(browser);
    const input = leverApplication({ current_location: 'San Francisco, California' });
    const observation = await lever.observe(runtime, input);
    const location = observation.fields.find(field => field.name === 'location');
    await assert.rejects(lever.fill(runtime, input, { ...observation, fields: [location] }),
      error => error.code === 'ANSWER_OPTION_INVALID' && error.options.join('|') === 'San Francisco, CA, USA|San Francisco, Córdoba, ARG');
  } finally { await browser.close(); }
});
test('a Lever form for another role or posting is an identity mismatch', { skip: !browserReady }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    await assert.rejects(lever.observe((await leverFixture(browser, 'Other Intern')).runtime, leverApplication()), /ATS_IDENTITY_MISMATCH/);
    const { runtime } = await leverFixture(browser);
    await assert.rejects(lever.observe(runtime, { ...leverApplication(), applicationUrl: 'https://jobs.lever.co/fixture/11111111-1111-4111-8111-111111111111/apply' }), /ATS_IDENTITY_MISMATCH/);
    await assert.rejects(lever.observe(runtime, { ...leverApplication(), applicationUrl: 'https://jobs.eu.lever.co/fixture/0b2c3d4e-1111-4222-8333-944455566677' }), /ATS_IDENTITY_MISMATCH/);
  } finally { await browser.close(); }
});

test('applications open as tabs of one window, each reaching only its own origins', { skip: !browserReady }, async () => {
  const listen = () => new Promise(resolve => { const server = createServer((_, response) => response.end('<title>ok</title>'));
    server.listen(0, '127.0.0.1', () => resolve(server)); });
  const [a, b] = await Promise.all([listen(), listen()]);
  const origin = server => `http://127.0.0.1:${server.address().port}`;
  const userDataDir = await mkdtemp(join(tmpdir(), 'workie-tabs-'));
  const open = server => openApplicationTab({ userDataDir, approvedOrigins: [`${origin(server)}/`], allowLoopback: true, headless: true });
  let first;
  try {
    first = await open(a); const second = await open(b);
    const pageA = await first.navigate(await first.page(), `${origin(a)}/`);
    const pageB = await second.navigate(await second.page(), `${origin(b)}/`);
    assert.equal(first.context, second.context, 'one window');
    assert.notEqual(pageA, pageB, 'one tab per application');
    assert.equal(await pageA.evaluate(url => fetch(url).then(() => 'reached', () => 'blocked'), `${origin(b)}/`), 'blocked');
    await second.close();
    assert.ok(pageB.isClosed(), 'a finished application closes its tab');
    await first.close();
    assert.equal(first.context.pages().length, 1, 'the last tab stays so the window stays up');
    const third = await open(a);
    assert.equal(await third.page(), pageA, 'the idle tab is reused');
  } finally {
    await first?.context.close(); a.close(); b.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test('a long Lever list takes the one option a typed name matches', () => {
  const schools = ['Stanford University', 'University of Southern California', 'University of California, Los Angeles', 'Other (School Not Listed)'];
  assert.equal(matchOption(schools, 'Stanford University'), 'Stanford University');
  assert.equal(matchOption(schools, '  stanford  university '), 'Stanford University');
  assert.equal(matchOption(schools, 'Stanford'), 'Stanford University');
  assert.equal(matchOption(schools, 'other'), 'Other (School Not Listed)');
  assert.equal(matchOption(schools, 'University of'), undefined);
  assert.equal(matchOption(schools, ''), undefined);
});
