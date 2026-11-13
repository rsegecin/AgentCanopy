import hljs from 'highlight.js/lib/common';
import { memo, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from '../../app/components';
import { usePost } from '../../app/context';
import { fragmentToReact } from './dom-to-react';
import { INVISIBLE_WARNING, hasInvisible, markInvisible } from './invisible';
import { sanitizeHighlightHtml } from './sanitize';

/** Highlighting a huge block on every streamed token would stall the view. */
const MAX_HIGHLIGHT_CHARS = 20_000;

function highlight(code: string, language: string): ReactNode[] | null {
  if (language === '' || code.length > MAX_HIGHLIGHT_CHARS) return null;
  const name = language.toLowerCase();
  if (!hljs.getLanguage(name)) return null;
  try {
    const { value } = hljs.highlight(code, { language: name, ignoreIllegals: true });
    // highlight.js escapes its input, but its output is still untrusted text to this view.
    return fragmentToReact(sanitizeHighlightHtml(value), { text: markInvisible });
  } catch {
    return null;
  }
}

export interface CodeBlockProps {
  /** The fence's info string, first word. Empty for an unlabelled fence. */
  language: string;
  code: string;
}

export const CodeBlock = memo(function CodeBlock({ language, code }: CodeBlockProps) {
  const post = usePost();
  const [copied, setCopied] = useState(false);
  const highlighted = useMemo(() => highlight(code, language), [code, language]);
  const label = language === '' ? 'text' : language.slice(0, 30);
  const warn = useMemo(() => hasInvisible(code), [code]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => {
      setCopied(false);
    }, 1500);
    return () => {
      clearTimeout(timer);
    };
  }, [copied]);

  return (
    <div className="code-block">
      {warn && (
        <p className="code-warning" role="note">
          <Icon name="warning" />
          <span>{INVISIBLE_WARNING}</span>
        </p>
      )}
      <div className="code-block-header">
        <span className="code-block-language">{label}</span>
        <button
          type="button"
          className="code-block-copy"
          aria-label={copied ? 'Copied' : `Copy ${label} code`}
          onClick={() => {
            post({ type: 'clipboard.copy', text: code });
            setCopied(true);
          }}
        >
          <Icon name={copied ? 'check' : 'copy'} />
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <pre className="code-block-pre" tabIndex={0} role="group" aria-label={`${label} code`}>
        <code className="hljs">{highlighted ?? markInvisible(code)}</code>
      </pre>
    </div>
  );
});
