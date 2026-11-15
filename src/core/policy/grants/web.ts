import { isValidGrant, type FolderGrants } from './store';

/** True for a backslash, whitespace and control characters (C0 and C1). The URL parser would drop or turn some of them. */
function hasUnsafeCharacter(address: string): boolean {
  for (const char of address) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '\\' || code <= 0x1f || (code >= 0x7f && code <= 0x9f) || /\s/u.test(char)) {
      return true;
    }
  }
  return false;
}

/**
 * The site an address belongs to, or `undefined` when it is not one that can be saved or matched: the
 * address has a backslash, whitespace or a control character, does not parse, is not `http` or
 * `https`, carries a user name or password, or its host would not be a valid saved site. Otherwise the
 * lower-case host, with a port that is not the scheme's default one. The same function is used when a
 * site is offered, when it is saved and when a fetch is matched, so the three always agree.
 */
export function fetchSite(address: string): string | undefined {
  if (hasUnsafeCharacter(address)) return undefined;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (url.username !== '' || url.password !== '') return undefined;
  const host = url.host;
  return isValidGrant({ kind: 'web-site', host }) ? host : undefined;
}

/**
 * Whether the user allowed this web call without asking: a fetch when the `web-fetch` switch is on or
 * its site is saved, a search when the `web-search` switch is on. `stored` must have been read from
 * the store just now, with nothing awaited between that and the decision.
 */
export function webCovered(
  stored: FolderGrants,
  fetchTool: boolean,
  site: string | undefined,
): boolean {
  if (!fetchTool) return stored.switches.includes('web-search');
  if (stored.switches.includes('web-fetch')) return true;
  return (
    site !== undefined &&
    stored.grants.some((grant) => grant.kind === 'web-site' && grant.host === site)
  );
}
