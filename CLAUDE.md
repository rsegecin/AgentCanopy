# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

AgentCanopy is a VS Code extension that drives the locally installed Claude Code CLI (Ask, Plan and Agent modes, change review, checkpoints, forking).

- The plan in force, with a status table per phase: `docs/planning/2026-11-10-implementation-plan.md`.
- Plans for work after the first release are in `roadmap/plans/`. Built: `roadmap/plans/2026-11-13-chat-cards-and-concurrent-send.md` (Phase 9 in the status table, with what was decided along the way). Built: `roadmap/plans/2026-11-13-agent-auto-mode.md` (Phase 10; the status table's paragraphs record where it differs from the roadmap).
- The owner's specification: `docs/SPEC.md`. Evidence for CLI and VS Code facts: `docs/planning/2026-11-10-research-and-architecture.md`.
- Layers, enforced by ESLint: `src/shared` and `src/core` import neither `vscode` nor React; `src/webview` imports only `src/shared`; `src/vscode` adapts core to VS Code.
- `package.json`, the lockfile, `src/shared/`, `src/core/contracts/` and `src/vscode/extension.ts` are changed only by the primary model. Subagents report the dependency or contract change they need instead of editing them.

## Commands

| Command | Purpose |
| :- | :- |
| `npm run typecheck` | Type-check both TypeScript projects (Node side and webview) |
| `npm run lint` / `npm run format:check` | ESLint and Prettier |
| `npm test` | Unit tests (vitest). One file: `npx vitest run <path>` |
| `npm run build` | Bundle the extension and the webview into `dist/` |
| `npm run test:integration` | VS Code integration tests against the installed VS Code, in an isolated profile. Opens a second window briefly |
| `npm run test:live` | Opt-in tests against the real CLI. They use the owner's subscription; run only when asked |
| `npm run build && node scripts/preview-webview.mjs` | Serve the built webview with sample data in a browser, under the extension's CSP. Add `--check` to render it in headless Chrome and write screenshots |
| `npm run package` | Production build and VSIX (`AGENTCANOPY_PUBLISHER` overrides the publisher) |

Commits are local, on `develop`, one or more per phase. Nothing is pushed.

## Model delegation

Work in this project is split across models by task type. Two project-local subagents are defined in `.claude/agents/`:

| Subagent | Model | Use for |
| :- | :- | :- |
| `simple-tasks` | Haiku | Codebase exploration, file searches, reading files, simple analysis. Read-only: it must never modify files. |
| `implementation` | Sonnet | Routine coding, refactoring, and writing and running automated tests. |

The primary (session) model keeps architecture, complex decisions, task orchestration, and final code review. It does not hand those off.

Delegate to the matching subagent whenever practical, so the primary model is not spent on lookups or routine edits:

- Give `implementation` a decided design: the files, the behavior, and the checks that prove it works. If it reports an open design question, the primary model decides and re-briefs.
- Review every change `implementation` returns before treating it as done.
- Treat `simple-tasks` output as leads to confirm when a decision depends on it.

These subagents are project-scoped. Do not move them to `~/.claude/agents/` or change global Claude Code settings.
