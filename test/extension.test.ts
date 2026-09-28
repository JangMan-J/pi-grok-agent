import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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
