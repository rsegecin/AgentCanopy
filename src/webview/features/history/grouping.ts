import type { ConversationSummary } from '../../../shared';

export interface ConversationGroup {
  label: string;
  conversations: ConversationSummary[];
}

function startOfDay(timestamp: number): number {
  const d = new Date(timestamp);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const dateFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});

/**
 * True when the conversation is a side question whose parent is in the list: it is listed under
 * that parent. A side question whose parent is gone (or is itself one) stands on its own.
 */
export function isNestedAside(
  conversation: ConversationSummary,
  byId: ReadonlyMap<string, ConversationSummary>,
): boolean {
  if (conversation.aside === undefined) return false;
  const parent = byId.get(conversation.aside.parentId);
  return parent !== undefined && parent.aside === undefined;
}

/**
 * Newest first, grouped by calendar day (local time): Today, Yesterday, then the date. A side
 * question follows its parent, in the parent's group, whatever its own date.
 */
export function groupByDay(
  conversations: readonly ConversationSummary[],
  now: number,
): ConversationGroup[] {
  const today = startOfDay(now);
  const yesterday = startOfDay(today - 1);
  const byId = new Map(conversations.map((c) => [c.id as string, c]));
  const asidesOf = new Map<string, ConversationSummary[]>();
  const standing: ConversationSummary[] = [];
  for (const conversation of conversations) {
    if (conversation.aside !== undefined && isNestedAside(conversation, byId)) {
      const list = asidesOf.get(conversation.aside.parentId) ?? [];
      list.push(conversation);
      asidesOf.set(conversation.aside.parentId, list);
    } else standing.push(conversation);
  }
  const sorted = standing.sort((a, b) => b.updatedAt - a.updatedAt);
  const groups: ConversationGroup[] = [];
  const byDay = new Map<number, ConversationGroup>();
  for (const conversation of sorted) {
    const day = startOfDay(conversation.updatedAt);
    let group = byDay.get(day);
    if (!group) {
      const label =
        day >= today ? 'Today' : day === yesterday ? 'Yesterday' : dateFormat.format(day);
      group = { label, conversations: [] };
      byDay.set(day, group);
      groups.push(group);
    }
    group.conversations.push(conversation);
    const asides = asidesOf.get(conversation.id);
    if (asides) group.conversations.push(...asides.sort((a, b) => b.updatedAt - a.updatedAt));
  }
  return groups;
}
