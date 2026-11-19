# Plan mode

Plan is for work you want to think through before anything changes. The agent explores your code read-only, saves a plan, and revises it as you answer questions. Nothing is implemented until you approve a specific version.

## Create a plan

1. Choose **Plan** under the message box and describe the goal. Your message is marked "Plan request" in the chat.
2. The agent reads your code with the same four read-only tools as [Ask mode](ask-mode.md), plus one more tool, `submit_plan`, which saves the plan. The same checks that keep Ask read-only apply here.
3. When there are choices to make, the agent asks you first, before it writes the plan. The question appears in the chat as a **Plan options** card. Pick your options and submit; the agent goes on with your answers and writes a plan that follows them.
4. Each save is a new immutable version of the plan. The chat shows a plan card for it, in the order things happened: request, the agent's activity, options, plan.

You can choose Plan while the agent works: the mode applies to the next message and does not affect the running turn. A Plan message sent meanwhile is queued and sent when the turn completes; see [Agent mode](agent-mode.md#send-while-the-agent-works).

If the agent answers in chat without saving a plan, a card says: "No plan was saved in this turn. Ask for the plan again, or switch to Ask mode if you only wanted an answer."

## The plan card

The newest card is the working one. It shows:

- The plan's title, a button that opens the plan as a read-only Markdown document in an editor tab. It is the source, exactly the text that is approved, so what you read is what the agent receives. VS Code's own **Open Preview** shows it rendered.
- The version ("Version 4, restored by you from version 1" after a revert) and a short summary of what changed.
- **Your decisions**, the options you chose, and **Still to decide**, the decision points and open questions the plan still carries.
- **Approve and Execute**, **View changes** and **Revert to version N-1**, and the time of each approval of this version.

The document holds the title, objective, requirements, analysis, architecture, relevant files (with what happens to each), stages with their dependencies and acceptance checks, external dependencies, diagrams, alternatives that were considered, decisions to make, open questions, a testing strategy and acceptance criteria. Diagrams are in the document as Mermaid source text.

The chat does not draw a plan's diagrams or its stage dependency diagram, and file names in a plan are not links. Each version compares only with the version before it (see below), and a plan cannot be exported: the document opened from the title is the way to read or copy it. There is no Plan tab.

## Answer questions and make decisions

- **Decisions to make** are choices between approaches. Pick an option on the plan card; the agent's recommendation is marked.
- **Open questions** take a single choice, several choices or free text.
- Questions the agent asks in chat (the plan options and other question cards) are stored as decisions too.

Your answers are listed under **Your decisions**. They belong to you, not to the model: a new version cannot change them, and they carry over to later versions as long as the question is still in the plan. The next turn receives them.

## Versions, compare and revert

- Every version has its own card in the chat. Older cards are compact and read-only: the title opens that version, **View changes** compares it with the version before it in VS Code's diff editor, and **Restore this version** saves a copy of it as a new latest version. Restore is not shown when its content equals the latest.
- On the newest card, **View changes** compares it with the version before, and **Revert to version N-1** saves a copy of that version as the new latest. Nothing is deleted.

## Lock the plan

**Lock plan** (next to the mode selector) removes the plan tool from the turn. While locked, the agent can answer questions about the plan but cannot change it. Ask mode always works with the plan locked. The lock can only be changed between turns.

## Approve and execute

**Approve and Execute** on the newest plan card is the only way a plan runs. It acts on the latest version, and it is disabled, with a hint, while a turn is running, while configuration changes from an earlier Agent turn await your decision in the Changes card, or while an Agent turn of another conversation runs in the same folder ("Another agent turn is running in this folder.").

1. Click it. A native VS Code dialog names the version and warns if questions or decisions are still unanswered. Which dialog it is depends on [Auto](agent-mode.md#auto):
   - Auto is offered (`agentCanopy.agent.auto.enabled` is on) and off for the conversation: "Approve and execute this plan with Auto?". After the version paragraph and the warning it says "Approving also turns on Auto for this conversation.", then everything the dialog of the Auto switch says: the `Folder:` and `Conversation:` lines, what runs without asking, the sandbox, what still asks, what review and checkpoints do not undo, and "Auto stays on for this conversation, also for queued messages and approved plans, until you turn it off." The button reads **Approve and Execute with Auto**.
   - Auto is already on: "Approve and execute this plan?", with the line "Auto is on for this conversation: terminal commands and edits inside the folder will run without asking." (with `agentCanopy.agent.alwaysAskCommands` on: "Auto is on for this conversation: edits inside the folder will run without asking. Terminal commands still ask."). The button reads **Approve and Execute**.
   - Auto is not offered: "Approve and execute this plan?" with no word about Auto.
   - In each case, when the conversation uses an [orchestrate and delegate](agent-mode.md#orchestrate-and-delegate) model, the dialog adds a paragraph: `This conversation uses an "orchestrate and delegate" model: the model plans, decides and reviews, and hands routine tasks to subagents on faster models (Haiku and Sonnet). What a subagent does is approved, tracked and reviewed like the model's own work.`
2. Confirm. AgentCanopy records the approval for that exact version and content before anything starts. If the plan changed since you looked at it, you are asked to review it and approve again.
3. An [Agent mode](agent-mode.md) turn starts in the same conversation with the approved text embedded in the prompt. In the chat its message reads "Plan approved: executing version N" (in a branch, the copied turns show "Execute plan version N"). With an orchestrate and delegate model the plan is executed that way: the model orchestrates and hands routine tasks to subagents.

From then on the usual Agent rules apply: edits are tracked, commands ask unless Auto is on (or they are [read-only](agent-mode.md#read-only-commands)), and you [review the changes](reviewing-changes.md) afterwards. The plan card shows the time of each approval.

### Auto and plan execution

Approving a plan always turns [Auto](agent-mode.md#auto) on for the conversation, as if you had pressed the **Auto** switch, when Auto is offered and not already on. The approval dialog is the confirmation, which is why it says everything the Auto dialog says. The execution turn then runs with Auto: its commands and edits inside the folder run without asking, as [Agent mode](agent-mode.md#auto) describes, and the execution message "Plan approved: executing version N" carries an "Auto" mark.

- The plan card says what will happen. With Auto off: "Approving turns on Auto for this conversation: commands and edits run without asking." (with `agentCanopy.agent.alwaysAskCommands` on: "Approving turns on Auto for this conversation: edits run without asking. Commands still ask."). With Auto on: "Runs with Auto: commands and edits run without asking." (with `alwaysAskCommands` on: "Runs with Auto: edits run without asking. Commands still ask.").
- With `alwaysAskCommands` on, Auto is turned on but commands still ask, read-only ones too, and the dialog says so.
- With `agentCanopy.agent.auto.enabled` off, nothing is turned on, the dialog and the plan card say nothing of Auto, and every command asks, except a [read-only](agent-mode.md#read-only-commands) one while `agentCanopy.agent.alwaysAskCommands` is off.
- If you decline the dialog, nothing is approved and Auto stays as it was.
- If anything the dialog depended on changes while it is open (the conversation, `alwaysAskCommands`, `agentCanopy.agent.auto.webTools`, `agentCanopy.agent.sandbox`, or `agentCanopy.agent.auto.enabled` turned off and on again), Auto is not turned on. A warning says "Auto was not turned on: the conversation changed while the dialog was open." The approval stays recorded and the execution turn runs without Auto, so its commands ask. If Auto could not be saved ("Auto could not be turned on. The AgentCanopy log has the details."), the same happens.
- Auto stays on afterwards: later turns, queued messages and later approvals of this conversation run with it until you turn it off. The **Auto** switch stays visible in Plan mode while Auto is on. Turning it off needs no dialog and works at once, also in the middle of the execution turn: the next permission request asks again.

Turning Auto on with the switch is not possible while the approval dialog is open.

## Switch modes freely

You can change the mode of a conversation at any time, also while the agent works: the choice applies to the next message and does not affect the running turn. The conversation keeps one Claude Code session, and each turn gets the tool set of its own mode. A branch of the conversation gets its own copy of the plan as it stood when the fork point's turn ended; see [Checkpoints and branches](checkpoints-and-branches.md).

## Related

- [Ask mode](ask-mode.md) for the read-only checks and what they do not cover
- [Limitations](../limitations.md)
