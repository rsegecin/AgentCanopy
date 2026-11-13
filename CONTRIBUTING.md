# Contributing to AgentCanopy

AgentCanopy is a VS Code extension, written in TypeScript, that drives the Claude Code CLI. This page explains how to build, test and change it. For what the extension does and how it works inside, read [README.md](README.md) and [docs/architecture.md](docs/architecture.md) first. To report a security problem, follow [SECURITY.md](SECURITY.md) and do not open a public issue.

## Prerequisites

- Node.js 22.18 or newer (CI uses Node 22) and npm. The integration test configuration relies on Node's built-in type stripping.
- Git.
- VS Code 1.106 or newer, for the integration tests and for running the extension.
- Claude Code 2.1.295 or newer, only if you run the extension against the real CLI or the live tests. Everything else uses a fake CLI.

```sh
npm install
```

To try your changes, open the repository in VS Code and run the **Run Extension** launch configuration (F5). It builds first and opens an Extension Development Host. `npm run watch` rebuilds on change.

## Commands

| Command                                             | Purpose                                                                                                                    |
| :-------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                                 | Type-check the Node side and the webview                                                                                   |
| `npm run lint`                                      | ESLint, including the layering rules                                                                                       |
| `npm run format:check` / `npm run format`           | Prettier check / write. `docs/` is not formatted                                                                           |
| `npm test`                                          | Unit tests (vitest). One file: `npx vitest run <path>`. `npm run test:watch` watches                                       |
| `npm run build` / `npm run build:prod`              | Bundle the extension and the webview into `dist/`                                                                          |
| `npm run test:integration`                          | VS Code integration tests in an isolated profile, in two launches (`main`, then `restart`). Opens VS Code windows briefly  |
| `npm run test:live`                                 | Opt-in tests against the real CLI, with their own config (`vitest.live.config.mts`). They use your own Claude Code account |
| `npm run build && node scripts/preview-webview.mjs` | Serve the built webview with sample data in a browser. Add `--check` to render it in headless Chrome and write screenshots |
| `npm run package`                                   | Production build, then `dist/THIRD_PARTY_LICENSES.txt`, then a VSIX. `AGENTCANOPY_PUBLISHER` overrides the publisher       |
| `npm run licenses`                                  | Write `dist/THIRD_PARTY_LICENSES.txt` from the last build (run `npm run build` first)                                      |

Before you open a pull request, run `typecheck`, `lint`, `format:check`, `test` and `build`, which is what CI runs on Linux, macOS and Windows, and `test:integration` if you touched anything that talks to VS Code.

## Layers

| Path          | Rule                                                                                                                                                                    |
| :------------ | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared`  | Domain types and zod schemas shared by everything. Imports neither `vscode` nor React                                                                                   |
| `src/core`    | The application: provider, policy, workspace tracking, review, conversations, plans. Imports neither `vscode` nor React, and nothing from `src/vscode` or `src/webview` |
| `src/vscode`  | Adapts the core to VS Code: activation, views, commands, diffs, CodeLens. The only layer that imports `vscode`                                                          |
| `src/webview` | The React UI. Imports only `src/shared` and its own folder, no Node built-ins and no `vscode`                                                                           |

ESLint enforces these (`npm run lint` fails on a violation). They exist so that the code that decides what an agent may do and what gets restored can be tested as plain Node code with a fake CLI and fake ports, without a running editor. They also keep the webview a pure function of validated messages, which lets it run in a browser preview under the same Content Security Policy. Prefer a new port in `src/core/contracts` over reaching around a layer.

`src/shared`, `src/core/contracts`, `package.json` and `src/vscode/extension.ts` are the surfaces everything else depends on. Keep changes to them small and explain them in the pull request.

## Tests

- **Unit tests** sit next to the code as `*.test.ts` and `*.test.tsx`, and run with `npm test`. The provider tests run a **fake CLI** (`test/fake-cli`) as a real child process, driven by a JSON scenario, so process handling is tested for real: crashes, hangs, cancel, garbage output, authentication failure and permission round trips. Webview tests use jsdom and Testing Library. Fixtures in `test/fixtures/cli` are scrubbed recordings of the real CLI. Data-safety code (review and restore) also has property tests over random sequences of agent turns, edits and restores.
- **Integration tests** (`test/integration`) are bundled by `esbuild.mjs --tests` and run with `@vscode/test-cli` against an installed VS Code, in an isolated user-data and extensions directory under `.vscode-test/`, with the fake CLI standing in for Claude Code. On macOS the app is found in `/Applications`; set `AGENTCANOPY_VSCODE_PATH` to use another VS Code, or one is downloaded. They do not touch your own VS Code profile. `.vscode-test.mjs` defines two launches that share one profile and workspace folder: `main` runs every test in `test/integration` and, last, `test/integration/last`, which leaves a renamed conversation and a pending change behind; `restart` then starts VS Code again and checks, in `test/integration/restart`, that a new window finds them. Put a test that must survive a restart in those two folders.
- **Live tests** (`test/live`) call the real CLI with small prompts, the Haiku model and a scratch folder. They have their own config, `vitest.live.config.mts`, and run only through `npm run test:live`; `npm test` never runs them. They use your own Claude Code usage, so run them deliberately.
- **Browser preview** (`scripts/preview-webview.mjs`) shows the built webview with sample state, for looking at the UI and checking that Markdown, code, Mermaid and cards render under the real CSP.
- **Protocol spike** (`spike/`) records real CLI runs and is how the facts in `docs/protocol/claude-cli.md` were established. `node spike/run.mjs <id>` makes real model calls.

Each edge case in a spec gets a named test in the package that owns the behavior. **A test may not be weakened, skipped or deleted to make it pass.** If a test looks wrong, say so in the pull request and explain why. A change that makes a failing test pass by making it check less will not be accepted.

## Style

- For webview changes, go through `src/webview/ACCESSIBILITY.md`, the checklist for keyboard use, names and roles, announcements, themes and motion. `app/accessibility.test.tsx` and `app/styles.test.ts` check part of it automatically.
- Prettier and ESLint decide formatting and most style (`.prettierrc.json`, `eslint.config.mjs`, `.editorconfig`). Run `npm run format` before committing.
- Write user-facing text in plain language, with the sentences kept in one place (for example `src/core/session/text.ts`) so they are easy to review.
- Do not add a dependency without a reason that you can explain. Everything that ends up in the VSIX needs an entry in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); the license texts in the VSIX are generated from the bundler's output by `npm run package`.
- Documentation under `docs/` follows the same rule as the code: every statement must be true of the repository today.

## Commits

Development happens on `develop`. Commit messages use a type prefix, `feat:`, `fix:`, `docs:`, `test:`, `refactor:` or `chore:`, then a short imperative subject (about 70 characters). The body says what changed and why, in sentences. Keep a commit to one change, and include its tests.

## Names and logos

The name and logos of other companies must not be used in the product: not in the extension name, a command or setting name, the UI, an icon or the Marketplace listing. Refer to Claude Code and to other products in plain text, only to say what AgentCanopy works with, and keep the statement that AgentCanopy is not affiliated with, endorsed by or sponsored by them.
