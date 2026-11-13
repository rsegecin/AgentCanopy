import { homedir } from 'node:os';

/*
 * Redaction for log lines and error reports.
 *
 * Every pass is linear in the text length: no regular expression has a nested or leading
 * unbounded quantifier. Passes either look for fixed literals (indexOf or a literal-only regex)
 * and then scan the characters around the hit with a hard bound, or consume a whole run of
 * characters once and continue after it.
 */

const REDACTED = '[redacted]';

type Predicate = (code: number) => boolean;

const isDigit: Predicate = (c) => c >= 48 && c <= 57;
const isAsciiLetter: Predicate = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isAsciiAlnum: Predicate = (c) => isDigit(c) || isAsciiLetter(c);
/** [A-Za-z0-9_-] */
const isTokenChar: Predicate = (c) => isAsciiAlnum(c) || c === 95 || c === 45;
/** [A-Za-z0-9_] */
const isWordChar: Predicate = (c) => isAsciiAlnum(c) || c === 95;
const isBearerChar: Predicate = (c) =>
  isAsciiAlnum(c) || '._~+/=-'.includes(String.fromCharCode(c));
const isBase64Char: Predicate = (c) => isAsciiAlnum(c) || c === 43 || c === 47 || c === 61;
const isHighSurrogate = (c: number): boolean => c >= 0xd800 && c <= 0xdfff;
const UNICODE_ALNUM = /^[\p{L}\p{N}\p{M}]$/u;

/** Letters, digits and marks of any script. Surrogate halves count, so astral letters are covered. */
function isUnicodeAlnum(c: number): boolean {
  if (c < 128) return isAsciiAlnum(c);
  return isHighSurrogate(c) || UNICODE_ALNUM.test(String.fromCharCode(c));
}

function runEnd(text: string, from: number, accepts: Predicate): number {
  let end = from;
  while (end < text.length && accepts(text.charCodeAt(end))) end += 1;
  return end;
}

/** Collects replacements over non-overlapping, ascending ranges. */
class Rewriter {
  private readonly parts: string[] = [];
  private last = 0;
  constructor(private readonly text: string) {}
  /** Start of the text not yet copied. Scans must not reach back before it. */
  get floor(): number {
    return this.last;
  }
  replace(start: number, end: number, replacement: string): void {
    this.parts.push(this.text.slice(this.last, start), replacement);
    this.last = end;
  }
  result(): string {
    if (this.last === 0 && this.parts.length === 0) return this.text;
    this.parts.push(this.text.slice(this.last));
    return this.parts.join('');
  }
}

// ---- PEM blocks ----

function redactPem(text: string): string {
  let at = text.indexOf('-----BEGIN ');
  if (at < 0) return text;
  const out = new Rewriter(text);
  while (at >= 0) {
    let end = text.length;
    const endMark = text.indexOf('-----END ', at + 11);
    if (endMark >= 0) {
      const close = text.indexOf('-----', endMark + 9);
      if (close >= 0) end = close + 5;
    }
    out.replace(at, end, REDACTED);
    at = end >= text.length ? -1 : text.indexOf('-----BEGIN ', end);
  }
  return out.result();
}

// ---- user info in URLs ----

const USERINFO_LIMIT = 512;
const NOT_USERINFO = new Set([...'/?#"\'<>@\\[]`'].map((c) => c.charCodeAt(0)));

function isUserInfoChar(c: number): boolean {
  return c > 32 && c !== 127 && !NOT_USERINFO.has(c);
}

function redactUrlUserInfo(text: string): string {
  let at = text.indexOf('://');
  if (at < 0) return text;
  const out = new Rewriter(text);
  while (at >= 0) {
    const start = at + 3;
    const limit = Math.min(text.length, start + USERINFO_LIMIT);
    let end = start;
    while (end < limit && isUserInfoChar(text.charCodeAt(end))) end += 1;
    if (end > start && end < limit && text.charCodeAt(end) === 64) {
      out.replace(start, end, REDACTED);
    }
    at = text.indexOf('://', Math.max(end, start));
  }
  return out.result();
}

// ---- Bearer and Basic values ----

function redactAuthValues(text: string): string {
  const scheme = /\b(bearer|basic)[ \t]+/gi;
  const out = new Rewriter(text);
  let match = scheme.exec(text);
  while (match) {
    const start = match.index + match[0].length;
    const bearer = (match[1] ?? '').toLowerCase() === 'bearer';
    const end = runEnd(text, start, bearer ? isBearerChar : isBase64Char);
    // Basic is an ordinary word too: only a base64-looking value with a digit or padding counts.
    const plausible = bearer || /[0-9=+/]/.test(text.slice(start, end));
    if (end - start >= 8 && plausible) out.replace(start, end, REDACTED);
    scheme.lastIndex = Math.max(end, scheme.lastIndex);
    match = scheme.exec(text);
  }
  return out.result();
}

// ---- token shapes ----

const TOKEN_START = /sk-|gh[pousr]_|github_pat_|xox[abprs]-|AKIA|eyJ|\/hook\/|\/mcp\//g;

function redactTokens(text: string): string {
  const start = new RegExp(TOKEN_START.source, 'g');
  const out = new Rewriter(text);
  let match = start.exec(text);
  while (match) {
    const at = match.index;
    const prefix = match[0];
    const bodyStart = at + prefix.length;
    let from = at;
    let end = -1;
    let resume = at + 1;
    if (prefix === 'sk-') {
      const anthropic = text.startsWith('sk-ant-', at);
      const bodyFrom = anthropic ? at + 7 : bodyStart;
      const bodyEnd = runEnd(text, bodyFrom, isTokenChar);
      const boundary = at === 0 || !isWordChar(text.charCodeAt(at - 1));
      if (anthropic && bodyEnd - bodyFrom >= 8) end = bodyEnd;
      else if (boundary && runEnd(text, bodyStart, isTokenChar) - bodyStart >= 20) {
        end = runEnd(text, bodyStart, isTokenChar);
      }
    } else if (prefix.startsWith('gh')) {
      const bodyEnd = runEnd(text, bodyStart, isWordChar);
      if (bodyEnd - bodyStart >= 16) end = bodyEnd;
    } else if (prefix === 'github_pat_') {
      const bodyEnd = runEnd(text, bodyStart, isWordChar);
      if (bodyEnd - bodyStart >= 20) end = bodyEnd;
    } else if (prefix.startsWith('xox')) {
      const bodyEnd = runEnd(text, bodyStart, (c) => isAsciiAlnum(c) || c === 45);
      if (bodyEnd - bodyStart >= 8) end = bodyEnd;
    } else if (prefix === 'AKIA') {
      const upper: Predicate = (c) => isDigit(c) || (c >= 65 && c <= 90);
      const bodyEnd = runEnd(text, bodyStart, upper);
      const boundary = at === 0 || !upper(text.charCodeAt(at - 1));
      if (boundary && bodyEnd - bodyStart >= 16) end = bodyStart + 16;
    } else if (prefix === 'eyJ') {
      // Three base64url segments. A failure skips the whole run so overlapping starts stay cheap.
      const first = runEnd(text, bodyStart, isTokenChar);
      resume = Math.max(resume, first);
      if (first - bodyStart >= 8 && text.charCodeAt(first) === 46) {
        const second = runEnd(text, first + 1, isTokenChar);
        resume = Math.max(resume, second);
        if (second - first - 1 >= 8 && text.charCodeAt(second) === 46) {
          const third = runEnd(text, second + 1, isTokenChar);
          resume = Math.max(resume, third);
          if (third - second - 1 >= 4) end = third;
        }
      }
    } else {
      // /hook/<secret> and /mcp/<route>: the path segment is a credential. Keep the prefix.
      const bodyEnd = runEnd(text, bodyStart, isTokenChar);
      if (bodyEnd - bodyStart >= 20) {
        from = bodyStart;
        end = bodyEnd;
      }
    }
    if (end >= 0 && from >= out.floor) {
      out.replace(from, end, REDACTED);
      start.lastIndex = end;
    } else {
      start.lastIndex = resume;
    }
    match = start.exec(text);
  }
  return out.result();
}

// ---- NAME=value ----

const SECRET_NAME = /token|secret|key|password|auth/i;
const NAME_LIMIT = 64;
const isNameChar: Predicate = (c) => isAsciiAlnum(c) || c === 95 || c === 46 || c === 45;

function isAssignedValueChar(c: number): boolean {
  return c > 32 && c !== 127 && c !== 34 && c !== 39 && c !== 38;
}

function redactNamedSecrets(text: string): string {
  let eq = text.indexOf('=');
  if (eq < 0) return text;
  const out = new Rewriter(text);
  while (eq >= 0) {
    let nameStart = eq;
    while (
      nameStart > out.floor &&
      eq - nameStart < NAME_LIMIT &&
      isNameChar(text.charCodeAt(nameStart - 1))
    ) {
      nameStart -= 1;
    }
    let next = eq + 1;
    if (nameStart < eq && SECRET_NAME.test(text.slice(nameStart, eq))) {
      let valueStart = eq + 1;
      const quote = text.charCodeAt(valueStart);
      if (quote === 34 || quote === 39) valueStart += 1;
      const valueEnd = runEnd(text, valueStart, isAssignedValueChar);
      if (valueEnd > valueStart) {
        out.replace(valueStart, valueEnd, REDACTED);
        next = valueEnd;
      }
    }
    eq = text.indexOf('=', next);
  }
  return out.result();
}

// ---- e-mail addresses ----

const LOCAL_LIMIT = 64;
const DOMAIN_LIMIT = 255;
const TLD = /^\p{L}[\p{L}\p{N}-]+$/u;

function isLocalChar(c: number): boolean {
  // . _ % + - '
  return isUnicodeAlnum(c) || c === 46 || c === 95 || c === 37 || c === 43 || c === 45 || c === 39;
}

function isDomainChar(c: number): boolean {
  return isUnicodeAlnum(c) || c === 46 || c === 45;
}

/** Finds `@` and `%40`, expands both sides within bounds, and checks the domain ends in a TLD. */
function redactEmails(text: string): string {
  let nextAt = text.indexOf('@');
  let nextEncoded = text.indexOf('%40');
  if (nextAt < 0 && nextEncoded < 0) return text;
  const out = new Rewriter(text);
  let from = 0;
  while (nextAt >= 0 || nextEncoded >= 0) {
    if (nextAt >= 0 && nextAt < from) nextAt = text.indexOf('@', from);
    if (nextEncoded >= 0 && nextEncoded < from) nextEncoded = text.indexOf('%40', from);
    let at: number;
    let sepLength: number;
    if (nextAt >= 0 && (nextEncoded < 0 || nextAt < nextEncoded)) {
      at = nextAt;
      sepLength = 1;
    } else if (nextEncoded >= 0) {
      at = nextEncoded;
      sepLength = 3;
    } else {
      break;
    }
    from = at + 1;

    let localStart = at;
    while (
      localStart > out.floor &&
      at - localStart < LOCAL_LIMIT &&
      isLocalChar(text.charCodeAt(localStart - 1))
    ) {
      localStart -= 1;
    }
    const domainStart = at + sepLength;
    let domainEnd = domainStart;
    while (
      domainEnd < text.length &&
      domainEnd - domainStart < DOMAIN_LIMIT &&
      isDomainChar(text.charCodeAt(domainEnd))
    ) {
      domainEnd += 1;
    }
    while (domainEnd > domainStart && [45, 46].includes(text.charCodeAt(domainEnd - 1))) {
      domainEnd -= 1;
    }
    let lastDot = -1;
    for (let i = domainEnd - 1; i > domainStart; i -= 1) {
      if (text.charCodeAt(i) === 46) {
        lastDot = i;
        break;
      }
    }
    if (localStart < at && lastDot > domainStart && TLD.test(text.slice(lastDot + 1, domainEnd))) {
      out.replace(localStart, domainEnd, REDACTED);
      from = domainEnd;
    }
  }
  return out.result();
}

// ---- home directory ----

export interface RedactEnvironment {
  /** The user's home directory. */
  home: string;
  platform: NodeJS.Platform;
}

interface HomePattern {
  /** The path starts with a separator (POSIX absolute). */
  leadingSeparator: boolean;
  /** Per path segment: the spellings accepted (raw and URI-encoded). */
  segments: { exact: string; lower: string }[][];
}

interface HomeMatcher {
  caseInsensitive: boolean;
  patterns: HomePattern[];
  /** Spellings of the dashed folder name Claude Code derives from the path. */
  dashed: { exact: string; lower: string }[];
  /** Code units a match can start with. */
  starts: Set<number>;
}

function spellings(raw: string): { exact: string; lower: string }[] {
  const encoded = encodeURIComponent(raw);
  const encodedLower = encoded.replace(/%[0-9A-F]{2}/g, (h) => h.toLowerCase());
  return [...new Set([raw, encoded, encodedLower])].map((exact) => ({
    exact,
    lower: exact.toLowerCase(),
  }));
}

const matcherCache = new Map<string, HomeMatcher | null>();

function buildHomeMatcher(env: RedactEnvironment): HomeMatcher | null {
  const { home, platform } = env;
  if (home.length <= 1) return null;
  const parts = home.split(/[\\/]+/);
  const leadingSeparator = parts[0] === '';
  const names = parts.filter((p) => p !== '');
  if (names.length === 0) return null;
  const caseInsensitive = platform === 'win32' || platform === 'darwin';

  const patterns: HomePattern[] = [{ leadingSeparator, segments: names.map(spellings) }];
  const drive = /^([A-Za-z]):$/.exec(names[0] ?? '');
  if (drive?.[1]) {
    // The same folder as seen from WSL.
    patterns.push({
      leadingSeparator: true,
      segments: [
        spellings('mnt'),
        spellings(drive[1].toLowerCase()),
        ...names.slice(1).map(spellings),
      ],
    });
  }
  const dashedForms = new Set([home.replace(/[\\/:]/g, '-'), home.replace(/[^A-Za-z0-9]/g, '-')]);
  const dashed = [...dashedForms].map((exact) => ({ exact, lower: exact.toLowerCase() }));

  const starts = new Set<number>();
  const addStart = (s: string): void => {
    const first = s.charAt(0);
    starts.add(first.charCodeAt(0));
    if (caseInsensitive) {
      starts.add(first.toLowerCase().charCodeAt(0));
      starts.add(first.toUpperCase().charCodeAt(0));
    }
  };
  for (const pattern of patterns) {
    if (pattern.leadingSeparator) {
      for (const sep of ['/', '\\', '%']) addStart(sep);
    } else {
      for (const spelling of pattern.segments[0] ?? []) addStart(spelling.exact);
    }
  }
  for (const spelling of dashed) addStart(spelling.exact);
  return { caseInsensitive, patterns, dashed, starts };
}

function homeMatcher(env: RedactEnvironment): HomeMatcher | null {
  const key = `${env.platform}\0${env.home}`;
  let matcher = matcherCache.get(key);
  if (matcher === undefined) {
    matcher = buildHomeMatcher(env);
    if (matcherCache.size > 8) matcherCache.clear();
    matcherCache.set(key, matcher);
  }
  return matcher;
}

function matchSpelling(
  text: string,
  at: number,
  options: { exact: string; lower: string }[],
  caseInsensitive: boolean,
): number {
  for (const option of options) {
    const end = at + option.exact.length;
    if (end > text.length) continue;
    const slice = text.slice(at, end);
    if (caseInsensitive ? slice.toLowerCase() === option.lower : slice === option.exact) return end;
  }
  return -1;
}

/** A path separator in any spelling: / \ \\ (escaped in JSON) %2F %5C. Returns the end, or -1. */
function matchSeparator(text: string, at: number): number {
  const c = text.charAt(at);
  if (c === '/') return at + 1;
  if (c === '\\') return text.charAt(at + 1) === '\\' ? at + 2 : at + 1;
  if (c === '%') {
    const code = text.slice(at + 1, at + 3).toUpperCase();
    if (code === '2F') return at + 3;
    if (code === '5C')
      return text.startsWith('%5C', at + 3) || text.startsWith('%5c', at + 3) ? at + 6 : at + 3;
  }
  return -1;
}

/** True when the text continues the last path segment, so `/Users/alice2` is another user. */
function continuesName(text: string, at: number): boolean {
  if (at >= text.length) return false;
  const c = text.charCodeAt(at);
  if (c === 37) {
    const code = text.slice(at + 1, at + 3).toUpperCase();
    return /^[0-9A-F]{2}$/.test(code) && code !== '2F' && code !== '5C';
  }
  return isUnicodeAlnum(c) || c === 95 || c === 45;
}

function matchHomePath(
  text: string,
  at: number,
  matcher: HomeMatcher,
  pattern: HomePattern,
): number {
  let position = at;
  if (pattern.leadingSeparator) {
    position = matchSeparator(text, position);
    if (position < 0) return -1;
  }
  for (let i = 0; i < pattern.segments.length; i += 1) {
    if (i > 0) {
      position = matchSeparator(text, position);
      if (position < 0) return -1;
    }
    position = matchSpelling(text, position, pattern.segments[i] ?? [], matcher.caseInsensitive);
    if (position < 0) return -1;
  }
  return continuesName(text, position) ? -1 : position;
}

function redactHome(text: string, env: RedactEnvironment): string {
  const matcher = homeMatcher(env);
  if (!matcher) return text;
  const out = new Rewriter(text);
  let i = 0;
  while (i < text.length) {
    if (!matcher.starts.has(text.charCodeAt(i))) {
      i += 1;
      continue;
    }
    let end = -1;
    for (const pattern of matcher.patterns) {
      end = Math.max(end, matchHomePath(text, i, matcher, pattern));
    }
    if (end < 0) {
      // The dashed folder name must not start in the middle of a word.
      const before = i > 0 ? text.charCodeAt(i - 1) : 0;
      if (i === 0 || !isUnicodeAlnum(before)) {
        const dashedEnd = matchSpelling(text, i, matcher.dashed, matcher.caseInsensitive);
        if (
          dashedEnd >= 0 &&
          !(dashedEnd < text.length && isUnicodeAlnum(text.charCodeAt(dashedEnd)))
        ) {
          end = dashedEnd;
        }
      }
    }
    if (end > i) {
      out.replace(i, end, '~');
      i = end;
    } else {
      i += 1;
    }
  }
  return out.result();
}

// ---- public API ----

/** Redacts with an explicit home directory and platform. `redact` uses the real ones. */
export function redactWith(text: string, env: RedactEnvironment): string {
  let out = redactPem(text);
  out = redactUrlUserInfo(out);
  out = redactAuthValues(out);
  out = redactTokens(out);
  out = redactNamedSecrets(out);
  out = redactEmails(out);
  return redactHome(out, env);
}

/**
 * Removes things that must never reach a log: tokens, keys, credentials in URLs, email addresses,
 * and the home directory (in its path, URI and dashed spellings).
 */
export function redact(text: string): string {
  return redactWith(text, { home: homedir(), platform: process.platform });
}

/** Keeps the last `max` characters of a text, for bounded error reports. */
export function tail(text: string, max: number): string {
  return text.length <= max ? text : text.slice(text.length - max);
}
