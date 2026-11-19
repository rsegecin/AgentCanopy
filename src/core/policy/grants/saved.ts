import { createHash } from 'node:crypto';
import type { FolderKey, PermissionPrompt, SavedPermission } from '../../../shared';
import { runsProjectCode, runsProjectCodePowerShell } from '../agent/commands';
import type { RuleStore } from '../agent/rules';
import { escapeForDisplay } from '../readonly/escape';
import { grantValue, type Grant, type GrantStore } from './store';

/** Everything the user saved for a folder, in both stores, as the Permissions view lists it. */
export interface SavedPermissions {
  list(folderKey: FolderKey): SavedPermission[];
  /** Removes the entry with this id from the store it came from. False when no entry has that id. */
  remove(folderKey: FolderKey, id: string): Promise<boolean>;
  /** Whether what a prompt offered to save is saved now. */
  has(folderKey: FolderKey, rule: NonNullable<PermissionPrompt['alwaysRule']>): boolean;
}

interface Entry {
  view: SavedPermission;
  remove(): Promise<void>;
}

const BASH_RULE = /^Bash\(([\s\S]*)\)$/;
const POWERSHELL_RULE = /^PowerShell\(([\s\S]*)\)$/;

/** Stable across restarts and different for different entries: the hash of what the entry is in its store. */
function idOf(source: Record<string, string>): string {
  return createHash('sha256').update(JSON.stringify(source)).digest('hex').slice(0, 32);
}

function hasGrant(grants: GrantStore, folderKey: FolderKey, wanted: Grant): boolean {
  return grants.get(folderKey).grants.some((grant) => {
    if (grant.kind !== wanted.kind) return false;
    switch (grant.kind) {
      case 'read-directory':
        return wanted.kind === 'read-directory' && grant.path === wanted.path;
      case 'edit-directory':
        return wanted.kind === 'edit-directory' && grant.path === wanted.path;
      case 'web-site':
        return wanted.kind === 'web-site' && grant.host === wanted.host;
      case 'powershell-command':
        return wanted.kind === 'powershell-command' && grant.command === wanted.command;
    }
  });
}

export function createSavedPermissions(options: {
  rules: RuleStore;
  grants: GrantStore;
}): SavedPermissions {
  const { rules, grants } = options;

  function grantEntry(folderKey: FolderKey, grant: Grant): Entry {
    const value = grantValue(grant);
    const id = idOf({ store: 'grants', kind: grant.kind, value });
    const text = escapeForDisplay(value);
    const view: SavedPermission =
      grant.kind === 'powershell-command'
        ? {
            id,
            kind: 'command',
            text,
            shell: 'powershell',
            runsProjectCode: runsProjectCodePowerShell(grant.command),
          }
        : { id, kind: grant.kind, text };
    return { view, remove: () => grants.remove(folderKey, grant) };
  }

  function ruleEntry(folderKey: FolderKey, rule: string): Entry {
    const id = idOf({ store: 'rules', rule });
    const command = BASH_RULE.exec(rule)?.[1];
    const view: SavedPermission =
      command === undefined
        ? { id, kind: 'mcp-tool', text: escapeForDisplay(rule) }
        : {
            id,
            kind: 'command',
            text: escapeForDisplay(command),
            shell: 'bash',
            runsProjectCode: runsProjectCode(command),
          };
    return { view, remove: () => rules.remove(folderKey, rule) };
  }

  /** Read directories, edit directories, sites, Bash commands, PowerShell commands, MCP tools. */
  function entries(folderKey: FolderKey): Entry[] {
    const stored = grants.get(folderKey).grants;
    const own = (kind: Grant['kind']) =>
      stored.filter((grant) => grant.kind === kind).map((grant) => grantEntry(folderKey, grant));
    const ruleList = rules.list(folderKey);
    const bash = ruleList.filter((rule) => BASH_RULE.test(rule));
    const tools = ruleList.filter((rule) => !BASH_RULE.test(rule));
    return [
      ...own('read-directory'),
      ...own('edit-directory'),
      ...own('web-site'),
      ...bash.map((rule) => ruleEntry(folderKey, rule)),
      ...own('powershell-command'),
      ...tools.map((rule) => ruleEntry(folderKey, rule)),
    ];
  }

  return {
    list(folderKey) {
      return entries(folderKey).map((entry) => entry.view);
    },

    async remove(folderKey, id) {
      const entry = entries(folderKey).find((candidate) => candidate.view.id === id);
      if (entry === undefined) return false;
      await entry.remove();
      return true;
    },

    has(folderKey, rule) {
      switch (rule.kind) {
        case 'read-directory':
          return hasGrant(grants, folderKey, { kind: 'read-directory', path: rule.rule });
        case 'edit-directory':
          return hasGrant(grants, folderKey, { kind: 'edit-directory', path: rule.rule });
        case 'web-site':
          return hasGrant(grants, folderKey, { kind: 'web-site', host: rule.rule });
        default: {
          const command = POWERSHELL_RULE.exec(rule.rule)?.[1];
          if (command !== undefined) {
            return hasGrant(grants, folderKey, { kind: 'powershell-command', command });
          }
          return rules.list(folderKey).includes(rule.rule);
        }
      }
    },
  };
}
