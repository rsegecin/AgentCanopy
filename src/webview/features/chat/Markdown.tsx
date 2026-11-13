import { memo, useMemo } from 'react';
import { renderMarkdown } from './render-markdown';

/**
 * Renders model output as Markdown. Memoised on the text, so a streaming message only re-renders
 * the part whose text changed.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const nodes = useMemo(() => renderMarkdown(text), [text]);
  return <div className="markdown">{nodes}</div>;
});
