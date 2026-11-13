import DOMPurify from 'dompurify';
import { useSyncExternalStore } from 'react';

/** Longer sources are shown as code and never sent to Mermaid. */
export const MAX_DIAGRAM_CHARS = 20_000;

interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  render(id: string, text: string): Promise<{ svg: string }>;
}

let loading: Promise<MermaidApi> | null = null;

/** Mermaid is large: it is loaded on first use, as a chunk of its own. */
function loadMermaid(): Promise<MermaidApi> {
  loading ??= import('mermaid').then(
    (module) => module.default as unknown as MermaidApi,
    (error: unknown) => {
      loading = null;
      throw error;
    },
  );
  return loading;
}

/* ------------------------------------------------------------------ theme */

const FALLBACK_DARK = { bg: '#1e1e1e', fg: '#d4d4d4' };
const FALLBACK_LIGHT = { bg: '#ffffff', fg: '#333333' };

/** Mermaid's theme variables, taken from the VS Code CSS variables in effect right now. */
export function readThemeVariables(): Record<string, string | boolean> {
  const body = document.body;
  const style = getComputedStyle(body);
  const light = body.classList.contains('vscode-light');
  const fallback = light ? FALLBACK_LIGHT : FALLBACK_DARK;
  const read = (name: string, alternative: string): string => {
    const value = style.getPropertyValue(name).trim();
    return value !== '' ? value : alternative;
  };
  const bg = read('--vscode-editor-background', fallback.bg);
  const fg = read('--vscode-editor-foreground', read('--vscode-foreground', fallback.fg));
  return {
    darkMode: !light,
    background: bg,
    fontFamily: read('--vscode-font-family', 'sans-serif'),
    textColor: fg,
    primaryColor: read('--vscode-editorWidget-background', bg),
    primaryTextColor: fg,
    primaryBorderColor: read('--vscode-focusBorder', fg),
    secondaryColor: read('--vscode-input-background', bg),
    tertiaryColor: read('--vscode-sideBar-background', bg),
    lineColor: fg,
    nodeBorder: read('--vscode-focusBorder', fg),
    mainBkg: read('--vscode-editorWidget-background', bg),
    edgeLabelBackground: bg,
  };
}

let themeVersion = 0;
const themeListeners = new Set<() => void>();
let observer: MutationObserver | null = null;

function subscribeTheme(listener: () => void): () => void {
  themeListeners.add(listener);
  if (!observer) {
    // VS Code changes the theme by changing the classes of the body.
    observer = new MutationObserver(() => {
      themeVersion++;
      for (const l of [...themeListeners]) l();
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }
  return () => {
    themeListeners.delete(listener);
    if (themeListeners.size === 0) {
      observer?.disconnect();
      observer = null;
    }
  };
}

/** A number that changes whenever the VS Code theme does. */
export function useThemeVersion(): number {
  return useSyncExternalStore(subscribeTheme, () => themeVersion);
}

/* ------------------------------------------------------------------ rendering */

let initialisedWith: string | null = null;
let counter = 0;
let tail: Promise<unknown> = Promise.resolve();
const cache = new Map<string, string>();
const CACHE_MAX = 40;

/** Forgets everything Mermaid-related. For tests. */
export function resetMermaidForTests(): void {
  loading = null;
  initialisedWith = null;
  cache.clear();
  tail = Promise.resolve();
}

async function renderNow(source: string, isCancelled: () => boolean): Promise<string | null> {
  // Give the browser a turn between diagrams so typing stays responsive.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  if (isCancelled()) return null;
  const mermaid = await loadMermaid();
  const theme = readThemeVariables();
  const themeKey = JSON.stringify(theme);
  const cacheKey = `${themeKey}\n${source}`;
  const hit = cache.get(cacheKey);
  if (hit !== undefined) return hit;
  if (initialisedWith !== themeKey) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      themeVariables: theme,
      // Labels are drawn as SVG text: HTML labels would need foreignObject, which is not allowed.
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      // The ELK layout engine is not shipped (see scripts/stubs/elk.mjs), so the classic layout is
      // the default. A diagram that asks for ELK itself fails to draw and shows its source.
      layout: 'dagre',
    });
    initialisedWith = themeKey;
  }
  const id = `agentcanopy-diagram-${String(++counter)}`;
  try {
    const { svg } = await mermaid.render(id, source);
    if (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(cacheKey, svg);
    return svg;
  } finally {
    // A failed render can leave its scratch element behind.
    document.getElementById(`d${id}`)?.remove();
    document.getElementById(id)?.remove();
  }
}

/**
 * Draws a diagram, one at a time. Resolves to the SVG markup (not yet safe to insert), or to null
 * when `isCancelled` said so before the turn came. Rejects when Mermaid cannot draw the source.
 */
export function renderMermaid(source: string, isCancelled: () => boolean): Promise<string | null> {
  const result = tail.then(() => renderNow(source, isCancelled));
  tail = result.catch(() => undefined);
  return result;
}

/* ------------------------------------------------------------------ sanitising */

const purify = DOMPurify(window);

purify.addHook('uponSanitizeAttribute', (_node, data) => {
  const name = data.attrName.toLowerCase();
  if (name.startsWith('on')) {
    data.keepAttr = false;
    return;
  }
  if (name === 'href' || name === 'xlink:href') {
    // No element of a diagram opens anything: the text of a link stays, the link does not.
    data.keepAttr = false;
  } else if (name === 'style') {
    data.attrValue = cleanCss(data.attrValue);
  }
});

/** Drops CSS that could load something: `@import` and any `url()` that is not a reference inside the SVG. */
function cleanCss(css: string): string {
  return css.replace(/@import[^;]*;?/gi, '').replace(/url\(\s*(?!['"]?#)[^)]*\)/gi, 'none');
}

/**
 * Puts the SVG that Mermaid produced into `container`. This is the one place in the webview where
 * markup is inserted into the DOM instead of being built as React elements: Mermaid returns a
 * finished SVG string, so it first goes through DOMPurify (SVG profile, no script, foreignObject,
 * iframe, event handler or href, so a `click` directive cannot make a link) and is added as DOM
 * nodes, never as a string.
 */
export function insertSanitizedSvg(container: HTMLElement, svg: string): void {
  const fragment = purify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ['style'],
    FORBID_TAGS: ['script', 'foreignObject', 'foreignobject', 'iframe', 'object', 'embed'],
    KEEP_CONTENT: false,
    RETURN_DOM_FRAGMENT: true,
  });
  for (const style of Array.from(fragment.querySelectorAll('style'))) {
    style.textContent = cleanCss(style.textContent);
  }
  container.replaceChildren(fragment);
}
