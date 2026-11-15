import type { Logger } from '../../contracts';
import type { GrantStore } from './store';

export {
  createGrantStore,
  isValidGrant,
  MAX_GRANTS_PER_FOLDER,
  type FolderGrants,
  type Grant,
  type GrantStore,
} from './store';
export { checkDirectoryToGrant, type DirectoryRefusal } from './directory';
export { createSavedPermissions, type SavedPermissions } from './saved';
export {
  canGrantDirectory,
  containsSensitive,
  isSensitivePath,
  resolveSensitiveEnv,
  type SensitiveEnv,
} from './sensitive';
export { fetchSite, webCovered } from './web';

/** What the policies need to honour saved permissions. Without it every decision is the old one. */
export interface PolicyAccess {
  grants: GrantStore;
  /** AgentCanopy's storage directories, which always ask. Read at every decision. */
  sensitiveRoots: () => string[];
  logger: Logger;
}
