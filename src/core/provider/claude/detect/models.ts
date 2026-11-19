import {
  delegateChoice,
  delegateLabel,
  parseModelChoice,
  type ModelInfo,
} from '../../../../shared';

/** What the CLI accepts as a model name; the same pattern as `MODEL` in process/invocation.ts. */
const MODEL_ID = /^[A-Za-z0-9._:[\]/@-]{1,100}$/;

/** A versioned Claude id: family, major, optional minor, optional date, optional 1M context. */
const VERSIONED = /^claude-([a-z]+)-(\d{1,2})(?:-(\d{1,2}))?(?:-(\d{8}))?(\[1m\])?$/;

/** The full id each alias is taken to run, until a finished turn reports the real one. */
const ALIASES: ReadonlyArray<readonly [alias: string, id: string]> = [
  ['sonnet', 'claude-sonnet-5-5'],
  ['opus', 'claude-opus-5-5'],
  ['haiku', 'claude-haiku-5-5'],
  ['fable', 'claude-fable-5-2'],
];

const DEFAULT_LABEL = 'Default (Claude Code decides)';

/**
 * A readable name for a versioned Claude model id, such as "Opus 5.5" or "Fable 5", with " (1M)"
 * for the long-context form. The date is left out. Undefined for any id of another shape.
 */
export function modelDisplayName(id: string): string | undefined {
  const match = VERSIONED.exec(id);
  if (!match) return undefined;
  const [, family = '', major = '', minor, , long] = match;
  const name = `${family.charAt(0).toUpperCase()}${family.slice(1)}`;
  const version = minor === undefined ? major : `${major}.${minor}`;
  return `${name} ${version}${long === undefined ? '' : ' (1M)'}`;
}

/** The value learned for an alias, when there is one of the right shape. Own keys only. */
function learned(known: Readonly<Record<string, string>>, alias: string): string | undefined {
  if (!Object.hasOwn(known, alias)) return undefined;
  const value: unknown = known[alias];
  return typeof value === 'string' && MODEL_ID.test(value) ? value : undefined;
}

/**
 * The built-in entries and then the user's own model ids, without duplicates. `known` maps an alias
 * to the full id a finished turn reported; it sets the version shown in the label and `resolved`.
 */
export function claudeModels(
  custom: readonly string[],
  known: Readonly<Record<string, string>> = {},
): ModelInfo[] {
  const models: ModelInfo[] = [];
  /** The default and the aliases, by id: what a custom delegate choice can be based on. */
  const byId = new Map<string, ModelInfo>();
  const add = (model: ModelInfo): void => {
    models.push(model);
    byId.set(model.id, model);
  };

  const defaultId = learned(known, 'default');
  const defaultName = defaultId === undefined ? undefined : modelDisplayName(defaultId);
  add({
    id: 'default',
    label: defaultName === undefined ? DEFAULT_LABEL : `${DEFAULT_LABEL} · ${defaultName}`,
    custom: false,
    ...(defaultId === undefined ? {} : { resolved: defaultId }),
  });

  for (const [alias, tableId] of ALIASES) {
    const id = learned(known, alias);
    const label =
      (id === undefined ? undefined : modelDisplayName(id)) ?? modelDisplayName(tableId) ?? alias;
    add({ id: alias, label, custom: false, resolved: id ?? tableId });
  }

  const fable = byId.get('fable');
  if (fable) {
    models.push({
      id: delegateChoice('fable'),
      label: delegateLabel(fable.label),
      custom: false,
      ...(fable.resolved === undefined ? {} : { resolved: fable.resolved }),
    });
  }

  const seen = new Set(models.map((m) => m.id));
  for (const raw of custom) {
    const id = raw.trim();
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    const { model, delegate } = parseModelChoice(id);
    if (!delegate) {
      models.push({ id, label: id, custom: true });
      continue;
    }
    const base = byId.get(model);
    const baseLabel = base ? (model === 'default' ? 'Default' : base.label) : model;
    models.push({
      id,
      label: delegateLabel(baseLabel),
      custom: true,
      ...(base?.resolved === undefined ? {} : { resolved: base.resolved }),
    });
  }
  return models;
}
