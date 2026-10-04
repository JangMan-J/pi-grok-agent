// Grok Build as a Pi model. Grok runs its own harness: native tools, permissions, subagents.
// Pi drives turns, shows the stream, and can lend extra tools through Grok's client-hosted
// MCP channel; those are the only tool calls that reach Pi's executor.
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools, type AssistantMessage, type AssistantMessageEventStream, type Message, type Model, type Api, type SimpleStreamOptions, type ToolCall, type ToolResultMessage, type TranscriptContext, type Usage } from '@earendil-works/pi-ai';
import type { GrokModelConnection } from './connection.ts';
import { GrokModelSession, type TurnEvent, type GrokTurnUsage } from './session.ts';
import { createPiToolRoutes, selectPiTools, type PiToolAttribution, type PiToolPolicy } from '../tool-policy.ts';

/** Same marker as model.ts; kept here to avoid importing the extension entry from the provider. */
const GROK_DISPLAY_ONLY = '\u200b[grok-display]';
/** pi-agent-core presents custom messages (ours and other extensions') to the model as user messages. Ours carry a marker. */
function isDisplayOnly(m: Message): boolean {
  if (m.role !== 'user') return false;
  const first = typeof m.content === 'string' ? m.content : m.content.find((c) => c.type === 'text')?.text ?? '';
  return first.startsWith(GROK_DISPLAY_ONLY);
}
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Grok's ACP accepts image blocks but does not see them (promptCapabilities.image: false, verified: a red 1x1 PNG
// answered "Unknown"). Given a file path it reads the image with its own tools and answers correctly, so inbound
// images become temp files referenced from the prompt text.
const IMAGE_DIR = join(tmpdir(), 'pi-grok-images');
/**
 * Write an attached image block to a temp file (0600) and return its path, so Grok (which cannot see ACP
 * image blocks) can read it with its own file tools. Content-addressed: the same bytes reuse the same file.
 */
export function spillImageFile(data: string, mimeType: string): string {
  mkdirSync(IMAGE_DIR, { recursive: true, mode: 0o700 });
  const ext = mimeType.split('/')[1]?.replace('jpeg', 'jpg') || 'bin';
  const file = join(IMAGE_DIR, `${createHash('sha256').update(data).digest('hex').slice(0, 16)}.${ext}`);
  try { writeFileSync(file, Buffer.from(data, 'base64'), { flag: 'wx', mode: 0o600 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  return file;
}

export const GROK_API = 'grok-acp' as Api;
export const MODEL_IDS = ['grok-4.7', 'grok-4.7-build-fast', 'grok-4.6', 'grok-4.5'];
const BATCH_GRACE_MS = 150;
const PREAMBLE_LIMIT = 60_000;
const PI_HARNESS_PROMPT_SECTIONS = ['tools', 'rules', 'docs', 'skills'];

export interface SessionResolver { current(): GrokModelSession | undefined; piTools?: PiToolPolicy; blockedPiExtensions?: Iterable<string>; getPiToolAttributions?: () => readonly PiToolAttribution[]; }

function removeXmlSection(text: string, tag: string): string {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const kept: string[] = [];
  let skipping = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === open) { skipping = true; continue; }
    if (skipping) {
      if (trimmed === close) skipping = false;
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

/**
 * Pi's system prompt describes Pi's own harness tools. Grok does not receive those tool schemas, so sending
 * that prose makes Grok believe tools such as codemode/read/edit are callable when they are not. Keep project
 * and user context, but strip Pi-harness catalog/rule sections before sending `_meta.rules` to Grok.
 */
export function grokRulesFromPiPrompt(systemPrompt: string | undefined): string | undefined {
  let prompt = systemPrompt ?? '';
  for (const section of PI_HARNESS_PROMPT_SECTIONS) prompt = removeXmlSection(prompt, section);
  prompt = prompt.replace(/\n{3,}/gu, '\n\n').trim();
  const bridge = [
    'You are Grok Build running under Pi. Use Grok native tools for files, shell, search, code navigation, images, permissions, subagents, and other harness features.',
    'Pi may lend extra tools over MCP; those callable tools are explicitly named with a pi_ prefix. Do not call or refer to unprefixed Pi harness tools unless they appear in your callable tool schema list.',
  ].join('\n');
  return prompt ? `${bridge}\n\n${prompt}` : bridge;
}

function zeroUsage(): Usage { return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }; }

/**
 * Pi usage from Grok's `turn_completed` accounting. Grok's `inputTokens` includes the cached portion
 * (per-sample frames show input_tokens + cache_read_input_tokens = turn inputTokens); Pi keeps them apart.
 * Cost is what Grok reports (USD ticks / 1e9), attributed to input since Grok gives one number per turn.
 */
function usageFrom(turn: GrokTurnUsage | undefined): Usage {
  const usage = zeroUsage();
  if (!turn) return usage;
  usage.cacheRead = turn.cachedReadTokens;
  usage.cacheWrite = turn.cacheCreationTokens;
  usage.input = Math.max(0, turn.inputTokens - turn.cachedReadTokens - turn.cacheCreationTokens);
  usage.output = turn.outputTokens;
  // Pi's context token calculation uses message.usage.totalTokens as the active conversation context size.
  // Grok's turn_completed accounting is cumulative across all sub-calls in the turn (which can sum past the context window),
  // whereas turn.contextTokens (from session/prompt response _meta.totalTokens) is the size of Grok's actual context.
  usage.totalTokens = turn.contextTokens ?? (usage.input + usage.output + usage.cacheRead + usage.cacheWrite);
  usage.cost = { input: turn.costUsd, output: 0, cacheRead: 0, cacheWrite: 0, total: turn.costUsd };
  return usage;
}

/** Messages after the last assistant message: the new user input and/or tool results. */
/**
 * Messages after the last assistant message, keeping only what is input to Grok: user messages and tool
 * results. Custom messages (our own `grok-media`, `grok-command`, other extensions' notes) are Pi-side display
 * and never become prompt text; otherwise Grok would be told the image it just generated was "attached" and
 * read it back, which Grok Build itself never does.
 */
export function splitTail(messages: Message[]): { history: Message[]; tail: Message[] } {
  let last = -1;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'assistant') { last = i; break; }
  const tail = messages.slice(last + 1).filter((m) => (m.role === 'user' && !isDisplayOnly(m)) || m.role === 'toolResult');
  return { history: messages.slice(0, last + 1), tail };
}

function textOf(content: string | { type: string; text?: string; data?: string; mimeType?: string }[]): string {
  if (typeof content === 'string') return content;
  return content.map((c) => {
    if (c.type === 'text') return c.text ?? '';
    if (c.type === 'image' && c.data) { try { return `\n[attached image: ${spillImageFile(c.data, c.mimeType ?? 'image/png')} — read this file to view it]\n`; } catch { return '[image]'; } }
    return `[${c.type}]`;
  }).join('');
}

/** Render prior conversation for a fresh Grok session that has no history of its own. */
export function renderPreamble(history: Message[]): string {
  const lines: string[] = [];
  for (const m of history) {
    if (m.role === 'user') lines.push(`[user]\n${textOf(m.content)}`);
    else if (m.role === 'assistant') {
      const text = m.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('');
      const calls = m.content.filter((c) => c.type === 'toolCall').map((c) => { const t = c as ToolCall; return `${t.name}(${JSON.stringify(t.arguments)})`; });
      lines.push(`[assistant]\n${text}${calls.length ? `\n[tool calls] ${calls.join('; ')}` : ''}`);
    } else if (m.role === 'toolResult') lines.push(`[tool result ${m.toolName}]\n${textOf(m.content)}`);
  }
  let text = lines.join('\n\n');
  if (text.length > PREAMBLE_LIMIT) text = '…' + text.slice(-PREAMBLE_LIMIT);
  return text;
}

export function promptTextFor(tail: Message[], orphans: ToolResultMessage[], preamble?: string): string {
  const parts: string[] = [];
  if (preamble) parts.push(`Conversation so far (Pi transcript):\n\n${preamble}\n\n---`);
  for (const r of orphans) parts.push(`[tool result ${r.toolName}${r.isError ? ' (error)' : ''}]\n${textOf(r.content)}`);
  for (const m of tail) if (m.role === 'user') parts.push(textOf(m.content));
  return parts.join('\n\n');
}

export function createGrokStream(connection: GrokModelConnection, sessions: SessionResolver) {
  return function streamGrok(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();
    const signal = options?.signal;
    const message: AssistantMessage = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, usage: zeroUsage(), stopReason: 'pending', timestamp: Date.now() };
    const fail = (reason: 'error' | 'aborted', text: string) => {
      message.stopReason = reason; message.errorMessage = text;
      stream.push({ type: 'error', reason, error: message }); stream.end(message);
    };
    (async () => {
      const session = sessions.current();
      if (!session) throw new Error('No active Pi session for the Grok model provider.');
      await connection.open(signal);
      const isNew = !session.grokSessionId;
      const piTools = getCurrentTools(context.messages);
      const piToolAttributions = sessions.getPiToolAttributions?.() ?? [];
      session.piToolNames = piTools.map((t) => t.name);
      session.piToolAttributions = piToolAttributions;
      session.tools = selectPiTools(piTools, sessions.piTools ?? 'extensions', sessions.blockedPiExtensions, piToolAttributions);
      session.piToolRoutes = createPiToolRoutes(session.tools, piToolAttributions);
      await session.attach(grokRulesFromPiPrompt(getCurrentSystemPrompt(context.messages) || undefined));
      await session.applyModel(model.id); // before the effort: grok-4.5 has no xhigh
      await session.applyEffort(options?.reasoning); // Pi's thinking level drives Grok's reasoning_effort
      signal?.throwIfAborted();
      const { history, tail } = splitTail(context.messages);
      const results = tail.filter((m): m is ToolResultMessage => m.role === 'toolResult');
      const orphans = session.promptActive ? session.resolveToolResults(results) : results;
      if (!session.promptActive) {
        const preamble = isNew && history.length ? renderPreamble(history) : undefined;
        const text = promptTextFor(tail, orphans, preamble);
        if (!text.trim()) throw new Error('Nothing to send to Grok: no user message or tool result after the last assistant message (custom messages are not prompt input).');
        session.startPrompt(text);
      } else if (orphans.length) {
        // Results for calls Grok is not waiting on (e.g. after a restart). Let them reach Grok as text on the next prompt.
        throw new Error(`Tool results ${orphans.map((o) => o.toolCallId).join(', ')} do not match any pending Grok tool call.`);
      }
      stream.push({ type: 'start', partial: message });
      if (session.reconnected) {
        const note = `[grok reconnected after: ${session.reconnected}; session ${session.grokSessionId} reloaded]\n`;
        session.reconnected = undefined;
        const index = message.content.push({ type: 'thinking', thinking: note }) - 1;
        stream.push({ type: 'thinking_start', contentIndex: index, partial: message });
        stream.push({ type: 'thinking_delta', contentIndex: index, delta: note, partial: message });
        stream.push({ type: 'thinking_end', contentIndex: index, content: note, partial: message });
      }
      await new Promise<void>((resolve, reject) => {
        let open: { type: 'text' | 'thinking'; index: number } | undefined;
        let batchTimer: ReturnType<typeof setTimeout> | undefined;
        let finished = false;
        // Declared before consume(): consume() flushes buffered events synchronously, and a buffered completion
        // could reach onAbort/finish (which call detach) before a `const` further down was initialized.
        let detach: () => void = () => {};
        const closeBlock = () => {
          if (!open) return;
          const block = message.content[open.index];
          if (open.type === 'text') stream.push({ type: 'text_end', contentIndex: open.index, content: (block as { text: string }).text, partial: message });
          else stream.push({ type: 'thinking_end', contentIndex: open.index, content: (block as { thinking: string }).thinking, partial: message });
          open = undefined;
        };
        const finish = (reason: 'stop' | 'length' | 'toolUse') => {
          if (finished) return; finished = true;
          clearTimeout(batchTimer); detach(); signal?.removeEventListener('abort', onAbort);
          closeBlock();
          message.stopReason = reason;
          stream.push({ type: 'done', reason, message }); stream.end(message); resolve();
        };
        const onAbort = () => {
          if (finished) return; finished = true;
          clearTimeout(batchTimer); detach();
          session.rejectParked('Pi aborted the turn.');
          session.abandonPrompt(); // cancels on Grok and frees the session for the next Pi message
          closeBlock();
          fail('aborted', 'Request was aborted'); resolve();
        };
        const onEvent = (event: TurnEvent) => {
          if (finished) return;
          switch (event.kind) {
            case 'text':
            case 'thought': {
              const type = event.kind === 'text' ? 'text' : 'thinking';
              if (open && open.type !== type) closeBlock();
              if (!open) {
                const index = message.content.push(type === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' }) - 1;
                open = { type, index };
                stream.push(type === 'text' ? { type: 'text_start', contentIndex: index, partial: message } : { type: 'thinking_start', contentIndex: index, partial: message });
              }
              const block = message.content[open.index] as { text?: string; thinking?: string };
              if (type === 'text') { block.text! += event.delta; stream.push({ type: 'text_delta', contentIndex: open.index, delta: event.delta, partial: message }); }
              else { block.thinking! += event.delta; stream.push({ type: 'thinking_delta', contentIndex: open.index, delta: event.delta, partial: message }); }
              return;
            }
            case 'toolcall': {
              closeBlock();
              const toolCall: ToolCall = { type: 'toolCall', id: event.toolCallId, name: event.name, arguments: event.arguments as ToolCall['arguments'] };
              const index = message.content.push(toolCall) - 1;
              stream.push({ type: 'toolcall_start', contentIndex: index, partial: message });
              stream.push({ type: 'toolcall_delta', contentIndex: index, delta: JSON.stringify(event.arguments), partial: message });
              stream.push({ type: 'toolcall_end', contentIndex: index, toolCall, partial: message });
              clearTimeout(batchTimer);
              batchTimer = setTimeout(() => finish('toolUse'), BATCH_GRACE_MS);
              return;
            }
            case 'complete': {
              message.usage = usageFrom(event.usage);
              message.rawStopReason = event.response.stopReason;
              // Grok reports `cancelled` both for our session/cancel and for a rejected permission prompt.
              // Only the former is a Pi abort; a rejected prompt is an ordinary end of turn Grok already narrated.
              if (event.response.stopReason === 'cancelled') { if (signal?.aborted) onAbort(); else finish('stop'); return; }
              finish(event.response.stopReason === 'max_tokens' ? 'length' : 'stop');
              return;
            }
            case 'error': {
              if (finished) return; finished = true;
              detach(); signal?.removeEventListener('abort', onAbort);
              closeBlock();
              const dropped = /connection closed|socket|EPIPE|closed/i.test(event.error.message);
              fail('error', dropped ? `Grok connection dropped mid-turn (${event.error.message}). Send the message again; the next turn reconnects and reloads the Grok session.` : event.error.message);
              resolve();
              return;
            }
          }
        };
        detach = session.consume(onEvent);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
        void reject;
      });
    })().catch((error) => {
      const aborted = signal?.aborted || (error instanceof Error && error.name === 'AbortError');
      fail(aborted ? 'aborted' : 'error', error instanceof Error ? error.message : String(error));
    });
    return stream;
  };
}
