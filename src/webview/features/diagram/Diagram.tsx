import { memo, useLayoutEffect, useRef, useState } from 'react';
import { CodeBlock } from '../chat/CodeBlock';
import {
  MAX_DIAGRAM_CHARS,
  insertSanitizedSvg,
  renderMermaid,
  useThemeVersion,
} from './mermaid-render';

export interface DiagramProps {
  /** Mermaid source. */
  source: string;
  /** Names the picture for assistive technology. */
  title?: string;
  /** False while the closing fence of a streamed code block has not arrived: nothing is drawn yet. */
  closed?: boolean;
  /** Id of an element that describes the diagram in text. */
  describedBy?: string;
}

type Outcome = { key: string; svg: string } | { key: string; failed: true };

/** A Mermaid diagram: drawn once the source is complete, with the source one click away. */
export const Diagram = memo(function Diagram({
  source,
  title,
  closed = true,
  describedBy,
}: DiagramProps) {
  const theme = useThemeVersion();
  const key = `${String(theme)}\n${source}`;
  const tooLong = source.length > MAX_DIAGRAM_CHARS;
  const wanted = closed && !tooLong;
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const current = outcome?.key === key ? outcome : null;

  useLayoutEffect(() => {
    if (!wanted) return;
    let cancelled = false;
    renderMermaid(source, () => cancelled).then(
      (svg) => {
        if (cancelled || svg === null) return;
        setOutcome({ key, svg });
      },
      () => {
        if (!cancelled) setOutcome({ key, failed: true });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [wanted, source, key]);

  const svg = current !== null && 'svg' in current ? current.svg : null;
  useLayoutEffect(() => {
    if (svg !== null && canvas.current) insertSanitizedSvg(canvas.current, svg);
  }, [svg]);

  if (!closed) return <CodeBlock language="mermaid" code={source} />;

  if (tooLong || (current !== null && 'failed' in current)) {
    return (
      <div className="diagram diagram--failed">
        <p className="diagram-message" role="status">
          {tooLong ? 'This diagram is too long to draw.' : 'This diagram could not be drawn.'}
        </p>
        <CodeBlock language="mermaid" code={source} />
      </div>
    );
  }

  if (svg === null) {
    return (
      <div className="diagram diagram--loading">
        <p className="diagram-message" role="status">
          Drawing diagram…
        </p>
      </div>
    );
  }

  return (
    <div className="diagram">
      <div
        ref={canvas}
        className="diagram-canvas"
        role="img"
        // Wide diagrams scroll inside their box: the keyboard must be able to reach it.
        tabIndex={0}
        aria-label={title !== undefined && title !== '' ? title : 'Diagram'}
        aria-describedby={describedBy}
      />
      <details className="diagram-source">
        <summary>Show source</summary>
        <CodeBlock language="mermaid" code={source} />
      </details>
    </div>
  );
});
