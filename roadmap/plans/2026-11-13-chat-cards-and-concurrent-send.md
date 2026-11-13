# Plan and review as cards in the chat; remove the Plan and Review tabs

## Context

After an Agent turn edited a file under `.claude/agents`, the next turn was refused with "The last turn changed tool or editor configuration. Review those changes before starting another turn." The decision (Keep / Revert) lives in the Review tab, which the message does not name, so the chat was a dead end.

The owner wants a Cursor-style chat instead of tabs:

- The transcript is strictly linear, every event where it happened: **plan request card** → agent activity (as Claude Code shows it) → **plan options card** → agent activity continues with the chosen options → **plan card** → after approval, execution activity → **changes card** pinned at the bottom once the turn has finished.
- The plan card's title opens the proposed plan as read-only Markdown. The card shows the options the user accepted.
- The changes card lists changed files and configuration files with their actions. Clicking a file opens its diff. Per-change (hunk) review stays in the editor only (CodeLens).
- The Plan and Review tabs are removed. Tabs left: Chat, Checkpoints, History.
- The user can send at any moment and can always stop. While the agent works, **Stop and Send are both shown**. A question (Ask mode) runs **concurrently** and is answered in an inline "Side question" card. An instruction (Agent or Plan mode) is **queued** and sent when the turn ends, with **Send now** to stop the turn and send it.

Plans stay structured JSON with immutable versions; no editable `.md`, no change to the plan model or the approval hash check.

## Design

### Changes card (`ChangesDock`)

- Mounted in `src/webview/app/App.tsx` between `<MessageList />` and `<Composer />`, always mounted (renders nothing when empty), so it shows with no open conversation and in the editor-area panel. Driven by `state.review` (folder-scoped).
- **Configuration section**, always shown when `review.configChanges` is non-empty: the warning text, then per file a marker, the path as a button (`config.openDiff`), **Keep** (`config.keep`), **Revert** (`config.revert`, disabled when not revertible). No webview-side lock on these buttons: the native confirm can be cancelled without a state change.
- **Files section**, hidden while an Agent turn runs in the view's folder (new host flag `review.busy`): summary, **Accept All**, **Reject All** (keeping the uncertain-source tick boxes), **Open All in Diff Editor**; rows reuse `ReviewEntryRow` without the expander, path opens the diff (`review.openDiff`); collapsed **Accepted** group. With nothing pending: one collapsed line "No pending changes, N accepted".
- `SnapshotStatus` (baseline progress / degraded warning) moves here from `ReviewView`.
- Bounded height (about `min(40vh, 320px)`) with its own scroll; collapsible through the existing `ui.expanded` map. `Log` in `MessageList.tsx` gets a `ResizeObserver` so it stays pinned to the bottom when the dock appears. `useFocusRecovery` in the dock, falling back to the composer textarea.
- The header warning icon and the tab badge are removed.

### No more refused turns

- **Composer** (`src/webview/features/chat/Composer.tsx`): in Agent mode with pending configuration changes, disable only Send/Enter and show a status hint naming the changes card. The textarea and mode switch stay usable (Ask and Plan are not blocked).
- **Host** (`sendTurn`, `src/core/session/controller.ts:1300`): before `options.gate` (line 1369), refuse an Agent turn with a toast when `tracker.configChanges(folder.key)` is non-empty. Nothing is recorded. This also fixes Approve and Execute, which today records the approval and then has the turn refused. The tracker check in `beforeTurn` stays as the backstop.
- Plan card: Approve and Execute is disabled, with a hint, while configuration changes are pending.
- Texts stop naming a tab and point at the changes card below the chat: `CONFIG_PENDING_MESSAGE` and the end-of-turn notice in `src/core/workspace/tracker/tracker.ts`, `reviewNotice` in `controller.ts`, the `submit_plan` reply in `src/core/session/turn.ts:709`.

### Plan cards

All from existing data; no new message part kind.

1. **Plan request card**: a user message with `mode === 'plan'` (already on `UserMessage`) renders with a checklist icon and a "Plan request" label, in `MessageItem` (`MessageList.tsx`).
2. **Agent activity**: unchanged; tool, thinking and text parts already render in order in every mode. The "Submitted a plan" tool card is hidden, since the two cards after it show the same thing.
3. **Plan options card**: the agent asks its choices *during* the Plan turn with `AskUserQuestion`, before it submits the plan. That is the existing `prompt` part and `QuestionCard` (`src/webview/features/chat/PromptCards.tsx`), which already sits in the transcript where it was asked, pauses the turn, and turns into a read-only record of what was chosen. Changes:
   - In Plan mode the card is presented as "Plan options" (label and styling shared with the plan card's decision list).
   - The Plan-mode paragraph in `src/core/conversations/compose.ts` (and `PLAN_TOOL_DESCRIPTION`) tells the model to put choices to the user with `AskUserQuestion` first, continue with the answers, and submit a plan that follows them, instead of leaving them as decision points inside the plan.
   - Answers given before the first `submit_plan` are buffered in `TurnRun` and recorded as plan decisions once the plan exists (today `recordQuestionDecisions` drops them, `turn.ts:721`), so the plan card can show them.
4. **Agent activity** continues after the answer, in order, then
5. **Plan card**: the registered `plan-update` renderer (`src/webview/features/plan/PlanUpdateCard.tsx`), one card per part.
   - Title button → new `plan.open {planId, version}`; change summary; "Your decisions" from `summarizeDecisions` (the accepted options); **Approve and Execute** (`plan.approve`, disabled while a turn runs or configuration changes are pending); **View changes** (`plan.compare`); **Revert to version N-1** (`plan.revert`); approvals line.
   - If a submitted plan still carries decision points or open questions, they show inside the plan card as a "Still to decide" section using `DecisionPointCard` / `OpenQuestionCard` (`plan.decide`), with the existing warn-only unanswered warning on approval. No separate card is placed out of order.
   - *Current rule*: the current card is the `plan-update` part with the highest version in the conversation for the active plan. It always acts on `latestVersion(plan)` and states the real version ("Version 4, restored by you from version 1"), so it survives user reverts. If a plan exists and no part matches it, one synthetic card renders at the end of the log.
   - *Older cards*: compact and read-only; title opens that version; View changes; **Restore this version** (hidden when its content equals the latest).
6. **Execution message**: the synthetic "Execute plan version N" user message renders as "Plan approved: executing version N", identified by `plan.approvals[].executionTurnId === message.turnId` (not by its text).

`App.tsx` keeps `import '../features/plan';` after `PlanView` is gone: that import is the only thing that registers the card (confirmed: `features/plan/index.ts:7`, sole importer `App.tsx:6`).

### Opening the plan

- New `UiPort.showReadOnlyDocument({ key, title, text, beside? })` in `src/core/contracts/app.ts`, implemented in `src/vscode/host/ui.ts` on `createVirtualDocument` (`src/vscode/plan/virtual-documents.ts`), which gains a stable key (`plan-<planId>-v<version>`) so one version reuses one tab. `beside` is set when the request comes from the editor-area panel, so the document does not cover the chat.
- It opens the read-only Markdown **source**, exactly `renderPlanMarkdown(content)`: what the user reads is the text that is hashed and sent on approval. The rendered preview is not opened automatically, because it can load remote images from model-written plan text, which the webview deliberately never does; VS Code's own Open Preview button remains available.

### Sending while the agent works

The CLI runs one process per turn and closes stdin after the prompt (`src/core/provider/claude/process/runner.ts:187`), so nothing can be added to a running turn. Today the composer swaps Send for Stop and the host refuses a second `turn.send` with "A turn is already running" (`controller.ts:1334`).

**Stop.** `Composer.tsx` shows Stop next to Send whenever the last turn is `running` or `preparing` (it posts the existing `turn.cancel`). Stop keeps a queued message; it does not send it.

**Queued instruction** (Agent or Plan mode while the conversation is busy):

- `turn.send` on a busy conversation is no longer refused: the host stores one queued message per conversation (text, mode, model, and a snapshot of the view's draft attachments, with their image bytes held against `pruneImages`). A second one while one is queued is refused with a toast.
- New view state `active.queued` (nullable) and messages `queue.edit` (back into the composer), `queue.remove`, `queue.sendNow`.
- Shown as a chip above the composer: the text, **Edit**, **Remove**, **Send now**.
- Dispatch: from the run's `onEnded` hook (`controller.ts:1488-1497`), after `runs.delete`, and only when the turn ended `completed`. After Stop, an error, or with configuration changes pending for an Agent message, it stays queued and the chip offers **Send**.
- **Send now**: `run.cancel()`, `await run.done`, then send (the pattern conversation delete already uses, `controller.ts:1119-1123`).
- Kept in memory only: a queued message is lost if the window reloads before it is sent.

**Side question** (Ask mode while the conversation is busy):

- The host creates a branch of the conversation with `store.fork` at the running turn's user message, which already keeps only the finished turns (`forkConversation`, `controller.ts:1166-1187`), without opening it in the view, marks it with new `ConversationMeta.aside { parentId, anchor: { messageId, afterParts } }`, and sends the Ask turn there. Runs are keyed by conversation, Ask is read-only and is not subject to the tracker's folder lock, so it runs alongside the parent. Because the parent is running, the branch's first turn uses a fresh session with the transcript rebuilt (`planFork`, `turn.ts:410-458`): it knows the conversation up to the last finished turn, not the work in progress.
- New view state `active.asides[]`: per side question its conversation id, anchor, question, assistant parts, prompts and turn status, kept in sync by the host for asides whose parent is the open conversation, and rebuilt from the stored branch when the conversation is opened.
- Webview: a "Side question" card rendered in the log at its anchor (after that many parts of the anchored message), showing the question and the streaming answer with the normal part renderers; its own **Stop** (`turn.cancel` for the aside's conversation) and **Open as conversation** for follow-ups. One side question runs at a time per conversation.
- In History the branch is listed under its parent, labelled as a side question.

### Removed

- Webview: `PlanView.tsx`, `PlanSection.tsx`, `ReviewView.tsx`, `ConfigChanges.tsx`, `HunkList.tsx`, the hunk helpers in `review-model.ts`, diagram helpers in `plan-model.ts`, `ui.planClosed`. `Diagram.tsx` and its CSS stay (chat Markdown uses them); `review-*` classes used by `CheckpointsView` and `plan-lock` / `plan-option*` stay.
- Protocol: `plan.openInEditor`, `plan.export`, `review.requestHunks`, `review.acceptHunk`, `review.rejectHunk`; `review.hunks` in view state; `UiPort.showDocument`; `show-tab` narrowed to `chat | history | checkpoints`.
- Accepted losses, recorded in the planning doc: rendered Mermaid and the stage-dependency diagram for plans, clickable file links in the plan, comparing arbitrary versions (N-1 ↔ N remains per card), the "No longer in the plan" list, hunk review in the panel (deviation from C19).

## Phases

One green commit per phase on `develop`. The primary model edits `src/shared/` and `src/core/contracts/`, briefs `implementation` for the rest, and reviews every change. The uncommitted `package.json` / lockfile version bump is left out of these commits.

| Phase | Primary model | `implementation` subagent |
| :- | :- | :- |
| 0. Decisions | Save this plan as `roadmap/plans/2026-11-13-chat-cards-and-concurrent-send.md` (new directory) and point to it from `CLAUDE.md`. `docs/planning/2026-11-10-implementation-plan.md`: C19 deviation, source-first plan document (C11 note), accepted losses, status row | None |
| 1. Additive contracts and host | `protocol.ts`: add `plan.open`. `view-state.ts`: add `review.busy`. `app.ts`: add `showReadOnlyDocument` | `ui.ts`, `virtual-documents.ts`, `plan.open` handler, `review.busy` sync (same predicate as `acceptRefused`), early refusal in `sendTurn`, new texts, security comment at `controller.ts:788-807`, tests |
| 2. Changes card | None | `ChangesDock`, slimmed `ReviewEntryRow`, `App.tsx` (drop Review tab, header icon), composer soft block, `Log` resize pinning, CSS, tests, preview data |
| 3. Plan cards | None | The six items above (including the Plan-mode prompt wording and buffering early answers in `TurnRun`, with core tests), drop the Plan tab, keep the side-effect import plus a test that fails if the card is not registered, prune `plan.css`, tests, preview data |
| 4. Subtractive contracts | Remove the messages, `review.hunks`, `showDocument`; narrow `show-tab` | Delete handlers and hunk syncing, narrow `Tab` in `ui-state.ts`, rewrite core tests that drive hunks through the view (`src/core/session/review.test.ts`) |
| 5. Stop and queue | `view-state.ts`: `active.queued`. `protocol.ts`: `queue.edit`, `queue.remove`, `queue.sendNow` | Stop beside Send, queue storage and dispatch in the controller, attachment snapshot, chip, tests (`turns.test.ts`, `composer.test.tsx`) |
| 6. Side question | `conversation.ts`: `ConversationMeta.aside`. `view-state.ts`: `active.asides` | Aside creation on a busy Ask send, aside sync to the view, the card and its anchoring in `MessageList.tsx`, History label, tests (core session, forks, webview chat) |
| 7. Docs | Review | `README.md`, `docs/guide/*` (plan-mode, reviewing-changes, troubleshooting, agent-mode), `src/webview/ACCESSIBILITY.md` |

Tests that change: `src/webview/app/{app,accessibility,ui-state,styles}.test.*`, `features/review/review.test.tsx`, `features/plan/plan-{view,integration}.test.tsx`, `features/chat/{composer,chat}.test.tsx`, `src/core/session/{review,plans,views,agent}.test.ts` and `test-support.ts`, `src/core/workspace/tracker/git-config.test.ts`, `test/integration/plan-documents.test.ts`, `scripts/preview-webview.mjs`.

## Verification

- Every phase: `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`.
- Phases 1 and 4: `npm run test:integration` (read-only document opens, same key reuses the tab).
- Phases 5 and 6, core tests: a busy Agent/Plan send is queued and dispatched only after the run has fully ended; Stop keeps it; Send now waits for the stopped run before sending; a busy Ask send starts a second run in a branch while the parent keeps running, and the parent's transcript and session are untouched.
- Phases 2, 3, 5, 6, 7: `npm run build && node scripts/preview-webview.mjs --check`, then read the screenshots: chat with the plan sequence, the changes card with configuration and file rows, the empty chat with a pending configuration change, the editor-area panel.
- New tests that pin the original bug: with a pending configuration change, the composer blocks Send in Agent mode and names the card; `turn.send` and `plan.approve` in Agent mode are refused before anything is recorded and before the approval is written; after Keep or Revert the turn runs.
- Manual, in the Extension Development Host: have an Agent turn edit `.claude/agents/<file>`, confirm the card appears when the turn ends, click the path to see the diff, Keep, and send the next turn. Run a Plan turn (also covered by `npm run test:live` for the new prompt wording, only if you ask for it), answer the options card, watch the activity continue and the plan card arrive with those options listed, open the plan from the title, approve, and watch the changes card appear after execution.

## Not in this change

- Steering a running turn (adding a message to it). The CLI offers no documented way; a side question never affects the running agent.
- On Windows a stop is a hard kill, so after **Send now** the CLI session keeps nothing of the stopped turn (`docs/limitations.md:66`); this stays a documented limitation.

- The refusal text possibly rendering twice in the transcript (notice part plus `turn.error`); the refusal no longer reaches the transcript in the normal path.
