# Plan mode

Plan is for work you want to think through before anything changes. The agent explores your code read-only, saves a plan, and revises it as you answer questions. Nothing is implemented until you approve a specific version.

## Create a plan

1. Choose **Plan** under the message box and describe the goal.
2. The agent reads your code with the same four read-only tools as [Ask mode](ask-mode.md), plus one more tool, `submit_plan`, which saves the plan. The same checks that keep Ask read-only apply here.
3. Each save is a new immutable version of the plan. The chat shows a card, "Plan updated to version N", with a short summary of what changed and the buttons **Open plan**, **View changes** and **Revert to version N-1**. The Plan tab appears as soon as a plan exists.

If the agent answers in chat without saving a plan, a card says: "No plan was saved in this turn. Ask for the plan again, or switch to Ask mode if you only wanted an answer."

## What a plan contains

The Plan tab shows the title, objective, requirements, analysis, architecture, relevant files (with what happens to each), stages with their dependencies and acceptance checks, external dependencies, diagrams, alternatives that were considered, decisions to make, open questions, a testing strategy and acceptance criteria. Diagrams are written in Mermaid and drawn with Mermaid's strict security level.

## Answer questions and make decisions

- **Decisions to make** are choices between approaches. Pick an option; the agent's recommendation is marked.
- **Open questions** take a single choice, several choices or free text.
- Questions the agent asks in chat (question cards) are stored as decisions too.

Your answers are listed under **Your decisions**. They belong to you, not to the model: a new version cannot change them, and they carry over to later versions as long as the question is still in the plan. The next turn receives them.

## Versions, compare and revert

- Use the **Version** menu to read an older version. Older versions are read-only.
- **Compare with...** opens VS Code's diff editor on the two versions as Markdown.
- **Revert to this version** saves a copy of that version as a new latest version. Nothing is deleted.
- **Export** opens the version as Markdown in an editor tab, and **Open in editor** moves the plan view into the editor area.

## Lock the plan

**Lock plan** (next to the mode selector, and **Locked** in the Plan tab) removes the plan tool from the turn. While locked, the agent can answer questions about the plan but cannot change it. Ask mode always works with the plan locked.

## Approve and execute

**Approve and execute version N** is the only way a plan runs. It is shown for the latest version and is disabled while a turn is running.

1. Click it. A native VS Code dialog, "Approve and execute this plan?", names the version and warns if questions or decisions are still unanswered.
2. Confirm with **Approve and Execute**. AgentCanopy records the approval for that exact version and content before anything starts. If the plan changed since you looked at it, you are asked to review it and approve again.
3. An [Agent mode](agent-mode.md) turn starts in the same conversation with the approved text embedded in the prompt.

From then on the usual Agent rules apply: edits are tracked, commands ask, and you [review the changes](reviewing-changes.md) afterwards. The plan shows the time of each approval.

## Switch modes freely

You can change the mode of a conversation between turns. The conversation keeps one Claude Code session, and each turn gets the tool set of its own mode. A branch of the conversation gets its own copy of the plan as it stood when the fork point's turn ended; see [Checkpoints and branches](checkpoints-and-branches.md).

## Related

- [Ask mode](ask-mode.md) for the read-only checks and what they do not cover
- [Limitations](../limitations.md)
