import type { AnyMessage } from '@agentclientprotocol/sdk';

/** One answer per reverse request. No deadlines: only orderly disconnect answers for Pi. */
export class ReverseRequestGuard {
  private readonly gates = new Map<string, (why: string) => void>();
  private readonly answered = new Set<string>();
  private closedReason?: string;
  lateAnswersDropped = 0;

  private readonly reply: (message: AnyMessage) => void;
  constructor(reply: (message: AnyMessage) => void) { this.reply = reply; }

  watch(message: any) {
    if (typeof message?.method !== 'string' || message.id == null) return;
    const id = JSON.stringify(message.id);
    if (this.gates.has(id) || this.answered.has(id)) return;
    const reply = (result: any) => this.reply({ jsonrpc: '2.0', id: message.id, result });
    let answer: ((why: string) => void) | undefined;
    if (message.method === '_x.ai/hooks/run') {
      const event = message.params?.hookEventName;
      if (event === 'pre_tool_use') answer = (why) => reply({ decision: 'deny', reason: `Denied because the Pi session is gone: ${why}.` });
      else if (event === 'post_tool_use' || event === 'stop') answer = () => reply({ decision: 'continue' });
    } else if (message.method === 'session/request_permission') {
      const options: any[] = message.params?.options ?? [];
      const reject = options.find((o) => o?.kind === 'reject_once') ?? options.find((o) => String(o?.kind).startsWith('reject'));
      answer = () => reply(reject ? { outcome: { outcome: 'selected', optionId: reject.optionId } } : { outcome: { outcome: 'cancelled' } });
    } else if (message.method === '_x.ai/ask_user_question') {
      answer = () => reply({ outcome: 'cancelled' });
    }
    if (!answer) return;
    this.gates.set(id, answer);
    if (this.closedReason !== undefined) this.close(this.closedReason);
  }

  settle(message: any): 'forward' | 'drop' {
    if (!message || !('id' in message) || !('result' in message || 'error' in message)) return 'forward';
    const id = JSON.stringify(message.id);
    if (this.answered.has(id)) { this.lateAnswersDropped++; return 'drop'; }
    if (this.gates.delete(id)) this.answered.add(id);
    return 'forward';
  }

  close(why: string) {
    this.closedReason = why;
    for (const [id, answer] of this.gates) {
      this.gates.delete(id);
      this.answered.add(id);
      answer(why);
    }
  }
}
