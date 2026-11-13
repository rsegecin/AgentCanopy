import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { FolderKey } from '../../../shared';
import { silentLogger, type Logger } from '../../contracts';
import { exactCommandRule } from './commands';

export const MAX_RULES_PER_FOLDER = 200;
const MAX_RULE_LENGTH = 500;
const FOLDER_KEY = /^[A-Za-z0-9_-]{1,64}$/;
const FILE_NAME = /^([A-Za-z0-9_-]{1,64})\.json$/;

export interface RuleStore {
  /** Creates the directory if needed and loads every file. Call once before the other methods. */
  init(): Promise<void>;
  list(folderKey: FolderKey): string[];
  /** Rejects with a plain message for an invalid rule or when the folder already has the maximum. */
  add(folderKey: FolderKey, rule: string): Promise<void>;
  remove(folderKey: FolderKey, rule: string): Promise<void>;
}

const MCP_RULE = /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/;
const OWN_PREFIX = 'mcp__agentcanopy__';

/**
 * Only two shapes of rule can be stored, so that a hand-edited file cannot add a broad one such as
 * `Bash` or `Bash(*)`: the exact rule for one plain command, and the name of one MCP tool that is
 * not our own.
 */
export function isValidRule(rule: unknown): rule is string {
  if (typeof rule !== 'string' || rule.length === 0 || rule.length > MAX_RULE_LENGTH) return false;
  if (rule.startsWith('Bash(') && rule.endsWith(')')) {
    return exactCommandRule(rule.slice('Bash('.length, -1)) === rule;
  }
  return MCP_RULE.test(rule) && !rule.startsWith(OWN_PREFIX);
}

const FileSchema = z.object({ allow: z.array(z.unknown()) });

function checkKey(folderKey: string): void {
  if (!FOLDER_KEY.test(folderKey)) throw new Error('That folder key cannot be used for rules.');
}

/**
 * The always-allow rules the user created, per workspace folder, one JSON file each. The rules are
 * in Claude Code's own syntax and go into the settings file of the next turn.
 */
export function createRuleStore(options: { dir: string; logger?: Logger }): RuleStore {
  const { dir } = options;
  const logger = options.logger ?? silentLogger;
  const rules = new Map<string, string[]>();
  let opened = false;
  /** Writes are queued, so two adds in a row cannot overwrite each other. */
  let queue: Promise<unknown> = Promise.resolve();

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  }

  async function load(file: string, key: string): Promise<string[]> {
    let parsed: z.infer<typeof FileSchema>;
    try {
      parsed = FileSchema.parse(JSON.parse(await fs.readFile(join(dir, file), 'utf8')));
    } catch (error) {
      logger.warn('A rule file could not be read and is treated as empty.', {
        file,
        reason: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
    const valid = [...new Set(parsed.allow.filter(isValidRule))].slice(0, MAX_RULES_PER_FOLDER);
    if (valid.length !== parsed.allow.length) {
      logger.warn('Some stored rules were not allowed, repeated or too many and were dropped.', {
        key,
        kept: valid.length,
        found: parsed.allow.length,
      });
    }
    return valid;
  }

  async function write(key: string, allow: string[]): Promise<void> {
    const target = join(dir, `${key}.json`);
    const temp = join(dir, `.${key}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      await fs.writeFile(temp, `${JSON.stringify({ allow }, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(temp, target);
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  return {
    async init() {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      rules.clear();
      for (const file of await fs.readdir(dir)) {
        const key = FILE_NAME.exec(file)?.[1];
        if (key !== undefined) rules.set(key, await load(file, key));
      }
      opened = true;
    },

    list(folderKey) {
      return [...(rules.get(folderKey) ?? [])];
    },

    add(folderKey, rule) {
      return enqueue(async () => {
        if (!opened) throw new Error('The rule store has not been opened.');
        checkKey(folderKey);
        if (!isValidRule(rule)) throw new Error('That rule cannot be saved.');
        const current = rules.get(folderKey) ?? [];
        if (current.includes(rule)) return;
        if (current.length >= MAX_RULES_PER_FOLDER) {
          throw new Error(
            `This folder already has ${MAX_RULES_PER_FOLDER} saved rules. Remove some before adding more.`,
          );
        }
        const next = [...current, rule];
        await write(folderKey, next);
        rules.set(folderKey, next);
      });
    },

    remove(folderKey, rule) {
      return enqueue(async () => {
        if (!opened) throw new Error('The rule store has not been opened.');
        checkKey(folderKey);
        const current = rules.get(folderKey) ?? [];
        if (!current.includes(rule)) return;
        const next = current.filter((entry) => entry !== rule);
        await write(folderKey, next);
        rules.set(folderKey, next);
      });
    },
  };
}
