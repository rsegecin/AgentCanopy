# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

Version 0.1.0, the first version. It is not published to the Marketplace; install it from a VSIX built from source.

### Added

- Chat view in the Secondary Side Bar, also available in an editor tab, with a status bar entry and the commands New Conversation, Focus Chat, Open Chat in Editor Area, Add Selection to Chat, Check Claude Code Again, Sign In to Claude Code, Show Logs and Delete Stored File Contents and Change History for This Folder.
- Detection of the locally installed Claude Code CLI (2.1.295 or newer, native `claude.exe` on Windows), its version and sign-in state, with a status indicator and banners. Sign-in opens a terminal running `claude auth login` with the detected executable. A notice appears when `ANTHROPIC_API_KEY` is set. Credentials are never read, stored or forwarded.
- Conversations that persist across restarts, with history, search, rename and delete, a model selector (Claude Code aliases plus custom ids), and context attachments: files and folders by `@` mention, the editor selection and the current problems.
- Ask mode: read-only questions with exactly four tools (Read, Grep, Glob, AskUserQuestion), a guard that verifies what Claude Code reports at the start and on every tool call, prompts for reads outside the workspace, optional web tools, a notice for plugins and hooks (or a refused turn with `agentCanopy.readOnly.strict`), and a check after each turn that reports workspace changes.
- Plan mode: persistent plans saved through a plan tool, with immutable versions, decisions and open questions, Mermaid diagrams, version compare in the diff editor, revert to a version, export, a plan lock, and approval and execution through a native confirmation.
- Agent mode: edits inside the workspace applied and tracked, with prompts for commands, protected paths, anything outside the workspace, web access and external tools; always-allow rules limited to literal commands; tool cards that show who allowed each call; optional sandbox (`agentCanopy.agent.sandbox`); a warning for unsaved files.
- Review of agent changes independent of Git staging: Review tab, native diff editor, CodeLens, gutter marks and a status bar entry, with accept and reject per change, file or all. Keys: Alt+] and Alt+[ to move between changes, Alt+Enter to accept and Alt+Backspace to reject the change at the cursor. Changes that may hold your own work always ask before they are rejected, are kept out of Reject All unless ticked (or entirely, when both you and the agent changed the file or it was reconstructed after an interruption), and files that cannot be restored are marked.
- Detection of configuration changes made by an agent turn (Claude Code and editor settings, hooks, skills, `.mcp.json`, Git hooks), which must be kept or reverted before the next Agent turn, and a note when the agent changed Git state.
- Crash recovery for interrupted turns, with a cross-window lock per folder and "Recover now".
- Checkpoints: a history of agent turns, rejects and restores per workspace folder, a restore preview that sorts files into will be restored, needs your decision and cannot be restored, restores that can be undone, and retention settings that never remove what a pending review entry or the last Agent turn needs.
- Conversation branches from any message, exact where Claude Code allows it and rebuilt from visible messages otherwise, each labeled with which it got and what a rebuilt one lost, with its own copy of the plan and a notice when files are newer than the branch. Restore and Branch From Here combines a restore with a branch.
- Settings under `agentCanopy.*` for the provider path, default mode and model, web tools, strict read-only mode, edit approval, command approval, sandbox, forks, unsaved files, snapshot limits and exclusions and checkpoint retention. Every setting but `unsavedFiles` has machine scope, including the default mode and model.
- No telemetry and no network requests of its own. A loopback-only server serves the CLI's permission, plan and tool-hook calls, protected by a per-turn token.
- Keyboard support for the tabs and review actions, theme colors only with extra borders in high-contrast themes, and status announcements for screen readers. Checked with automated tests, not yet with a screen reader.
- Mermaid diagrams with the classic layout; the ELK layout engine is not shipped.
- A notice when an always-allow rule could not be saved.
- `npm run package` writes the license text of every bundled package to `dist/THIRD_PARTY_LICENSES.txt`, which ships in the VSIX with the third-party notices and the security policy.
- Documentation: README, guides for each mode, review and checkpoints, troubleshooting, limitations, security policy, architecture, contributing and publishing notes, and third-party notices.

### Security

- A check of the project's own Claude Code configuration (`.claude/settings.json`, `.claude/settings.local.json`, `.mcp.json`) before every turn in every mode. When it can run programs or change the environment, a native dialog offers Ignore Project Settings or Use Project Settings. The answer is remembered until the files change. Ignoring skips the project's settings, its `CLAUDE.md` and its tool servers. The command Ask Again About This Folder's Claude Code Project Settings clears it.
- Every shell command, file read and search, edit and web access reaches AgentCanopy's policy. In Agent mode every command asks unless you chose Always allow for that exact command. Reads inside the workspace pass and reads outside ask, in every mode.
- Permission cards show every line of a command, mark each line break and long runs of blank lines, give the line count and warn about multi-line commands. Always allow is not offered for a command that starts with an environment variable, and the warning about commands that run project code covers more commands.
- Links in Mermaid diagrams are inert. Invisible direction-changing and zero-width characters in code blocks are shown as markers with a warning, and Copy copies the original.
- Log redaction covers tokens, e-mail addresses and the home folder in many spellings.
- The Claude Code executable is found only through absolute paths and probed from the home folder. The sign-in fallback terminal opens in the home folder.
- Native confirmations also guard deleting a conversation. Text from the model or the workspace is shown in dialogs on one line with control characters written out.
