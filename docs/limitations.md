# Limitations

This page lists what AgentCanopy does not do, does not guarantee, or cannot undo. It is meant to be complete. If you find a limit that is missing, please report it.

## Read-only modes (Ask and Plan)

- **The guarantee covers the agent's own tools, hooks, skills and other tool servers.** It does not cover hooks from Claude Code's managed policy, helper commands that Claude Code runs when it reads its settings, or plugins. Ask and Plan turn off hooks from your own settings, but an administrator's hooks cannot be turned off. When a plugin other than the built-in ones is loaded, the turn shows a notice that the guarantee is downgraded, or stops with `agentCanopy.readOnly.strict` on. A hook that runs shows a notice, or stops the turn with the strict setting on.
- **Reads inside the workspace folder are not prompted.** That includes files such as `.env`. Claude Code sends what the agent reads to the model.
- **The check after a turn compares file metadata, not content.** It reports changes and never reverts them. It does not see ignored files (`.gitignore`, `node_modules`, `.git` and similar), and it is skipped for a folder with more than 500,000 files.
- **Web tools, when you turn them on, send queries and page addresses off your machine.** Each use asks first.
- The guarantee depends on Claude Code honoring the options AgentCanopy passes. AgentCanopy verifies what Claude Code reports, but it cannot look inside Claude Code.

## Agent mode

- **A command you allow runs with your privileges and can do anything you can**, unless `agentCanopy.agent.sandbox` is on. The sandbox exists on macOS, Linux and WSL2 only, and still leaves the workspace folder and temporary directories writable.
- **Rules in your own Claude Code settings can still pre-approve some tool calls** other than commands, reads and web access, which always reach AgentCanopy's policy. Such calls show as "Allowed by Claude Code". `agentCanopy.agent.alwaysAskCommands` also ignores your saved always-allow rules, so every command asks.
- **Ignoring a project's Claude Code settings also skips the project's `CLAUDE.md`**, together with its settings files and tool servers. The agent then does not see the project's instructions until you choose **Use Project Settings**. AgentCanopy cannot split the two.
- **Always-allow rules exist only for plain literal commands**, not for patterns. A command that contains quotes, pipes, redirections, substitutions or globs, or that starts with an environment variable, asks every time. PowerShell commands always ask.
- **Background tasks are disabled.** The agent cannot keep a dev server or a watcher running between turns.
- The agent has text search (Grep and Glob) but no symbol search.
- You can attach at most 50 files, folders, selections, problem lists or images to one message.

## Pasted images

- **Images can only be pasted** (Ctrl+V or Cmd+V) into the message box: PNG, JPEG, GIF or WebP, at most 5 images and 5 MB together per message. A clipboard that also holds text, as Excel, Word and browsers often do, pastes the text and no image.
- **A message with an image still needs text.** Image-only messages are not supported.
- **AgentCanopy does not store image content.** The bytes stay in memory until the message is sent and the turn ends. Your conversation history keeps only the image's type and size, so earlier messages show an image chip without a preview, and a new window or a restart cannot resend them.
- **Claude Code keeps the image in its own session.** Later turns and exact branches still see it. When Claude Code no longer has the session, or a branch is rebuilt, the earlier images are gone: the new session only learns that an image was attached, and AgentCanopy says so.
- **Branching at your own message keeps its text, not its images.** Paste them again in the branch.
- Checked against Claude Code 2.1.323 on Windows. Images use Claude Code's `--input-format stream-json` input; text-only messages are sent exactly as before.

## Change tracking and restore

- **Only the workspace folder is tracked.** The tracked set leaves out VCS directories, `node_modules`, `.venv`, `venv`, `__pycache__`, files ignored by Git, and paths in `agentCanopy.snapshots.exclude`. Symlinks are recorded and never followed. Empty directories are not tracked. A rename shows as a delete plus a create. A folder with more than 500,000 files is only partly tracked, and AgentCanopy shows a note about it.
- **Changes a command makes to ignored, oversized or over-budget files are detected but not restorable.** Their earlier content was never captured. See `agentCanopy.snapshots.maxFileSizeMB` and `agentCanopy.snapshots.maxTotalSizeMB`. Files the agent edits with its own file tools are always captured before the edit, up to 256 MB.
- **Files matching sensitive patterns** (`.env` files, key and certificate files, `.npmrc`, `.netrc`, `credentials` files, anything in `.ssh` or `.aws`) are hashed and not stored, except that the content before an edit by a file tool is kept, with owner-only permissions. The result of such an edit cannot be restored.
- **File restore does not undo Git operations, databases, network calls or anything outside the workspace folder.** If the agent changes Git state, a note says so.
- **Directories left behind.** Rejecting a created file removes the file, not the directories that were created for it.
- **A hand edit made outside the editor that a command overwrites in the same turn cannot be recovered.** If you change a file with another program while a turn is running, and a command of the agent overwrites that change in the same turn, your version was never captured and is gone.
- **A change someone else makes in the fraction of a second after a command ends can be attributed to that command.** The tracker closes a command's window when its result arrives, and an edit of yours or another program's in that gap looks like the command's work.
- **Files over 256 MB are never written** by a restore. They are left as they are.
- **Hard links and extended attributes are not preserved.** A restore writes a new file and renames it into place.
- **A sub-millisecond window** remains between the last check of a file and the rename that replaces it. A change made by another program inside that window is not detected beforehand. AgentCanopy checks again after writing and keeps a copy if the file changed.
- **Line-by-line review** works for UTF-8 text files up to 2 MiB. Other files are accepted or rejected whole, and binary files have no diff.
- **Moving a workspace folder starts with empty AgentCanopy storage.** Conversations, plans and history of the old location stay where they were.
- **One window per folder.** Only one VS Code window can track changes in a folder at a time.
- **Unsaved editor content is invisible to the agent.** It reads from disk. AgentCanopy warns, but does not save for you.

## Forking and checkpoints

- **Exact forks from an earlier message depend on a Claude Code flag, `--resume-session-at`, that is not in Claude Code's CLI reference.** AgentCanopy checks that the installed CLI accepts it, uses it only when the turn it cuts at finished normally, and `agentCanopy.forks.exactEarlierMessages` turns the feature off. It may stop working in a future release.
- **A rebuilt branch carries only the visible text.** It is rebuilt from the visible messages within a size budget. It does not carry tool inputs and outputs, the model's reasoning, files and selections attached to messages, or pasted images, and the oldest messages are dropped if the transcript is too long. The branch header names what was not carried over.
- **A branch is not exact until its first turn has run, and an exact branch can become rebuilt** if Claude Code no longer has its session.
- **Deleting a conversation deletes AgentCanopy's copy, not Claude Code's own transcript.** Claude Code keeps its sessions on its own schedule and removes old ones after its own retention period. A conversation whose session was removed continues with its visible messages as context.
- **Checkpoints are kept for 50 steps and 30 days by default.** Older ones cannot be restored. Anything a pending or accepted review entry still needs, and anything after the last Agent turn, is kept regardless of these settings.
- **A restore only writes files whose content was captured.** Files in the "Cannot be restored" group of a preview (unsaved in the editor, content not kept, blocked path) are left as they are.
- **Restore and Branch From Here branches only when every chosen file was restored.**
- Forking never changes files, so a branch can see a folder that is newer than the point it was forked from. The branch says so when later turns changed files.
- You cannot fork from the last message of a turn that is still running.

## Sending while the agent works

- **Nothing can be added to a running turn.** Claude Code reads its prompt once, when the turn starts, and AgentCanopy knows no documented way to steer a turn that has begun. A message sent while the agent works is queued (Agent and Plan) or answered apart (Ask).
- **One queued message per conversation.** A second one is refused until you edit, remove or send the first.
- **A queued message is lost if the window reloads** before it is sent. It is kept in memory only, never stored.
- **Send now stops the running turn first**, with the limits of Stop, including that on Windows the Claude Code session keeps nothing of the stopped turn (see Platform below).
- **A side question does not see the turn in progress.** It knows the conversation up to the last finished turn, with the context rebuilt from the visible messages, so it has the limits of a rebuilt branch (see above). It has its own copy of the plan, read-only, and what is decided there does not reach the original conversation's plan. The agent never sees the question or its answer.
- **One side question at a time per conversation**, and none inside a side question that you opened as a conversation. Each one is a branch stored as a conversation, a copy of the finished turns, until you delete it.

## Platform

- **Tested on macOS.** Windows and Linux are covered by the CI configuration, which has not been run yet. Expect problems there.
- **On Windows, 8.3 short names are not recognised as protected paths.** A short name such as `.GIT~1` for `.git` is not matched by the protected-path list, so an edit through it does not get the extra prompt.
- **Windows supports the native install only** (`claude.exe`), not npm shims.
- **Stopping a turn on Windows is a hard stop.** On macOS and Linux AgentCanopy interrupts Claude Code first, and the partial answer is kept. On Windows the process and its children are killed, so the Claude Code session keeps nothing of the stopped turn. That includes a stop made by **Send now** on a queued message: the message is sent into a session that does not contain the stopped turn.
- **On Windows, the process of an interrupted turn cannot be matched by its start time**, so after a crash AgentCanopy may ask you to stop the old process yourself and choose **Recover now**.
- Virtual workspaces and folders that are not on the local file system are not supported. In an untrusted workspace nothing runs and only history is readable.

## Interface

- **A compromised webview could still start a turn or allow a single command without a native dialog.** Native dialogs guard the high-impact actions, and the Content Security Policy and the HTML sanitizer exist to keep script out of the view in the first place. [SECURITY.md](../SECURITY.md) lists what a compromised view could still do.
- **Plans are cards in the chat and a read-only Markdown document, nothing more.** The document is the source: a plan's diagrams are shown as Mermaid text, not drawn, and there is no stage dependency diagram. File names in a plan are not links. A plan version compares only with the version before it, and a plan cannot be exported. Review of single changes (hunks) is only in the editor, through CodeLens, gutter marks and the keys, not in the Changes card.
- **Mermaid diagrams in chat messages use the classic layout only.** The ELK layout engine is not shipped with AgentCanopy because of its license (EPL-2.0). A diagram that explicitly asks for the ELK layout cannot be drawn and shows its source instead.
- Links in Mermaid diagrams are inert: their text stays and nothing opens.
- Diagrams are drawn only when their code block is complete, at Mermaid's strict security level, and with labels as plain SVG text rather than HTML.
- Accessibility has been checked with automated tests only. It has not been tested with a screen reader. See the README.

## Provider (Claude Code)

- **Claude Code is the only provider**, and it must be installed locally at version 2.1.295 or newer. AgentCanopy does not include it.
- **AgentCanopy was built against observed behavior of Claude Code**, recorded on macOS with version 2.1.322 (see `docs/protocol/claude-cli.md`). Windows and Linux, authentication failure and rate-limit output, the shape of subagent events and very large writes were not observed. A new Claude Code version may change behavior that AgentCanopy relies on.
- **The model list is Claude Code's aliases plus the ids you add** in `agentCanopy.customModels`. AgentCanopy does not query the provider for available models.
- **Context usage is approximate.**
- **Usage is yours.** Every turn uses your Claude Code subscription limits or API billing. Check Anthropic's current terms for Claude Code and your plan.
