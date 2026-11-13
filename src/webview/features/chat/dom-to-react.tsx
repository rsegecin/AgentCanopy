import { createElement } from 'react';
import type { ReactNode } from 'react';
import { markInvisible } from './invisible';

export interface ConvertContext {
  /** Replaces an element entirely. Return undefined to convert it normally. */
  element?: (element: Element, key: string) => ReactNode | undefined;
  /** Renders `<a>` and inline `<code>` with behaviour. */
  link?: (element: Element, children: ReactNode[], key: string) => ReactNode;
  inlineCode?: (element: Element, key: string) => ReactNode;
  /** Renders a run of text. Lets a caller mark characters that need to be seen. */
  text?: (text: string, key: string) => ReactNode;
}

const VOID_TAGS = new Set(['br', 'hr']);
const ATTRIBUTES: Record<string, string> = {
  title: 'title',
  start: 'start',
  colspan: 'colSpan',
  rowspan: 'rowSpan',
};
/** The only elements that are ever created. The sanitiser has already run; this is a second wall. */
const RENDERABLE = new Set([
  'p',
  'br',
  'hr',
  'em',
  'strong',
  's',
  'del',
  'ins',
  'sub',
  'sup',
  'blockquote',
  'ul',
  'ol',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'div',
  'span',
]);

/**
 * Turns an already sanitised DOM tree into React elements, so nothing is ever injected as raw HTML.
 * Only text, a fixed set of elements and a fixed set of attributes survive.
 */
export function fragmentToReact(root: ParentNode, ctx: ConvertContext, prefix = ''): ReactNode[] {
  const out: ReactNode[] = [];
  root.childNodes.forEach((node, index) => {
    const key = `${prefix}${String(index)}`;
    if (node.nodeType === 3) {
      out.push(ctx.text ? ctx.text(node.textContent ?? '', key) : node.textContent);
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    const custom = ctx.element?.(element, key);
    if (custom !== undefined) {
      out.push(custom);
      return;
    }
    const tag = element.tagName.toLowerCase();
    if (tag === 'a' && ctx.link) {
      out.push(ctx.link(element, fragmentToReact(element, ctx, `${key}.`), key));
      return;
    }
    if (tag === 'code' && ctx.inlineCode) {
      out.push(ctx.inlineCode(element, key));
      return;
    }
    if (tag === 'code' || tag === 'a') {
      const text = element.textContent ?? '';
      out.push(
        createElement(
          tag === 'code' ? 'code' : 'span',
          { key },
          tag === 'code' ? markInvisible(text) : text,
        ),
      );
      return;
    }
    if (!RENDERABLE.has(tag) && tag !== 'span') {
      // Unknown element: keep its text, drop the element.
      out.push(...fragmentToReact(element, ctx, `${key}.`));
      return;
    }
    const props: Record<string, unknown> = { key };
    for (const [name, prop] of Object.entries(ATTRIBUTES)) {
      const value = element.getAttribute(name);
      if (value !== null) props[prop] = value;
    }
    const className = element.getAttribute('class');
    if (tag === 'span' && className !== null && /^[\w\- ]+$/.test(className)) {
      props.className = className;
    }
    if (tag === 'table') {
      // A wide table scrolls inside a box of its own, which the keyboard must be able to reach.
      out.push(
        createElement(
          'div',
          { key, className: 'markdown-table', role: 'group', 'aria-label': 'Table', tabIndex: 0 },
          createElement('table', {}, ...fragmentToReact(element, ctx, `${key}.`)),
        ),
      );
      return;
    }
    if (VOID_TAGS.has(tag)) out.push(createElement(tag, props));
    else out.push(createElement(tag, props, ...fragmentToReact(element, ctx, `${key}.`)));
  });
  return out;
}
