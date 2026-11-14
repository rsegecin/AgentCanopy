import { applyPatch } from '../../shared';
import type {
  ConversationId,
  FolderKey,
  HostMessage,
  PatchOp,
  StatePath,
  ViewEvent,
  ViewState,
} from '../../shared';
import type { Logger, ViewSink } from '../contracts';

/** Text deltas are held back this long so a fast stream becomes a few patches. */
export const TEXT_FLUSH_MS = 30;

function samePath(a: StatePath, b: StatePath): boolean {
  return a.length === b.length && a.every((segment, index) => segment === b[index]);
}

/**
 * One attached view: its state, its sequence number and what it shows. Every change goes through
 * `apply`, which changes the stored state with `applyPatch` and posts the same operations, so a view
 * that applies every patch holds exactly this state.
 */
export class ViewRecord {
  state: ViewState;
  /** Sequence number of `state`: how many patches have been cut for this view. */
  seq = 0;
  ready = false;
  disposed = false;
  /** The conversation this view shows. Undefined: a draft that is not stored yet. */
  activeId: ConversationId | undefined;
  draftFolder: FolderKey | undefined;
  /**
   * The user turned Auto on, in a native dialog, for the conversation this view is about to start,
   * in this folder (the one the dialog named). Host-only; the view state mirrors it as
   * `draftAgentAuto`. Cleared whenever the view moves on. `since` is the time recorded for it when
   * the dialog was confirmed: the conversation it creates stores it as `agentAutoSince`.
   */
  draftAuto: { folder: FolderKey; since: number } | undefined;
  /** Conversation to open once the application has started. */
  initialConversation: ConversationId | undefined;
  /** Bumped by every navigation, so a slow load can tell that the view moved on. */
  navigation = 0;
  searchToken = 0;
  /** Bumped when the file search is asked or closed, so a slow answer can tell it is out of date. */
  fileSearchToken = 0;
  /** Bumped by every refresh of the checkpoint list, so a slow answer can tell it is out of date. */
  checkpointToken = 0;
  /** Bumped by every refresh of the review entries, so a slow answer can tell it is out of date. */
  reviewToken = 0;
  /** When the baseline status was last patched, and the timer that patches it later. */
  baselineAt = 0;
  baselineTimer: NodeJS.Timeout | undefined;
  /** True while the first message of a draft is creating its conversation. */
  creating = false;

  private held: PatchOp[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(
    readonly id: string,
    readonly kind: 'sidebar' | 'panel',
    private readonly sink: ViewSink,
    initialState: ViewState,
    private readonly logger: Logger,
    private readonly flushMs: number = TEXT_FLUSH_MS,
  ) {
    this.state = initialState;
  }

  /** Changes the state now and tells the view: text appends are coalesced, everything else goes at once. */
  apply(ops: PatchOp[]): void {
    if (this.disposed || ops.length === 0) return;
    this.state = applyPatch(this.state, ops);
    if (ops.every((op) => op.op === 'appendText')) {
      this.hold(ops);
      return;
    }
    this.flush();
    this.seq += 1;
    this.post({ type: 'patch', seq: this.seq, ops });
  }

  /** Sends what is held back. Order is kept: anything else for this view goes after it. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.held.length === 0) return;
    const ops = this.held;
    this.held = [];
    this.seq += 1;
    this.post({ type: 'patch', seq: this.seq, ops });
  }

  event(event: ViewEvent): void {
    if (this.disposed) return;
    this.flush();
    this.post({ type: 'event', event });
  }

  /** The full state at the current sequence number. */
  init(): void {
    if (this.disposed) return;
    this.flush();
    this.post({ type: 'init', seq: this.seq, state: this.state });
  }

  dispose(): void {
    this.disposed = true;
    this.ready = false;
    this.held = [];
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.baselineTimer) clearTimeout(this.baselineTimer);
    this.baselineTimer = undefined;
  }

  private hold(ops: PatchOp[]): void {
    for (const op of ops) {
      const last = this.held[this.held.length - 1];
      if (last?.op === 'appendText' && op.op === 'appendText' && samePath(last.path, op.path)) {
        this.held[this.held.length - 1] = { ...last, text: last.text + op.text };
      } else {
        this.held.push(op);
      }
    }
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, this.flushMs);
  }

  /** A view that has not sent `ready` is told nothing; its `init` carries everything it missed. */
  private post(message: HostMessage): void {
    if (!this.ready) return;
    try {
      this.sink.post(message);
    } catch (error) {
      this.logger.warn('a view could not be updated', {
        view: this.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
