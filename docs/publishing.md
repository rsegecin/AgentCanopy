# Publishing to the VS Code Marketplace

This page is for the maintainer who publishes AgentCanopy. AgentCanopy is not on the Marketplace yet; today it is installed from a VSIX built from source. Nothing here has been run against the Marketplace, so check each step against Microsoft's current documentation.

## Build a VSIX

```sh
npm ci
npm run package
```

`npm run package` runs `scripts/package.mjs`: a production build (`node esbuild.mjs --production`), then `scripts/third-party-licenses.mjs`, which writes `dist/THIRD_PARTY_LICENSES.txt` with the license text of every bundled package, then `vsce package --no-dependencies`. The result is `agentcanopy-<version>.vsix` in the repository root. Everything the extension needs is bundled into `dist/`, which is why `node_modules` is not packaged.

What goes into the VSIX is decided by `.vscodeignore`, which excludes everything and then adds back `dist/**/*.js`, `dist/**/*.css`, `dist/**/*.ttf`, `dist/THIRD_PARTY_LICENSES.txt`, `media/**`, `package.json`, `README.md`, `CHANGELOG.md`, `LICENSE`, `THIRD_PARTY_NOTICES.md` and `SECURITY.md`. List the files with `npx vsce ls --no-dependencies`.

## Choose a publisher id

The `publisher` in `package.json` is a placeholder, `agentcanopy-local`. The Marketplace needs a publisher you own. Create one in the Marketplace's publisher management page, then build with:

```sh
AGENTCANOPY_PUBLISHER=<your-publisher-id> npm run package
```

`scripts/package.mjs` writes the id into `package.json` for the duration of the build and restores the file afterwards, so the repository keeps the placeholder. The extension's id on the Marketplace is `<publisher>.agentcanopy`.

## Add repository metadata

Add these to `package.json` before you publish. `vsce` complains about a missing repository and has `--allow-missing-repository` to accept it; do not rely on that.

```json
"repository": { "type": "git", "url": "https://github.com/<owner>/<repo>.git" },
"homepage": "https://github.com/<owner>/<repo>#readme",
"bugs": { "url": "https://github.com/<owner>/<repo>/issues" }
```

The Marketplace page is made from `README.md`, and `docs/` is not in the VSIX. `vsce` rewrites relative links in the README to the repository URL, so links such as `docs/guide/ask-mode.md` work only if the repository is public and contains those files. After the first publish, open the listing and click them.

## Publish

Do not build a release process around an Azure DevOps global personal access token. Those tokens are retired on December 1, 2026. Use one of these instead.

### GitHub Actions trusted publishing (OIDC)

`vsce publish --oidc` publishes from GitHub Actions without a stored token. Create a trusted publishing policy for the repository and workflow in the Marketplace, as Microsoft describes, then grant the workflow permission to request an OIDC token. A sketch:

```yaml
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npm run package
        env:
          AGENTCANOPY_PUBLISHER: <your-publisher-id>
      - run: npx @vscode/vsce publish --oidc --packagePath agentcanopy-*.vsix
```

`vsce` exchanges the GitHub token for a short-lived Marketplace token and does not fall back to a personal access token if that fails. The `vsce` documentation in `node_modules/@vscode/vsce/README.md` describes the exchange.

### Microsoft Entra ID

`npx @vscode/vsce publish --azure-credential --packagePath <file>.vsix` authenticates with Microsoft Entra ID. It needs credentials that Entra ID accepts for your publisher; see Microsoft's documentation for how to set them up.

The workflow above is a sketch of this project's setup, not a tested file. This repository's CI (`.github/workflows/ci.yml`) builds and uploads a VSIX but does not publish.

## Pre-publish checklist

- [ ] **The name is free.** Confirm that "AgentCanopy" is not taken on the Marketplace and is not someone's trademark. This project has not checked either.
- [ ] **Anthropic's terms.** Review Anthropic's current terms for products that run Claude Code. When the implementation plan was written (2026-11-10), Anthropic's legal page said that running Claude Code in a product requires agreeing to Anthropic's Commercial Terms of Service. Whether that applies to you as publisher is your decision; this project has not made it. Also check what the terms say today about subscription use through third-party tools, since Anthropic reserves the right to change billing and enforcement.
- [ ] **Names and logos.** The extension name, description, categories, icon, screenshots and listing text must not use another company's name as part of the product name or feature names, or any company logo. The README describes Claude Code in plain text and states that AgentCanopy is not affiliated with, endorsed by or sponsored by Anthropic or Cursor. Keep that.
- [ ] **Publisher and metadata.** Publisher id chosen, `repository`, `homepage` and `bugs` added, `version` set, and "Unreleased" in `CHANGELOG.md` renamed to the version and date.
- [ ] **Security contact works.** Private security advisories are enabled on the repository, as `SECURITY.md` says.
- [ ] **Full test suites pass.** `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`, `npm run build` and `npm run test:integration`, and `npm run test:live` against your own Claude Code account if you changed anything that talks to the CLI.
- [ ] **CI has run on all three systems.** The workflow in `.github/workflows/ci.yml` has not been run yet, so Windows and Linux are unverified. Consider publishing with `--pre-release` until it has.
- [ ] **Check the VSIX contents.** `npx vsce ls --no-dependencies` and `unzip -l <file>.vsix` show `dist/`, `media/`, `package.json`, the README, the changelog, the license, `THIRD_PARTY_NOTICES.md`, `SECURITY.md` and `dist/THIRD_PARTY_LICENSES.txt`, and no source, tests, `docs/`, `spike/`, source maps or `.vscode-test/`.
- [ ] **Update third-party notices.** `THIRD_PARTY_NOTICES.md` matches the bundled dependencies of this version, and `dist/THIRD_PARTY_LICENSES.txt` comes from the packaging run you are publishing. The ELK layout engine, whose license is EPL-2.0, is deliberately not shipped (`scripts/stubs/elk.mjs`); check that it is not in the VSIX.
- [ ] **Install check.** Install the VSIX into an empty profile, `code --extensions-dir <scratch> --user-data-dir <scratch> --install-extension <file>.vsix`, open a scratch folder and run one real turn in each mode.
- [ ] **Documentation matches.** The README, the guides and `docs/limitations.md` describe this version. Forking and checkpoints text in particular is correct for what ships.

## After publishing

Tag the commit that was published, install from the Marketplace in a clean profile and repeat a turn. The Marketplace page is generated from the README at the time of publishing, so a README fix needs a new version.
