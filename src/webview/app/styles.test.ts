// @vitest-environment node
import { describe, expect, it } from 'vitest';

/**
 * Vitest blanks CSS imports (even `?raw`), so the stylesheets are read from disk. The webview may
 * not import Node built-ins, so the module is taken from `process` instead; this file is a test and
 * is never bundled.
 */
interface Fs {
  readdirSync(dir: URL): string[];
  readFileSync(file: URL, encoding: 'utf8'): string;
}
declare const process: { getBuiltinModule(id: string): unknown };
const fs = process.getBuiltinModule('node:fs') as Fs;
const dir = new URL('./styles/', import.meta.url);

const entries = fs
  .readdirSync(dir)
  .filter((name) => name.endsWith('.css'))
  .sort()
  .map((name) => ({ name, css: fs.readFileSync(new URL(name, dir), 'utf8') }));
const all = entries.map((e) => e.css).join('\n');

/** The CSS with comments removed. */
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

const NAMED = [
  'white',
  'black',
  'red',
  'green',
  'blue',
  'yellow',
  'orange',
  'purple',
  'gray',
  'grey',
  'silver',
  'navy',
  'teal',
  'pink',
  'brown',
];

describe('stylesheets', () => {
  it('finds the stylesheets', () => {
    expect(entries.map((e) => e.name)).toEqual(
      expect.arrayContaining(['base.css', 'chat.css', 'composer.css', 'contrast.css', 'plan.css']),
    );
  });

  it.each(entries)('$name uses no fixed colours: only VS Code theme variables', ({ css }) => {
    const text = strip(css);
    expect(text).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(text).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\(/i);
    // Named colours, in a colour-valued declaration (not in selectors or other words).
    const colourDeclarations = text.match(
      /(?:^|[;{\s])(?:color|background|background-color|border|border-color|border-left|border-left-color|outline|outline-color|box-shadow|fill|stroke)\s*:[^;}]*/gi,
    );
    for (const declaration of colourDeclarations ?? []) {
      for (const colour of NAMED) {
        expect(declaration, declaration).not.toMatch(new RegExp(`\\b${colour}\\b`, 'i'));
      }
    }
  });

  it('draws every focus ring with the theme focus colour', () => {
    const text = strip(all);
    expect(text).toMatch(
      /:focus-visible\s*\{[^}]*outline:\s*1px solid var\(--vscode-focusBorder\)/,
    );
    // The plain :focus rule only removes the default ring because :focus-visible puts one back.
    expect(text).toMatch(/:focus\s*\{\s*outline:\s*none/);
    for (const [, value] of text.matchAll(/(?<![-\w])outline:\s*([^;}]+)/g)) {
      const v = (value ?? '').trim();
      expect(
        v === 'none' ||
          v.includes('--vscode-focusBorder') ||
          v.includes('--ac-contrast-active') ||
          v.includes('--vscode-editor-findMatchHighlightBorder'),
        v,
      ).toBe(true);
    }
  });

  it('keeps a visible focus ring on elements that scroll inside a box', () => {
    const text = strip(all);
    expect(text).not.toMatch(
      /\.(?:code-block-pre|diagram-canvas|tool-card-pre|markdown-table)[^{]*:focus[^{]*\{[^}]*outline:\s*none/,
    );
  });

  it('draws the ring inside boxes that clip or scroll, so it is never cut off', () => {
    const text = strip(all);
    const rule = text.match(/(\.code-block :focus-visible[^{]*)\{([^}]*)\}/);
    expect(rule?.[2]).toMatch(/outline-offset:\s*-\d+px/);
    for (const selector of [
      '.diagram-canvas',
      '.markdown-table',
      '.tool-card-pre',
      '.log',
      '.changes-dock-body',
      '.changes-card-body',
    ]) {
      expect(rule?.[1], selector).toContain(`${selector}:focus-visible`);
    }
    expect(text).toMatch(/\.code-block\s*\{[^}]*overflow:\s*hidden/);
  });

  it('only removes the ring from containers that take focus from script, never from controls', () => {
    const text = strip(all);
    const removed = [...text.matchAll(/([^{}]+)\{\s*outline:\s*none;?\s*\}/g)].flatMap((m) =>
      (m[1] ?? '').split(',').map((x) => x.trim()),
    );
    for (const selector of removed) {
      if (selector === ':focus') continue;
      expect(selector, selector).toMatch(
        /^(?:\[role='tabpanel'\]|\.changes-dock|\.changes-card|\.checkpoints-scroll|\.permissions-scroll|\.plan-card|\.plan-card-slot|\.history|form\.composer):focus-visible$/,
      );
    }
    expect(removed.length).toBeGreaterThan(3);
  });

  it('shows the controls that appear on hover when they are focused too', () => {
    const text = strip(all);
    expect(text).toMatch(/\.message:focus-within \.message-actions/);
    expect(text).toMatch(/\.history-row:focus-within \.row-actions/);
    expect(text).toMatch(/@media \(hover: none\)/);
  });

  it('removes animation and smooth scrolling when motion is reduced', () => {
    const block = strip(all).match(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\n\}/);
    expect(block).not.toBeNull();
    expect(block?.[0]).toMatch(/animation:\s*none !important/);
    expect(block?.[0]).toMatch(/transition:\s*none !important/);
    expect(block?.[0]).toMatch(/scroll-behavior:\s*auto !important/);
    expect(block?.[0]).toMatch(/\.codicon-modifier-spin/);
  });

  it('makes disabled buttons look disabled in more than opacity', () => {
    const text = strip(all);
    const rule = text.match(/\.button:disabled[^{]*\{([^}]*)\}/);
    expect(rule?.[1]).toMatch(/opacity:\s*0?\.\d+/);
    expect(rule?.[1]).toMatch(/cursor:\s*not-allowed/);
    expect(rule?.[1]).toMatch(/background:\s*transparent/);
    expect(rule?.[1]).toMatch(/--vscode-disabledForeground/);
    expect(text).toMatch(/\.icon-button:disabled\s*\{[^}]*cursor:\s*not-allowed/);
  });

  it('gives high-contrast themes explicit borders from the contrast colours', () => {
    const contrast = strip(entries.find((e) => e.name === 'contrast.css')?.css ?? '');
    expect(contrast).toContain('body.vscode-high-contrast');
    expect(contrast).toContain('body.vscode-high-contrast-light');
    expect(contrast).toContain('--vscode-contrastBorder');
    expect(contrast).toContain('--vscode-contrastActiveBorder');
    for (const surface of [
      '.message--user',
      '.code-block',
      '.tool-card',
      '.prompt-card',
      '.review-entry',
      '.changes-dock',
      '.changes-card',
      '.plan-card',
      '.menu',
      '.reference-picker',
      '.composer-input',
      '.button',
      '.tab',
      '.history-row--active',
      '.plan-option--chosen',
      '.permissions-row',
      '.permissions-switch--on',
    ]) {
      expect(contrast, surface).toContain(surface);
    }
  });

  it('is imported last, so the high-contrast rules win', () => {
    const index = entries.find((e) => e.name === 'index.css')?.css ?? '';
    const imports = [...index.matchAll(/@import '\.\/([\w-]+\.css)'/g)].map((m) => m[1]);
    expect(imports[imports.length - 1]).toBe('contrast.css');
  });

  it('lets text wrap or scroll in its own box instead of being cut off', () => {
    const text = strip(all);
    // Long paths and commands wrap.
    const rules = [...text.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({
      selectors: (m[1] ?? '').split(',').map((x) => x.trim()),
      body: m[2] ?? '',
    }));
    for (const selector of ['.review-path', '.tool-card-pre', '.prompt-detail', '.diff-line']) {
      const declarations = rules
        .filter((r) => r.selectors.includes(selector))
        .map((r) => r.body)
        .join(';');
      expect(declarations, selector).toMatch(/overflow-wrap:\s*anywhere|white-space:\s*pre-wrap/);
    }
    // Tabs wrap at narrow widths.
    expect(text).toMatch(/\.tabs\s*\{[^}]*flex-wrap:\s*wrap/);
    // No fixed pixel widths on layout containers that could exceed a 260 px view.
    expect(text).not.toMatch(
      /\.(?:app|column|composer|plan-card|changes-dock|changes-card|checkpoints|permissions|history)\s*\{[^}]*(?<!max-|min-)width:\s*\d+px/,
    );
  });

  it('bounds the changes strip and the Changed files card, which scroll inside themselves, and drops the removed tab styles', () => {
    const text = strip(all);
    for (const selector of ['changes-dock-body', 'changes-card-body']) {
      const body = text.match(new RegExp(`\\.${selector}\\s*\\{([^}]*)\\}`));
      expect(body?.[1], selector).toMatch(/max-height:\s*min\(40vh,\s*320px\)/);
      expect(body?.[1], selector).toMatch(/overflow-y:\s*auto/);
    }
    expect(text).not.toContain('.tab-badge');
    expect(text).not.toContain('.header-warning');
    expect(text).not.toContain('.review-scroll');
  });

  it('marks the Auto switch on by weight and an outline, not by colour, and in high contrast', () => {
    const text = strip(all);
    const rule = text.match(/\.auto-switch--on\s*\{([^}]*)\}/);
    expect(rule?.[1]).toMatch(/font-weight:\s*600/);
    expect(rule?.[1]).toMatch(/outline:\s*1px solid/);
    expect(rule?.[1]).not.toMatch(/(?:^|[;\s])(?:color|background(?:-color)?)\s*:/);
    expect(strip(entries.find((e) => e.name === 'contrast.css')?.css ?? '')).toContain(
      '.auto-switch--on',
    );
  });

  it('marks a permission switch on by weight and an outline, not by colour, and in high contrast', () => {
    const text = strip(all);
    const rule = text.match(/\.permissions-switch--on\s*\{([^}]*)\}/);
    expect(rule?.[1]).toMatch(/font-weight:\s*600/);
    expect(rule?.[1]).toMatch(/outline:\s*1px solid/);
    expect(rule?.[1]).not.toMatch(/(?:^|[;\s])(?:color|background(?:-color)?)\s*:/);
    const contrast = strip(entries.find((e) => e.name === 'contrast.css')?.css ?? '');
    expect(contrast).toContain('.permissions-switch--on');
    expect(contrast).toContain('.permissions-row');
  });
});
