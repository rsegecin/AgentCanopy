import type { ActiveConversation, Aside, AssistantMessage, PatchOp } from '../../shared';
import { canonicalJson } from './prompts';

/** What a side question is projected from: a branch as it is held in memory or stored. */
type BranchData = Pick<ActiveConversation, 'meta' | 'turns' | 'messages' | 'prompts'>;

function assistantOf(data: BranchData, turnId: string): AssistantMessage | undefined {
  return data.messages.find(
    (message): message is AssistantMessage =>
      message.role === 'assistant' && message.turnId === turnId,
  );
}

/**
 * The side question a branch holds, as its parent's card shows it: the one turn named in
 * `meta.aside.turnId`. Undefined for a branch that holds none, or whose turn has not started.
 */
export function projectAside(data: BranchData): Aside | undefined {
  const aside = data.meta.aside;
  if (aside?.turnId === undefined) return undefined;
  const turn = data.turns.find((candidate) => candidate.id === aside.turnId);
  if (!turn) return undefined;
  const user = data.messages.find(
    (message) => message.role === 'user' && message.turnId === turn.id,
  );
  return {
    conversationId: data.meta.id,
    anchor: aside.anchor,
    question: user?.role === 'user' ? user.text : '',
    parts: assistantOf(data, turn.id)?.parts ?? [],
    prompts: data.prompts.filter((prompt) => prompt.turnId === turn.id),
    status: turn.status,
    ...(turn.error !== undefined ? { error: turn.error } : {}),
  };
}

/**
 * The side questions of a conversation: one per branch whose `aside.parentId` is that conversation,
 * oldest first. Branches with nothing to show are left out.
 */
export function asidesOf(branches: readonly BranchData[]): Aside[] {
  return [...branches]
    .sort((a, b) => a.meta.createdAt - b.meta.createdAt)
    .flatMap((branch) => {
      const projection = projectAside(branch);
      return projection ? [projection] : [];
    });
}

/**
 * The operations that bring the parent's `asides` in step with a branch that has just changed by
 * `ops` (already applied to `branch`). Streamed text of the side question's answer is passed on as
 * the same appends; anything else replaces the entry when its projection differs.
 */
export function asideOps(
  asides: readonly Aside[],
  branch: BranchData,
  ops: readonly PatchOp[],
): PatchOp[] {
  const index = asides.findIndex((entry) => entry.conversationId === branch.meta.id);
  const entry = asides[index];
  const turnId = branch.meta.aside?.turnId;
  if (entry && turnId !== undefined) {
    const assistant = assistantOf(branch, turnId);
    const appends: PatchOp[] = [];
    for (const op of ops) {
      const [root, messageIndex, parts, partIndex, field] = op.path;
      if (
        op.op !== 'appendText' ||
        op.path.length !== 5 ||
        root !== 'messages' ||
        typeof messageIndex !== 'number' ||
        parts !== 'parts' ||
        typeof partIndex !== 'number' ||
        field !== 'text' ||
        assistant === undefined ||
        branch.messages[messageIndex] !== assistant ||
        entry.parts[partIndex] === undefined
      ) {
        appends.length = 0;
        break;
      }
      appends.push({
        op: 'appendText',
        path: ['asides', index, 'parts', partIndex, 'text'],
        text: op.text,
      });
    }
    if (appends.length > 0) return appends;
  }
  const projection = projectAside(branch);
  if (!projection) return entry ? [{ op: 'delete', path: ['asides', index] }] : [];
  if (!entry) return [{ op: 'push', path: ['asides'], value: projection }];
  if (canonicalJson(entry) === canonicalJson(projection)) return [];
  return [{ op: 'set', path: ['asides', index], value: projection }];
}
