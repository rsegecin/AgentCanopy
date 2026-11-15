import * as z from 'zod';
import { FolderKeySchema } from './ids';

/**
 * A kind of request the user can let run without asking, for one workspace folder. Off until the user
 * turns it on in a native dialog. There is none for commands (Agent mode's Auto is that switch) and
 * none for tools of other tool servers.
 */
export const PermissionSwitchSchema = z.enum(['read-outside', 'web-fetch', 'web-search']);
export type PermissionSwitch = z.infer<typeof PermissionSwitchSchema>;

/** Every switch, in the order the Permissions view shows them. */
export const PERMISSION_SWITCHES: readonly PermissionSwitch[] = PermissionSwitchSchema.options;

export const SavedPermissionKindSchema = z.enum([
  'read-directory',
  'web-site',
  'command',
  'mcp-tool',
]);
export type SavedPermissionKind = z.infer<typeof SavedPermissionKindSchema>;

/** One thing the user chose "Always allow" for, as the Permissions view lists it. */
export const SavedPermissionSchema = z.object({
  /** Opaque and stable for the entry. Removing it names this id, never the text. */
  id: z.string().min(1).max(64),
  kind: SavedPermissionKindSchema,
  /** The directory, the site, the command or the tool. Control and bidi characters are escaped by the host. */
  text: z.string(),
  /** For a command: the shell that runs it. */
  shell: z.enum(['bash', 'powershell']).optional(),
  /** For a command: it can run code from the project. */
  runsProjectCode: z.boolean().optional(),
});
export type SavedPermission = z.infer<typeof SavedPermissionSchema>;

/** What is allowed without asking in the workspace folder a view shows. */
export const FolderPermissionsSchema = z.object({
  /** The folder these belong to, or null when the view has none or permissions are not available. */
  folder: FolderKeySchema.nullable(),
  /** The switches that are on. */
  switches: z.array(PermissionSwitchSchema),
  saved: z.array(SavedPermissionSchema),
});
export type FolderPermissions = z.infer<typeof FolderPermissionsSchema>;

/**
 * The settings that shape what asks, as the Permissions view shows them. They apply to every project
 * on this machine and are changed in the editor's settings, never from the view.
 */
export const PolicySettingsSchema = z.object({
  /** `agentCanopy.agent.editApproval` */
  editApproval: z.enum(['auto', 'ask']),
  /** `agentCanopy.agent.alwaysAskCommands` */
  alwaysAskCommands: z.boolean(),
  /** `agentCanopy.ask.webTools` */
  askWebTools: z.boolean(),
  /** `agentCanopy.agent.auto.enabled` */
  autoOffered: z.boolean(),
  /** `agentCanopy.agent.auto.webTools` */
  autoWebTools: z.boolean(),
  /** `agentCanopy.agent.sandbox` */
  sandbox: z.boolean(),
});
export type PolicySettings = z.infer<typeof PolicySettingsSchema>;
