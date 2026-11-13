# Accessibility checklist for webview UI

Check this when you add or change UI. `app/accessibility.test.tsx` and `app/styles.test.ts` cover much of it.

## Keyboard and focus

- Use native elements. A custom control needs a role, `tabIndex={0}`, and Enter (Space for buttons). No positive `tabindex`.
- Whatever appears on hover also appears on `:focus-within`. A scrolling box gets `tabIndex={0}`, a role and an `aria-label`.
- Popups close on Escape and return focus to their opener. Never trap Tab.
- If an update removes or disables the focused control, use `useFocusRecovery` (`app/focus.ts`) and give the container `tabIndex={-1}`. Do not remount a form to reset it.
- A tab change moves focus only if it was already lost; never take it from the composer.

## Names, roles, states

- Say what a control acts on: "Reject src/a.ts". Icon-only buttons use `IconButton` with a `label`.
- Toggles: `aria-pressed`. Disclosures: `aria-expanded` and `aria-controls`. Groups: role plus `aria-labelledby`.
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
