import { Fragment } from 'react';
import type { ReactNode } from 'react';

/** Bidirectional controls and zero-width characters: invisible, but they change how text reads or parses. */
const INVISIBLE = new RegExp(
  '([\\u202A-\\u202E\\u2066-\\u2069\\u200E\\u200F\\u061C\\u200B-\\u200D\\u2060\\uFEFF])',
);

const NAMES: Record<string, string> = {
  '202A': 'left-to-right embedding',
  '202B': 'right-to-left embedding',
  '202C': 'pop directional formatting',
  '202D': 'left-to-right override',
  '202E': 'right-to-left override',
  '2066': 'left-to-right isolate',
  '2067': 'right-to-left isolate',
  '2068': 'first strong isolate',
  '2069': 'pop directional isolate',
  '200E': 'left-to-right mark',
  '200F': 'right-to-left mark',
  '061C': 'arabic letter mark',
  '200B': 'zero width space',
  '200C': 'zero width non-joiner',
  '200D': 'zero width joiner',
  '2060': 'word joiner',
  FEFF: 'zero width no-break space',
};

export const INVISIBLE_WARNING =
  'This code contains invisible characters that can make it read differently from how it runs.';

export function hasInvisible(text: string): boolean {
  return INVISIBLE.test(text);
}

function codePoint(char: string): string {
  return (char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0');
}

/**
 * The text, with each invisible character replaced by a visible marker like ⟦U+202E⟧ and a title
 * that names it. Text without any is returned as it is.
 */
export function markInvisible(text: string, key = ''): ReactNode {
  if (!INVISIBLE.test(text)) return text;
  const parts = text.split(INVISIBLE);
  return (
    <Fragment key={key}>
      {parts.map((part, index) => {
        if (index % 2 === 0) return part === '' ? null : <Fragment key={index}>{part}</Fragment>;
        const hex = codePoint(part);
        return (
          <span
            key={index}
            className="invisible-char"
            title={`Invisible character U+${hex} (${NAMES[hex] ?? 'control character'})`}
          >
            {`⟦U+${hex}⟧`}
          </span>
        );
      })}
    </Fragment>
  );
}
