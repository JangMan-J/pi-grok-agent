import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Type } from '@earendil-works/pi-ai';
import { normalizeContext, type Message, type Model, type Api } from '@earendil-works/pi-ai';
import { GrokModelSession } from '../src/model/session.ts';
import { createGrokStream, splitTail, promptTextFor, GROK_API } from '../src/model/provider.ts';
import type { SessionHandlers } from '../src/model/connection.ts';

const model: Model<Api> = { id: 'grok-4.7', name: 'Grok', api: GROK_API, provider: 'grok', baseUrl: 'ws://127.0.0.1:1/ws', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 } as Model<Api>;
const readTool = { name: 'read', description: 'Read a file', parameters: Type.Object({ path: Type.String() }) };

/** Fake Grok: records prompts, exposes the registered handlers so the test can play Grok's side. */
function fakeConnection() {
  let handlers: SessionHandlers | undefined;
  const promptResolvers: ((r: any) => void)[] = [];
  const calls: { method: string; params: any }[] = [];
  const connection = {
    isOpen: true,
    open: async () => {},
    attachSession: async (input: { handlers: SessionHandlers; rules?: string; serverId: string; offerPiTools: boolean }) => { handlers = input.handlers; calls.push({ method: 'session/new', params: { rules: input.rules, serverId: input.serverId, offerPiTools: input.offerPiTools } }); return { sessionId: 'g1', response: {} }; },
    detachSession: () => {},
    agent: {
      request: (method: string, params: any) => { calls.push({ method, params }); return new Promise<any>((r) => { if (method === "session/prompt") promptResolvers.push(r); else r({}); }); },
      notify: async (method: string, params: any) => { calls.push({ method, params }); },
    },
  };
  return { connection: connection as any, calls, handlers: () => handlers!, finishPrompt: (res: any = 'end_turn') => promptResolvers[promptResolvers.length - 1]!(typeof res === 'string' ? { stopReason: res } : res), finishPromptAt: (i: number, stopReason = 'end_turn') => promptResolvers[i]!({ stopReason }) };
}

async function collect(stream: AsyncIterable<any>) { const events: any[] = []; for await (const e of stream) events.push(e); return events; }

test('one Grok turn becomes two Pi assistant messages around a Pi tool call', async () => {
  const fake = fakeConnection();
  const session = new GrokModelSession(fake.connection, 'pi-session-1', '/repo');
  const stream = createGrokStream(fake.connection, { current: () => session, piTools: 'all' });

  const messages: Message[] = [{ role: 'user', content: 'read token.txt', timestamp: 1 }];
  const ctx1 = normalizeContext({ systemPrompt: 'You are Pi.', tools: [readTool], messages });
  const s1 = stream(model, ctx1, {});
  // Wait until Grok received the prompt, then play Grok: text, then a tools/call for Pi's read tool.
  await new Promise<void>((r) => { const i = setInterval(() => { if (fake.calls.some((c) => c.method === 'session/prompt')) { clearInterval(i); r(); } }, 5); });
  const h = fake.handlers();
  assert.deepEqual(await h.onMcp({ method: 'tools/list', id: 1 }), { tools: [{ name: 'read', description: 'Read a file', inputSchema: JSON.parse(JSON.stringify(readTool.parameters)), annotations: { readOnlyHint: true }, _meta: { readOnlyHint: true } }] });
  h.onUpdate({ sessionId: 'g1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Reading. ' } } } as any);
  const toolResultPromise = h.onMcp({ method: 'tools/call', id: 2, params: { name: 'read', arguments: { path: 'token.txt' } } });
  const events1 = await collect(s1);
  const done1 = events1.at(-1);
  assert.equal(done1.type, 'done'); assert.equal(done1.reason, 'toolUse');
  const toolCall = done1.message.content.find((c: any) => c.type === 'toolCall');
  assert.equal(toolCall.name, 'read'); assert.deepEqual(toolCall.arguments, { path: 'token.txt' });
  assert.equal(done1.message.content[0].text, 'Reading. ');
  assert.equal(fake.calls.find((c) => c.method === 'session/new')!.params.rules, 'You are Pi.');
  assert.equal(fake.calls.find((c) => c.method === 'session/new')!.params.offerPiTools, true);
  assert.match(fake.calls.find((c) => c.method === 'session/prompt')!.params.prompt[0].text, /read token\.txt/);

  // Pi executed the tool; second stream carries the result. Grok's parked call resolves, then Grok finishes.
  messages.push(done1.message, { role: 'toolResult', toolCallId: toolCall.id, toolName: 'read', content: [{ type: 'text', text: 'abc123' }], isError: false, timestamp: 2 });
  const s2 = stream(model, normalizeContext({ systemPrompt: 'You are Pi.', tools: [readTool], messages }), {});
  assert.deepEqual(await toolResultPromise, { content: [{ type: 'text', text: 'abc123' }], isError: false });
  h.onUpdate({ sessionId: 'g1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'abc123' } } } as any);
  fake.finishPrompt();
  const events2 = await collect(s2);
  const done2 = events2.at(-1);
  assert.equal(done2.type, 'done'); assert.equal(done2.reason, 'stop');
  assert.equal(done2.message.content[0].text, 'abc123');
  assert.equal(fake.calls.filter((c) => c.method === 'session/prompt').length, 1, 'tool results continue the same Grok turn');
});

test('default policy keeps Pi core tools out; Grok native tool activity is observed, not executed', async () => {
  const fake = fakeConnection();
  const session = new GrokModelSession(fake.connection, 'pi-3', '/repo');
  const stream = createGrokStream(fake.connection, { current: () => session });
  const s = stream(model, normalizeContext({ tools: [readTool], messages: [{ role: 'user', content: 'go', timestamp: 1 }] }), {});
  await new Promise<void>((r) => { const i = setInterval(() => { if (fake.calls.some((c) => c.method === 'session/prompt')) { clearInterval(i); r(); } }, 5); });
  assert.equal(fake.calls.find((c) => c.method === 'session/new')!.params.offerPiTools, false, 'only core Pi tools present, so no Pi server is offered');
  const h = fake.handlers();
  h.onUpdate({ sessionId: 'g1', update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'read_file', kind: 'read', rawInput: { path: 'a.txt' } } } as any);
  h.onUpdate({ sessionId: 'g1', update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'hello' } }] } } as any);
  h.onUpdate({ sessionId: 'g1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } } } as any);
  fake.finishPrompt();
  const events = await collect(s);
  const done = events.at(-1);
  assert.equal(done.reason, 'stop');
  assert.ok(!done.message.content.some((c: any) => c.type === 'toolCall'), 'native Grok tool never becomes a Pi tool call');
  const thinking = done.message.content.find((c: any) => c.type === 'thinking');
  assert.match(thinking.thinking, /\[grok read_file\] \{"path":"a.txt"\}/);
  assert.match(thinking.thinking, /\[grok read_file completed\] hello/);
  assert.equal(done.message.content.at(-1).text, 'done');
});

test('abort cancels the Grok prompt and rejects parked tool calls', async () => {
  const fake = fakeConnection();
  const session = new GrokModelSession(fake.connection, 'pi-2', '/repo');
  const stream = createGrokStream(fake.connection, { current: () => session, piTools: 'all' });
  const ac = new AbortController();
  const s = stream(model, normalizeContext({ tools: [readTool], messages: [{ role: 'user', content: 'go', timestamp: 1 }] }), { signal: ac.signal });
  await new Promise<void>((r) => { const i = setInterval(() => { if (fake.calls.some((c) => c.method === 'session/prompt')) { clearInterval(i); r(); } }, 5); });
  const parked = fake.handlers().onMcp({ method: 'tools/call', id: 9, params: { name: 'read', arguments: { path: 'x' } } });
  await new Promise((r) => setTimeout(r, 10));
  ac.abort();
  const events = await collect(s);
  assert.equal(events.at(-1).type, 'error'); assert.equal(events.at(-1).reason, 'aborted');
  await assert.rejects(parked, /aborted/);
  assert.ok(fake.calls.some((c) => c.method === 'session/cancel'));
});

test('tail splitting and prompt text', () => {
  const msgs: Message[] = [
    { role: 'user', content: 'a', timestamp: 1 },
    { role: 'assistant', content: [{ type: 'text', text: 'b' }], api: GROK_API, provider: 'grok', model: 'm', usage: {} as any, stopReason: 'stop', timestamp: 2 },
    { role: 'user', content: 'c', timestamp: 3 },
  ];
  const { history, tail } = splitTail(msgs);
  assert.equal(history.length, 2); assert.equal(tail.length, 1);
  assert.equal(promptTextFor(tail, [], 'PRE'), 'Conversation so far (Pi transcript):\n\nPRE\n\n---\n\nc');
});

test('usage: turn_completed accounting maps to Pi usage with cache split out and cost from ticks', async () => {
  const { parseTurnUsage } = await import('../src/model/session.ts');
  const u = parseTurnUsage({ inputTokens: 24140, outputTokens: 226, totalTokens: 24366, cachedReadTokens: 1792, cacheCreationTokens: 0, reasoningTokens: 225, modelCalls: 1, costUsdTicks: 159623200 });
  assert.deepEqual(u, { inputTokens: 24140, outputTokens: 226, cachedReadTokens: 1792, cacheCreationTokens: 0, reasoningTokens: 225, modelCalls: 1, costUsd: 0.1596232 });
  assert.equal(parseTurnUsage(undefined), undefined);
  // Through the stream: complete event carries usage; the Pi message reports input excluding cached tokens.
  const fake = fakeConnection();
  const session = new GrokModelSession(fake.connection, 'pi-u', '/repo');
  const stream = createGrokStream(fake.connection, { current: () => session });
  const s = stream(model, normalizeContext({ messages: [{ role: 'user', content: 'go', timestamp: 1 }] }), {});
  await new Promise<void>((r) => { const i = setInterval(() => { if (fake.calls.some((c) => c.method === 'session/prompt')) { clearInterval(i); r(); } }, 5); });
  const h = fake.handlers();
  (h as any).onSessionExt({ sessionUpdate: 'turn_completed', usage: { inputTokens: 24140, outputTokens: 226, cachedReadTokens: 1792, cacheCreationTokens: 0, reasoningTokens: 225, modelCalls: 1, costUsdTicks: 159623200 } });
  h.onUpdate({ sessionId: 'g1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'one' } } } as any);
  fake.finishPrompt();
  const events = await collect(s);
  const done = events.at(-1);
  assert.deepEqual(done.message.usage, { input: 22348, output: 226, cacheRead: 1792, cacheWrite: 0, totalTokens: 24366, cost: { input: 0.1596232, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1596232 } });
  assert.equal(session.usageTotals.turns, 1);
});

test('usage: contextTokens from response _meta overrides multi-call cumulative totalTokens for Pi context estimation', async () => {
  const fake = fakeConnection();
  const session = new GrokModelSession(fake.connection, 'pi-u2', '/repo');
  const stream = createGrokStream(fake.connection, { current: () => session });
  const s = stream(model, normalizeContext({ messages: [{ role: 'user', content: 'go', timestamp: 1 }] }), {});
  await new Promise<void>((r) => { const i = setInterval(() => { if (fake.calls.some((c) => c.method === 'session/prompt')) { clearInterval(i); r(); } }, 5); });
  const h = fake.handlers();
  // Multi-call turn: input + cacheRead totals 583k tokens across 10 internal calls, but actual context window size is 45k
  (h as any).onSessionExt({ sessionUpdate: 'turn_completed', usage: { inputTokens: 583000, outputTokens: 9000, cachedReadTokens: 435000, cacheCreationTokens: 0, reasoningTokens: 200, modelCalls: 10, costUsdTicks: 1929000000 } });
  fake.finishPrompt({ stopReason: 'end_turn', _meta: { totalTokens: 45000 } });
  const events = await collect(s);
  const done = events.at(-1);
  assert.equal(done.message.usage.totalTokens, 45000, 'totalTokens matches Grok context size rather than multi-call sum');
  assert.equal(done.message.usage.input, 148000);
  assert.equal(done.message.usage.cacheRead, 435000);
});

test('display-only messages are never prompt input to Grok (pi-agent-core presents custom messages as user)', () => {
  const marker = '\u200b[grok-display]';
  const msgs: Message[] = [
    { role: 'user', content: 'draw it', timestamp: 1 },
    { role: 'assistant', content: [{ type: 'text', text: 'here' }], api: GROK_API, provider: 'grok', model: 'm', usage: {} as any, stopReason: 'stop', timestamp: 2 },
    // what the provider actually receives for our grok-media message: role user, marker first
    { role: 'user', content: [{ type: 'text', text: `${marker}image_gen: /x/1.jpg` }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }], timestamp: 3 },
  ];
  assert.equal(splitTail(msgs).tail.length, 0, 'a trailing display-only message leaves nothing to send');
  msgs.push({ role: 'user', content: 'now a video', timestamp: 4 });
  const t2 = splitTail(msgs).tail;
  assert.equal(t2.length, 1);
  assert.equal(promptTextFor(t2, []), 'now a video', 'the media caption and image never reach the prompt');
});

test('abort then immediate new message: no TDZ, no stale completion, second turn runs clean', async () => {
  const fake = fakeConnection();
  const session = new GrokModelSession(fake.connection, 'pi-abort2', '/repo');
  const stream = createGrokStream(fake.connection, { current: () => session });
  const ac1 = new AbortController();
  const s1 = stream(model, normalizeContext({ messages: [{ role: 'user', content: 'draw', timestamp: 1 }] }), { signal: ac1.signal });
  await new Promise<void>((r) => { const i = setInterval(() => { if (fake.calls.some((c) => c.method === 'session/prompt')) { clearInterval(i); r(); } }, 5); });
  ac1.abort();
  const e1 = await collect(s1);
  assert.equal(e1.at(-1).reason, 'aborted');
  assert.equal(session.promptActive, false, 'abandoned prompt no longer blocks the session');
  // Grok answers the cancelled prompt late, after the user already sent the next message.
  const s2 = stream(model, normalizeContext({ messages: [{ role: 'user', content: 'draw', timestamp: 1 }, e1.at(-1).error, { role: 'user', content: 'again', timestamp: 3 }] }), {});
  await new Promise<void>((r) => { const i = setInterval(() => { if (fake.calls.filter((c) => c.method === 'session/prompt').length === 2) { clearInterval(i); r(); } }, 5); });
  const prompts = fake.calls.filter((c) => c.method === 'session/prompt');
  assert.match(prompts[1].params.prompt[0].text, /again/);
  fake.finishPromptAt(0, 'cancelled'); // late answer for the aborted first prompt
  fake.handlers().onUpdate({ sessionId: 'g1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'second' } } } as any);
  fake.finishPromptAt(1, 'end_turn');
  const e2 = await collect(s2);
  assert.equal(e2.at(-1).type, 'done', JSON.stringify(e2.at(-1)).slice(0, 200));
  assert.equal(e2.at(-1).reason, 'stop');
  assert.equal(e2.at(-1).message.content.find((c: any) => c.type === 'text')?.text, 'second');
});

test('/grok command timeout cancels on Grok and frees the session for the next turn; the late reply is dropped', async () => {
  const fake = fakeConnection();
  const session = new GrokModelSession(fake.connection, 'pi-cmd', '/repo');
  await session.attach(undefined);
  const command = session.runCommand('/goal status', 30);
  await new Promise<void>((r) => { const i = setInterval(() => { if (fake.calls.some((c) => c.method === 'session/prompt')) { clearInterval(i); r(); } }, 5); });
  fake.handlers().onUpdate({ sessionId: 'g1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'thinking about it' } } } as any);
  await assert.rejects(command, /timed out after 0\.03s/);
  assert.equal(session.promptActive, false, 'the session is free');
  assert.ok(fake.calls.some((c) => c.method === 'session/cancel'), 'the command prompt was cancelled on Grok');

  // The next normal turn starts at once; the timed-out command's late completion does not bleed into it.
  const stream = createGrokStream(fake.connection, { current: () => session, piTools: 'none' });
  const s2 = stream(model, normalizeContext({ systemPrompt: 'You are Pi.', tools: [], messages: [{ role: 'user', content: 'hello', timestamp: 1 }] }), {});
  await new Promise<void>((r) => { const i = setInterval(() => { if (fake.calls.filter((c) => c.method === 'session/prompt').length === 2) { clearInterval(i); r(); } }, 5); });
  fake.finishPromptAt(0, 'end_turn'); // late completion of the cancelled command
  fake.handlers().onUpdate({ sessionId: 'g1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } } as any);
  fake.finishPromptAt(1, 'end_turn');
  const events = await collect(s2);
  assert.equal(events.at(-1).type, 'done');
  assert.equal(events.at(-1).message.content[0].text, 'hi');
  assert.equal(fake.calls.filter((c) => c.method === 'session/prompt')[1]!.params.prompt[0].text, 'hello');
});

test('/grok command completes through the shared prompt lifetime: text collected, busy while running, free after', async () => {
  const fake = fakeConnection();
  const session = new GrokModelSession(fake.connection, 'pi-cmd2', '/repo');
  await session.attach(undefined);
  const command = session.runCommand('/compact');
  await new Promise<void>((r) => { const i = setInterval(() => { if (fake.calls.some((c) => c.method === 'session/prompt')) { clearInterval(i); r(); } }, 5); });
  assert.equal(session.promptActive, true);
  await assert.rejects(session.runCommand('/goal status'), /busy with a turn/);
  fake.handlers().onUpdate({ sessionId: 'g1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Compacted 3 turns.' } } } as any);
  fake.finishPrompt('end_turn');
  assert.deepEqual(await command, { text: 'Compacted 3 turns.', stopReason: 'end_turn' });
  assert.equal(session.promptActive, false);
  assert.equal(fake.calls.filter((c) => c.method === 'session/cancel').length, 0, 'a completed command is not cancelled');
});
