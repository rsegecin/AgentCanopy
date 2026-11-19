import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { PermissionSwitchSchema, type FolderKey, type PermissionSwitch } from '../../../shared';
import { silentLogger, type Logger } from '../../contracts';
import { exactPowerShellCommand } from '../agent/commands';
import { escapeOneLine } from '../readonly/escape';

export const MAX_GRANTS_PER_FOLDER = 200;
const MAX_PATH_LENGTH = 4096;
const FOLDER_KEY = /^[A-Za-z0-9_-]{1,64}$/;
const FILE_NAME = /^([A-Za-z0-9_-]{1,64})\.json$/;
const HOST_CHARS = /^[a-z0-9._\-[\]:]{1,261}$/;

/**
 * What the user allowed for one workspace folder, besides the rules of the rule store. A
 * `read-directory` allows reads and searches in a directory outside the folder and below it; an
 * `edit-directory` allows edits there, and reads and searches with them.
 */
export type Grant =
  | { kind: 'read-directory'; path: string }
  | { kind: 'edit-directory'; path: string }
  | { kind: 'web-site'; host: string }
  | { kind: 'powershell-command'; command: string };

export interface FolderGrants {
  /** The switches that are on. */
  switches: PermissionSwitch[];
  grants: Grant[];
}

export interface GrantStore {
  /** Creates the directory if needed and loads every file. Call once before the other methods. */
  init(): Promise<void>;
  /** A copy of what is stored for the folder; empty for a folder with nothing. */
  get(folderKey: FolderKey): FolderGrants;
  /** Does nothing when the grant is there. Rejects with a plain message when it is invalid or the folder has the maximum. */
  add(folderKey: FolderKey, grant: Grant): Promise<void>;
  /** Does nothing when the grant is not there. */
  remove(folderKey: FolderKey, grant: Grant): Promise<void>;
  setSwitch(folderKey: FolderKey, name: PermissionSwitch, on: boolean): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidHost(host: string): boolean {
  if (!HOST_CHARS.test(host)) return false;
  try {
    return new URL(`http://${host}/`).host === host || new URL(`https://${host}/`).host === host;
  } catch {
    return false;
  }
}

/**
 * The shape of a grant, nothing more. Whether a directory may be granted is not decided here (see
 * `canGrantDirectory`): the policy checks that again when it uses the grant.
 */
export function isValidGrant(value: unknown): value is Grant {
  if (!isRecord(value)) return false;
  switch (value['kind']) {
    case 'read-directory':
    case 'edit-directory': {
      const path = value['path'];
      return (
        typeof path === 'string' &&
        path.length >= 1 &&
        path.length <= MAX_PATH_LENGTH &&
        isAbsolute(path) &&
        escapeOneLine(path) === path
      );
    }
    case 'web-site': {
      const host = value['host'];
      return typeof host === 'string' && isValidHost(host);
    }
    case 'powershell-command': {
      const command = value['command'];
      return typeof command === 'string' && exactPowerShellCommand(command) === command;
    }
    default:
      return false;
  }
}

/** The text a grant is about. Two grants are the same when kind and value are equal. */
export function grantValue(grant: Grant): string {
  switch (grant.kind) {
    case 'read-directory':
    case 'edit-directory':
      return grant.path;
    case 'web-site':
      return grant.host;
    case 'powershell-command':
      return grant.command;
  }
}

export function sameGrant(a: Grant, b: Grant): boolean {
  return a.kind === b.kind && grantValue(a) === grantValue(b);
}

/** A grant with only its own fields, so that extra keys of a hand-edited file are never kept. */
function clean(grant: Grant): Grant {
  switch (grant.kind) {
    case 'read-directory':
      return { kind: 'read-directory', path: grant.path };
    case 'edit-directory':
      return { kind: 'edit-directory', path: grant.path };
    case 'web-site':
      return { kind: 'web-site', host: grant.host };
    case 'powershell-command':
      return { kind: 'powershell-command', command: grant.command };
  }
}

const FileSchema = z.object({
  version: z.literal(1),
  switches: z.array(z.unknown()),
  grants: z.array(z.unknown()),
});

function checkKey(folderKey: string): void {
  if (!FOLDER_KEY.test(folderKey))
    throw new Error('That folder key cannot be used for permissions.');
}

function empty(): FolderGrants {
  return { switches: [], grants: [] };
}

/**
 * The permissions the user saved besides the rule store's, per workspace folder, one JSON file each:
 * the switches that are on, the directories that may be read, the sites that may be fetched and the
 * PowerShell commands that may run. Written like the rule files; the policy reads it at every request.
 */
export function createGrantStore(options: { dir: string; logger?: Logger }): GrantStore {
  const { dir } = options;
  const logger = options.logger ?? silentLogger;
  const folders = new Map<string, FolderGrants>();
  let opened = false;
  /** Writes are queued, so two changes in a row cannot overwrite each other. */
  let queue: Promise<unknown> = Promise.resolve();

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  }

  async function load(file: string, key: string): Promise<FolderGrants> {
    let parsed: z.infer<typeof FileSchema>;
    try {
      parsed = FileSchema.parse(JSON.parse(await fs.readFile(join(dir, file), 'utf8')));
    } catch (error) {
      logger.warn('A permissions file could not be read and is treated as empty.', {
        file,
        reason: error instanceof Error ? error.message : String(error),
      });
      return empty();
    }
    const switches: PermissionSwitch[] = [];
    for (const item of parsed.switches) {
      const result = PermissionSwitchSchema.safeParse(item);
      if (result.success && !switches.includes(result.data)) switches.push(result.data);
    }
    const grants: Grant[] = [];
    for (const item of parsed.grants) {
      if (!isValidGrant(item)) continue;
      const grant = clean(item);
      if (grants.some((other) => sameGrant(other, grant))) continue;
      if (grants.length < MAX_GRANTS_PER_FOLDER) grants.push(grant);
    }
    if (switches.length !== parsed.switches.length || grants.length !== parsed.grants.length) {
      logger.warn(
        'Some stored permissions were not valid, repeated or too many and were dropped.',
        {
          key,
          keptSwitches: switches.length,
          foundSwitches: parsed.switches.length,
          keptGrants: grants.length,
          foundGrants: parsed.grants.length,
        },
      );
    }
    return { switches, grants };
  }

  async function write(key: string, state: FolderGrants): Promise<void> {
    const target = join(dir, `${key}.json`);
    const temp = join(dir, `.${key}.${randomBytes(6).toString('hex')}.tmp`);
    const content = { version: 1, switches: state.switches, grants: state.grants };
    try {
      await fs.writeFile(temp, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(temp, target);
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** Writes the new state, and only when that worked keeps it in memory. */
  async function commit(key: string, state: FolderGrants): Promise<void> {
    await write(key, state);
    folders.set(key, state);
  }

  return {
    async init() {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      folders.clear();
      for (const file of await fs.readdir(dir)) {
        const key = FILE_NAME.exec(file)?.[1];
        if (key !== undefined) folders.set(key, await load(file, key));
      }
      opened = true;
    },

    get(folderKey) {
      const current = folders.get(folderKey) ?? empty();
      return { switches: [...current.switches], grants: current.grants.map(clean) };
    },

    add(folderKey, grant) {
      return enqueue(async () => {
        if (!opened) throw new Error('The permission store has not been opened.');
        checkKey(folderKey);
        if (!isValidGrant(grant)) throw new Error('That permission cannot be saved.');
        const wanted = clean(grant);
        const current = folders.get(folderKey) ?? empty();
        if (current.grants.some((other) => sameGrant(other, wanted))) return;
        if (current.grants.length >= MAX_GRANTS_PER_FOLDER) {
          throw new Error(
            `This folder already has ${MAX_GRANTS_PER_FOLDER} saved permissions. Remove some before adding more.`,
          );
        }
        await commit(folderKey, {
          switches: [...current.switches],
          grants: [...current.grants, wanted],
        });
      });
    },

    remove(folderKey, grant) {
      return enqueue(async () => {
        if (!opened) throw new Error('The permission store has not been opened.');
        checkKey(folderKey);
        const current = folders.get(folderKey) ?? empty();
        if (!current.grants.some((other) => sameGrant(other, grant))) return;
        await commit(folderKey, {
          switches: [...current.switches],
          grants: current.grants.filter((other) => !sameGrant(other, grant)),
        });
      });
    },

    setSwitch(folderKey, name, on) {
      return enqueue(async () => {
        if (!opened) throw new Error('The permission store has not been opened.');
        checkKey(folderKey);
        if (!PermissionSwitchSchema.safeParse(name).success) {
          throw new Error('That permission cannot be saved.');
        }
        const current = folders.get(folderKey) ?? empty();
        if (current.switches.includes(name) === on) return;
        await commit(folderKey, {
          switches: on
            ? [...current.switches, name]
            : current.switches.filter((other) => other !== name),
          grants: [...current.grants],
        });
      });
    },
  };
}
