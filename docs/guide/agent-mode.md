# Agent mode

Agent mode lets Claude Code edit files and run commands in your workspace folder. AgentCanopy decides what is allowed without asking, asks you about the rest, and records every change so you can review it afterwards.

## Start an Agent turn

Choose **Agent** under the message box and send your request, or [approve a plan](plan-mode.md). Before Claude Code starts, AgentCanopy prepares a baseline of the folder so that changes can be undone later. The turn shows as preparing until that is done, which can take a while for a large folder. You can stop the turn while it waits.

If files have unsaved changes, a warning lists them: the agent reads from disk, so it only sees what is saved. Set `agentCanopy.unsavedFiles` to `ignore` to turn this warning off.

AgentCanopy refuses to start an Agent turn while another turn is running in the same folder, while the last turn's configuration changes are undecided (see [Reviewing changes](reviewing-changes.md)), or while another VS Code window is tracking the same folder. [Troubleshooting](troubleshooting.md) covers each message.

## Project Claude Code settings

Before any turn, AgentCanopy looks at the Claude Code configuration the repository brings: `.claude/settings.json`, `.claude/settings.local.json` and `.mcp.json`, in the folder and at its Git root. Plain permission rules that only deny or ask are ignored by this check. Anything else needs your decision, because Claude Code would run it without asking: hooks, environment variables, helper commands, pre-approved permissions, extra folders the agent may read, tool servers, or a file that cannot be read safely or is not valid JSON.

If there is something, a native dialog, "This project configures Claude Code to run programs", lists it and offers **Ignore Project Settings** and **Use Project Settings**. Use them only if you trust the repository.

- Your answer is remembered for the folder until those files change, and then you are asked again. Dismissing the dialog ignores the settings for that turn only and remembers nothing.
- Ignoring starts Claude Code with only your own user settings, so the project's settings files are skipped and, with them, its `CLAUDE.md` instructions (the dialog says so), and its tool servers are not started. A notice on the turn says the project's settings are ignored.
- Run **AgentCanopy: Ask Again About This Folder's Claude Code Project Settings** to clear the answer for a folder.

## What happens without asking

- **Edits inside the workspace folder** are applied and tracked. They are not blocked, because you review them afterwards. Set `agentCanopy.agent.editApproval` to `ask` to be asked before every edit.
- **Reads and searches inside the folder** (Read, Grep, Glob) go through without a prompt. Outside the folder they ask.
- **Calls you already approved for good.** A command with a saved always-allow rule runs without asking, and so does an MCP tool you chose to always allow. Rules in your own Claude Code user settings can still pre-approve some other kinds of tool calls; the tool card then says "Allowed by Claude Code", and AgentCanopy cannot tell which rule allowed it. This never applies to terminal commands, reads or web access, which always reach AgentCanopy's policy. AgentCanopy does not switch off your own Claude Code permission settings.

## What always asks

A permission card appears in the chat, and the turn waits for you. The card shows the full text of the request. You can type a note under "Tell the agent what to do instead" before denying; the agent receives it. A command is shown in full: every line is shown, each line break is marked, long runs of blank lines are counted, the title gives the number of lines, and a warning appears for a command of more than one line. The card is not height-limited, so a second command cannot hide below the first.

- **Protected paths.** Edits to `.git`, `.vscode`, `.claude`, `.husky` and `.devcontainer` (at any depth), `.github/workflows`, `.mcp.json`, `.npmrc`, `.netrc`, `.env` and `.env.*` ask, even with `editApproval` on `auto`. These files can change what runs later or hold secrets.
- **Anything outside the workspace.** Editing a file outside the folder asks.
- **Every terminal command**, including harmless ones such as `ls`, unless you saved an always-allow rule for that exact command. Choices are **Allow once**, **Always allow** and **Deny**.
- **Web search and fetch**, and **tools from other tool servers** (MCP). Each use asks. For an MCP tool you can choose **Always allow**.

Set `agentCanopy.agent.alwaysAskCommands` to ask before every terminal command and to ignore all saved always-allow rules.

## Always allow

**Always allow** is only offered for a plain command that does not start with an environment variable (`NAME=value`, which can change what runs, such as `PATH`): letters, digits, spaces and the characters `_ . / : = @ % + , ~ -`, up to 300 characters, with no quotes, pipes, redirections, substitutions or globs. The saved rule is exactly that command, `Bash(<command>)`, and the card shows it. A native dialog, "Always allow this?", asks you to confirm; if you decline, the command is allowed once.

If the command could run code from your project or write files (any command not known to only look at things, such as `npm test` or `make`, and also an otherwise harmless one with an environment prefix or with an option that writes output or runs a program, such as `sort -o` or `git -c`), the card warns: "This command runs code from the project, which can do anything you can do." Such a command can rewrite the files that hold your approvals. Think twice before allowing it for good.

Rules are stored per workspace folder, at most 200 of them. If a rule cannot be saved, the command still runs once and you are told: "The command was allowed this once, but the rule to always allow it could not be saved." A PowerShell command always asks.

## Who allowed each call

Each tool card shows one of four labels: "Approved by you" (this includes a saved always-allow rule you created), "Allowed by AgentCanopy" (the edit and read rules above), "Allowed by Claude Code" (only for tools that your own Claude Code settings pre-approve, never for commands) and "Not verified by AgentCanopy".

## Run commands in a sandbox

`agentCanopy.agent.sandbox` turns on Claude Code's sandbox for the agent's commands on macOS, Linux and WSL2. Commands can then write only inside the workspace folder and temporary directories. Commands still ask for approval. Without the sandbox, a command you allow runs with your own privileges and can do anything you can. Claude Code creates a `.claude/.cc-writes` folder in the workspace while the sandbox is on; AgentCanopy ignores it.

## Stop a turn

Click **Stop** in the message box. On macOS and Linux, AgentCanopy interrupts Claude Code first and escalates only if it does not stop. On Windows, stopping ends the process and its children at once.

## After the turn

- The Review tab lists the changed files. Accept or reject them; see [Reviewing changes](reviewing-changes.md).
- If the agent changed Git state, a note says: "The agent changed Git state (commits, branch or stash). Undoing file changes does not undo that."
- If the agent changed Claude Code or editor configuration, you must decide on each file before the next Agent turn.
- Each turn is a step you can go back to; see [Checkpoints and branches](checkpoints-and-branches.md).
- Files you reverted since the last turn are listed in the next prompt, so the agent does not assume its earlier edits still exist.

Background tasks are disabled, so the agent cannot leave a dev server running between turns. See [limitations](../limitations.md) for everything Agent mode cannot do or undo.
