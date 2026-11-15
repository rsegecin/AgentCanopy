import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..', '..');

interface Property {
  type?: string;
  default?: unknown;
  scope?: string;
}

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  contributes: {
    commands: { command: string; title: string; category?: string }[];
    configuration: { properties: Record<string, Property> };
  };
};
const properties = manifest.contributes.configuration.properties;

/**
 * Settings that are not machine-scoped today. The security-relevant ones must be machine-scoped so a
 * repository's `.vscode/settings.json` cannot weaken them (plan constraint C17). Each entry says why.
 */
const NOT_MACHINE_SCOPED: Record<string, string> = {
  // Only controls whether a warning about unsaved files is shown; it grants the agent nothing.
  'agentCanopy.unsavedFiles': 'window',
};

describe('package.json commands', () => {
  it('contributes the Show Permissions command', () => {
    expect(
      manifest.contributes.commands.find((c) => c.command === 'agentcanopy.showPermissions'),
    ).toEqual({
      command: 'agentcanopy.showPermissions',
      title: 'Show Permissions',
      category: 'AgentCanopy',
    });
  });
});

describe('package.json configuration', () => {
  it('has only agentCanopy.* properties', () => {
    for (const key of Object.keys(properties))
      expect(key.startsWith('agentCanopy.'), key).toBe(true);
  });

  it('gives every setting machine scope, except the listed ones', () => {
    for (const [key, property] of Object.entries(properties)) {
      const expected = NOT_MACHINE_SCOPED[key] ?? 'machine';
      expect(property.scope, key).toBe(expected);
    }
  });

  it('lists only exceptions that exist', () => {
    for (const key of Object.keys(NOT_MACHINE_SCOPED)) expect(properties[key], key).toBeDefined();
  });

  it.each([
    ['agentCanopy.agent.auto.enabled', true],
    ['agentCanopy.agent.auto.webTools', false],
  ])('declares %s as a machine-scoped boolean defaulting to %s', (key, value) => {
    expect(properties[key]).toMatchObject({ type: 'boolean', default: value, scope: 'machine' });
  });

  it('declares every configuration key the settings reader uses', () => {
    // `src/vscode/host/settings.ts` imports `vscode`, so its source is read instead of imported.
    const source = readFileSync(join(root, 'src', 'vscode', 'host', 'settings.ts'), 'utf8');
    const configs = [...source.matchAll(/config: '([^']+)'/g)].map((match) => match[1]);
    expect(configs.length).toBeGreaterThan(10);
    for (const config of configs) {
      expect(properties[`agentCanopy.${config}`], config).toBeDefined();
    }
  });
});
