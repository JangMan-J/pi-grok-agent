import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { capabilityGate, capabilitiesFrom, postEditContext, stopGate, editedFile, classify, metaSaysReadOnly } from '../src/model/hooks.ts';
import { GrokModelSession } from '../src/model/session.ts';

test('capability mirror: read-only Pi session denies Grok writes and shell, allows reads', () => {
  const gate = capabilityGate(['read', 'grep', 'find', 'ls'], {});
  assert.deepEqual(gate('hashline_read'), { allow: true });
  assert.equal(gate('hashline_edit').allow, false);
  assert.equal(gate('write').allow, false);
  assert.equal(gate('run_terminal_command').allow, false);
  assert.deepEqual(gate('web_search'), { allow: true }, 'unclassified tools pass');
  assert.match((gate('run_terminal_command') as { reason: string }).reason, /no shell access/);
});

test('capability mirror: full Pi session allows everything; explicit deny beats allow beats mirror', () => {
  const full = capabilityGate(['read', 'bash', 'edit', 'write'], {});
  assert.equal(full('run_terminal_command').allow, true);
  const configured = capabilityGate(['read'], { allowGrokTools: ['run_terminal_command'], denyGrokTools: ['web_.*'] });
  assert.equal(configured('run_terminal_command').allow, true, 'allow entry overrides the read-only mirror');
  assert.equal(configured('web_search').allow, false, 'deny pattern applies');
  assert.equal(configured('hashline_edit').allow, false, 'mirror still applies to the rest');
  assert.deepEqual(capabilitiesFrom([]), { read: false, write: false, shell: false });
});

test('classification: x.ai/tool stamp wins over the name table; unknown mutating kinds deny in read-only', () => {
  assert.equal(classify('apply_patch'), 'write', 'fallback name table');
  assert.equal(classify('some_new_tool', { kind: 'delete', read_only: false }), 'write', 'stamp kind classifies unknown names');
  assert.equal(classify('hashline_read', { kind: 'execute' }), 'shell', 'stamp beats name');
  assert.equal(classify('linear__save_issue', { kind: 'use_tool', read_only: false }), 'mcp');
  assert.equal(classify('linear__save_issue'), 'mcp', 'qualified name alone marks MCP');
  const ro = capabilityGate(['read'], {});
  assert.equal(ro('deploy', { kind: 'deploy_app', read_only: false }).allow, false, 'stamped mutating kind denied in read-only');
  assert.equal(ro('ask_user_question', { kind: 'ask_user', read_only: true }).allow, true, 'stamped read-only kind passes');
  assert.equal(ro('web_search', { kind: 'web_search', read_only: true }).allow, true);
  const rw = capabilityGate(['read', 'edit'], {});
  assert.equal(rw('deploy', { kind: 'deploy_app', read_only: false }).allow, true, 'mirror only bites in read-only sessions');
});

test('MCP and plugin tools: denied in read-only unless _meta says read-only or the server is allowlisted', () => {
  const ro = capabilityGate(['read'], { mcpReadOnlyServers: ['context7'] }, (t) => (t === 'docs__lookup' ? { readOnlyHint: true } : t === 'docs__pi_ro' ? { 'pi/readOnly': true } : undefined));
  const stamp = { kind: 'use_tool', read_only: false };
  assert.equal(ro('linear__save_issue', stamp).allow, false);
  assert.match((ro('linear__save_issue', stamp) as any).reason, /cannot verify that MCP tool/);
  assert.equal(ro('context7__resolve_library_id', stamp).allow, true, 'server allowlist');
  assert.equal(ro('docs__lookup', stamp).allow, true, '_meta.readOnlyHint');
  assert.equal(ro('docs__pi_ro', stamp).allow, true, '_meta pi/readOnly');
  assert.equal(ro('docs__delete', stamp).allow, false, 'same server, no marker, not allowlisted');
  const rw = capabilityGate(['read', 'bash'], {});
  assert.equal(rw('linear__save_issue', stamp).allow, true, 'a shell-capable Pi session passes MCP tools');
  assert.equal(metaSaysReadOnly({ annotations: { readOnlyHint: true } }), true);
  assert.equal(metaSaysReadOnly({ readOnlyHint: false }), false);
  assert.equal(metaSaysReadOnly(undefined), false);
});

test('post-edit check: built-in syntax check reports a broken TypeScript file, silent on a good one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'grok-hook-'));
  const bad = join(dir, 'bad.ts'); const good = join(dir, 'good.ts');
  await writeFile(bad, 'const x: number = ;\n'); await writeFile(good, 'export const x: number = 1;\n');
  const note = await postEditContext({ file_path: bad }, dir, {});
  assert.ok(note && /Check failed after editing .*bad\.ts/.test(note), note ?? 'no note');
  assert.equal(await postEditContext({ file_path: good }, dir, {}), undefined);
  assert.equal(await postEditContext({ command: 'ls' }, dir, {}), undefined, 'no file, no check');
  assert.equal(editedFile({ target_file: '/a', file_path: '/b' }), '/b');
});

test('post-edit check: configured command with {file}', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'grok-hook-'));
  const f = join(dir, 'x.txt'); await writeFile(f, 'hello\n');
  const note = await postEditContext({ file_path: f }, dir, { postEditCheck: 'grep -q FORBIDDEN {file} && echo "forbidden word present" && exit 1; exit 0' });
  assert.equal(note, undefined);
  await writeFile(f, 'FORBIDDEN\n');
  const note2 = await postEditContext({ file_path: f }, dir, { postEditCheck: 'if grep -q FORBIDDEN {file}; then echo "forbidden word present"; exit 1; fi' });
  assert.match(note2!, /forbidden word present/);
});

test('stop gate: blocks on a failing acceptance command, only for genuine end_turn', async () => {
  const base = { hookCallbackId: 'pi-stop', hookEventName: 'stop', sessionId: 's', cwd: tmpdir() };
  assert.deepEqual(await stopGate({ ...base, reason: 'end_turn' }, {}), { decision: 'continue' });
  const blocked = await stopGate({ ...base, reason: 'end_turn' }, { stopCheck: 'echo "2 tests failed"; exit 1' });
  assert.equal(blocked.decision, 'block'); assert.match(blocked.reason!, /2 tests failed/);
  assert.deepEqual(await stopGate({ ...base, reason: 'channel_closed' }, { stopCheck: 'exit 1' }), { decision: 'continue' }, 'session-end fire is not gated');
  assert.deepEqual(await stopGate({ ...base, reason: 'end_turn' }, { stopCheck: 'exit 0' }), { decision: 'continue' });
});

test('session hook dispatch: gate + log, fail-open on handler error', async () => {
  const session = new GrokModelSession({ isOpen: true } as any, 'pi-h', '/repo');
  session.piToolNames = ['read'];
  const deny = await session.onHookRun({ hookCallbackId: 'pi-pre', hookEventName: 'pre_tool_use', sessionId: 'g', cwd: '/repo', toolName: 'write', toolInput: {} });
  assert.equal(deny.decision, 'deny');
  const cont = await session.onHookRun({ hookCallbackId: 'pi-pre', hookEventName: 'pre_tool_use', sessionId: 'g', cwd: '/repo', toolName: 'hashline_read', toolInput: {} });
  assert.equal(cont.decision, 'continue');
  const unknown = await session.onHookRun({ hookCallbackId: 'x', hookEventName: 'weird', sessionId: 'g', cwd: '/repo' });
  assert.equal(unknown.decision, 'continue');
  assert.equal(session.hookLog.length, 2);
});

test('media tool results: path extracted, transcript record carries mediaPath', async () => {
  const { mediaPath, resultText } = await import('../src/model/session.ts');
  const env = { type: 'ImageGen', path: '/home/u/.grok/sessions/x/images/1.jpg', filename: '1.jpg', session_folder: 'images' };
  assert.equal(mediaPath(env), '/home/u/.grok/sessions/x/images/1.jpg');
  assert.equal(resultText(env), '/home/u/.grok/sessions/x/images/1.jpg');
  assert.equal(mediaPath({ type: 'ReadFile', path: '/x' }), undefined, 'only media envelopes');
  assert.equal(resultText({ FileContent: { raw_output: 'tok\n' } }), 'tok\n');
});

test('inbound image blocks become temp files referenced by path in the prompt text', async () => {
  const { promptTextFor } = await import('../src/model/provider.ts');
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
  const text = promptTextFor([{ role: 'user', content: [{ type: 'text', text: 'what color?' }, { type: 'image', data: png, mimeType: 'image/png' }], timestamp: 1 }], []);
  const m = text.match(/\[attached image: (\S+) /);
  assert.ok(m, text);
  const { readFileSync } = await import('node:fs');
  assert.equal(readFileSync(m![1]).subarray(0, 4).toString('hex'), '89504e47', 'spilled file is the PNG');
  assert.match(text, /what color\?/);
});

test('media copy: Grok media lands in the project mediaDir with a readable name; source kept; off when empty', async () => {
  const { GrokModelSession } = await import('../src/model/session.ts');
  const { mkdtemp, writeFile, readFile, readdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const cwd = await mkdtemp(join(tmpdir(), 'grok-media-'));
  const grokDir = await mkdtemp(join(tmpdir(), '%2Fhome%2Fu%2Fproj-'));
  const src = join(grokDir, '1.jpg'); await writeFile(src, Buffer.from('ffd8ffe0', 'hex'));
  const session = new GrokModelSession({ isOpen: true } as any, 'pi-m', cwd);
  session.grokSessionId = '01a0e5c7-003b-7233-b5a1-6cd0731c92c0';
  const records: any[] = []; session.onToolRecord = (r) => records.push(r);
  const payload = { hookCallbackId: 'pi-post', hookEventName: 'post_tool_use', sessionId: 'g', cwd, toolName: 'image_gen', toolUseId: 'u1', toolInput: { prompt: 'x' }, toolResult: { type: 'ImageGen', path: src, filename: '1.jpg', session_folder: 'images' } };
  await session.onHookRun(payload);
  const r = records[0];
  assert.equal(r.sourcePath, src);
  assert.match(r.mediaPath, new RegExp(`^${cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.pi/grok-images/\\d{8}-\\d{4}-1c92c0-1\\.jpg$`), r.mediaPath);
  assert.equal((await readFile(r.mediaPath)).toString('hex'), 'ffd8ffe0');
  assert.deepEqual((await readdir(join(cwd, '.pi/grok-images'))).filter((f) => f === '.gitignore'), ['.gitignore']);
  session.mediaDir = ''; records.length = 0;
  await session.onHookRun({ ...payload, toolUseId: 'u2' });
  assert.equal(records[0].mediaPath, src, 'copy disabled: Grok path used');
  assert.equal(records[0].sourcePath, src);
});

test('/grok perms: readonly denies writes/shell regardless of Pi tools; ask consults the dialog; auto mirrors', async () => {
  const { GrokModelSession } = await import('../src/model/session.ts');
  const session = new GrokModelSession({ isOpen: true } as any, 'pi-perm', '/repo');
  session.piToolNames = ['read', 'edit', 'write', 'bash'];
  const pre = (tool: string) => session.onHookRun({ hookCallbackId: 'pi-pre', hookEventName: 'pre_tool_use', sessionId: 'g', cwd: '/repo', toolName: tool, toolUseId: 'u', toolInput: {} });
  assert.equal((await pre('hashline_edit')).decision, 'continue', 'auto: full Pi session allows');
  session.permissionMode = 'readonly';
  assert.equal((await pre('hashline_edit')).decision, 'deny');
  assert.equal((await pre('run_terminal_command')).decision, 'deny');
  assert.equal((await pre('hashline_read')).decision, 'continue', 'reads still allowed');
  session.permissionMode = 'ask';
  assert.equal((await pre('hashline_edit')).decision, 'deny', 'ask without a UI behaves as readonly');
  const asked: string[] = []; let answer = true;
  session.askDialog = async (tool) => { asked.push(tool); return answer; };
  assert.equal((await pre('hashline_edit')).decision, 'continue');
  assert.equal((await pre('hashline_read')).decision, 'continue', 'reads never prompt');
  answer = false;
  const denied = await pre('run_terminal_command');
  assert.equal(denied.decision, 'deny'); assert.match(denied.reason!, /declined/);
  assert.deepEqual(asked, ['hashline_edit', 'run_terminal_command']);
});

test('/grok perms yolo: everything allowed regardless of Pi tools, no dialogs', async () => {
  const { GrokModelSession } = await import('../src/model/session.ts');
  const session = new GrokModelSession({ isOpen: true } as any, 'pi-yolo', '/repo');
  session.piToolNames = ['read']; session.permissionMode = 'yolo';
  const asked: string[] = []; session.askDialog = async (tool) => { asked.push(tool); return false; };
  const pre = (tool: string) => session.onHookRun({ hookCallbackId: 'pi-pre', hookEventName: 'pre_tool_use', sessionId: 'g', cwd: '/repo', toolName: tool, toolUseId: 'u', toolInput: {} });
  assert.equal((await pre('hashline_edit')).decision, 'continue');
  assert.equal((await pre('run_terminal_command')).decision, 'continue', 'shell allowed, no dialog');
  assert.deepEqual(asked, []);
});

test('hook decisions retain the last 500 entries without truncating the call count', async () => {
  const session = new GrokModelSession({ isOpen: true } as any, 'pi-log', '/repo');
  session.piToolNames = ['read'];
  for (let n = 0; n < 505; n++) {
    await session.onHookRun({ hookCallbackId: 'pi-pre', hookEventName: 'pre_tool_use', sessionId: 'g', cwd: '/repo', toolName: `read-${n}`, toolUseId: `u-${n}` });
  }
  assert.equal(session.toolCallsSeen, 505);
  assert.equal(session.hookLog.length, 500);
  assert.equal(session.hookLog[0].tool, 'read-5');
  assert.equal(session.hookLog.at(-1)?.tool, 'read-504');
});
