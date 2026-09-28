import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSteerHandler, steerText } from '../src/model/steer.ts';
import type { InputEvent } from '@earendil-works/pi-coding-agent';

const input = (over: Partial<InputEvent>): InputEvent => ({ type: 'input', text: '', source: 'interactive', ...over });
function deps(over: Partial<Parameters<typeof createSteerHandler>[0]> = {}) {
  const calls: { interjected: string[]; recorded: string[]; notified: string[] } = { interjected: [], recorded: [], notified: [] };
  return {
    calls,
    handler: createSteerHandler({
      hasGrokSession: () => true,
      interject: async (text: string) => { calls.interjected.push(text); },
      record: (text: string) => calls.recorded.push(text),
      notify: (text: string) => calls.notified.push(text),
      ...over,
    }),
  };
}

test('idle and followUp input flows through untouched', async () => {
  const d = deps();
  assert.equal(await d.handler(input({ text: 'hello' })), undefined);
  assert.equal(await d.handler(input({ text: 'hello', streamingBehavior: 'followUp' })), undefined);
  assert.deepEqual(d.calls.interjected, []);
});

test('steer with no Grok session flows through (Pi queues it normally)', async () => {
  const d = deps({ hasGrokSession: () => false });
  assert.equal(await d.handler(input({ text: 'stop that', streamingBehavior: 'steer' })), undefined);
  assert.deepEqual(d.calls.interjected, []);
});

test('steer interjects, records, and takes the message over', async () => {
  const d = deps();
  assert.deepEqual(await d.handler(input({ text: 'use postgres instead', streamingBehavior: 'steer' })), { action: 'handled' });
  assert.deepEqual(d.calls.interjected, ['use postgres instead']);
  assert.deepEqual(d.calls.recorded, ['use postgres instead']);
});

test('slash input and empty input are left to Pi', async () => {
  const d = deps();
  assert.equal(await d.handler(input({ text: '/grok debug', streamingBehavior: 'steer' })), undefined);
  assert.equal(await d.handler(input({ text: '   ', streamingBehavior: 'steer' })), undefined);
  assert.deepEqual(d.calls.interjected, []);
});

test('failed interject falls back to Pi queueing and notifies', async () => {
  const d = deps({ interject: async () => { throw new Error('no active turn'); } });
  assert.deepEqual(await d.handler(input({ text: 'stop', streamingBehavior: 'steer' })), { action: 'continue' });
  assert.equal(d.calls.notified.length, 1);
  assert.deepEqual(d.calls.recorded, []);
});

test('steerText spills attached images to paths', () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
  const text = steerText('look', [{ type: 'image', data: png, mimeType: 'image/png' }]);
  assert.match(text, /\[attached image: .*\.png/);
});
