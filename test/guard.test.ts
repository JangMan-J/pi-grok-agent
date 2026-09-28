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
