import type { Logger } from '../contracts';
import { loadIgnoreRules, scanWorkspace } from '../workspace/store';
import type { IgnoreRules, ScanOptions, ScanResult } from '../workspace/store';

export interface FileSearchResult {
  path: string;
  kind: 'file' | 'folder';
}

export interface FileSearch {
  /** Files and folders of `folderPath` whose path matches `query`, best first. Ignored paths never appear. */
  search(
    folderPath: string,
    excludes: string[],
    query: string,
    limit?: number,
  ): Promise<FileSearchResult[]>;
  /** Forgets the cached listing of a folder, or of every folder. */
  invalidate(folderPath?: string): void;
}

export interface FileSearchOptions {
  /** Most entries a listing holds; a bigger workspace is listed in part. Default 200000. */
  maxEntries?: number;
  /** How long a listing is reused. Default 15000. */
  cacheMs?: number;
  logger?: Logger;
  /** For tests: replaces the workspace scan. */
  scan?: (root: string, rules: IgnoreRules, options?: ScanOptions) => Promise<ScanResult>;
  /** For tests: replaces the clock that expires cached listings. */
  now?: () => number;
}

interface Item {
  path: string;
  kind: 'file' | 'folder';
  lower: string;
  base: string;
}

interface Listing {
  excludesKey: string;
  items: Promise<Item[]>;
  /** Set when the scan has finished; the listing is reused until then plus `cacheMs`. */
  expiresAt: number | undefined;
}

const DEFAULT_LIMIT = 30;

function itemOf(path: string, kind: 'file' | 'folder'): Item {
  const lower = path.toLowerCase();
  return { path, kind, lower, base: lower.slice(lower.lastIndexOf('/') + 1) };
}

/** Every file, and every directory that holds one. Symbolic links are left out. */
function listingOf(result: ScanResult): Item[] {
  const folders = new Set<string>();
  const items: Item[] = [];
  for (const [path, entry] of result.entries) {
    if (entry.kind !== 'file') continue;
    items.push(itemOf(path, 'file'));
    for (let slash = path.indexOf('/'); slash !== -1; slash = path.indexOf('/', slash + 1)) {
      folders.add(path.slice(0, slash));
    }
  }
  for (const folder of folders) items.push(itemOf(folder, 'folder'));
  return items;
}

function isSubsequence(query: string, text: string): boolean {
  let at = 0;
  for (let index = 0; index < text.length && at < query.length; index += 1) {
    if (text[index] === query[at]) at += 1;
  }
  return at === query.length;
}

/** 0 is the best match; undefined does not match. */
function rankOf(item: Item, query: string): number | undefined {
  if (item.base.startsWith(query)) return 0;
  if (item.base.includes(query)) return 1;
  if (item.lower.includes(query)) return 2;
  if (isSubsequence(query, item.lower)) return 3;
  return undefined;
}

export function createFileSearch(options: FileSearchOptions = {}): FileSearch {
  const maxEntries = options.maxEntries ?? 200_000;
  const cacheMs = options.cacheMs ?? 15_000;
  const scan = options.scan ?? scanWorkspace;
  const now = options.now ?? (() => Date.now());
  const logger = options.logger;
  const listings = new Map<string, Listing>();

  async function list(folderPath: string, excludes: string[]): Promise<Item[]> {
    const excludesKey = JSON.stringify(excludes);
    const known = listings.get(folderPath);
    if (
      known?.excludesKey === excludesKey &&
      (known.expiresAt === undefined || known.expiresAt > now())
    ) {
      return known.items;
    }
    const listing: Listing = {
      excludesKey,
      expiresAt: undefined,
      items: (async () => {
        const rules = await loadIgnoreRules(folderPath, excludes);
        const result = await scan(folderPath, rules, { maxEntries });
        if (result.truncated) {
          logger?.warn('the workspace is too large to search completely', { maxEntries });
        }
        return listingOf(result);
      })(),
    };
    listings.set(folderPath, listing);
    listing.items.then(
      () => {
        listing.expiresAt = now() + cacheMs;
      },
      () => {
        // A failed scan is not kept: the next search tries again.
        if (listings.get(folderPath) === listing) listings.delete(folderPath);
      },
    );
    return listing.items;
  }

  return {
    async search(folderPath, excludes, query, limit = DEFAULT_LIMIT) {
      const needle = query.trim().toLowerCase();
      if (needle.length === 0 || limit <= 0) return [];
      const items = await list(folderPath, excludes);
      const matches: { item: Item; rank: number }[] = [];
      for (const item of items) {
        const rank = rankOf(item, needle);
        if (rank !== undefined) matches.push({ item, rank });
      }
      matches.sort((a, b) => {
        if (a.rank !== b.rank) return a.rank - b.rank;
        if (a.item.path.length !== b.item.path.length) {
          return a.item.path.length - b.item.path.length;
        }
        if (a.item.path === b.item.path) return 0;
        return a.item.path < b.item.path ? -1 : 1;
      });
      return matches.slice(0, limit).map(({ item }) => ({ path: item.path, kind: item.kind }));
    },

    invalidate(folderPath) {
      if (folderPath === undefined) listings.clear();
      else listings.delete(folderPath);
    },
  };
}
