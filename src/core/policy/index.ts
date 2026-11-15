import type { TurnPolicy } from '../contracts';

/** Dispatches to the policy of the turn's mode: `profile` by the requested mode, the rest by the context's. */
export function createModePolicy(policies: {
  ask: TurnPolicy;
  plan: TurnPolicy;
  agent: TurnPolicy;
}): TurnPolicy {
  return {
    profile: (input) => policies[input.mode].profile(input),
    decide: (request, context) => policies[context.mode].decide(request, context),
    inspect: (event, context) => policies[context.mode].inspect?.(event, context),
  };
}

export { createAgentPolicy, createRuleStore } from './agent';
export {
  checkDirectoryToGrant,
  createGrantStore,
  type DirectoryRefusal,
  createSavedPermissions,
  type FolderGrants,
  type Grant,
  type GrantStore,
  type SavedPermissions,
} from './grants';
export { createReadOnlyPolicy, createReadOnlyTripwire } from './readonly';
export {
  createProjectConfigDecisions,
  inspectProjectConfig,
  type ProjectConfigDecision,
  type ProjectConfigDecisions,
  type ProjectConfigSummary,
} from './project-config';
