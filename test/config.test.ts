import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const dir = await mkdtemp(join(tmpdir(), 'pi-grok-config-'));
process.env.PI_CODING_AGENT_DIR = dir;
test.after(async () => {
  delete process.env.PI_CODING_AGENT_DIR;
  await rm(dir, { recursive: true, force: true });
});
const { parsePermissionMode, parseToolBatchSize, readConfig, resolveGuard, GROK_HOOK_CAP_MS } = await import('../src/config.ts');

test('leash guard defaults and precedence: env over file over default', () => {
  assert.deepEqual(resolveGuard(undefined, {}), { stallMs: 1000, requestMs: 25000, dialogMs: 570000 });
  assert.deepEqual(resolveGuard({ stallMs: 2000, requestMs: 20000, dialogMs: 500000 }, { PI_GROK_STALL_MS: '1500', PI_GROK_REQUEST_MS: '24000', PI_GROK_DIALOG_MS: '550000' }), { stallMs: 1500, requestMs: 24000, dialogMs: 550000 });
  assert.equal(resolveGuard({ stallMs: 2000 }, {}).stallMs, 2000);
});

test('leash guard rejects non-positive ms and deadlines that permit Grok to fail open', () => {
  for (const key of ['stallMs', 'requestMs', 'dialogMs']) {
    for (const bad of [0, -1, 0.5, Infinity, NaN]) assert.throws(() => resolveGuard({ [key]: bad }, {}), /positive number/);
  }
  assert.throws(() => resolveGuard({ requestMs: 30000 }, {}), /below the request deadline/);
  assert.throws(() => resolveGuard({ dialogMs: GROK_HOOK_CAP_MS }, {}), /below Grok's hook cap/);
  assert.throws(() => resolveGuard(undefined, { PI_GROK_REQUEST_MS: 'soon' }), /positive number/);
});

test('parsePermissionMode accepts the four modes and rejects the rest', () => {
  for (const mode of ['yolo', 'auto', 'ask', 'readonly']) assert.equal(parsePermissionMode(mode), mode);
  for (const bad of [undefined, null, '', 'YOLO', 'read-only', 42]) {
    assert.throws(() => parsePermissionMode(bad), /permissionMode must be yolo, auto, ask, or readonly /);
  }
});

test('permissionMode and leash guard default without a config file', async () => {
  const config = await readConfig();
  assert.equal(config.permissionMode, 'auto');
  assert.deepEqual(config.guard, { stallMs: 1000, requestMs: 25000, dialogMs: 570000 });
});

test('permissionMode loads from grok-ws.json and rejects garbage', async () => {
  await writeFile(join(dir, 'grok-ws.json'), JSON.stringify({ permissionMode: 'yolo' }));
  assert.equal((await readConfig()).permissionMode, 'yolo');
  await writeFile(join(dir, 'grok-ws.json'), JSON.stringify({ permissionMode: 'wide-open' }));
  await assert.rejects(readConfig(), /permissionMode must be yolo, auto, ask, or readonly /);
});

test('parseToolBatchSize accepts positive integers and rejects the rest', () => {
  assert.equal(parseToolBatchSize(1), 1);
  assert.equal(parseToolBatchSize(25), 25);
  for (const bad of [undefined, null, 0, -3, 2.5, '10', Number.NaN]) {
    assert.throws(() => parseToolBatchSize(bad), /toolBatchSize must be a positive integer/);
  }
});

test('toolBatchSize defaults to the batcher default and loads from grok-ws.json', async () => {
  const { TOOL_BATCH_SIZE } = await import('../src/config.ts');
  await writeFile(join(dir, 'grok-ws.json'), JSON.stringify({}));
  assert.equal((await readConfig()).toolBatchSize, TOOL_BATCH_SIZE);
  await writeFile(join(dir, 'grok-ws.json'), JSON.stringify({ toolBatchSize: 25 }));
  assert.equal((await readConfig()).toolBatchSize, 25);
  await writeFile(join(dir, 'grok-ws.json'), JSON.stringify({ toolBatchSize: 0 }));
  await assert.rejects(readConfig(), /toolBatchSize must be a positive integer/);
});

