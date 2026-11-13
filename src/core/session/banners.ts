import type { Banner, ProviderStatus } from '../../shared';
import { TEXT } from './text';

export const REFRESH_ACTION = { id: 'refresh', label: 'Check again' } as const;
export const SIGN_IN_ACTION = { id: 'sign-in', label: 'Sign in' } as const;

interface ProblemKind {
  slug: string;
  level: Banner['level'];
  action: Banner['action'];
  dismissible: boolean;
}

/**
 * The provider reports problems as plain sentences, so the kind is worked out from the status
 * fields first and from the text only to tell the notices of an installed, current provider apart.
 */
function classify(status: ProviderStatus, problem: string): ProblemKind {
  if (!status.installed) {
    return { slug: 'not-installed', level: 'error', action: REFRESH_ACTION, dismissible: false };
  }
  if (!status.meetsMinimum) {
    return {
      slug: status.version === undefined ? 'unusable' : 'too-old',
      level: 'error',
      action: REFRESH_ACTION,
      dismissible: false,
    };
  }
  if (/ANTHROPIC_API_KEY/.test(problem)) {
    return { slug: 'api-key', level: 'warning', action: REFRESH_ACTION, dismissible: true };
  }
  if (status.auth === 'signed-out' && /sign(ed)?[ -]?in/i.test(problem)) {
    return { slug: 'signed-out', level: 'error', action: SIGN_IN_ACTION, dismissible: false };
  }
  return { slug: 'other', level: 'warning', action: REFRESH_ACTION, dismissible: true };
}

export interface BannerInput {
  trusted: boolean;
  folderCount: number;
  provider: ProviderStatus | null;
}

/** The banners for the current conditions. Ids are stable so a later call replaces an earlier banner. */
export function computeBanners(input: BannerInput): Banner[] {
  const banners: Banner[] = [];
  if (!input.trusted) {
    banners.push({ id: 'untrusted', level: 'warning', text: TEXT.untrusted, dismissible: false });
  }
  if (input.folderCount === 0) {
    banners.push({ id: 'no-folder', level: 'info', text: TEXT.noFolder, dismissible: false });
  }
  const provider = input.provider;
  if (provider) {
    const seen = new Map<string, number>();
    for (const problem of provider.problems) {
      const kind = classify(provider, problem);
      const count = (seen.get(kind.slug) ?? 0) + 1;
      seen.set(kind.slug, count);
      banners.push({
        id:
          count === 1 ? `provider-problem:${kind.slug}` : `provider-problem:${kind.slug}-${count}`,
        level: kind.level,
        text: problem,
        ...(kind.action ? { action: { ...kind.action } } : {}),
        dismissible: kind.dismissible,
      });
    }
  }
  return banners;
}

/** What a dismissal is remembered by: the banner is shown again when its text changes. */
export function bannerKey(banner: Banner): string {
  return `${banner.id}\u0000${banner.text}`;
}
