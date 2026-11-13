import type { AgentProvider, ProviderRegistry } from '../../contracts';

/** Holds the providers in registration order. A duplicate id is a programming error. */
export function createProviderRegistry(providers: AgentProvider[]): ProviderRegistry {
  const byId = new Map<string, AgentProvider>();
  for (const provider of providers) {
    if (byId.has(provider.id)) {
      throw new Error(`Provider id registered twice: ${provider.id}`);
    }
    byId.set(provider.id, provider);
  }
  const ordered = [...byId.values()];
  return {
    list: () => [...ordered],
    get: (id) => byId.get(id),
  };
}
