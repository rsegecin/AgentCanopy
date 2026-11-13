/**
 * Control and bidirectional-override characters that must never reach a prompt as they are: they can
 * hide the end of a path or reorder a URL on screen. Newline and tab stay, so multi-line text reads.
 */
function mustEscape(code: number): boolean {
  if (code === 0x0a || code === 0x09) return false;
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
    code === 0x00ad
  );
}

/**
 * Replaces C0 and C1 controls (except newline and tab), bidi controls, line and paragraph
 * separators, zero-width characters, the word joiner, the byte order mark and the soft hyphen with
 * `\u{XXXX}`.
 */
export function escapeForDisplay(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    out += mustEscape(code)
      ? `\\u{${code.toString(16).toUpperCase().padStart(4, '0')}}`
      : (text[i] as string);
  }
  return out;
}

/** A name from the provider, cut to `max` characters and made safe to put into a message. */
export function displayName(name: string, max = 60): string {
  return escapeForDisplay(name.slice(0, max));
}
