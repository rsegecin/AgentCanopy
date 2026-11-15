# Claude Code CLI protocol: observed behaviour

Observed on 2026-11-11 with Claude Code 2.1.322 on macOS (arm64), using the harness in `spike/` (52 short runs, model `haiku`, subscription login, no API key in the environment). Everything here was seen in real output, not read from documentation. Scrubbed recordings of nine runs are in `test/fixtures/cli/`.

Re-run a scenario with `node spike/run.mjs <id>`; it performs real model calls. `AGENTCANOPY_SPIKE_DIR` chooses where runs happen (default: a folder under the OS temp directory).

Every run used `-p --output-format stream-json --verbose --include-partial-messages --include-hook-events --permission-mode default`, a child environment with all `CLAUDECODE*` and `CLAUDE_CODE_*` variables removed, and then `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`, `CLAUDE_CODE_STARTUP_FAILURE_RESULTS=1`, `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`.

## 1. Gate results

| Gate | Result | Evidence |
| :- | :- | :- |
| S1 Permission prompt tool | Pass | P1 to P4 |
| S2 Long approval waits | Pass | D1: replies after 75, 150 and 330 s all succeeded |
| S3 `AskUserQuestion` through the prompt tool | Pass | Q1: single, multi-select, free text |
| S4 Ask flags give an exact tool set | Pass | T2, T3 |
| S5 Resume, fork, fork at an earlier message | Pass | S1 |
| S6 Mode switch on one session | Pass | S2 |
| S7 Cancel with SIGINT | Pass | C1 to C3 |
| S8 Ask rule and PreToolUse HTTP hook from a settings file | Pass, both | A1x, A2x |
| S9 `submit_plan` | Pass | L1 |
| S10 MCP surface | Recorded | section 3 |
| S11 Sandbox from a settings file | Pass | X1, re-run outside the temp directory |

## 2. Event stream

- Order for a plain text turn: `system/session_state_changed` (running), `system/init`, `system/status`, `stream_event` (message_start, content_block_start, deltas, content_block_stop, message_delta, message_stop), `assistant`, `rate_limit_event`, `result`, `system/session_state_changed` (idle). The `assistant` event for a block arrives after that block's deltas.
- Every event has a unique `uuid` and the run's `session_id`.
- A resumed turn that uses no tools contains no `user` event: the prompt is not echoed.
- `system/init` carries, among others: `tools`, `mcp_servers` (`{name, status, source}`), `plugins` (`{name, path}`), `permissionMode`, `apiKeySource`, `model` (resolved id), `claude_code_version`, `slash_commands`, `skills`, `agents`, `capabilities`, `cwd`. It also carries local paths (`memory_paths`, `messaging_socket_path`), which must not be logged.
- Four plugins with `path: "builtin"` are listed in every run, including under the Ask flags. A read-only guard must accept those and reject any other plugin.
- `result` carries `subtype`, `is_error`, `result`, `num_turns`, `duration_ms`, `usage`, `modelUsage`, `total_cost_usd`, `permission_denials`, `terminal_reason`, `stop_reason`, `api_error_status`, `errors`. It also carries `credential_expires_at`, which must not be logged or stored.
- Tool call: an `assistant` event whose `message.content` holds `{type: "tool_use", id, name, input}`, with `parent_tool_use_id` at the top level. Tool result: a `user` event with `message.content[{type: "tool_result", tool_use_id, content, is_error?}]`, a structured `tool_use_result`, and `tool_result_meta[{id, permission_decision: {decision, source, reason_type?}, non_execution_kind?}]`.
- `permission_decision.source` tells who decided: `config` (Claude Code's own rules or classification; `reason_type` is `mode`, `rule` or `subcommandResults`), `user_temporary` (the host allowed), `user_reject` (the host denied).
- Hook events: `system/hook_started` and `system/hook_response` (`hook_name` such as `PreToolUse:Write`, `outcome`, `exit_code`).
- Default tool list (25 names without a permission host, 30 with one, where `AskUserQuestion` and `EnterPlanMode` appear) includes `Task`, `Bash`, `Edit`, `Write`, `NotebookEdit`, `Read`, `Skill`, `ToolSearch`, `WebFetch`, `WebSearch`. `Glob` and `Grep` are absent from the default set and present when named in `--tools`. There is no `TodoWrite` tool.

## 3. MCP surface the CLI uses

Sequence at startup, identical in every run:

1. `POST` `server/discover` (JSON-RPC id `server-discover-probe-1`, header `mcp-protocol-version: 2026-07-28`). A `-32601` error reply is accepted.
2. `POST` `initialize` with `protocolVersion: "2025-11-25"`.
3. `POST` `notifications/initialized` (answered 202).
4. `GET` with `Accept: text/event-stream`. A 405 reply is accepted.
5. `POST` `tools/list`.
6. `POST` `tools/call` when needed.

Request headers: `accept: application/json, text/event-stream`, `content-type: application/json`, `authorization`, `mcp-protocol-version: 2025-11-25`, and a `user-agent` naming the CLI version. No `Origin` header and no session header.

A server entry of type `http` appears in `init.mcp_servers` as `{"name": "agentcanopy", "status": "connected", "source": "dynamic"}`. Without `--strict-mcp-config`, a claude.ai connector also appears (source `claudeai`); with it, only the configured server does.

## 4. Permission prompt tool

- Arguments received: exactly `{"tool_name": string, "input": object, "tool_use_id": string}`. The request's `_meta` holds `"claudecode/toolUseId"` (the same id) and a `progressToken`.
- `{"behavior": "allow"}` with no `updatedInput` is accepted on 2.1.322.
- `{"behavior": "deny", "message": "..."}`: the model receives the message as an error tool result, the tool does not run, and `result.permission_denials` lists `{tool_name, tool_use_id, tool_input}`.
- `updatedInput` replaces the input the tool runs with. The model is not told: after a host changed a Write's content, the model's reply still described its original content.
- The prompt tool is hidden from the model. It never appears in `init.tools`, tool search does not find it, and the model could not call it when asked to. `--disallowedTools` on it changes nothing: the runtime still calls it.
- Not every tool call reaches the host. Reads inside the working directory, `ls`, and `sleep 45` ran with `source: "config"` and no request. A write through `Bash` (`echo ... > file`, `printf ... > file`) does reach the host.
- The model often writes files through `Bash` instead of `Write` when the prompt does not name a tool.
- Timing: replies after 75, 150 and 330 seconds all worked with a per-server `timeout` of 600000, with a plain JSON reply, with an SSE reply carrying `notifications/progress`, and with the idle timeout disabled. No abort was seen at five idle minutes.
- Cancel while a request is pending: the CLI sends `notifications/cancelled` (`{requestId, reason: "AbortError: user-cancel"}`) and closes the request socket within milliseconds.

## 5. Rules, hooks and sandbox passed with `--settings <file>`

- With `--allowedTools Write Edit` alone, a Write does not reach the host. Adding `{"permissions": {"ask": ["Edit", "Write", "NotebookEdit"]}}` in the settings file makes it reach the host.
- A PreToolUse hook of type `http` in the settings file fires for every tool call, including pre-allowed ones. Body keys: `session_id`, `transcript_path`, `cwd`, `prompt_id`, `permission_mode`, `effort`, `hook_event_name`, `tool_name`, `tool_input`, `tool_use_id`. A `{}` reply lets the call continue.
- Hook order and coverage (scenario H1): PreToolUse fires before the permission request. A denied call gets no further hook of any kind. A command that fails (`ls` on a missing directory) reports through `PostToolUseFailure` (extra body keys `error`, `is_interrupt`, `duration_ms`), not `PostToolUse`. An Edit that fails Claude Code's own validation (the file was not read first) produces no hook and no permission request.
- Project configuration (scenario H2, a folder never opened in interactive Claude Code, with a committed `.claude/settings.json`, `CLAUDE.md` and `.mcp.json`):
  - The project's `env` block reaches the commands the agent runs (`echo $VAR` printed the project's value). A project `"allow": ["Bash"]` rule did not pre-approve a command here; the request still reached the host.
  - Without `--strict-mcp-config`, a stdio server from the project's `.mcp.json` was started at session start (its command ran and wrote a marker file) and listed with `source: "project"`, in a plain `-p` run with no prompt to the user.
  - With `--setting-sources user`: the project's `env` no longer applies, the project's `.mcp.json` server is not started, the claude.ai connector is absent too, and the model reported no instructions from the project's `CLAUDE.md`. A file passed with `--settings` still applies (its ask rule fired).
  - `permissions.ask` rules for `Read`, `Grep`, `Glob` and `Bash` in the `--settings` file send those calls to the host, including `ls`, which Claude Code otherwise runs without asking.
- An invalid rule entry (`"ask": [42]`) is accepted silently: exit code 0, no message. AgentCanopy must validate its own settings file, because the CLI will not.
- `{"sandbox": {"enabled": true, "autoAllowBashIfSandboxed": false}}`: the command still reaches the host for approval, a write inside the working directory succeeds, and a write to the parent folder fails with "operation not permitted". The temp directory stays writable inside the sandbox, which made the first run of this scenario look like a failure. The CLI creates `.claude/.cc-writes/` in the working directory when the sandbox is on.

## 6. Read-only (Ask) invocation

With `--tools Read,Grep,Glob,AskUserQuestion --strict-mcp-config --disable-slash-commands --no-chrome`, a settings file with `disableAllHooks: true`, and `ENABLE_CLAUDEAI_MCP_SERVERS=false`:

- `init.tools` is exactly `["AskUserQuestion", "Glob", "Grep", "Read"]`; `init.mcp_servers` is exactly our server; `slash_commands` and `skills` are empty.
- Asked to create a file by any means, the model tried only `Glob`, said it had no write tool, and the folder was unchanged.
- An MCP tool allowed with `--allowedTools mcp__agentcanopy__submit_plan` is listed in `init.tools` (not deferred behind tool search) and runs without consulting the prompt tool. A 14 KB argument object was accepted. An `isError` reply is shown to the model, which retried.

## 7. `AskUserQuestion`

- Arrives as a permission request with `tool_name: "AskUserQuestion"` and `input.questions[{question, header, options[{label, description}], multiSelect}]`.
- Answer: allow with `updatedInput` equal to the input plus `answers: {"<question text>": "<answer>"}`.
- A single label, a comma-joined multi-select answer (`"Red, Blue"`) and a free-text answer that is not among the options were all accepted and reached the model.

## 8. Sessions

- `--session-id <uuid>` sets the id; `--resume <uuid>` keeps it.
- `--resume <id> --fork-session --session-id <new>` creates a session with the new id and the full history; the original is unchanged.
- Adding `--resume-session-at <uuid>`, with the `uuid` of the last `assistant` event of the turn to keep, cuts the fork after that turn: the fork knew the first codeword and not the second.
- One session accepted an Ask turn (4 tools), an Agent turn (30 tools), then an Ask turn again; context carried across.
- Resuming an unknown id: exit code 1, no `init`, one `result` with `subtype: "error_during_execution"`, `is_error: true` and `errors: ["No conversation found with session ID: ..."]`.

## 9. Cancel and process lifecycle

- SIGINT while streaming: a `user` text event "[Request interrupted by user]", then `result` with `subtype: "error_during_execution"`, `terminal_reason: "aborted_streaming"`, exit code 0 about half a second later. The partial output is persisted and visible on resume.
- SIGINT during a tool: `terminal_reason: "aborted_tools"`, exit code 0, and the tool's child process is gone.
- SIGTERM mid-stream: exit code 143, no `result`, and nothing from that turn is persisted.
- The command a `Bash` call runs is in its own process group, not the CLI's.
- When the CLI's parent is killed, the CLI and its running command keep running (re-parented, still alive after 10 seconds).

## 10. Errors

- Unknown model: exit code 1; a synthetic `assistant` event with the message; `result` with `subtype: "success"`, `is_error: true`, `api_error_status: 404`, `terminal_reason: "api_error"`. `is_error` and `terminal_reason` are the fields to trust, not `subtype`.

## 11. Consequences for the design

- The architecture in the implementation plan stands; no gate failed.
- Because the model often writes through `Bash`, attribution cannot depend on file-tool calls alone. Agent mode will bracket every tool call with PreToolUse and PostToolUse HTTP hooks and scan after each command, so a change made inside a command's window is attributed to that command. PostToolUse over HTTP was confirmed afterwards by the live Agent-mode test. A tool window must also be closed on the tool's result event, because a denied call never reports back through a hook.
- The model-calls-the-prompt-tool threat does not exist on this version, since the tool is hidden. The host still denies requests that name its own tools.
- Progress heartbeats are not required for long waits on this version. They stay in as cheap insurance, since the request supplies a progress token.
- Orphan recovery must signal the recorded CLI process first (so it stops its own commands) before killing anything.
- A sandboxed run creates `.claude/.cc-writes/` in the workspace; the tracker must ignore it.

## 12. Image input (`--input-format stream-json`)

Probed on 2026-11-12 on Windows 10 with CLI 2.1.323, Haiku, spawned without a shell as the runner does.

- With `--input-format stream-json`, stdin takes one line `{"type":"user","message":{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"..."}},{"type":"text","text":"..."}]},"parent_tool_use_id":null}` followed by a newline. Closing stdin after it is enough: the CLI answers, emits `result` and exits 0 about 0.5 to 0.8 s later. No `user` event is echoed on stdout.
- The image is kept in the session: a later `--resume` turn with plain-text stdin, a whole fork (`--resume X --fork-session --session-id Y`) and a cut fork (`--resume-session-at`) all still answered from it.
- With the full Ask-mode argument list (permission prompt tool on the loopback server, `--settings`, `--strict-mcp-config`, `--tools Read,Grep,Glob,AskUserQuestion`), the permission prompt for `Read` arrived and was answered after stdin had been closed.
- PNGs of 3.0 MB and 5.85 MB (a 7.8 MB stdin line) were accepted.
- `--resume` of an unknown session gives the same shape as with text input: exit code 1, no `init`, one `result` with `error_during_execution` and "No conversation found with session ID".
- A PNG declared as `image/jpeg` was still read. Bytes that are not an image did not fail the turn: the model said it could not read the image, and the session resumed normally afterwards.
- Not probed: the Agent-mode argument list (HTTP hooks, sandbox), SIGINT on macOS or Linux in this input mode, stdin lines above 7.8 MB, CLI versions before 2.1.323.

## 13. Permission facts from the documentation (not probed)

Checked on 2026-11-14 against the Claude Code documentation for 2.1.322, for the Auto switch of Agent mode. Nothing in this section was observed in a run.

- **Which tools ask.** The tools reference marks as needing permission: `Bash`, `PowerShell`, `Edit`, `Write`, `NotebookEdit`, `WebFetch`, `WebSearch`, `Monitor`, `Skill`, `ExitPlanMode`, `EnterWorktree`, `Workflow`. It marks as running without asking: subagent launch (`Task`, called `Agent` in the reference), `ToolSearch`, `ListAgents`, `TaskStop`, `EnterPlanMode`, `ExitWorktree`, `CronCreate` / `CronDelete` / `CronList`, `ScheduleWakeup`, `SendMessage`, `RemoteTrigger`, `PushNotification`, `ReportFindings`, `AskUserQuestion`. `DesignSync`, `SendToProject` and `SendToProjectContext` are not in the reference. So the host is never asked about the second group: those calls show as "Allowed by Claude Code".
- **Rules.** "Rules are evaluated in order: deny, then ask, then allow." A bare tool name in `permissions.ask` prompts for that tool, also when an allow rule matches. That a prompt caused by an ask rule goes to `--permission-prompt-tool` in `-p` mode is the behaviour section 4 observed for the named tools; the documentation does not state it for every tool.
- **Sandbox.** macOS, Linux and WSL2 only; on native Windows commands run unsandboxed. The `Bash` input `dangerouslyDisableSandbox` asks to run one command outside the sandbox, behind a prompt. `sandbox.allowUnsandboxedCommands: false` removes that retry and, set through `--settings`, holds against project settings. Whether the permission prompt tool receives the `dangerouslyDisableSandbox` field is not documented.
- **Monitor** runs a background command and "uses the same permission rules as Bash"; its own name also needs permission.
- **Skill.** A skill's `allowed-tools` grants the listed tools for the turn that invokes it, without prompting. That an ask rule still wins over that grant follows from the evaluation order; it is not stated.
- **Subagents.** Their tool calls fire `PreToolUse` and `PostToolUse` like the main agent's. A subagent definition's `permissionMode` applies under a parent in the default mode. Whether a subagent's inner calls reach the permission prompt tool was not probed (see section 14).
- **Plan mode tools.** `EnterPlanMode` switches the session to plan mode without asking. Approving `ExitPlanMode` can switch the session's permission mode for later calls. The policy's `inspect` checks the mode at session start only.
- **Hooks.** "PreToolUse hook decisions don't bypass permission rules": a matching ask rule still prompts when a hook returned allow.

Added on 2026-11-15 for the saved permissions of Phase 11, from the tools reference and the permissions page as published that day. Nothing here was observed in a run either.

- **WebFetch and redirects.** "When a URL redirects to a different host, WebFetch returns a text result that names the original URL and the redirect target instead of following it. Claude then fetches the new URL with a second WebFetch call." That second call is a new tool call, so it reaches the host under the ask rule and is judged on its own address. Redirects that WebFetch does follow exist ("including any redirects WebFetch follows"); the documentation does not say which, beyond "a different host" not being among them, nor whether `www.example.com` and `example.com` count as different hosts. A site saved in AgentCanopy therefore covers what that host serves, including a redirect within it.
- **WebFetch, other behaviour.** "HTTP URLs are automatically upgraded to HTTPS." It refuses `localhost` and any hostname without a dot before making a request. The CLI's own domain rules (`WebFetch(domain:example.com)`) match the hostname without regard to case, support `*` and strip a trailing dot; AgentCanopy does not use them: its site match is done in the host, on the exact `host` of the address (lower case, with a port that is not the default one).
- **PowerShell input.** The permissions page names `command` as the primary content field "for Bash and PowerShell", and the tools reference says hooks "receive the tool's command string in `tool_input.command`, with the same fields as the Bash tool". The tool's own input schema is not printed. The policy reads `command` for both tools.
- **PowerShell rules.** "PowerShell permission rules use the same shape as Bash rules"; "Common aliases are canonicalized before matching" and "Matching is case-insensitive". AgentCanopy does not pass PowerShell rules to the CLI: a saved PowerShell command is matched in the host by exact text, so `ls` and `Get-ChildItem` are two commands there. On Windows the PowerShell tool is not sandboxed ("On Windows, sandboxing is not supported").

## 14. Not covered

- Windows and Linux.
- Authentication failure and rate-limit shapes (not reproducible without logging out or exhausting limits).
- Subagent (`Task`) event shapes, and writes larger than 40 KB.
