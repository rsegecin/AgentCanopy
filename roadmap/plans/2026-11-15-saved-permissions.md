# Saved permissions, per-folder switches and a Permissions view

## Context

AgentCanopy's own policy in the extension host decides every edit, command, read and web call: the CLI runs with `--permission-mode default`, and the turn's settings file names those tools under `permissions.ask`, so each call reaches the loopback permission tool and then `TurnPolicy.decide` (`src/core/provider/claude/process/invocation.ts`, `src/core/policy/`).

Today only two things can be saved: an exact plain Bash command and an MCP tool, per workspace folder (`src/core/policy/agent/rules.ts`). A read outside the folder, a web fetch, a web search and every PowerShell command ask each time, and nothing lists or removes what was saved: `RuleStore.remove` has no caller. The Auto roadmap left that out by name ("A list or remove screen for always-allow rules").

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
- `createSavedPermissions({ rules, grants })` lists both stores as display entries with an opaque id, removes by id, and tells whether what a card offered was saved.

### Policy

Both policy factories get `grants` and `sensitiveRoots`. The store is read at every request, after the last await before an approval returns. Without a grant store every decision is today's.

- **Reads** (`decideRead`, all modes). An outside target is covered when its real path is known, is not sensitive, and the switch is on or it lies in a saved directory. All covered: allow. Otherwise the prompt; "Always allow" is offered when one directory covers every outside target and may be granted (the target when it is a directory, else its parent).
- **Sensitive and too broad** (`grants/sensitive.ts`). Sensitive: `.ssh`, `.aws`, `.azure`, `.gnupg`, `.kube`, `.docker`, `.config`, `.claude`, `.claude.json`, `.npmrc`, `.netrc`, `.git-credentials`, `.pypirc` under the home directory, `AppData` on Windows, `Library` on macOS, and the extension's storage directories. Not grantable: a filesystem or drive root, the home directory, its ancestors, anything sensitive.
- **Web.** A site is the lower-case `host` of an `http` or `https` address without user name or password; the match is exact. Order: the `askWebTools` gate in Ask and Plan, the switch or a saved site, Auto, the prompt. A search card has no "always".
- **PowerShell.** A command of letters, digits, space and `_ . / \ : -`, at most 300 characters, can be saved; the match is exact text. Order as for Bash: the sandbox-escape check, the saved command unless `alwaysAskCommands`, Auto, the prompt.

### Adding and removing

The webview is untrusted. It can take permissions away without a dialog; it cannot add one.

- **From a card**: "Always allow" opens the native "Always allow this?" dialog, which names the directory, site or command and the workspace folder. Declined, the call is allowed once.
- **A switch turned on, a folder added in the view**: refused in an untrusted workspace or without a folder; then a native dialog; then the same checks again; then the save.
- **Remove, and a switch turned off**: at once, no dialog, also during a turn. The next request asks.

What the dialogs must say:

| Dialog | Content |
| :- | :- |
| Switch: reads outside | The folder's path. The agent reads and searches anywhere on this machine without asking, in every mode; what it reads is sent to the model. Credential locations and AgentCanopy's storage still ask; edits outside still ask |
| Switch: web fetch | The folder's path. Any address is fetched without asking. A page can carry instructions for the agent and an address can carry file contents out. In Ask and Plan only while `agentCanopy.ask.webTools` is on |
| Switch: web search | The folder's path. Every search runs without asking; the query leaves the machine |
| Always allow: directory | The directory and the workspace folder. Reads and searches in it and below no longer ask, in every mode |
| Always allow: site | The host and the workspace folder. Any address on that site is fetched without asking and can carry file contents to it. A redirect to another site is reported to the agent, and its next request is judged on its own |
| Always allow: PowerShell | The command, and that it runs code from the project when it may |

### Permissions view

A tab in the AgentCanopy view, for the folder the view shows, reachable from the overflow menu and from **AgentCanopy: Show Permissions**. The tab button is in the tab list while the folder has something saved or a switch on, or while the tab is selected.

1. **Allowed without asking in this folder**: the three switches.
2. **Saved permissions**: folders, web sites, commands, tools; each with **Remove**. **Allow a folder...** opens the native folder picker.
3. **Always asks**: edits outside the folder, protected files, other tools, with the reason.
4. **Settings for every project**: the machine-wide settings that shape permissions, read-only, and **Open Settings**.

### Contracts

- `src/shared/permissions.ts`: the switch names and the saved-permission entry.
- `PermissionPrompt.alwaysRule.kind` (optional): `command`, `tool`, `read-directory`, `web-site`. Absent means a command or tool rule, so stored prompts still load.
- `ViewState.permissions` (per view) and `ViewState.policySettings` (global).
- Messages `permissions.remove`, `permissions.setSwitch`, `permissions.addDirectory`, `settings.open`; `show-tab` accepts `permissions`. None names a folder.
- `UiPort.pickDirectory`, `UiPort.openSettings`, `AppController.showPermissions`. Command `agentcanopy.showPermissions`. No new setting, no new dependency.

### What does not change

The CLI invocation and the execution profile, the rule file format, Auto and its reset, the tracker, review and checkpoints, the read-only guard and tripwire, the protected-path list, and the text sent to the model about the mode.

## Phases

One or more green commits per phase on `develop`. The primary model edits `package.json`, `src/shared/` and `src/core/contracts/`, briefs `implementation` for the rest, and reviews every change.

| Phase | Primary model | `implementation` subagent |
| :- | :- | :- |
| 0. Decisions | The Phase 11 row and paragraph in `docs/planning/2026-11-10-implementation-plan.md`; this file; the WebFetch redirect and PowerShell input facts in `docs/protocol/claude-cli.md`, section 13 | None |
| 1. Contracts | `shared/permissions.ts`, `prompts.ts`, `view-state.ts`, `protocol.ts`, `contracts/app.ts`, the command in `package.json`, schema tests | `vscode/host/ui.ts` and `activate.ts`, placeholder handlers and `policySettings` in the controller, the fake UI port, manifest and activation tests |
| 2. Store and policy | Review | `policy/grants/`, the PowerShell helpers, `decideRead`, both `decideWeb`, `decideCommand`, and their tests |
| 3. Host | Review against the trust model | Store wiring, handlers and dialogs, view state, the always-allow report from the turn, confirmation texts, session tests |
| 4. Webview | Review, reading the preview screenshots | The Permissions view, the tab and menu item, card wording, styles, fixtures, preview data, tests |
| 5. Docs and verification | Review every sentence against the code | The guides, limitations, `SECURITY.md`, troubleshooting, architecture, README, the status table |

## Verification

- Every phase: `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`.
- Policy tests, on real temporary directories: with nothing saved every decision is today's; a saved directory covers a file below it and not a sibling, nor a path reached through a symlink that leaves it; a sensitive path asks with the switch on; a site matches the exact host and port only; Ask denies web tools while `askWebTools` is off whatever is saved; a plain PowerShell command can be saved and `alwaysAskCommands` ignores it; edits outside the folder and protected files still offer only once and deny.
- Session tests, with a UI port that declines: `permissions.setSwitch` on and `permissions.addDirectory` leave the store empty; a switch turned off during a turn makes the next outside read of that turn ask; removal picks the right store.
- Phase 4: `npm run build && node scripts/preview-webview.mjs --check`, and the screenshots are read.
- Phase 5: `npm run build`, `npm run test:integration`, and by hand in the Extension Development Host on Windows: save a sibling folder from an Ask-mode card, read a second file there, remove it, read again; the reads switch on and off; a file under `~/.ssh` with the switch on; a plain PowerShell command saved in Agent mode; an edit outside the folder and one to `.vscode/settings.json`; a second project.
- `npm run test:live` gets one case (an outside read with a saved directory), written and run only when asked.

## Not in this change

- "Always allow" for edits outside the folder and for protected files.
- Folder switches for commands and MCP tools; "Always allow" for non-MCP tools.
- Permissions that apply to every project.
- Pattern rules for commands, and Bash rules beyond a plain literal command.
- Site wildcards, and typing a site into the view.
- Telling the model which outside folders are allowed.
