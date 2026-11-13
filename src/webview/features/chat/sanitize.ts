import DOMPurify from 'dompurify';

/** Own instance, so the hook below cannot leak into any other use of DOMPurify. */
const purify = DOMPurify(window);

purify.addHook('uponSanitizeAttribute', (_node, data) => {
  // Belt and braces: the attribute allow-list already excludes every event handler.
  if (data.attrName.toLowerCase().startsWith('on')) data.keepAttr = false;
});

/** Only http, https and mailto, or a relative reference. Mirrors DOMPurify's default minus the other schemes. */
const ALLOWED_URI = /^(?:(?:https?|mailto):|[^a-z]|[a-z0-9+.-]+(?:[^a-z0-9+.\-:]|$))/i;

const FORBIDDEN_TAGS = [
  'script',
  'style',
  'iframe',
  'form',
  'input',
  'object',
  'embed',
  'svg',
  'math',
  'img',
  'link',
  'meta',
  'base',
  'button',
  'textarea',
  'select',
  'audio',
  'video',
  'source',
];

const MARKDOWN_TAGS = [
  'a',
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
  'code',
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
];

/** Sanitises the HTML markdown-it produced. The result is a detached fragment, never a string. */
export function sanitizeMarkdownHtml(html: string): DocumentFragment {
  return purify.sanitize(html, {
    ALLOWED_TAGS: MARKDOWN_TAGS,
    ALLOWED_ATTR: ['href', 'title', 'start', 'colspan', 'rowspan', 'data-codeblock'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    FORBID_TAGS: FORBIDDEN_TAGS,
    FORBID_ATTR: ['style'],
    ALLOWED_URI_REGEXP: ALLOWED_URI,
    RETURN_DOM_FRAGMENT: true,
  });
}

/** Sanitises highlight.js output: spans with a class, nothing else. */
export function sanitizeHighlightHtml(html: string): DocumentFragment {
  return purify.sanitize(html, {
    ALLOWED_TAGS: ['span'],
    ALLOWED_ATTR: ['class'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    FORBID_TAGS: FORBIDDEN_TAGS,
    FORBID_ATTR: ['style'],
    RETURN_DOM_FRAGMENT: true,
  });
}
