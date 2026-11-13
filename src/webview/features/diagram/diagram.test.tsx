// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assistantMessage, makeActive, makeState, userMessage } from '../../test-support/fixtures';
import { renderWithHost } from '../../test-support/harness';
import { MessageList } from '../chat/MessageList';
import { Diagram } from './Diagram';
import { MAX_DIAGRAM_CHARS, resetMermaidForTests } from './mermaid-render';

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));
vi.mock('mermaid', () => ({ default: mermaid }));

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><g><text>Hello diagram</text></g></svg>';

beforeEach(() => {
  resetMermaidForTests();
  mermaid.initialize.mockReset();
  mermaid.render.mockReset();
  mermaid.render.mockResolvedValue({ svg: SVG });
});

afterEach(() => {
  document.body.className = '';
  document.body.removeAttribute('style');
});

const SOURCE = 'graph TD; A-->B;';

describe('Diagram', () => {
  it('shows Drawing diagram… and then the SVG that Mermaid returned', async () => {
    renderWithHost(<Diagram source={SOURCE} />);
    expect(screen.getByText('Drawing diagram…')).toBeTruthy();
    const picture = await screen.findByRole('img', { name: 'Diagram' });
    expect(picture.querySelector('svg text')?.textContent).toBe('Hello diagram');
    expect(screen.queryByText('Drawing diagram…')).toBeNull();
    expect(mermaid.render).toHaveBeenCalledTimes(1);
    expect(mermaid.render.mock.calls[0]?.[1]).toBe(SOURCE);
  });

  it('is labelled with its title', async () => {
    renderWithHost(<Diagram source={SOURCE} title="Read flow" />);
    expect(await screen.findByRole('img', { name: 'Read flow' })).toBeTruthy();
  });

  it('can point at a text alternative', async () => {
    renderWithHost(
      <>
        <p id="alt">Step one, then step two.</p>
        <Diagram source={SOURCE} describedBy="alt" />
      </>,
    );
    const picture = await screen.findByRole('img');
    expect(picture.getAttribute('aria-describedby')).toBe('alt');
  });

  it('initialises Mermaid once, strictly, with the VS Code theme', async () => {
    document.body.style.setProperty('--vscode-editor-background', '#123456');
    document.body.style.setProperty('--vscode-editor-foreground', '#abcdef');
    renderWithHost(
      <>
        <Diagram source="graph TD; A-->B;" />
        <Diagram source="graph TD; C-->D;" />
      </>,
    );
    await waitFor(() => {
      expect(screen.getAllByRole('img')).toHaveLength(2);
    });
    expect(mermaid.initialize).toHaveBeenCalledTimes(1);
    const config = mermaid.initialize.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(config.startOnLoad).toBe(false);
    expect(config.securityLevel).toBe('strict');
    expect(config.theme).toBe('base');
    const vars = config.themeVariables as Record<string, unknown>;
    expect(vars.background).toBe('#123456');
    expect(vars.textColor).toBe('#abcdef');
  });

  it('draws again, with new colours, when the theme class of the body changes', async () => {
    renderWithHost(<Diagram source={SOURCE} />);
    await screen.findByRole('img');
    expect(mermaid.render).toHaveBeenCalledTimes(1);
    const first = mermaid.initialize.mock.calls[0]?.[0] as {
      themeVariables: { darkMode: boolean };
    };
    expect(first.themeVariables.darkMode).toBe(true);

    await act(async () => {
      document.body.className = 'vscode-light';
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mermaid.render).toHaveBeenCalledTimes(2);
    });
    const second = mermaid.initialize.mock.calls[1]?.[0] as {
      themeVariables: { darkMode: boolean };
    };
    expect(second.themeVariables.darkMode).toBe(false);
    expect(await screen.findByRole('img')).toBeTruthy();
  });

  it('draws diagrams one at a time', async () => {
    let inFlight = 0;
    let peak = 0;
    mermaid.render.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return { svg: SVG };
    });
    renderWithHost(
      <>
        <Diagram source="graph TD; A-->B;" />
        <Diagram source="graph TD; B-->C;" />
        <Diagram source="graph TD; C-->D;" />
      </>,
    );
    await waitFor(() => {
      expect(screen.getAllByRole('img')).toHaveLength(3);
    });
    expect(mermaid.render).toHaveBeenCalledTimes(3);
    expect(peak).toBe(1);
  });

  describe('untrusted SVG', () => {
    const HOSTILE = `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">
      <script>window.pwned = 1</script>
      <g onclick="alert(2)">
        <foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">html <img src=x onerror="alert(3)"></div></foreignObject>
        <a href="javascript:alert(4)"><text>bad link</text></a>
        <a xlink:href="javascript:alert(5)" xmlns:xlink="http://www.w3.org/1999/xlink"><text>bad xlink</text></a>
        <a href="https://example.com/ok"><text>good link</text></a>
        <a href="data:text/html,x"><text>data link</text></a>
        <use href="https://evil.test/x.svg#a"/>
        <rect width="5" height="5" style="fill:url(https://evil.test/p.png)"/>
      </g>
      <iframe src="https://evil.test"></iframe>
      <style>@import url(https://evil.test/x.css); .node { fill: red }</style>
    </svg>`;

    it('leaves no script, handler, foreignObject, iframe or unsafe link in the DOM', async () => {
      mermaid.render.mockResolvedValue({ svg: HOSTILE });
      renderWithHost(<Diagram source={SOURCE} />);
      const picture = await screen.findByRole('img');
      const html = picture.innerHTML;
      expect(html.toLowerCase()).not.toContain('<script');
      expect(html.toLowerCase()).not.toContain('foreignobject');
      expect(html.toLowerCase()).not.toContain('<iframe');
      expect(html).not.toContain('javascript:');
      expect(html).not.toContain('onerror');
      expect(html).not.toContain('html <img');
      expect(picture.querySelector('script, iframe, img')).toBeNull();
      for (const element of Array.from(picture.querySelectorAll('*'))) {
        for (const attribute of Array.from(element.attributes)) {
          expect(attribute.name.toLowerCase().startsWith('on')).toBe(false);
          // No element of a diagram links anywhere, not even to https.
          expect(/href$/i.test(attribute.name), `${element.localName} ${attribute.name}`).toBe(
            false,
          );
        }
      }
      // The text of every link survives; the link itself does not.
      expect(picture.querySelector('[href], [*|href]')).toBeNull();
      expect(html).not.toContain('example.com');
      expect(within(picture).getByText('good link')).toBeTruthy();
      expect(within(picture).getByText('bad link')).toBeTruthy();
      expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
    });

    it('removes @import and external url() from styles but keeps the rules', async () => {
      mermaid.render.mockResolvedValue({ svg: HOSTILE });
      renderWithHost(<Diagram source={SOURCE} />);
      const picture = await screen.findByRole('img');
      const css = Array.from(picture.querySelectorAll('style'))
        .map((s) => s.textContent)
        .join('\n');
      expect(css).not.toContain('@import');
      expect(css).not.toContain('evil.test');
      expect(css).toContain('fill: red');
      expect(picture.innerHTML).not.toContain('evil.test');
    });

    it('keeps references inside the SVG', async () => {
      mermaid.render.mockResolvedValue({
        svg: '<svg xmlns="http://www.w3.org/2000/svg"><defs><marker id="m"><path d="M0 0"/></marker></defs><path marker-end="url(#m)" style="fill:url(#m)" d="M0 0 L1 1"/></svg>',
      });
      renderWithHost(<Diagram source={SOURCE} />);
      const picture = await screen.findByRole('img');
      expect(picture.querySelector('marker#m')).not.toBeNull();
      expect(picture.querySelector('path[marker-end]')?.getAttribute('marker-end')).toBe('url(#m)');
      expect(picture.querySelector('path[style]')?.getAttribute('style')).toContain('url(#m)');
    });
  });

  it('shows the source and a message, never the error, when Mermaid fails', async () => {
    mermaid.render.mockRejectedValue(new Error('<img src=x onerror=alert(1)> Parse error'));
    const { container } = renderWithHost(<Diagram source="graph TD; A-->" />);
    expect(await screen.findByText('This diagram could not be drawn.')).toBeTruthy();
    expect(container.textContent).toContain('graph TD; A-->');
    expect(container.textContent).not.toContain('Parse error');
    expect(container.querySelector('img')).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('cleans up the scratch element a failed render leaves behind', async () => {
    mermaid.render.mockImplementation((id: string) => {
      const leftover = document.createElement('div');
      leftover.id = `d${id}`;
      document.body.append(leftover);
      return Promise.reject(new Error('bad'));
    });
    renderWithHost(<Diagram source="x" />);
    await screen.findByText('This diagram could not be drawn.');
    expect(document.querySelector('[id^="dagentcanopy-diagram"]')).toBeNull();
  });

  it('does not draw a source over the limit, and shows it as code', () => {
    const long = `graph TD;\n${'A-->B;\n'.repeat(Math.ceil(MAX_DIAGRAM_CHARS / 7))}`;
    expect(long.length).toBeGreaterThan(MAX_DIAGRAM_CHARS);
    renderWithHost(<Diagram source={long} />);
    expect(screen.getByText('This diagram is too long to draw.')).toBeTruthy();
    expect(document.querySelector('.code-block')).not.toBeNull();
    expect(mermaid.render).not.toHaveBeenCalled();
  });

  it('draws a source of exactly the limit', async () => {
    renderWithHost(<Diagram source={'a'.repeat(MAX_DIAGRAM_CHARS)} />);
    await screen.findByRole('img');
    expect(mermaid.render).toHaveBeenCalledTimes(1);
  });

  it('offers the source in a disclosure with a copy button', async () => {
    const { host } = renderWithHost(<Diagram source={SOURCE} />);
    await screen.findByRole('img');
    const details = screen.getByText('Show source').closest('details');
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain(SOURCE);
    fireEvent.click(within(details as HTMLElement).getByRole('button', { name: /Copy/ }));
    expect(host.postedOf('clipboard.copy')).toEqual([{ type: 'clipboard.copy', text: SOURCE }]);
  });

  it('draws nothing and shows the code while the fence is not closed', () => {
    renderWithHost(<Diagram source={SOURCE} closed={false} />);
    expect(document.querySelector('.code-block')?.textContent).toContain(SOURCE);
    expect(mermaid.render).not.toHaveBeenCalled();
  });
});

describe('mermaid fences in chat', () => {
  const state = (text: string) =>
    makeState({
      active: makeActive('c1', {
        messages: [userMessage('u1', 'draw'), assistantMessage('a1', [{ kind: 'text', text }])],
      }),
    });

  it('draws a closed fence', async () => {
    renderWithHost(<MessageList />, state('Here:\n\n```mermaid\ngraph TD; A-->B;\n```\n'));
    expect(await screen.findByRole('img', { name: 'Diagram' })).toBeTruthy();
    expect(mermaid.render).toHaveBeenCalledTimes(1);
  });

  it('does not call Mermaid for an unclosed fence while text streams in, then draws when it closes', async () => {
    const { host } = renderWithHost(<MessageList />, state('```mermaid\ngraph TD;'));
    for (const [i, chunk] of [' A-->B;', '\n'].entries()) {
      host.emit({
        type: 'patch',
        seq: i + 1,
        ops: [
          { op: 'appendText', path: ['active', 'messages', 1, 'parts', 0, 'text'], text: chunk },
        ],
      });
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(mermaid.render).not.toHaveBeenCalled();
    expect(screen.queryByRole('img')).toBeNull();
    expect(document.querySelector('.code-block')?.textContent).toContain('graph TD; A-->B;');

    host.emit({
      type: 'patch',
      seq: 3,
      ops: [
        { op: 'appendText', path: ['active', 'messages', 1, 'parts', 0, 'text'], text: '```\n' },
      ],
    });
    expect(await screen.findByRole('img')).toBeTruthy();
    expect(mermaid.render).toHaveBeenCalledTimes(1);
  });
});
