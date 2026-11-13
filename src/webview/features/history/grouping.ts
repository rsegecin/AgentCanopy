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

/** Newest first, grouped by calendar day (local time): Today, Yesterday, then the date. */
export function groupByDay(
  conversations: readonly ConversationSummary[],
  now: number,
): ConversationGroup[] {
  const today = startOfDay(now);
  const yesterday = startOfDay(today - 1);
  const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
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
  }
  return groups;
}
