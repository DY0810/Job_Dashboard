import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveView } from './live.ts';

test('a step that changes while a frame is sending is sent next, before the last frame', async () => {
  const posted = [];
  let release;
  const slow = new Promise(resolve => { release = resolve; });
  const runtime = { page: async () => ({ screenshot: async () => Buffer.alloc(2_000, 1) }) };
  const live = liveView(async frame => { posted.push(frame.step); if (posted.length === 1) await slow; }, runtime, 60_000);
  live.step('Writing the cover letter');
  await new Promise(resolve => setImmediate(resolve));
  live.step('Filling the form'); // the cover letter frame is still sending
  const stopped = live.stop('Filled. Waiting for your approval');
  release();
  await stopped;
  assert.deepEqual(posted, ['Writing the cover letter', 'Filling the form', 'Filled. Waiting for your approval']);
});
