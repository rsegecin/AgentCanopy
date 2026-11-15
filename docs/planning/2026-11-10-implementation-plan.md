# AgentCanopy — implementation plan

## Status

| Phase | State |
| :- | :- |
| 0. Foundations | Done (scaffold, spike, contracts) |
| 1. Foundation | Done. Ask-mode turns run end to end; verified with the fake CLI, in VS Code, and live against the real CLI |
| 2. Ask mode | Done. Guard and tripwire verified live against the real CLI |
| 3. Plan mode | Done. Plan submission and the plan lock verified live against the real CLI; the plan view and Mermaid rendering verified in a real browser under the CSP |
| 4. Agent mode | Done. Verified live against the real CLI; an independent review found 3 blockers and 5 major issues in change tracking, all fixed with regression tests |
| 5. Review changes | Done. Verified live against the real CLI and in VS Code; an independent review found 2 blockers in snapshot cleanup and 4 other issues, all fixed with regression tests |
| 6. Forking and checkpoints | Done. Exact and rebuilt branches and checkpoint restore verified live against the real CLI; a four-reviewer pass found 2 blockers and 9 major issues, all fixed with regression tests |
| 7. Polish and release | Done. Accessibility pass, documentation, security review (1 critical, fixed and verified live), VSIX built, installed in a clean profile and tested there |
| 8. Pasted images | Done in code. Image input through `--input-format stream-json` probed live on Windows (CLI 2.1.323): image read, resume, whole and cut forks, Ask-mode permission flow, 5.85 MB image. Unit and integration tests pass; the chip renders in the preview under the CSP. Not yet tried by hand in VS Code; the live image test is written and not run |
| 9. Chat cards and concurrent send | Done in code (plan: `roadmap/plans/2026-11-13-chat-cards-and-concurrent-send.md`). Unit tests and the VS Code integration tests pass; every card renders in the preview under the CSP. Each phase was reviewed by independent reviewers and what they confirmed was fixed with regression tests. Not yet tried by hand in VS Code; the live tests were not run, so the new Plan-mode prompt wording is unverified against the real CLI |
| 10. Auto for Agent mode | Done in code (plan: `roadmap/plans/2026-11-13-agent-auto-mode.md`, as corrected below). Unit tests and the VS Code integration tests pass; the switch and its marks render in the preview under the CSP. The policy, the host state and the documentation went through four rounds of independent review, and what they confirmed was fixed with regression tests. Not yet tried by hand in VS Code, on Windows in particular; the live tests, including the new Auto variant, were not run, and the CLI facts in `docs/protocol/claude-cli.md` section 13 come from the documentation, not from a probe |
| 11. Saved permissions and the Permissions view | In work. Resumed by the owner on 2026-11-15 after stages s0 (decisions) and s1 (contracts) of six. A fix to the path judgement precedes s2: path forms the host cannot be sure to resolve like the CLI now ask. No other permission decision has changed yet. The plan, its stages and their progress are in `roadmap/plans/2026-11-15-saved-permissions.md` |

Approved by the owner on 2026-11-10. Updated at every phase commit.

Phase 9 (added 2026-11-13 at the owner's request): the Plan and Review tabs are replaced by cards in the chat (plan request, plan options, plan, changes), and a message can be sent while a turn runs (queued instruction, concurrent side question). Decisions and deviations:

- **Deviation from C19**: hunk actions are no longer offered in the panel. They stay in the editor (CodeLens, decorations) and in commands. The changes card lists files and opens their diffs.
- **Note on C11**: the plan card's title opens the plan as read-only Markdown source, exactly the text that is hashed and sent on approval. The rendered preview is not opened automatically, because it can load remote images from model-written text; VS Code's own Open Preview stays available. Executing a plan still goes through the native modal.
- **Accepted losses**: rendered Mermaid and the stage-dependency diagram for plans, clickable file links in the plan, comparing arbitrary plan versions (each card compares with the version before it), the "No longer in the plan" list, exporting a plan as an untitled document.
- A queued message is kept in memory only and is lost if the window reloads before it is sent. A side question knows the conversation up to the last finished turn, not the work in progress, and never affects the running turn.

Decided while Phase 9 was built (not in the plan as written):

- **The mode can be changed while a turn runs.** The host refuses to change a conversation's mode under a running turn, so without this a side question could not be reached during an Agent turn, nor a Plan message queued behind one. The choice is kept in the view and applies to the next message; the running turn is not affected.
- A side question's branch has its own copy of the plan, like any other branch, so the plan is attached read-only to the question. Its first turn always starts a new session with the transcript rebuilt, and never holds or copies the parent's session.
- A queued Agent message also waits while an Agent turn of another conversation runs in the folder, instead of being used up by a turn the tracker refuses. An Ask message sent in the instant a turn is ending is queued and sent as an ordinary turn.
- Editing a queued message returns its text through `prefill-composer`, which now goes in front of what the user typed instead of replacing it.
- The plan card still lists decisions whose question is no longer in the plan, each tagged "No longer in the plan"; only the separate list is gone.
- The hint to reject the whole file, for a single change that may hold the user's own work, moved from the panel to the editor with the hunk actions.
- In a branch, turns copied from the original conversation show the execution message with its stored text ("Execute plan version N") and carry no plan options cards: the label is found through the plan's approvals, which a copy of a plan does not keep, and branches never carried prompts. Marking the message itself would need a new stored field, which the plan rules out ("no new message part kind"), so this is a documented limitation.
- Send now does not stop the turn when the queued Agent message could not be sent afterwards (configuration changes pending, or another conversation's Agent turn in the folder). Approve and Execute is refused before its dialog in the second case too. Once such a blocker clears, the user presses Send: only the end of the conversation's own turn sends a queued message by itself.
- Queued messages together hold at most 20 MB of pasted images.
- The read-only check after an Ask or Plan turn names an Agent turn in the folder as a possible cause of changed files, since a side question normally runs while one edits.
- `roadmap/` is excluded from Prettier, like `docs/`.

Phase 8 (added 2026-11-12 at the owner's request): images pasted into the composer. The plan's "Images are not supported in the first version" (section 2) is lifted. Image bytes stay in the extension host's memory until the turn ends and are never stored; the conversation keeps a reference (SHA-256, type, size). A turn with images adds `--input-format stream-json` and sends one stream-json user line; every other turn is sent exactly as before. No Agent SDK.

Phase 10 (added 2026-11-14 at the owner's request): an **Auto** switch for Agent mode, per conversation, with which the policy approves terminal commands (and edits inside the folder) without a prompt for each one.

- **Deviation from section 2.2** ("Commands ask: once, always, or deny with feedback"): with Auto on, commands run without asking. Everything else of section 2.2 stands: protected paths, anything outside the folder, web tools and external tools still ask, and `bypassPermissions` is never used. The decision stays in AgentCanopy's policy; the CLI still runs with `--permission-mode default`.
- **SPEC section 8** ("Never silently enable unrestricted command execution", "No unrestricted command execution by default"): Auto is off by default, off for every new conversation, branch and side question, and can only be turned on by the user through a native dialog that says what will run without asking and what review and checkpoints cannot undo. While it is on it is visible in the composer, on every message sent with it, on every call it approved ("Auto-approved") and in History, and it can be turned off at any moment, also during a turn.
- **Owner's decisions (2026-11-14).** Commands are approved without requiring the sandbox, since it does not exist on Windows; the dialog states what is known about it. Auto can be turned on before the first message of a new conversation. Turning it off takes effect at once, also for a running turn; turning it on is only possible between turns. Other tools are approved only from an explicit list of verified names.
- **That list is empty.** The documentation check (`docs/protocol/claude-cli.md`, section 13) showed that the harmless tools the roadmap had in mind (subagent launch, tool search) never ask, so the host is not consulted about them, and that every other tool that does ask (`Skill`, `Monitor`, `ExitPlanMode`, `EnterWorktree`, `Workflow`) must keep asking. Auto therefore covers commands, edits inside the folder and, by setting, web tools; `Monitor` and `Skill` are named in the ask rules so that this is the host's decision and not the CLI's default.
- **Sandbox escape.** A turn that starts with Auto and the sandbox configured sets `sandbox.allowUnsandboxedCommands: false`, so a command cannot leave the sandbox in that turn, and a command that carries `dangerouslyDisableSandbox` is never approved by Auto. The roadmap only said such a command asks; whether the host sees that field is not documented, so the escape is closed where it does not depend on it.
- **Decided while Phase 10 was built**, each after a review found the gap:
  - Auto is decided once per send, where the execution profile is built, and can only tighten afterwards, so the sandbox lock, the plan approval dialog and the turn always agree.
  - One function answers "is Auto on" for the whole host. A conversation whose off could not be saved stays off in the host until a later write succeeds (after a window reload the disk is the truth, and the warning says so). A failed write of on leaves it off.
  - A draft's Auto stays with the conversation whatever the mode of its first message, because the dialog the user confirmed said so. Turning it off while that message is being sent is honoured.
  - Settings that narrow Auto (`alwaysAskCommands` on, `auto.webTools` off, `auto.enabled` off) take effect at once, also for a running turn, and stay in effect for the rest of that turn even when changed back; a setting that widens it applies from the next turn.
  - Turning `auto.enabled` off resets Auto on the whole machine: global storage keeps when it was last seen off and the highest time given to an Auto turned on, and each conversation stores when its Auto was turned on (`agentAutoSince`), so a conversation in a workspace that was closed meanwhile is off when it is opened again. Every doubt fails closed: a file that cannot be read or used counts as a reset now, and a reset that could not be saved is retried and announced. It is only noticed while AgentCanopy is running in some window.
  - The dialog shows the folder's path first (not its display name, which a workspace file can set) and cuts the conversation title, which the webview can set, with control and invisible characters written out; Auto can only be turned on for the conversation the view shows.
  - A command that carries `dangerouslyDisableSandbox` always asks, with or without Auto, and no always-allow rule applies to it.

Phase 11 (added 2026-11-15 at the owner's request): per workspace folder, the user can save permissions from a permission card ("Always allow" for reads outside the folder by directory, for web fetch by site and for a plain PowerShell command), turn on three Ask/Allow switches (reads outside the folder, web fetch, web search), and see and revoke all of it in a Permissions view that also lists the Bash and MCP rules saved since Phase 4.

- **Owner's decisions (2026-11-15).**
  1. The settings area lists the saved permissions and also has an Ask/Allow switch per kind.
  2. Switches exist for reads outside the folder, web fetch and web search. Not for commands (Auto is that switch, per conversation) and not for MCP tools.
  3. Switches and saved permissions belong to one workspace folder. Another project asks again.
  4. Edits outside the folder and edits to protected files keep asking every time; they get no "Always allow".
- **Deviation from section 2.2** ("reads outside ask", "Network, unknown and external tools ask"): a read or search outside the folder, a web fetch and a web search no longer ask when the user saved a permission that covers the call or turned the folder's switch on. This holds in Ask, Plan and Agent mode alike. Everything else of section 2.2 stands: the decision stays in AgentCanopy's policy, the CLI still runs with `--permission-mode default` and the same ask rules, and nothing new is passed to it. In Ask and Plan the web tools still exist only while `agentCanopy.ask.webTools` is on.
- **SPEC section 8** ("Never silently enable unrestricted command execution", "No unrestricted command execution by default"): nothing is saved and every switch is off until the user acts. Every widening (a saved permission, a switch turned on, a folder added in the view) needs a native dialog that names the workspace folder and what stops asking; the webview can only take permissions away. What is saved is visible and removable in the Permissions view, a removal applies to the next request of a running turn, and a call allowed this way is labelled "Approved by you". No switch covers commands.
- **Always asks, whatever is saved.** Credential locations under the home directory (`.ssh`, `.aws`, `.azure`, `.gnupg`, `.kube`, `.docker`, `.config`, `.claude`, `.claude.json`, `.npmrc`, `.netrc`, `.git-credentials`, `.pypirc`, `AppData` on Windows, `Library` on macOS) and AgentCanopy's own storage directories. A filesystem root, the home directory and its ancestors cannot be saved as a directory. The list is a backstop, not a complete inventory of secrets.
- **No "Always allow" for non-MCP tools** (`Skill`, `Monitor`, `ExitPlanMode`, `EnterWorktree`, `Workflow`, unknown tools). Phase 10 decided that such tools are approved only from an explicit list of verified names, and that list is empty; `Monitor` runs a command under Bash's rules and approving `ExitPlanMode` can switch the session's permission mode (`docs/protocol/claude-cli.md`, section 13). A by-name rule would undo that.
- **Storage.** The rule store of Phase 4 is unchanged (Bash commands and MCP tools, in the CLI's rule syntax, still passed as allow rules). Switches, directories, sites and PowerShell commands live in a second per-folder store in the extension's workspace storage, read by the policy at every request and never passed to the CLI.
- **CLI facts** (from the documentation, not probed; `docs/protocol/claude-cli.md`, section 13): `WebFetch` does not follow a redirect to another host but reports it, so the agent's second call is judged on its own host; the `PowerShell` tool carries its command in `command`, like `Bash`.

Further deviations, decided during Phases 6 and 7:

- The repository's own Claude Code configuration (`.claude/settings*.json`, `.mcp.json`) is used only after the user agrees in a native dialog, pinned to the files' content. The security review showed it can start programs and change the environment with no prompt; ignoring it also skips the project's CLAUDE.md, so it is the user's choice. Not in the original plan.
- Every command, read and web call now reaches AgentCanopy's policy (ask rules in the settings file). This replaces C6's "commands keep Claude Code's matcher": commands Claude Code would run on its own, such as `ls`, now ask unless the user chose "Always allow".
- Mermaid's ELK layout engine (EPL-2.0) is not shipped; diagrams use the classic layout.
- The setting `agentCanopy.log.includeContent` was removed: nothing implemented it.

Deviation from the approved plan (Phase 4): the "proceed unprotected" option of C7 was not built. A turn without a baseline cannot be reviewed or undone, so the turn waits for the baseline with progress shown and can be cancelled instead.

Spike result (2026-11-11): all eleven gates passed; details in `docs/protocol/claude-cli.md`. One refinement follows from it. The model often writes files through `Bash`, so Agent mode brackets every tool call with PreToolUse and PostToolUse hooks and scans after each command. A change made inside a command's window is attributed to that command and stays in Reject All; only changes outside every tool window are "unattributed" (this narrows C2).

## Context

AgentCanopy is a free, MIT-licensed VS Code extension that gives standard VS Code a Cursor-like agent experience (Ask, Plan and Agent modes, forking, change review, checkpoints, history) on top of the user's locally installed Claude Code CLI. The owner's specification is in `docs/SPEC.md`. It asks for working software with tests, documentation and a VSIX, not a mockup.

Research and a draft architecture were committed as `docs/planning/2026-11-10-research-and-architecture.md` (commit `61c8936`, branch `develop`). No code exists yet. This plan finalizes that draft. Since the draft, the open documentation facts were re-checked at the source and an independent design review attacked the architecture; section 1.3 lists what changed as a result. The evidence for CLI and VS Code claims stays in section 5 of the notes and is not repeated here.

The outcome is an installable VSIX that meets the spec's Definition of Done (section 18), with every limitation documented instead of hidden.

## 1. Decisions

### 1.1 Owner decisions

| Topic | Choice |
| :- | :- |
| Fork from an earlier message | Use `--resume-session-at` when the installed CLI accepts it, fall back to reconstructed context, label each branch exact or reconstructed, setting to turn the flag off |
| Live tests | One protocol spike plus a short smoke suite after provider-affecting phases. Small prompts, Haiku, scratch folder |
| Git | Local commit on `develop` after each phase passes build, lint and tests. Never push |
| Sandbox | Opt-in setting, off by default |
| Where this plan lives | New file `docs/planning/2026-11-10-implementation-plan.md`; the notes file stays as the evidence record |

### 1.2 Kept from the draft

Spawn the user's unmodified `claude` binary, no Agent SDK. One process per user turn. A loopback HTTP MCP server in the extension host provides the permission prompt tool and `submit_plan`. Native `AskUserQuestion` for interactive questions. Content-addressed snapshot store, no git and no shadow git. No runs in untrusted workspaces. Minimum CLI 2.1.295 (changelog entry confirmed). Mode instructions travel in a tagged block at the start of the user message, which also means a prompt never starts with a slash command.

### 1.3 Changes since the draft

| # | Change | Reason |
| :- | :- | :- |
| C1 | **Only operations advance file state.** An agent turn or an AgentCanopy write is an operation. A difference between the disk and the last operation's after-state is a foreign delta: it is recorded, and the review baseline is rebased over it by 3-way merge. If that merge conflicts, the entry becomes mixed | Review blocker: observing a user's edit at the next turn made it "known state", so a later Reject silently deleted it |
| C2 | **Inferred attribution never takes a destructive fast path.** Changes seen during a turn with no file-tool call behind them are a separate "unattributed" class, left out of Reject All unless ticked. Entries recovered after a crash always go through the conflict flow | Review blocker: a `git pull` or an editor save during a long command, or days of work after a crashed turn, would have been reverted as agent changes |
| C3 | **Configuration tripwire.** Agent turns hash Claude Code and editor configuration (`.claude/settings*.json`, skills and hooks, `.mcp.json`, `.vscode`, `.git/hooks`, `.git/config`, at the folder and the git root) before and after. A change is flagged with its diff and must be kept or reverted before the next turn. Always-allow rules for commands that run project code are labelled as such | Review blocker: an always-allowed command such as `npm test` runs project code that could rewrite those files and approve everything later |
| C4 | **Sandbox as an opt-in setting.** When on, the settings file enables Claude Code's sandbox with `autoAllowBashIfSandboxed: false`, and the UI shows a sandboxed or unsandboxed state | Owner decision. Verified in the spike before it is offered |
| C5 | **Edits are forced through the host.** Agent mode's settings file carries `permissions.ask` rules for the edit tools, so capture happens when the request arrives. If the spike confirms hooks work through `--settings`, a PreToolUse HTTP hook that blocks on failure runs alongside as the barrier for every tool call. A file-tool call seen in the stream with no host request is shown as an unverified edit | Docs confirm ask beats allow, but a `PermissionRequest` hook or a plugin can still decide first |
| C6 | **Commands keep Claude Code's matcher.** AgentCanopy's always-allow rules go into the settings file. Tool cards show one of three sources: you approved, AgentCanopy policy, or not asked (Claude Code allowed it). Setting `alwaysAskCommands` adds a `Bash` ask rule | Re-implementing shell matching is a security risk; the host cannot tell which Claude Code rule allowed a call, so it does not pretend to |
| C7 | **Baseline is pre-warmed, not coupled to the first prompt.** Content capture runs in a worker from activation, most recently modified first. An Agent turn waits for it with progress and an explicit "proceed unprotected". Text cap 10 MB, manifests and lockfiles always captured, total budget 512 MB (settings). Ask and Plan turns do a stat-only pass | Measured here: a 63,000-file, 1.3 GB tree takes 0.4 to 1 s to walk and about 9 s to hash. The draft's 1 to 2 MB cap made a rewritten lockfile unrestorable |
| C8 | **One log per workspace folder** holding operations, foreign deltas and review decisions. Review state is a pure fold over it; a hunk-accept stores its new baseline as a blob the GC keeps | The draft's review state could not be derived from the timeline, and undoing a restore could not bring entries back |
| C9 | **Restore is planned, preflighted and verified.** Plan, check blockers, conflicts and free space, capture a safety copy, write by temp file and rename, verify hashes, record per path what was achieved. Refused while a turn or an orphaned CLI is alive | A blocked `rmdir` or a full disk would have left a half-restore or a truncated file |
| C10 | **Path identity comes from the filesystem** (device, inode, on-disk name), not from unconditional NFC or case folding. Parent realpath is re-checked around every write; deletes are `unlink` and non-recursive `rmdir` only | Unconditional folding merges distinct files on Linux; symlinks and case-only renames can turn a restore into data loss |
| C11 | **High-impact approvals use a native modal**: creating an always-allow rule, overwriting on conflict, executing a plan. Every approval carries the prompt id and a hash of what was displayed. Commands are shown untruncated with control and bidi characters escaped | A single sanitizer bypass in rendered model output must not be able to approve anything |
| C12 | **Plan lock.** A per-conversation toggle, forced on in Ask mode, removes `submit_plan` from the turn. Approval carries version and content hash, bound to the canonical text the execution prompt is built from, and is recorded before the execution turn spawns | "Ask about the plan without modifying it" is enforced by the tool list |
| C13 | **Argv hygiene.** Settings JSON, rules, system prompt text and MCP config go in files created exclusively with mode 0600; the prompt goes on stdin. Windows supports the native `claude.exe` only | No injection surface and nothing sensitive in `ps` |
| C14 | **Long approval waits.** Our MCP entry sets a per-server `timeout` (mandatory: without it the first-byte limit is 60 s) and sends `notifications/progress` heartbeats. A prompt whose request closes is marked expired, and a late answer is a no-op | Docs: HTTP tool calls abort after 5 idle minutes unless progress arrives |
| C15 | **Locks.** One lock per folder realpath in global storage, one per storage directory with heartbeat | Two windows on one folder would each revert the other's agent edits |
| C16 | **Conversations are append-only JSONL** with compaction and truncated tool output | Rewriting a JSON file per event is quadratic and can lose a pending prompt in a crash |
| C17 | **Security-relevant settings have machine scope** | A repository's `.vscode/settings.json` must not be able to weaken them |
| C18 | **Git-state notice** from `.git/logs/HEAD`, the stash ref and index entries, following `gitdir:` files | File restore does not revert a commit, checkout or stash |
| C19 | **Hunk actions** live in the normal editor (CodeLens, decorations), in commands and in the review panel | Confirmed: `diffEditor.codeLens` defaults to false and the quick-diff registration API is proposed-only |

## 2. Architecture

### 2.1 Layout and ownership

| Path | Content |
| :- | :- |
| `src/shared/`, `src/core/contracts/` | Domain types, zod schemas (events, protocol, plan, engine log, settings), provider interface, ports (Fs, Clock, Spawner, Editor). Owned by the primary model |
| `src/core/provider/` | Registry and the Claude adapter: `process/` (config files, argv, environment, spawn, drain, cancel, orphan registry, byte framer), `events/`, `detect/` |
| `src/core/mcp-host/` | Loopback server, auth, per-turn routes, request lifecycle |
| `src/core/policy/` | `readonly/` (Ask and Plan profile, init guard, tripwire), `agent/` (decisions, rule store, risk labels, sandbox profile) |
| `src/core/conversations/`, `branching/`, `context/`, `plans/` | Stores, search, fork strategies and reconstruction, reference resolver, plan versions and approvals |
| `src/core/workspace/` | `store/` (blobs, index, scanner, ignore, path identity, log), `tracker/` (turn journal, capture, attribution, recovery, config tripwire), `review/` (fold, accept, reject, hunks, merge, restore executor), `checkpoints/` |
| `src/vscode/` | `host/` (activation, views, CSP, router, trust gate, locks), `plan/`, `review/`, `checkpoints/`. `extension.ts` is owned by the primary model |
| `src/webview/` | `app/` and `features/` (chat, history, tools, references, plan, questions, permissions, review, checkpoints, branches) |
| `test/` | `fixtures/cli/` from the spike, `fake-cli/`, `integration/`, `live/` |

Build with esbuild (extension as CJS, webview as ESM, Mermaid as a lazy chunk). TypeScript `~6.0.3`, `engines.vscode ^1.106.0`, `extensionKind: ["workspace"]`, `untrustedWorkspaces: limited`, `virtualWorkspaces: false`. A window with no folder shows a message and runs nothing; a multi-root window asks which folder a conversation belongs to.

### 2.2 Claude adapter

Common invocation: `claude -p --output-format stream-json --verbose --include-partial-messages --include-hook-events --permission-mode default --permission-prompt-tool mcp__agentcanopy__permission_prompt --mcp-config <file> --settings <file> --append-system-prompt-file <file> --model <id>`, plus `--session-id <uuid>` or `--resume <uuid>`. A branch's first turn adds `--fork-session --session-id <new>` and, for an exact earlier-message fork, `--resume-session-at <uuid>`. Spawned without a shell, in its own process group, with VS Code's own variables (such as `ELECTRON_RUN_AS_NODE`) stripped from the environment.

| Mode | Extra flags and settings | Host policy |
| :- | :- | :- |
| Ask | `--tools Read,Grep,Glob,AskUserQuestion` (web tools only by setting), `--strict-mcp-config`, `--disable-slash-commands`, `--no-chrome`, `disableAllHooks: true`, `ENABLE_CLAUDEAI_MCP_SERVERS=false` | Default deny. Reads inside the folder pass (checked on the realpath), reads outside ask, everything else is refused |
| Plan | Ask, plus `submit_plan` allowed unless the plan is locked | Same as Ask |
| Agent | Default tools, the user's MCP servers, settings file with C5 rules and stored allow rules | Workspace edits are allowed automatically and are reviewable, except protected paths (`.git`, `.vscode`, `.claude`, `.husky`, `.devcontainer`, `.mcp.json`, `.env*`, anything outside the folder), which ask. Commands ask: once, always, or deny with feedback. Network, unknown and external tools ask and are shown as external. `bypassPermissions` is never used |

**Read-only guard (Ask, Plan).** Any failure kills the process group and reports that enforcement could not be verified.

1. `init` arrives within a timeout, before any assistant event, with no hook or plugin event before it.
2. Every `tools` entry is on the allowlist (the four tools, `EndConversation`, our own MCP tools, web tools only by setting); `Read` is present.
3. `mcp_servers` is exactly ours and connected; no server errors.
4. `plugins` is empty; otherwise the stated guarantee is downgraded, or the turn fails under a strict setting.
5. Permission mode, working directory and session id are the expected ones.
6. During the run: every tool-use name, including subagent ones, is on the allowlist, and no hook event appears.
7. After exit: the stat tripwire reports any change. It reports only; it does not offer a restore.

**Other adapter rules**

- A permission request naming one of our own tools is denied. A request with no matching tool-use id in the stream gets no capture, no UI and no rule.
- The turn ends at process exit, not at the first result. Stdout is always drained; stderr goes to a ring buffer. Lines are framed on bytes with a size cap.
- Never two processes on one session id. Forking from the latest message waits while the parent runs.
- Cancel sends SIGINT first, then resolves pending prompts, then SIGTERM and SIGKILL to the group after grace periods. Windows uses `taskkill /T /F`.
- Structured fields drive the UX for expired login, rate limit, overload and startup failure. A notice appears when an environment API key is the active credential.
- Sign-in opens a terminal running the CLI's own login. AgentCanopy never reads, stores, relays or logs credentials or account fields.

### 2.3 Loopback MCP server

Bound to 127.0.0.1 on a random port. Per-turn bearer token and route, compared in constant time, revoked at turn end. Requires the exact `Host`, no `Origin`, and JSON content; body cap 16 MB; no CORS headers. Stateless; implements `initialize`, `tools/list`, `tools/call`, `ping`. Because the agent could read the token file, an authenticated request is still treated as untrusted input.

### 2.4 Turn flow

1. Check trust, provider readiness, the folder lock and that no configuration change is waiting for a decision.
2. Compose the prompt: mode block, attached context, plan block, and a note listing files reverted since the last turn.
3. Record dirty editor buffers and warn that the agent sees the saved version.
4. Wait for the baseline; detect foreign deltas since the last operation; journal the turn (phases, timestamps, child pid and start time) before spawning.
5. Stream events into host state; route permission requests through the policy; capture a file before every file-tool edit and re-hash every path a tool names.
6. At process exit: reconcile in a worker, append the operation, update the review fold, run the tripwires, clean up.
7. On activation, a journaled open turn means a crash: kill the orphan's process group first, then reconcile. Changes dated after the last journaled activity are marked "after interruption".

### 2.5 Workspace engine

- **Tracked set.** Files under the conversation's folder, minus VCS directories, gitignored paths (parsed with `ignore`, pruned by directory, no git binary), a heavy-directory list and user excludes. Symlinks are recorded by target and never followed. Sensitive patterns (`.env*`, keys) are hash-only in the baseline, but a file-tool edit to one is still captured, stored 0600, with a purge command.
- **Index.** Size, mtime and ctime in nanoseconds, inode and mode from bigint stats. Blobs are sha256-addressed gzip, written before anything references them and verified on every read.
- **Attribution classes.** Agent tool, unattributed during turn, user (editor save), mixed, external, after interruption. Only the first enters Reject All by default.
- **Review.** The pending diff is the baseline against the current file. Accept is a logged decision, and accepted changes stay visible as accepted. Reject restores the baseline only when the file equals the last operation's after-state; otherwise the user chooses: review hunks, revert only the agent's change by 3-way merge, overwrite (native modal), or cancel. Reject All states what it cannot restore before acting. A file with unsaved editor changes refuses writes.
- **Hunks.** Byte-exact line arrays with terminators kept, so CRLF, BOM and a missing final newline round-trip. Identity is path, baseline hash, current hash and index, refused when stale. "Absent" and "empty" are different states. Binary and non-UTF-8 files are whole-file only.
- **Checkpoints.** "Restore to before operation K" reverse-applies each agent delta and writes a snapshot verbatim only where no foreign delta intervened. The preview names every affected operation and conversation. "Restore and branch from here" combines it with a fork.
- **Limits.** Past the budget, or for bulk creations over a per-turn cap, a file is tracked by name and stat: listed, not restorable. Renames are a linked delete and create. Empty directories are not tracked. Retention: 50 operations or 30 days (settings), with GC of unreferenced blobs.

### 2.6 Plan mode

A plan is a stored document with immutable versions (zod schema, whose generated JSON Schema is the `submit_plan` input), host-owned user decisions that carry across versions by stable ids, and approvals. Fields: title, objective, requirements, analysis, architecture, relevant files, stages with dependencies and acceptance, external dependencies, Mermaid diagrams, alternatives, decision points, open questions, testing strategy, acceptance criteria, change summary.

- A new version appears in chat as a card with "View changes" and "Revert to previous". If the model answers in chat without submitting, a card says no plan was saved and offers to ask again.
- Version compare opens the native diff editor on canonical Markdown.
- Answers to open questions and to `AskUserQuestion` are stored as decisions and fed into the next turn.
- "Approve and execute vN" (native modal, with a warning when questions are open) is the only path to execution. It starts an Agent turn on the same session with the approved text embedded.
- A fork gets its own copy of the plan as it stood at the fork point.

### 2.7 Forking

A branch is a new conversation with `parentId` and `forkedAtMessageId`. Fork points are turn boundaries; forking at a user message keeps the turns before it and prefills the composer. Strategies: exact at the latest message (`--fork-session`), exact at an earlier one (`--resume-session-at`, when detected and enabled), otherwise reconstructed from stored visible messages within a size budget. The branch shows which it got, what a reconstructed branch lost, and a note when the files on disk are newer than the fork point. Forking never touches files.

### 2.8 Webview, context and security

- Host state is the source of truth: a full snapshot on ready, then sequence-numbered patches with resync on a gap. A prompt is a state machine (pending, then answered, expired or cancelled); the first answer wins across views, and a badge shows a prompt waiting in a hidden view.
- Context attachments are files, folders, the selection, open editors and diagnostics, sent as paths or small inline excerpts. Images are not supported in the first version. Symbol search is not offered to the agent; this is documented.
- CSP: `default-src 'none'`; scripts by nonce plus `cspSource`; styles `cspSource 'unsafe-inline'`; images `cspSource data:`; no `connect-src`. Markdown through markdown-it with HTML off, then DOMPurify. Links open only after a confirmation showing the full URL, http and https only. Mermaid runs with `securityLevel: 'strict'` on closed fences.
- Every message in both directions is validated against a zod union. Logs are redacted. No telemetry.
- Untrusted workspace: history is readable, nothing runs.

## 3. Phase 0 spike and its gates

A dependency-free harness in `spike/` (loopback MCP server and scenario runner) records real CLI runs with Haiku in a scratch folder. Fixtures are scrubbed of home paths and account fields before entering `test/fixtures/cli/`. Findings go to `docs/protocol/claude-cli.md`. About 25 short runs.

| Gate | What must hold | If it does not |
| :- | :- | :- |
| S1 | The permission prompt tool is called with usable arguments and honours allow, deny and `updatedInput` | Stop and return to the owner. This is the one result that would change the architecture |
| S2 | A reply delayed past 2 and past 5 minutes works with the per-server `timeout` and progress heartbeats | `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`; failing that, prompts expire with an automatic deny and a visible state |
| S3 | `AskUserQuestion` arrives through the prompt tool and accepts single, multi and free-text answers | Own `ask_user` MCP tool with `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0` |
| S4 | With the Ask flags, `init` matches the guard exactly and a prompt asking to create a file changes nothing | Add `--disallowedTools`; then `--restricted`; then disable Ask mode with an explanation |
| S5 | `--resume` keeps the id; `--fork-session --session-id` works; `--resume-session-at` cuts at a turn boundary | Earlier-message forks are reconstructed only |
| S6 | One session accepts Ask, Agent, then Ask turns with different tool sets | New session per mode switch, seeded with reconstructed context |
| S7 | SIGINT produces a result and a resumable session; a deny followed by interrupt behaves | Treat cancel as a hard stop and document it |
| S8 | An ask rule and a PreToolUse HTTP hook passed in the settings file both fire with a pre-existing `Edit` allow rule present | Use whichever works; with neither, capture only at turn boundaries and document the weaker attribution |
| S9 | `submit_plan` is offered to the model (not deferred behind tool search), accepts 20 KB and returns a usable error on invalid input | Add the search tool to the allowlist, or split the plan into smaller calls |
| S10 | The MCP surface the CLI uses is recorded, including whether SSE replies are accepted | Adjust the server |
| S11 | Sandbox settings in the settings file take effect and prompts still reach the host | Ship without the sandbox setting and document how to enable it in Claude Code |

Also recorded: stream shapes for text, tool calls, subagents and errors; whether a run takes further turns after its first result; what a child does when its parent is killed; the effect of an invalid settings entry.

## 4. Roadmap

Each phase ends with the full checks, a review and a local commit. Packages in a phase own disjoint paths and run in parallel unless noted. The engine track (workspace store, tracker, review, checkpoints) is core-only and runs ahead of the UI from phase 1.

| Phase | Packages |
| :- | :- |
| 0. Foundations | **Scaffold** (root configs, `scripts/`, CI skeleton, original icon, LICENSE) and **Spike** in parallel, then **Contracts** by the primary model. Also: commit `CLAUDE.md` and `.claude/agents/`, add build commands and a pointer to this plan to `CLAUDE.md` |
| 1. Foundation | Provider process layer with the fake CLI; provider events, detection and registry; MCP host; conversation store; workspace store; webview app, chat and history. Then the VS Code host and the first integration tests |
| 2. Ask mode | Read-only profile, guard and tripwire; reference and attachment resolver; tool cards, reference picker and question card |
| 3. Plan mode | Plan store, versions, lock, approvals and `submit_plan`; plan and question views; virtual documents, compare and the approval gate |
| 4. Agent mode | Tracker (journal, capture, attribution, recovery, config tripwire); agent policy, rule store, risk labels, sandbox profile; permission cards |
| 5. Review changes | Review fold, accept, reject, hunks, merge, restore executor; snapshot provider, diff commands, CodeLens, dirty-buffer guard; review panel |
| 6. Forking and checkpoints | Fork strategies and reconstruction; restore planning, preview, retention and GC; branch and checkpoint views |
| 7. Polish and release | Accessibility pass against a written checklist (keyboard path for every action, focus order, labels, contrast in four themes); README, CONTRIBUTING, CHANGELOG, SECURITY, third-party notices, limitations and publishing docs (OIDC, publisher injected at package time); security review; live and end-to-end suites; VSIX and install check |

Tests from spec section 15 are written inside the package that owns the behaviour, and each listed edge case gets a named test. Three kinds carry the data-safety claims:

- Property tests over random interleavings of agent turns, user edits, accepts, rejects and restores: no user byte is lost without an explicit choice, and rejecting every hunk in any order reproduces the baseline byte for byte.
- A scan benchmark on a generated 50,000-file tree for the large-workspace case.
- An end-to-end restart test across two VS Code launches.

## 5. Delegation and the per-phase loop

- The primary model writes the contracts, owns `package.json`, the lockfile and `extension.ts`, decides every design question, briefs, reviews and commits.
- Sonnet implementers take one package each, with a brief naming owned paths, contracts, behaviour, tests and acceptance commands. They follow `.claude/agents/implementation.md` and return dependency or contract requests instead of editing shared files.
- Haiku handles lookups and codebase searches, read-only.
- If the two project subagents are not registered in the executing session, the same roles run through model overrides with those rule files named in the brief.
- Implementers share one working tree (no worktrees: about 4 GiB of disk is free). After each wave the primary model runs the full checks, reads the diff and sends fixes back.
- An independent reviewer on the primary model reads phases 4 to 6, where a mistake can cost user data.
- Work returns to the owner only if gate S1 fails, a finding changes the architecture, or free disk space falls under 1.5 GiB.
- The repository copy of this plan carries a status table updated at every phase commit, so a new session can resume from it.

## 6. Verification

| Check | Command or method |
| :- | :- |
| Types, lint, format | `npm run typecheck`, `npm run lint`, `npm run format:check` |
| Unit and property tests | `npm test` (vitest). The fake CLI runs as a real child process for crash, hang, cancel, garbage output, auth failure and permission round trips |
| Integration tests | `npm run test:integration` (`@vscode/test-cli`, `useInstallation.fromPath` at the installed VS Code, isolated user-data and extensions directories through `launchArgs`). It briefly opens a second VS Code window |
| Live smoke | `npm run test:live` (opt-in, real CLI, Haiku, scratch folder): Ask leaves the folder unchanged, an Agent edit with approval, resume, fork, plan submit, cancel |
| Package and install | `npx vsce package --no-dependencies`, then `code --extensions-dir <scratch> --user-data-dir <scratch> --install-extension <vsix>` and one real turn; the owner's profile is untouched |
| CI | The workflow file is written and linted locally. It cannot be executed here (no remote), and the final report will say so |

A test is reported as passing only with its command output. Anything not run is reported as not run.

## 7. Limitations to document and items for the owner

**Documented in README and `docs/limitations.md`:**

- Ask mode's guarantee covers the agent's tools, hooks, skills and other MCP servers. It does not cover hooks from managed policy, settings helper commands, or plugins; with plugins present the guarantee is shown as downgraded.
- A command you allow runs with your privileges unless the sandbox setting is on. Changes it makes to ignored or over-budget files are detected but not restorable.
- File restore does not undo Git operations, database changes, network calls or anything outside the folder.
- Exact earlier-message forks depend on a CLI flag missing from the CLI reference; reconstructed forks lose tool output and reasoning.
- Deleting a conversation removes AgentCanopy's data, not Claude Code's own transcript. Moving a folder starts with empty AgentCanopy storage.
- Background tasks are disabled, so the agent cannot keep a dev server running between turns.
- Windows supports the native install only, is verified only in CI, and cancel there is a hard stop.
- The model list is the documented aliases plus custom ids. Context usage is approximate.

**For the owner, before publishing (not blocking development):**

- Anthropic's legal page says running Claude Code in a product "requires agreeing to our Commercial Terms of Service". Whether that applies to you as publisher is your call, not mine.
- Anthropic's names and logos may not be part of a product or feature name; the README will describe the provider in plain text with a no-affiliation statement for Anthropic and Cursor.
- Subscription use through third-party tools is permitted today, but Anthropic reserves the right to change billing or enforcement.
- I have not checked whether the name "AgentCanopy" is free as a trademark or on the Marketplace. The publisher id stays configurable.

## 8. First steps after approval

1. Done: this plan is saved here and the notes file carries the confirmed facts and the review outcome (its section 10).
2. Start Phase 0: scaffold and spike in parallel, then contracts.
