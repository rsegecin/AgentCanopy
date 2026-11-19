# Troubleshooting

The provider indicator in the header of the AgentCanopy view shows the state of Claude Code: **Ready**, **Not installed**, **Update needed**, **Signed out** or **Has problems**. Hover over it for the details. After you fix a problem, click **Check again** on the banner, use **More actions > Refresh provider**, or run **AgentCanopy: Check Claude Code Again**.

## Claude Code is not found

Message: "Claude Code was not found. Install it, or set the path in the AgentCanopy settings."

- Install Claude Code and check that `claude --version` works in a terminal.
- AgentCanopy looks for `claude` in the absolute entries of `PATH` and in `~/.local/bin`. Relative `PATH` entries (such as `.` or `node_modules/.bin`) are skipped on purpose, so that a repository cannot decide which `claude` runs. The check itself runs from your home folder. If VS Code was not started from a shell, it may not see your shell's `PATH`. Set `agentCanopy.claude.path` to the absolute path of the executable instead. A relative path is not accepted, and an explicit path is never replaced by a search.
- On Windows, AgentCanopy needs the native installer's `claude.exe`. If it finds an npm shim (`claude.cmd`, `claude.bat` or `claude.ps1`) it says: "AgentCanopy needs the native Claude Code install (claude.exe). An npm shim was found instead." Install the native version.
- "Claude Code was found but could not be run", "did not report a version" or "its version could not be read": run the same executable in a terminal and see what it prints.

## Claude Code is too old

Message: "Claude Code X is older than the minimum supported version 2.1.295. Update Claude Code." Update the CLI, then check again. Messages cannot be sent until you do.

## You are signed out

Message: "Claude Code is not signed in. Use Sign in to open a terminal and run its login." Click **Sign in** (or run **AgentCanopy: Sign In to Claude Code**). A terminal named "Claude Code sign-in" opens and runs `claude auth login`. Finish the login there, then click **Check again**. AgentCanopy never sees what you type or receive in that terminal.

The **Sign in** button on the banner and in the message box starts the Claude Code executable that AgentCanopy detected (so `agentCanopy.claude.path` is honoured) with `auth login`, directly and without a shell. The Command Palette command **AgentCanopy: Sign In to Claude Code** does the same. Only when Claude Code was not detected does it fall back to typing `claude auth login` into the terminal, which uses the `claude` on that terminal's `PATH`. That fallback terminal opens in your home folder, not in the workspace.

If a turn stops with "Claude Code is no longer signed in. Sign in and send the message again.", do the same.

## The API key notice

Message: "An ANTHROPIC_API_KEY environment variable is set, so Claude Code bills the API account instead of your subscription." This is a warning, not an error, and you can dismiss it. It appears because Claude Code uses that variable in preference to a subscription sign-in. If you want your subscription to be used, remove the variable from the environment VS Code was started from, restart VS Code and click **Check again**.

## The workspace is not trusted, or no folder is open

- "This workspace is not trusted, so AgentCanopy will not run agents here. Your conversation history stays readable." Trust the folder through VS Code's Workspace Trust. Nothing runs before that.
- "Open a folder to start a conversation." AgentCanopy works on a folder, not on loose files. In a window with several folders, a conversation belongs to one of them.

## "Another VS Code window is tracking changes in this folder."

Only one VS Code window at a time may track changes for a folder, because two windows would each undo the other's agent edits. An Agent turn started in a second window ends with this message.

Close the folder in the other window (or that window), then try again. If the other window crashed, its claim is released by itself after about 90 seconds.

## Other reasons an Agent turn does not start

- "Another agent turn is running in this folder. Stop it or wait for it to finish."
- "The last turn changed tool or editor configuration. Keep or revert those changes below the chat before starting another Agent turn." A turn in Agent mode changed Claude Code or editor configuration, such as a file under `.claude/agents`, and the changes await your decision. In Agent mode the message box already disables Send and says where to decide, and **Approve and Execute** on a plan is disabled with the same hint. Look at the strip below the chat, headed **Changes**, whose **Configuration changes** section lists each file. Open its diff from its path, then **Keep** or **Revert** each one. See [Reviewing changes](reviewing-changes.md#configuration-changes). Ask and Plan are not blocked.

## A message is queued, or a side question will not start

- "A turn is already running in this conversation." Only Agent and Plan messages can be sent while a turn runs; an Ask message becomes a side question. A side question opened as a conversation cannot start another one while it runs: wait for the answer or stop it.
- "A message is already waiting for this turn. Edit or remove it first." One message can be queued per conversation. Use **Edit** or **Remove** on the chip above the message box, or **Send now**.
- A queued message that is not sent when the turn ends. A message of any mode stays queued after a stop or an error, and the chip offers **Send**. A queued Agent message is also held back while configuration changes are undecided or an Agent turn runs in the same folder in another conversation: its **Send** is disabled and the chip says "Decide on the configuration changes, then press Send." or "Another agent turn is running in this folder. Press Send when it has ended." It is not sent by itself when the blocker clears: press **Send**. A queued Plan message is not held back by those two. A queued message is kept in memory only, so closing or reloading the window loses it.
- "The side question could not be started." A warning in the chat view. The side question did not get going and leaves nothing behind. Send it again.
- "A side question is already running. Wait for it or stop it." One side question runs at a time per conversation. Stop it with **Stop** on its card, or wait. See [Ask mode](ask-mode.md#ask-while-the-agent-works).
- A side question that did not see something you did in the running turn. It knows the conversation up to the last finished turn only.

## An interrupted turn and "Recover now"

If VS Code closes or crashes during an Agent turn, AgentCanopy notices at the next start. The turn is marked interrupted and has no Changed files card, so the files that changed are listed in the strip below the chat, as "Changed around an interrupted turn", because AgentCanopy cannot tell which of them the agent made. A note says: "AgentCanopy was closed while this turn was running, so it cannot tell which of these changes the agent made."

Claude Code may still be running. AgentCanopy tries to stop the old process. When it cannot be sure the process has ended, a banner says "Claude Code from an interrupted turn may still be running (process N). Stop it, then choose Recover now." (or "is still running ... Stop it, then reload the window."). Stop the process yourself, then click **Recover now** on the banner and confirm "Recover the interrupted turn now?" Do this only after Claude Code has stopped; otherwise its later changes are not tracked. On Windows a process cannot be matched by its start time, so AgentCanopy cannot be sure it is the old one and shows this banner whenever a process with the recorded id is still alive.

## A read-only turn was stopped

Messages that start "Claude Code offered tools that are not allowed in a read-only mode", "Claude Code loaded tool servers that are not allowed", or "AgentCanopy could not check this turn and stopped it" mean the check described in [Ask mode](ask-mode.md) failed and the turn was ended on purpose. Check which plugins, tool servers and Claude Code settings are active, update Claude Code, and look at the log.

## A turn ends with an error

| Message | Meaning |
| :- | :- |
| Claude Code's usage limit was reached. Try again later. | Your plan's limit |
| Claude Code is overloaded right now. Try again in a moment. | Provider side |
| Claude Code does not know the model "X". | Pick another model or fix `agentCanopy.defaultModel` or `agentCanopy.customModels` |
| Claude Code reports a billing problem with your account. | Check your plan or credits |
| Claude Code could not be started. | Check that it is installed and signed in |
| Claude Code no longer has this session. | The conversation continues with its visible messages as context |
| model name contains characters that are not allowed | The conversation stored an "orchestrate and delegate" choice (a model name ending in `+delegate`) and this build is older than 0.1.7, which does not know that form. Pick another model, or use a newer build |

## The model selector shows an old version

The label of an alias comes from a table built into the extension until a turn that used that alias has completed on this machine. After that AgentCanopy shows the version that Claude Code reported. Run a turn with that model: a turn that fails or is stopped does not count. Hover over the selector to see the full id of the selected entry, when it is known. See [Model versions](agent-mode.md#model-versions).

## The project settings dialog

"This project configures Claude Code to run programs" appears before a turn when the folder (or its Git root) has `.claude/settings.json`, `.claude/settings.local.json` or `.mcp.json` with hooks, environment variables, helper commands, pre-approved permissions, extra folders, tool servers, or a file that cannot be read safely or is not valid JSON. The dialog lists what it found. Choose **Ignore Project Settings** unless you trust the repository.

- Dismissing the dialog ignores the settings for that turn only, and you are asked again on the next one. Choosing remembers your answer until those files change.
- If the agent seems to know nothing about your project's instructions or tool servers, you probably ignored the project settings. Ignoring skips the settings files, the project's `CLAUDE.md` and its tool servers, and the turn shows a notice. Run **AgentCanopy: Ask Again About This Folder's Claude Code Project Settings**, then send a message and choose **Use Project Settings**.
- "The project's own Claude Code settings are ignored" is that notice. It appears once per folder and set of files.

## A command asks even though it is harmless

In Agent mode a terminal command asks unless it is read-only, you chose **Always allow** for that exact command, or [Auto](agent-mode.md#auto) is on for the conversation. Only a fixed list of commands and options counts as read-only, and anything AgentCanopy does not fully understand asks. This is deliberate. A harmless command asks for one of these reasons:

- It is not on the list, or uses an option that is not: `npm test`, `git fetch`, `sed -i`, `tail -f`, an abbreviated long option such as `--co`. A command is not read-only because it looks harmless; see [Read-only commands](agent-mode.md#read-only-commands) for the list.
- It contains a variable, a substitution (`$(...)` or backticks), a `~` path, a glob (other than the patterns of grep `--include` and rg `--glob`), a redirection other than `2>&1`, `>&2` and `/dev/null`, a single `&`, or a line break.
- It names a file outside the workspace folder, or a link inside the folder leads outside it. On Windows, MSYS paths such as `/c/...` ask.
- It is a git command and the folder has no `.git` directory of its own at its root. A parent folder's repository, a linked worktree and a submodule (where `.git` is a file) all ask.
- It is a PowerShell command. PowerShell commands ask unless saved or Auto is on.
- It comes from a subagent, or Claude Code did not report the workspace folder as the working directory. AgentCanopy reads that from the hook it installs in Agent mode, so with `disableAllHooks` in your Claude Code user settings every command asks. A turn with an [orchestrate and delegate](agent-mode.md#orchestrate-and-delegate) model therefore asks more often without Auto, because the read-only commands of a subagent ask; with Auto on they do not.
- `agentCanopy.agent.alwaysAskCommands` is on. It turns read-only commands off.
- You chose **Use Project Settings** and the project's settings hold environment variables, hooks or helper commands.
- The workspace folder is your home folder or above it, or inside a credential location, or a `PATH` entry is relative or lies inside the folder.

The AgentCanopy log records the reason a command was not judged read-only, at debug level and without the command text.

Reads inside the workspace do not ask, and reads outside it do, unless you allowed them for the folder (see [Permissions](agent-mode.md#permissions)). Choose **Always allow** for commands you run often; it is offered for plain literal commands that do not start with an environment variable, and for PowerShell for plain commands made of letters, digits, spaces and `_ . / \ : -`. For everything at once, see Auto.

## Why did a command still ask with Auto on?

Auto is on when the Auto switch is pressed and the setting `agentCanopy.agent.auto.enabled` is on. A command can still ask for these reasons:

- `agentCanopy.agent.alwaysAskCommands` is on. It wins over Auto, and the composer hint says "Auto is on: edits in this folder run without asking. Commands still ask."
- The command asks to run outside the sandbox (`dangerouslyDisableSandbox`). Auto never approves that. With Auto and `agentCanopy.agent.sandbox` on, a turn cannot leave the sandbox at all.
- Auto was turned off, by you or because the setting `agentCanopy.agent.auto.enabled` was turned off. Turning it off takes effect at once, also in a running turn: the next request asks. Turning the setting off also clears Auto in every conversation on this machine, also in workspaces that are closed at the time, so turning the setting on again does not turn Auto back on. This is only noticed while AgentCanopy is running in some window; see [Limitations](../limitations.md).
- A setting that narrows Auto was changed during the turn. Turning `agentCanopy.agent.alwaysAskCommands` on, `agentCanopy.agent.auto.webTools` off or `agentCanopy.agent.auto.enabled` off takes effect at once, also in a running turn, and stays in effect for the rest of that turn even if you change it back: the next call asks. A setting that widens what runs, such as turning `alwaysAskCommands` off or `webTools` on, applies from the next turn.
- The turn started before Auto was on. Whether a turn runs with Auto is decided when it is sent, and turning Auto on cannot change a turn that is already running.
- The turn is the execution of a plan, and Auto was not turned on by the approval because something changed while its dialog was open, or Auto could not be saved. A warning said so; see [Auto messages](#auto-messages).
- The call is a side question. A side question is a branch and starts without Auto, and it is read-only anyway.
- It is not a command. Protected files, edits outside the folder (unless a folder you saved for edits covers them, and then not protected files or credential locations), other tools and MCP tools ask with Auto on. So do reads outside the folder, unless the folder's reads switch is on or a saved folder covers them, and so do web fetch and web search while `agentCanopy.agent.auto.webTools` is off (it is on by default), unless a switch or saved site of the folder covers them.

## Auto messages

These appear as warnings in the chat view.

| Message | What to do |
| :- | :- |
| Auto is turned off in the settings (agentCanopy.agent.auto.enabled). | Turn the setting on, then use the Auto switch |
| Wait for the current turn to finish before turning on Auto. | Auto can only be turned on between turns. Wait for the turn to end or stop it |
| The dialog to turn on Auto is already open. | Answer the dialog that is open first |
| Open the conversation to turn Auto on. | Auto can only be turned on for the conversation the view shows. Open the conversation, then use the Auto switch |
| Auto can be turned on for a new conversation only before its first message. | The conversation was created or is being created, so the switch no longer belongs to a draft. Turn Auto on in the conversation that is open |
| Auto was not turned on: the conversation changed while the dialog was open. | A turn started, the conversation or its folder changed, `agentCanopy.agent.auto.enabled` was turned off, or one of the settings the dialog names (`alwaysAskCommands`, `agentCanopy.agent.auto.webTools`, `agentCanopy.agent.sandbox`) changed while you read it. Nothing was turned on. Turn Auto on again and read the new dialog. If the dialog was the plan approval, the approval stays recorded and the execution turn runs without Auto, so its commands ask; turn Auto on with the switch and send a message if you want it |
| Auto could not be turned on. The AgentCanopy log has the details. | The conversation could not be written to storage. Auto is off. Check the log and try again. After a plan approval, the approval stays recorded and the execution turn runs without Auto |
| Auto is off for now, but that could not be saved: after a reload it may be on again. Turn it off again later. | You turned Auto off and storage failed. It is off in this window until it reloads, and the next save of the conversation retries it. Check the Auto switch after a reload and the log for the reason |
| Auto is off in this window, but that could not be saved for other workspaces on this machine. AgentCanopy will try again. | You turned `agentCanopy.agent.auto.enabled` off and the machine-wide reset could not be written. Do nothing in this window. If the warning persists, check that VS Code's global storage folder is writable, and turn Auto off by hand in the conversations of other workspaces |

The workspace and folder warnings of any other action also apply to Auto: an untrusted workspace, a closed folder or a conversation that is gone refuses it with the usual message.

## An always-allow rule was not saved

If you chose **Always allow** for a command and the rule could not be written, you see: "The command was allowed this once, but the rule to always allow it could not be saved." The command ran, and the next one asks again. Check the log for the reason. A folder can hold at most 200 saved rules.

For a folder or a web site the message is "It was allowed this once, but the permission to always allow it could not be saved."; a PowerShell command gets the message above, like a Bash command. The call ran and the next one asks again. Check the log for the reason. A workspace folder can hold at most 200 saved folders, sites and PowerShell commands together; remove some in the Permissions tab.

## Permissions messages

These appear as warnings in the chat view. They come from the Permissions tab and from **Always allow** on a card. See [Agent mode](agent-mode.md#permissions) for how the tab works.

| Message | What to do |
| :- | :- |
| A permissions dialog is already open. | Answer the dialog that is open first. Turning a switch on, **Allow reads in a folder...** and **Allow edits in a folder...** each open one, and only one can be open at a time |
| The folder or the trust of the workspace changed while the dialog was open, so nothing was changed. | The view moved to a conversation of another folder, or the workspace stopped being trusted, while you read the dialog. Nothing was turned on or saved. Do it again from the folder you mean |
| The permission could not be removed. | The entry is still saved and still allows its calls. Try **Remove** again, and check the log for the reason |
| The switch could not be changed. | The switch kept its old state, also when you meant to turn it off. Check what it shows, try again, and check the log for the reason |
| That folder could not be read. | The folder you picked does not exist, is not a folder or could not be opened. Pick another |
| That folder is inside the workspace folder, where reads never ask. | There is nothing to allow: reads inside the workspace folder never ask |
| That folder is a credential location, AgentCanopy's own storage or on a network share. Reads there always ask. | These are never saved. Read the file once with **Allow once** when the agent asks. Claude Code's memory for this folder is the exception: it needs no permission |
| That folder is too broad to allow: a drive or filesystem root, your home folder, or a folder that holds it or a credential location. | Pick the folder that holds the files you mean, not one above it |
| That folder is already inside a saved folder. | It already counts. The saved folder is listed under Saved permissions |
| That folder is inside the workspace folder, where edits are reviewed and need no saved folder. | Only **Allow edits in a folder...** gives this message. There is nothing to allow: edits inside the workspace folder do not ask |
| That folder is a credential location, AgentCanopy's own storage or on a network share. Edits there always ask. | Only **Allow edits in a folder...** gives this message. These are never saved for edits. Allow the edit once with **Allow once** when the agent asks |
| That folder is in a protected location (such as .git, .vscode or .claude). Edits there always ask. | Protected locations are never saved for edits. Allow the edit once when the agent asks |
| That folder is already inside a folder saved for edits. | Only **Allow edits in a folder...** gives this message. It already counts. The saved folder is listed under Saved permissions |

The messages about a folder that cannot be read or is too broad are the same for both buttons.

Turning a switch on, choosing **Allow reads in a folder...** or choosing **Allow edits in a folder...** also does nothing in an untrusted workspace or in a window with no folder: the tab disables its controls and says why.

## A read or a web call asks although I allowed it

- The target is a credential location, AgentCanopy's own storage, on Windows a network path, a search that starts at your home folder or above it, or on Windows the temp folder. These always ask, whatever is on or saved. See [limitations](../limitations.md#saved-permissions-and-switches). The one exception is Claude Code's memory for this folder (`projects/<slug>/memory` under `~/.claude`, or under `CLAUDE_CONFIG_DIR` when that is an absolute path), which is read without asking. A memory read still asks when the memory folder or a file in it is a link that leads elsewhere, when the call is an edit, when it is another project's memory, or when the folder path gives a slug of more than 200 characters.
- The path is written in a form AgentCanopy cannot judge (whitespace at either end, or on Windows a path rooted without a drive, a drive letter without a separator, or a segment that ends in a dot or a space), or a pattern has `..` after a wildcard or an alternative in braces that starts at a root.
- The permission belongs to another workspace folder. Another project, or another folder of the same window, has its own.
- A saved site matches the exact host: `a.docs.example.com`, `example.com` and `docs.example.com:8443` are not `docs.example.com`. An address with a user name or password is never matched by a saved site.
- In Ask and Plan, web tools stay off while `agentCanopy.ask.webTools` is off, whatever is saved. The call is refused and does not ask.
- You removed the permission or turned the switch off. That applies to the next request, also in a running turn.

## Delete stored file contents and change history

AgentCanopy keeps captured file contents, the list of agent changes and the checkpoint history for each folder. To remove them for one folder, run **AgentCanopy: Delete Stored File Contents and Change History for This Folder**. In a window with several folders it asks which one unless the active file settles it.

A native dialog asks you to confirm. It deletes the captured file contents, the list of pending agent changes (and accepted ones) and the checkpoint history, and the journal of an interrupted turn. It leaves your files, your conversations and plans, your always-allow rules and your saved permissions alone. It cannot be undone. Afterwards AgentCanopy starts capturing the folder again.

The command refuses while an Agent turn is running in the folder ("An agent turn is running in this folder. Wait for it to finish.") and while a configuration change waits for your decision ("A configuration change is waiting for your decision. Keep or revert it first."). Do what the message says and run it again.

## Where the logs are

Run **AgentCanopy: Show Logs**, or **More actions > Show logs** in the view. It opens the "AgentCanopy" channel in VS Code's Output panel. Tokens, e-mail addresses and your home folder are redacted from log lines. Include the relevant log lines, with anything private removed, when you report a bug.
