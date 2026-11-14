# Ask mode

Ask is for questions about your code. The agent can read and search files in your workspace folder and ask you questions back. It cannot edit, create or delete files, and it cannot run commands.

## Start a conversation in Ask mode

1. Open the AgentCanopy view and choose **Ask** under the message box. It is the default mode (`agentCanopy.defaultMode`).
2. Attach what the question is about, if you like: type `@` and pick a file or folder, or use the buttons for a file, a folder, the editor selection or the current problems. Attachments are sent as paths or small excerpts, and at most 50 can go with one message.
3. Send the message. The agent reads what it needs and answers.

If the agent needs a decision from you, it shows a question card with options and an **Other** field. Answer it and press **Submit**; the turn continues with your answer.

## Ask while the agent works

The mode you choose applies to the next message and does not affect the running turn, so you can switch to **Ask** while the agent works and send a message in the same conversation. The question is answered alongside, in a **Side question** card in the chat, at the point where the running turn had got to. The message box says: "Asked as a side question: the agent keeps working and does not see it."

- It knows the conversation up to the last finished turn, not the work in progress. The agent never sees the question or its answer. A side question asked while the agent edits files will usually end with the folder warning described under [How the read-only promise is checked](#how-the-read-only-promise-is-checked); the changes it lists are the agent's work.
- It runs in its own conversation, a branch that keeps the finished turns, with the context rebuilt from the visible messages (see [Checkpoints and branches](checkpoints-and-branches.md#pending-exact-or-rebuilt)). The branch gets its own copy of the conversation's plan, like any other branch, attached read-only as in any Ask turn; decisions made there are not written to the original conversation's plan, and **Open as conversation** continues with that copy. It is read-only like any Ask turn, and a prompt it raises, such as a read outside the workspace, appears inside the side question card.
- One side question runs at a time per conversation: while the agent's turn is still running, Send in Ask mode is disabled until the side question has finished or you stop it with **Stop** on its card. Once the agent's turn has ended, an Ask message is an ordinary turn. A side question has no side questions of its own: in one that you opened as a conversation, Send waits while its turn runs.
- The card has **Open as conversation**, which opens the branch to continue with follow-up questions. History lists it under its conversation as a side question. Later turns in the branch do not change the card, which keeps showing the first answer.

To queue an instruction for the agent instead, choose **Agent** or **Plan** before you send: see [Agent mode](agent-mode.md#send-while-the-agent-works).

An Ask message sent when nothing is running is an ordinary Ask turn.

## What the agent can do

Claude Code is started with exactly four tools: Read, Grep, Glob and AskUserQuestion. Nothing else is offered to the model: no edit tools, no shell, no other tool servers, no slash commands.

- Reads and searches inside the workspace folder go through without a prompt. Paths are checked after links are resolved, so a symlink that points outside the folder does not count as inside.
- Reading or searching outside the workspace folder shows a prompt, **Read a file outside the workspace** or **Search outside the workspace**, with the full path. You can allow it once or deny it.
- Web search and fetch are off. Turn on `agentCanopy.ask.webTools` to allow them in Ask and Plan. Each use then asks first, because the query or the page address leaves your machine.
- Any other tool request is refused with "This action is not allowed in Ask mode because the mode is read-only." Nothing you click can approve it.

Files inside the folder include files such as `.env`. Ask does not hide them from the agent, and whatever the agent reads is sent to the model by Claude Code. Do not point Ask at a folder whose contents you would not send to the model.

## Project Claude Code settings

Ask is read-only, but a repository's own Claude Code configuration can still run programs when Claude Code starts. Before every turn, in Ask as in the other modes, AgentCanopy checks `.claude/settings.json`, `.claude/settings.local.json` and `.mcp.json` (in the folder and at its Git root). If they hold hooks, environment variables, helper commands, pre-approved permissions, extra folders or tool servers, or cannot be read safely, a native dialog lists them and asks you to **Ignore Project Settings** or **Use Project Settings**. The answer is remembered until the files change. Ignoring also skips the project's `CLAUDE.md`. See [Agent mode](agent-mode.md#project-claude-code-settings) for the details and the command that clears the answer.

## How the read-only promise is checked

At the start of every turn, Claude Code reports its configuration, and AgentCanopy compares it with what Ask allows: the tool list, the tool servers, the permission mode and the working folder. During the turn it watches every tool call and every hook event. If anything is off, AgentCanopy stops the process and tells you why. Examples of what you may see:

- "Claude Code offered tools that are not allowed in a read-only mode (...), so the turn was stopped."
- "Claude Code loaded tool servers that are not allowed in a read-only mode, so the turn was stopped."
- "Claude Code started answering before reporting its configuration, so read-only mode could not be verified."
- "Claude Code tried to use a tool that is not allowed in a read-only mode (...), so the turn was stopped."

After the turn ends, AgentCanopy compares file metadata (size and timestamps) in the folder with how it was before. If a file changed, a warning lists up to five paths and says that the agent of this turn had no tool that can write, so an Agent turn in this folder, another program or an edit of yours changed them. This check only reports. It never reverts anything.

## What the promise does not cover

Some things run outside the tools AgentCanopy controls. They show as a notice on the turn:

- Plugins. "A Claude Code plugin is loaded (...). Plugins run outside AgentCanopy's read-only guarantee." Turn on `agentCanopy.readOnly.strict` to refuse Ask and Plan turns while such a plugin is loaded. Claude Code's built-in plugins do not count.
- Hooks that an administrator configured through Claude Code's managed policy. Ask turns off hooks from your own settings, but managed-policy hooks cannot be turned off. If one runs you see "A hook ran during this turn (...)", or the turn stops when the strict setting is on.
- Settings helper commands that Claude Code runs when it reads its settings.

The folder check after a turn also skips ignored files and very large folders (more than 500,000 files). The complete list is in [limitations](../limitations.md).

## Ask and plans

If the conversation has a plan, Ask attaches it read-only and always treats it as locked: the agent can answer questions about the plan but cannot change it. See [Plan mode](plan-mode.md).

## Related

- [Plan mode](plan-mode.md) and [Agent mode](agent-mode.md)
- [Troubleshooting](troubleshooting.md)
