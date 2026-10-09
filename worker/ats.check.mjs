import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { BrowserEgressError, createBrowserRuntime } from './browser.ts';
import { greenhouse, hostedFields, hostedTitle } from './ats/greenhouse.ts';
import { fillField, locateField, undergraduateTranscript, verifyField } from './ats/protocol.ts';
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
      return greenhouse.observe({ context, page: () => context.newPage(), navigate: async (page, url) => { await page.goto(redirect ?? url); return page; } },
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
    const observation = await greenhouse.observe({ context, page: () => context.newPage(), navigate: async (page, url) => { await page.goto(url); return page; } },
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
    const runtime = { context, page: () => context.newPage(), navigate: async (page, url) => { await page.goto(url); return page; } };
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
