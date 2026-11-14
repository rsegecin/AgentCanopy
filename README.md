# AgentCanopy

AgentCanopy is a free, MIT-licensed VS Code extension that puts a chat view in the Secondary Side Bar and runs the Claude Code command-line tool for you. It has three modes: Ask (read-only questions about your code), Plan (a saved, versioned plan you review before anything changes) and Agent (edits and commands, with your approval). Everything an agent changes in your folder is tracked, so you can review it, accept or reject it, and go back to an earlier state.

AgentCanopy does not include Claude Code and is not affiliated with, endorsed by, or sponsored by Anthropic or by Cursor. It runs the Claude Code CLI that you installed yourself, unmodified, and uses whatever sign-in that CLI already has. It never asks for, reads, stores or forwards a password, token or API key. Signing in happens in Claude Code itself: the Sign In action opens a terminal running `claude auth login`.

Using AgentCanopy consumes your own Claude Code usage: subscription limits or API billing, depending on how your CLI is signed in. If an `ANTHROPIC_API_KEY` environment variable is set, Claude Code bills that API account, and AgentCanopy shows a notice. Anthropic's terms govern the use of Claude Code and can change. Check Anthropic's current terms for Claude Code and for your plan.

## Requirements

- VS Code 1.106 or newer.
- Claude Code CLI 2.1.295 or newer, installed locally (`claude --version` shows it). On Windows this must be the native installer's `claude.exe`, not an npm shim.
- A trusted workspace folder. Nothing runs in an untrusted workspace or in a window with no folder open.
- Node.js 22 or newer, only to build the extension from source.

AgentCanopy is tested on macOS. Windows and Linux are covered by the CI configuration, which has not been run yet. See [docs/limitations.md](docs/limitations.md).

## Install from source

AgentCanopy is not published to the Marketplace yet. Build a VSIX from a clone of this repository:

```sh
npm install
npm run package
```

This writes `agentcanopy-0.1.0.vsix` to the repository root. In VS Code, run **Extensions: Install from VSIX...** from the Command Palette and pick that file.

## First use

1. Open a folder and trust it.
2. Open the AgentCanopy view in the Secondary Side Bar. If you cannot see it, run **AgentCanopy: Focus Chat** or click **AgentCanopy** in the status bar.
3. Look at the provider status in the view's header. **Ready** means Claude Code was found, is new enough and is signed in. Anything else shows a banner with the reason and a **Check again** or **Sign in** button.
4. Choose a mode (Ask, Plan or Agent) and a model under the message box. New conversations start in the mode set by `agentCanopy.defaultMode`, which is `ask`.
5. Type a message and press Enter (Shift+Enter adds a line). Type `@` to attach a file or folder, or use the buttons beside the model selector to add a file, a folder, the editor selection or the current problems. **AgentCanopy: Add Selection to Chat** is also in the editor context menu.

The tabs are Chat, Checkpoints and History. Checkpoints appears once there is a step in the folder's history. Plans, the agent's questions and the changes an Agent turn made are cards in the chat, not tabs. Use **AgentCanopy: Open Chat in Editor Area** to move the chat into an editor tab.

## While the agent works

You can type and send at any moment. **Stop** and **Send** are both shown while a turn runs. Nothing can be added to a running turn, because Claude Code reads its prompt once when the turn starts, so what happens to a message you send depends on its mode. The mode you choose under the message box applies to the next message and does not affect the running turn, so you can change it while the agent works: choose Ask to ask a side question, or Agent or Plan to queue an instruction of that mode.

- **Agent or Plan.** The message is queued: one per conversation, shown as a chip above the message box with **Edit**, **Remove** and **Send now**. It is sent when the turn completes. After a stop or an error, a message of any mode stays queued and the chip offers **Send**. A queued Agent message also waits, with its **Send** disabled and a line saying what it waits for, while configuration changes are undecided or an Agent turn runs in another conversation of the same folder; a queued Plan message is sent regardless. **Send now** stops the running turn and sends the message. A queued message is kept in memory only, so a window reload loses it.
- **Ask.** The question is answered alongside, in a **Side question** card in the chat, while the agent keeps working. It knows the conversation up to the last finished turn, not the work in progress, and the agent never sees it. One side question runs at a time per conversation. It is a branch: History lists it under its conversation as a side question, and **Open as conversation** on the card continues it.

## Project settings that can run programs

A repository can bring its own Claude Code configuration: `.claude/settings.json`, `.claude/settings.local.json` and `.mcp.json`, in the folder or at its Git root. Claude Code runs hooks, helper commands and tool servers from those files without asking, so opening an untrusted repository and sending one message could run someone else's program.

- Before a turn in any mode, AgentCanopy reads those files. If they hold anything that can run programs or change the environment (hooks, environment variables, helper commands, pre-approved permissions, extra folders, tool servers, or a file that is unreadable or not valid JSON), a native dialog lists it and asks: **Ignore Project Settings** or **Use Project Settings**.
- Your answer is remembered for the folder until those files change. If you dismiss the dialog, the settings are ignored for that turn only.
- Ignoring skips what needed the decision: the project's settings files (and with them its `CLAUDE.md` instructions) and its tool servers. A notice on the turn says so. **AgentCanopy: Ask Again About This Folder's Claude Code Project Settings** clears the answer.

## Modes

### Ask

Ask cannot change your files.

- Claude Code is started with exactly four tools: Read, Grep, Glob and AskUserQuestion. Web search and fetch are added only if you turn on `agentCanopy.ask.webTools`.
- At the start of every turn AgentCanopy checks the tool list, the tool servers, the permission mode and the folder that Claude Code reports, and it watches every tool call and hook event after that. Any mismatch stops the turn.
- Reading a file outside the workspace folder asks you first, and so does every use of web search or fetch.
- When the turn ends, AgentCanopy compares file metadata in the folder with how it was before and reports any change. It only reports; it never reverts.

Details: [docs/guide/ask-mode.md](docs/guide/ask-mode.md).

### Plan

Plan is read-only like Ask, with one added tool that saves a plan.

- The plan is a sequence of cards in the chat: your request, the agent's questions about the options (a plan options card, asked before the plan is written), and one plan card per saved version. The card's title opens the plan as a read-only Markdown document.
- Each save is a new immutable version. The newest card lists your decisions and what is still to decide, and offers **Approve and Execute**, **View changes** (the version before against this one in VS Code's diff editor) and **Revert to the version before**. An older card opens, compares and restores its own version.
- A lock switches the plan tool off, so the agent can discuss the plan but not change it. Ask mode always works with the plan locked.
- **Approve and execute** is the only way a plan runs. You confirm in a native dialog, and an Agent turn starts on the same conversation with the approved version embedded.

Details: [docs/guide/plan-mode.md](docs/guide/plan-mode.md).

### Agent

Agent can edit files and run commands.

- Edits inside the workspace are applied without asking and are tracked for review. `agentCanopy.agent.editApproval` can make every edit ask.
- Every terminal command asks first, including harmless ones such as `ls`, unless you chose **Always allow** for that exact command. Reads inside the workspace go through without a prompt. Reads outside it, edits to protected paths, edits outside the workspace and web access ask first.
- **Always allow** is offered only for a plain literal command, never one that starts with an environment variable, and you confirm it in a native dialog.
- A permission card shows every line of a command, marks each line break and says how many lines there are.
- Each tool card shows who allowed the call: you, AgentCanopy or, for some other tools that your own Claude Code settings pre-approve, Claude Code.

Details: [docs/guide/agent-mode.md](docs/guide/agent-mode.md).

## Reviewing changes

When an Agent turn ends, a **Changes** card appears under the chat. It lists every file the agent changed, with its added and removed lines, and while an Agent turn runs in the folder it says "File changes can be reviewed when the turn ends." in place of the file list. Click a path to open the file's diff in VS Code's diff editor, or use the command **AgentCanopy: Show Agent Changes for File**. The card has **Accept All**, **Reject All** and **Open All in Diff Editor**, **Accept** and **Reject** for each file, and a collapsed **Accepted** group. You can collapse the card. Review of single changes is in the editor: changed lines are marked in the gutter and each change has **Accept Change**, **Reject Change** and **Show Diff** actions above it.

| Action                          | Where                                    | Key           |
| :------------------------------ | :--------------------------------------- | :------------ |
| Next / previous change          | Editor with pending changes              | Alt+] / Alt+[ |
| Accept the change at the cursor | Editor with pending changes              | Alt+Enter     |
| Reject the change at the cursor | Editor with pending changes              | Alt+Backspace |
| Accept or reject a whole file   | Editor title bar, CodeLens, Changes card | none          |
| Accept All, Reject All          | Changes card, Command Palette            | none          |

- Files that may hold your own work (you changed them too, they changed outside one of the agent's tool calls, or they were reconstructed after an interruption) are listed apart. Rejecting one always asks first. Reject All leaves them out unless you tick them, and never rejects a file that both of you changed or that was reconstructed after an interruption.
- A file marked **Cannot be restored** was not captured before the agent changed it, so you can accept it but not put the old content back.
- If the agent changed Claude Code or editor configuration (settings, hooks, skills, `.mcp.json`, Git hooks and similar), the Changes card shows a warning with each file, and you must **Keep** or **Revert** each one, with a confirmation, before the next Agent turn. That section stays visible, also when you collapse the card. Until you decide, Send is disabled in Agent mode and says where to decide; Ask and Plan still work.

Details: [docs/guide/reviewing-changes.md](docs/guide/reviewing-changes.md).

## Checkpoints and branches

Every Agent turn, reject and restore is a step in a per-folder history.

- The Checkpoints tab previews putting files back to what they were before a chosen step. It names every step and conversation that would be undone and sorts files into "Will be restored", "Needs your decision" and "Cannot be restored". Nothing is written until you confirm in a native dialog.
- A restore is a step of its own, so it can be undone. Retention (`agentCanopy.checkpoints.keepOperations`, `keepDays`) never removes anything a review entry still needs or anything after the last Agent turn.
- File restore does not undo Git operations, database changes, network calls or anything outside the folder.

A message has a **Fork from here** action that starts a branch: a new conversation that remembers where it came from. A side question (see above) is a branch too, made for you.

- A branch is exact only when its first turn runs on a copy of the parent's Claude Code session: the whole session, or a cut at the last kept turn when the installed CLI supports it, `agentCanopy.forks.exactEarlierMessages` is on and that turn finished normally.
- Otherwise the context is rebuilt from the visible messages. The branch header says which one it got and names what was not carried over: tool inputs and outputs, reasoning, attached files and selections, and earlier messages that did not fit.
- Forking never touches your files. If later turns changed files, the branch says they are newer than the conversation.

See [docs/guide/checkpoints-and-branches.md](docs/guide/checkpoints-and-branches.md).

## Settings

| Setting                                  | Default   | What it does                                                                                                                 |
| :--------------------------------------- | :-------- | :--------------------------------------------------------------------------------------------------------------------------- |
| `agentCanopy.claude.path`                | empty     | Absolute path to `claude`. Empty means search the absolute entries of `PATH` and `~/.local/bin`.                             |
| `agentCanopy.defaultMode`                | `ask`     | Mode a new conversation starts in (`ask`, `plan`, `agent`).                                                                  |
| `agentCanopy.defaultModel`               | `default` | Model for new conversations: an alias, a full id, or `default` to let Claude Code decide.                                    |
| `agentCanopy.customModels`               | `[]`      | Extra model ids for the model selector.                                                                                      |
| `agentCanopy.ask.webTools`               | `false`   | Let Ask and Plan use web search and fetch. Fetched pages and queries leave your machine.                                     |
| `agentCanopy.readOnly.strict`            | `false`   | Refuse Ask and Plan turns when a plugin other than the built-in ones is loaded.                                              |
| `agentCanopy.agent.editApproval`         | `auto`    | `auto` applies edits inside the workspace and reviews them afterwards; `ask` asks before every edit.                         |
| `agentCanopy.agent.alwaysAskCommands`    | `false`   | Ask before every terminal command and ignore all always-allow rules.                                                         |
| `agentCanopy.agent.sandbox`              | `false`   | Run commands in Claude Code's sandbox (macOS, Linux, WSL2).                                                                  |
| `agentCanopy.forks.exactEarlierMessages` | `true`    | Ask Claude Code to cut its session when branching from an earlier message. Uses a flag missing from Claude Code's reference. |
| `agentCanopy.unsavedFiles`               | `warn`    | Warn at the start of a turn when files have unsaved changes (`warn` or `ignore`).                                            |
| `agentCanopy.snapshots.maxFileSizeMB`    | `10`      | Largest file whose content is captured for undoing command changes.                                                          |
| `agentCanopy.snapshots.maxTotalSizeMB`   | `512`     | Disk budget for captured content per workspace.                                                                              |
| `agentCanopy.snapshots.exclude`          | `[]`      | Extra paths to leave out of change tracking, in `.gitignore` syntax.                                                         |
| `agentCanopy.checkpoints.keepOperations` | `50`      | Checkpoints kept per workspace folder.                                                                                       |
| `agentCanopy.checkpoints.keepDays`       | `30`      | Days checkpoints are kept.                                                                                                   |

Every setting except `agentCanopy.unsavedFiles` has machine scope, so a repository's `.vscode/settings.json` cannot change them, including the default mode and model.

## Commands

All commands are in the Command Palette under the category AgentCanopy. The review commands appear only while agent changes are pending.

| Command                                                        | What it does                                                                                          |
| :------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------- |
| New Conversation                                               | Start a conversation (also the plus button in the view)                                               |
| Focus Chat                                                     | Move focus to the chat view                                                                           |
| Open Chat in Editor Area                                       | Show the chat in an editor tab                                                                        |
| Add Selection to Chat                                          | Attach the editor selection (also in the editor context menu)                                         |
| Check Claude Code Again                                        | Detect Claude Code, its version and its sign-in state again                                           |
| Sign In to Claude Code                                         | Open a terminal running `claude auth login`                                                           |
| Show Logs                                                      | Open the AgentCanopy output channel                                                                   |
| Ask Again About This Folder's Claude Code Project Settings     | Clear your answer about the project's Claude Code settings, so the next turn asks again               |
| Delete Stored File Contents and Change History for This Folder | Delete the captured file contents, the list of agent changes and the checkpoint history of one folder |
| Show Agent Changes for File / Show All Agent Changes           | Open the diff of one file or of every pending file                                                    |
| Accept / Reject Agent Changes in File                          | Decide on a whole file                                                                                |
| Accept / Reject Agent Change at Cursor                         | Decide on one change                                                                                  |
| Go to Next / Previous Agent Change                             | Move between changes in a file                                                                        |
| Accept All / Reject All Agent Changes                          | Decide on everything pending                                                                          |

## Limits at a glance

- Ask and Plan do not cover hooks from managed policy, settings helper commands or plugins. Plugins show a notice, or stop the turn with `agentCanopy.readOnly.strict`.
- A command you allow in Agent mode runs with your privileges unless the sandbox setting is on.
- Changes a command makes to ignored, oversized or over-budget files are detected but cannot be restored.
- Background tasks are disabled, so the agent cannot leave a dev server running between turns.
- Images can only be pasted, at most 5 images and 5 MB together per message, and a message with an image still needs text. The agent has text search but no symbol search.
- Nothing can be added to a running turn: an Agent or Plan message waits in a queue, and a side question does not see the work in progress.
- Windows supports the native Claude Code install only, and stopping a turn there is a hard stop.

## Keyboard, contrast and screen readers

- The review keys above work when the editor shows a file with pending changes. Every review action is also a command in the Command Palette.
- The tabs (Chat, Checkpoints, History) form a tab list: use the arrow keys, Home and End to move between them. Pressing Escape in the message box while a turn runs moves focus to Stop. Escape closes the **More actions** menu and the `@` picker and cancels a rename.
- Controls have text names that say what they act on, state is never shown by color alone, and the interface uses only VS Code theme colors, with extra borders in high-contrast themes. Animation respects the reduced-motion setting.
- Streaming text is not announced. A short status line announces that the agent is working, finished, failed or was stopped, and when it waits for your answer.
- This has been checked with automated tests and a written checklist (`src/webview/ACCESSIBILITY.md`). It has not yet been tested with a screen reader, so expect rough edges.

## Privacy and security

AgentCanopy has no telemetry and makes no network requests of its own. Its only server listens on the loopback interface, for the CLI's permission, plan and tool-hook calls during a turn. Claude Code itself sends your prompts and the files it reads to the model provider; that is Claude Code's behavior, under Anthropic's terms. Conversations, plans and the change history are stored on your machine in VS Code's per-workspace storage. Read [SECURITY.md](SECURITY.md) for the trust model, what is stored and how to report a vulnerability, and [docs/limitations.md](docs/limitations.md) for everything the guarantees do not cover.

## Documentation

- Guides: [Ask](docs/guide/ask-mode.md), [Plan](docs/guide/plan-mode.md), [Agent](docs/guide/agent-mode.md), [Reviewing changes](docs/guide/reviewing-changes.md), [Checkpoints and branches](docs/guide/checkpoints-and-branches.md), [Troubleshooting](docs/guide/troubleshooting.md)
- [Limitations](docs/limitations.md), [Security](SECURITY.md), [Changelog](CHANGELOG.md)
- For contributors: [CONTRIBUTING.md](CONTRIBUTING.md), [Architecture](docs/architecture.md), [Publishing](docs/publishing.md), [Third-party notices](THIRD_PARTY_NOTICES.md)

## License

MIT. See [LICENSE](LICENSE).
