/**
 * A hand-written scanner for a shell command line. It accepts only a small, fully understood subset
 * of the shell language, and says why when it meets anything else. Whatever the scanner accepts must
 * be read by bash and zsh exactly as it is read here, so every rule below closes a way for a word to
 * mean something other than its text.
 *
 * No `\s`, `trim()` or `split(/\s+/)` here: bash splits words on space and tab only, and those
 * helpers also split on NBSP and the other Unicode spaces.
 */

export type Separator = '&&' | '||' | '|' | ';';

/** One shell word, after quote removal. */
export interface Word {
  text: string;
  /** How many characters at the start of `text` came from unquoted source text. */
  unquotedPrefix: number;
  /** True when any part of the word was quoted. */
  quoted: boolean;
  /** Positions in `text` of the unquoted `* ? [ ]` characters: the shell would expand them. */
  globs: number[];
}

export interface SimpleCommand {
  /** The command name first. Redirections are validated and dropped. */
  words: Word[];
  /** What follows this command, or undefined for the last one. */
  separator: Separator | undefined;
}

export type Tokenized = { ok: true; commands: SimpleCommand[] } | { ok: false; reason: string };

export const MAX_LENGTH = 2000;
export const MAX_WORDS = 64;
export const MAX_COMMANDS = 16;

/**
 * Control and format characters. Git Bash deletes a CR even inside quotes (`'.<CR>.'` becomes `..`),
 * and zero-width or bidirectional characters hide what a word says. TAB is the one exception, and
 * only as an unquoted separator. Unpaired surrogates cannot be sent to a shell at all.
 */
const FORBIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const PLAIN = /^[A-Za-z0-9_./:=@%+,^-]$/;
const TILDE_AFTER = /^[A-Za-z0-9_^]$/;
const REVISION_BRACE = /^\{[A-Za-z0-9_-]+\}/;
const GLOB_CHARS = '*?[]';
const DEV_NULL = '/dev/null';

class Refusal extends Error {}

function refuse(code: string, detail?: string): never {
  throw new Refusal(detail === undefined ? code : `${code}:${detail}`);
}

function isBlank(char: string | undefined): boolean {
  return char === ' ' || char === '\t';
}

function isSeparatorStart(char: string | undefined): boolean {
  return char === '&' || char === '|' || char === ';';
}

class Scanner {
  private pos = 0;
  private words: Word[] = [];
  private wordCount = 0;
  private readonly commands: SimpleCommand[] = [];

  constructor(private readonly input: string) {}

  run(): SimpleCommand[] {
    while (this.pos < this.input.length) this.step();
    if (this.words.length === 0) {
      refuse('separator', this.commands.length === 0 ? 'empty command' : 'trailing separator');
    }
    this.endCommand(undefined);
    for (const command of this.commands) this.checkCommandName(command);
    return this.commands;
  }

  /** The loop is always at the start of a token here: words end only at a blank or a separator. */
  private step(): void {
    const char = this.input[this.pos];
    if (isBlank(char)) {
      this.pos += 1;
    } else if (char === '<') {
      refuse('redirection', '<');
    } else if (this.startsRedirection()) {
      this.redirection();
    } else if (isSeparatorStart(char)) {
      this.separator();
    } else {
      this.word();
    }
  }

  private startsRedirection(): boolean {
    const char = this.input[this.pos];
    const next = this.input[this.pos + 1];
    if (char === '>') return true;
    return (char === '&' || char === '1' || char === '2') && next === '>';
  }

  /**
   * Only `2>&1`, `>&2` and a write to `/dev/null` pass. Anything else would write a file, or write
   * to one named by the characters that follow (`>&2evil` writes the file `2evil`).
   */
  private redirection(): void {
    const rest = this.input.slice(this.pos);
    if (rest.startsWith('2>&1')) {
      this.pos += 4;
      this.endRedirection();
      return;
    }
    if (rest.startsWith('>&2')) {
      this.pos += 3;
      this.endRedirection();
      return;
    }
    const first = rest[0];
    this.pos += first === '>' ? 1 : 2;
    const after = this.input[this.pos];
    if (after === '>' || after === '|' || after === '&') refuse('redirection', rest.slice(0, 3));
    while (isBlank(this.input[this.pos])) this.pos += 1;
    if (!this.input.startsWith(DEV_NULL, this.pos)) refuse('redirection', 'not /dev/null');
    this.pos += DEV_NULL.length;
    this.endRedirection();
  }

  private endRedirection(): void {
    const next = this.input[this.pos];
    if (next !== undefined && !isBlank(next) && !isSeparatorStart(next)) {
      refuse('redirection', 'text after the redirection');
    }
  }

  private separator(): void {
    const two = this.input.slice(this.pos, this.pos + 2);
    let separator: Separator;
    if (two === '&&') separator = '&&';
    else if (two === '||') separator = '||';
    else if (two === '|&' || two === ';;') refuse('separator', two);
    else if (two[0] === '|') separator = '|';
    else if (two[0] === ';') separator = ';';
    else refuse('separator', '& (a background job)');
    if (this.words.length === 0) refuse('separator', 'empty command');
    this.pos += separator.length;
    this.endCommand(separator);
  }

  private endCommand(separator: Separator | undefined): void {
    if (this.commands.length >= MAX_COMMANDS) refuse('too-many-commands');
    this.commands.push({ words: this.words, separator });
    this.words = [];
  }

  private word(): void {
    const word: Word = { text: '', unquotedPrefix: 0, quoted: false, globs: [] };
    // The previous character, when it came from unquoted text; used by the `~` and `{` rules.
    let previous: string | undefined;
    while (this.pos < this.input.length) {
      const char = this.input[this.pos];
      if (char === undefined || isBlank(char) || isSeparatorStart(char)) break;
      if (char === "'") {
        this.singleQuoted(word);
        previous = undefined;
      } else if (char === '"') {
        this.doubleQuoted(word);
        previous = undefined;
      } else {
        previous = this.unquoted(word, previous);
      }
    }
    // zsh expands a word that starts with an unquoted `=` to the full path of a command.
    if (word.text.startsWith('=') && word.unquotedPrefix > 0) refuse('equals-word');
    this.wordCount += 1;
    if (this.wordCount > MAX_WORDS) refuse('too-many-words');
    this.words.push(word);
  }

  private unquoted(word: Word, previous: string | undefined): string {
    const char = this.input[this.pos] ?? '';
    if (char === '{') return this.revisionBrace(word, previous);
    if (char === '~') {
      // Bash expands a tilde at the start of a word and after `=` or `:`, never inside `HEAD~1`.
      if (previous === undefined || !TILDE_AFTER.test(previous)) refuse('tilde');
    } else if (GLOB_CHARS.includes(char)) {
      word.globs.push(word.text.length);
    } else if (!PLAIN.test(char)) {
      const shown = String.fromCodePoint(this.input.codePointAt(this.pos) ?? 0);
      refuse('unquoted-character', shown);
    }
    this.appendUnquoted(word, char);
    this.pos += 1;
    return char;
  }

  /** `@{u}`, `HEAD@{1}`, `stash@{0}`, `@{-1}`: a brace right after `@` with a plain name inside. */
  private revisionBrace(word: Word, previous: string | undefined): string {
    const match = REVISION_BRACE.exec(this.input.slice(this.pos));
    if (previous !== '@' || match === null) refuse('unquoted-character', '{');
    for (const char of match[0]) this.appendUnquoted(word, char);
    this.pos += match[0].length;
    return '}';
  }

  private appendUnquoted(word: Word, char: string): void {
    if (word.unquotedPrefix === word.text.length) word.unquotedPrefix += 1;
    word.text += char;
  }

  private singleQuoted(word: Word): void {
    const end = this.input.indexOf("'", this.pos + 1);
    if (end === -1) refuse('unterminated-quote');
    const content = this.input.slice(this.pos + 1, end);
    if (content.includes('\t')) refuse('control-character', 'TAB inside quotes');
    word.text += content;
    word.quoted = true;
    this.pos = end + 1;
  }

  /**
   * Inside double quotes `$` and the backtick still expand, so both are refused, escaped or not.
   * A backslash escapes only `"` and `\`; before anything else it stays, so `"a\|b"` is `a\|b`.
   */
  private doubleQuoted(word: Word): void {
    this.pos += 1;
    word.quoted = true;
    for (;;) {
      const char = this.input[this.pos];
      if (char === undefined) refuse('unterminated-quote');
      this.pos += 1;
      if (char === '"') return;
      if (char === '\t') refuse('control-character', 'TAB inside quotes');
      if (char === '$' || char === '`')
        refuse('unquoted-character', `${char} inside double quotes`);
      if (char !== '\\') {
        word.text += char;
        continue;
      }
      const escaped = this.input[this.pos];
      if (escaped === undefined) refuse('unterminated-quote');
      if (escaped === '$' || escaped === '`') {
        refuse('unquoted-character', `\\${escaped} inside double quotes`);
      }
      this.pos += 1;
      if (escaped === '\t') refuse('control-character', 'TAB inside quotes');
      word.text += escaped === '"' || escaped === '\\' ? escaped : `\\${escaped}`;
    }
  }

  /** The first word names the command: no quotes (so no `\ls` or `'ls'` tricks) and no `NAME=value`. */
  private checkCommandName(command: SimpleCommand): void {
    const name = command.words[0];
    if (name === undefined) refuse('separator', 'empty command');
    if (name.quoted) refuse('unknown-command', 'the command name is quoted');
    if (name.text.includes('=')) refuse('assignment', name.text);
  }
}

export function tokenize(input: string): Tokenized {
  if (input.length > MAX_LENGTH) return { ok: false, reason: 'too-long' };
  for (const char of input) {
    if (char !== '\t' && FORBIDDEN.test(char)) {
      const code = (char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0');
      return { ok: false, reason: `control-character:U+${code}` };
    }
  }
  try {
    return { ok: true, commands: new Scanner(input).run() };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, reason: error.message };
    throw error;
  }
}
