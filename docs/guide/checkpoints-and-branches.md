# Checkpoints and branches

Checkpoints put files back to an earlier state. Branches let you take a conversation in a second direction. They work separately, and one action combines them.

## Checkpoints

Every step that changes files in a workspace folder is recorded in that folder's history: an Agent turn, rejected changes, restored files and a recovery after an interruption. Each step is a checkpoint, and you can go back to the state before any of them.

The **Checkpoints** tab appears once there is at least one. Each row shows the kind of step, when it happened, the conversation it belongs to, how many files it changed and an **Interrupted** badge if the turn did not end normally.

### Restore to before a step

1. Click **Preview Restore** beside a step. The button is disabled while a turn is running.
2. Read the preview. Going back to before step K also undoes every step after it, so the preview names each of them and the conversation it belongs to ("This undoes 3 steps"). Each file has a **Diff** button.
3. Tick the files you want and click **Restore Selected Files**, or **Restore and Branch From Here** (see below).
4. A native dialog, "Restore N files?", asks you to confirm. If some of the files contain changes that were not the agent's, it says how many and that restoring discards those changes. Nothing is written before you confirm.

The preview puts each file in one of three groups:

- **Will be restored.** Ticked by default. The file is as the log last recorded it, and the agent was the only one to change it since.
- **Needs your decision.** Not ticked by default, because restoring discards something. Either the file changed after the last recorded state ("This file changed after the last recorded state. Restoring it discards that change."), or it also holds changes that were not the agent's since that point ("This file also contains changes that were not the agent's since that point. Restoring it discards them.").
- **Cannot be restored.** The file cannot be ticked. The reason is one of: it has unsaved changes in the editor ("Save or discard them first"); its content at that point was not kept; or the path is blocked, for example because it is not inside the folder or a link or something that is not a folder is in the way.

Some files have to be restored together: a name that differs only by case or Unicode form from another one that the restore deletes, or a folder that has to be replaced by a file (or the other way round). They are ticked and unticked as a group and take the most cautious state of the group. Restoring only one of them is refused: "X and Y have to be restored together."

### How a restore is done

AgentCanopy builds the plan from the history again when you confirm. If the history or the files moved on since the preview, it refuses ("The preview is out of date. Open it again.") and shows a fresh preview. A restore is refused while a turn is running in the folder.

Files are written one at a time through a temporary file and a rename, deletions first. Before anything is replaced that is not what the history last recorded, a copy of it is kept. Each file ends up restored or not, and the result is listed ("Restored 3 of 4 files"). The restore is recorded as a step of its own, "Restored files".

That makes a restore undoable: preview a restore to before the "Restored files" step. Undoing a restore also brings back the pending review entries it took away.

### What a restore does not do

File restore does not undo Git operations (commits, checkouts, stashes), database changes, network calls or anything outside the workspace folder. It does not remove directories, except an empty folder that stands where a restored file has to go. A change that was never captured, such as one a command made to an ignored or oversized file, shows under **Cannot be restored**. See [Reviewing changes](reviewing-changes.md#cannot-be-restored) and [limitations](../limitations.md).

### How long checkpoints are kept

By default the last 50 steps per workspace folder, for 30 days. Change this with `agentCanopy.checkpoints.keepOperations` (minimum 5) and `agentCanopy.checkpoints.keepDays`. Older steps are dropped, and captured file content that nothing needs any more is cleaned up. Retention never removes anything that a review entry still shown (pending or accepted) is made of, and never removes anything after the last Agent turn.

To delete the stored contents and history of a folder at once, run **AgentCanopy: Delete Stored File Contents and Change History for This Folder**. See [Troubleshooting](troubleshooting.md#delete-stored-file-contents-and-change-history).

## Branches

A branch is a new conversation that remembers which conversation and which message it came from. Use **Fork from here** on a message. A fork point is a turn boundary. Forking at one of your messages keeps the turns before it and puts that message back in the message box so you can rephrase it. Forking at an assistant message keeps that whole turn. The original conversation is not changed.

The top of a branch names its parent, with a link to open it, and says what kind of context the branch has. A message that has branches shows a marker with the number of branches and a way to open each. A side question (below) has no marker: its card in the chat is the marker.

You cannot branch from the last message of a turn that is still running: "Wait for the turn to finish before branching from its last message." You can branch from the user message of a running turn, which keeps only the turns before it.

### Pending, exact or rebuilt

A new branch is **pending** until its first turn runs: "Its context is decided when you send the first message." The first turn decides how the context is carried:

- **Exact copy.** The branch is exact only when Claude Code really ran on a copy of the parent's session. That happens in two cases. The branch keeps everything the parent has, so the whole session is copied (`--fork-session`). Or the branch keeps up to an earlier turn, and the installed CLI supports cutting a session there (`--resume-session-at`, a flag that is not in Claude Code's CLI reference), `agentCanopy.forks.exactEarlierMessages` is on (it is by default), and that turn finished normally. A branch with nothing before it is also exact: it starts empty.
- **Rebuilt.** In every other case the branch gets a new session, and the visible messages go in front of your prompt as a transcript, within a size budget. The header says "Context rebuilt from the visible messages" and names what was not carried over: tool inputs and outputs, the model's reasoning, files and selections attached to messages, and earlier messages that did not fit in the budget. If the setting is off or the CLI cannot cut, the turn also says so.

An exact branch that later loses its session (Claude Code removed it) is relabelled as rebuilt when it carries on from the visible messages. While a copy of the parent's session is being made, the parent cannot start a turn.

If turns that the branch does not keep changed files in the folder, the branch shows a notice: "The files in the workspace include changes made after this point in the conversation. Branching does not change files; use the checkpoint history to restore them." **Forking never touches your files.** The agent in a branch sees the folder as it is now.

A branch starts with [Auto](agent-mode.md#auto) off, also when the conversation it came from has it on, and so does a side question and the branch that **Restore and Branch From Here** makes. Turn it on in the branch if you want it.

A branch gets its own copy of the plan as it stood when the fork point's turn ended, so changes to the plan in one conversation do not change the other. The turns copied into a branch show the plan execution message as "Execute plan version N" and have no plan options cards, because branches never carry prompts; the answers are still listed on the plan card under "Your decisions".

### Side questions

A question sent in Ask mode while the agent works is a branch that AgentCanopy makes for you; see [Ask mode](ask-mode.md#ask-while-the-agent-works). It keeps the turns that had finished, so its first turn always uses a rebuilt context, because the parent's session is in use and the running turn is not part of the copy. It gets its own copy of the conversation's plan, attached read-only, and decisions made there are not written to the parent's plan. The parent's conversation, session and files are not touched, and the agent in the parent never sees the question.

The answer is shown in a **Side question** card in the parent, where the agent had got to when you asked. History lists the branch under its conversation, marked as a side question. If you open it, it is a normal conversation whose header says it is a side question of its parent, and later turns there do not change the card. Deleting the original conversation keeps the side question as a conversation of its own, still marked as a side question in History, and it cannot have side questions of its own. If the side question could not start, nothing is left behind.

### Restore and branch from here

In the restore preview, **Restore and Branch From Here** restores the selected files and then starts a branch of that step's conversation from just before that turn. It branches only if every chosen file was restored. If some were not, no branch is made, so that the conversation does not suggest the files are back as they were; the message lists the first failures. If the step's conversation was deleted, the files are restored and no branch is made. The branch does not show the "files are newer" notice, because the files are as they were.

## Related

- [Reviewing changes](reviewing-changes.md)
- [Limitations](../limitations.md), including the forking limits
