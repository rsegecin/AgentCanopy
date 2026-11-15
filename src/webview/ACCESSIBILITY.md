# Accessibility checklist for webview UI

Check this when you add or change UI. `app/accessibility.test.tsx` and `app/styles.test.ts` cover much of it.

## Keyboard and focus

- Use native elements. A custom control needs a role, `tabIndex={0}`, and Enter (Space for buttons). No positive `tabindex`.
- Whatever appears on hover also appears on `:focus-within`. A scrolling box gets `tabIndex={0}`, a role and an `aria-label`.
- Popups close on Escape and return focus to their opener. Never trap Tab.
- If an update removes or disables the focused control, use `useFocusRecovery` (`app/focus.ts`) and give the container `tabIndex={-1}`. Do not remount a form to reset it.
- A tab change moves focus only if it was already lost; never take it from the composer.

## Cards in the chat and above the composer

The view has four tabs (Chat, Checkpoints, History, Permissions; Checkpoints only once there is a step; Permissions only while something is saved or a switch is on, or while it is the selected tab, so it never disappears under the user). Plans, the agent's questions, side questions and the changes of a turn are cards, not tabs. Every card is a labelled region or group, takes `tabIndex={-1}` so focus can land on it, and uses `useFocusRecovery` for the control that may go away.

- **Changes card** (`features/review/ChangesDock.tsx`, between the log and the composer): a `section` named by its "Changes" heading. The header is a disclosure button (`aria-expanded`, `aria-controls`) only while there are files to collapse; the configuration section is outside the collapsed part. The body is a scrolling `role="group"` named "Changes details" with `tabIndex={0}`. Buttons name the file: "Open diff of src/a.ts", "Accept src/a.ts", "Reject src/a.ts", "Keep …", "Revert …", "Include in Reject All: …". A disabled Revert or Reject points to its reason. Focus recovery falls back to the composer's textarea. While the baseline is prepared, one polite status repeats the progress at most every 5 seconds.
- **Plan cards** (`features/plan/PlanUpdateCard.tsx`): the current card is a `section` named by its title, which is a button ("Title, open version N"). "Your decisions" and "Still to decide" are named groups. Approve and Execute, when disabled, points to the reason (a turn is running, configuration changes are pending, questions have no answer). Older cards are groups named "Plan version N"; View changes and Restore this version say which version in hidden text. One wrapper stays mounted while a card changes between current, older and one-line, and recovery sends focus to the title button of the card shown. The "Plan options" card is the agent's question card, a named group; "Needs your answer" is text, and a new question is scrolled into view, never focused.
- **Queued message** (`features/chat/QueuedMessage.tsx`, above the composer): a `section` named "Queued message" with a `role="status"` line that says when it will be sent or why not. Its buttons are named "Edit queued message", "Remove queued message" and "Send now, queued message" (or "Send queued message"); a disabled Send points to the status line. The text is clamped and becomes a focusable named group only when it overflows. Focus recovery falls back to the composer.
- **Auto switch** (`features/chat/Composer.tsx`, next to the mode selector): a real button named "Auto" with `aria-pressed`, shown in Agent mode and, while Auto is on, in the other modes so it can be turned off. The on state is the icon (a filled check against an empty circle) and the pressed state, never colour alone. It is disabled only for turning on, while a turn runs or the composer is blocked, and then points with `aria-describedby` to its reason ("Auto can be turned on when the turn ends." or the block notice); turning off is never disabled. A hint line says what Auto covers ("Auto is on: commands and edits in this folder run without asking.", "…edits in this folder run without asking. Commands still ask.", or "Auto is on for this conversation's Agent turns." outside Agent mode), and the Agent mode description is rewritten while Auto is on so that it does not say "with your approval". The marks are text: "Agent · Auto" on messages and on the queued message, an "Auto" badge on the plan execution message, "Runs with Auto: …" on the plan card, and in History an "Auto" flag with icon whose hidden text says "Auto is on for this conversation's Agent turns." Tool cards say "Auto-approved" in words.
- **Composer**: Stop sits beside Send while a turn runs. Escape in the textarea moves focus to Stop. The reason Send is disabled, or the note that an Ask message will be asked as a side question, is text tied to the textarea with `aria-describedby`.
- **Side question card** (`features/chat/AsideCard.tsx`, in the log at its anchor): a `section` named "Side question: <question>", so several cards differ. Its answer uses the transcript's part renderers and is never in a live region. A status line says "Answering…", "Answered." (once, when it has finished) or "Stopped."; the error of a failed side question is a `role="alert"` line instead, and the rest is polite. The buttons are "Stop side question: <question>" and "Open as conversation: <question>". When Stop goes away, focus stays on the card. A permission or question prompt inside the card is answered there, and one that waits for the user is announced like any other prompt.
- **Permissions view** (`features/permissions/PermissionsView.tsx`): a scroll container with `tabIndex={-1}` holding four `section`s named by their `h2` ("Allowed without asking in this folder", "Saved permissions", "Always asks", "Settings for every project"); the saved entries are real lists under `h3` headings by kind. The three switches are `role="switch"` buttons with `aria-checked` and the visible word "Allow" or "Ask"; the on state is also the filled icon, the bold label and the outline, never colour alone. Each Remove is named after its entry ("Remove docs.example.com"). The whole of it is disabled, with the real `disabled` attribute, in an untrusted workspace or without a folder, and each control points with `aria-describedby` to one visible sentence that says why; "Open Settings" stays enabled. After a click every changing control stays disabled until the host sends the permissions again, and focus then goes back to the control that was pressed, or to the one now in its place when its entry is gone (`useFocusRecovery` keeps it on the page while the lock holds). The project-code warning of a command has the icon hidden and the hidden text "Warning: ".
- **History** marks a side question with an icon and the visible words "Side question", and says it in words for screen readers like the branch flag.

## Names, roles, states

- Say what a control acts on: "Reject src/a.ts". Icon-only buttons use `IconButton` with a `label`.
- Toggles: `aria-pressed`. An Ask/Allow setting is a `role="switch"` button with `aria-checked`, its name from `aria-labelledby` (the setting, not the state), its description from `aria-describedby`, and the state in visible words ("Allow", "Ask"). Disclosures: `aria-expanded` and `aria-controls`. Groups: role plus `aria-labelledby`.
- A disabled control with a reason points to it with `aria-describedby`.
- Use real lists and headings without skipped levels. Diagrams are `role="img"` with a name; code blocks name their language.

## Announcements and colour

- Never put streaming text in a live region. Announce a change once, in words. Errors `role="alert"`, the rest polite. Throttle progress.
- Status, change type, attribution, warnings and errors carry text or an icon with a text alternative, never colour alone.

## Themes

- Only `--vscode-*` variables: no hex, `rgb()` or colour names.
- Focus ring `1px solid var(--vscode-focusBorder)`, drawn inside clipping boxes.
- A surface told apart only by background gets a border in `app/styles/contrast.css`.
- Disabled: dimmed, `cursor: not-allowed`, real `disabled`.

## Motion and size

- Do not add smooth scrolling or animation outside the reduced-motion rules.
- Long paths, commands and titles wrap or scroll in their own box. Try 260 px width and 200% zoom.

## What was checked

The rules above are covered by automated tests (`app/accessibility.test.tsx`, `app/styles.test.ts` and the component tests) and by this checklist. The Permissions view has tests for its headings (h2 then h3, no skipped level), the name of every control, the role and checked state of each switch, no positive `tabindex`, the reason a disabled control points to, and focus after the pressed entry goes away; its styles are checked for the on state without colour, the high-contrast borders and the 260 px rules, and its screenshots in the preview (520 px dark and light, 260 px dark, and the two permission cards) were looked at. They have not been tested with a screen reader, so expect rough edges.
