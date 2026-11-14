# Reviewing changes

After an Agent turn, every file the agent changed is listed for review. Accepting and rejecting are AgentCanopy decisions and have nothing to do with Git staging. The changes are already on disk while you review; rejecting puts the earlier content back.

While an Agent turn runs in the folder, the Changes card stays but lists no files. In their place it says: "File changes can be reviewed when the turn ends." The configuration section stays too. Accepting through a command or a CodeLens while an Agent turn runs says "Wait for the turn to finish before accepting changes."

## Where to review

- **The Changes card** under the chat in the AgentCanopy view. It appears when there is something to review or decide. Review of single changes is not in the view; it is only in the editor, below.
- **Status bar.** An item such as "2 agent changes" opens all changes in one diff editor.
- **The file itself.** Changed lines are marked in the gutter. Above the file there are **Accept File** and **Reject File** actions, and above each change **Accept Change**, **Reject Change** and **Show Diff**. If the file has unsaved edits, the actions are replaced by "Save to review the agent's changes".
- **Editor title bar.** Accept, reject and diff icons appear when the open file has pending changes.
- **Command Palette**, when changes are pending: **AgentCanopy: Show All Agent Changes**, **Show Agent Changes for File**, **Accept Agent Changes in File**, **Reject Agent Changes in File**, **Accept Agent Change at Cursor**, **Reject Agent Change at Cursor**, **Go to Next Agent Change**, **Go to Previous Agent Change**, **Accept All Agent Changes** and **Reject All Agent Changes**.

In an editor showing a file with pending changes:

| Key | Action |
| :- | :- |
| Alt+] | Go to the next change |
| Alt+[ | Go to the previous change |
| Alt+Enter | Accept the change at the cursor |
| Alt+Backspace | Reject the change at the cursor |

On macOS, Alt is the Option key. The cursor must be in the change, and the file must be saved.

## The Changes card

The card sits between the chat and the message box, also when no conversation is open and in the chat opened in the editor area. Its header, **Changes**, summarizes what is there, for example "2 configuration changes · 3 pending". The arrow in the header collapses the files below it. The configuration section, when there is one, stays visible whatever you do.

**Files.** Each file shows what happened to it (Added, Modified, Deleted, Permissions or Type changed), its path, the lines added and removed, and the buttons **Accept** and **Reject**. Click the path to open the file's diff in VS Code's diff editor. At the top are **Accept All**, **Reject All** and **Open All in Diff Editor**. Reject All includes a file whose source is uncertain only when you tick it (see below). Accepted files move to a collapsed **Accepted** group, or the line "No pending changes, N accepted", and stay readable.

**Single changes.** The card does not list changes line by line. Review them in the editor: the gutter marks, CodeLens and the keys above. Line-by-line review works for UTF-8 text files up to 2 MiB. Other files are accepted or rejected as a whole, and binary files have no diff.

**The workspace snapshot.** The card appears only when there are changed files or configuration changes, and only while it is shown does it show the snapshot. While AgentCanopy prepares the baseline of the folder, the card shows its progress, and when the baseline is incomplete it says so. With nothing to review there is no card, so no progress and no warning.

## Source uncertain

AgentCanopy cannot always say that a change is the agent's alone. These entries may hold your own work:

- **Changed during a turn, but not through one of the agent's tool calls.** For example a save you made in the editor or a `git pull` in another terminal. They are listed under "Changed during a turn, source uncertain" ("Changed while the agent was working, but not by one of its tool calls").
- **Both you and the agent changed the file** ("Both you and the agent changed this file", badge **Includes your edits**).
- **Reconstructed after an interruption** ("Changed around an interrupted turn"), because after a crash AgentCanopy cannot tell which changes the agent made.

Rejecting such a file never happens silently. A single change in it cannot be rejected on its own: you are sent to Reject on the whole file ("This file may include your own work. Use Reject on the whole file to choose what happens."). Rejecting the whole file opens a native dialog titled "This change may include your own work". It says that restoring the earlier version discards everything changed since the turn started, and offers **Review in Diff Editor** or **Restore the Earlier Version**.

**Reject All leaves these files alone unless you tick Include in Reject All** beside them, and then only the ones that were changed outside a tool call are rejected. A file that both you and the agent changed, or that was reconstructed after an interruption, is never part of Reject All, even when ticked: "Reject it on its own to choose what happens." The Reject All confirmation lists every ticked file that was not made by one of the agent's tool calls and may include your work.

## Cannot be restored

A file marked **Cannot be restored** can be accepted, but **Reject** is disabled, because its earlier content was not kept: "The earlier content of this file was not kept, so it cannot be put back." This happens when a command changed a file that is:

- ignored by Git or by `agentCanopy.snapshots.exclude` (the change is detected, but the earlier content was never captured),
- larger than `agentCanopy.snapshots.maxFileSizeMB` (10 MB by default),
- beyond the `agentCanopy.snapshots.maxTotalSizeMB` budget (512 MB by default).

Files the agent edits with its own file tools are captured before the edit whatever their size, up to 256 MB. Files matching sensitive patterns, such as `.env` and key files, are not kept as an after-state, so a restore of one of them cannot recreate what the agent wrote there. When the baseline is incomplete, the Changes card says so while it is shown, for example when a folder has more files than AgentCanopy tracks, so that changes to some of them are not seen at all.

## Rejecting

Rejecting a file restores the earlier content, but only when the file is still exactly what the agent left. Otherwise AgentCanopy asks, in a native dialog titled "This file changed after the agent edited it":

- **Review in Diff Editor**
- **Undo Only the Agent's Changes**, offered when the agent's change can be taken out and your later edits kept
- **Discard Later Edits and Restore**

A file with unsaved edits in the editor is never written: "Save or discard your unsaved changes in this file first." If a single change no longer matches the lines it was made on, it is refused: "This part of the file changed after the agent edited it, so it was not restored."

**Reject All** shows how many changes it will reject and lists those that cannot be rejected and stay as they are. Confirm with **Reject Changes**. Anything that could not be rejected stays listed for review. A created file is removed, but the folders that were created for it stay.

File restore does not undo Git operations, database changes, network calls or anything outside the folder. If the agent changed Git state, a note says so.

## Configuration changes

AgentCanopy compares a set of files before and after every Agent turn: `.claude/settings.json` and `.claude/settings.local.json`, `.mcp.json`, `.vscode/settings.json`, `tasks.json`, `launch.json` and `mcp.json`, the files under `.claude/skills`, `hooks`, `commands` and `agents`, `.husky`, and Git's `config` and `hooks` (in the folder and at the Git root). If any changed, the Changes card shows a **Configuration changes** section with this warning, and the section stays visible, also when the rest of the card is collapsed:

"The last turn changed tool or editor configuration. Such files can make later commands run without asking. Keep or revert each one before the next Agent turn."

For each file, click its path to see the diff, then choose **Keep** or **Revert**. Revert is disabled when the earlier content was not kept. Keep and Revert both ask you to confirm in a native dialog, because either one is final: keeping drops the only copy of the earlier file and lifts the block on Agent turns.

While a configuration change is undecided, an Agent turn does not start. In Agent mode the message box disables Send and says: "Keep or revert the configuration changes in the changes card below the chat before sending in Agent mode." Ask and Plan still work. **Approve and Execute** on a plan is disabled too, with a hint, and a queued Agent message waits.

## Related

- [Agent mode](agent-mode.md)
- [Checkpoints and branches](checkpoints-and-branches.md), to go back further than one turn
- [Limitations](../limitations.md)
- [Delete stored file contents and change history](troubleshooting.md#delete-stored-file-contents-and-change-history)
