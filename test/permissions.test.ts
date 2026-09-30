import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import { permissionAnswer, permissionDialog } from '../src/model/permissions.ts';

const bash: RequestPermissionRequest = {
  sessionId: 's',
  toolCall: { toolCallId: 'c', title: 'bash', kind: 'execute', rawInput: { command: 'ls' } },
  options: [
    { optionId: 'ok', name: 'Allow', kind: 'allow_once' },
    { optionId: 'no', name: 'Reject', kind: 'reject_once' },
  ],
};

function ui() {
  const selects: string[] = [];
  const ctx = {
    hasUI: true,
    ui: { select: async (title: string) => { selects.push(title); return '1. Allow (allow_once)'; } } as any,
  };
  return { ctx, selects };
}

test('yolo selects allow once for a bash permission prompt and does not open a dialog', async () => {
  const { ctx, selects } = ui();
  let mode: 'yolo' | 'auto' = 'auto';
  const answer = permissionAnswer(true, permissionDialog(ctx), 'dialog', () => mode);
  const prompted = await answer(bash);
  assert.equal(prompted.outcome.outcome, 'selected');
  assert.equal(prompted.outcome.outcome === 'selected' && prompted.outcome.optionId, 'ok');
  assert.deepEqual(selects, ['Grok: bash\n{\n  "command": "ls"\n}']);
  mode = 'yolo';
  const allowed = await answer(bash);
  assert.deepEqual(allowed, { outcome: { outcome: 'selected', optionId: 'ok' } });
  assert.equal(selects.length, 1, 'yolo does not open another dialog');
});

test('yolo selects allow once without a UI, including when the headless policy would cancel', async () => {
  const answer = permissionAnswer(false, async () => { throw new Error('dialog'); }, 'dialog', () => 'yolo');
  assert.deepEqual(await answer(bash), { outcome: { outcome: 'selected', optionId: 'ok' } });
  const cancel = permissionAnswer(false, async () => { throw new Error('dialog'); }, 'dialog', () => 'auto');
  assert.deepEqual(await cancel(bash), { outcome: { outcome: 'cancelled' } });
});
