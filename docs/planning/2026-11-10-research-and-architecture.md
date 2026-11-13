# AgentCanopy — research notes and draft architecture (superseded by the implementation plan)

**Status.** This file is the evidence record. Its sections 6 to 9 are a draft that was reviewed and replaced by `2026-11-10-implementation-plan.md`, which is the plan in force. Section 5 (verified findings) and section 10 (later confirmations and the design review outcome) remain current.

## 2. What is being built

AgentCanopy is a free, MIT-licensed VS Code extension that gives standard VS Code a Cursor-like agent experience without using Cursor's code or assets. It must be working software with tests, documentation and a VSIX, not a mockup. Requirements condensed from the owner's spec (all in scope, none optional):

1. **Ask mode.** Read-only codebase exploration. Must never modify workspace files, enforced at the execution and tool-permission layers, not by prompt. Disabling edit tools alone is not assumed to be enough (shell and other tools can write). If the provider cannot enforce read-only safely, disable unsafe tools or report the limitation.
2. **Plan mode.** A plan is a persistent structured document separate from chat history: title, objective, requirements, analysis, architecture, relevant files, stages, dependencies, Mermaid diagrams, alternatives, open questions, user decisions, testing strategy, acceptance criteria. The user can generate it, ask about it without modifying it, switch to Ask and back with the plan intact, request revisions, compare revisions, answer interactive questions, choose among alternatives, and explicitly approve and execute. Version history. A plan never executes because of a question or a revision request; the approved version is recorded before execution starts.
3. **Agent mode.** Implements changes with controlled permissions, streaming progress, tool details, interruption, error reporting, tracked modified files and a reviewable change set. Distinguishes read-only operations, workspace modifications, terminal commands and external or destructive operations. Never silently enables unrestricted command execution.
4. **Conversation forking.** "Fork from here" on an earlier message creates a new branch with context up to that point; the original is unchanged; both continue independently; the relationship is displayed and persisted. Whole-session fork is not the same as arbitrary-message fork. If exact is unavailable, use safe context reconstruction, document the limits, and never claim an exact fork when context differs materially.
5. **Review Changes (critical).** Review, accept or reject agent modifications without Git staging; must work in non-git folders. Capture initial state and pre-existing modifications before execution; track created, modified, renamed and deleted files; attribute changes to the agent; detect external or concurrent modifications. Afterwards: change summary, native diff editor, Accept All, Reject All, per-file, hunk-level where safe, pending versus accepted clearly distinguished. Safety: preserve user modifications that existed before the agent started; never blindly restore the whole workspace; use hashes, snapshot metadata and conflict detection; never silently overwrite a file the user edited during the run; binary files and renames handled conservatively; filesystem rollback is not treated as reversing external side effects; when a rollback cannot complete safely, say exactly what remains unresolved.
6. **Checkpoints** independent of Git: created before agent modifications, persisted metadata, safe restore with conflict detection, multiple checkpoints, history, rollback previews. No promise of arbitrary historical rollback without conflict handling. Consider storage limits, large files, ignored directories, symlinks, sensitive files; avoid duplicating large workspaces unnecessarily.
7. **History.** List, rename, resume, delete, search; show branches; associate plans and checkpoints; no secrets in metadata; context-usage indicator when reliable.
8. **Interactive questions** as accessible controls with optional free text; pending state survives navigation; adapt the provider's real capability.
9. **Provider abstraction** with capability detection. Only Claude Code now; Codex and Gemini CLI later.
10. **UI.** Sidebar chat plus optional editor-area chat, history, new chat, provider/model/mode selectors, composer with file and folder references and context attachments, streaming Markdown with highlighted code and Mermaid, tool status with collapsible details, fork actions, review UI, checkpoint history; VS Code theme variables; responsive; keyboard accessible.
11. **Security.** Strict webview CSP, validated webview-host messages, safe Markdown, no command injection, Workspace Trust integration, controlled process spawning, safe path handling, no credential logging, no telemetry by default.
12. **Tests.** Provider abstraction, CLI process management, stream parsing, session persistence, forking, plan persistence and revisions, Ask restrictions, change detection, accept/reject, snapshot restore, conflict detection, cancellation, error handling; VS Code integration tests; edge cases: unsaved buffers, pre-existing git modifications, concurrent edits, new/deleted/renamed/binary files, interrupted execution, CLI crashes, large workspaces, VS Code restarts. Tests are only reported as passing if they actually ran.
13. **Distribution.** README, CONTRIBUTING, CHANGELOG, MIT LICENSE, `.gitignore`, `.vscodeignore`, build and test scripts, VSIX via vsce, GitHub Actions CI, Marketplace publishing instructions, configurable publisher id.

Working rules from the spec: no invented flags or APIs; no claims of unsupported functionality; verify against installed CLI help and official docs; prefer structured CLI output; avoid undocumented CLI internals; minimal dependencies; do not stop at the scaffold; fix failures before proceeding.

## 3. Owner decisions and standing instructions

| Decision | Choice |
| :- | :- |
| Fork from an earlier message | Use `--resume-session-at` when the installed CLI accepts it, fall back to reconstructed context, label each branch exact or reconstructed, and provide a setting that turns the flag off |
| Live testing against the real CLI | Allowed: one protocol spike plus a short smoke suite after provider-affecting phases. Small prompts, Haiku model, scratch folder. Draws on the owner's subscription limits |
| Version control | `git init`, local commit after each phase passes build, lint and tests. Never push |

- Delegation (from `CLAUDE.md` and the owner's message): the primary model keeps architecture, orchestration and final review. The `implementation` subagent (Sonnet) does routine coding, refactoring and tests from a decided design that names files, behaviour and checks. The `simple-tasks` subagent (Haiku, read-only) does exploration and lookups. Verify subagent results before integrating; review every `implementation` change.
- The two project subagents were not among the planning session's registered agent types. If they are still unregistered, use the same roles through model overrides (sonnet, haiku) with the rules from `.claude/agents/*.md` in the brief.
- Ultracode was on in the planning session (workflows for substantive tasks; default size guideline is under 10 agents per workflow).
- The spec is in English; the owner's last message was in Portuguese.

## 4. Environment

| Item | Value |
| :- | :- |
| Repo | Git repository initialized on 2026-11-10, branch `develop` (`main` not created). Besides `docs/` it holds `CLAUDE.md`, `.claude/agents/implementation.md` and `.claude/agents/simple-tasks.md`, which are not committed yet |
| OS | macOS 26.6.2, arm64 |
| Node / npm | v26.5.1 / 11.17.0; no pnpm, no yarn |
| git | 2.50.1; user name and email configured; `gh` not installed |
| VS Code | 1.142.0 at `/Applications/Visual Studio Code.app` |
| Claude Code CLI | 2.1.322, native install at `~/.local/bin/claude`; signed in with a claude.ai subscription login |
| Disk | 4.6 GiB free on the home volume: run local integration tests against the installed VS Code in an isolated profile instead of downloading another copy |

## 5. Verified findings

Legend: **[V]** verified by the primary session against the source page or the installed binary. **[R]** reported by a research subagent with citations, not independently re-checked. Docs were fetched on 2026-11-10 from `code.claude.com/docs/en/*.md`.

### 5.1 Claude Code CLI 2.1.322

**Invocation and stream**

- [V] `claude -p` takes the prompt as an argument or piped stdin (10 MB cap). Exit code 0 on success, non-zero on failure. A failure inside the run, such as missing authentication, is printed as the result on stdout. (headless)
- [V] Streaming: `--output-format stream-json --verbose --include-partial-messages`. Each line is a JSON event; the last line is a `result` message. (headless)
- [V] `system/init` is the first event unless startup events precede it. It reports model, tools, `mcp_servers[{name,status}]`, `mcp_server_errors`, plugins and an optional `capabilities` array meant for feature detection. (headless)
- [V] `system/api_retry` carries `attempt`, `max_retries`, `retry_delay_ms`, `error_status` and `error`, one of `authentication_failed`, `oauth_org_not_allowed`, `account_on_hold`, `billing_error`, `rate_limit`, `overloaded`, `invalid_request`, `model_not_found`, `server_error`, `max_output_tokens`, `cloud_credential_error`, `unknown`. (headless)
- [R] The event schema is the Agent SDK `SDKMessage` union (TypeScript reference and `sdk.d.ts` 0.3.322). Docs say to ignore unknown types because the set grows. Shapes that matter:
  - `assistant`: `message` (Messages API message), `uuid`, `session_id`, `parent_tool_use_id`, optional `error` (same categories as above), optional `aborted`. One assistant event per completed content block; consecutive events can share `message.id`; `usage` on them is not final.
  - `user`: tool results, `tool_use_result`, `parent_tool_use_id`.
  - `stream_event`: raw Messages API stream event (`text_delta`, `thinking_delta`, `input_json_delta`, block start/stop).
  - `result`: exactly one per turn. `subtype` `success` or `error_during_execution` / `error_max_turns` / `error_max_budget_usd` / `error_max_structured_output_retries`; `is_error`, `result`, `num_turns`, `duration_ms`, `usage`, `modelUsage[model]{inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, costUSD, contextWindow, maxOutputTokens}`, `total_cost_usd` (an estimate), `permission_denials[{tool_name, tool_use_id, tool_input}]`, `terminal_reason`, `errors[]`, `startup_failure_reason`.
  - Also `system/status`, `system/compact_boundary` (`pre_tokens`), `rate_limit_event` (`status` allowed / allowed_warning / rejected, `resetsAt`, `rateLimitType`, `utilization`), `tool_progress`, task and subagent events, `system/permission_denied`.
- [R] `--input-format stream-json` accepts lines shaped `{"type":"user","message":{"role":"user","content":...},"parent_tool_use_id":null}`, with image blocks and an optional `uuid`. [V] `--replay-user-messages` requires stream-json in both directions.
- [R] The stdin/stdout control protocol (`control_request` for can_use_tool, interrupt, set_model, supportedModels, getContextUsage) has no documented schema for direct CLI consumers. It is the Agent SDK's transport.
- [V] `/skill-name` and custom commands in a `-p` prompt are expanded. `--disable-slash-commands` disables all skills and commands. (headless, cli-reference)

**Tools and permissions**

- [V] `--tools`: "Restrict which built-in tools Claude can use. Use `""` to disable all, `"default"` for the default set, or tool names... The flag doesn't affect MCP tools; to deny those too, use `--disallowedTools "mcp__*"`. A list that omits `EndConversation` doesn't remove it." (cli-reference)
- [V] On macOS, Linux and WSL the default set leaves out `Glob` and `Grep` (search goes through Bash). Naming them in `--tools` gives exactly the ones listed. (cli-reference, tools-reference)
- [V] `--allowedTools` pre-approves and does not restrict ("To restrict which tools are available, use `--tools` instead"). `--disallowedTools` with a bare name removes the tool from context; a scoped rule such as `Bash(rm *)` denies matching calls. (cli-reference)
- [V] `--permission-mode` choices in `--help`: acceptEdits, auto, bypassPermissions, manual, dontAsk, plan. The binary also accepts `default` (probe). Use `default` for compatibility.
- [V] "With Claude Code v2.1.302 or later, `claude -p` runs start in Manual mode when nothing sets a permission mode." [R] A `permissions.defaultMode` in settings can set it, so always pass the mode explicitly.
- [V] "In a Manual mode `claude -p` run, a call that needs approval is denied unless something approves it, such as a `PermissionRequest` hook or a `--permission-prompt-tool`." (headless)
- [V] `dontAsk` denies anything that would prompt, including `AskUserQuestion`. `acceptEdits` auto-approves file writes and common filesystem commands. (headless)
- [R] `plan` mode is not a hard read-only guarantee: Bash still runs read-only-classified commands, and classifier- or host-approved commands can write.
- [R] Evaluation order: hooks, deny rules, ask rules, permission mode, allow rules, then the host. Auto-approved calls never reach the host. Deny rules apply in every mode. Docs say Bash rules match command text and are "not a security boundary".
- [V] `--restricted` (2.1.248+): removes command and code-running built-ins and WebFetch unless individually named in `--tools`, confines file tools to the working directories, loads only managed settings and `--settings`, refuses `bypassPermissions`. (cli-reference)
- [V] `--safe-mode`: disables CLAUDE.md, skills, plugins, hooks, MCP servers, custom commands and agents; authentication and permissions work normally. (cli-reference)
- [R] Changelog: 2.1.295 "Fixed `--tools` and `--restricted` not applying to built-in tools that register after launch"; 2.1.285 fixed permission-prompt-tool routing for background subagents; 2.1.259 added `--permission-prompts`; 2.1.200 renamed the default mode to Manual.

**Permission prompt tool and interactive questions**

- [V] `--permission-prompt-tool mcp__<server>__<tool>`: "Specify an MCP tool to handle permission prompts in non-interactive mode." The run waits for that server up to `MCP_TIMEOUT`. It cannot approve an MCP tool marked as requiring user interaction. Documented example: `claude -p --mcp-config ./mcp.json --permission-prompt-tool mcp__permissions__approve "query"`. Present in the binary but hidden from `--help`. (cli-reference, probe)
- [V] Result contract: one text block whose text is `{"behavior": "allow"}` or `{"behavior": "deny", "message": "<reason>"}`; add `updatedInput` to change the input; no `structuredContent`; for inputs of about 40 KB or more, do not copy the input into `updatedInput` or the deny message. Versions 2.1.86 to 2.1.206 needed `"updatedInput": {}` on allow. If the tool is missing, the run exits 1 on the first tool call. (errors)
- [V] The arguments the tool receives are not documented. Expected `tool_name`, `input`, possibly `tool_use_id`. Must be captured in the spike.
- [V] `--permission-prompts host|none` (2.1.259+): `none` denies anything that would prompt and removes `AskUserQuestion`.
- [V] "A `-p` run offers `AskUserQuestion` only when it has a permission host, such as an MCP tool you pass with `--permission-prompt-tool`." (hooks reference)
- [R] `AskUserQuestion` input: 1 to 4 questions, each `{question, header (max 12 chars), options[2..4]{label, description}, multiSelect}`. The host answers with allow plus `updatedInput: {questions, answers: {"<question text>": "<label, joined labels, or free text>"}}`. Not available to subagents.

**MCP**

- [V] `--mcp-config` takes JSON files or strings; `--strict-mcp-config` uses only those servers. HTTP entry: `{"type":"http","url":"...","headers":{"Authorization":"Bearer ..."}}`; a per-server `timeout` in milliseconds is supported. (cli-reference, mcp)
- [V] Time limits: `MCP_TOOL_TIMEOUT` defaults to about 28 hours. HTTP servers also have a per-request timer to the first response byte, equal to the greatest of 60 s, the tool timeout that applies to the server, and `MCP_TIMEOUT`; and an idle window of 5 minutes (30 for stdio). A per-server `timeout` raises both and is a hard wall-clock cap per call. Main-conversation calls longer than 2 minutes are moved to the background unless `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0`. (mcp, env-vars)

**Sessions**

- [V] `--session-id <uuid>`, `--resume <id>`, `--fork-session` ("create a new session ID instead of reusing the original"), `--no-session-persistence`. (cli-reference)
- [V] `--resume-session-at <message id>`, `--resume-drops-turn <message id>` and `--rewind-files <user-message-id>` exist in the binary (argument-missing probe) and are absent from `--help` and from the CLI reference. [R] The SDK documents `resumeSessionAt`: "only resume messages up to and including the message with this UUID"; fork at the kept turn's last chain entry.
- [R] `--fork-session` can be combined with `--session-id` to choose the new id. Transcripts live under `~/.claude/projects/` in an internal format that "changes between versions" and are deleted after `cleanupPeriodDays` (default 30). `--mcp-config` and `--settings` are not restored on resume and must be passed again.
- [V] `--system-prompt-snapshot`: by default the system prompt, including `--append-system-prompt`, is recorded on the conversation's first request and reused on resume. (cli-reference)

**Cancel and lifecycle**

- [V] SIGTERM: exit code 143, the turn is left unfinished with no result, running Bash process trees are terminated. "To end the turn instead, send SIGINT." On resume the interrupted turn is left as it is and the next prompt drives the conversation. (headless)
- [V] After the final turn a `-p` run can stay open for background work (10-minute idle cap by default). `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` turns background execution off. (headless, env-vars)
- [V] With `--mcp-config` and `-p`, startup waits up to `MCP_TIMEOUT` (30 s) for pending servers.

**Auth, models, usage**

- [V] `claude auth status` prints JSON, exit 0 if logged in and 1 if not; `authMethod` is one of none, claude.ai, oauth_token, api_key, api_key_helper, third_party. Locally the JSON has `loggedIn`, `authMethod`, `apiProvider`, `subscriptionType`, `planTier`, `loginExpiresAt`, `configDirectory`, `projectsDirectory`, plus `email`, `orgId`, `orgName` (never log these).
- [R] In `-p`, `ANTHROPIC_API_KEY` in the environment is always used when present, which means API billing instead of the subscription. `system/init.apiKeySource` shows which credential is active.
- [V] `--model` takes an alias (sonnet, opus, haiku, fable) or a full name. [R] Other aliases: default, best, `sonnet[1m]`, `opus[1m]`, opusplan. No CLI command lists models.
- [V] `--effort`: low, medium, high, xhigh, max (or ultracode).
- [R] Context size is not streamed directly. It can be derived from the last main-loop assistant `usage` (input plus cache tokens) against `modelUsage[model].contextWindow`.

**Settings and environment**

- [V] Docs: "Without `--bare`, a `-p` session runs the hooks in a project's `.claude/settings.json` and connects the servers in its `.mcp.json`, even in a folder you've never trusted." There is no trust dialog in `-p`.
- [V] `--bare` never reads OAuth credentials or the keychain, so it cannot be used with a subscription login. Docs: `--bare` "will become the default for `-p` in a future release".
- [V] `disableAllHooks` is a settings key. [R] `--settings '<json>'` is a per-session layer above user, project and local settings; documented example `--settings '{"sandbox": {"enabled": true, "allowUnsandboxedCommands": false}}'`. The OS sandbox covers Bash on macOS (Seatbelt) and Linux/WSL2 (bubblewrap), not native Windows.
- [V] `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` adds `session_state_changed` events. `CLAUDE_CODE_STARTUP_FAILURE_RESULTS=1` (2.1.274+) makes startup refusals produce a result message.
- [R] Claude Code's own checkpointing tracks only Write, Edit and NotebookEdit. It does not track Bash changes or subagent edits, so it cannot satisfy requirement 5.

### 5.2 Agent SDK (`@anthropic-ai/claude-agent-sdk`) [R]

- Version 0.3.322 tracks Claude Code 2.1.322. About 5.2 MB of JS plus a native binary in a per-platform optional package (323 to 346 MB each). Peer dependencies: zod ^4, `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`.
- License field "SEE LICENSE IN README.md"; `LICENSE.md` reads "© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements outlined here: https://code.claude.com/docs/en/legal-and-compliance." No redistribution grant was found.
- `pathToClaudeCodeExecutable` pointing at a separately installed native binary is documented as supported.
- It offers what the raw CLI lacks as documented interfaces: `canUseTool`, `interrupt()`, `setModel()`, `supportedModels()`, `getContextUsage()`, `listSessions()`, `forkSession(id, {upToMessageId})`, in-process hooks and MCP servers.
- The V2 session API was removed in 0.3.142.
- SDK docs: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK."

### 5.3 Terms

- [V] Legal and compliance page, "Authentication and credential use": "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow." It continues: "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code".
- [V] Same page, "Can customers offer Claude Code in their products?": "preinstalling or running Claude Code in your products or services ... requires agreeing to our Commercial Terms of Service"; the binary must not be modified; no authentication method may be removed or restricted; usage may not be paid for, resold or intermediated. Naming: "You can accurately say, in plain text, that your product ... runs Claude Code. But you can't use the Claude Code or Anthropic names or logos as part of your own product, feature, or company name".
- [V] Support article "Use the Claude Agent SDK with your Claude plan". June 15, 2026: "Claude Agent SDK, `claude -p`, and third-party app usage still draw from your subscription limits." October 7, 2026: "when you're signed in with your Claude plan, the Claude Agent SDK and `claude -p` still draw from your subscription limits."
- [R] Support article "Log in to your Claude account": the preferred way for third-party tools, "including open-source projects", is API key authentication; Anthropic "reserves the right to draw use of such third-party tools from usage credits rather than subscription limits"; tools that "misrepresent their identity" are prohibited.
- Consequences for the design: spawn only the unmodified, user-installed binary; never read, store or relay credentials; sign-in happens through `claude auth login` in a terminal; never alter how the CLI identifies itself; describe the provider in plain text with no logos; README carries a terms section and a no-affiliation statement. I cannot judge how the Commercial Terms sentence applies to the owner as publisher: flag it, do not decide it.

### 5.4 VS Code API and toolchain

- [V] `typescript` latest is 7.0.2, but `typescript-eslint` 8.72.2 peers `typescript >=4.8.4 <6.1.0`. Pin TypeScript `~6.0.3`.
- [V] `contributes.viewsContainers.secondarySidebar` was finalized in VS Code 1.106 according to a search summary of the 1.106 release notes (confirm on the release-notes page when writing the manifest). [R] The VS Code source does not gate it behind a proposal and the official Claude Code extension uses it. Set `engines.vscode` to `^1.106.0` with matching `@types/vscode` (1.106.x exists).
- [V] Marketplace publishing: "On December 1, 2026, global Personal Access Tokens (PATs) in Azure DevOps are retired." Docs recommend GitHub Actions OIDC trusted publishing (`vsce publish --oidc`) or Microsoft Entra ID (`--azure-credential`). "Every extension needs to include a `publisher` identifier in its package.json file."
- [V] `node-diff3` 3.2.1 is MIT. vitest 5.1.0 peers vite ^6.4, ^7 or ^8 and supports Node 26.
- [R] Latest versions: esbuild 0.28.2, vitest 5.1.0, eslint 10.14.0, `@eslint/js` 10.0.1, eslint-plugin-react-hooks 7.1.1, prettier 3.9.10, react and react-dom 19.3.1, `@types/vscode` 1.145.0, `@vscode/vsce` 4.1.0, `@vscode/test-cli` 0.0.15, `@vscode/test-electron` 3.1.0, mocha 12.0.3, mermaid 12.3.0, markdown-it 15.0.3, dompurify 3.4.17 (MPL-2.0 OR Apache-2.0), highlight.js 11.12.0 (BSD-3), diff 9.0.0 (BSD-3, ships types), zod 4.6.7, ignore 7.0.14, `@vscode/codicons` 0.0.46-24 (CC-BY-4.0).
- [R] Built-in commands: `vscode.diff(left, right, title, options)` and `vscode.changes(title, resourceList)`. `vscode.changes` is the only stable entry to the multi-file diff editor.
- [R] No stable API for inline accept/reject widgets. Stable building blocks: CodeLens providers, decorations, `editor/title` and `editor/context` menus, Comments API. Whether CodeLens shows inside diff editors by default (`diffEditor.codeLens`) is unverified and believed false.
- [R] Chat and agent-session APIs for third-party agents are proposed-only and cannot ship in a Marketplace extension.
- [R] Workspace Trust: manifest `capabilities.untrustedWorkspaces: {supported: 'limited', description, restrictedConfigurations}`; API `workspace.isTrusted`, `workspace.onDidGrantWorkspaceTrust`.
- [R] Webviews: `registerWebviewViewProvider` (with `retainContextWhenHidden`), `registerWebviewPanelSerializer`, `webview.cspSource`, `asWebviewUri`, `acquireVsCodeApi().getState/setState`.
- [R] Storage: `context.storageUri` (per workspace), `globalStorageUri`, `logUri`, `workspaceState`, `globalState`, `secrets`.
- [R] Testing: `@vscode/test-cli` with `.vscode-test.mjs` and Mocha; Linux CI needs `xvfb-run -a`.
- [R] vsce: `vsce package` works without a publisher for testing; `--no-dependencies` when bundling; the `@types/vscode` major.minor must not exceed `engines.vscode`.
- [R] `extensionKind: ["workspace"]` runs the extension where the workspace and CLI are (SSH, WSL, containers).

## 6. Decisions and draft architecture

This is a draft. The design review that should have challenged it did not finish.

### 6.1 Decisions with reasons

- **D1. Spawn the user's installed, unmodified `claude` binary; no Agent SDK.** The SDK has no redistribution grant, so bundling it in an MIT VSIX is not clean; Anthropic's terms explicitly leave room for an end user signing in to the unmodified binary; and it matches the spec's wording. Cost: the control protocol is not available as a documented interface, so permissions go through `--permission-prompt-tool`, cancel through signals, and models through aliases.
- **D2. One process per user turn.** `claude -p`, prompt on stdin as text, stream-json out, `--session-id` on the first turn and `--resume` afterwards. Each mode needs different flags anyway, crashes stay isolated, and no idle process holds memory. Always pass `--permission-mode default`.
- **D3. Loopback HTTP MCP server inside the extension host** exposing `permission_prompt` (the `--permission-prompt-tool` target) and, in Plan mode, `submit_plan`. Bound to 127.0.0.1 on a random port; per-turn bearer token and unguessable path; Host and Origin validation; config handed to the CLI as a 0600 temp file, not on argv; per-server `timeout` raised so a person can take their time. Hand-rolled minimal JSON-RPC (initialize, tools/list, tools/call, ping) unless the spike shows friction.
- **D4. Interactive questions use the native `AskUserQuestion`** routed through the permission prompt tool (documented path).
- **D5. Snapshots use a content-addressed blob store in `context.storageUri`.** No git and no shadow git, because the spec requires independence from Git and shadow repos break on nested repositories.
- **D6. Runs are disabled in untrusted workspaces**, because `-p` executes project hooks and MCP servers with no trust dialog.
- **D7. A protocol spike against the real CLI precedes the provider implementation.** Everything else is tested against a scriptable fake CLI, with fixtures recorded in the spike.
- **D8. Minimum supported CLI 2.1.295** (the `--tools` fix), refused below that. Re-verify the changelog entry before fixing the number.
- **D9. Mode instructions and the current plan travel in a tagged block appended to the user message.** `--append-system-prompt` is frozen on the first request, so it carries only one constant text.
- **D10. Plans are delivered through our own `submit_plan` MCP tool with a JSON Schema**, not Claude Code's native plan mode, which yields free-form Markdown and is not a hard read-only mode.

### 6.2 Rejected alternatives

- Agent SDK: licensing and terms (D1).
- Long-lived stream-json process: mode switches need a respawn anyway; kept as a later option for mid-turn steering and images.
- Claude Code's `plan` permission mode for Ask or Plan: not a hard read-only guarantee and it injects its own plan workflow.
- A custom `ask_user` MCP tool: model-invoked MCP calls are auto-backgrounded after 2 minutes; the native tool has a documented host path.
- stdio MCP bridge script: needs a Node runtime on PATH.
- Recursive file watcher for attribution: it cannot tell an external process from an agent command either, so the turn-end scan plus tool paths plus editor save events are enough (tentative).
- `--restricted` or `--safe-mode` as the default for Ask: they drop user settings (possibly auth-related `env`) or CLAUDE.md. Offer as an optional strict setting.

### 6.3 Layers

| Layer | Content |
| :- | :- |
| `src/shared` | Domain types and zod schemas for the webview-host protocol. No vscode, no DOM |
| `src/core` | Pure Node logic, unit-tested with vitest: providers (interface, registry, Claude adapter: detection, argv builder, process runner, NDJSON parser, event mapper, MCP host), conversations and branches, plans, workspace engine (blob store, index, change tracker, review, checkpoints, hunks, ignore rules), permission policy, config, logging |
| `src/vscode` | Adapters: sidebar WebviewView and editor WebviewPanel, webview HTML and CSP, read-only FileSystemProvider for snapshots and plan versions, review controller (CodeLens, decorations, commands), trust gating, status bar, commands |
| `src/webview` | React 19 app shared by both views: chat, history, composer, tool cards, permission and question cards, plan view, review panel, checkpoint history |

Build: esbuild, extension as CJS for Node with `vscode` external, webview as ESM with code splitting (Mermaid as a lazy chunk). Manifest: secondary side bar container, `extensionKind: ["workspace"]`, `untrustedWorkspaces: limited`, `virtualWorkspaces: false`, `agentCanopy.claude.path` with machine scope so a repo cannot redirect the binary.

### 6.4 Provider interface

Turn-based: `detect()` (installed, version, auth state, capabilities), `listModels()`, `startTurn(request, host)` returning `{events: AsyncIterable<AgentEvent>, cancel(), done}`. The request carries cwd, prompt, mode, execution policy, model, effort, session reference with fork info, and host-tool configuration. The host supplies `requestPermission` and `askUser`. Normalized events: session, text-delta, thinking-delta, message, tool-call, tool-result, usage, status, rate-limit, error, result. Capabilities: streaming, sessions (resume, forkWhole, forkAtMessage), model selection, interactive approval, read-only enforcement level, cancellation, tool events, interactive questions, usage, host tools, sandbox.

### 6.5 Claude adapter

Common argv: `claude -p --output-format stream-json --verbose --include-partial-messages --permission-mode default --permission-prompt-tool mcp__agentcanopy__permission_prompt --mcp-config <0600 file> --model <alias or id> [--effort <level>] --append-system-prompt <constant text>`, plus `--session-id <uuid>` or `--resume <uuid>` (with `--fork-session --session-id <new>` and optionally `--resume-session-at <uuid>` on a branch's first turn). Spawned without a shell, cwd at the workspace folder, environment passed through with `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`, `CLAUDE_CODE_STARTUP_FAILURE_RESULTS=1` and, by default, `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`.

| Mode | Additional flags | Host policy |
| :- | :- | :- |
| Ask | `--tools Read,Grep,Glob,AskUserQuestion` (plus `WebSearch,WebFetch` only if a setting enables web access), `--strict-mcp-config`, `--disable-slash-commands`, `--settings '{"disableAllHooks":true}'` | Default-deny: reads inside the workspace pass, reads outside ask the user, everything else is denied |
| Plan | Same as Ask, plus `--allowedTools mcp__agentcanopy__submit_plan` | Same as Ask. Execution starts only from an explicit, host-validated UI action that records the approval (version and content hash) first |
| Agent | Default tools and the user's MCP servers; stored allow rules as `--allowedTools`; optional sandbox settings | Workspace edits auto-allowed by default (checkpointed and reviewable) except protected paths (`.git`, `.vscode`, `.claude`, shell rc files, outside the workspace), which ask. Commands ask by default: allow once, always allow, or deny with feedback. Network and unknown tools ask. `bypassPermissions` is never used |

- **Init guard (Ask and Plan):** on `system/init`, check that `tools` is a subset of the allowlist plus `EndConversation` and that `mcp_servers` is exactly ours. Otherwise kill the process and report that read-only enforcement could not be verified.
- **Post-turn verification:** the workspace engine checks that no tracked file changed during an Ask or Plan turn and offers restore if one did.
- **Always-allow rules:** stored per workspace in `workspaceState` (not in repo settings), passed as `--allowedTools` on later turns so Claude Code's own matcher applies. Within the running turn only exact-string matches auto-approve.
- **Cancel:** SIGINT, then SIGTERM to the process group after a grace period, then SIGKILL. Windows uses `taskkill /T`.
- **Errors:** structured `assistant.error` and `result` fields drive the UX for expired login, rate limit and overload. Human-readable text is shown but never parsed. Show a notice when an environment API key is the active credential.
- **Models:** documented aliases plus user-configured ids. `system/init.model` shows the resolved model.

### 6.6 Workspace engine

- **Tracked set:** files under the conversation's workspace folder, excluding VCS directories, gitignored paths (parsed with the `ignore` package, nested `.gitignore`, no git binary), a default heavy-directory list and user excludes. Per-file size cap (1 to 2 MB; larger files are hash-only: change detected, not restorable). Sensitive patterns (`.env*`, keys, credentials) hash-only by default. Symlinks recorded by target, never followed. File-count and byte caps with visible degradation.
- **Blob store and index:** sha256-addressed gzip blobs. A working index maps path to size, mtime in nanoseconds, mode, hash, stored flag, binary flag and skip reason. Entries with unchanged size and mtime are not re-read; entries modified within about 2 seconds of capture are re-hashed.
- **Turn start (every mode):** incremental baseline pass (stat walk, hash and store new or changed files), then persist the pre-turn index as `open-turn.json` before spawning. Record dirty editor buffers (path, hash, content blob) and warn that the agent sees the saved version (setting: warn, save all, ignore).
- **During the turn:** file-tool calls give exact paths. In `default` mode every Edit and Write reaches the permission handler before it runs; if the file on disk differs from its last known hash, store that content as a blob and mark the path mixed. The handler also pre-captures targets outside the tracked set. Editor save events mark user saves.
- **Turn end, and crash recovery at next activation:** authoritative stat walk, diff against the pre-turn index, store post-state blobs. A rename is a delete plus a create with the same hash.
- **Attribution:** `agent-tool` (named in a successful file-tool call), `agent-command` (changed during a turn that ran opaque tools; inferred), `user` (editor save with no agent tool on the path), `mixed`, `external`. Only agent and mixed entries enter the change set; the rest are listed and never touched.
- **Known state:** a per-path last-known hash, updated at turn end and after AgentCanopy's own reject or restore writes. Conflict checks compare the disk with this hash, so a partial reject does not cause false conflicts later.
- **Checkpoint (per turn):** that turn's changes with before and after hashes, plus dirty-buffer records. Restoring to before turn N touches only paths changed by turns N and later; the target is the `before` of the earliest such turn. A mismatch with the known state is a conflict (skip, 3-way merge for text, or explicit overwrite). Always previewed; a safety checkpoint of the current state is taken first; linear rewind only.
- **Review state (per workspace, cumulative until accepted):** path to review baseline R, agent result A, type, turns, attribution, status. Pending diff is diff(R, current). Accept file drops the entry. Reject file restores R when the disk matches the known state; otherwise a conflict flow: review hunks, revert only the agent's changes by 3-way merge (base A, ours current, theirs R), explicit overwrite, or cancel.
- **Hunks:** computed on demand with zero context from (R, current) for UTF-8 text. Accept advances R by that hunk. Reject rewrites only that hunk after verifying it still matches. Hunk identity is a content hash. Binary and non-UTF-8 files are whole-file only. A file with a dirty buffer refuses reject until saved or reverted.
- **After rejects or restores:** queue a note for the next turn listing the reverted files so the model does not assume its edits still exist.
- **Native diffs:** `vscode.diff` and `vscode.changes` with a read-only snapshot FileSystemProvider on the left and the real file on the right. Per-hunk actions through CodeLens and decorations in the normal editor, commands at the cursor, and a hunk list in the webview review panel.
- **Concurrency:** one Agent-mode turn per workspace at a time. Read-only turns may overlap.
- **GC:** mark and sweep of blobs unreferenced by the index, retained checkpoints and review baselines.
- **Scope limits:** one workspace folder per conversation; files outside it are not tracked.

### 6.7 Plan mode

`plans/<planId>.json` holds versions (number, author agent or user, content validated by a zod schema mirrored as the `submit_plan` JSON Schema, change summary), host-owned user decisions (alternative choices, answers) that carry across versions, and approvals (version, content hash, execution turn). The model sends the complete plan on each revision. Comparing versions renders both to canonical Markdown and opens the native diff editor on virtual documents. Switching to Ask attaches the plan read-only: `submit_plan` is not exposed there, so the plan cannot change. The plan view renders sections, Mermaid diagrams, stages, alternatives as choice cards and open questions as form controls.

### 6.8 Forking

A branch is a new conversation with `parentId` and `forkedAtMessageId`, with messages up to the fork point copied. Fork points are turn boundaries. The session strategy is applied on the branch's first turn:

| Case | Strategy | Label |
| :- | :- | :- |
| Fork at the latest message | `--resume <parent> --fork-session --session-id <new>` | Exact |
| Fork at an earlier message, flag detected and enabled | Add `--resume-session-at <last chain uuid of the kept turn>` | Exact |
| Flag unavailable or disabled, or parent session expired | New session seeded with a size-budgeted transcript of visible messages and one-line tool summaries | Reconstructed, with what was lost |

Forking never changes files. "Fork and restore files to this point" is a separate, previewed checkpoint restore. A sanity check compares the fork's first request size with the recorded context size at the fork point.

### 6.9 Webview and security

- The host is the source of truth; webviews are projections (full snapshot on ready, then patches; several views can attach). Messages are zod-validated discriminated unions in both directions. Text deltas are coalesced before posting.
- CSP: `default-src 'none'`; scripts by nonce plus `cspSource`; styles `cspSource 'unsafe-inline'` (Mermaid needs inline styles); images `cspSource data:` only, so Markdown cannot load remote images; no `connect-src`.
- Markdown: markdown-it with HTML disabled, output through DOMPurify, links intercepted and validated by the host; fenced code rendered by React components with highlight.js; Mermaid with `securityLevel: 'strict'`.
- Pending permission and question prompts are stored in the conversation so they survive webview reloads and navigation. After a restart, answering an expired question sends the answers as a new turn.
- Logs go to a `LogOutputChannel` with redaction: no prompts or content unless a debug setting is on, never the environment or account fields.

### 6.10 Persistence layout (under `context.storageUri`)

`conversations/index.json`, `conversations/<id>.json`, `plans/<id>.json`, `checkpoints/<id>.json`, `review/state.json`, `snapshots/index.json`, `snapshots/open-turn.json`, `snapshots/blobs/`, transient `mcp/turn-<id>.json`. Atomic writes (temp file plus rename).

## 7. Limitations and risks to document

- Subscription use through a third-party tool: today `claude -p` under a plan login draws from subscription limits, but Anthropic calls API-key authentication the preferred route for third-party tools and reserves the right to change billing or enforce. If `--bare` becomes the default for `-p`, subscription logins would stop being read.
- Publisher obligations: the Commercial Terms sentence and the naming rule in section 5.3. README needs a no-affiliation statement for Anthropic and for Cursor.
- Ask mode's guarantee covers the agent's tools, hooks, skills and other MCP servers. Managed-policy hooks cannot be disabled.
- Changes to ignored or oversized paths are listed but not restorable unless pre-captured.
- External side effects are not reverted: operations inside `.git`, databases, network calls, anything outside the workspace folder.
- Deleting a conversation does not delete Claude Code's own transcript. Sessions expire after 30 days by default and then continue with reconstructed context.
- Exact earlier-message forks depend on a flag that is missing from the CLI reference.
- Windows: `.cmd` shims, no SIGINT semantics, no sandbox. It cannot be verified on this machine, only in CI.
- Model list is static aliases plus custom ids. Context usage is approximate.
- TypeScript stays on 6.0.x until typescript-eslint supports 7.

## 8. Open items

### 8.1 Design review to re-run

The review was briefed to attack the draft and return a work breakdown. Questions it was asked:

1. Where does the workspace engine lose or overwrite user data, misattribute a change, or report "restored" when it did not? Cases: editor saves racing the agent; formatters, auto-save and watchers such as a dev server or `tsc -w`; the agent running `git checkout`, `git stash`, `npm install` or a build; case-insensitive filesystems and case-only renames; Unicode normalization on macOS; CRLF and missing trailing newlines in hunks; empty files; file-to-directory swaps; permission-only changes; huge directories appearing mid-turn; mtime granularity; a crash between writing a blob and writing the index; two windows on one folder; deleted extension storage; remote hosts.
2. Is a baseline at every turn start the right cost model? Numbers for a 50k-file, 1 GB tracked workspace.
3. Are the review-state semantics coherent with per-turn checkpoints across partial accepts, rejects, restores and new turns?
4. Any remaining path by which an Ask or Plan turn could modify the workspace or exfiltrate data? What exactly should the init guard check?
5. Loopback MCP host threats: other local users, DNS rebinding, a malicious page or process, the model calling `permission_prompt` directly, replay across turns.
6. Process lifecycle: backpressure, partial and very long lines, stderr, zombie children, cancel during a pending prompt or during baseline capture, deactivation mid-turn, concurrent sends.
7. Webview patch granularity and keeping pending prompts correct across reloads and multiple views.
8. Work packages with disjoint file ownership after an initial contracts package, each with files, inputs, behaviour, acceptance commands and the requirement-12 tests it carries.
9. What is missing relative to the 13 requirements?

### 8.2 Protocol spike checklist (real CLI, Haiku, scratch folder)

1. Text-only prompt with stream-json and partial messages: record a fixture; confirm init and result fields and the exit code.
2. A Read tool call: tool_use and tool_result shapes.
3. Ask argv: `init.tools` equals the allowlist plus `EndConversation`; `init.mcp_servers` is only ours under `--strict-mcp-config` (claude.ai connectors and plugin servers absent); hooks off; slash commands inert; a prompt asking to create a file changes nothing on disk.
4. Permission prompt tool: the exact arguments received; allow, deny with message, `updatedInput`; what happens if the model calls the tool directly; whether `--disallowedTools` on it hides it from the model while it still works as the prompt tool; replies delayed 75 s and over 5 minutes with the per-server `timeout` raised; a Write larger than 40 KB.
5. `AskUserQuestion` through the prompt tool: request shape and answer round trip for single choice, multi-select and free text.
6. Sessions: `--session-id` then `--resume` (is the id kept?); `--fork-session --session-id`; `--resume-session-at` at a turn boundary (codeword test); resume of a missing session (error shape).
7. Cancel: SIGINT mid-stream and mid-tool (result shape, exit code, state on resume); SIGTERM; process-group kill; cancel while a permission prompt is pending.
8. `submit_plan`: allowed through `--allowedTools`; behaviour on schema-invalid input.
9. Agent-mode permissions: Edit and Write reach the prompt tool in `default` mode; a read-only Bash command runs without a prompt; another command prompts.
10. The MCP surface the client actually exercises (methods, headers, GET or SSE attempts, protocol version).
11. Error shape for a nonexistent model. Auth failure cannot be tested without logging out.

### 8.3 Facts still unverified

- The arguments passed to the permission prompt tool.
- Whether `--strict-mcp-config` also excludes claude.ai connectors and plugin MCP servers.
- Whether the MCP per-request and idle timers apply to permission-prompt calls.
- The `diffEditor.codeLens` default.
- The 1.106 release-notes wording for `secondarySidebar` (seen only through a search summary).
- All [R] items in section 5 that the design leans on, in particular the 2.1.295 changelog entry and the `AskUserQuestion` answer shape.

## 9. Draft roadmap and orchestration

| Phase | Content |
| :- | :- |
| 0. Foundations | Scaffold (package.json, tsconfig, esbuild, eslint, prettier, vitest, vsce, CI skeleton, `.gitignore`) and commit of the existing `CLAUDE.md` and `.claude/agents/`; protocol spike and fixtures; contracts in `src/shared` and the provider interface, written by the primary model |
| 1. Foundation | Extension lifecycle, webview shell in the secondary side bar plus editor panel, provider registry, Claude adapter (detect, spawn, parse, cancel), loopback MCP host, conversation store and history, streaming chat |
| 2. Ask mode | Read-only argv, init guard, post-turn verification, file and folder references, context attachments, tool cards |
| 3. Plan mode | Plan store and versions, `submit_plan`, plan view with Mermaid, questions, alternatives and decisions, version compare, Ask-Plan switching, approve-and-execute gate |
| 4. Agent mode | Permission policy and approval UI, allow rules, sandbox option, progress, change detection |
| 5. Review changes | Review engine, native diffs, per-file and per-hunk actions, conflict flows |
| 6. Forking and checkpoints | Branches, the three fork strategies, checkpoint history, preview, restore |
| 7. Polish and release | Accessibility, docs (README, CONTRIBUTING, CHANGELOG, LICENSE, terms and limitations), security review, integration tests, live smoke, VSIX, install check in an isolated profile, CI |

The workspace engine core (blob store, index, change tracker) has no UI dependency and is needed from Phase 2 for post-turn verification, so it should be built in parallel with Phase 1.

**Orchestration per phase:** implementers on Sonnet take file-disjoint work packages in parallel and run build, lint and tests themselves; independent reviewers on the primary model review with adversarial verification; fixes loop back to implementers; the primary model then runs the full checks itself, reviews the diff, and commits. Each workflow stays under 10 agents.

**Verification:** unit tests with vitest (including a scriptable fake CLI spawned as a real process for crash, hang, cancel and auth-failure cases); integration tests with `@vscode/test-cli` against the installed VS Code in an isolated profile; opt-in live smoke suite against the real CLI; `vsce package --no-dependencies`; install check with `code --extensions-dir <scratch> --user-data-dir <scratch> --install-extension <vsix>` so the owner's profile is untouched.

## 10. Addendum: confirmations and design review outcome

### 10.1 Facts confirmed after the draft (all [V], checked at the source page or the installed binary)

- VS Code 1.106 release notes: "Extension authors can now register view containers in the Secondary Side Bar by using the new `secondarySidebar` contribution point." It was proposed-only in 1.104. The contribution-points reference page has not been updated to mention it.
- `diffEditor.codeLens` defaults to false (`diffCodeLens: false` in the VS Code source), so CodeLens does not show inside diff editors by default.
- `window.registerQuickDiffProvider` is proposed-only. `SourceControl.quickDiffProvider` and the `scm/change/title` menu are stable.
- `@vscode/test-cli` supports `useInstallation: { fromPath }` and `launchArgs` (type definitions; the README does not show them).
- The Marketplace icon must be a PNG of at least 128x128; SVG is refused for the manifest icon.
- Changelog 2.1.295: "Fixed `--tools` and `--restricted` not applying to built-in tools that register after launch, and deprecated tool names reaching tools outside the caller's tool set".
- Permission rules: "Rules are evaluated in order: deny, then ask, then allow." A matching ask rule prompts even when a more specific allow rule also matches. List keys such as `permissions.allow` combine across settings files.
- `--settings` takes a file path or inline JSON, sits above user, project and local settings and below managed settings, and "can set any key your user settings file can set". The file must be a regular file of at most 2 MiB. Relative path rules in such a file anchor at the file's directory.
- `--settings '{"disableAllHooks": true}'` turns hooks off for one run whatever the project's settings say. Managed-policy hooks cannot be disabled this way.
- Hooks support `"type": "http"` (url, headers, timeout, `onFailure` from 2.1.295). PreToolUse returns its decision in `hookSpecificOutput.permissionDecision` (allow, deny, ask, defer).
- `--append-system-prompt-file`, `--setting-sources`, `--include-hook-events` and `--no-chrome` exist.
- `AskUserQuestion` is answered with allow plus `updatedInput` echoing `questions` and adding `answers` (question text to chosen label; multi-select labels joined with commas).
- MCP limits: the per-server `timeout` is a hard wall-clock limit per call and also raises the HTTP first-byte timer, which is otherwise 60 s. A call with no response and no progress notification for the idle window (5 minutes for HTTP) aborts; `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` changes or disables that window. `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0` turns automatic backgrounding off.
- `ENABLE_CLAUDEAI_MCP_SERVERS=false` stops claude.ai connectors from loading. No page says whether `--strict-mcp-config` excludes them or plugin servers.
- Bash rules: Claude Code "is aware of shell operators", and every subcommand of a compound command must be allowed.
- Native Windows installs `claude.exe` under the user profile. No documentation of a `.cmd` shim or of interrupting `claude -p` on Windows.
- Still undocumented: the arguments the permission prompt tool receives, and `--resume-session-at` as a CLI flag (the SDK documents `resumeSessionAt` as "Resume session at a specific message UUID").

### 10.2 Design review outcome

An independent review of sections 6 to 9 found three blockers, all addressed in the implementation plan (changes C1 to C3 there):

1. A user edit made between two agent turns became "known state" at the next turn, so a later Reject would have deleted it with no conflict.
2. Changes with inferred attribution (for example a `git pull` during a long command, or work done after a crashed turn) would have entered Reject All.
3. An always-allowed command runs project code, which can rewrite Claude Code's settings and approve everything later.

It also reported measurements on this machine (63,319 files, 1.33 GB): a stat walk takes 0.44 to 0.97 s; reading and hashing files up to 2 MB takes 9.0 s on one thread; per-file gzip runs at 117 MB/s (level 6) or 208 MB/s (level 1).

Reviewer claims not yet verified by the primary model, to be checked in the spike or when the code that depends on them is written: that `-p` applies an untracked local settings file's allow rules without trust; that settings helper commands and the project `env` block run in a never-trusted folder; that a run can take further turns after its first result when background tasks are enabled; that Claude Code waits at most 30 s for output to drain at exit.
