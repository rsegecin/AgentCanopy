import type { Prompt, PromptAnswer } from '../../shared';
import type { NewPrompt } from '../contracts';
import { sha256Hex } from '../util';
import { safeText } from './text';

/** JSON with object keys in sorted order, so equal values always give equal text. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${canonicalJson(item)}`);
    }
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Hash of the fields the user sees. An answer must echo it. */
export function displayHashOf(prompt: NewPrompt): string {
  if (prompt.kind === 'permission') {
    return sha256Hex(
      canonicalJson({
        kind: prompt.kind,
        toolName: prompt.toolName,
        category: prompt.category,
        title: prompt.title,
        detail: prompt.detail,
        inputPreview: prompt.inputPreview,
        choices: prompt.choices,
        alwaysRule: prompt.alwaysRule,
      }),
    );
  }
  return sha256Hex(canonicalJson({ kind: prompt.kind, questions: prompt.questions }));
}

/** A prompt that is waiting for an answer. The turn that asked owns it. */
export interface PendingPrompt {
  readonly prompt: Prompt;
  /** True while a native confirmation for "allow always" is open; no other answer is accepted then. */
  answering: boolean;
  settled: boolean;
  /** Ends the prompt: updates and persists its state, then resolves the waiting policy. */
  settle(state: 'answered' | 'expired' | 'cancelled', answer?: PromptAnswer): void;
}

/** Why an answer cannot be accepted, or undefined when it can. The text is for the log only. */
export function answerProblem(
  entry: PendingPrompt,
  displayHash: string,
  answer: PromptAnswer,
): string | undefined {
  const { prompt } = entry;
  if (entry.settled) return 'the prompt is not pending';
  if (entry.answering) return 'another answer is being confirmed';
  if (displayHash !== prompt.displayHash) return 'the display hash does not match';
  if (answer.kind !== prompt.kind) return 'the answer is of a different kind';
  if (prompt.kind === 'permission' && answer.kind === 'permission') {
    if (!prompt.choices.includes(answer.choice)) return 'the choice is not offered';
  }
  if (prompt.kind === 'question' && answer.kind === 'question') {
    const known = new Set(prompt.questions.map((question) => question.question));
    const keys = Object.keys(answer.answers);
    if (keys.length === 0) return 'no question was answered';
    if (keys.some((key) => !known.has(key))) return 'the answer names an unknown question';
  }
  return undefined;
}

const PROJECT_CODE_SENTENCE =
  'This command runs code from the project, which can do anything you can do.';

/** The text of the native confirmation shown before an "allow always" answer takes effect. */
export function alwaysAllowDetail(prompt: Prompt): string {
  if (prompt.kind !== 'permission') return '';
  const rule = prompt.alwaysRule;
  if (rule === undefined) return prompt.detail;
  const shown = safeText(rule.rule);
  return rule.runsProjectCode ? `${shown}\n\n${PROJECT_CODE_SENTENCE}` : shown;
}
