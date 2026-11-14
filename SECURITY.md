# Security

This page describes what AgentCanopy can and cannot do on your machine, what it trusts, what it stores and how to report a vulnerability. For known gaps in its guarantees, see [docs/limitations.md](docs/limitations.md).

## What the extension does on your machine

AgentCanopy runs inside the VS Code extension host with your user's privileges. It:

- starts the Claude Code executable you installed, found only through absolute paths (`agentCanopy.claude.path`, the absolute entries of `PATH` and `~/.local/bin`) and probed from your home folder, so nothing in a workspace can stand in for it. It starts it without a shell, in its own process group, with VS Code's own environment variables removed. The prompt goes to the process on standard input. Configuration for each turn goes in files created for that turn in a private directory (owner-only permissions) and deleted when the turn ends;
- listens on the loopback interface while turns run (see below);
- reads and writes files in the workspace folder when you reject, restore or revert, and in its own storage. Restores write through a temporary file and a rename, refuse to write through symbolic links, never remove directories and repeat their checks just before writing;
- opens a terminal that runs `claude auth login` when you use Sign In, using the Claude Code executable it detected (when none was detected, a terminal opened in your home folder runs `claude auth login`);
- opens an `http`, `https` or `mailto` link only after a native dialog that shows the full address.

It does not:

- make network requests of its own, collect telemetry or phone home;
- ask for, read, store, forward or log a password, token or API key. Signing in happens inside Claude Code. The only things it reads from `claude auth status` are whether you are logged in and which method is used. Fields such as account names or credential expiry are not copied;
- run anything in an untrusted workspace or in a window with no folder open;
- run commands that the model proposes. Claude Code runs them, and in Agent mode AgentCanopy's policy asks you before each one, unless you saved an always-allow rule for that exact command or you turned on [Auto](#auto) for the conversation, which removes that prompt on purpose;
- run Claude Code with `bypassPermissions`.

The agent, which is Claude Code, can do what your permissions allow: Agent mode can edit files and run commands, and a command you allow can reach anything you can. AgentCanopy limits and records that; it does not sandbox it unless you turn on `agentCanopy.agent.sandbox`.

Claude Code itself sends your prompts and the files it reads to Anthropic's service. That is Claude Code's behavior and is governed by Anthropic's terms, not by this project.

### The threat from a repository's own Claude Code configuration

The review's most serious finding was this one. A repository can contain `.claude/settings.json`, `.claude/settings.local.json` and `.mcp.json`. Claude Code reads them on its own and, without any prompt, runs the hooks and helper commands they name, applies the environment variables they set (for example `PATH` or `LD_PRELOAD`), accepts the permissions they pre-approve and starts the tool servers they declare. Nothing the user typed is involved, so a message sent to Ask mode in a cloned, untrusted repository could run an attacker's program with the user's privileges, before any read-only guard or permission prompt exists. A read-only mode cannot stop a program that runs before it. AgentCanopy therefore inspects those files before every turn in every mode, and when they contain anything that can run programs or change the environment, or cannot be read safely, a native dialog asks whether to ignore them. Ignoring starts Claude Code with only the user's own settings and without the project's tool servers. The answer is stored per folder and pinned to the content of the files, so a later change asks again, and dismissing the dialog ignores them for that turn only.

## Trust model

Workspace content, model output and tool output are all untrusted. A repository you open, a file the agent reads or a web page it fetches may try to steer the model, and the model's output may try to deceive you or the interface. AgentCanopy's defenses do not rely on the model behaving.

- **The chat view** is a webview with a closed Content Security Policy: `default-src 'none'`; scripts only by nonce or from the extension's own files; no network connections of any kind; images only from the extension and `data:` URIs. Command URIs and forms are not enabled.
- **Rendered text** goes through a Markdown parser with raw HTML turned off, then through an HTML sanitizer. Images in Markdown are never loaded. A link opens only after a confirmation that shows its full address, and only for web and email links. Mermaid diagrams run at Mermaid's strict security level and their links are inert. In code blocks, invisible direction-changing and zero-width characters are shown as visible markers with a warning, and Copy copies the original text.
- **Every message between the webview and the extension host is validated** against a schema in both directions. A malformed message is dropped.
- **High-impact approvals use native VS Code dialogs**, which web content in the view cannot click: executing a plan, turning on Auto, creating an always-allow rule, overwriting a file that changed, rejecting all changes, restoring a checkpoint, keeping or reverting a configuration file, recovering an interrupted turn, deleting a conversation, deleting stored file contents and the choice about a project's Claude Code settings. Text that comes from the model or the workspace (titles, paths, commands) is shown in those dialogs on one line with control characters written out. Every answer to a permission card carries the prompt's id and a hash of the text that was displayed, and a mismatch is ignored. Commands are shown in full on the permission card: every line, each line break marked, long runs of blank lines counted, the line count in the title, and a warning for a command of more than one line.
- **Read-only modes fail closed.** If Claude Code reports anything the profile does not allow, the turn is stopped. See [Ask mode](docs/guide/ask-mode.md).
- **Every command and every read reaches AgentCanopy's policy.** AgentCanopy's own settings file makes Claude Code ask the policy about every shell command, file read or search, edit and web access that the mode's tools allow, so that Claude Code's built-in classification cannot approve something first. In Agent mode a command asks unless you saved an always-allow rule for it or [Auto](#auto) is on for the conversation; reads inside the workspace pass and reads outside ask, in every mode. An always-allow rule is never created for a command that starts with an environment variable.
- **Every setting except `agentCanopy.unsavedFiles` has machine scope**, including the default mode and model, so a repository cannot change them through `.vscode/settings.json`.
- **Edits to files that configure tools, editors or Git** (settings, hooks, skills, `.mcp.json` and others) are detected after every Agent turn and must be kept or reverted before the next one, because such files can make later commands run without asking.

### What a compromised webview could still do

The Content Security Policy and the sanitizer exist to keep script out of the chat view. If script did run there anyway, the native dialogs above would still stop what can hurt you most. Without a native dialog it could still: start a turn, in any mode the policy offers, with text of its own; hand AgentCanopy pasted image data, which is checked for type, size and file signature, kept in memory only while a draft refers to it, and sent to the model with the next message; answer a permission prompt with "allow once" (the card shows what it allows, but the click would be the webview's) and answer the agent's questions; make plan decisions, lock or unlock a plan and revert a plan to an earlier version; accept changes (this only records a decision and writes no file); reject a single file or change that is still as the agent left it (the checkpoint history can undo that); copy text to the clipboard; open files inside the workspace folders and links after the editor's own confirmation; and rename, change the mode and model of, fork and open conversations. It could also turn Auto off, ask for the dialog that turns it on again (which only you can confirm), and, in a conversation where you turned Auto on, send turns and queue messages that run with it. It cannot turn Auto on: only the native dialog does, and the extension host checks again after the dialog that nothing it depended on has changed. The webview chooses when that dialog appears and wrote the conversation title the dialog shows, which is why the dialog shows the folder's path first, because a folder's display name can be set by the workspace and two folders can share it, and cuts the conversation title.

## Auto

Auto is a per-conversation switch of Agent mode. With it, AgentCanopy's policy approves terminal commands, and edits inside the folder, without a prompt for each one; web fetch and web search too if you turn on `agentCanopy.agent.auto.webTools`. It is off by default, off for every new conversation, branch and side question, and on only after you confirm a native dialog, which can be shown before the first message of a new conversation. Turning it off needs no dialog and takes effect at once, also for a running turn. The settings `agentCanopy.agent.auto.enabled`, `agentCanopy.agent.auto.webTools` and `agentCanopy.agent.alwaysAskCommands` are described in the [Agent mode guide](docs/guide/agent-mode.md#auto), which also lists what Auto never approves: protected files, anything outside the folder, MCP tools and other tools, a command that asks to leave the sandbox, and, while `alwaysAskCommands` is on, commands. A saved always-allow rule still approves as you, before Auto.

Auto removes a safeguard on purpose. What remains of the risk:

- **Commands run unreviewed with your privileges.** Text injected into files, tool output or web pages the agent reads can steer it into running commands you would have refused.
- **The path protections apply to the file tools, not to commands.** The protected files and the folder boundary are checked when the agent edits or reads a file with its own tools. A command can write those files, and any other path, without asking. After the turn, the configuration check reports changes to the project configuration it watches and blocks the next Agent turn until you keep or revert them: `.claude/settings.json`, `.claude/settings.local.json`, `.mcp.json`, `.vscode/settings.json`, `.vscode/tasks.json`, `.vscode/launch.json`, `.vscode/mcp.json`, the files under `.claude/skills`, `.claude/hooks`, `.claude/commands`, `.claude/agents` and `.husky`, all of them also at the Git root, and the Git `config` and the Git hooks of the repository. It does not cover `.env` files, `.npmrc`, `.github/workflows`, nested `.vscode` or `.claude` folders, user-level configuration (`~/.claude`, `~/.gitconfig`, shell profiles, VS Code user settings) or AgentCanopy's own storage. It also cannot undo what a changed configuration file did if it was written and used within one turn.
- **Review and checkpoints undo file changes inside the folder only.** They do not undo what a command does outside it, to Git, to databases or over the network.
- **Keeping web tools behind a prompt does not stop data leaving.** Commands have network access, so a command can send file contents out without a web tool.
- **The sandbox is requested through settings and not verified.** It does not exist on native Windows. With Auto on and `agentCanopy.agent.sandbox` set, the turn is started so that a command cannot leave the sandbox, and a command that asks to leave it is not approved by Auto. Without the sandbox, commands are not sandboxed, and the dialog says so.
- **Some tools never reach the policy.** Tools that Claude Code runs without asking (subagent launch, tool search, scheduling and messaging tools) are not decided by AgentCanopy, with or without Auto.
- **If turning Auto off cannot be saved,** it is off in the extension host until the window reloads, and a warning says so. After a reload the stored value may be read as on again, so turn it off again.
- **An older version of the extension** drops stored messages whose approval source is `auto`, because it does not know that value.

## The loopback server

During a turn, Claude Code calls AgentCanopy for permission decisions, for saving a plan and for before and after notifications of each tool call. The server that receives them:

- binds to `127.0.0.1` only, on a random port chosen by the operating system;
- needs a random per-turn bearer token (tool calls) or a random per-turn secret in the path (hook calls), compared in constant time, and forgets it when the turn ends;
- accepts only requests whose `Host` header is exactly `127.0.0.1:<port>` and that carry no `Origin` header, so a web page in a browser cannot call it;
- accepts only `POST` with JSON, limits bodies to 16 MiB and sends no CORS headers;
- treats an authenticated request as untrusted input anyway, because the agent can read the token. It validates the body, and a request that names one of AgentCanopy's own tools is denied.

Another process running as the same user could read the per-turn token file while a turn runs. This is the same exposure as any other file you own.

## What is stored, and where

AgentCanopy stores data in VS Code's per-workspace extension storage, in a folder for this extension, and a few lock files in VS Code's global extension storage. Nothing is sent anywhere.

- **Conversations**: your messages, the agent's replies and tool calls with their inputs and truncated output, which may include excerpts of files the agent read.
- **Plans**: every version, your decisions and approvals.
- **Always-allow rules** you created, per workspace folder.
- **The change log**: which files changed in which turn, an index of file metadata, and the **captured content of files**, compressed and addressed by hash, so that changes can be reviewed and undone. This can include secrets that are in your source files, for example files the agent edited. Files matching sensitive patterns (`.env` files, key and certificate files, `.npmrc`, `.netrc`, credentials files, anything under `.ssh` or `.aws`) are only hashed, except that their content before an edit by one of the agent's file tools is stored.
- **The log** in the "AgentCanopy" output channel. Tokens, e-mail addresses and your home folder, in many spellings, are redacted from every line. This is best-effort and not a promise that no sensitive text can appear.

On systems that support it, directories are created with mode 0700 and files with mode 0600. Disk encryption and operating system accounts remain your protection against other people with access to the machine.

### Removing it

- Delete a conversation from the History tab to remove its messages and its plan.
- The change log and captured file contents are not tied to one conversation. Retention is controlled by `agentCanopy.checkpoints.keepOperations` and `agentCanopy.checkpoints.keepDays`, but it never removes what a review entry still shown needs or anything after the last Agent turn.
- To remove the captured file contents, the list of agent changes and the checkpoint history of a folder now, run **AgentCanopy: Delete Stored File Contents and Change History for This Folder** and confirm. Your files, conversations, plans and always-allow rules are kept. It refuses while an Agent turn is running in the folder or a configuration change awaits your decision.
- To remove everything AgentCanopy stored for a workspace, close VS Code and delete this extension's folder inside that workspace's storage directory.
- Deleting a conversation does not delete Claude Code's own transcript of the session. That is stored by Claude Code on its own terms.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Open a private security advisory on this project's repository instead, using the repository's Security tab. Describe what you found, how to reproduce it, which version you used, your operating system and what an attacker could do with it. If a private advisory is not possible, open a public issue that says only that you have a security report and asks for a private channel, without any details.
