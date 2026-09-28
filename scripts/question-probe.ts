// Live: Grok's ask_user_question round trip through the provider's connection/session classes, with a scripted UI
// standing in for Pi's dialog. Also exercises /grok-style commands: set_mode plan/default and /goal status.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig } from '../src/config.ts';
import { GrokModelConnection } from '../src/model/connection.ts';
import { GrokModelSession } from '../src/model/session.ts';
import { questionAnswerer } from '../src/model/questions.ts';

const config = await readConfig();
const cwd = await mkdtemp(join(tmpdir(), 'grok-question-'));
const connection = new GrokModelConnection({ url: config.url, secret: config.secret });
connection.hasUI = true;
const session = new GrokModelSession(connection, 'probe', cwd);
session.hookSettings = {}; session.piToolNames = ['read', 'bash', 'edit', 'write'];
const asked: any[] = []; const dialogs: { title: string; options: string[] }[] = [];
// Scripted UI: pick the option whose label contains "SQLite", else the first real option.
const ui = { hasUI: true, ui: { select: async (title: string, options: string[]) => { dialogs.push({ title, options }); return options.find((o) => /sqlite/i.test(o)) ?? options[0]; }, input: async () => 'n/a' } as any };
const answer = questionAnswerer(ui);
session.ask = async (r) => { asked.push({ questions: r.questions.map((q: any) => ({ q: q.question, opts: q.options.map((o: any) => o.label) })), mode: r.mode }); return answer(r); };
let text = ''; const detach = session.consume((e) => { if (e.kind === 'text') text += e.delta; });

await connection.open();
await session.attach(undefined);
const done = new Promise<any>((resolve) => { const d2 = session.consume((e) => { if (e.kind === 'text') text += e.delta; if (e.kind === 'complete') { d2(); resolve(e.response); } if (e.kind === 'error') { d2(); resolve({ stopReason: 'error:' + e.error.message }); } }); });
session.startPrompt('Use your ask_user_question tool to ask me one question: which database should the project use, with options Postgres and SQLite (give each a short description). Then reply with exactly: chosen=<my answer>');
const r = await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 180_000))]) as any;
const evidence: Record<string, unknown> = { ask: { stopReason: r.stopReason, questionsReceived: asked, dialogsShown: dialogs, answerText: text.trim().slice(-200), ok: asked.length === 1 && /chosen=\s*SQLite/i.test(text) } };

// commands
text = '';
try { await session.setMode('plan'); const g = await session.runCommand('/goal status'); await session.setMode('default'); const c = await session.runCommand('/context'); evidence.commands = { ok: /no goal/i.test(g.text) && g.stopReason === 'end_turn', goalStatus: g.text.slice(0, 160), goalStop: g.stopReason, context: c.text.slice(0, 200) || '(empty text)', contextStop: c.stopReason }; }
catch (error) { evidence.commands = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
detach();
await writeFile(new URL('../evidence/question-probe.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence, null, 1));
await connection.close();
process.exit((evidence.ask as any).ok && (evidence.commands as any).ok ? 0 : 1);
