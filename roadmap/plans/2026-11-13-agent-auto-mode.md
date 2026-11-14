# Auto for Agent mode

## Context

In Agent mode every terminal command asks for approval, including `ls`, and so do web tools, the other tools that need permission (`Skill`, `Monitor`, `ExitPlanMode`, `EnterWorktree`, `Workflow`) and anything outside the folder. Subagent launch, tool search and the other tools Claude Code runs without asking never reach AgentCanopy's policy (corrected on 2026-11-14 against the CLI documentation; see `docs/protocol/claude-cli.md`, section 13). Only edits inside the workspace folder run without asking (`agentCanopy.agent.editApproval: auto`, the default). The owner wants Agent mode to also have an auto setting, where the agent keeps working without an approval for each action.

Approvals are decided by AgentCanopy's own policy in the extension host, not by the CLI: the CLI always runs with `--permission-mode default`, its settings file sends every edit, command, read and web call to the loopback permission tool, and that tool calls `createAgentPolicy().decide()` (`src/core/policy/agent/policy.ts:261-301`). Auto is therefore a change to that one policy.

## Decisions to confirm

These are the recommended answers. The first two set the security posture and are the owner's call.

Confirmed by the owner on 2026-11-14, with the changes recorded under Phase 10 in `docs/planning/2026-11-10-implementation-plan.md`: Auto can also be turned on before the first message of a new conversation, and turning it off takes effect at once, also during a turn.

1. **What Auto approves.** Terminal commands, in addition to in-folder edits. It keeps asking for protected paths, anything outside the folder, web tools, every other tool that asks today and unknown MCP tools (table below). Decided on 2026-11-14: other tools only from an explicit list of verified names, and the documentation check left that list empty.
2. **Commands are approved without a sandbox.** Claude Code's sandbox exists only on macOS, Linux and WSL2, and the owner works on Windows, so requiring it would make Auto unavailable there. The backstops are review, checkpoints and the configuration tripwire, none of which undo what a command does outside the folder, to Git or over the network.
3. **Auto is a per-conversation switch on Agent mode**, not a fourth mode, and turning it on needs a native confirmation.
4. **AgentCanopy's policy decides, not the CLI's `--permission-mode auto`.** Calls the CLI approves on its own never reach the host, which would skip protected-path checks, the file capture taken at the permission request, and the approval record; `inspect()` also stops any turn whose permission mode is not `default` (`policy.ts:305`).

## Design

### What Auto changes

| Call | Agent today | Agent with Auto |
| :- | :- | :- |
| Edit inside the folder | Runs (default) or asks (`editApproval: ask`) | Runs |
| Read inside the folder | Runs | Runs |
| Terminal command (Bash, PowerShell) | Asks unless an always-allow rule matches | **Runs** |
| Tools that need permission (`Skill`, `Monitor`, `ExitPlanMode`, `EnterWorktree`, `Workflow`) and unknown tools | Asks | Asks |
| Subagent launch, tool search and other tools Claude Code runs on its own | Runs (Claude Code decides) | Runs (unchanged) |
| Terminal command that asks to leave the sandbox | Asks | Asks; cannot leave it at all when the turn started with Auto and the sandbox is configured |
| Edit on a protected path (`.git`, `.vscode`, `.claude`, `.husky`, `.devcontainer`, `.mcp.json`, `.env*`, `.npmrc`, `.netrc`) | Asks | Asks |
| Edit or read outside the folder | Asks | Asks |
| Web fetch and web search | Asks | Asks, unless `agentCanopy.agent.auto.webTools` is on |
| Other MCP tools | Asks unless an always-allow rule matches | Asks unless an always-allow rule matches |
| `AskUserQuestion` | Shown to the user | Shown to the user |
| AgentCanopy's own MCP tools | Denied | Denied |

- `agentCanopy.agent.alwaysAskCommands` still wins: with it on, Auto does not cover commands.
- Web tools stay behind a prompt by default because in-folder reads (including `.env`) are already silent, so an unprompted fetch is a way to send file contents out, and fetched pages are the main prompt-injection route for an unattended agent.

### Turning it on

- New `ConversationMeta.agentAuto: boolean` (default false). New conversations and branches start with it off.
- Composer (`src/webview/features/chat/Composer.tsx`): when the mode is Agent, an **Auto** switch next to the mode selector. It posts new `conversation.setAuto { conversationId, on }`.
- Host (`changeConversation` path in `src/core/session/controller.ts`): turning it **on** opens a native `ui.confirm` that states what will run without asking, that commands run with the user's privileges, and whether the sandbox is active. Turning it off needs no dialog. Refused while a turn runs, like a mode change. The dialog is what keeps a compromised webview from enabling it (security comment at `controller.ts:788-807`, which gains this entry).
- **Approve and Execute** on a plan runs in Agent mode with the conversation's current Auto state; the approval dialog says so when Auto is on.

### Policy

- `PolicyContext.conversation` already reaches `decide`. In `decideCommand` and `decideOther`, and in `decideWeb` when the setting allows, return an allow before `ask()` when `conversation.agentAuto` is true, following the existing `editApproval === 'auto'` branch (`policy.ts:146-148`). `decideEdit` treats Auto as `editApproval: auto`.
- New `ApprovalSource` value `'auto'` (`src/shared/conversation.ts:57`), shown on tool cards as "Auto-approved" (`ToolCard.tsx:31-34`), so these calls are not labelled as approved by the user.
- File capture is unaffected: `onPermissionRequest` runs before the policy decides (`turn.ts:1207-1236`), so every edit and command is still recorded for review and checkpoints.
- The CLI invocation, the loopback MCP server and the tracker do not change.
- The Agent-mode paragraph sent to the model (`src/core/conversations/compose.ts:62-63`) says when Auto is on that commands run without approval and that protected paths, paths outside the folder and web access still ask.

### What still protects the user

- **Review and checkpoints**: every in-folder change is recorded, can be rejected per file, and can be restored to before any turn.
- **Configuration tripwire**: a change to tool or editor configuration blocks the next Agent turn until it is kept or reverted. This is the main backstop against an auto-approved command that rewrites configuration.
- **Workspace trust and the project-configuration dialog** still gate every turn.
- **Stop** is available throughout.
- Not covered: effects of commands outside the folder, on Git, on databases and over the network (`curl` is only a command). The confirmation dialog and the docs say this plainly.

### Visible state

- The composer shows the Auto switch state and a short hint ("Commands run without asking").
- The user message badge reads "Agent · Auto" for turns sent with Auto on (new optional `UserMessage.auto`).
- Each auto-approved tool card carries the "Auto-approved" label.

### Settings (machine scope, per C17)

| Setting | Default | Meaning |
| :- | :- | :- |
| `agentCanopy.agent.auto.enabled` | `true` | Offer the Auto switch at all. Off hides it and makes the policy ignore `agentAuto`. |
| `agentCanopy.agent.auto.webTools` | `false` | Let Auto also approve web fetch and web search. |

## Phases

One green commit per phase on `develop`. The primary model edits `package.json`, `src/shared/` and `src/core/contracts/`, briefs `implementation` for the rest, and reviews every change.

| Phase | Primary model | `implementation` subagent |
| :- | :- | :- |
| 0. Decisions | Record in `docs/planning/2026-11-10-implementation-plan.md`: Auto as a deviation from §2.2 ("Commands ask") and how it meets SPEC §8 "Never silently enable unrestricted command execution" (explicit native confirmation per conversation, visible state, labelled calls) | None |
| 1. Contracts | `conversation.ts`: `agentAuto`, `UserMessage.auto`, `ApprovalSource 'auto'`. `protocol.ts`: `conversation.setAuto`. `shared/settings.ts` and `package.json`: the two settings | `vscode/host/settings.ts` mapping, schema default tests |
| 2. Policy and host | None | Policy branches, `setAuto` handler with the native confirm, plan-approval dialog text, model-facing mode text, security comment; tests in `src/core/policy/agent/policy.test.ts`, `src/core/session/{agent,prompts}.test.ts` |
| 3. Webview | None | Composer switch and hint, message badge, tool-card label, preview sample data; tests in `features/chat/{composer,tool-cards,chat}.test.tsx`, accessibility test |
| 4. Docs | Review | `SECURITY.md` (line 20), `docs/guide/agent-mode.md`, `docs/limitations.md`, `README.md` |

## Verification

- Every phase: `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`.
- Policy tests, with Auto on: a command and `TodoWrite` are allowed with `approval: 'auto'` and no prompt; a protected-path edit, an outside edit, an outside read, a web fetch and an unknown MCP tool still prompt; `alwaysAskCommands` makes commands prompt again; the web setting makes web tools run; `AskUserQuestion` still reaches the user. With Auto off, behaviour is unchanged.
- Session tests: `conversation.setAuto` on is ignored when the native confirm is declined, refused during a running turn, and off needs no dialog; a branch starts with Auto off; a command auto-approved in a turn is still captured (reject restores the file).
- Phase 3: `npm run build && node scripts/preview-webview.mjs --check` and read the screenshots for the switch, the badge and the card label.
- Manual, in the Extension Development Host on Windows: turn Auto on, confirm the dialog, ask for a change that runs a command, and check that nothing prompts, cards say "Auto-approved", an edit to `.vscode/settings.json` still prompts, and the changes card appears afterwards.
- `npm run test:live` has an Agent test that expects a command prompt; add an Auto variant and run it only when asked.

## Not in this change

- A model-based classifier that blocks risky commands before they run, as Claude Code's own auto mode has. Without it, Auto approves every command.
- A list or remove screen for always-allow rules (none exists today).
- Using the sandbox automatically where the platform supports it.
