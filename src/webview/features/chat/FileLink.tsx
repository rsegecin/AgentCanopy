import type { KeyboardEvent } from 'react';
import { usePost } from '../../app/context';

export interface FileTarget {
  path: string;
  /** First line to reveal, when known. */
  line?: number;
}

/** A workspace path that opens in the editor. Shown as plain text when the path cannot be opened. */
export function FileLink({ target, className }: { target: FileTarget; className?: string }) {
  const post = usePost();
  if (target.path === '' || target.path.length > 4096) {
    return <span className={className}>{target.path}</span>;
  }
  const open = () => {
    post({
      type: 'open.file',
      path: target.path,
      ...(target.line !== undefined ? { line: target.line } : {}),
    });
  };
  const where = target.line !== undefined ? ` at line ${String(target.line)}` : '';
  return (
    <span
      className={`md-file-link${className ? ` ${className}` : ''}`}
      role="link"
      tabIndex={0}
      title={`Open ${target.path}${where}`}
      onClick={(event) => {
        event.preventDefault();
        open();
      }}
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          open();
        }
      }}
    >
      {target.path}
    </span>
  );
}
