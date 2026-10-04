import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveGuard, GATE_REGISTRATION_MS, GROK_HOOK_CAP_MS } from '../src/config.ts';

test('guard defaults and precedence: env over file over default', () => {
  assert.deepEqual(resolveGuard(undefined, {}), { ackMs: 5000, policyMs: 15000, checkBudgetMs: 590000, dialogMs: 600000 });
  assert.equal(resolveGuard({ ackMs: 2000 }, {}).ackMs, 2000);
  assert.equal(resolveGuard({ ackMs: 2000 }, { PI_GROK_ACK_MS: '3000' }).ackMs, 3000);
  assert.equal(resolveGuard({ dialogMs: 1_800_000 }, {}).dialogMs, 1_800_000, 'dialog window may exceed Grok caps: permissions have no Grok deadline');
});

test('guard rejects tiers that would let Grok fail open first', () => {
  assert.throws(() => resolveGuard({ ackMs: GATE_REGISTRATION_MS }, {}), /below the pre_tool_use registration deadline/);
  assert.throws(() => resolveGuard({ policyMs: GATE_REGISTRATION_MS + 1 }, {}), /below the pre_tool_use registration deadline/);
  assert.throws(() => resolveGuard({ checkBudgetMs: GROK_HOOK_CAP_MS }, {}), /below Grok's hook cap/);
  assert.throws(() => resolveGuard({ ackMs: 10000, policyMs: 5000 }, {}), /ackMs must not exceed/);
  assert.throws(() => resolveGuard({ ackMs: -1 }, {}), /positive number/);
  assert.throws(() => resolveGuard(undefined, { PI_GROK_POLICY_MS: 'soon' }), /positive number/);
});

test('close-time guard settles once, drops every late answer, and leaves unguarded traffic alone', async () => {
  const { ReverseRequestGuard } = await import('../src/model/guard.ts');
  const replies: any[] = [];
  const guard = new ReverseRequestGuard((message) => replies.push(message));
  const hook = (id: string, hookEventName: string) => ({ jsonrpc: '2.0', id, method: '_x.ai/hooks/run', params: { hookEventName } });
  guard.watch(hook('answered', 'pre_tool_use'));
  const answer = { jsonrpc: '2.0', id: 'answered', result: { decision: 'continue' } };
  assert.equal(guard.settle(answer), 'forward');
  assert.equal(guard.settle(answer), 'drop');
  for (const event of ['pre_tool_use', 'post_tool_use', 'stop']) guard.watch(hook(event, event));
  guard.watch({ jsonrpc: '2.0', id: 'question', method: '_x.ai/ask_user_question' });
  guard.watch({ jsonrpc: '2.0', id: 'permission', method: 'session/request_permission', params: { options: [{ kind: 'reject_always', optionId: 'no' }] } });
  guard.watch({ jsonrpc: '2.0', id: 'cancel', method: 'session/request_permission', params: { options: [] } });
  guard.close('Pi connection closed');
  guard.close('again');
  assert.deepEqual(replies.map((reply) => reply.result), [
    { decision: 'deny', reason: 'Denied because the Pi session is gone: Pi connection closed.' },
    { decision: 'continue' }, { decision: 'continue' }, { outcome: 'cancelled' },
    { outcome: { outcome: 'selected', optionId: 'no' } }, { outcome: { outcome: 'cancelled' } },
  ]);
  for (const reply of replies) {
    assert.equal(guard.settle(reply), 'drop');
    assert.equal(guard.settle(reply), 'drop');
  }
  assert.equal(guard.lateAnswersDropped, 13);
  assert.equal(guard.settle({ jsonrpc: '2.0', id: 'other', result: {} }), 'forward');
  assert.equal(guard.settle({ jsonrpc: '2.0', method: 'notify', params: {} }), 'forward');
});
