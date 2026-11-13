import MarkdownIt from 'markdown-it';
import type { Env } from 'markdown-it';
import type { ReactNode } from 'react';
import { CodeBlock } from './CodeBlock';
import { DiagramBlock } from './DiagramBlock';
import { fragmentToReact } from './dom-to-react';
import type { ConvertContext } from './dom-to-react';
import { MdInlineCode, MdLink } from './links';
import { sanitizeMarkdownHtml } from './sanitize';

interface FenceInfo {
  language: string;
  code: string;
  closed: boolean;
}

interface RenderEnv extends Env {
  fences: FenceInfo[];
  lines: string[];
}

const CLOSING_FENCE = /^[\s>]*(`{3,}|~{3,})\s*$/;

/** markdown-it does not say whether a fence was closed. A fence that ran to the end of the text is not. */
function isClosed(env: RenderEnv, map: [number, number] | null, markup: string): boolean {
  if (!map) return true;
  const last = env.lines[map[1] - 1];
  if (last === undefined || map[1] - 1 <= map[0]) return false;
  const match = CLOSING_FENCE.exec(last);
  return match?.[1] !== undefined && match[1][0] === markup[0] && match[1].length >= markup.length;
}

const md = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: false });

function placeholder(env: RenderEnv, fence: FenceInfo): string {
  env.fences.push(fence);
  return `<div data-codeblock="${String(env.fences.length - 1)}"></div>\n`;
}

md.renderer.rules.fence = (tokens, idx, _options, env) => {
  const token = tokens[idx];
  if (!token) return '';
  const e = env as RenderEnv;
  const language = token.info.trim().split(/\s+/)[0] ?? '';
  return placeholder(e, {
    language,
    code: token.content,
    closed: isClosed(e, token.map, token.markup),
  });
};

md.renderer.rules.code_block = (tokens, idx, _options, env) => {
  const token = tokens[idx];
  if (!token) return '';
  return placeholder(env as RenderEnv, { language: '', code: token.content, closed: true });
};

// Images are never loaded: the alt text stands in for them.
md.renderer.rules.image = (tokens, idx) => {
  const token = tokens[idx];
  return md.utils.escapeHtml(`[${token?.content ?? ''}]`);
};

function convertContext(env: RenderEnv): ConvertContext {
  return {
    element(element, key) {
      if (element.tagName.toLowerCase() !== 'div') return undefined;
      const index = element.getAttribute('data-codeblock');
      if (index === null) return undefined;
      const fence = env.fences[Number(index)];
      if (!fence) return null;
      return fence.language.toLowerCase() === 'mermaid' ? (
        <DiagramBlock key={key} code={fence.code} closed={fence.closed} />
      ) : (
        <CodeBlock key={key} language={fence.language} code={fence.code} />
      );
    },
    link: (element, children, key) => (
      <MdLink key={key} href={element.getAttribute('href')} title={element.getAttribute('title')}>
        {children}
      </MdLink>
    ),
    inlineCode: (element, key) => <MdInlineCode key={key} text={element.textContent} />,
  };
}

/** Markdown text to React elements. Raw HTML in the text is escaped, then the output is sanitised. */
export function renderMarkdown(text: string): ReactNode[] {
  const env: RenderEnv = { fences: [], lines: text.split('\n') };
  const html = md.render(text, env);
  return fragmentToReact(sanitizeMarkdownHtml(html), convertContext(env));
}
