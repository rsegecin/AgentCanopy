import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initEvent } from '../../../test/fake-cli';
import { DEFAULT_SETTINGS } from '../../shared';
import type { AssistantMessage } from '../../shared';
import type { PolicyContext } from '../contracts';
import {
  FOLDER_KEY,
  assistantText,
  createHarness,
  createPlanTestPolicy,
  createTestPolicy,
  finishedTurn,
  resultStep,
  stateEvent,
  textScenario,
  until as untilQuickly,
  type Harness,
  type HarnessOptions,
  type ScenarioSpec,
  type TestView,
} from './test-support';

vi.setConfig({ testTimeout: 30_000 });
const until = (description: string, condition: () => boolean, timeoutMs = 20_000): Promise<void> =>
  untilQuickly(description, condition, timeoutMs);

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.dispose();
});

const text = (): ScenarioSpec => ({ record: true, scenario: textScenario('ok') });

const SETTINGS_WITH_HOOKS = JSON.stringify({
  hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo checked' }] }] },
});
const MCP_SERVER = JSON.stringify({
  mcpServers: { tools: { command: 'node', args: ['server.js'] } },
});

async function project(
  files: Record<string, string>,
  sequence: ScenarioSpec[],
  options: HarnessOptions = {},
): Promise<{ h: Harness; view: TestView }> {
  const own = options.policy !== undefined;
  const h = await createHarness({ realDefaults: !own, noStart: true, sequence, ...options });
  harnesses.push(h);
  h.env.settingsValue = { ...DEFAULT_SETTINGS, editApproval: 'auto' };
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(join(h.workspace, name, '..'), { recursive: true });
    await fs.writeFile(join(h.workspace, name), content);
  }
  await h.controller.start();
  if (!own) await until('the baseline', () => h.tracker()?.status(FOLDER_KEY).state === 'ready');
  return { h, view: h.attach() };
}

async function turn(h: Harness, view: TestView, mode: 'ask' | 'plan' | 'agent' = 'ask') {
  const active = view.state?.active;
  const before = active?.turns.length ?? 0;
  view.send({
    type: 'turn.send',
    ...(active ? { conversationId: active.meta.id } : {}),
    text: `a ${mode} turn`,
    mode,
    model: 'default',
  });
  await until('the turn to exist', () => (view.state?.active?.turns.length ?? 0) > before);
  await finishedTurn(h, view);
}

function choiceOf(h: Harness, index: number) {
  return h.requests[index]?.profile.projectConfig;
}

function noticesOf(view: TestView, which: number): string[] {
  const messages = view
    .active()
    .messages.filter((m): m is AssistantMessage => m.role === 'assistant');
  return (messages[which]?.parts ?? []).flatMap((part) =>
    part.kind === 'notice' ? [part.text] : [],
  );
}

const IGNORED_NOTICE =
  "The project's own Claude Code settings are ignored. Use the command “Ask Again About This Folder's Claude Code Project Settings” to change this.";

describe("asking about the project's Claude Code configuration", () => {
  it('does not ask when the project brings nothing that runs, and uses everything', async () => {
    const { h, view } = await project(
      { '.claude/settings.json': JSON.stringify({ permissions: { deny: ['Read(.env)'] } }) },
      [text(), text()],
    );
    await turn(h, view, 'ask');
    await turn(h, view, 'agent');
    expect(h.ui.callsOf('choose')).toEqual([]);
    expect(choiceOf(h, 0)).toEqual({ settings: 'use', mcp: 'use' });
    expect(choiceOf(h, 1)).toEqual({ settings: 'use', mcp: 'use' });
    expect(noticesOf(view, 0)).toEqual([]);
    view.expectMirror();
  });

  it('asks, with the folder and the items, and the CLAUDE.md sentence only when settings are at stake', async () => {
    const { h, view } = await project(
      { '.claude/settings.json': SETTINGS_WITH_HOOKS, 'CLAUDE.md': '# Rules\n' },
      [text()],
    );
    h.ui.chooseAnswers = ['use'];
    await turn(h, view);
    const asked = h.ui.callsOf('choose')[0]?.[0] as {
      title: string;
      detail: string;
      options: unknown;
    };
    expect(asked.title).toBe('This project configures Claude Code to run programs');
    expect(asked.options).toEqual([
      { id: 'ignore', label: 'Ignore Project Settings' },
      { id: 'use', label: 'Use Project Settings' },
    ]);
    expect(asked.detail.startsWith('work:\n')).toBe(true);
    expect(asked.detail).toContain('Hooks that run commands');
    expect(asked.detail).toContain('\n\nUse them only if you trust this repository.');
    expect(asked.detail).toContain(
      "\nIgnoring them also skips the project's CLAUDE.md instructions.",
    );

    // Only a tool server at stake: ignoring it does not skip CLAUDE.md, so the sentence is left out.
    const mcpOnly = await project({ '.mcp.json': MCP_SERVER, 'CLAUDE.md': '# Rules\n' }, [text()]);
    mcpOnly.h.ui.chooseAnswers = ['use'];
    await turn(mcpOnly.h, mcpOnly.view);
    expect((mcpOnly.h.ui.callsOf('choose')[0]?.[0] as { detail: string }).detail).not.toContain(
      'CLAUDE.md',
    );
    view.expectMirror();
  });

  it('puts each answer into the profile of the turn, with only the flags that matter', async () => {
    const settingsOnly = await project({ '.claude/settings.json': SETTINGS_WITH_HOOKS }, [
      text(),
      text(),
    ]);
    settingsOnly.h.ui.chooseAnswers = ['ignore'];
    await turn(settingsOnly.h, settingsOnly.view);
    expect(choiceOf(settingsOnly.h, 0)).toEqual({ settings: 'ignore', mcp: 'use' });

    const mcpOnly = await project({ '.mcp.json': MCP_SERVER }, [text()]);
    mcpOnly.h.ui.chooseAnswers = ['ignore'];
    await turn(mcpOnly.h, mcpOnly.view);
    expect(choiceOf(mcpOnly.h, 0)).toEqual({ settings: 'use', mcp: 'ignore' });

    const both = await project(
      { '.claude/settings.json': SETTINGS_WITH_HOOKS, '.mcp.json': MCP_SERVER },
      [text()],
    );
    both.h.ui.chooseAnswers = ['ignore'];
    await turn(both.h, both.view);
    expect(choiceOf(both.h, 0)).toEqual({ settings: 'ignore', mcp: 'ignore' });

    const used = await project(
      { '.claude/settings.json': SETTINGS_WITH_HOOKS, '.mcp.json': MCP_SERVER },
      [text()],
    );
    used.h.ui.chooseAnswers = ['use'];
    await turn(used.h, used.view);
    expect(choiceOf(used.h, 0)).toEqual({
      settings: 'use',
      mcp: 'use',
      settingsBeyondSafeSet: true,
    });
    both.view.expectMirror();
  });

  it('asks in Ask and Plan mode as well', async () => {
    const { h, view } = await project({ '.claude/settings.json': SETTINGS_WITH_HOOKS }, [
      text(),
      text(),
    ]);
    h.ui.chooseAnswers = ['ignore'];
    await turn(h, view, 'ask');
    expect(h.ui.callsOf('choose')).toHaveLength(1);
    expect(h.requests[0]?.profile.kind).toBe('read-only');
    expect(choiceOf(h, 0)).toEqual({ settings: 'ignore', mcp: 'use' });

    const other = await project({ '.claude/settings.json': SETTINGS_WITH_HOOKS }, [text()], {
      policy: createPlanTestPolicy(),
      projectConfigGate: true,
    });
    other.h.ui.chooseAnswers = ['use'];
    await turn(other.h, other.view, 'plan');
    expect(other.h.ui.callsOf('choose')).toHaveLength(1);
    expect(choiceOf(other.h, 0)).toEqual({
      settings: 'use',
      mcp: 'use',
      settingsBeyondSafeSet: true,
    });
  });

  it('remembers an answer, but not a dismissal', async () => {
    const { h, view } = await project({ '.claude/settings.json': SETTINGS_WITH_HOOKS }, [
      text(),
      text(),
      text(),
      text(),
    ]);
    // Dismissed: this turn ignores the project's configuration, and the question comes back.
    h.ui.chooseAnswers = [undefined, 'use'];
    await turn(h, view);
    expect(choiceOf(h, 0)).toEqual({ settings: 'ignore', mcp: 'use' });
    await turn(h, view);
    expect(h.ui.callsOf('choose')).toHaveLength(2);
    expect(choiceOf(h, 1)).toEqual({ settings: 'use', mcp: 'use', settingsBeyondSafeSet: true });
    // Answered: the next turns do not ask again.
    await turn(h, view);
    await turn(h, view);
    expect(h.ui.callsOf('choose')).toHaveLength(2);
    expect(choiceOf(h, 3)).toEqual({ settings: 'use', mcp: 'use', settingsBeyondSafeSet: true });
    view.expectMirror();
  });

  it('asks again when the files change, and when the user resets the decision', async () => {
    const { h, view } = await project({ '.claude/settings.json': SETTINGS_WITH_HOOKS }, [
      text(),
      text(),
      text(),
    ]);
    h.ui.chooseAnswers = ['use', 'use', 'ignore'];
    await turn(h, view);
    expect(h.ui.callsOf('choose')).toHaveLength(1);

    await fs.writeFile(
      join(h.workspace, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo changed' }] }] },
      }),
    );
    await turn(h, view);
    expect(h.ui.callsOf('choose')).toHaveLength(2);

    await h.controller.resetProjectConfigDecision(FOLDER_KEY);
    expect(view.toasts.at(-1)).toEqual({
      level: 'info',
      text: 'AgentCanopy will ask again before the next turn.',
    });
    await turn(h, view);
    expect(h.ui.callsOf('choose')).toHaveLength(3);
    expect(choiceOf(h, 2)).toEqual({ settings: 'ignore', mcp: 'use' });
    view.expectMirror();
  });

  it('says once per folder and fingerprint that the settings are ignored', async () => {
    const { h, view } = await project({ '.claude/settings.json': SETTINGS_WITH_HOOKS }, [
      text(),
      text(),
      text(),
    ]);
    h.ui.chooseAnswers = ['ignore', 'ignore'];
    await turn(h, view);
    expect(noticesOf(view, 0)).toEqual([IGNORED_NOTICE]);
    await turn(h, view);
    expect(noticesOf(view, 1)).toEqual([]);

    // After a reset the user may answer differently, so it is said again.
    await h.controller.resetProjectConfigDecision(FOLDER_KEY);
    await turn(h, view);
    expect(noticesOf(view, 2)).toEqual([IGNORED_NOTICE]);
    view.expectMirror();
  });

  it('gives the choice to the policy with every decision', async () => {
    const seen: (PolicyContext['projectConfig'] | 'none')[] = [];
    const base = createPlanTestPolicy();
    const policy = {
      ...base,
      decide: (request: Parameters<typeof base.decide>[0], context: PolicyContext) => {
        seen.push(context.projectConfig ?? 'none');
        return base.decide(request, context);
      },
    };
    const permission: ScenarioSpec = {
      scenario: {
        steps: [
          stateEvent('running'),
          initEvent(),
          {
            permission: {
              toolName: 'Bash',
              input: { command: 'ls' },
              toolUseId: 'toolu_p',
              onAllow: [],
              onDeny: [],
            },
          },
          assistantText('done'),
          ...resultStep('done'),
        ],
      },
    };
    const { h, view } = await project({ '.mcp.json': MCP_SERVER }, [permission], {
      policy,
      projectConfigGate: true,
    });
    h.ui.chooseAnswers = ['ignore'];
    await turn(h, view, 'agent');
    expect(seen).toEqual([{ settings: 'use', mcp: 'ignore' }]);
    expect(choiceOf(h, 0)).toEqual({ settings: 'use', mcp: 'ignore' });
  });

  it('marks the settings in use as beyond the safe set only when the user chose them and they need a decision', async () => {
    const SETTINGS_WITH_ENV = JSON.stringify({ env: { PATH: '/somewhere/bin' } });

    // "Use", for settings that run or change things: the flag is set.
    const used = await project({ '.claude/settings.json': SETTINGS_WITH_ENV }, [text()]);
    used.h.ui.chooseAnswers = ['use'];
    await turn(used.h, used.view);
    expect(choiceOf(used.h, 0)).toEqual({
      settings: 'use',
      mcp: 'use',
      settingsBeyondSafeSet: true,
    });

    // Nothing needs a decision: nothing is asked and the flag is absent.
    const plain = await project(
      { '.claude/settings.json': JSON.stringify({ permissions: { deny: ['Read(.env)'] } }) },
      [text()],
    );
    await turn(plain.h, plain.view, 'agent');
    expect(plain.h.ui.callsOf('choose')).toEqual([]);
    expect(choiceOf(plain.h, 0)).toEqual({ settings: 'use', mcp: 'use' });
    expect(choiceOf(plain.h, 0)).not.toHaveProperty('settingsBeyondSafeSet');

    // Only a tool server needs a decision, and the user uses it: the settings are still the safe set.
    const mcpOnly = await project({ '.mcp.json': MCP_SERVER }, [text()]);
    mcpOnly.h.ui.chooseAnswers = ['use'];
    await turn(mcpOnly.h, mcpOnly.view);
    expect(choiceOf(mcpOnly.h, 0)).toEqual({ settings: 'use', mcp: 'use' });
    expect(choiceOf(mcpOnly.h, 0)).not.toHaveProperty('settingsBeyondSafeSet');

    // "Ignore": the settings are not in force, so the flag is absent.
    const ignored = await project({ '.claude/settings.json': SETTINGS_WITH_ENV }, [text()]);
    ignored.h.ui.chooseAnswers = ['ignore'];
    await turn(ignored.h, ignored.view);
    expect(choiceOf(ignored.h, 0)).toEqual({ settings: 'ignore', mcp: 'use' });
    expect(choiceOf(ignored.h, 0)).not.toHaveProperty('settingsBeyondSafeSet');
  });

  it('gives the policy the flag with every decision', async () => {
    const seen: (PolicyContext['projectConfig'] | 'none')[] = [];
    const base = createPlanTestPolicy();
    const policy = {
      ...base,
      decide: (request: Parameters<typeof base.decide>[0], context: PolicyContext) => {
        seen.push(context.projectConfig ?? 'none');
        return base.decide(request, context);
      },
    };
    const permission: ScenarioSpec = {
      scenario: {
        steps: [
          stateEvent('running'),
          initEvent(),
          {
            permission: {
              toolName: 'Bash',
              input: { command: 'ls' },
              toolUseId: 'toolu_f',
              onAllow: [],
              onDeny: [],
            },
          },
          assistantText('done'),
          ...resultStep('done'),
        ],
      },
    };
    const { h, view } = await project(
      { '.claude/settings.json': SETTINGS_WITH_HOOKS },
      [permission],
      { policy, projectConfigGate: true },
    );
    h.ui.chooseAnswers = ['use'];
    await turn(h, view, 'agent');
    expect(seen).toEqual([{ settings: 'use', mcp: 'use', settingsBeyondSafeSet: true }]);
  });

  it('is not asked when the application is built with its own policy, unless switched on', async () => {
    const { h, view } = await project({ '.claude/settings.json': SETTINGS_WITH_HOOKS }, [text()], {
      policy: createTestPolicy(),
      observers: [],
    });
    await turn(h, view);
    expect(h.ui.callsOf('choose')).toEqual([]);
    expect(h.requests[0]?.profile.projectConfig).toBeUndefined();
    view.expectMirror();
  });
});
