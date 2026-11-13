# Third-party notices

AgentCanopy itself is licensed under the MIT License (see [LICENSE](LICENSE)). The extension bundles the libraries below into `dist/extension.js` and `dist/webview/`, which are what a VSIX ships. Versions are the ones installed in `node_modules/` when this file was written. Licenses are the `license` field of each package's own `package.json`.

The full license text of every bundled package is in `dist/THIRD_PARTY_LICENSES.txt`. `npm run package` generates it with `scripts/third-party-licenses.mjs`, which takes the list of packages from the bundler's own output, so it matches what ships. It is included in the VSIX together with this file and `SECURITY.md`. To regenerate it by hand, run `npm run build` and then `npm run licenses`. The tables below were produced from that file on 2026-11-12; regenerate them when a dependency changes. Development tools (TypeScript, esbuild, vitest, ESLint, Prettier, `vsce` and the test libraries) are not bundled and are not listed.

## Libraries used directly

| Package          | Version   | License                 | Used for                                                                 |
| :--------------- | :-------- | :---------------------- | :----------------------------------------------------------------------- |
| react            | 19.3.1    | MIT                     | Webview UI                                                               |
| react-dom        | 19.3.1    | MIT                     | Webview UI                                                               |
| zod              | 4.6.7     | MIT                     | Schemas for messages, events, plans and settings (extension and webview) |
| ignore           | 7.0.14    | MIT                     | Reading `.gitignore` rules                                               |
| diff             | 9.0.0     | BSD-3-Clause            | Line diffs for review hunks                                              |
| node-diff3       | 3.2.1     | MIT                     | Three-way merge when rejecting changes                                   |
| markdown-it      | 15.0.3    | MIT                     | Rendering Markdown                                                       |
| dompurify        | 3.4.17    | (MPL-2.0 OR Apache-2.0) | Sanitizing rendered HTML                                                 |
| highlight.js     | 11.12.0   | BSD-3-Clause            | Syntax highlighting                                                      |
| mermaid          | 12.3.0    | MIT                     | Diagrams                                                                 |
| @vscode/codicons | 0.0.46-24 | CC-BY-4.0               | Icon font (`codicon.ttf`) and its stylesheet                             |

The Codicons icon font and stylesheet are by Microsoft. The `@vscode/codicons` package states: "Microsoft and any contributors grant you a license to the Microsoft documentation and other content in this repository under the Creative Commons Attribution 4.0 International Public License ... and grant you a license to any code in the repository under the MIT License". The copyright line of its code license (`LICENSE-CODE`) is "Copyright (c) Microsoft Corporation." The package also says that its licenses do not grant any rights to use Microsoft names, logos or trademarks. AgentCanopy uses the icon font unchanged and claims no endorsement by Microsoft.

## Dependencies of the libraries above

| Package     | Version | License      | Required by |
| :---------- | :------ | :----------- | :---------- |
| scheduler   | 0.28.0  | MIT          | react-dom   |
| entities    | 8.1.0   | BSD-2-Clause | markdown-it |
| linkify-it  | 6.1.0   | MIT          | markdown-it |
| mdurl       | 2.1.0   | MIT          | markdown-it |
| punycode.js | 2.3.1   | MIT          | markdown-it |
| uc.micro    | 3.0.0   | MIT          | markdown-it |

## Mermaid and its dependencies

Mermaid is loaded on demand in the webview. The packages below were bundled with it. Some packages appear twice because a dependency carries its own older copy.

| Package                   | Version | License                                                                     |
| :------------------------ | :------ | :-------------------------------------------------------------------------- |
| @braintree/sanitize-url   | 7.1.2   | MIT                                                                         |
| @chevrotain/cst-dts-gen   | 13.2.0  | Apache-2.0                                                                  |
| @chevrotain/gast          | 13.2.0  | Apache-2.0                                                                  |
| @chevrotain/regexp-to-ast | 13.2.0  | Apache-2.0                                                                  |
| @chevrotain/utils         | 13.2.0  | Apache-2.0                                                                  |
| @iconify/utils            | 3.1.7   | MIT                                                                         |
| @mermaid-js/parser        | 2.0.1   | MIT                                                                         |
| @upsetjs/venn.js          | 2.0.0   | MIT                                                                         |
| chevrotain                | 13.2.0  | Apache-2.0                                                                  |
| cose-base                 | 1.0.3   | MIT                                                                         |
| cose-base                 | 2.2.0   | MIT                                                                         |
| cytoscape                 | 3.35.0  | MIT                                                                         |
| cytoscape-cose-bilkent    | 4.1.0   | MIT                                                                         |
| cytoscape-fcose           | 2.2.0   | MIT                                                                         |
| d3                        | 7.9.2   | ISC                                                                         |
| d3-array                  | 2.12.1  | BSD-3-Clause                                                                |
| d3-array                  | 3.2.5   | ISC                                                                         |
| d3-axis                   | 3.0.1   | ISC                                                                         |
| d3-brush                  | 3.0.1   | ISC                                                                         |
| d3-chord                  | 3.0.2   | ISC                                                                         |
| d3-color                  | 3.1.1   | ISC                                                                         |
| d3-contour                | 4.0.3   | ISC                                                                         |
| d3-delaunay               | 6.0.6   | ISC                                                                         |
| d3-dispatch               | 3.0.2   | ISC                                                                         |
| d3-drag                   | 3.0.1   | ISC                                                                         |
| d3-dsv                    | 3.0.2   | ISC                                                                         |
| d3-ease                   | 3.0.2   | BSD-3-Clause                                                                |
| d3-fetch                  | 3.0.2   | ISC                                                                         |
| d3-force                  | 3.0.1   | ISC                                                                         |
| d3-format                 | 3.1.3   | ISC                                                                         |
| d3-geo                    | 3.1.2   | ISC                                                                         |
| d3-hierarchy              | 3.1.3   | ISC                                                                         |
| d3-interpolate            | 3.0.2   | ISC                                                                         |
| d3-path                   | 1.0.9   | BSD-3-Clause                                                                |
| d3-path                   | 3.1.1   | ISC                                                                         |
| d3-polygon                | 3.0.2   | ISC                                                                         |
| d3-quadtree               | 3.0.2   | ISC                                                                         |
| d3-random                 | 3.0.2   | ISC                                                                         |
| d3-sankey                 | 0.12.3  | BSD-3-Clause                                                                |
| d3-scale                  | 4.0.3   | ISC                                                                         |
| d3-scale-chromatic        | 3.1.1   | ISC                                                                         |
| d3-selection              | 3.0.1   | ISC                                                                         |
| d3-shape                  | 1.3.7   | BSD-3-Clause                                                                |
| d3-shape                  | 3.2.1   | ISC                                                                         |
| d3-time                   | 3.1.1   | ISC                                                                         |
| d3-time-format            | 4.1.1   | ISC                                                                         |
| d3-timer                  | 3.0.2   | ISC                                                                         |
| d3-transition             | 3.0.2   | ISC                                                                         |
| d3-zoom                   | 3.0.1   | ISC                                                                         |
| dagre-d3-es               | 7.0.14  | MIT                                                                         |
| dayjs                     | 1.11.23 | MIT                                                                         |
| es-toolkit                | 1.53.2  | MIT                                                                         |
| internmap                 | 1.0.1   | ISC                                                                         |
| katex                     | 0.18.10 | MIT                                                                         |
| khroma                    | 2.1.0   | MIT (stated in its license file; its `package.json` has no `license` field) |
| layout-base               | 1.0.2   | MIT                                                                         |
| layout-base               | 2.0.1   | MIT                                                                         |
| lodash-es                 | 4.18.1  | MIT                                                                         |
| marked                    | 16.4.2  | MIT                                                                         |
| roughjs                   | 4.6.6   | MIT                                                                         |
| stylis                    | 4.4.0   | MIT                                                                         |
| ts-dedent                 | 2.3.0   | MIT                                                                         |

The ELK layout engine (`elkjs`, EPL-2.0 OR GPL-3.0-or-later) is a dependency of Mermaid but is not shipped. The build replaces it with a stub (`scripts/stubs/elk.mjs`), so Mermaid diagrams use the classic layout and a diagram that asks for ELK shows its source instead.

## Fonts and icons

The extension's own icon (`media/icon.png`) and sidebar icon (`media/sidebar.svg`) are generated by `scripts/make-icon.mjs` and are original to this project.
