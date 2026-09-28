import assert from 'node:assert/strict';
import { test } from 'node:test';
import { questionAnswerer, type AskUserQuestionRequest } from '../src/model/questions.ts';

function ui(script: (string | undefined)[], inputs: (string | undefined)[] = []) {
  const selects: { title: string; options: string[] }[] = [];
  return {
    ctx: { hasUI: true, ui: { select: async (title: string, options: string[]) => { selects.push({ title, options }); return script.shift(); }, input: async () => inputs.shift() } as any },
    selects,
  };
}
const req = (questions: AskUserQuestionRequest['questions'], mode: 'default' | 'plan' = 'default'): AskUserQuestionRequest => ({ sessionId: 's', toolCallId: 't', questions, mode });
const q1 = { question: 'Which DB?', options: [{ label: 'Postgres', description: 'relational' }, { label: 'SQLite', description: 'embedded', preview: 'sqlite3 app.db' }] };
const q2 = { question: 'Features?', options: [{ label: 'Auth', description: '' }, { label: 'Cache', description: '' }, { label: 'Search', description: '' }], multiSelect: true };

test('single select answers by label; preview annotation carried for single-select', async () => {
  const { ctx, selects } = ui(['SQLite — embedded']);
  const r = await questionAnswerer(ctx)(req([q1]));
  assert.deepEqual(r, { outcome: 'accepted', answers: { 'Which DB?': ['SQLite'] }, annotations: { 'Which DB?': { preview: 'sqlite3 app.db' } } });
  assert.deepEqual(selects[0].options, ['Postgres — relational', 'SQLite — embedded', 'Other'], 'no plan-mode actions in default mode');
});

test('multi select accumulates until Done; Other captures free text as notes', async () => {
  const { ctx } = ui(['Auth', 'Search', 'Done selecting', 'Other'], ['use MySQL actually']);
  const r = await questionAnswerer(ctx)(req([q2, q1]));
  assert.deepEqual(r, { outcome: 'accepted', answers: { 'Features?': ['Auth', 'Search'], 'Which DB?': ['Other'] }, annotations: { 'Which DB?': { notes: 'use MySQL actually' } } });
});

test('plan mode exposes Chat about this and Skip interview, returning partial answers', async () => {
  const chat = await questionAnswerer(ui(['Postgres — relational', 'Chat about this']).ctx)(req([q1, q2], 'plan'));
  assert.deepEqual(chat, { outcome: 'chat_about_this', partial_answers: { 'Which DB?': 'Postgres' } });
  const skip = await questionAnswerer(ui(['Skip interview and plan immediately']).ctx)(req([q1], 'plan'));
  assert.deepEqual(skip, { outcome: 'skip_interview', partial_answers: {} });
});

test('dismissal and headless both cancel', async () => {
  assert.deepEqual(await questionAnswerer(ui([undefined]).ctx)(req([q1])), { outcome: 'cancelled' });
  assert.deepEqual(await questionAnswerer({ hasUI: false, ui: {} as any })(req([q1])), { outcome: 'cancelled' });
});
