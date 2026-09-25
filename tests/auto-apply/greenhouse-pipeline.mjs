import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { chromium } from 'playwright';
import { createBrowserRuntime } from '../../worker/browser.ts';
import { createStageDispatch } from '../../worker/main.ts';
import { createJevActionSelector } from '../../worker/jev.ts';
import { artifactManifestHash } from '../../lib/applications/artifact-protocol.ts';
import { postingContacts } from '../../worker/outreach.ts';

// Drives the real worker stage dispatch (screening -> tailoring -> filling -> submit) against a
// Greenhouse-shaped hosted form, with a fake control plane and a deterministic writer model.
const browserReady = existsSync(chromium.executablePath());
const toolsReady = spawnSync('pdftotext', ['-v'], { stdio: 'ignore' }).status === 0;
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const JOB = '/fixtureco/jobs/4000001';
const URL_BASE = 'https://job-boards.greenhouse.io';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const ORIGINAL = 'Built REST APIs in TypeScript for a scheduling product used by students';
const TAILORED = 'Built TypeScript REST APIs with CI tests for a student scheduling app';
const NARRATIVE = 'Fixture Co builds tools students rely on, and I want to make them faster.';
const JD = 'Fixture Co is hiring a Software Engineering Intern to build TypeScript APIs, write CI tests and improve reliability. ' +
  'Questions? Email university-recruiting@fixtureco.com or see https://www.fixtureco.com/careers and https://www.eeoc.gov/poster.';

function masterDocx() {
  const paragraphs = ['Test Applicant', ORIGINAL, 'Reduced dashboard query time by 95 percent with indexed joins', 'Skills: TypeScript, PostgreSQL, React'];
  return Buffer.from(zipSync({
    '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': strToU8(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${
      paragraphs.map(text => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`),
  }));
}

const combobox = (id, label) => `<label id="${id}-label" for="${id}">${label}*</label>
  <div class="select__control"><div class="select__single-value"></div><input id="${id}" name="${id}" role="combobox" aria-required="true"></div>`;
const text = (id, label, required = true, tag = 'input') => `<label id="${id}-label" for="${id}">${label}${required ? '*' : ''}</label>
  <${tag} id="${id}" name="${id}" ${required ? 'aria-required="true"' : ''}>${tag === 'textarea' ? '</textarea>' : ''}`;
const FORM = `<!doctype html><title>Job Application for Software Engineering Intern at Fixture Co</title>
<form id="application-form">
  ${text('first_name', 'First Name')}${text('last_name', 'Last Name')}${text('email', 'Email')}${text('phone', 'Phone', false)}
  <label id="resume-label" for="resume">Resume/CV*</label><input id="resume" name="resume" type="file">
  <label id="cover_letter-label" for="cover_letter">Cover Letter</label><input id="cover_letter" name="cover_letter" type="file">
  ${text('question_101', 'LinkedIn Profile')}
  ${combobox('question_102', 'Are you legally authorized to work in the country for which you are applying?')}
  ${combobox('question_103', 'Will you now or in the future require sponsorship for employment visa status (e.g., H-1B visa)?')}
  ${text('question_104', 'Why are you interested in Fixture Co?', true, 'textarea')}
  <button type="button" id="submit">Submit application</button>
</form>
<script>
for (const input of document.querySelectorAll('input[role="combobox"]')) input.addEventListener('input', () => {
  document.querySelectorAll('[role="listbox"]').forEach(node => node.remove());
  const list = document.createElement('div'); list.setAttribute('role', 'listbox');
  for (const option of ['Yes', 'No']) {
    const item = document.createElement('div'); item.setAttribute('role', 'option'); item.textContent = option;
    item.onclick = () => { input.closest('.select__control').querySelector('.select__single-value').textContent = option; input.value = ''; list.remove(); };
    list.append(item);
  }
  input.closest('.select__control').after(list);
});
document.getElementById('submit').onclick = async () => {
  const base64 = async file => { let out = ''; for (const byte of new Uint8Array(await file.arrayBuffer())) out += String.fromCharCode(byte); return btoa(out); };
  const files = {}, fields = {};
  for (const input of document.querySelectorAll('input[type=file]')) if (input.files.length) files[input.id] = { name: input.files[0].name, base64: await base64(input.files[0]) };
  for (const input of document.querySelectorAll('#application-form input:not([type=file]), #application-form textarea')) {
    fields[input.id] = input.getAttribute('role') === 'combobox' ? input.closest('.select__control').textContent.trim() : input.value;
  }
  await fetch(location.pathname + '/capture', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fields, files }) });
  location.assign(location.pathname + '/confirmation');
};
</script>`;
const CONFIRMATION = `<!doctype html><title>Thank you</title><h1>Thank you for applying.</h1>
<p>Your application has been received.</p><a href="${JOB}">Back to job post</a>`;

test('Greenhouse pipeline tailors the resume, asks only the new question, writes a cover letter and stores the exact receipt',
  { skip: !browserReady || !toolsReady }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'workie-pipeline-'));
    const applicationId = randomUUID(), runId = randomUUID(), master = masterDocx();
    const masterRef = { documentId: randomUUID(), version: 1, sha256: sha256(master), size: master.length, mime: DOCX, path: '/master' };
    const stored = new Map([[masterRef.documentId, master]]);
    const calls = { tailor: [], letter: [], jev: 0, intents: [], submission: null, receipt: null, captured: null, outreach: [] };
    const context = {
      protocolVersion: 1, applicationId, runId, ownerId: 'owner', policyRevision: 1, profileRevision: 1,
      identity: { ats: 'greenhouse', tenant: 'fixtureco', requisition: '4000001' }, company: 'Fixture Co', role: 'Software Engineering Intern',
      coverLetterAllowed: true, outreach: true, applicationUrl: `${URL_BASE}${JOB}`,
      facts: {
        countries: { state: 'confirmed', values: ['US'] }, degreeLevels: { state: 'confirmed', values: ['bachelor'] },
        majors: { state: 'confirmed', values: ['computer science'] }, availableTerms: { state: 'confirmed', values: ['summer 2027'] },
        expectedGraduation: { state: 'confirmed', month: '2028-12' }, workAuthorization: { state: 'confirmed', values: ['authorized'] },
        pay: { state: 'unknown', currency: null, amount: null, period: null },
      },
      requirements: {
        sourceUrl: `${URL_BASE}${JOB}`, officialDescription: JD, excerpts: [JD], countries: ['US'], degreeLevels: [], majors: [],
        terms: [], authorizationRequired: true, paid: true, graduationWindow: null, payFloor: null,
      },
      // What the server derives from confirmed profile facts (see applicationAnswers).
      answers: { first_name: 'Test', last_name: 'Applicant', email: 'test@example.com', linkedin: 'https://linkedin.com/in/test',
        us_authorized: 'Yes', posting_authorized: 'Yes', us_sponsorship_ever: 'No', posting_sponsorship_ever: 'No' },
      documents: { resumeMaster: masterRef, resume: masterRef }, tailoredArtifact: null, manifestHash: null, artifactHashes: [], createdAt: Date.now(),
    };
    let intent;
    const control = {
      applicationContext: async () => structuredClone(context),
      downloadDocument: async (_application, documentId) => stored.get(documentId),
      artifactIntent: async (_application, body) => { intent = body; calls.intents.push(body); return { artifactId: randomUUID(), uploadPath: '/upload' }; },
      uploadArtifact: async (_application, _artifact, _path, _header, bytes, mime) => {
        // Mirrors the server: the verified artifact becomes the application's resume.
        const documentId = randomUUID(), hash = sha256(bytes), manifestHash = artifactManifestHash(intent.manifest);
        stored.set(documentId, Buffer.from(bytes));
        context.documents.resume = { documentId, version: 1, sha256: hash, size: bytes.length, mime, path: '/tailored' };
        context.tailoredArtifact = { documentId, version: 1, sourceDocumentId: masterRef.documentId, sourceVersion: 1,
          sourceHash: masterRef.sha256, verificationManifestHash: manifestHash, outputHash: hash };
        context.manifestHash = manifestHash; context.artifactHashes = [hash];
      },
      submissionIntent: async (_application, body) => { calls.submission = body; return { intentId: body.intentId }; },
      receipt: async (_application, body) => { calls.receipt = body; return {}; },
      outreach: async (_application, body) => { calls.outreach.push({ body, afterReceipt: calls.receipt !== null }); return {}; },
      letter: async (_application, body) => { calls.storedLetter = { body, afterReceipt: calls.receipt !== null }; return { applicationId, stored: true }; },
    };
    const usage = { input_tokens: 1, output_tokens: 1 };
    const generate = async (input) => {
      if (input.task === 'tailor') {
        calls.tailor.push(input);
        const anchor = input.anchors.find(item => item.text === ORIGINAL);
        return { task: 'tailor', edits: [{ anchorId: anchor.id, replacement: TAILORED, evidenceIds: [input.evidence[0].id] }], confidence: 0.9, model: 'fixture', usage };
      }
      calls.letter.push(input);
      const cite = [input.evidence[0].id];
      return { task: 'cover_letter', introduction: `I am applying for the ${input.role} role at ${input.company}.`,
        body: [{ text: 'I built TypeScript REST APIs for a scheduling product used by students.', evidenceIds: cite },
          { text: 'I reduced dashboard query time by 95 percent with indexed joins.', evidenceIds: cite }],
        conclusion: 'Thank you for considering my application.', companyParagraph: `${input.company} builds tools that students rely on every day.`,
        confidence: 0.9, model: 'fixture', usage };
    };
    // A model that would park the form if it were ever asked.
    const chooseAction = createJevActionSelector({ evaluate: async () => { calls.jev += 1; return { model: 'jev', usage,
      answers: { select_action: { type: 'choice', choice: 'inspect', probabilities: { fill: 0, inspect: 1 }, confidence: 1 } } }; } });
    const browser = async (options) => {
      const runtime = await createBrowserRuntime(options);
      await runtime.context.route(`${URL_BASE}/**`, async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === JOB) return route.fulfill({ contentType: 'text/html', body: FORM });
        if (path === `${JOB}/confirmation`) return route.fulfill({ contentType: 'text/html', body: CONFIRMATION });
        if (path === `${JOB}/capture`) { calls.captured = JSON.parse(route.request().postData()); return route.fulfill({ status: 204 }); }
        return route.fulfill({ status: 404, body: '' });
      });
      // The fixture replaces the network, so skip the DNS-backed public-host check for this one origin.
      return { ...runtime, navigate: async (page, url) => { await page.goto(url, { waitUntil: 'domcontentloaded' }); return page; } };
    };
    const signal = new AbortController().signal;
    const dispatch = createStageDispatch(control, directory, signal, browser);
    const stage = (state) => dispatch({ applicationId, runId, fence: 1, revision: 1, state, checkpoint: null },
      { check() {} }, { signal, generate, chooseAction });
    try {
      assert.deepEqual(await stage('screening'), { state: 'tailoring', reasonCode: 'screened' });

      assert.deepEqual(await stage('tailoring'), { state: 'filling', reasonCode: 'artifact_verified', evidence: { artifactVerified: true } });
      assert.equal(calls.tailor[0].jobSummary, JD, 'tailoring is driven by this posting');
      const tailored = strFromU8(unzipSync(stored.get(context.documents.resume.documentId))['word/document.xml']);
      assert.ok(tailored.includes(TAILORED) && !tailored.includes(ORIGINAL));

      // Only the role-specific narrative is new; profile facts answer LinkedIn, authorization and sponsorship.
      const asked = await stage('filling');
      assert.equal(asked.kind, 'questions');
      assert.deepEqual(asked.questions.map(item => item.originalWording), ['Why are you interested in Fixture Co?']);
      context.answers[asked.questions[0].key] = NARRATIVE; // the inbox answer, as the server returns it

      assert.deepEqual(await stage('filling'), { state: 'ready', reasonCode: 'form_verified', evidence: { formVerified: true } });
      assert.deepEqual(await stage('ready'), { state: 'submitted', reasonCode: 'exact_role_receipt', durable: true });

      assert.equal(calls.jev, 0, 'a fully answered form is filled without a fill/inspect model call');
      assert.equal(calls.receipt.intentId, applicationId);
      assert.deepEqual(calls.receipt.identity, context.identity);
      assert.equal(calls.receipt.evidence.pageUrl, `${URL_BASE}${JOB}/confirmation`);
      const { fields, files } = calls.captured;
      assert.deepEqual(fields, { first_name: 'Test', last_name: 'Applicant', email: 'test@example.com', phone: '',
        question_101: 'https://linkedin.com/in/test', question_102: 'Yes', question_103: 'No', question_104: NARRATIVE });
      assert.equal(sha256(Buffer.from(files.resume.base64, 'base64')), context.tailoredArtifact.outputHash, 'the tailored resume is the one submitted');
      assert.equal(calls.letter.at(-1).jobSummary, JD);
      const letterPath = join(directory, 'letter.pdf');
      await writeFile(letterPath, Buffer.from(files.cover_letter.base64, 'base64'));
      const letter = spawnSync('pdftotext', [letterPath, '-'], { encoding: 'utf8' }).stdout;
      assert.match(letter, /Software Engineering Intern role at Fixture Co/);
      assert.match(letter, /Sincerely,\s+Test Applicant/);

      // The exact letter that went out is kept for the Applications page.
      assert.deepEqual(calls.storedLetter, { afterReceipt: true, body: { protocolVersion: 1,
        introduction: 'I am applying for the Software Engineering Intern role at Fixture Co.',
        body: ['I built TypeScript REST APIs for a scheduling product used by students.', 'I reduced dashboard query time by 95 percent with indexed joins.'],
        conclusion: 'Thank you for considering my application.', companyParagraph: 'Fixture Co builds tools that students rely on every day.' } });

      // After the verified receipt, one recruiter note built from the submitted letter goes to the server.
      assert.equal(calls.outreach.length, 1);
      const [{ body: note, afterReceipt }] = calls.outreach;
      assert.equal(afterReceipt, true);
      assert.equal(note.subject, 'Following up on my Software Engineering Intern application');
      assert.deepEqual(note.body.split('\n\n'), [
        'I just applied for the Software Engineering Intern role at Fixture Co and wanted to reach out directly.',
        'I built TypeScript REST APIs for a scheduling product used by students.',
        'Fixture Co builds tools that students rely on every day.',
        'Would you be open to a quick 15-minute call about the role or the team? If someone else is handling this position, I would appreciate it if you could point me in the right direction.',
        'Thank you,\nTest Applicant\nhttps://linkedin.com/in/test',
      ]);
      assert.deepEqual({ emails: note.emails, domains: note.domains }, { emails: ['university-recruiting@fixtureco.com'], domains: ['fixtureco.com'] });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

test('posting contacts keep recruiting inboxes and employer domains only', () => {
  assert.deepEqual(postingContacts('Email accommodations@acme.io, no-reply-careers@acme.io or Talent@Acme.io. Apply via ' +
    'https://boards.greenhouse.io/acme and read https://acme.io/privacy, https://www.dol.gov/agencies and https://linkedin.com/company/acme.'),
  { emails: ['talent@acme.io'], domains: ['acme.io'] });
});
