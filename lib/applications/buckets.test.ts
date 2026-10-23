import { describe, expect, it } from 'vitest';
import { openQuestions, rowAsks } from './buckets.ts';

const app = 'a0000000-0000-4000-8000-000000000001';
const question = (id: string, resolved = false) => ({ id, resolved });

describe("a row's questions and Retry", () => {
  it('lists a question asked again (one notification per ask) once', () => {
    const asked = openQuestions([
      { applicationId: app, question: question('q1') }, { applicationId: app, question: question('q1') },
      { applicationId: app, question: question('q2', true) }, { applicationId: app, question: null },
    ]);
    expect(asked.get(app)).toEqual([question('q1')]);
  });

  it('offers Retry, not a read-only Answer, on a stopped row that still has open questions', () => {
    for (const state of ['cancelled', 'failed', 'skipped'] as const)
      expect(rowAsks({ state, reasonCode: 'run_stopped' }, [question('q1')])).toEqual({ questions: [], restart: false });
    expect(rowAsks({ state: 'needs_answer', reasonCode: 'question_unresolved' }, [question('q1')])).toEqual({ questions: [question('q1')], restart: false });
  });

  it('restarts a needs_answer the worker parked with no question, which nothing else resumes', () => {
    expect(rowAsks({ state: 'needs_answer', reasonCode: 'form_question' })).toEqual({ questions: [], restart: true });
    expect(rowAsks({ state: 'needs_answer', reasonCode: 'profile_answer_required' }, [])).toEqual({ questions: [], restart: true });
    // Questions arrive with the inbox a moment after the rows; that wait is not a dead end.
    expect(rowAsks({ state: 'needs_answer', reasonCode: 'question_unresolved' })).toEqual({ questions: [], restart: false });
    expect(rowAsks({ state: 'needs_answer', reasonCode: 'run_paused' })).toEqual({ questions: [], restart: false });
  });
});
