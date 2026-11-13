import type { Attachment, Message } from '../../shared';
import { neutralizeBlockTags } from './compose';

const OPEN_TAG = '<prior-conversation reconstructed="true">';
const CLOSE_TAG = '</prior-conversation>';
const TRUNCATED_MARK = '[truncated]';
const DEFAULT_MAX_CHARS = 60_000;

/**
 * Makes message text safe to put in the block: no tag of either block survives, and a line that
 * is exactly a section header gets a backslash so it cannot start a section.
 */
function escapeBody(text: string): string {
  return neutralizeBlockTags(text)
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      return trimmed === 'User:' || trimmed === 'Assistant:' ? `\\${line}` : line;
    })
    .join('\n');
}

/** One line naming what the user attached. Selections and diagnostics are named by path only. */
function attachedLine(attachments: Attachment[]): string {
  const names = attachments.map((attachment) => {
    const path = neutralizeBlockTags(attachment.path.replace(/[\r\n]+/g, ' '));
    switch (attachment.kind) {
      case 'file':
        return path;
      case 'folder':
        return path.endsWith('/') ? path : `${path}/`;
      case 'selection':
        return `${path} (selection)`;
      case 'diagnostics':
        return `${path} (diagnostics)`;
    }
  });
  return `Attached: ${names.join(', ')}`;
}

interface Section {
  header: string;
  body: string;
}

function sectionOf(message: Message): Section {
  if (message.role === 'user') {
    const text = escapeBody(message.text);
    if (message.attachments.length === 0) return { header: 'User:', body: text };
    const attached = attachedLine(message.attachments);
    return { header: 'User:', body: text.length > 0 ? `${text}\n${attached}` : attached };
  }
  const lines: string[] = [];
  for (const part of message.parts) {
    if (part.kind === 'text') lines.push(part.text);
    else if (part.kind === 'tool') lines.push(`[tool ${part.call.name}: ${part.call.status}]`);
  }
  return { header: 'Assistant:', body: escapeBody(lines.join('\n')) };
}

function render(section: Section): string {
  return section.body.length > 0 ? `${section.header}\n${section.body}` : section.header;
}

function omittedLine(count: number): string {
  return `[${count} earlier ${count === 1 ? 'message' : 'messages'} omitted]`;
}

function assemble(omitted: number, sections: string[]): string {
  const lines = omitted > 0 ? [omittedLine(omitted)] : [];
  const content = [...lines, ...(sections.length > 0 ? [sections.join('\n\n')] : [])].join('\n\n');
  return content.length > 0 ? `${OPEN_TAG}\n${content}\n${CLOSE_TAG}` : `${OPEN_TAG}\n${CLOSE_TAG}`;
}

/** Cuts a text to `max` characters without splitting a surrogate pair. */
function cut(text: string, max: number): string {
  if (max <= 0) return '';
  let end = Math.min(text.length, max);
  const code = text.charCodeAt(end - 1);
  if (end < text.length && code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/**
 * A plain transcript of the kept messages, for a brand-new provider session when the branch cannot
 * be an exact fork. Tool inputs and outputs, reasoning and notices are not carried.
 */
export function reconstructContext(
  messages: Message[],
  options: { maxChars?: number } = {},
): { text: string; lost: string[] } {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const sections = messages.map(sectionOf);
  const rendered = sections.map(render);

  // Drop whole messages from the oldest end until the transcript fits. Lengths are computed
  // arithmetically (suffix sums) so a long history costs one pass.
  const count = rendered.length;
  const suffix: number[] = new Array<number>(count + 1).fill(0);
  for (let i = count - 1; i >= 0; i -= 1) suffix[i] = suffix[i + 1]! + rendered[i]!.length;
  const lengthWhenDropping = (k: number): number => {
    const kept = count - k;
    if (kept === 0) return OPEN_TAG.length + 1 + CLOSE_TAG.length;
    const omit = k > 0 ? omittedLine(k).length + 2 : 0;
    const content = omit + suffix[k]! + 2 * (kept - 1);
    return OPEN_TAG.length + 1 + content + 1 + CLOSE_TAG.length;
  };
  let dropped = 0;
  while (lengthWhenDropping(dropped) > maxChars && dropped < count - 1) dropped += 1;
  let text = assemble(dropped, rendered.slice(dropped));

  // One message is left and it is still too long: cut its text.
  let truncated = false;
  if (text.length > maxChars && rendered.length > 0) {
    const last = sections[sections.length - 1]!;
    const overhead = assemble(dropped, [`${last.header}\n\n${TRUNCATED_MARK}`]).length;
    const room = maxChars - overhead;
    truncated = true;
    const body = `${cut(last.body, room)}\n${TRUNCATED_MARK}`;
    text = assemble(dropped, [`${last.header}\n${body}`]);
  }

  const lost: string[] = [];
  const hasTools = messages.some(
    (message) => message.role === 'assistant' && message.parts.some((part) => part.kind === 'tool'),
  );
  const hasThinking = messages.some(
    (message) =>
      message.role === 'assistant' && message.parts.some((part) => part.kind === 'thinking'),
  );
  const hasAttachments = messages.some(
    (message) => message.role === 'user' && message.attachments.length > 0,
  );
  if (hasTools) lost.push('Tool inputs and outputs');
  if (hasThinking) lost.push("The model's reasoning");
  if (hasAttachments) lost.push('Files and selections attached to messages');
  if (dropped > 0) lost.push(`${dropped} earlier ${dropped === 1 ? 'message' : 'messages'}`);
  if (truncated) lost.push('Part of the text of the most recent message');
  return { text, lost };
}
