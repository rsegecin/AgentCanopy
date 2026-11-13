import type { ModelInfo } from '../../../../shared';

const BUILT_IN: ModelInfo[] = [
  { id: 'default', label: 'Default (Claude Code decides)', custom: false },
  { id: 'sonnet', label: 'Sonnet', custom: false },
  { id: 'opus', label: 'Opus', custom: false },
  { id: 'haiku', label: 'Haiku', custom: false },
  { id: 'fable', label: 'Fable', custom: false },
];

/** The built-in aliases followed by the user's own model ids, without duplicates. */
export function claudeModels(custom: readonly string[]): ModelInfo[] {
  const models = BUILT_IN.map((m) => ({ ...m }));
  const seen = new Set(models.map((m) => m.id));
  for (const raw of custom) {
    const id = raw.trim();
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label: id, custom: true });
  }
  return models;
}
