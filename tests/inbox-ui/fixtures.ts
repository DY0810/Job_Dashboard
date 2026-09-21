import {
  AnswerCommandSchema, AnswerResultSchema, FocusCommandSchema, FocusResultSchema,
  InboxPageSchema, QuestionDetailSchema, ReadCommandSchema, ReviewCommandSchema,
  type QuestionDetail, type QuestionField,
} from '../../lib/applications/question-protocol';
import { EXPECTED_APPLICANT_HEADER } from '../../lib/applications/applicant-precondition';
import { createEmptyProfile } from '../../lib/applications/profile';
import { createEmptyPolicy } from '../../lib/applications/policy';

// Synthetic transport only. These fixtures prove no server resume, identity, upload safety or ATS behavior.
export const ownerA = 'synthetic-inbox-a';
export const ownerB = 'synthetic-inbox-b';
export const id = () => crypto.randomUUID();
export const baseField = { allowBlank: false, declineValue: null, units: null, precision: null };
export function question(field: QuestionField = {
  ...baseField, type: 'text', minLength: 1, maxLength: 300, format: 'plain',
}, kind: QuestionDetail['descriptor']['kind'] = 'needs_answer'): QuestionDetail {
  const applicationId = id();
  return QuestionDetailSchema.parse({
    id: id(), ownerId: ownerA, revision: 1, resolved: false, waitingCount: 2,
    expectedProfileRevision: 0, expectedPolicyRevision: 1, expectedScopeHash: 'a'.repeat(64),
    factVersions: [], allowedReuse: ['application'], canAnswer: true, canBlank: false, canDecline: false, focus: null,
    application: { id: applicationId, workerId: id(), ats: 'synthetic-ats', tenant: 'employer.example.test',
      requisition: 'synthetic-role-001', company: 'Synthetic Employer', role: 'Test Engineer' },
    descriptor: {
      key: 'synthetic-fact', kind, originalWording: 'Which contact address should this employer use?',
      reason: 'Personal and school addresses differ; no employer-specific answer is confirmed.',
      required: !field.allowBlank, meaning: { id: 'contact-address-for-employer', reviewId: null }, schemaVersion: 1,
      scope: { kind: 'application', country: null, employer: null, applicationId, includesSubsidiaries: false,
        timeframe: 'current', validFrom: null, validUntil: null, tenant: 'employer.example.test', ats: 'synthetic-ats', version: 1 },
      provenance: { source: 'user', sourceId: null, sourceVersion: null, excerpt: 'Exact synthetic application context.' },
      field, factIds: [], sensitive: false,
    },
  });
}
export function storage(): Storage {
  const values = new Map<string, string>();
  return { get length() { return values.size; }, key: (i) => [...values.keys()][i] ?? null,
    getItem: (k) => values.get(k) ?? null, setItem: (k, v) => { values.set(k, v); },
    removeItem: (k) => { values.delete(k); }, clear: () => values.clear() };
}
export function fixture(initial = question()) {
  const event = id();
  const state = {
    owner: ownerA, auth: 200, keyVersion: '1', q: initial, read: false, resumes: 0,
    inboxError: false, answerMode: 'ok' as 'ok' | 'lost' | 'offline' | 'conflict',
    writes: [] as { path: string; body: unknown }[], documents: [] as Record<string, unknown>[],
    notifications: false, beforeAnswer: null as null | (() => Promise<void>),
    beforeRead: null as null | (() => Promise<void>),
  };
  const answers = new Map<string, unknown>();
  async function respond(path: string, method = 'GET', body?: unknown, headers = new Headers()) {
    const reply = (json: unknown, status = 200) => ({ json, status });
    if (path === '/api/auth/applicant') return state.auth !== 200 ? reply({ code: 'AUTH_REQUIRED' }, state.auth) :
      reply({ ownerId: state.owner, email: 'synthetic@example.test', name: 'Synthetic' });
    if (headers.get(EXPECTED_APPLICANT_HEADER) !== state.owner) return reply({ code: 'PRINCIPAL_CHANGED' }, 403);
    if (path === '/api/profile/draft-key') return reply({ ownerId: state.owner, keyVersion: state.keyVersion,
      key: btoa((state.keyVersion === '1' ? 's' : 'r').repeat(32)) });
    if (path === '/api/profile') return reply({ ownerId: state.owner, revision: 0, profile: createEmptyProfile() });
    if (path === '/api/auto-apply/policies') return reply({
      revision: 0, policy: createEmptyPolicy(), enabled: false, policyVersion: 0, policyHash: null,
      acceptedPolicyVersion: null, acceptedPolicyHash: null, acceptedAt: null, runnerAvailable: false,
    });
    if (path === '/api/documents') return reply({ documents: state.documents, storage: 'local' });
    if (path.startsWith('/api/inbox?')) {
      if (state.inboxError) return reply({ code: 'UNAVAILABLE' }, 503);
      const mine = state.owner === state.q.ownerId;
      const submitted = { eventId: '00000000-0000-4000-8000-000000000001', applicationId: state.q.application.id,
        kind: 'submitted', createdAt: 1789948800000, read: false, question: null };
      return reply(InboxPageSchema.parse({
        ownerId: state.owner, unread: mine ? Number(!state.read) + Number(state.notifications) : 0,
        unresolved: mine && !state.q.resolved ? 1 : 0, waitingApplications: mine && !state.q.resolved ? 2 : 0,
        serverTime: 1789948800000, nextCursor: null,
        items: mine ? [{ eventId: event, applicationId: state.q.application.id, kind: 'question',
          createdAt: 1789948800000, read: state.read, question: state.q }, ...(state.notifications ? [submitted] : [])] : [],
      }));
    }
    if (path === `/api/questions/${state.q.id}`) return reply(QuestionDetailSchema.parse(state.q));
    if (method === 'POST') {
      state.writes.push({ path, body: structuredClone(body) });
      if (path === '/api/inbox/read') {
        const command = ReadCommandSchema.parse(body);
        await state.beforeRead?.();
        state.read = true;
        return reply({ ownerId: state.owner, eventIds: command.eventIds });
      }
      if (path.endsWith('/answer')) {
        const command = AnswerCommandSchema.parse(body);
        await state.beforeAnswer?.();
        if (state.answerMode === 'offline') throw new Error('Synthetic disconnected transport');
        if (state.answerMode === 'conflict') return reply({ code: 'STALE_QUESTION' }, 409);
        let answer = answers.get(command.requestId);
        if (!answer) {
          state.resumes++;
          state.q = { ...state.q, resolved: true, waitingCount: 0, revision: state.q.revision + 1 };
          answer = AnswerResultSchema.parse({ ownerId: state.owner, answerId: id(), questionId: state.q.id,
            resolvedQuestionIds: [state.q.id], resumedApplicationIds: [state.q.application.id], replayed: false });
          answers.set(command.requestId, answer);
        }
        if (state.answerMode === 'lost') throw new Error('Synthetic lost acknowledgement');
        return reply(answer);
      }
      if (path.endsWith('/review')) {
        ReviewCommandSchema.parse(body);
        state.q = { ...state.q, revision: state.q.revision + 1, allowedReuse: ['application', 'employer', 'equivalent'],
          descriptor: { ...state.q.descriptor, meaning: { ...state.q.descriptor.meaning, reviewId: id() } } };
        return reply(QuestionDetailSchema.parse(state.q));
      }
      if (path.endsWith('/focus')) {
        FocusCommandSchema.parse(body);
        state.q.focus = FocusResultSchema.parse({ id: id(), questionId: state.q.id, applicationId: state.q.application.id,
          workerId: state.q.application.workerId, revision: 1, status: 'pending', reason: null });
        return reply(state.q.focus);
      }
    }
    return reply({ code: 'UNMOCKED' }, 404);
  }
  return { state, respond };
}
