# Agent mode

Agent mode lets Claude Code edit files and run commands in your workspace folder. AgentCanopy decides what is allowed without asking, asks you about the rest, and records every change so you can review it afterwards.

## Start an Agent turn

Choose **Agent** under the message box and send your request, or [approve a plan](plan-mode.md). Before Claude Code starts, AgentCanopy prepares a baseline of the folder so that changes can be undone later. The turn shows as preparing until that is done, which can take a while for a large folder. You can stop the turn while it waits.

If files have unsaved changes, a warning lists them: the agent reads from disk, so it only sees what is saved. Set `agentCanopy.unsavedFiles` to `ignore` to turn this warning off.

An Agent turn does not start in these cases. [Troubleshooting](troubleshooting.md) covers each message.

- **Configuration changes from the last turn are undecided** (see [Reviewing changes](reviewing-changes.md#configuration-changes)). In Agent mode the message box disables Send and says where to decide, in the Changes card under the chat. Ask and Plan still work, and **Approve and Execute** on a plan is disabled too.
- **Another Agent turn is running in the same folder.**
- **Another VS Code window is tracking the same folder.**

## Send while the agent works

**Stop** and **Send** are both shown while a turn runs. Nothing can be added to a running turn, so an Agent message sent meanwhile is queued. The mode you choose under the message box applies to the next message and does not affect the running turn: you can change it while the agent works, to **Agent** or **Plan** to queue an instruction of that mode, or to **Ask** to ask a side question. There is one queued message per conversation, and the chip above the message box shows its text with **Edit** (back into the message box), **Remove** and **Send now**.

- The queued message is sent only when the conversation's own running turn completes, or when you press **Send**. Nothing else sends it.
- If the turn was stopped or ended with an error, a message of any mode stays queued and the chip offers **Send** instead.
- A queued Agent message is held back, when the turn completes, while configuration changes are undecided or an Agent turn is running in the same folder in another conversation. While the turn runs the chip says "Sent when the agent finishes if the configuration changes are decided by then. Otherwise press Send afterwards." or "Sent when the agent finishes if the other agent turn in this folder has ended by then. Otherwise press Send afterwards." Afterwards its **Send** is disabled and the chip says "Decide on the configuration changes, then press Send." or "Another agent turn is running in this folder. Press Send when it has ended." When the blocker clears, the message is not sent by itself: press **Send**. A queued Plan message is not held back by those two.
- **Send now** stops the running turn and then sends the message. If a queued Agent message could not be sent afterwards (configuration changes are pending, or another conversation's Agent turn is running in the folder), the turn is not stopped and a warning says why. Stopping on Windows is a hard stop; see [limitations](../limitations.md#platform).
- The queued message is kept in memory only. If the window reloads before it is sent, it is gone.

A question in Ask mode is not queued; see [Ask mode](ask-mode.md#ask-while-the-agent-works). If a side question could not be started, a warning appears in the chat view: "The side question could not be started."

## Project Claude Code settings

Before any turn, AgentCanopy looks at the Claude Code configuration the repository brings: `.claude/settings.json`, `.claude/settings.local.json` and `.mcp.json`, in the folder and at its Git root. Plain permission rules that only deny or ask are ignored by this check. Anything else needs your decision, because Claude Code would run it without asking: hooks, environment variables, helper commands, pre-approved permissions, extra folders the agent may read, tool servers, or a file that cannot be read safely or is not valid JSON.

If there is something, a native dialog, "This project configures Claude Code to run programs", lists it and offers **Ignore Project Settings** and **Use Project Settings**. Use them only if you trust the repository.

- Your answer is remembered for the folder until those files change, and then you are asked again. Dismissing the dialog ignores the settings for that turn only and remembers nothing.
- Ignoring starts Claude Code with only your own user settings, so the project's settings files are skipped and, with them, its `CLAUDE.md` instructions (the dialog says so), and its tool servers are not started. A notice on the turn says the project's settings are ignored.
- Run **AgentCanopy: Ask Again About This Folder's Claude Code Project Settings** to clear the answer for a folder.

## What happens without asking

- **Edits inside the workspace folder** are applied and tracked. They are not blocked, because you review them afterwards. Set `agentCanopy.agent.editApproval` to `ask` to be asked before every edit.
- **Reads and searches inside the folder** (Read, Grep, Glob) go through without a prompt. Outside the folder they ask, unless you allowed them for this folder; see [Permissions](#permissions).
- **Claude Code's memory for this folder.** Reads and searches (Read, Grep, Glob) of the `memory` folder that Claude Code keeps for this workspace folder go through without a prompt, in Ask, Plan and Agent mode alike. The tool card says "Allowed by AgentCanopy". The folder is `projects/<slug>/memory` under Claude Code's configuration directory: `CLAUDE_CONFIG_DIR` when that is set to an absolute path, otherwise `~/.claude`. `<slug>` is the workspace folder's path with every character other than a letter or digit replaced by `-`, as Claude Code builds it. Edits there, the memory of other projects, the rest of `~/.claude`, a link inside the memory folder that leads elsewhere, a memory folder that is itself a link, and a folder whose slug is longer than 200 characters still ask. Two folders whose paths give the same slug share one memory folder in Claude Code itself.
- **Read-only terminal commands** (Bash, in Agent mode), while `agentCanopy.agent.alwaysAskCommands` is off. A command such as `git status`, `git log --oneline | head` or `grep -rn text src` runs without asking when AgentCanopy can tell that it only reads files inside the workspace folder and prints. The tool card says "Allowed by AgentCanopy". Anything AgentCanopy does not fully understand asks, as before. The rules are under [Read-only commands](#read-only-commands).
- **Calls you already approved for good.** A command with a saved always-allow rule runs without asking, and so does an MCP tool you chose to always allow. So do a read or search in a folder you saved or while the reads switch is on, an edit outside the workspace folder in a folder you saved for edits, a web fetch to a site you saved or while the fetch switch is on, and a web search while the search switch is on; see [Permissions](#permissions). Rules in your own Claude Code user settings can still pre-approve some other kinds of tool calls; the tool card then says "Allowed by Claude Code", and AgentCanopy cannot tell which rule allowed it. This never applies to terminal commands, reads or web access, which always reach AgentCanopy's policy. AgentCanopy does not switch off your own Claude Code permission settings.
- **Commands and, with `editApproval` on `ask`, edits inside the folder, when Auto is on for the conversation.** Auto is off until you turn it on in a native dialog. See [Auto](#auto).

### Read-only commands

A Bash command runs without asking, labelled "Allowed by AgentCanopy", only when all of the following hold. Otherwise it asks, as before. [Security](../../SECURITY.md#read-only-commands) says how the check works and what it trusts.

- **Nothing decided it first.** A saved always-allow rule is checked first ("Approved by you"), then Auto ("Auto-approved"). This rule comes after both, and they keep their labels.
- **`agentCanopy.agent.alwaysAskCommands` is off.**
- **The call comes from the main session, and Claude Code reported the workspace folder as its working directory.** AgentCanopy reads that from the PreToolUse hook that it installs in Agent mode. A command run by a subagent asks. With `disableAllHooks` in your Claude Code user settings no hook arrives, and every command asks. Every Bash call of an Agent turn starts in the folder, so a `cd` does not carry over to the next call.
- **The project's own Claude Code settings are not in use, or hold only the safe set.** If you chose **Use Project Settings** and they hold environment variables, hooks or helper commands, read-only commands ask, because those settings can change what a command name runs.
- **The folder is not your home folder or above it, and not inside a credential location.** Every entry of `PATH` is an absolute path outside the folder. On Windows an empty entry is ignored, because Git Bash drops it.
- **The command is made only of these commands, with the options AgentCanopy lists for each:** `ls`, `cat`, `head`, `tail`, `wc`, `nl`, `stat`, `file`, `du`, `df`, `cut`, `tr`, `diff`, `cmp`, `sort`, `uniq`, `grep`, `egrep`, `fgrep`, `rg`, `find`, `sed` (scripts that only print), `echo`, `printf`, `pwd`, `which`, `whoami`, `uname`, `date`, `basename`, `dirname`, `realpath`, and `git` with `status`, `diff`, `log`, `show`, `shortlog`, `rev-list`, `rev-parse`, `ls-files`, `ls-tree`, `blame`, `describe`, `cat-file`, `check-ignore`, `reflog`, `grep`, the listing forms of `branch` and `tag`, and `remote -v`. An option that is not listed asks, and so does an abbreviated long option.
- **The shape is simple.** Commands may be joined with `|`, `&&`, `||` and `;`, and may start with `cd <the workspace folder> &&`. The only redirections are `2>&1`, `>&2` and output to `/dev/null`. Variables, substitutions, `~` paths, globs (except the patterns of grep `--include` and rg `--glob`) and line breaks ask, and so does a command of more than 2,000 characters, 64 words or 16 simple commands.
- **Every file the command names lies inside the folder after links are followed.** `git` also needs the folder's own `.git` directory at its root. A folder whose `.git` is a file (a linked worktree or a submodule) asks for git commands. On Windows, MSYS paths such as `/c/...` ask.
- **It is not a PowerShell command.** PowerShell commands are unchanged: they ask unless saved or Auto is on.

A read-only command can read any file inside the folder, as the Read tool can; reads inside the folder never asked. What it reads is sent to the model.

## What asks

A permission card appears in the chat, and the turn waits for you. The card shows the full text of the request. You can type a note under "Tell the agent what to do instead" before denying; the agent receives it. A command is shown in full: every line is shown, each line break is marked, long runs of blank lines are counted, the title gives the number of lines, and a warning appears for a command of more than one line. The card is not height-limited, so a second command cannot hide below the first.

- **Protected paths.** Edits to `.git`, `.vscode`, `.claude`, `.husky` and `.devcontainer` (at any depth), `.github/workflows`, `.mcp.json`, `.npmrc`, `.netrc`, `.gitattributes`, `.env` and `.env.*` ask, even with `editApproval` on `auto` and with Auto on. These files can change what runs later or hold secrets. `.gitattributes` selects the diff and filter programs that git's system configuration defines (`astextplain` and `git-lfs` on Git for Windows).
- **Anything outside the workspace.** Editing a file outside the folder asks, also with Auto on, unless you saved the folder that holds the file for edits (see [Permissions](#permissions)). The card, "Edit a file outside the workspace", offers **Allow once** and **Deny**, and **Always allow** when that folder may be saved. Reading or searching outside the folder asks too, also with Auto on, unless the folder's reads switch is on or you saved a folder that holds the target (see [Permissions](#permissions)). When one folder covers everything the call touches and may be saved, the card also offers **Always allow**. Credential locations and AgentCanopy's own storage always ask, with only **Allow once** and **Deny**. The one exception is reading or searching Claude Code's memory for this folder (see above).
- **Terminal commands**, unless you saved an always-allow rule for that exact command, Auto is on for the conversation, or the command is [read-only](#read-only-commands). A command that writes, runs project code (`npm test`, `make`), names a file outside the folder or is not fully understood asks, and so does every PowerShell command. Choices are **Allow once**, **Always allow** and **Deny**. A command that asks to run outside the sandbox always asks, with or without Auto, and no always-allow rule is offered for it.
- **Web search and fetch**, unless a switch or a saved site of this folder covers it, or Auto is on and `agentCanopy.agent.auto.webTools` is on (the default), and **tools from other tool servers** (MCP), also with Auto on. Each use asks. For a fetch you can choose **Always allow** for the site, and for an MCP tool for the tool; a search card has no **Always allow**.
- **Other tools that need permission** (`Skill`, `Monitor`, `ExitPlanMode`, `EnterWorktree`, `Workflow`, and any tool AgentCanopy does not know), also with Auto on.

Set `agentCanopy.agent.alwaysAskCommands` to ask before every terminal command, read-only ones too, and to ignore all saved always-allow rules for commands and tools. It also stops Auto from approving commands. It does not change reads or web access: saved folders, saved sites and switches still apply.

## Always allow

**Always allow** is only offered for a plain command that does not start with an environment variable (`NAME=value`, which can change what runs, such as `PATH`): letters, digits, spaces and the characters `_ . / : = @ % + , ~ -`, up to 300 characters, with no quotes, pipes, redirections, substitutions or globs. The saved rule is exactly that command, `Bash(<command>)`, and the card shows it. A native dialog, "Always allow this?", asks you to confirm; it names the command. If you decline, the command is allowed once.

**Always allow** is offered for four other things, with the same dialog and the same result when you decline:

- **A PowerShell command**, only when it is plain: letters, digits, spaces and the characters `_ . / \ : -`, from 1 to 300 characters, with no space at either end. The saved rule is `PowerShell(<command>)`, and it matches that exact text. It warns about project code in the same way as a Bash command, with its own short list of commands known to only look at things (such as `Get-ChildItem`, `Get-Content` and `git status`). With `agentCanopy.agent.alwaysAskCommands` on it is not offered and a saved one is ignored.
- **A folder**, on the card of a read or search outside the folder. The card says that **Always allow** would allow reads and searches in that folder and below, and shows the folder that would be saved: the path itself when it is a folder, otherwise the folder that holds it. The dialog names that folder and the workspace folder it is saved for. It is not offered when the folder is a drive or filesystem root, your home folder or a folder above it, a credential location or AgentCanopy's own storage or a folder inside one of them, a folder that holds one of them, or on Windows a network path (`\\server\share`). It is not offered either when the path contains a line break, another control character or an invisible direction-changing character, when the request uses a path form that AgentCanopy cannot judge or a pattern with `..` after a wildcard or with an alternative in braces that starts at a root, a drive or your home folder (see [limitations](../limitations.md#saved-permissions-and-switches)), or when the targets of one call are not in one folder, for example a search path and a pattern that lead to different places. The call then asks with **Allow once** and **Deny** only.
- **A folder to edit in**, on the card of an edit outside the workspace folder. The card says that **Always allow** would allow edits in the folder that holds the file and below, and shows that folder. The dialog names it and the workspace folder it is saved for, and says that reads and searches there no longer ask either, in Ask, Plan and Agent mode, and that what is read is sent to the model. It also says that review and checkpoints do not cover files outside the workspace folder: AgentCanopy cannot show or undo these edits. It is not offered for a folder inside the workspace folder, a drive or filesystem root, your home folder or a folder above it, a credential location or AgentCanopy's own storage or a folder inside one of them, a folder that holds one of them, a network path on Windows or a protected location (see below), nor for a protected file. The edit then asks with **Allow once** and **Deny** only.
- **A web site**, on the card of a web fetch. The card says that **Always allow** would allow fetching any address on that site, and the dialog names the site and the workspace folder. It is not offered for an address that has a user name or password, is not `http` or `https`, has a backslash, a space or a control character, or cannot be read as an address.

If the command could run code from your project or write files (any command not known to only look at things, such as `npm test` or `make`, and also an otherwise harmless one with an environment prefix or with an option that writes output or runs a program, such as `sort -o` or `git -c`), the card warns: "This command runs code from the project, which can do anything you can do." Such a command can rewrite the files that hold your approvals. Think twice before allowing it for good.

Everything you save belongs to one workspace folder, and the [Permissions](#permissions) tab lists it. Rules for Bash commands and tools from other tool servers are at most 200 per folder, and so are the saved folders, sites and PowerShell commands together. If a rule for a command (Bash or PowerShell) or a tool cannot be saved, the call still runs once and you are told: "The command was allowed this once, but the rule to always allow it could not be saved." If a folder or a site cannot be saved, the call is allowed once and you are told: "It was allowed this once, but the permission to always allow it could not be saved." A PowerShell command that is not plain asks every time, unless Auto is on.

## Permissions

The **Permissions** tab shows what is allowed without asking in the workspace folder the view shows, and lets you take it away. Open it from **More actions > Permissions**, or run **AgentCanopy: Show Permissions**. Its tab button is in the tab list while the folder has something saved or a switch on, and while the tab is selected. The switches, saved folders and saved sites apply in Ask, Plan and Agent mode alike; saved commands and tools, and the edits that a folder saved for edits allows, only in Agent mode.

Everything on the tab belongs to one workspace folder. It is stored in the extension's storage for the workspace, never in the repository or in VS Code settings, so another project asks again and a clone of the repository brings nothing with it.

- **Allowed without asking in this folder.** Three switches, each showing **Ask** or **Allow**, all off until you turn them on:
  - **Reads outside the folder**: the agent reads and searches files anywhere on this machine without asking, in every mode. What it reads is sent to the model. Credential locations and AgentCanopy's own storage still ask, except Claude Code's memory for this folder. The switch never allows edits outside the folder.
  - **Web fetch**: any web address is fetched without asking. A page can carry instructions for the agent, and an address can carry file contents out.
  - **Web search**: every search runs without asking. The query leaves your machine.

  There is no switch for commands (Auto is that, per conversation) or for tools from other tool servers. In Ask and Plan the web tools exist only while `agentCanopy.ask.webTools` is on, and the tab says so while it is off.
- **Saved permissions.** Everything you chose **Always allow** for in this folder, in groups: folders (read and edit), folders (read), web sites, commands (Bash and PowerShell, with the warning about project code where it applies) and tools. It also lists the commands and tools you saved before this tab existed. Each entry has **Remove**. **Allow reads in a folder...** opens the system's folder picker to save a folder for reading without waiting for a card. **Allow edits in a folder...** does the same for a folder outside the workspace folder that the agent may also edit in, with the limits of **Always allow** for a folder to edit in (see above). A folder saved for edits is listed under "Folders (read and edit)" and one saved for reads only under "Folders (read)"; after **Remove**, the next edit there asks again. A folder saved for reads only never allows edits.
- **Always asks.** What no switch or saved permission covers: edits outside the folder, unless you saved the folder for edits; edits to protected files; tools that are not from a tool server; and credential locations and AgentCanopy's own storage (reading Claude Code's memory for this folder is the exception). In a folder saved for edits these still ask every time, with only **Allow once** and **Deny**:
  - protected files: anything in or below `.git`, `.vscode`, `.claude`, `.husky`, `.devcontainer` and `.github/workflows`, and files named `.env`, `.env.*`, `.npmrc`, `.netrc`, `.mcp.json` and `.gitattributes`;
  - credential locations (such as `~/.ssh`, `~/.aws`, `~/.claude` and, on Windows, `AppData`), AgentCanopy's own storage and network shares;
  - a link inside the folder that points out of it.
- **Settings for every project.** The current value of six settings that shape what asks, read-only: `agentCanopy.agent.editApproval`, `agentCanopy.agent.alwaysAskCommands`, `agentCanopy.ask.webTools`, `agentCanopy.agent.auto.enabled`, `agentCanopy.agent.auto.webTools` and `agentCanopy.agent.sandbox`. **Open Settings** opens the editor's settings on this extension, where you change them. They apply to every project on this machine.

Adding and removing are not alike:

- **Adding needs a native dialog.** Turning a switch on, **Allow reads in a folder...** and **Allow edits in a folder...** (after you pick the folder) each open one, which names the workspace folder and what would be allowed, and nothing changes unless you confirm. They are refused in an untrusted workspace, when the view has no folder and while another permissions dialog is open. If the folder the view shows or the trust of the workspace changes while the dialog is open, nothing is changed. A folder you pick can also be refused with a message of its own: see [Troubleshooting](troubleshooting.md#permissions-messages).
- **Removing needs no dialog.** Turning a switch off and **Remove** work at once, also while a turn is running: the next request of that turn asks again.

A saved permission or a switch that allows a call is checked before Auto, and the call is labelled "Approved by you". `agentCanopy.agent.alwaysAskCommands` ignores saved commands and tools but not folders, sites or switches. What the saved permissions cover and do not cover is in [limitations](../limitations.md#saved-permissions-and-switches).

## Auto

Auto is a switch, per conversation, with which Agent turns run terminal commands and edits inside the folder without a prompt for each one. It is off until you turn it on. It exists because approving every command is slow, and it removes a safeguard on purpose: with Auto on, nothing reviews a command before it runs, and the command runs with your privileges. Text in files, tool output or web pages the agent reads can steer it into running something you would have refused. Read [Security](../../SECURITY.md#auto) before you use it.

### Turn it on

1. In Agent mode, click **Auto** next to the mode selector. You can do this before the first message of a new conversation: the first message you send, in any mode, then creates the conversation with Auto on, in the folder the dialog named.
2. A native dialog, "Turn on Auto for this conversation?" (for a new conversation, "Turn on Auto for the new conversation?"), opens. It starts with two labelled lines, `Folder: <path>` (the home directory shown as `~`, a very long path shortened in the middle with an ellipsis so that its start and its end stay visible; the folder's display name is not shown, because a workspace file can set it to anything) and `Conversation: <title>` (a long title is cut; `Conversation: new` for a new conversation), then says: "Agent turns in this conversation run terminal commands and edits inside the folder without asking for each one. Commands run with your privileges." With `agentCanopy.agent.alwaysAskCommands` on it says instead that edits run without asking and commands still ask. It states what is known about the sandbox: not sandboxed; requested by your settings but not verifiable, in which case a command cannot leave it; or set but not available on this platform. It lists what still asks, says that review and checkpoints undo file changes inside the folder only, not what a command does outside it, to Git or over the network, and that a command can change protected files without asking. It also says that Auto stays on for the conversation, also for queued messages and approved plans, until you turn it off.
3. Confirm with **Turn On Auto**. The webview can ask for the dialog but only the dialog turns Auto on.

Approving a [plan](plan-mode.md#auto-and-plan-execution) is another way to turn Auto on. Its dialog, "Approve and execute this plan with Auto?", says "Approving also turns on Auto for this conversation." and then everything the dialog above says, and **Approve and Execute with Auto** is the confirmation. It applies when Auto is offered and not yet on for the conversation.

Auto can only be turned on for the conversation the view shows; for any other, the refusal reads "Open the conversation to turn Auto on." It can only be turned on between turns. The switch is disabled while a turn runs ("Auto can be turned on when the turn ends."), and it is refused while a plan approval dialog is open, while another Auto dialog is open, in an untrusted workspace, for a conversation whose folder is closed and when `agentCanopy.agent.auto.enabled` is off. If anything that the dialog depends on changes while it is open, including the three settings its text names, Auto is not turned on and a warning says so. See [Troubleshooting](troubleshooting.md#auto-messages).

### Turn it off

Click **Auto** again. There is no dialog, it works at any time, and it takes effect at once, also in a running turn: the next permission request of that turn asks again. A command that is already running is not stopped; use **Stop** for that. Whether a turn runs with Auto is decided when it is sent, so turning Auto on cannot change a turn that already runs, and turning it off can. If the change cannot be saved, Auto is off in this window until it reloads, and a warning says so: "Auto is off for now, but that could not be saved: after a reload it may be on again. Turn it off again later."

### What runs without asking, and what still asks

| Call | With Auto on |
| :- | :- |
| Terminal command (Bash, PowerShell) | Runs, labelled "Auto-approved", a read-only Bash command too: Auto is checked before the read-only rule. Asks while `agentCanopy.agent.alwaysAskCommands` is on, and always asks when it carries `dangerouslyDisableSandbox` (a request to run outside the sandbox) |
| Command with a saved always-allow rule (Bash or PowerShell) | Runs, labelled "Approved by you": the rule is checked first |
| Read-only Bash command, with Auto off | Runs, labelled "Allowed by AgentCanopy", when the [rules](#read-only-commands) hold. With Auto on it is "Auto-approved", as above |
| Edit inside the folder | Runs. With `editApproval` on `ask` it is labelled "Auto-approved"; with `auto` it is "Allowed by AgentCanopy", as without Auto |
| Edit on a protected path | Asks |
| Edit outside the folder | Asks, unless a folder saved for edits covers it, with or without Auto. Then it runs, labelled "Approved by you": Auto does not cover edits outside the folder by itself. Protected files, credential locations, AgentCanopy's own storage and network shares always ask |
| Read outside the folder | Asks, unless the folder's reads switch is on or a saved folder covers it. Then it runs, labelled "Approved by you": saved permissions are checked before Auto, and Auto never covers a read. Credential locations always ask, except Claude Code's memory for this folder |
| Read inside the folder | Runs, as without Auto |
| Read of Claude Code's memory for this folder | Runs, labelled "Allowed by AgentCanopy", as without Auto |
| Web fetch and web search | Run, labelled "Approved by you", when the folder's switch for it is on or, for a fetch, its site is saved: saved permissions are checked before Auto. Otherwise they run, labelled "Auto-approved", unless `agentCanopy.agent.auto.webTools` is off. Then they ask |
| Tool from another tool server (MCP) | Asks, unless you saved an always-allow rule |
| Any other tool that asks (`Skill`, `Monitor`, `ExitPlanMode`, `EnterWorktree`, `Workflow`, unknown tools) | Asks |
| `AskUserQuestion` | Shown to you, as always |
| AgentCanopy's own tools | Denied, as always |

Tools that Claude Code runs without asking (subagent launch, tool search, scheduling and messaging tools) never reach AgentCanopy's policy, with or without Auto; their cards say "Allowed by Claude Code". When Auto covers commands, the agent is told in its prompt that Auto is on and what still asks; with `agentCanopy.agent.alwaysAskCommands` on, the prompt is the ordinary Agent one.

### What shows that it is on

- The **Auto** switch next to the mode selector is pressed and has a filled icon, and a line under the selector says "Auto is on: commands and edits in this folder run without asking." (with `alwaysAskCommands` on: "Auto is on: edits in this folder run without asking. Commands still ask."). In Ask and Plan mode the switch stays visible while Auto is on, so you can turn it off first, and the line says "Auto is on for this conversation's Agent turns." The Agent mode description under the selector changes too.
- Messages sent with Auto are marked "Agent · Auto". The plan execution message "Plan approved: executing version N" has an "Auto" mark. The queued message chip says "Agent · Auto" while Auto is on. History flags the conversation with "Auto".
- The plan card says "Runs with Auto: commands and edits run without asking." (or, while Auto is off, "Approving turns on Auto for this conversation: commands and edits run without asking."), and the plan approval dialog says that Auto is on or that approving turns it on.
- Tool cards of calls that Auto approved say "Auto-approved".

### Where it applies

Auto belongs to one conversation. A new conversation, a branch, a side question and **Restore and Branch From Here** start with it off, whatever the conversation they came from had. A queued message has no setting of its own: it runs with the conversation's Auto at the moment it is sent. **Approve and Execute** on a [plan](plan-mode.md#approve-and-execute) turns Auto on for the conversation, if it is not on yet and the setting offers it, and the execution then runs with it; if Auto is already on, it runs with it as it is.

### Settings

- `agentCanopy.agent.auto.enabled` (default on) offers the Auto switch. Turning it off hides the switch and Auto applies nowhere at once; stored Auto flags and the switch of any new conversation are cleared, so turning the setting on again turns nothing back on. This covers every conversation on this machine, also in workspaces that are closed at the time: when such a workspace is opened later, its conversations no longer have Auto. This is only noticed while AgentCanopy is running in some window; see [Limitations](../limitations.md).
- `agentCanopy.agent.auto.webTools` (default on) lets Auto also approve web fetch and web search, so a plan that reads documentation runs without a card for each page. Turn it off to have them ask even with Auto on: a fetched page can carry instructions for the agent and a request can send file contents out.

A setting that narrows Auto takes effect at once, also for a running turn: turning `agentCanopy.agent.alwaysAskCommands` on, `agentCanopy.agent.auto.webTools` off or `agentCanopy.agent.auto.enabled` off makes the next call ask, and it stays in effect for the rest of that turn even if you change it back. A setting that widens what runs applies from the next turn.

## Who allowed each call

Each tool card shows one of five labels: "Approved by you" (this includes a saved always-allow rule you created, and a call that a saved folder, site or PowerShell command or a switch you turned on in the Permissions tab allowed), "Allowed by AgentCanopy" (the edit and read rules above, reads of Claude Code's memory for this folder, and [read-only commands](#read-only-commands)), "Allowed by Claude Code" (Claude Code allowed the call on its own: tools it runs without asking, such as launching a subagent, and tools that your own Claude Code settings pre-approve; never commands, edits, reads or web access, which always reach AgentCanopy's policy), "Auto-approved" (approved by Auto, see above) and "Not verified by AgentCanopy".

## Run commands in a sandbox

`agentCanopy.agent.sandbox` turns on Claude Code's sandbox for the agent's commands on macOS, Linux and WSL2. Commands can then write only inside the workspace folder and temporary directories. Commands still ask for approval, unless they are read-only or Auto is on for the conversation. AgentCanopy requests the sandbox through Claude Code's settings and cannot verify that it is active, and it does not exist on native Windows. With Auto on and the sandbox set, a command cannot leave the sandbox. Without the sandbox, a command you allow runs with your own privileges and can do anything you can. Claude Code creates a `.claude/.cc-writes` folder in the workspace while the sandbox is on; AgentCanopy ignores it.

## Stop a turn

Click **Stop**, next to **Send** in the message box while a turn runs. Pressing Escape in the message box moves focus to Stop. Stopping keeps a queued message; it does not send it. On macOS and Linux, AgentCanopy interrupts Claude Code first and escalates only if it does not stop. On Windows, stopping ends the process and its children at once.

## After the turn

- The Changes card under the chat lists the changed files. Accept or reject them; see [Reviewing changes](reviewing-changes.md).
- If the agent changed Git state, a note says: "The agent changed Git state (commits, branch or stash). Undoing file changes does not undo that."
- If the agent changed Claude Code or editor configuration, the Changes card asks you to decide on each file before the next Agent turn.
- Each turn is a step you can go back to; see [Checkpoints and branches](checkpoints-and-branches.md).
- Files you reverted since the last turn are listed in the next prompt, so the agent does not assume its earlier edits still exist.

Background tasks are disabled, so the agent cannot leave a dev server running between turns. See [limitations](../limitations.md) for everything Agent mode cannot do or undo.
