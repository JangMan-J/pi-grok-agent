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
const { parsePermissionMode, parseToolBatchSize, readConfig } = await import('../src/config.ts');

test('parsePermissionMode accepts the four modes and rejects the rest', () => {
  for (const mode of ['yolo', 'auto', 'ask', 'readonly']) assert.equal(parsePermissionMode(mode), mode);
  for (const bad of [undefined, null, '', 'YOLO', 'read-only', 42]) {
    assert.throws(() => parsePermissionMode(bad), /permissionMode must be yolo, auto, ask, or readonly /);
  }
});

test('permissionMode defaults to auto without a config file', async () => {
  assert.equal((await readConfig()).permissionMode, 'auto');
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

test('MCP mode is environment-only and readConfig returns a snapshot', async (t) => {
  const before = process.env.PI_GROK_MCP;
  t.after(() => { if (before === undefined) delete process.env.PI_GROK_MCP; else process.env.PI_GROK_MCP = before; });
  await writeFile(join(dir, 'grok-ws.json'), JSON.stringify({ mcp: 'sdk' }));
  delete process.env.PI_GROK_MCP;
  const http = await readConfig();
  assert.equal(http.mcp, 'http', 'the JSON file does not select the temporary probe mode');
  process.env.PI_GROK_MCP = 'sdk';
  assert.equal(http.mcp, 'http');
  assert.equal((await readConfig()).mcp, 'sdk');
  process.env.PI_GROK_MCP = 'invalid';
  await assert.rejects(readConfig(), /PI_GROK_MCP must be http or sdk/);
});
