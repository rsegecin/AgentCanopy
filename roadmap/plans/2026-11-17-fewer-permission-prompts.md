# Fewer permission prompts: install Phase 12, read-only commands, Claude's memory

Phase 13 in `docs/planning/2026-11-10-implementation-plan.md`. Plan version 1, written on 2026-11-17. **Not approved yet.**

## Context

When you execute a plan in AgentCanopy, almost every terminal command asks for permission. I checked the conversation logs in VS Code's workspace storage since Nov 16:

- The installed extension (`~/.vscode/extensions/agentcanopy-local.agentcanopy-0.1.3`, built Nov 16 09:15) is **older than the Phase 12 commit** (12:41). Its `dist` has none of Phase 12's strings. So approving a plan never turned Auto on.
- **36 command prompts, all in "Execute plan version N" turns without Auto.** About a third of them only look at things: `grep … | head`, `sed -n 432,500p f`, `cat f; git check-ignore -v f`, `git status --short && git branch --show-current && git log --oneline -1`, `git branch -vv | head && git reflog -8`, `git show <rev> --format=… -- paths`. Claude Code runs these without asking, because it auto-allows read-only commands. AgentCanopy asks for every one: it puts `Bash` in the CLI's `ask` list ([invocation.ts](src/core/provider/claude/process/invocation.ts)), and [policy.ts](src/core/policy/agent/policy.ts) `decideCommand` asks unless a rule for that exact command is saved or Auto is on.
- **Two read prompts** for `~/.claude/projects/<slug>/memory/*.md`, Claude Code's own auto-memory for this folder. `~/.claude` is a credential location ([sensitive.ts](src/core/policy/grants/sensitive.ts)), so these always ask, even with Auto on.

What changes:

1. Install the current build. Plan execution then runs with Auto, as Phase 12 intended.
2. Without Auto, read-only commands that stay inside the folder run without asking, like in Claude Code.
3. Reads of this folder's Claude memory directory run without asking.

## Step 0: Install the current build (primary model, first)

- Bump `package.json` to `0.1.4` (primary model only). The installed version then shows which build is in.
- `npm run package`, then `code --install-extension <vsix> --force`. Check that `~/.vscode/extensions/agentcanopy-local.agentcanopy-0.1.4/dist/extension.js` contains "Approve and Execute with Auto".
- Ask the user to reload the window. Approving a plan then shows the "…with Auto" dialog.
- Leave the working-tree change to `package-lock.json` alone. It is the user's and is not committed.
- Repeat this step after Steps 1–3 so that the final build is the one installed.

## Step 1: Claude's memory directory is readable without asking

In [decide.ts](src/core/policy/readonly/decide.ts), `decideRead` is shared by Ask, Plan and Agent:

- New helper (same folder, e.g. `claude-memory.ts`): `claudeMemoryDirs(configDir, folderPaths)` returns `<configDir>/projects/<slug>/memory` for each of the folder's path and its real path. `<slug>` is the path with every non-`[A-Za-z0-9]` character replaced by `-`, which matches `/Users/rinaldi/Documents/Sources/pixlox_app3` → `-Users-rinaldi-Documents-Sources-pixlox-app3` in the logs. `configDir` is `process.env.CLAUDE_CONFIG_DIR` or `<real home>/.claude`. A slug over 200 characters is skipped, because Claude Code hashes those, so such a read still asks.
- In `decideRead`, when there are outside targets: if every target's resolved real path (`target.check.real`; for a pattern target, also require that `coverablePath`'s pattern checks pass, but not its sensitive refusal) is inside one of those directories, compared lexically (`isInside`), allow with `approval: 'policy'`. A symlink inside the memory directory that points elsewhere resolves outside it and still asks.
- Edits to the memory directory still ask (no change to `decideEdit`).
- Tests in `decide.test.ts`: the memory file is allowed; the same file under another project's slug asks; a symlink from the memory directory to `~/.claude/.credentials.json` asks; a glob pattern with `..` asks.

## Step 2: Read-only commands run without asking (Agent mode, Bash only)

### New module `src/core/policy/agent/readonly-command.ts` (core, no new dependency)

`isReadOnlyCommand(command: string, folderPath: string): Promise<boolean>`. Anything it does not fully understand returns `false`, and the command asks as it does today.

**Tokenizer: a strict subset of the shell**
- Words: unquoted characters from `[A-Za-z0-9_./:=@%+,^-]`. `'single quotes'` hold any content except a newline. `"double quotes"` hold any content without `$`, a backtick or a newline. Inside double quotes `\"`, `\\` and `` \` `` unescape and any other `\x` stays literal, so `"a\|b"` is accepted.
- Separators: `|`, `&&`, `||`, `;`.
- Redirections allowed: `2>&1`, `>&2`, and `>`, `1>`, `2>`, `&>` only when the target is exactly `/dev/null` (with or without a space).
- Rejected: `$` and backticks outside single quotes, a lone `&`, `<`, any other `>`, `(`, `)`, `{`, `}`, `#` at the start of a word, a newline, a backslash outside quotes, a leading `NAME=value`, and `~`.
- Unquoted `*`, `?`, `[`, `]` are rejected, except in the value part of a `--name=value` word (`--include=*.ts`).

**Each simple command**: the first word must be on the list below and the rest of its words must pass that command's checks. To share code, refactor `INERT_COMMANDS`, `hasDangerousOption` and `gitRunsProjectCode` in [commands.ts](src/core/policy/agent/commands.ts) into a words-based core. The stricter checks belong to this module only, so the "runs project code" label on Always allow keeps working as it does.

| Command | Extra conditions |
| :- | :- |
| `ls pwd echo printf which whoami uname basename dirname realpath cat head tail wc nl stat df cut tr diff cmp jq` | none |
| `date` | no `-s` or `--set` |
| `file` | no `-C` or `--compile` |
| `du` | no `-L` in an option cluster |
| `tree` | existing `-o`/`--output` check, and no `-l` in a cluster |
| `sort` | existing `-o`, `--output` and `--compress-program` checks |
| `uniq` | at most one operand (a second operand is an output file) |
| `grep egrep fgrep` | no `-R` or `--dereference-recursive` |
| `rg` | existing `--pre`/`--hostname-bin` check; no `-L` or `--follow` |
| `find` | existing action check; no `-L`, `-follow` or `-fprint*` |
| `sed` | options only from `-n`, `-E`, `-r` and `--quiet`, and one script that matches `^(\d+\|\$)(,(\d+\|\$))?p$`; any operands are file paths |
| `git` | see below |

**git**
- Optional leading `--no-pager`. `-C`, `-c`, `--git-dir`, `--work-tree` and `--exec-path` are rejected.
- Subcommands: `status diff log show rev-parse ls-files ls-tree blame describe shortlog rev-list cat-file check-ignore`.
- `reflog` only with no operand or with `show`.
- `branch` and `tag` only with options from a fixed listing set (`-a -r -v -vv -l --list --all --remotes --verbose --show-current --contains --merged --no-merged --sort=* --format=* --points-at`), and operands only when `-l` or `--list` is present.
- `remote` only with `-v` or `--verbose`.
- `grep` without `-O` or `--open-files-in-pager`.
- Anywhere: reject `-c*`, `--output*`, `--ext-diff` and `--upload-pack*`. Keep the existing `-c` rule as it is (`git log -c` will ask; that is acceptable).

**Path check (every word after the command name, and the value after `=` in an option)**
- Reject when the word or value starts with `/` (except exactly `/dev/null`), when an option cluster carries an absolute path (`-f/etc/x`), or when it has a `..` segment (`(^|[/=])\.\.(/|$)`).
- For each remaining word, resolve it relative to the folder root. If it exists (`lstat`), its real path (reuse `checkPath` from `readonly/targets.ts`) must be inside the folder. Otherwise reject.
- This is sound only when every Bash call starts at the folder root, so add `env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR = '1'` to the Agent-mode child environment in [launch.ts](src/core/provider/claude/process/launch.ts) (`buildChildEnv`; add an `agent` flag or apply it to every mode). The variable exists in the installed CLI 2.1.326 (found in the binary). `cd` and `pushd` are not on the list, so the start directory never changes within a chain.

### Wiring in `decideCommand` ([policy.ts](src/core/policy/agent/policy.ts))
After the `dangerouslyDisableSandbox` branch: if `request.toolName === 'Bash'`, `alwaysAskCommands` is off and `await isReadOnlyCommand(command, context.folder.path)`, return `{ response: { behavior: 'allow' }, approval: 'policy' }`, labelled "Allowed by AgentCanopy". The existing synchronous rule, PowerShell and Auto checks follow unchanged, with no await before them. PowerShell is not changed.

### Tests (`readonly-command.test.ts` and `policy.test.ts`)
- Allowed, taken from the logs: `grep -n "a\|b" src/x.ts`, `sed -n 432,500p src/x.ts`, `git status --short && git branch --show-current && git log --oneline -1`, `git branch -vv | head -20 && git reflog -8 --date=iso`, `grep -rn "x" src --include=*.ts 2>/dev/null | head`, `git show abc123 --format='%h %ad' -- lib/a.dart`, `cat jest.config.js; git check-ignore -v src/a.ts`.
- Asked: `ls ~/x`, `cat /etc/passwd`, `cat ../x`, `cat link-to-outside`, `cat docs/linkdir/f`, `npx tsc`, `sed -i …`, `sed 'e ls'`, `uniq a b`, `sort -o f`, `find . -exec`, `grep -R x .`, `git branch --set-upstream-to=x`, `git -c core.pager=x log`, `git diff --output=f`, `echo $(id)`, `` echo `id` ``, `cat x > y`, `cat < x`, `a & b`, `for f in a; do cat $f; done`, `cd /tmp && ls`, `X=1 ls`, `cat *`, multi-line commands.
- Policy: allowed with `approval: 'policy'`; with `alwaysAskCommands` on it asks; `dangerouslyDisableSandbox` still asks; a saved rule still wins with "user".
- `launch.test.ts`: the new environment variable is set.

## Step 3: Text, docs and status (primary model reviews)
- [docs/guide/agent-mode.md](docs/guide/agent-mode.md): under "What happens without asking", add read-only commands inside the folder, with the rules in short. Under "What asks", fix "Terminal commands, including harmless ones such as `ls`". Mention reads of Claude's memory directory. Update the Auto table where it applies.
- [SECURITY.md](SECURITY.md) and `docs/limitations.md`: what the read-only check covers. A read-only command can still read any file inside the folder (as the Read tool can), configuration-driven git helpers (`core.fsmonitor`, textconv) are trusted as in Claude Code, and a concurrent approved command can race the symlink check.
- The Permissions tab's "Always asks" text and the system-prompt text, if they say every command asks (grep `harmless`, `every command`, `Terminal commands`).
- Add Phase 13 to the status table in [docs/planning/2026-11-10-implementation-plan.md](docs/planning/2026-11-10-implementation-plan.md) and to CLAUDE.md's plan list.

## Delegation
- Step 0 and the `package.json` bump: primary model.
- Steps 1 and 2: `implementation` subagent with this design. The primary model reviews the tokenizer and path check line by line, since this is the security-sensitive part.
- Step 3: `implementation` drafts, primary model reviews.
- Commits on `develop`: 13.1 (memory reads), 13.2 (read-only commands and env), 13.3 (docs and status).

## Verification
- `npm run typecheck && npm run lint && npm run format:check && npm test` all pass.
- `caffeinate -s -i npm run test:integration`.
- Real use after the install (the user's, not `test:live`):
  - In a test folder, Plan → Approve: the dialog reads "Approve and Execute with Auto", the execution message has the "Auto" mark, and commands show "Auto-approved".
  - In a new conversation with Auto off, Agent mode: `git status && git log --oneline -3` runs with "Allowed by AgentCanopy"; `npm test` asks; `cat ../something` asks.
  - A memory read under `~/.claude/projects/<slug>/memory` runs without a prompt.
- Re-run `/private/tmp/claude-501/-Users-rinaldi-Documents-Sources-AgentCanopy/936bd4fb-f3b3-4758-b0f1-853de2fb339b/scratchpad/prompts.py` after a real plan execution to count the prompts left.
