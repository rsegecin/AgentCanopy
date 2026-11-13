> Owner's original specification for AgentCanopy, saved verbatim on 2026-11-10. It is written as a prompt to the implementing agent.

# AgentCanopy — Complete Implementation Prompt

You are a senior software architect and full-stack engineer specializing in TypeScript, VS Code extensions, AI coding agents, CLI integrations, and developer experience.

Your task is to **design, implement, test, document, and package AgentCanopy**, a free, open-source VS Code extension that provides an AI-assisted development experience as close as practical to Cursor.

**This must be a working extension, not a mockup, prototype-only UI, or architectural proposal.**

## 1. Product Vision

AgentCanopy provides a unified interface for AI coding agents inside standard Visual Studio Code.

The extension should reproduce the familiar Cursor workflow while remaining independent of Cursor's proprietary code, branding, and assets.

The core features are:

1. **Ask Mode** — read-only codebase exploration.
2. **Plan Mode** — interactive, visual, persistent planning.
3. **Agent Mode** — autonomous implementation with controlled permissions.
4. **Conversation Forking** — branch conversations from earlier messages.
5. **Review Changes** — inspect, accept, or reject agent modifications without Git staging.
6. **Checkpoints** — safely restore previous workspace states.
7. **Conversation History** — persistent conversations and sessions.
8. **Provider Architecture** — initially Claude Code, with future support for Codex, Gemini CLI, and other agents.

Prioritize a polished, intuitive developer experience.

## 2. Technical Stack

Use:

- TypeScript with strict type checking.
- VS Code Extension API.
- VS Code Webview API.
- React for the interface, unless a lighter framework is clearly preferable.
- Mermaid for architecture and flow diagrams.
- VS Code's native diff editor.
- A modular agent-provider abstraction.
- Vitest or an equivalent testing framework.
- ESLint and Prettier.
- `@vscode/vsce` for VSIX packaging.

Use the current stable VS Code Extension API and verify relevant Claude Code CLI capabilities against installed CLI help and official documentation before implementing integrations.

Avoid unnecessary dependencies.

## 3. Architecture

Separate the implementation into clearly defined modules:

- Extension host and lifecycle.
- Webview UI.
- Provider interface and provider registry.
- Claude Code CLI adapter.
- Conversation and session manager.
- Conversation branching manager.
- Planning engine and persistent plan storage.
- Workspace change tracking.
- Snapshot and checkpoint manager.
- Diff review engine.
- Permissions and execution policy.
- Configuration and settings.
- Logging and diagnostics.

Define a provider interface that can support capabilities such as:

- Starting conversations.
- Resuming sessions.
- Streaming responses.
- Selecting models.
- Managing tool permissions.
- Cancelling execution.
- Receiving tool execution events.
- Accessing session history.
- Forking sessions when supported.
- Handling interactive questions.
- Reporting token usage when available.

Providers may expose different capabilities. Use capability detection instead of assuming every agent implements the same features.

Implement only the Claude Code provider initially.

## 4. Claude Code Integration

Integrate with the locally installed Claude Code CLI.

Requirements:

- Detect whether Claude Code is installed.
- Detect its version and supported capabilities.
- Use existing Claude Code authentication where supported.
- Do not request or store the user's Claude password.
- Do not extract authentication tokens.
- Do not bypass subscription limits or authentication restrictions.
- Verify compatibility with Claude Pro authentication and Anthropic's applicable terms.
- Support persistent sessions.
- Stream responses and execution events.
- Support model selection where available.
- Support cancellation and interruption.
- Handle CLI failures and authentication expiration gracefully.

Prefer supported structured CLI output, such as JSON or streaming JSON, where available.

Do not rely on parsing human-readable terminal output if a structured interface exists.

Avoid depending on undocumented CLI internals.

## 5. User Interface

Create a UI closely resembling Cursor's AI chat experience.

Include:

- Sidebar chat panel.
- Optional wider editor-area chat view.
- Conversation history.
- New conversation button.
- Agent/provider selector.
- Model selector.
- Ask / Plan / Agent mode selector.
- Message composer.
- File and folder references.
- Workspace context attachments.
- Streaming responses.
- Markdown rendering.
- Syntax-highlighted code blocks.
- Mermaid diagrams.
- Tool execution status.
- Collapsible execution details.
- Interactive questions.
- Conversation fork actions.
- Review Changes interface.
- Checkpoint history.

Use VS Code theme variables so the extension works naturally with light and dark themes.

Maintain responsive layouts and keyboard accessibility.

Do not copy Cursor's proprietary assets or source code.

## 6. Ask Mode

Ask Mode must allow the user to investigate a codebase without modifying it.

Supported operations:

- Read source files.
- Search files and symbols.
- Inspect project structure.
- Explain code.
- Analyze architecture.
- Identify bugs.
- Suggest improvements.
- Answer technical questions.

**Ask Mode must never modify workspace files.**

Enforce this restriction at the execution and tool-permission layers, not merely through system prompts.

Do not automatically generate implementation plans unless requested.

For Claude Code, investigate the supported permission controls and tool restrictions.

Do not assume that disabling file-editing tools alone prevents shell commands or other tools from modifying files.

If the provider cannot enforce a sufficiently safe read-only environment, disable unsafe tools or explicitly report the limitation.

## 7. Plan Mode

Implement a visual, interactive planning experience similar to Cursor.

A plan is a persistent, structured document, not merely a chat message.

Each plan may contain:

- Title and objective.
- Requirements.
- Technical analysis.
- Architecture.
- Relevant files.
- Implementation stages.
- Dependencies.
- Mermaid diagrams.
- Alternatives and tradeoffs.
- Open questions.
- User decisions.
- Testing strategy.
- Acceptance criteria.

### Interactive planning

The user must be able to:

1. Generate an initial plan.
2. Ask questions about the plan without modifying it.
3. Switch temporarily to Ask Mode.
4. Return to Plan Mode with the plan intact.
5. Request changes to the existing plan.
6. Compare plan revisions.
7. Answer interactive questions.
8. Choose among suggested technical alternatives.
9. Explicitly approve and execute the plan.

Maintain version history for plans.

Separate the plan's persisted state from the conversation's message history.

### Visual presentation

Use Mermaid diagrams when they meaningfully improve understanding.

Support architecture diagrams, flowcharts, sequence diagrams, and dependency diagrams.

Do not generate diagrams merely for decoration.

### Execution rules

**A plan must never execute automatically because the user asked a question or requested a revision.**

Execution requires an explicit user action.

The approved plan version must be recorded before execution begins.

## 8. Agent Mode

Agent Mode allows Claude Code to implement changes in the workspace.

Requirements:

- Execute coding tasks.
- Create, modify, and delete files.
- Run approved commands.
- Show streaming progress.
- Display tool execution details.
- Allow interruption.
- Report errors.
- Track modified files.
- Generate a reviewable change set.

Expose clear permission settings.

Distinguish between:

- Read-only operations.
- Workspace modifications.
- Terminal commands.
- External or potentially destructive operations.

Never silently enable unrestricted command execution.

Respect provider-specific permission capabilities.

## 9. Conversation Forking

Implement conversation branching similar to Cursor.

The user must be able to select a previous message and choose:

**Fork from here**

Expected behavior:

- Create a new conversation branch.
- Preserve the conversation context up to the selected point.
- Exclude subsequent messages from the new branch.
- Keep the original conversation unchanged.
- Allow independent continuation of both branches.
- Display the relationship between branches.
- Persist branches across VS Code restarts.

Investigate Claude Code's supported session-forking capabilities.

Important: forking an entire session is not necessarily equivalent to forking at an arbitrary message.

If the CLI does not support arbitrary-message forking, implement a safe context-reconstruction strategy where possible.

Document limitations involving hidden tool state, summaries, file changes, and token usage.

Do not claim an exact fork if the reconstructed context differs materially from the original.

## 10. Review Changes

This is a critical feature.

Reproduce Cursor's ability to review changes made by an agent and accept or reject them.

**Do not use Git staging as the underlying acceptance mechanism.**

The review system must operate independently of Git and must also work in folders that are not Git repositories.

### Workflow

Before execution:

- Capture the relevant initial workspace state.
- Record pre-existing modifications.
- Establish a transaction/checkpoint boundary.

During execution:

- Track files created, modified, renamed, or deleted.
- Record changes attributable to the agent.
- Detect external or concurrent modifications.

After execution:

- Display a change summary.
- Show diffs using VS Code's native diff editor.
- Allow Accept All.
- Allow Reject All.
- Allow accepting or rejecting individual files.
- Support hunk-level review where technically safe.
- Clearly distinguish pending and accepted changes.

### Safety requirements

Preserve user modifications that existed before the agent started.

Never blindly restore an entire workspace.

Use file hashes, snapshot metadata, and conflict detection.

If the user modifies a file while the agent is working, do not overwrite those changes silently.

Support binary files and renames conservatively.

Do not treat filesystem rollback as equivalent to reversing external side effects such as database writes, remote API calls, or deployments.

When a rollback cannot be completed safely, explain exactly what remains unresolved.

## 11. Checkpoints

Implement a checkpoint system independent of Git.

A checkpoint should capture the workspace state relevant to an agent execution.

Requirements:

- Create checkpoints before agent modifications.
- Persist checkpoint metadata.
- Restore safely when possible.
- Detect conflicts.
- Avoid overwriting unrelated user work.
- Support multiple checkpoints.
- Display checkpoint history.
- Allow rollback previews.

Design checkpoint restoration carefully when later changes depend on earlier ones.

Do not promise arbitrary historical rollback without conflict handling.

Consider storage limits, large files, ignored directories, symlinks, and sensitive files.

Use a storage strategy that avoids duplicating large workspaces unnecessarily.

## 12. Conversation History and Context

Persist conversation metadata and supported session references.

Requirements:

- List previous conversations.
- Rename conversations.
- Resume conversations.
- Delete conversations.
- Search conversation history.
- Display conversation branches.
- Associate plans and checkpoints with conversations.

Use VS Code storage facilities where appropriate.

Store larger structured artifacts separately when necessary.

Do not store credentials or secrets in conversation metadata.

Provide an understandable indication of context usage when reliable usage information is available.

## 13. Interactive Questions

Support structured questions from agents.

Examples:

- Choose a database.
- Select an architectural approach.
- Confirm an implementation decision.
- Clarify requirements.
- Choose between alternatives.

Display choices as accessible UI controls.

Allow free-text responses when appropriate.

Maintain the pending question state when the user navigates away.

Do not fabricate provider support for interactive tools. Adapt the provider's actual capabilities.

## 14. Security and Reliability

Treat workspace content, model output, and tool output as untrusted.

Requirements:

- Secure Webview Content Security Policy.
- Strict validation of messages between Webview and extension host.
- Safe Markdown rendering.
- Protection against command injection.
- Workspace Trust integration.
- Controlled process spawning.
- Safe filesystem path handling.
- No credential logging.
- Clear handling of untrusted workspaces.
- No unrestricted command execution by default.
- No silent destructive operations.

Use VS Code SecretStorage only when storing secrets is genuinely necessary.

Avoid telemetry by default. Any future telemetry must be opt-in and documented.

## 15. Testing

Create automated tests for:

- Provider abstraction.
- Claude CLI process management.
- Streaming response parsing.
- Session persistence.
- Conversation forking.
- Plan persistence and revisions.
- Ask Mode restrictions.
- Change detection.
- Accept/reject behavior.
- Snapshot restoration.
- Conflict detection.
- Cancellation.
- Error handling.

Include VS Code extension integration tests.

Test important edge cases, including:

- Unsaved editor buffers.
- Pre-existing Git modifications.
- Concurrent file edits.
- New and deleted files.
- Renamed files.
- Binary files.
- Interrupted agent execution.
- CLI crashes.
- Large workspaces.
- VS Code restarts.

Do not report tests as passing unless they actually ran successfully.

## 16. Open-Source Distribution

Prepare AgentCanopy for public distribution.

Requirements:

- MIT license.
- README with installation and usage instructions.
- CONTRIBUTING.md.
- CHANGELOG.md.
- Appropriate `.gitignore` and `.vscodeignore`.
- Extension manifest.
- Build scripts.
- Test scripts.
- VSIX packaging.
- GitHub Actions CI workflow.
- Instructions for publishing to the VS Code Marketplace.

Use AgentCanopy as the working project name.

Keep the publisher identifier configurable.

Do not assume the name or trademark is legally available.

The extension must be free to use, although external agent providers may require their own subscriptions or usage allowances.

## 17. Development Strategy

Do not attempt to implement everything in a single uncontrolled pass.

First:

1. Inspect the repository and development environment.
2. Verify the installed Claude Code CLI and relevant capabilities.
3. Identify technical constraints.
4. Design the architecture.
5. Create an implementation roadmap.
6. Begin implementation.

Recommended phases:

**Phase 1 — Foundation**

- Extension scaffold.
- Webview UI.
- Provider abstraction.
- Claude Code integration.
- Basic conversation history.

**Phase 2 — Ask Mode**

- Read-only enforcement.
- File references.
- Streaming responses.
- Codebase exploration.

**Phase 3 — Plan Mode**

- Persistent plans.
- Visual diagrams.
- Interactive questions.
- Plan revisions.
- Ask/Plan switching.

**Phase 4 — Agent Mode**

- Controlled execution.
- Progress tracking.
- Workspace change detection.

**Phase 5 — Review Changes**

- Snapshots.
- Native diffs.
- Accept/reject controls.
- Conflict handling.

**Phase 6 — Conversation Forking and Checkpoints**

- Conversation branches.
- Session reconstruction where needed.
- Checkpoint persistence.
- Safe restoration.

**Phase 7 — Polish and Release**

- UX improvements.
- Tests.
- Documentation.
- Security review.
- VSIX packaging.

These phases are an implementation order, not permission to omit features.

## 18. Definition of Done

The project is complete only when:

- The extension builds successfully.
- A VSIX package can be generated.
- The extension installs in standard VS Code.
- Claude Code integration works with a supported authentication configuration.
- Ask Mode is reliably read-only.
- Plan Mode supports persistent, interactive planning.
- Agent Mode can execute approved coding tasks.
- Conversations can be forked with documented context guarantees.
- Agent changes can be reviewed and accepted/rejected independently of Git staging.
- Checkpoints support safe restoration with conflict handling.
- Conversation history persists.
- Automated tests pass.
- Documentation explains setup, limitations, and usage.

Do not substitute simulated behavior for functional integrations.

If a feature cannot be implemented safely or is unsupported by the provider, explain the limitation and implement the safest practical alternative.

## 19. Working Instructions

You are responsible for implementation, not just planning.

Follow these rules:

- Make reasonable engineering decisions autonomously.
- Ask questions only when a decision materially affects architecture, security, or user experience.
- Prefer maintainable, well-structured code.
- Avoid unnecessary abstraction and overengineering.
- Implement working vertical slices.
- Run builds and tests after meaningful changes.
- Fix failures before proceeding.
- Keep the repository in a consistent state.
- Document important decisions.
- Do not invent CLI flags or APIs.
- Do not claim unsupported functionality works.
- Do not stop after creating the initial scaffold.

**Start by examining the current repository, checking the development environment and Claude Code CLI capabilities, and creating the implementation plan. Then proceed with the implementation, validating each phase until the extension is ready for installation and testing.**

The final deliverable must include the complete source code, documentation, automated tests, and a generated `.vsix` file whenever the environment supports packaging.
