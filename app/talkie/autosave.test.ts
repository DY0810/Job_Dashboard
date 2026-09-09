import { describe, expect, it } from 'vitest';

import { DeferredEditWriter, reconcileBody, sameNoteDraft, shouldAttachServerId } from './autosave.ts';

describe('autosave response ordering', () => {
  it('patches text typed after a slow create response', () => {
    expect(reconcileBody('typed second', 'typed first')).toEqual({ patchBody: 'typed second', matches: false });
  });

  it('patches the newest body when an idempotent retry returns an older persisted body', () => {
    // The POST may be a retry with the same client key. Its response is the old stored note,
    // not proof that the browser's newer body was persisted.
    expect(reconcileBody('new local body', 'old stored body')).toEqual({ patchBody: 'new local body', matches: false });
  });

  it('detects another keystroke after a prior PATCH completed', () => {
    expect(reconcileBody('third body', 'second body')).toEqual({ patchBody: 'third body', matches: false });
    expect(reconcileBody('third body', 'third body')).toEqual({ patchBody: null, matches: true });
  });

  it('does not attach canceled draft A to newly drawn draft B', () => {
    expect(shouldAttachServerId('b-key', 'a-key')).toBe(false);
    expect(shouldAttachServerId('b-key', 'b-key')).toBe(true);
  });

  it('treats a move during a save as newer work even when the text did not change', () => {
    const draft = { body: 'note', x: 10, y: 20, w: 240, h: 0 };
    expect(sameNoteDraft(draft, { ...draft, x: 80 })).toBe(false);
    expect(sameNoteDraft(draft, { ...draft, w: 320 })).toBe(false);
    expect(sameNoteDraft(draft, { ...draft, body: ' note ' })).toBe(true);
  });
});

describe('DeferredEditWriter', () => {
  it('serializes A -> B in-flight -> A against the last acknowledged body', async () => {
    let resolveFirst!: () => void;
    let resolveSecond!: () => void;
    const calls: string[] = [];
    const writer = new DeferredEditWriter('A', {
      delayMs: 0,
      write: (body) => {
        calls.push(body);
        return new Promise<void>((resolve) => {
          if (calls.length === 1) resolveFirst = resolve;
          else resolveSecond = resolve;
        });
      },
    });

    writer.setDesired('B');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(['B']);
    writer.setDesired('A');
    resolveFirst();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(['B', 'A']);
    resolveSecond();
    await writer.flush();
  });

  it('keeps newer local work queued after an acknowledgement', async () => {
    const calls: string[] = [];
    const writer = new DeferredEditWriter('one', {
      delayMs: 0,
      write: async (body) => { calls.push(body); },
    });
    writer.setDesired('two');
    await new Promise((resolve) => setTimeout(resolve, 0));
    writer.setDesired('three');
    await writer.flush();
    expect(calls).toEqual(['two', 'three']);
  });

  it('preserves failed work without retrying until explicitly retried', async () => {
    const calls: string[] = [];
    const writer = new DeferredEditWriter('one', {
      delayMs: 0,
      write: async (body) => {
        calls.push(body);
        if (calls.length === 1) throw new Error('offline');
      },
    });

    writer.setDesired('two');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(['two']);

    writer.retry();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(['two', 'two']);
  });
});
