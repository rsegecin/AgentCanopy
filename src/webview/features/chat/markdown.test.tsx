// @vitest-environment jsdom
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithHost } from '../../test-support/harness';
import { Markdown } from './Markdown';
import { parseWorkspacePath } from './paths';

// Diagrams load Mermaid on demand; these tests are about Markdown, so it never draws anything.
vi.mock('mermaid', () => ({
  default: { initialize: vi.fn(), render: vi.fn(() => new Promise(() => undefined)) },
}));

function renderMarkdown(text: string) {
  return renderWithHost(<Markdown text={text} />);
}

const FORBIDDEN_ELEMENTS =
  'script, iframe, img, svg, style, object, embed, form, input, math, link';

function expectSafe(container: HTMLElement) {
  expect(container.querySelectorAll(FORBIDDEN_ELEMENTS)).toHaveLength(0);
  for (const element of Array.from(container.querySelectorAll('*'))) {
    for (const attribute of Array.from(element.attributes)) {
      expect(attribute.name.startsWith('on'), `${element.tagName} ${attribute.name}`).toBe(false);
      expect(attribute.name).not.toBe('style');
      expect(attribute.value).not.toMatch(/(javascript|vbscript|data)\s*:/i);
    }
  }
  for (const anchor of Array.from(container.querySelectorAll('[href]'))) {
    const href = anchor.getAttribute('href') ?? '';
    // http, https, mailto, or a relative reference (no scheme at all)
    expect(href, href).toMatch(/^((https?|mailto):|(?![a-z][a-z0-9+.-]*:))/i);
  }
}

const CORPUS: Record<string, string> = {
  'raw script': 'before <script>window.__pwned = 1</script> after',
  'img onerror': '<img src=x onerror="window.__pwned=1"> and ![alt](x "t")',
  iframe: '<iframe src="https://evil.example"></iframe>',
  'svg onload': '<svg onload="window.__pwned=1"><circle/></svg>',
  'javascript link': '[click](javascript:alert(1))',
  'javascript mixed case': '[click](JaVaScRiPt:alert(1))',
  'javascript with tab entity': '[click](java&#x09;script:alert(1))',
  'javascript with newline entity': '[click](java&#10;script:alert(1))',
  'javascript with entities for letters': '[click](&#106;avascript:alert(1))',
  'javascript with spaces': '[click](<java script:alert(1)>)',
  'data link': '[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
  'data mixed case': '[click](DaTa:text/html,<script>alert(1)</script>)',
  'vbscript link': '[click](vbscript:msgbox(1))',
  'vbscript mixed case': '[click](VbScRiPt:msgbox(1))',
  'file link': '[click](file:///etc/passwd)',
  'autolink javascript': '<javascript:alert(1)>',
  'reference link': '[x][1]\n\n[1]: javascript:alert(1)',
  'html comment': 'a <!-- <script>alert(1)</script> --> b',
  'style block': '<style>body { display: none }</style> text',
  'link title with quotes': '[x](https://example.com "a \\" onmouseover=\\"alert(1)")',
  'link title with raw quotes': '[x](https://example.com \'" onmouseover="alert(1)\')',
  'fence closing tags': '```\n</code></pre><script>alert(1)</script>\n```',
  'fence info string': '```"><script>alert(1)</script>\ncode\n```',
  'nested html in list': '- <script>alert(1)</script>\n- <img src=x onerror=alert(1)>',
  'form and input': '<form action="https://evil.example"><input name="x"></form>',
  'math and object':
    '<math><mi xlink:href="javascript:alert(1)">x</mi></math><object data="x"></object>',
  'table with html': '| a |\n|---|\n| <img src=x onerror=alert(1)> |',
};

describe('Markdown security corpus', () => {
  for (const [name, text] of Object.entries(CORPUS)) {
    it(`renders "${name}" without active content`, () => {
      const { container } = renderMarkdown(text);
      expectSafe(container);
      expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    });
  }

  it('keeps raw HTML visible as text instead of dropping it silently', () => {
    const { container } = renderMarkdown('use <script>alert(1)</script> carefully');
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });

  it('keeps the content of a fence that contains closing tags as code text', () => {
    const { container } = renderMarkdown('```\n</code></pre><script>alert(1)</script>\n```');
    expect(container.querySelectorAll('.code-block')).toHaveLength(1);
    expect(container.querySelector('code')?.textContent).toContain('</code></pre><script>');
  });

  it('replaces images with their alt text in brackets', () => {
    const { container } = renderMarkdown('see ![a diagram](https://example.com/x.png) here');
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('see [a diagram] here');
  });

  it('keeps a title with quotes as inert attribute text', () => {
    const { container } = renderMarkdown('[x](https://example.com "say \\"hi\\"")');
    const anchor = container.querySelector('a');
    expect(anchor?.getAttribute('title')).toBe('say "hi"');
    expect(anchor?.hasAttribute('onmouseover')).toBe(false);
  });
});

describe('Markdown rendering', () => {
  it('renders common markdown', () => {
    const { container } = renderMarkdown(
      '# Title\n\nSome **bold** and *em* text.\n\n- one\n- two\n\n> quote\n\n| a | b |\n|---|---|\n| 1 | 2 |',
    );
    expect(container.querySelector('h1')?.textContent).toBe('Title');
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelector('blockquote')).not.toBeNull();
    expect(container.querySelectorAll('td')).toHaveLength(2);
  });

  it('renders a fenced block through CodeBlock with a language label and highlighting', () => {
    const { container } = renderMarkdown('```ts\nconst x: number = 1;\n```');
    const block = container.querySelector('.code-block');
    expect(block).not.toBeNull();
    expect(block?.querySelector('.code-block-language')?.textContent).toBe('ts');
    expect(block?.querySelector('.hljs-keyword')?.textContent).toBe('const');
    expect(screen.getByRole('button', { name: 'Copy ts code' })).toBeTruthy();
  });

  it('renders an unknown language as plain text', () => {
    const { container } = renderMarkdown('```nosuchlang\nlet <b>x</b>\n```');
    expect(container.querySelector('.hljs-keyword')).toBeNull();
    expect(container.querySelector('code')?.textContent).toBe('let <b>x</b>\n');
    expect(container.querySelector('b')).toBeNull();
  });

  it('hands a closed mermaid fence to the diagram component', () => {
    const { container } = renderMarkdown('```mermaid\ngraph TD; A-->B;\n```');
    expect(container.querySelector('.diagram')).not.toBeNull();
    expect(screen.getByText('Drawing diagram…')).toBeTruthy();
  });

  it('shows an unclosed mermaid fence as a plain code block', () => {
    const { container } = renderMarkdown('```mermaid\ngraph TD; A-->B;');
    expect(container.querySelector('.code-block-language')?.textContent).toBe('mermaid');
    expect(container.querySelector('code')?.textContent).toContain('graph TD');
    expect(container.querySelector('.diagram')).toBeNull();
  });

  it('copies a code block through clipboard.copy', () => {
    const { host } = renderMarkdown('```js\nlet a = 1;\n```');
    fireEvent.click(screen.getByRole('button', { name: 'Copy js code' }));
    expect(host.postedOf('clipboard.copy')).toEqual([
      { type: 'clipboard.copy', text: 'let a = 1;\n' },
    ]);
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
  });

  it('renders a fence that is still streaming (no closing fence)', () => {
    const { container } = renderMarkdown('text\n\n```python\nprint(1)');
    expect(container.querySelector('.code-block')).not.toBeNull();
  });
});

describe('Markdown links', () => {
  it('posts open.link for an http link and does not navigate', () => {
    const { host } = renderMarkdown('[docs](https://example.com/docs)');
    const link = screen.getByRole('link', { name: 'docs' });
    const notPrevented = fireEvent.click(link);
    expect(notPrevented).toBe(false); // preventDefault was called
    expect(host.postedOf('open.link')).toEqual([
      { type: 'open.link', url: 'https://example.com/docs' },
    ]);
  });

  it('posts open.link for mailto and linkified text', () => {
    const { host } = renderMarkdown('[mail](mailto:a@example.com) and https://example.org/x');
    fireEvent.click(screen.getByRole('link', { name: 'mail' }));
    fireEvent.click(screen.getByRole('link', { name: 'https://example.org/x' }));
    expect(host.postedOf('open.link').map((m) => m.url)).toEqual([
      'mailto:a@example.com',
      'https://example.org/x',
    ]);
  });

  it('posts open.file with the line for path-like inline code', () => {
    const { host } = renderMarkdown('see `src/app/main.tsx:42` for details');
    fireEvent.click(screen.getByText('src/app/main.tsx:42'));
    expect(host.postedOf('open.file')).toEqual([
      { type: 'open.file', path: 'src/app/main.tsx', line: 42 },
    ]);
  });

  it('opens a path-like inline code with the keyboard', () => {
    const { host } = renderMarkdown('`README.md`');
    fireEvent.keyDown(screen.getByRole('link', { name: 'Open README.md' }), { key: 'Enter' });
    expect(host.postedOf('open.file')).toEqual([{ type: 'open.file', path: 'README.md' }]);
  });

  it('posts open.file for a relative link and gives it no href', () => {
    const { host, container } = renderMarkdown('[the file](src/util.ts:7)');
    fireEvent.click(screen.getByText('the file'));
    expect(host.postedOf('open.file')).toEqual([
      { type: 'open.file', path: 'src/util.ts', line: 7 },
    ]);
    expect(container.querySelector('[href]')).toBeNull();
  });

  it('does nothing for ordinary inline code and for non-path words', () => {
    const { host } = renderMarkdown('`console.log` and `foo` and `Array.map`');
    fireEvent.click(screen.getByText('console.log'));
    fireEvent.click(screen.getByText('foo'));
    expect(host.posted.filter((m) => m.type !== 'ready')).toEqual([]);
  });
});

describe('parseWorkspacePath', () => {
  it('accepts workspace-relative paths with an optional line', () => {
    expect(parseWorkspacePath('src/a.ts')).toEqual({ path: 'src/a.ts' });
    expect(parseWorkspacePath('./src/a.ts:12')).toEqual({ path: 'src/a.ts', line: 12 });
    expect(parseWorkspacePath('src/a.ts:12:3')).toEqual({ path: 'src/a.ts', line: 12 });
    expect(parseWorkspacePath('package.json')).toEqual({ path: 'package.json' });
    expect(parseWorkspacePath('src/a.ts#L9')).toEqual({ path: 'src/a.ts', line: 9 });
  });

  it('rejects absolute paths, parent segments, URLs and bare words', () => {
    for (const bad of [
      '/etc/passwd',
      '../secret.ts',
      'a/../b.ts',
      'C:\\x\\y.ts',
      'C:/x/y.ts',
      'https://example.com/a.ts',
      '~/x.ts',
      'foo',
      'console.log',
      'a b/c.ts',
      '',
    ]) {
      expect(parseWorkspacePath(bad), bad).toBeNull();
    }
  });
});

describe('sanitizer (second layer, fed hostile HTML directly)', () => {
  const hostile = [
    '<a href="javascript:alert(1)" onclick="alert(2)">a</a>',
    '<a href="JaVa\tScRiPt:alert(1)">b</a>',
    '<a href="  javascript:alert(1)">b2</a>',
    '<a href="data:text/html,x">c</a>',
    '<a href="vbscript:x">c2</a>',
    '<a href="https://ok.example/" style="x:y" onmouseover="z">d</a>',
    '<a href="rel/path.ts">e</a>',
    '<img src=x onerror=alert(1)>',
    '<svg onload=alert(1)><a xlink:href="javascript:1">s</a></svg>',
    '<style>p{}</style><iframe src="x"></iframe><form><input></form><object></object><embed>',
    '<math><mi>m</mi></math><script>alert(1)</script>',
    '<p onclick="x" class="c" id="i" data-x="1">p</p>',
  ].join('');

  it('removes forbidden elements, event handlers, style and unsafe URL schemes', async () => {
    const { sanitizeMarkdownHtml } = await import('./sanitize');
    const host = document.createElement('div');
    host.appendChild(sanitizeMarkdownHtml(hostile));
    expectSafe(host);
    const hrefs = Array.from(host.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('https://ok.example/');
    expect(hrefs).toContain('rel/path.ts');
    expect(host.querySelector('p')?.attributes.length).toBe(0);
    expect(host.textContent).toContain('p');
  });
});
