import type { CheckpointSummary, RestoreItem } from '../../../shared';

export const KIND_LABEL: Record<CheckpointSummary['kind'], string> = {
  'agent-turn': 'Agent turn',
  reject: 'Rejected changes',
  restore: 'Restored files',
  recovery: 'Recovered after an interruption',
};

export const ACTION_LABEL: Record<RestoreItem['action'], string> = {
  write: 'Restore content',
  delete: 'Delete',
  chmod: 'Restore permissions',
  rename: 'Undo rename',
  skip: 'Leave as is',
};

/** The time of day, in the user's locale: "14:02". */
export function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** The full date and time, in the user's locale. */
export function formatFull(at: number): string {
  return new Date(at).toLocaleString();
}

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago", or the date for anything older. */
export function formatRelative(at: number, now: number): string {
  const seconds = Math.round((now - at) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${String(hours)} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${String(days)} ${days === 1 ? 'day' : 'days'} ago`;
  return new Date(at).toLocaleDateString();
}

export interface PreviewGroups {
  /** Selectable and without a conflict. */
  ready: RestoreItem[];
  /** Selectable, but something is in the way: the user decides. */
  decision: RestoreItem[];
  /** Not selectable. */
  blocked: RestoreItem[];
}

export function groupItems(items: readonly RestoreItem[]): PreviewGroups {
  const groups: PreviewGroups = { ready: [], decision: [], blocked: [] };
  for (const item of items) {
    if (!item.selectable) groups.blocked.push(item);
    else if (item.conflict !== undefined) groups.decision.push(item);
    else groups.ready.push(item);
  }
  return groups;
}
