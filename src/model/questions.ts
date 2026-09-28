// Grok's ask_user_question reaches the client as the ACP extension request `x.ai/ask_user_question`
// (`_x.ai/ask_user_question` on the wire). The response is one of four outcomes Grok's tool already
// understands; Pi maps them onto its own dialogs. No new outcome is invented.
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

export type QuestionOption = { label: string; description: string; preview?: string; id?: string };
export type Question = { question: string; options: QuestionOption[]; multiSelect?: boolean; multi_select?: boolean };
export type AskUserQuestionRequest = { sessionId: string; toolCallId: string; questions: Question[]; mode: 'default' | 'plan' };
export type AskUserQuestionResponse =
  | { outcome: 'accepted'; answers: Record<string, string[]>; annotations?: Record<string, { preview?: string; notes?: string }> }
  | { outcome: 'chat_about_this'; partial_answers: Record<string, string> }
  | { outcome: 'skip_interview'; partial_answers: Record<string, string> }
  | { outcome: 'cancelled' };

const OTHER = 'Other';
const CHAT = 'Chat about this';
const SKIP = 'Skip interview and plan immediately';
const DONE = 'Done selecting';

export type Answerer = (request: AskUserQuestionRequest) => Promise<AskUserQuestionResponse>;

/** Interactive: one Pi dialog per question. Headless: cancelled, which Grok's tool reports to the model as unanswered. */
export function questionAnswerer(ctx: Pick<ExtensionContext, 'hasUI' | 'ui'>): Answerer {
  return async (request) => {
    if (!ctx.hasUI) return { outcome: 'cancelled' };
    const answers: Record<string, string[]> = {};
    const annotations: Record<string, { preview?: string; notes?: string }> = {};
    const partial = () => Object.fromEntries(Object.entries(answers).map(([q, a]) => [q, a[0] ?? OTHER]));
    for (const [index, q] of request.questions.entries()) {
      const multi = q.multiSelect === true || q.multi_select === true;
      const title = `Grok asks (${index + 1}/${request.questions.length}): ${q.question}`;
      const labels = q.options.map((o) => o.description ? `${o.label} — ${o.description}` : o.label);
      const extras = [OTHER, ...(request.mode === 'plan' ? [CHAT, SKIP] : [])];
      const byLabel = new Map(labels.map((l, i) => [l, q.options[i]]));
      const picked: QuestionOption[] = [];
      for (;;) {
        const menu = multi ? [...labels.filter((l) => !picked.includes(byLabel.get(l)!)), ...(picked.length ? [DONE] : []), ...extras] : [...labels, ...extras];
        const choice = await ctx.ui.select(picked.length ? `${title} (selected: ${picked.map((p) => p.label).join(', ')})` : title, menu);
        if (choice === undefined) return { outcome: 'cancelled' };
        if (choice === CHAT) return { outcome: 'chat_about_this', partial_answers: partial() };
        if (choice === SKIP) return { outcome: 'skip_interview', partial_answers: partial() };
        if (choice === DONE) break;
        if (choice === OTHER) {
          const notes = await ctx.ui.input('Your answer', 'Type a reply for Grok');
          if (notes === undefined) return { outcome: 'cancelled' };
          answers[q.question] = [OTHER];
          annotations[q.question] = { notes };
          picked.length = 0;
          break;
        }
        const option = byLabel.get(choice);
        if (!option) continue;
        picked.push(option);
        if (!multi) break;
      }
      if (picked.length) {
        answers[q.question] = picked.map((p) => p.label);
        if (!multi && picked[0].preview) annotations[q.question] = { preview: picked[0].preview };
      }
    }
    const response: AskUserQuestionResponse = { outcome: 'accepted', answers };
    if (Object.keys(annotations).length) response.annotations = annotations;
    return response;
  };
}
