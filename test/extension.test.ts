import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ExtensionAPI, ExtensionContext, InputEvent, InputEventResult } from '@earendil-works/pi-coding-agent';

// These tests load the real extension. It must never start a real gateway (and a real Grok leader) from a test.
process.env.PI_GROK_AUTOSTART = '0';

test('registered input handler leaves other models alone after a Grok session', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-grok-extension-test-'));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  const oldSecret = process.env.GROK_AGENT_SECRET;
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.GROK_AGENT_SECRET = 'test-secret';
  t.after(async () => {
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldDir;
    if (oldSecret === undefined) delete process.env.GROK_AGENT_SECRET;
    else process.env.GROK_AGENT_SECRET = oldSecret;
    await rm(dir, { recursive: true, force: true });
  });
  const { default: grokModel } = await import('../src/model.ts');
  const { GrokModelConnection } = await import('../src/model/connection.ts');
  const requests: unknown[] = [];
  const entries: unknown[] = [];
  t.mock.getter(GrokModelConnection.prototype, 'agent', () => ({
    request: async (...args: unknown[]) => { requests.push(args); return {}; },
  }) as never);
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
  const pi = {
    on: (name: string, handler: (event: any, ctx: ExtensionContext) => any) => { handlers.set(name, handler); },
    registerProvider() {}, registerMessageRenderer() {}, registerEntryRenderer() {}, registerCommand() {},
    appendEntry: (...args: unknown[]) => { entries.push(args); },
  } as unknown as ExtensionAPI;
  await grokModel(pi);
  const ctx = {
    cwd: dir, hasUI: false, model: { provider: 'grok' }, ui: { notify() {} },
    sessionManager: {
      getSessionId: () => 'pi-test',
      getBranch: () => [{ type: 'custom', customType: 'grok-model-session', data: {
        owner: 'pi-test', grokSessionId: 'grok-test', serverId: 'server-test', cwd: dir,
      } }],
    },
  } as unknown as ExtensionContext;
  await handlers.get('session_start')!({}, ctx);
  const input = handlers.get('input')! as (event: InputEvent, ctx: ExtensionContext) => Promise<InputEventResult | undefined>;
  const steer: InputEvent = { type: 'input', text: 'change direction', source: 'interactive', streamingBehavior: 'steer' };
  assert.deepEqual(await input(steer, ctx), { action: 'handled' });
  assert.equal(requests.length, 1);
  assert.equal(entries.length, 1);
  const other = { ...ctx, model: { provider: 'another-provider' } } as ExtensionContext;
  assert.equal(await input(steer, other), undefined);
  assert.equal(await input(steer, { ...ctx, model: undefined }), undefined);
  assert.equal(requests.length, 1, 'no stale Grok interjection after changing models');
  assert.equal(entries.length, 1, 'do not consume or record another model’s steering input');
  assert.deepEqual(await input(steer, ctx), { action: 'handled' }, 'switching back still steers Grok');
});

test('the extension loads without the gateway secret file; the secret is read at connect time', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-grok-extension-nosecret-'));
  const oldSecret = process.env.GROK_AGENT_SECRET;
  delete process.env.GROK_AGENT_SECRET;
  t.after(async () => {
    if (oldSecret !== undefined) process.env.GROK_AGENT_SECRET = oldSecret;
    await rm(dir, { recursive: true, force: true });
  });
  const { default: grokModel } = await import('../src/model.ts');
  const { defaultSecretFile } = await import('../src/config.ts');
  await rm(defaultSecretFile, { force: true });
  let provider: unknown;
  const pi = {
    on() {}, registerProvider: (...args: unknown[]) => { provider = args; }, registerMessageRenderer() {}, registerEntryRenderer() {}, registerCommand() {}, appendEntry() {},
  } as unknown as ExtensionAPI;
  await grokModel(pi); // Pi exits on any extension load error, so this must not throw
  assert.ok(provider, 'the grok provider is registered even though no secret exists yet');
});

test('context windows come from Grok Build\'s model cache; bad values and a missing cache are skipped', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-grok-models-cache-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { grokContextWindows } = await import('../src/model.ts');
  const file = join(dir, 'models_cache.json');
  // Shape of ~/.grok/models_cache.json as Grok Build wrote it on 2026-09-30.
  await writeFile(file, JSON.stringify({ models: {
    'grok-4.7': { info: { id: 'grok-4.7', name: 'Grok 4.7', context_window: 256000, compaction_at_tokens: true } },
    'grok-4.5': { info: { id: 'grok-4.5', context_window: 131072 } },
    'grok-x': { info: { context_window: '256000' } },
    'grok-y': { info: { context_window: -1 } },
    'grok-z': {},
  } }));
  assert.deepEqual(grokContextWindows(file), { 'grok-4.7': 256000, 'grok-4.5': 131072 });
  assert.deepEqual(grokContextWindows(join(dir, 'missing.json')), {});
  await writeFile(file, 'not json');
  assert.deepEqual(grokContextWindows(file), {});
});

test('tool rows keep call order and flush before tree navigation and shutdown', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-grok-extension-test-'));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  const oldSecret = process.env.GROK_AGENT_SECRET;
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.GROK_AGENT_SECRET = 'test-secret';
  t.after(async () => {
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldDir;
    if (oldSecret === undefined) delete process.env.GROK_AGENT_SECRET;
    else process.env.GROK_AGENT_SECRET = oldSecret;
    await rm(dir, { recursive: true, force: true });
  });
  const { default: grokModel } = await import('../src/model.ts');
  const { GrokModelSession } = await import('../src/model/session.ts');
  const { GrokModelConnection } = await import('../src/model/connection.ts');
  t.mock.method(GrokModelConnection.prototype, 'close', async () => {});
  let captured: InstanceType<typeof GrokModelSession> | undefined;
  t.mock.method(GrokModelSession.prototype, 'detach', function (this: InstanceType<typeof GrokModelSession>) { captured = this; });
  const entries: [string, unknown][] = [];
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
  const pi = {
    on: (name: string, handler: (event: any, ctx: ExtensionContext) => any) => { handlers.set(name, handler); },
    registerProvider() {}, registerMessageRenderer() {}, registerEntryRenderer() {}, registerCommand() {},
    appendEntry: (type: string, data: unknown) => { entries.push([type, data]); },
  } as unknown as ExtensionAPI;
  await grokModel(pi);
  const ctx = { cwd: dir, hasUI: false, ui: { notify() {} }, sessionManager: { getSessionId: () => 'pi-test', getBranch: () => [] } } as unknown as ExtensionContext;
  await handlers.get('session_start')!({}, ctx);
  await handlers.get('session_tree')!({}, ctx); // detaches the first session, which the mock captures
  const record = (tool: string, status: 'completed' | 'failed' = 'completed') => captured!.onToolRecord!({ toolUseId: tool, tool, input: {}, status, output: '' });
  const rows = () => entries.map(([type, data]) => `${type}:${Array.isArray(data) ? data.map((r) => r.tool).join(',') : (data as { tool: string }).tool}`);
  record('a'); record('b'); record('c', 'failed'); record('d');
  assert.deepEqual(rows(), ['grok-tools:a,b', 'grok-tool:c'], 'batched calls are written before a later single row');
  await handlers.get('session_before_tree')!({}, ctx);
  assert.deepEqual(rows().slice(2), ['grok-tools:d'], 'tree navigation flushes into the branch being left');
  record('e');
  await handlers.get('session_shutdown')!({ type: 'session_shutdown', reason: 'new' }, ctx);
  assert.deepEqual(rows().slice(3), ['grok-tools:e'], 'shutdown flushes before the session is replaced');
});
