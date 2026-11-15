import { EMPTY_VIEW_STATE, applyPatch } from '../../shared';
import type {
  ActiveConversation,
  ConversationId,
  ConversationMeta,
  ConversationSummary,
  Message,
  PatchOp,
  ViewState,
} from '../../shared';
import { canonicalJson } from './prompts';
import type { ViewRecord } from './view';

/** A conversation held in memory because a view shows it or a turn runs in it. */
export interface ConvRuntime {
  readonly id: ConversationId;
  /** Always equal to `active` of every view that shows this conversation. Replaced, never changed in place. */
  data: ActiveConversation;
}

/** The parts of the view state that are the same in every view. */
export type GlobalFields = Pick<
  ViewState,
  | 'trusted'
  | 'folders'
  | 'provider'
  | 'models'
  | 'defaults'
  | 'agentAuto'
  | 'policySettings'
  | 'conversations'
  | 'banners'
>;

const MAX_PREVIEW = 300;

/** One line from the most recent message that has text. */
export function previewOf(messages: readonly Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    let text = '';
    if (message.role === 'user') {
      text = message.text;
    } else {
      for (let part = message.parts.length - 1; part >= 0; part -= 1) {
        const candidate = message.parts[part];
        if (candidate?.kind === 'text' && candidate.text.trim().length > 0) {
          text = candidate.text;
          break;
        }
      }
    }
    const line = text.replace(/\s+/g, ' ').trim();
    if (line.length === 0) continue;
    return line.length > MAX_PREVIEW ? `${line.slice(0, MAX_PREVIEW - 1)}…` : line;
  }
  return '';
}

/** The state shared by the controller and the turn runs: views, loaded conversations and global fields. */
export class SessionState {
  readonly views = new Map<string, ViewRecord>();
  readonly runtimes = new Map<ConversationId, ConvRuntime>();
  /** Conversations with a turn running. */
  readonly running = new Set<ConversationId>();
  readonly previews = new Map<ConversationId, string>();
  global: GlobalFields;

  constructor(
    private readonly listMetas: () => ConversationMeta[],
    /** Called when a view has moved to another conversation or to a draft. */
    private readonly onNavigate: (view: ViewRecord) => void = () => undefined,
    /** Called after a loaded conversation has changed, with the operations that changed it. */
    private readonly onMutated: (runtime: ConvRuntime, ops: readonly PatchOp[]) => void = () =>
      undefined,
  ) {
    this.global = {
      trusted: EMPTY_VIEW_STATE.trusted,
      folders: EMPTY_VIEW_STATE.folders,
      provider: EMPTY_VIEW_STATE.provider,
      models: EMPTY_VIEW_STATE.models,
      defaults: EMPTY_VIEW_STATE.defaults,
      agentAuto: EMPTY_VIEW_STATE.agentAuto,
      policySettings: EMPTY_VIEW_STATE.policySettings,
      conversations: EMPTY_VIEW_STATE.conversations,
      banners: EMPTY_VIEW_STATE.banners,
    };
  }

  /** The state of a view that has just been attached. */
  newViewState(): ViewState {
    return { ...EMPTY_VIEW_STATE, ...this.global };
  }

  /** Changes global fields in every view. Fields that did not change produce nothing. */
  patchGlobal(next: Partial<GlobalFields>): void {
    const ops: PatchOp[] = [];
    const merged: Record<string, unknown> = { ...this.global };
    for (const key of Object.keys(next) as (keyof GlobalFields)[]) {
      const value: unknown = next[key];
      if (canonicalJson(this.global[key]) === canonicalJson(value)) continue;
      ops.push({ op: 'set', path: [key], value });
      merged[key] = value;
    }
    if (ops.length === 0) return;
    this.global = merged as GlobalFields;
    for (const view of this.views.values()) view.apply(ops);
  }

  summaries(): ConversationSummary[] {
    return this.listMetas().map((meta) => {
      const runtime = this.runtimes.get(meta.id);
      return {
        ...meta,
        preview: this.previews.get(meta.id) ?? '',
        running: this.running.has(meta.id),
        pendingPrompts: runtime
          ? runtime.data.prompts.filter((prompt) => prompt.state === 'pending').length
          : 0,
      };
    });
  }

  refreshSummaries(): void {
    this.patchGlobal({ conversations: this.summaries() });
  }

  addRuntime(data: ActiveConversation): ConvRuntime {
    const runtime: ConvRuntime = { id: data.meta.id, data };
    this.runtimes.set(runtime.id, runtime);
    return runtime;
  }

  /** Changes a conversation and every view that shows it, with the same operations. */
  mutate(runtime: ConvRuntime, ops: PatchOp[]): void {
    if (ops.length === 0) return;
    runtime.data = applyPatch(runtime.data, ops);
    const shown = ops.map((op): PatchOp => ({ ...op, path: ['active', ...op.path] }));
    for (const view of this.views.values()) {
      if (view.activeId === runtime.id) view.apply(shown);
    }
    this.onMutated(runtime, ops);
  }

  /**
   * Operations that empty the attachments queued in a view, when there are any, and that end the
   * Auto confirmed for its draft: a draft's Auto is never carried to another conversation or draft.
   */
  private clearDraftOps(view: ViewRecord): PatchOp[] {
    const ops: PatchOp[] =
      view.state.draftAttachments.length > 0
        ? [{ op: 'set', path: ['draftAttachments'], value: [] }]
        : [];
    view.draftAuto = undefined;
    if (view.state.draftAgentAuto) ops.push({ op: 'set', path: ['draftAgentAuto'], value: false });
    return ops;
  }

  /** A different conversation starts with no attachments queued. */
  showConversation(view: ViewRecord, runtime: ConvRuntime): void {
    const previous = view.activeId;
    view.activeId = runtime.id;
    const ops: PatchOp[] = [{ op: 'set', path: ['active'], value: runtime.data }];
    if (previous !== runtime.id) {
      ops.push(...this.clearDraftOps(view));
      // A restore preview belongs to the place it was asked from.
      if (view.state.restorePreview !== null) {
        ops.push({ op: 'set', path: ['restorePreview'], value: null });
      }
    }
    view.apply(ops);
    this.onNavigate(view);
    if (previous !== undefined && previous !== runtime.id) this.release(previous);
  }

  /** A new conversation starts with no attachments queued. */
  showDraft(view: ViewRecord): void {
    const previous = view.activeId;
    view.activeId = undefined;
    const ops = this.clearDraftOps(view);
    if (view.state.restorePreview !== null) {
      ops.push({ op: 'set', path: ['restorePreview'], value: null });
    }
    if (previous !== undefined) ops.push({ op: 'set', path: ['active'], value: null });
    view.apply(ops);
    this.onNavigate(view);
    if (previous !== undefined) this.release(previous);
  }

  /** Forgets a loaded conversation that nothing needs any more. */
  release(id: ConversationId): void {
    if (this.running.has(id)) return;
    for (const view of this.views.values()) {
      if (view.activeId === id) return;
    }
    this.runtimes.delete(id);
  }

  toast(view: ViewRecord, level: 'info' | 'warning' | 'error', text: string): void {
    view.event({ kind: 'toast', level, text });
  }

  toastConversation(id: ConversationId, level: 'info' | 'warning' | 'error', text: string): void {
    for (const view of this.views.values()) {
      if (view.activeId === id) this.toast(view, level, text);
    }
  }
}
