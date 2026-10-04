import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createToolBatcher, isInteresting } from '../src/tool-batch.ts';
import type { GrokToolRecord } from '../src/model/session.ts';

const routine = (tool: string, durationMs = 10): GrokToolRecord =>
  ({ toolUseId: `t-${tool}-${durationMs}`, tool, input: { path: 'a.txt' }, status: 'completed', durationMs });

test('routine completions flush as one batch entry per batch size, in order', () => {
  const batches: GrokToolRecord[][] = [];
  const batcher = createToolBatcher((records) => { batches.push(records); }, 3);
  const tools = ['read_file', 'grep', 'read_file', 'run_terminal_cmd', 'grep'];
  for (const tool of tools) assert.equal(batcher.record(routine(tool)), true);
  assert.equal(batches.length, 1, 'first 3 flush as one batch');
  assert.deepEqual(batches[0].map((r) => r.tool), ['read_file', 'grep', 'read_file']);
  assert.equal(batcher.pendingCount, 2);
  batcher.flush();
  assert.equal(batches.length, 2, 'leftovers flush at turn end');
  assert.deepEqual(batches[1].map((r) => r.tool), ['run_terminal_cmd', 'grep']);
  assert.equal(batcher.pendingCount, 0);
});

test('interesting records bypass the batcher: failures, denials, media, hook context', () => {
  const batches: GrokToolRecord[][] = [];
  const batcher = createToolBatcher((records) => { batches.push(records); });
  const failed = { ...routine('read_file'), status: 'failed' as const };
  const denied = { ...routine('run_terminal_cmd'), status: 'denied' as const, denyReason: 'no' };
  const media = { ...routine('read_file'), mediaPath: '/tmp/x.png' };
  const checked = { ...routine('search_replace'), hookContext: 'tsc clean' };
  for (const record of [failed, denied, media, checked]) {
    assert.equal(isInteresting(record), true, `${record.tool}/${record.status} renders alone`);
    assert.equal(batcher.record(record), false);
  }
  assert.equal(batches.length, 0);
  assert.equal(batcher.pendingCount, 0);
  assert.equal(isInteresting(routine('grep')), false);
});

test('flushing an empty batcher appends nothing', () => {
  let calls = 0;
  const batcher = createToolBatcher(() => { calls++; });
  batcher.flush();
  assert.equal(calls, 0);
});
