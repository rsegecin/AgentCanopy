import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { usePost } from '../../app/context';
import { markInvisible } from './invisible';
import { parseWorkspacePath } from './paths';
import type { FileTarget } from './paths';

const EXTERNAL = /^(?:https?:|mailto:)/i;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export type LinkTarget =
  { kind: 'external'; url: string } | { kind: 'file'; file: FileTarget } | { kind: 'none' };

/** What a link may do. Everything that is neither http(s)/mailto nor a workspace path does nothing. */
export function classifyHref(href: string | null): LinkTarget {
  if (href === null) return { kind: 'none' };
  const value = href.trim();
  if (EXTERNAL.test(value)) {
    return value.length <= 4096 ? { kind: 'external', url: value } : { kind: 'none' };
  }
  if (HAS_SCHEME.test(value) || value.startsWith('//') || value.startsWith('\\')) {
    return { kind: 'none' };
  }
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // keep the raw value
  }
  const file = parseWorkspacePath(decoded);
  return file ? { kind: 'file', file } : { kind: 'none' };
}

function useActivate(target: LinkTarget) {
  const post = usePost();
  const activate = () => {
    if (target.kind === 'external') post({ type: 'open.link', url: target.url });
    else if (target.kind === 'file') {
      post({
        type: 'open.file',
        path: target.file.path,
        ...(target.file.line !== undefined ? { line: target.file.line } : {}),
      });
    }
  };
  return {
    onClick: (event: MouseEvent) => {
      // Links never navigate the webview itself.
      event.preventDefault();
      activate();
    },
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        activate();
      }
    },
  };
}

export function MdLink({
  href,
  title,
  children,
}: {
  href: string | null;
  title: string | null;
  children: ReactNode;
}) {
  const target = classifyHref(href);
  const handlers = useActivate(target);
  if (target.kind === 'none') return <span>{children}</span>;
  if (target.kind === 'external') {
    return (
      <a
        href={target.url}
        title={title ?? target.url}
        rel="noopener noreferrer"
        onClick={handlers.onClick}
      >
        {children}
      </a>
    );
  }
  // A workspace path: no href, so there is nothing for the webview to navigate to.
  return (
    <span
      className="md-file-link"
      role="link"
      tabIndex={0}
      title={title ?? `Open ${target.file.path}`}
      onClick={handlers.onClick}
      onKeyDown={handlers.onKeyDown}
    >
      {children}
    </span>
  );
}

export function MdInlineCode({ text }: { text: string }) {
  const file = parseWorkspacePath(text);
  const target: LinkTarget = file ? { kind: 'file', file } : { kind: 'none' };
  const handlers = useActivate(target);
  if (!file) return <code className="md-code">{markInvisible(text)}</code>;
  const where = file.line !== undefined ? ` at line ${String(file.line)}` : '';
  return (
    <code
      className="md-code md-file-link"
      role="link"
      tabIndex={0}
      aria-label={`Open ${file.path}${where}`}
      onClick={handlers.onClick}
      onKeyDown={handlers.onKeyDown}
    >
      {text}
    </code>
  );
}
