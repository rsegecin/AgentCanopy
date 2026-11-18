/**
 * A parser for the small part of the sed language that only prints: `p`, `d`, `q`, `=` and
 * `s/RE/REPL/FLAGS`, each with an optional address, joined by `;`. Everything that can write a file
 * or run a program (`w`, `e`, `r`, `R`, `W`, `F`, the `e` and `w` flags of `s`) is a parse error.
 *
 * Text is cut into pieces the way GNU sed (and BSD sed) cuts it. In every piece a backslash takes
 * the next character, and an unescaped `/` ends the piece. In a regular expression (the `/RE/` of an
 * address and the RE of `s`) an unescaped `[` also starts a bracket expression, inside which a `/`
 * does not end the piece and a backslash is an ordinary character. The replacement has no brackets.
 * Cutting a piece anywhere else than sed does would let a hidden `w file` or `e` flag through:
 * `s/[/]/;p;s/w../../g` is one substitution with the flag `w ../../g`.
 */

const FLAGS = /^[gpiI0-9]*/;
const DIGITS = /^\d+/;

/**
 * Just past the bracket expression whose `[` is at `from`, or -1 when it is not closed. POSIX rules:
 * one optional `^`, then a `]` right there is a literal; the first later `]` closes it; `[:`, `[.`
 * and `[=` must be closed by `:]`, `.]` and `=]`; a backslash is an ordinary character.
 */
function endOfBracket(script: string, from: number): number {
  let i = from + 1;
  if (script[i] === '^') i += 1;
  if (script[i] === ']') i += 1;
  while (i < script.length) {
    const char = script[i];
    if (char === ']') return i + 1;
    const next = script[i + 1];
    if (char === '[' && (next === ':' || next === '.' || next === '=')) {
      const close = script.indexOf(`${next}]`, i + 2);
      if (close === -1) return -1;
      i = close + 2;
    } else {
      i += 1;
    }
  }
  return -1;
}

/**
 * Where a piece that starts after its opening `/` ends, just past the closing `/`; -1 if none.
 * Only a `regex` piece has bracket expressions.
 */
function endOfPiece(script: string, from: number, regex: boolean): number {
  let i = from;
  while (i < script.length) {
    const char = script[i];
    if (char === '/') return i + 1;
    if (char === '[' && regex) {
      i = endOfBracket(script, i);
      if (i === -1) return -1;
    } else {
      i += char === '\\' ? 2 : 1;
    }
  }
  return -1;
}

function skipSpaces(script: string, from: number): number {
  let i = from;
  while (script[i] === ' ') i += 1;
  return i;
}

/** The index just past an address (`12`, `$` or `/RE/`) at `from`, or -1 when there is none. */
function endOfAddress(script: string, from: number): number {
  if (script[from] === '$') return from + 1;
  if (script[from] === '/') return endOfPiece(script, from + 1, true);
  const digits = DIGITS.exec(script.slice(from));
  return digits === null ? -1 : from + digits[0].length;
}

/** The index just past the whole address part, `-1` for a bad one, and `from` for none. */
function endOfAddresses(script: string, from: number): number {
  const first = endOfAddress(script, from);
  if (first === -1) return /^[$/\d]/.test(script.slice(from, from + 1)) ? -1 : from;
  if (script[first] !== ',') return first;
  if (script[first + 1] === '+') {
    const digits = DIGITS.exec(script.slice(first + 2));
    return digits === null ? -1 : first + 2 + digits[0].length;
  }
  return endOfAddress(script, first + 1);
}

/** The index just past `s/RE/REPL/FLAGS` whose `s` is at `from`, or -1. */
function endOfSubstitution(script: string, from: number): number {
  if (script[from + 1] !== '/') return -1;
  const afterRegex = endOfPiece(script, from + 2, true);
  if (afterRegex === -1) return -1;
  const afterReplacement = endOfPiece(script, afterRegex, false);
  if (afterReplacement === -1) return -1;
  const flags = FLAGS.exec(script.slice(afterReplacement));
  return afterReplacement + (flags?.[0].length ?? 0);
}

/** The index just past one command, or -1. */
function endOfCommand(script: string, from: number): number {
  const addressEnd = endOfAddresses(script, from);
  if (addressEnd === -1) return -1;
  const command = script[addressEnd];
  if (command === 'p' || command === 'd' || command === 'q' || command === '=') {
    return addressEnd + 1;
  }
  return command === 's' ? endOfSubstitution(script, addressEnd) : -1;
}

/** True when the script uses only the commands above. An empty script is refused. */
export function isPrintOnlySedScript(script: string): boolean {
  let i = skipSpaces(script, 0);
  let commands = 0;
  while (i < script.length) {
    const end = endOfCommand(script, i);
    if (end === -1) return false;
    commands += 1;
    i = skipSpaces(script, end);
    if (i >= script.length) break;
    if (script[i] !== ';') return false;
    i = skipSpaces(script, i + 1);
  }
  return commands > 0;
}
