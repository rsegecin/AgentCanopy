# Saved permissions, per-folder switches and a Permissions view

Phase 11 in `docs/planning/2026-11-10-implementation-plan.md`. Plan version 1, approved by the owner on 2026-11-15. **Paused after stage s1**: two of six stages are committed.

## Progress

Updated at every stage commit. Last update: 2026-11-15, after stage s1.

**Paused by the owner on 2026-11-15**, when asked how to go on given that some checks of the plan fail on this machine without the change (see below). Nothing of s2 to s5 has been started, and the working tree holds no uncommitted Phase 11 work. Before s2 starts, the owner decides which bar the stages are held to:

- compare with the untouched checkout (type check and lint pass, no test fails that does not fail there, the format check passes with line endings ignored), as s1 was; or
- first make the failing tests and the format check pass on Windows, in commits outside this plan, and then hold the stages to the plan's checks as written.

| Stage | State | Commit |
| :- | :- | :- |
| s0. Decisions, roadmap file and CLI facts | Done | `35e7a14` |
| s1. Contracts, manifest and the editor port | Done | `3162ef6` |
| s2. Grant store and policy | Not started. Next, once the owner says to continue | |
| s3. Host: wiring, dialogs and view state | Not started. Needs s2 | |
| s4. Webview: Permissions view and card wording | Not started. Needs s1 only, so it can be built alongside s2 | |
| s5. Documentation, full verification and status | Not started. Needs s3 and s4 | |

### What exists after s1

- The contracts are in place and nothing uses them yet: `src/shared/permissions.ts`, `alwaysRule.kind`, `ViewState.permissions` and `ViewState.policySettings`, the four webview messages, `UiPort.pickDirectory`, `UiPort.openSettings`, `AppController.showPermissions`, the command `agentcanopy.showPermissions`.
- Working: the command reveals the chat view and posts `show-tab: permissions`; `settings.open` opens the editor's settings on this extension; `policySettings` follows the settings.
- Placeholders that later stages replace:
  - `permissions.remove`, `permissions.setSwitch` and `permissions.addDirectory` answer "This is not available yet." in `Controller.handle` (`src/core/session/controller.ts`). Stage s3 replaces them.
  - `ViewState.permissions` is always `{ folder: null, switches: [], saved: [] }`. Stage s3 fills it.
  - `src/webview/app/App.tsx` ignores a `show-tab` event for `permissions`, because the tab does not exist yet. Stage s4 replaces that line with the tab.
- No policy decision has changed. Every permission request is decided exactly as before Phase 11.

### Decided or found while building

- **The checks of the plan cannot all pass on this machine, with or without Phase 11.** Measured on 2026-11-15 on an untouched checkout of `35e7a14` (Windows 10):
  - `npm test`: 17 tests fail in 10 files, in tests written on macOS: `policy/readonly/decide.test.ts` (4), `provider/claude/detect/detect.test.ts` (2), `provider/claude/process/fake-cli.test.ts` (1), `provider/claude/provider.test.ts` (1), `session/auto.test.ts` (1), `session/checkpoints.test.ts` (1), `session/dialogs.test.ts` (1), `session/review.test.ts` (2), `workspace/store/refresh.test.ts` (1), `workspace/tracker/findings.test.ts` (3). The ones read fail on POSIX paths (`/etc` becomes `D:\etc`), executable bits and file names NTFS refuses.
  - One more, `provider/claude/detect/locate.test.ts` ("never picks an executable through a relative entry"), fails whenever the project folder and the temp directory are on different drives, as they are here (`D:` and `C:`).
  - Two vary from run to run under load: `session/forks.test.ts` ("is rebuilt when the provider cannot cut at a message") and `workspace/tracker/findings.test.ts` ("two hosts taking over the same stale lock").
  - `npm run format:check` fails on every file whose working copy has CRLF line endings (111 files at the time of s1; `core.autocrlf` is `true` and Prettier expects LF). `npx prettier --check --end-of-line auto .` passes for every file.
  - `npm run typecheck` and `npm run lint` pass.
- **The bar used for s1**: type check and lint pass, no test fails that does not fail on the untouched checkout, and the format check passes with line endings ignored. Whether s2 to s5 use the same bar is the owner's open decision (above). Fixing the Windows failures is not part of this plan.
- **The version bump to 0.1.2** in `package.json` and `package-lock.json` was uncommitted before Phase 11 and is not part of it. It stays uncommitted: of `package.json` only the hunk with the new command was staged (`git apply --cached` with that hunk).
- **CLI facts** (s0, from the documentation, not probed): `WebFetch` reports a redirect to another host instead of following it, so the agent's second call is judged on its own host; the `PowerShell` tool carries its command in `command`. Recorded in `docs/protocol/claude-cli.md`, section 13.
- **Small differences from the plan in s1**: `settings.open` is already the real handler, since it needs nothing from later stages. The extension id reaches `src/vscode/host/ui.ts` as `UiParts.extensionId`, set from `context.extension.id` in `activate.ts`. The test that a prompt stored without `alwaysRule.kind` still loads is in `src/core/conversations/store.test.ts`, next to the schema test in `src/shared/index.test.ts`.

### Notes for whoever continues

- In Git Bash, start test commands with `cd "d:/NSources/AgentCanopy" &&` (lower-case drive letter). With an upper-case drive letter in the working directory vitest fails every file with "Cannot read properties of undefined (reading 'config')".
- Never run `prettier --write` on more than the files being changed. During s1 a subagent ran it on `src` and `test`, which turned 95 untouched files from CRLF to LF. They were restored with `git checkout`; nothing but line endings had changed. Briefs for `implementation` must say so.
- To compare test failures with the untouched state: `git worktree add --detach <temp dir> HEAD`, link `node_modules` into it as a junction, run `npx vitest run` there, and remove the junction with `cmd /c rmdir` (not `rm -rf`, which would empty the real `node_modules`) before `git worktree remove`.
- s2 and s4 touch disjoint folders (`src/core/policy/` and `src/webview/` with `scripts/`), so they can be built at the same time; each is committed on its own.

## Context

AgentCanopy's own policy in the extension host decides every edit, command, read and web call: the CLI runs with `--permission-mode default`, and the turn's settings file names those tools under `permissions.ask`, so each call reaches the loopback permission tool and then `TurnPolicy.decide` (`src/core/provider/claude/process/invocation.ts`, `src/core/policy/`).

Before this phase only two things can be saved: an exact plain Bash command and an MCP tool, per workspace folder (`src/core/policy/agent/rules.ts`). A read outside the folder, a web fetch, a web search and every PowerShell command ask each time, and nothing lists or removes what was saved: `RuleStore.remove` has no caller. The Auto roadmap left that out by name ("A list or remove screen for always-allow rules").

The owner wants these permissions to be configurable in a settings area of the extension, with an "Always allow" choice.

## Decisions

Confirmed by the owner on 2026-11-15.

1. **The settings area lists saved permissions and has an Ask/Allow switch per kind.**
2. **Switches exist for reads outside the folder, web fetch and web search.** Not for commands: a folder-wide switch would be Auto left on for every conversation, and Auto is per conversation and starts off. Not for MCP tools: they keep "Always allow" per tool.
3. **Switches and saved permissions belong to one workspace folder.** Another project asks again.
4. **Edits outside the folder and edits to protected files keep asking.** Review and checkpoints cannot undo the first; the second can run code or change approvals later.

Decided with the plan, not asked:

- **Non-MCP tools get no "Always allow"** (`Skill`, `Monitor`, `ExitPlanMode`, `EnterWorktree`, `Workflow`, unknown tools). Phase 10 approves such tools only from a list of verified names, which is empty, and `Monitor` runs a command under Bash's rules.
- **Credential locations and AgentCanopy's own storage always ask**, also with the reads switch on or inside a saved directory.
- **The host decides, not the CLI.** Nothing new is passed to Claude Code. Its ask rules win over allow rules, so CLI rules for reads or domains would do nothing, and taking the tools out of the ask rules would lose the real-path check, the approval label and immediate removal.

## Requirements

- Reads and searches outside the workspace folder run without a prompt only when the folder's `read-outside` switch is on or every outside target lies inside a directory saved for that folder; otherwise the existing prompt appears.
- A read-outside card offers "Always allow" when one directory covers every outside target and may be granted; the card and the native confirmation both show exactly the directory that is saved.
- Credential locations under the home directory and AgentCanopy's own storage directories always ask and are never offered "Always allow", whatever switch is on and whatever directory is saved.
- A directory cannot be saved when it is a filesystem or drive root, the home directory, an ancestor of the home directory, or a sensitive location.
- Web fetch runs without a prompt when the folder's `web-fetch` switch is on or the address's host is saved for the folder (exact host match, `http` or `https` only, no user name or password in the address). Web search runs without a prompt only when the `web-search` switch is on.
- In Ask and Plan, web tools stay denied while `agentCanopy.ask.webTools` is off, whatever is saved.
- A plain PowerShell command (letters, digits, space and `_ . / \ : -`, at most 300 characters) can be saved and then runs without a prompt by exact match; `agentCanopy.agent.alwaysAskCommands` ignores it and removes the choice, as for Bash.
- Edits outside the folder, edits to protected files and non-MCP tools keep asking with only "Allow once" and "Deny".
- Every switch and saved permission belongs to one workspace folder and is stored in the extension's workspace storage, never in the repository or in VS Code settings.
- Adding a permission or turning a switch on happens only after a native dialog confirmed it; no message from the webview alone can do it. Removing a permission and turning a switch off need no dialog and work during a running turn.
- The policy reads the stores at every request, so a removal or a switch turned off applies to the next request of a running turn.
- A call allowed by a switch or a saved permission is recorded with approval `user` and shown as "Approved by you".
- The Permissions view shows, for the folder of the view: the three switches, every saved permission (directories, sites, Bash and PowerShell commands, MCP tools) with Remove, what always asks, and the machine-wide settings read-only with a button that opens VS Code's Settings.
- The Permissions view is reachable from the overflow menu and from the command **AgentCanopy: Show Permissions**, and meets the accessibility rules in `src/webview/ACCESSIBILITY.md`.
- Prompts stored before this change still load: `alwaysRule.kind` is optional.
- The CLI invocation, the rule file format, Auto, the tracker and the read-only guard are not changed, and their existing tests pass unmodified except where a signature they call changed.
- Layer rules hold: `src/shared` and `src/core` import neither `vscode` nor React, `src/webview` imports only `src/shared`. `package.json`, the lockfile, `src/shared/`, `src/core/contracts/` and `src/vscode/extension.ts` are edited by the primary model only.
- Commits are local on `develop`, one or more per stage, named "Phase 11.N: ...". Nothing is pushed.

## Design

### What changes per kind

| Kind | Today | After |
| :- | :- | :- |
| Read or search outside the folder | Asks: once / deny | Runs when the folder's switch is on or the path lies in a saved directory. Otherwise asks: once / always (the directory) / deny |
| Web fetch | Asks (Auto can cover it by setting) | Runs when the switch is on or the site is saved. Otherwise asks: once / always (the site) / deny |
| Web search | Asks (Auto can cover it by setting) | Runs when the switch is on. Otherwise asks: once / deny |
| PowerShell command | Asks every time | Runs when that exact plain command is saved. Otherwise asks: once / always / deny |
| Bash command, MCP tool | Once / always / deny | Unchanged; now listed and removable |
| Edit outside the folder, protected file, other tools | Asks | Unchanged |
| Credential locations and AgentCanopy's storage | Ask (they are outside) | Always ask, whatever is saved |

- Switches and saved read and web permissions apply in Ask, Plan and Agent mode. In Ask and Plan the web tools still exist only while `agentCanopy.ask.webTools` is on.
- `agentCanopy.agent.alwaysAskCommands` keeps ignoring saved commands and MCP tools, now also PowerShell ones. It does not affect reads or web.
- Auto is unchanged and is checked after the saved permissions.
- A call allowed by a switch or a saved permission has `approval: 'user'` and shows "Approved by you".

### Storage

- The rule store is unchanged: Bash commands and MCP tools in the CLI's rule syntax, still passed as allow rules.
- New grant store, `src/core/policy/grants/store.ts`, one file per folder key at `<storageDir>/permissions/<key>.json`, written like the rule files (validated on load, atomic write, queued, mode 0600, at most 200 grants):

```json
{ "version": 1,
  "switches": ["read-outside"],
  "grants": [
    { "kind": "read-directory", "path": "D:\\libs\\shared" },
    { "kind": "web-site", "host": "docs.example.com" },
    { "kind": "powershell-command", "command": "npm test" } ] }
```

- `path` is an absolute real path. `host` is the address's `host` in lower case, with a port that is not the default one.
- API: `init()`, `get(folderKey)` returning `{ switches, grants }`, `add`, `remove`, `setSwitch(folderKey, name, on)`.
- `createSavedPermissions({ rules, grants })` (`grants/saved.ts`) lists both stores as display entries with an opaque id (the first 32 hex characters of the sha256 of the entry's canonical JSON), removes by id, and tells whether what a card offered was saved.

### Policy

Both policy factories get `grants` and `sensitiveRoots: () => string[]` (the extension's workspace and global storage directories). `PolicyContext` does not change. The store is read at every request, after the last await before an approval returns. Without a grant store every decision is today's.

- **Reads** (`decideRead`, all modes). An outside target is covered when its real path is known, is not sensitive, and the switch is on or it lies in a saved directory. All covered: allow. Otherwise the prompt; "Always allow" is offered when one directory covers every outside target and may be granted (the target when it is a directory, else its parent), with `alwaysRule: { kind: 'read-directory', rule: <dir>, runsProjectCode: false }`.
- **Sensitive and too broad** (`grants/sensitive.ts`). `isSensitivePath`: `.ssh`, `.aws`, `.azure`, `.gnupg`, `.kube`, `.docker`, `.config`, `.claude`, `.claude.json`, `.npmrc`, `.netrc`, `.git-credentials`, `.pypirc` under the home directory, `AppData` on Windows, `Library` on macOS, and the extension's storage directories; case is ignored on Windows and macOS. `canGrantDirectory`: false for a filesystem or drive root, the home directory, its ancestors, anything sensitive. The sensitive check runs at decision time and wins over every switch and grant.
- **Web.** `fetchSite(url)` is the lower-case `host` of an `http` or `https` address without user name or password; the match is exact. Order: the `askWebTools` gate in Ask and Plan, the switch or a saved site (`approval: 'user'`), Auto, the prompt. A fetch with a site offers "always" with `alwaysRule: { kind: 'web-site', rule: <host> }`. A search card has no "always".
- **PowerShell.** `exactPowerShellCommand`: letters, digits, space and `_ . / \ : -`, 1 to 300 characters, no space at either end; the match is exact text. `runsProjectCodePowerShell` is false only for a short list of inert first words (`Get-ChildItem`, `Get-Content`, `Get-Location`, `Get-Item`, `Test-Path`, `Resolve-Path`, `Select-String`, `Get-Date`, the aliases `ls dir gci cat type gc pwd gl`, and `git` with the inert subcommands and option checks that Bash uses). Order as for Bash: the sandbox-escape check, the saved command unless `alwaysAskCommands`, Auto, the prompt. `alwaysRule: { kind: 'command', rule: 'PowerShell(<command>)', runsProjectCode }`.

### Adding and removing

The webview is untrusted. It can take permissions away without a dialog; it cannot add one.

- **From a card**: "Always allow" opens the native "Always allow this?" dialog, which names the directory, site or command and the workspace folder. Declined, the call is allowed once.
- **A switch turned on, a folder added in the view**: refused in an untrusted workspace, without a folder, or while another permissions dialog is open for the view; then a native dialog; then the same checks again (the view still shows the same folder, the workspace is still trusted); then the save. A failed save leaves it off and warns.
- **A folder added in the view** is refused with a plain message when it is inside the workspace folder, too broad, sensitive or already covered.
- **Remove, and a switch turned off**: at once, no dialog, also during a turn. The next request asks.

What the dialogs must say:

| Dialog | Content |
| :- | :- |
| Switch: reads outside | The folder's path. The agent reads and searches anywhere on this machine without asking, in every mode; what it reads is sent to the model. Credential locations and AgentCanopy's storage still ask; edits outside still ask. It can be turned off under Permissions |
| Switch: web fetch | The folder's path. Any address is fetched without asking. A page can carry instructions for the agent and an address can carry file contents out. In Ask and Plan only while `agentCanopy.ask.webTools` is on |
| Switch: web search | The folder's path. Every search runs without asking; the query leaves the machine. The same note about Ask and Plan |
| Always allow: directory | The directory and the workspace folder. Reads and searches in it and below no longer ask, in every mode. What is read is sent to the model |
| Always allow: site | The host and the workspace folder. Any address on that site is fetched without asking and can carry file contents to it. A redirect to another site is reported to the agent, and its next request is judged on its own |
| Always allow: PowerShell | The command, and that it runs code from the project when it may |

Folder paths are shown as the Auto dialog shows them (real path, home as `~`, shortened in the middle), never a display name.

### Permissions view

A tab in the AgentCanopy view, for the folder the view shows, reachable from the overflow menu and from **AgentCanopy: Show Permissions**. The tab button is in the tab list while the folder has something saved or a switch on, or while the tab is selected.

1. **Allowed without asking in this folder**: the three switches (`role="switch"`), each with one line of what it covers.
2. **Saved permissions**: folders, web sites, commands, tools; each with the text in `<code>`, the project-code warning where it applies, and **Remove**. **Allow a folder...** opens the native folder picker. An empty-state line.
3. **Always asks**: edits outside the folder, protected files, other tools, with the reason.
4. **Settings for every project**: the six `policySettings` values, read-only, and **Open Settings**.

Everything is disabled in an untrusted workspace or without a folder. A control stays locked after a click until the state changes. The permission card words its rule line by `alwaysRule.kind`: unchanged for commands and tools; "Always allow would allow reads and searches in this folder and below: ..." for a directory; "Always allow would allow fetching any address on: ..." for a site.

### Contracts

Built in s1.

- `src/shared/permissions.ts`: the switch names, the saved-permission entry, the folder's permissions and the policy settings.
- `PermissionPrompt.alwaysRule.kind` (optional): `command`, `tool`, `read-directory`, `web-site`. Absent means a command or tool rule, so stored prompts still load.
- `ViewState.permissions` (per view) and `ViewState.policySettings` (global).
- Messages `permissions.remove`, `permissions.setSwitch`, `permissions.addDirectory`, `settings.open`; `show-tab` accepts `permissions`. None names a folder.
- `UiPort.pickDirectory`, `UiPort.openSettings`, `AppController.showPermissions`. Command `agentcanopy.showPermissions`. No new setting, no new dependency.

### What does not change

The CLI invocation and the execution profile, the rule file format, Auto and its reset, the tracker, review and checkpoints, the read-only guard and tripwire, the protected-path list, and the text sent to the model about the mode.

## Stages

One or more commits per stage on `develop`. The primary model edits `package.json`, `src/shared/` and `src/core/contracts/`, briefs `implementation` for the rest with a decided design, and reviews every change.

### s0. Decisions, roadmap file and CLI facts (done, `35e7a14`)

Primary model, no code.

- The Phase 11 row and paragraph in `docs/planning/2026-11-10-implementation-plan.md`: the four decisions, the deviation from section 2.2, how SPEC section 8 is met, why non-MCP tools get no "Always allow".
- This file.
- `docs/protocol/claude-cli.md`, section 13: what `WebFetch` does on a redirect to another host, and the input field of the `PowerShell` tool.
- The uncommitted changes in `package.json` and the lockfile looked at and kept out.

### s1. Contracts, manifest and the editor port (done, `3162ef6`)

- Primary: `src/shared/permissions.ts`, `prompts.ts`, `view-state.ts`, `protocol.ts`, `index.ts`, schema tests in `index.test.ts`, `src/core/contracts/app.ts`, the command in `package.json`.
- `implementation`: `src/vscode/host/ui.ts` (`pickDirectory`, `openSettings`), `src/vscode/host/activate.ts` (the command), `src/core/session/controller.ts` (`showPermissions`, the message cases, `policySettings`), `state.ts`, the fake UI port in `test-support.ts`, tests in `views.test.ts`, `test/unit/manifest.test.ts`, `test/integration/activation.test.ts`.

### s2. Grant store and policy (next)

`implementation`, primary reviews. Depends on s1.

- `src/core/policy/grants/store.ts`: `createGrantStore({ dir, logger })` following `rules.ts` (folder key check, file name check, queue, temp file and rename, mode 0600, at most 200 grants, drop and log what does not validate, an unreadable file counts as empty).
- `grants/sensitive.ts` (`isSensitivePath`, `canGrantDirectory`), `grants/web.ts` (`fetchSite`), `grants/saved.ts` (`createSavedPermissions` with `list`, `remove`, `has`; display text through `escapeForDisplay`), `grants/index.ts`; `src/core/policy/index.ts` re-exports `createGrantStore` and `createSavedPermissions`.
- `src/core/policy/agent/commands.ts`: `exactPowerShellCommand`, `runsProjectCodePowerShell`.
- `src/core/policy/readonly/decide.ts`: `decideRead(request, context, access)` and the read-only `decideWeb` take an `access` object (`grants`, `sensitiveRoots`). The answer helper accepts `allow-always` only when it was offered and then saves; an answer that was not offered is denied, as `interpret` does in the agent policy.
- `src/core/policy/readonly/policy.ts` and `src/core/policy/agent/policy.ts`: the factories take `grants` and `sensitiveRoots`; `decideWeb` and `decideCommand` as designed. Without `grants` behaviour is exactly today's.
- Every approval reads the store after the last await before it returns, like `context.auto`.

Tests, on real temporary directories as the existing policy tests use:

- Store: round trip, invalid and duplicate entries dropped, the 200 limit, a failed write leaves memory unchanged, a bad folder key refused.
- Sensitive: each listed location, a path below one, case on Windows, a root, the home directory, an ancestor of it, an ordinary sibling repository.
- Reads, in Ask and in Agent: inside is unchanged; outside with nothing saved prompts once/always/deny and shows the directory; the switch allows with `approval: 'user'`; a saved directory allows a file below it and not a sibling; a symlink inside a saved directory that points out of it asks; path and pattern both outside and only one covered asks; a sensitive path asks with only once/deny although the switch is on; "always" saves the directory and the next request passes without a prompt; removing it makes the next request ask.
- Web: a site matches the exact host and port only; an address with a user name, a `file:` address and an unparsable one ask without "always"; search has no "always"; the switch allows; Ask with `askWebTools` off denies whatever is saved; with Auto and `agentAutoWebTools` the label stays `auto` when nothing is saved and is `user` when a site is saved.
- PowerShell: a plain command offers "always" and is saved; a command with `$`, `;`, `|`, a backtick or quotes does not; `alwaysAskCommands` removes the choice and ignores the saved command; `dangerouslyDisableSandbox` still asks first; Bash behaviour unchanged.

Files: `src/core/policy/grants/{store,sensitive,web,saved,index}.ts` with `store.test.ts`, `sensitive.test.ts`, `web.test.ts`, `saved.test.ts`; `src/core/policy/index.ts`; `src/core/policy/agent/{commands,policy}.ts` with `helpers.test.ts`, `policy.test.ts`; `src/core/policy/readonly/{decide,policy,test-support}.ts` with `decide.test.ts`, `policy.test.ts`.

Done when: the checks pass; every existing policy test passes with its expectations unedited; the tests above exist and pass, including the sensitive-path and symlink cases; nothing under `src/core/policy` imports `vscode` or React.

### s3. Host: wiring, dialogs and view state

`implementation`, primary reviews with the trust model as the checklist. Depends on s2.

- `controller.ts` `createDefaults`: create and open the grant store in `join(dir, 'permissions')`, build `createSavedPermissions`, pass `grants` and `sensitiveRoots` to both policies. With an injected policy there are no stores: the view is empty and the handlers answer "not available yet".
- `syncPermissions(view)` and a per-folder refresh, called from `syncViewScope` and after an always answer, a removal, a switch change and an added directory.
- Handlers for `permissions.remove`, `permissions.setSwitch` and `permissions.addDirectory` as designed: refusals before the dialog, the native dialog, the same checks again after it, then the save; one permissions dialog per view at a time. New texts in `src/core/session/text.ts`.
- `turn.ts`: keep the whole `alwaysRule` of an always answer; `onAlwaysAllowChosen(conversationId, folderKey, alwaysRule)`; the controller checks `saved.has`, warns with the existing "could not be saved" text when it is false, then refreshes the views of the folder.
- `src/core/session/prompts.ts`: `alwaysAllowDetail` per kind, with the folder path formatted as in the Auto dialog.
- The security comment above `handle` gains what the webview can and cannot do with permissions.

Tests in `src/core/session/permissions.test.ts` and additions to `prompts.test.ts` and `dialogs.test.ts`:

- A switch is not turned on when the dialog is declined, in an untrusted workspace, or when the view moved to a conversation of another folder while the dialog was open; it is turned off without a dialog during a running turn and the next outside read of that turn asks.
- `permissions.remove` with an unknown id does nothing; with a known id it removes from the right store and every view of the folder is patched.
- `permissions.addDirectory`: a cancelled picker saves nothing; a folder inside the workspace, a drive root, the home directory and a sensitive folder are refused with a message; a valid one is saved only after the confirmation.
- An always answer on a read-outside card: declined, it allows once and saves nothing; confirmed, it saves the directory, the view lists it and no warning appears; with a failing store the warning shows and the call is still allowed once.
- The confirmation text for each kind contains the directory or host, the workspace folder's path and the required sentences.
- With an injected policy the view state has empty permissions and the handlers answer "not available yet".

Files: `src/core/session/{controller,turn,prompts,text,state,view,test-support}.ts`, `permissions.test.ts`, `prompts.test.ts`, `dialogs.test.ts`.

Done when: the checks pass; every caller of `GrantStore.add` and `GrantStore.setSwitch(..., true)` is behind a resolved native dialog (the primary model reads each one); the tests above pass; existing session tests pass with only the calls to the changed `onAlwaysAllowChosen` signature edited.

### s4. Webview: Permissions view and card wording

`implementation`, primary reviews and reads the preview screenshots. Depends on s1 only.

- `src/webview/features/permissions/PermissionsView.tsx`: the four sections; switches as buttons with `role="switch"` and `aria-checked`; each Remove button named after its entry; headings in order; a visible focus ring; disabled with an explanation in an untrusted workspace or without a folder; controls locked after a click until the state changes.
- `src/webview/app/ui-state.ts`: `permissions` in `Tab` and in the stored-tab schema. `App.tsx`: the tab, its panel and the rule for when its button shows (this replaces the line that ignores the event). `OverflowMenu.tsx`: the "Permissions" item.
- `PromptCards.tsx`: the rule line by `alwaysRule.kind`.
- `src/webview/app/styles/permissions.css`, imported from `index.css`, with the existing variables; `contrast.css` checked for the high-contrast themes.
- `src/webview/test-support/fixtures.ts` and `scripts/preview-webview.mjs`: one entry of each kind, one switch on, a read-outside card and a web-fetch card that offer "Always allow".
- `src/webview/ACCESSIBILITY.md`: the new view.

Tests: `features/permissions/permissions.test.tsx` (each kind renders; `permissions.remove` with the id; `permissions.setSwitch` with the opposite value; `permissions.addDirectory` and `settings.open`; disabled when untrusted; the empty state), `prompt-cards.test.tsx` (wording per kind, unchanged without `kind`), `app.test.tsx` (the tab appears with a saved permission, is reachable from the overflow menu when empty, `show-tab: permissions` selects it), `accessibility.test.tsx`.

Done when: the checks pass; `npm run build && node scripts/preview-webview.mjs --check` renders the view and the two new cards under the CSP and the screenshots were read; the webview imports only from `src/shared`; every control is reachable and operable by keyboard.

### s5. Documentation, full verification and status

`implementation` writes, primary reviews every sentence against the code. Depends on s3 and s4.

- `docs/guide/agent-mode.md`: "What happens without asking", "What asks", "Always allow", a new section "Permissions", the Auto table rows for reads and web, the label paragraph.
- `docs/guide/ask-mode.md`: reads outside the folder and web tools with a switch or a saved permission; Ask stays read-only.
- `docs/limitations.md`: the sensitive list is a backstop; a saved site or the fetch switch lets file contents leave in an address; exact host match only; permissions are per folder and per workspace storage; PowerShell rules are plain literal commands; redirects. The sentence that no rule can be saved for a PowerShell command is corrected.
- `SECURITY.md`, `docs/guide/troubleshooting.md` (the new refusal messages), `docs/architecture.md` (the grant store and the policy inputs), `README.md` (the command and one paragraph).
- `docs/planning/2026-11-10-implementation-plan.md`: the Phase 11 row with what was verified and what was not. `CLAUDE.md`: this plan as built.
- `test/live/ask.live.test.ts`: one case (an outside read with a saved directory), written and run only when asked.

Verification: `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`, `npm run build`, `npm run test:integration`. By hand, in the Extension Development Host on Windows:

1. In Ask mode, read a file in a sibling folder, choose Always allow, confirm; a second file there does not ask; the Permissions view lists the folder; Remove; the next read asks.
2. Turn the reads switch on and off.
3. Read a file under `~/.ssh` with the switch on: it asks.
4. In Agent mode run a plain PowerShell command, Always allow, run it again.
5. An edit outside the folder and an edit to `.vscode/settings.json` still ask.
6. Open a second project: nothing is allowed there.

Done when: the commands' results are reported as they were; every statement in the changed docs about what asks and what runs matches the policy tests of s2; the status table says what was verified by test, by preview and by hand, and what was not; the manual checks were done and reported, or reported as not done.

## Acceptance criteria

- With nothing saved and all switches off, every permission decision is the same as before the change; the existing policy and session tests pass with their expectations unedited.
- Choosing "Always allow" on a read-outside card and confirming the native dialog saves the shown directory for the folder; later reads and searches below it run without a prompt in Ask, Plan and Agent mode and are labelled "Approved by you".
- Turning "Reads outside the folder" to Allow in the Permissions view needs a native confirmation; afterwards outside reads run without a prompt, except credential locations and AgentCanopy's storage, which still ask.
- A saved site lets web fetches to exactly that host run without a prompt; the web fetch and web search switches do the same for every address and every query; Ask and Plan still deny web tools while `agentCanopy.ask.webTools` is off.
- A plain PowerShell command can be saved and then runs without a prompt; `agentCanopy.agent.alwaysAskCommands` makes it ask again.
- Edits outside the folder, protected files and non-MCP tools still offer only "Allow once" and "Deny".
- The Permissions view lists every saved permission of the folder, including Bash commands and MCP tools saved before this change, and Remove takes effect on the next request, also in a running turn.
- No webview message can add a permission or turn a switch on without a confirmed native dialog; tests with a declining UI port prove it.
- Nothing is saved in the repository or in VS Code settings; a second project does not inherit a permission.
- Type check, lint, format check, unit tests, build and the VS Code integration tests pass, and the preview renders the view and the new cards under the CSP. (See Progress for what this means on a machine where some of them fail without the change.)
- The guides, limitations, `SECURITY.md` and the status table describe the behaviour as built, including what was not verified.

## Not in this change

- "Always allow" for edits outside the folder and for protected files.
- Folder switches for commands and MCP tools; "Always allow" for non-MCP tools.
- Permissions that apply to every project.
- Pattern rules for commands, and Bash rules beyond a plain literal command.
- Site wildcards, and typing a site into the view.
- Telling the model which outside folders are allowed.
