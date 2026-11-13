import { Fragment } from 'react';
import { VisuallyHidden } from '../../app/components';
import { blankRuns, commandLines } from './command-lines';
import { markInvisible } from './invisible';

/**
 * A command as typed: every line break shows as a dim marker (and is read out as "line break"),
 * and a long run of blank lines is counted. Nothing is collapsed or cut, so a second command
 * cannot hide below the first.
 */
export function CommandText({ text }: { text: string }) {
  const lines = commandLines(text);
  if (lines.length === 1) return <>{markInvisible(lines[0] ?? '')}</>;
  const runs = blankRuns(lines);
  return (
    <>
      {lines.map((line, index) => (
        <Fragment key={index}>
          {markInvisible(line)}
          {runs.has(index) && (
            <span className="cmd-blank">{`[${String(runs.get(index))} blank lines]`}</span>
          )}
          {index < lines.length - 1 && (
            <>
              <span className="cmd-eol" aria-hidden="true">
                {'⏎'}
              </span>
              <VisuallyHidden> line break </VisuallyHidden>
              {'\n'}
            </>
          )}
        </Fragment>
      ))}
    </>
  );
}

/** "This command has N lines…" for a command of more than one line, otherwise nothing. */
export function CommandLinesWarning({ text }: { text: string }) {
  const count = commandLines(text).length;
  if (count < 2) return null;
  return (
    <p className="cmd-warning" role="note">
      This command has {count} lines. Check all of them before allowing it.
    </p>
  );
}
