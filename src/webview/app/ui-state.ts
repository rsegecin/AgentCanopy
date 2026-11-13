import { useSyncExternalStore } from 'react';
import * as z from 'zod';
import { ModeSchema } from '../../shared';
import type { Mode } from '../../shared';
import type { Host } from './host';
import { useApp } from './context';

export type Tab = 'chat' | 'history' | 'plan' | 'checkpoints';

/** Draft key used while no conversation is open. */
export const NEW_CONVERSATION_KEY = '__new__';

const QuestionDraftSchema = z.object({
  labels: z.array(z.string()),
  other: z.string(),
  otherOn: z.boolean(),
});

/** What the user has picked for one question of a pending question prompt. */
export interface QuestionDraft {
  /** Chosen option labels (one for a single-choice question). */
  labels: readonly string[];
  /** Text typed in the "Other" field. */
  other: string;
  /** Whether "Other" is the chosen answer (or one of them for a multi-select question). */
  otherOn: boolean;
}

const PersistedSchema = z.object({
  tab: z.enum(['chat', 'history', 'plan', 'checkpoints']).catch('chat'),
  drafts: z.record(z.string(), z.string()).catch({}),
  expanded: z.record(z.string(), z.boolean()).catch({}),
  scroll: z.record(z.string(), z.object({ top: z.number(), atBottom: z.boolean() })).catch({}),
  newMode: ModeSchema.optional().catch(undefined),
  newModel: z.string().optional().catch(undefined),
  questions: z.record(z.string(), z.array(QuestionDraftSchema)).catch({}),
  planClosed: z.record(z.string(), z.record(z.string(), z.boolean())).catch({}),
  reviewInclude: z.record(z.string(), z.boolean()).catch({}),
  restoreSelection: z.record(z.string(), z.record(z.string(), z.boolean())).catch({}),
});

export interface UiSnapshot {
  tab: Tab;
  /** Composer text per conversation id (or `NEW_CONVERSATION_KEY`). Empty drafts are not kept. */
  drafts: Readonly<Record<string, string>>;
  /** Tool cards the user opened, by tool call id. */
  expanded: Readonly<Record<string, boolean>>;
  /** Mode and model picked while no conversation is open. */
  newMode: Mode | undefined;
  newModel: string | undefined;
  /** Selections in pending question prompts, per prompt id and then per question index. */
  questions: Readonly<Record<string, readonly QuestionDraft[]>>;
  /** Plan sections the user collapsed, per plan id. */
  planClosed: Readonly<Record<string, Readonly<Record<string, boolean>>>>;
  /** Pending review entries ticked "Include in Reject All", by path. */
  reviewInclude: Readonly<Record<string, boolean>>;
  /** Ticks the user changed in a restore preview, per preview token and then per path. */
  restoreSelection: Readonly<Record<string, Readonly<Record<string, boolean>>>>;
}

interface ScrollPosition {
  top: number;
  atBottom: boolean;
}

const PERSIST_DELAY_MS = 300;
const MAX_SCROLL_ENTRIES = 50;
const MAX_QUESTION_DRAFTS = 30;
const MAX_PLANS = 30;
const MAX_REVIEW_INCLUDE = 1000;
const MAX_RESTORE_SELECTIONS = 5;

/**
 * Purely local UI state: composer drafts, the active tab, expanded tool cards, scroll positions.
 * It is saved with `setState` so a reload of the webview restores it. Nothing here is a source of truth.
 */
export class UiState {
  private snapshot: UiSnapshot;
  private scroll: Record<string, ScrollPosition>;
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly host: Host) {
    const parsed = PersistedSchema.parse(
      typeof host.getState() === 'object' && host.getState() !== null ? host.getState() : {},
    );
    this.snapshot = {
      tab: parsed.tab,
      drafts: parsed.drafts,
      expanded: parsed.expanded,
      newMode: parsed.newMode,
      newModel: parsed.newModel,
      questions: parsed.questions,
      planClosed: parsed.planClosed,
      reviewInclude: parsed.reviewInclude,
      restoreSelection: parsed.restoreSelection,
    };
    this.scroll = parsed.scroll;
  }

  getSnapshot = (): UiSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  setTab(tab: Tab): void {
    this.update({ tab });
  }

  setDraft(key: string, text: string): void {
    const drafts = { ...this.snapshot.drafts };
    if (text === '') delete drafts[key];
    else drafts[key] = text;
    this.update({ drafts });
  }

  setExpanded(id: string, expanded: boolean): void {
    const next = { ...this.snapshot.expanded };
    if (expanded) next[id] = true;
    else delete next[id];
    this.update({ expanded: next });
  }

  setNewMode(mode: Mode): void {
    this.update({ newMode: mode });
  }

  setNewModel(model: string): void {
    this.update({ newModel: model });
  }

  /** Records the selection for one question of a prompt. Only the newest prompts are kept. */
  setQuestionDraft(promptId: string, index: number, draft: QuestionDraft): void {
    const empty: QuestionDraft = { labels: [], other: '', otherOn: false };
    const list = [...(this.snapshot.questions[promptId] ?? [])];
    while (list.length <= index) list.push(empty);
    list[index] = draft;
    const next: Record<string, readonly QuestionDraft[]> = { ...this.snapshot.questions };
    delete next[promptId];
    next[promptId] = list;
    const keys = Object.keys(next);
    if (keys.length > MAX_QUESTION_DRAFTS) {
      for (const old of keys.slice(0, keys.length - MAX_QUESTION_DRAFTS)) delete next[old];
    }
    this.update({ questions: next });
  }

  /** Opens or collapses one section of a plan's view. */
  setPlanSectionOpen(planId: string, section: string, open: boolean): void {
    const closed = { ...(this.snapshot.planClosed[planId] ?? {}) };
    if (open) delete closed[section];
    else closed[section] = true;
    const next: Record<string, Readonly<Record<string, boolean>>> = { ...this.snapshot.planClosed };
    delete next[planId];
    if (Object.keys(closed).length > 0) next[planId] = closed;
    const keys = Object.keys(next);
    if (keys.length > MAX_PLANS) {
      for (const old of keys.slice(0, keys.length - MAX_PLANS)) delete next[old];
    }
    this.update({ planClosed: next });
  }

  /** Ticks or unticks "Include in Reject All" for an entry of the review. */
  setReviewInclude(path: string, include: boolean): void {
    const next = { ...this.snapshot.reviewInclude };
    delete next[path];
    if (include) next[path] = true;
    const keys = Object.keys(next);
    if (keys.length > MAX_REVIEW_INCLUDE) {
      for (const old of keys.slice(0, keys.length - MAX_REVIEW_INCLUDE)) delete next[old];
    }
    this.update({ reviewInclude: next });
  }

  /** Forgets ticks of paths that are not in `paths`, so a file that comes back later starts unticked. */
  pruneReviewInclude(paths: readonly string[]): void {
    const keep = new Set(paths);
    const current = this.snapshot.reviewInclude;
    const next = Object.fromEntries(Object.entries(current).filter(([path]) => keep.has(path)));
    if (Object.keys(next).length === Object.keys(current).length) return;
    this.update({ reviewInclude: next });
  }

  /** Records a tick the user changed in the restore preview with this token. */
  setRestoreSelection(token: string, path: string, selected: boolean): void {
    const next: Record<string, Readonly<Record<string, boolean>>> = {
      ...this.snapshot.restoreSelection,
    };
    const paths = { ...(next[token] ?? {}), [path]: selected };
    delete next[token];
    next[token] = paths;
    const keys = Object.keys(next);
    if (keys.length > MAX_RESTORE_SELECTIONS) {
      for (const old of keys.slice(0, keys.length - MAX_RESTORE_SELECTIONS)) delete next[old];
    }
    this.update({ restoreSelection: next });
  }

  getScroll(key: string): ScrollPosition | undefined {
    return this.scroll[key];
  }

  /** Does not notify: scrolling must not re-render anything. */
  setScroll(key: string, position: ScrollPosition): void {
    const next = { ...this.scroll, [key]: position };
    const keys = Object.keys(next);
    if (keys.length > MAX_SCROLL_ENTRIES) {
      for (const old of keys.slice(0, keys.length - MAX_SCROLL_ENTRIES)) delete next[old];
    }
    this.scroll = next;
    this.schedulePersist();
  }

  /** Writes the state now. Called when the page is hidden so nothing is lost. */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.host.setState({
      tab: this.snapshot.tab,
      drafts: this.snapshot.drafts,
      expanded: this.snapshot.expanded,
      scroll: this.scroll,
      newMode: this.snapshot.newMode,
      newModel: this.snapshot.newModel,
      questions: this.snapshot.questions,
      planClosed: this.snapshot.planClosed,
      reviewInclude: this.snapshot.reviewInclude,
      restoreSelection: this.snapshot.restoreSelection,
    });
  }

  private update(patch: Partial<UiSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of [...this.listeners]) listener();
    this.schedulePersist();
  }

  private schedulePersist(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, PERSIST_DELAY_MS);
  }
}

export function useUi<T>(selector: (ui: UiSnapshot) => T): T {
  const { ui } = useApp();
  return useSyncExternalStore(ui.subscribe, () => selector(ui.getSnapshot()));
}
