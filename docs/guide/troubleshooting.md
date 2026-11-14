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
- "The last turn changed tool or editor configuration. Keep or revert those changes in the changes card below the chat before starting another Agent turn." A turn in Agent mode changed Claude Code or editor configuration, such as a file under `.claude/agents`, and the changes await your decision. In Agent mode the message box already disables Send and says where to decide, and **Approve and Execute** on a plan is disabled with the same hint. Look under the chat for the **Changes** card, whose **Configuration changes** section lists each file. Open its diff from its path, then **Keep** or **Revert** each one. See [Reviewing changes](reviewing-changes.md#configuration-changes). Ask and Plan are not blocked.

## A message is queued, or a side question will not start

- "A turn is already running in this conversation." Only Agent and Plan messages can be sent while a turn runs; an Ask message becomes a side question. A side question opened as a conversation cannot start another one while it runs: wait for the answer or stop it.
- "A message is already waiting for this turn. Edit or remove it first." One message can be queued per conversation. Use **Edit** or **Remove** on the chip above the message box, or **Send now**.
- A queued message that is not sent when the turn ends. A message of any mode stays queued after a stop or an error, and the chip offers **Send**. A queued Agent message also waits while configuration changes are undecided and while an Agent turn runs in the same folder: its **Send** is disabled and the chip says what it waits for. A queued Plan message is not held back by those two. A queued message is kept in memory only, so closing or reloading the window loses it.
- "The side question could not be started." A warning in the chat view. The side question did not get going and leaves nothing behind. Send it again.
- "A side question is already running. Wait for it or stop it." One side question runs at a time per conversation. Stop it with **Stop** on its card, or wait. See [Ask mode](ask-mode.md#ask-while-the-agent-works).
- A side question that did not see something you did in the running turn. It knows the conversation up to the last finished turn only.

## An interrupted turn and "Recover now"

If VS Code closes or crashes during an Agent turn, AgentCanopy notices at the next start. The turn is marked interrupted, and the files that changed are listed in the Changes card as "Changed around an interrupted turn", because AgentCanopy cannot tell which of them the agent made. A note says: "AgentCanopy was closed while this turn was running, so it cannot tell which of these changes the agent made."

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

## The project settings dialog

"This project configures Claude Code to run programs" appears before a turn when the folder (or its Git root) has `.claude/settings.json`, `.claude/settings.local.json` or `.mcp.json` with hooks, environment variables, helper commands, pre-approved permissions, extra folders, tool servers, or a file that cannot be read safely or is not valid JSON. The dialog lists what it found. Choose **Ignore Project Settings** unless you trust the repository.

- Dismissing the dialog ignores the settings for that turn only, and you are asked again on the next one. Choosing remembers your answer until those files change.
- If the agent seems to know nothing about your project's instructions or tool servers, you probably ignored the project settings. Ignoring skips the settings files, the project's `CLAUDE.md` and its tool servers, and the turn shows a notice. Run **AgentCanopy: Ask Again About This Folder's Claude Code Project Settings**, then send a message and choose **Use Project Settings**.
- "The project's own Claude Code settings are ignored" is that notice. It appears once per folder and set of files.

## A command asks even though it is harmless

In Agent mode every terminal command asks, including `ls`, unless you chose **Always allow** for that exact command. This is deliberate. Reads inside the workspace do not ask, and reads outside it do. Choose **Always allow** for commands you run often; it is offered for plain literal commands that do not start with an environment variable.

## An always-allow rule was not saved

If you chose **Always allow** for a command and the rule could not be written, you see: "The command was allowed this once, but the rule to always allow it could not be saved." The command ran, and the next one asks again. Check the log for the reason. A folder can hold at most 200 saved rules.

## Delete stored file contents and change history

AgentCanopy keeps captured file contents, the list of agent changes and the checkpoint history for each folder. To remove them for one folder, run **AgentCanopy: Delete Stored File Contents and Change History for This Folder**. In a window with several folders it asks which one unless the active file settles it.

A native dialog asks you to confirm. It deletes the captured file contents, the list of pending agent changes (and accepted ones) and the checkpoint history, and the journal of an interrupted turn. It leaves your files, your conversations and plans and your always-allow rules alone. It cannot be undone. Afterwards AgentCanopy starts capturing the folder again.

The command refuses while an Agent turn is running in the folder ("An agent turn is running in this folder. Wait for it to finish.") and while a configuration change waits for your decision ("A configuration change is waiting for your decision. Keep or revert it first."). Do what the message says and run it again.

## Where the logs are

Run **AgentCanopy: Show Logs**, or **More actions > Show logs** in the view. It opens the "AgentCanopy" channel in VS Code's Output panel. Tokens, e-mail addresses and your home folder are redacted from log lines. Include the relevant log lines, with anything private removed, when you report a bug.
