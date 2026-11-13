import { describe, expect, it } from 'vitest';
import { displayName, escapeForDisplay } from './escape';

describe('escapeForDisplay', () => {
  it('leaves plain text, newline and tab alone', () => {
    expect(escapeForDisplay('src/a b/ü.ts\n\tok')).toBe('src/a b/ü.ts\n\tok');
  });

  it('escapes C0 and C1 controls', () => {
    expect(escapeForDisplay('a\u0000b\u001bc\rd\u007fe\u0085f\u009fg')).toBe(
      'a\\u{0000}b\\u{001B}c\\u{000D}d\\u{007F}e\\u{0085}f\\u{009F}g',
    );
  });

  it('escapes bidirectional controls', () => {
    const all = [
      0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f,
      0x061c,
    ];
    for (const code of all) {
      const escaped = escapeForDisplay(`x${String.fromCharCode(code)}y`);
      expect(escaped).toBe(`x\\u{${code.toString(16).toUpperCase().padStart(4, '0')}}y`);
    }
  });

  it('escapes line and paragraph separators, zero-width characters and the soft hyphen', () => {
    for (const code of [0x2028, 0x2029, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x00ad]) {
      const escaped = escapeForDisplay(`x${String.fromCharCode(code)}y`);
      expect(escaped).toBe(`x\\u{${code.toString(16).toUpperCase().padStart(4, '0')}}y`);
    }
  });

  it('does not touch characters next to the ranges', () => {
    const plain = '\u00a0\u202f\u2065\u206a\u2061\u200a\u00ae';
    expect(escapeForDisplay(plain)).toBe(plain);
  });
});

describe('displayName', () => {
  it('cuts to 60 characters and escapes', () => {
    expect(displayName('a'.repeat(100))).toBe('a'.repeat(60));
    expect(displayName('x‮y')).toBe('x\\u{202E}y');
  });
});
