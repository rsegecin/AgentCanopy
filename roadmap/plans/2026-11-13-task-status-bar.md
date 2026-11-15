# Task status bar above the message box

## Context

While a turn runs, the chat shows one line of free text at the bottom of the transcript ("Starting Claude Code…", "Working…", "Compacting the conversation…"). It scrolls with the log, says nothing about which tool or subagent is active, and disappears when nothing runs, so there is no place that answers "is anything running, and at what stage?" Turns running in other conversations are only visible in the History tab.

The owner wants a status area right above the message box that shows whether any agents are running, what stage the current task is in, and says so explicitly when nothing is running.

## What exists

- `ActiveConversation.activity: string | null` (`src/shared/view-state.ts:30`), set by the host as free text in `src/core/session/turn.ts` (`setActivity`, line 1374; calls at 340, 754, 769, 937, 973-982) and cleared when the turn ends (648).
- The webview renders it inside the log (`src/webview/features/chat/MessageList.tsx:229-233`), falling back to "Preparing…" / "Working…".
- Tool calls are already in the transcript with a status (`running`, `awaiting-approval`, `done`, …), start time and `parentId` (`ToolCallViewSchema`, `src/shared/conversation.ts:70-83`); calls made by a subagent carry the subagent call's id as `parentId`.
- `ConversationSummary.running` and `pendingPrompts` exist for every conversation (`conversation.ts:195-199`).
- Not shown anywhere today: the end-of-turn bookkeeping phase (the tracker's `afterTurn`), during which the turn still counts as running and Stop has no effect.

## Design

### The bar

A single always-visible row in the chat panel, directly above the composer (below the pinned changes card from `2026-11-13-chat-cards-and-concurrent-send.md`, if that is built). Mounted in `src/webview/app/App.tsx`; the activity line inside the log is removed so the stage is shown once.

| State | What the bar shows |
| :- | :- |
| Nothing running in this conversation | "No task running". After a turn: its outcome and when ("Finished 2 min ago", "Stopped", "Failed") |
| Turn running | Stage text, elapsed time since the turn started, and a count of running subagents when there are any |
| Waiting on the user | "Waiting for your approval" or "Waiting for your answer", styled as needing attention; clicking scrolls to the prompt card |
| Other conversations running | A trailing "1 other conversation running" (or "… needs your answer"), in every state above |

The row expands (existing `ui.expanded` map) into a short list:

- **This task**: the stage, and the tool call in progress.
- **Subagents**: one line per running subagent call with its description and the tool it is currently running.
- **Other conversations**: title, running or waiting for an answer; clicking opens that conversation.

Stop stays in the composer; the bar does not duplicate it.

### Stages

`activity` becomes structured so the bar can label, style and announce stages consistently instead of parsing text.

`TurnActivity { stage, detail?, since }`, with stages:

| Stage | Set when | Bar text |
| :- | :- | :- |
| `preparing` | Turn begins; observers' `beforeTurn` (baseline capture) | Preparing… |
| `starting` | The CLI is being launched | Starting Claude Code… |
| `thinking` | Thinking output is streaming | Thinking… |
| `responding` | Text output is streaming | Writing a reply… |
| `tool` | A top-level tool call is running (`detail`: tool call id) | The tool's label, e.g. "Running `npm test`", "Editing src/cache.ts" |
| `waiting-approval` / `waiting-answer` | A permission or question prompt is pending | Waiting for your approval / answer |
| `compacting` | CLI status event | Compacting the conversation… |
| `retrying` | CLI retry or status event (`detail`: attempt of max) | Retrying (2 of 5)… |
| `rate-limited` | CLI rate-limit event (`detail`: reset time) | Rate limited until 14:05 |
| `finishing` | The CLI has ended and end-of-turn bookkeeping runs | Finishing… (Stop is disabled with a hint) |

- The host only writes on a stage transition, never per streamed chunk, so the patch volume stays low.
- The tool label comes from the existing `src/webview/features/chat/tool-present.ts`, looked up by the tool call id, so the bar and the tool cards use the same wording.

### Running agents

- **Subagents** are derived in the webview from data already in view state: tool parts of the running turn whose tool is the subagent tool and whose status is `running`; their current step is the latest running tool call whose `parentId` is that call. No contract change.
- **Other conversations** come from `state.conversations` (`running`, `pendingPrompts`), excluding the open one.
- If the side-question and queue features from the chat-cards plan are built, a running side question counts as a running agent in this list, and the queued-message chip sits in the same strip.

### Accessibility

- The bar is a `role="status"` live region. Stage changes are announced at most once every few seconds, reusing the throttling pattern of `SnapshotStatus` (`SNAPSHOT_ANNOUNCE_MS`); the elapsed timer is not announced.
- The existing "The turn was stopped." announcement in `MessageList.tsx` stays.

## Phases

One green commit per phase on `develop`. The primary model edits `src/shared/`, briefs `implementation` for the rest, and reviews every change.

| Phase | Primary model | `implementation` subagent |
| :- | :- | :- |
| 1. Contract | `view-state.ts`: replace `activity: string` with `TurnActivitySchema` (nullable) | Update fixtures (`src/webview/test-support/fixtures.ts`) and the fallback rendering so everything still builds |
| 2. Host | None | `turn.ts`: set stages at the transitions in the table, including `finishing` around `runAfterTurn` and the waiting stages in `askUser` / `recordPromptState`; tests in `src/core/session/{turns,prompts,observers}.test.ts` |
| 3. Webview | None | `TaskStatus` component and its selectors (stage text, subagents, other conversations, last-turn outcome), mount in `App.tsx`, remove the activity line from `MessageList.tsx`, Stop hint during `finishing`, CSS, tests, preview sample data and screenshots |
| 4. Docs | Review | `docs/guide/agent-mode.md`, `README.md`, `src/webview/ACCESSIBILITY.md` |

## Verification

- Every phase: `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`.
- Host tests: a scripted turn passes through preparing → starting → thinking/responding → tool → finishing → null in order; a pending prompt sets and clears the waiting stage; streaming many text chunks produces one `responding` patch; cancel during each stage ends with `activity` null.
- Webview tests: idle text with and without a previous turn; each stage's text; a running subagent with a nested tool appears in the expanded list and disappears when it ends; another running conversation is listed and clicking it opens it; announcements are throttled.
- `npm run build && node scripts/preview-webview.mjs --check`, then read the screenshots for idle, running with a subagent, and waiting for approval, in the sidebar and the editor-area panel.
- Manual, in the Extension Development Host: run an Agent turn that uses a subagent and a command, watch the bar move through the stages, start a second conversation and confirm the first is listed as running, and confirm the bar reads "No task running" afterwards.

## Not in this change

- Progress inside a tool (for example test counts or a percentage): the CLI does not report it.
- Stopping an individual subagent: the CLI can only stop the whole turn.
- A status-bar item in the VS Code window frame; this bar lives in the chat panel only.
