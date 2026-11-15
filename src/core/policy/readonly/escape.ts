/**
 * Control, bidirectional-override and invisible characters that must never reach a prompt as they
 * are: they can hide the end of a path, reorder a URL on screen or make two different texts look the
 * same. Newline and tab stay unless `lines` is set, so multi-line text reads.
 */
function mustEscape(code: number, lines: boolean): boolean {
  if (code === 0x0a || code === 0x09) return lines;
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0x200e ||
    code === 0x200f ||
    code === 0x061c ||
    code === 0x2028 ||
    code === 0x2029 ||
    (code >= 0x200b && code <= 0x200d) ||
    code === 0x2060 ||
    code === 0xfeff ||
    code === 0x00ad ||
    // Combining grapheme joiner, Mongolian vowel separator, invisible operators, variation
    // selectors and tag characters: invisible, and they make different texts look equal.
    code === 0x034f ||
    code === 0x180e ||
    (code >= 0x2061 && code <= 0x2064) ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    (code >= 0xe0000 && code <= 0xe007f)
  );
}

function escapeBy(text: string, lines: boolean): string {
  let out = '';
  // By code point, so that a character outside the basic plane is tested whole.
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    out += mustEscape(code, lines)
      ? `\\u{${code.toString(16).toUpperCase().padStart(4, '0')}}`
      : char;
  }
  return out;
}

/**
 * Replaces C0 and C1 controls (except newline and tab), bidi controls, line and paragraph
 * separators, zero-width and other invisible characters, the word joiner, the byte order mark and the
 * soft hyphen with `\u{XXXX}`.
 */
export function escapeForDisplay(text: string): string {
  return escapeBy(text, false);
}

/**
 * Like `escapeForDisplay`, and newline and tab are written out too, so that the text is one line and
 * two texts that differ only by a line break stay different.
 */
export function escapeOneLine(text: string): string {
  return escapeBy(text, true);
}

/** A name from the provider, cut to `max` characters and made safe to put into a message. */
export function displayName(name: string, max = 60): string {
  return escapeForDisplay(name.slice(0, max));
}
