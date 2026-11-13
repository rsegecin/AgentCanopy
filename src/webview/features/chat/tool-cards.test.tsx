// @vitest-environment jsdom
import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { MessagePart, ToolCallView } from '../../../shared';
import {
  assistantMessage,
  makeActive,
  makeState,
  makeToolCall,
  userMessage,
} from '../../test-support/fixtures';
import { renderWithHost } from '../../test-support/harness';
import { MessageList } from './MessageList';
import { DIFF_MAX_LINES } from './tool-present';

function render(calls: ToolCallView[]) {
  const parts: MessagePart[] = calls.map((call) => ({ kind: 'tool', call }));
  return renderWithHost(
    <MessageList />,
    makeState({
      active: makeActive('c1', {
        messages: [userMessage('u1', 'go'), assistantMessage('a1', parts)],
      }),
    }),
  );
}

const call = (name: string, input: unknown, over: Partial<ToolCallView> = {}) =>
  makeToolCall({ id: `toolu_${name}`, name, input, ...over });

const toggleOf = (name: string | RegExp) => screen.getByRole('button', { name });
const open = (name: string | RegExp) => {
  fireEvent.click(toggleOf(name));
};
const cardOf = (button: HTMLElement) => button.closest('.tool-card') as HTMLElement;

describe('Read card', () => {
  it('shows the path from the recording T2 as a link that opens the file', () => {
    const { host } = render([call('Read', { file_path: '/work/notes.txt' })]);
    const card = cardOf(toggleOf('Read'));
    const link = within(card).getByRole('link', { name: '/work/notes.txt' });
    fireEvent.click(link);
    expect(host.postedOf('open.file')).toEqual([{ type: 'open.file', path: '/work/notes.txt' }]);
  });

  it('shows the line range and opens at the first line', () => {
    const { host } = render([call('Read', { file_path: 'src/a.ts', offset: 10, limit: 20 })]);
    const card = cardOf(toggleOf('Read'));
    expect(card.textContent).toContain('lines 10-29');
    fireEvent.click(within(card).getByRole('link'));
    expect(host.postedOf('open.file')).toEqual([{ type: 'open.file', path: 'src/a.ts', line: 10 }]);
  });

  it('opens with the keyboard', () => {
    const { host } = render([call('Read', { file_path: 'src/a.ts' })]);
    const link = screen.getByRole('link', { name: 'src/a.ts' });
    fireEvent.keyDown(link, { key: 'Enter' });
    expect(host.postedOf('open.file')).toHaveLength(1);
  });

  it.each([
    [{ file_path: 'a.ts', limit: 5 }, 'lines 1-5'],
    [{ file_path: 'a.ts', offset: 7 }, 'from line 7'],
  ])('describes %j as %s', (input, text) => {
    render([call('Read', input)]);
    expect(cardOf(toggleOf('Read')).textContent).toContain(text);
  });

  it('ignores an offset or limit that is not a number', () => {
    const { host } = render([call('Read', { file_path: 'a.ts', offset: '3', limit: null })]);
    const card = cardOf(toggleOf('Read'));
    expect(card.textContent).not.toContain('lines');
    fireEvent.click(within(card).getByRole('link'));
    expect(host.postedOf('open.file')).toEqual([{ type: 'open.file', path: 'a.ts' }]);
  });

  it('shows a path too long to open as plain text', () => {
    render([call('Read', { file_path: `/${'a'.repeat(5000)}` })]);
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('Grep and Glob cards', () => {
  it('describes a search with its path', () => {
    render([call('Grep', { pattern: 'TODO', path: 'src' })]);
    const card = cardOf(toggleOf('Search for TODO'));
    expect(card.textContent).toContain('in src');
  });

  it('describes a search with a glob', () => {
    render([call('Grep', { pattern: 'TODO', glob: '*.ts', output_mode: 'content' })]);
    expect(cardOf(toggleOf('Search for TODO')).textContent).toContain('files matching *.ts');
  });

  it('describes a search with both', () => {
    render([call('Grep', { pattern: 'x', path: 'lib', glob: '*.js' })]);
    expect(cardOf(toggleOf('Search for x')).textContent).toContain('in lib, files matching *.js');
  });

  it('describes a file search', () => {
    render([call('Glob', { pattern: '**/*.tsx', path: 'src' })]);
    expect(cardOf(toggleOf('Find files matching **/*.tsx')).textContent).toContain('in src');
  });
});

describe('Bash and PowerShell cards', () => {
  const p1 = {
    command: "printf 'hello' > /work/a.txt && cat /work/a.txt",
    description: 'Create a.txt with content hello and verify it',
  };

  it('uses the description as the title and the command in a monospace block', () => {
    render([call('Bash', p1, { resultPreview: 'hello' })]);
    const button = toggleOf(p1.description);
    const card = cardOf(button);
    expect(card.querySelector('.tool-card-summary')?.textContent).toBe(p1.command);
    open(p1.description);
    expect(card.querySelector('pre.tool-card-command')?.textContent).toBe(p1.command);
    expect(within(card).getByText('hello').tagName).toBe('PRE');
  });

  it('names the card after the kind of command when there is no description', () => {
    render([
      call('Bash', { command: 'ls' }, { id: 'b' }),
      call('PowerShell', { command: 'Get-ChildItem' }, { id: 'p' }),
    ]);
    expect(toggleOf('Run command')).toBeTruthy();
    expect(toggleOf('Run PowerShell command')).toBeTruthy();
  });

  it('cuts the collapsed summary but never the expanded command', () => {
    const command = `echo ${'x'.repeat(5000)}\nsecond line`;
    render([call('Bash', { command })]);
    const card = cardOf(toggleOf(/^Run command/));
    const summary = card.querySelector('.tool-card-summary')?.textContent ?? '';
    expect(summary.length).toBeLessThanOrEqual(120);
    expect(summary.endsWith('…')).toBe(true);
    expect(summary).not.toContain('\n');
    open(/^Run command/);
    const block = card.querySelector('pre.tool-card-command') as HTMLElement;
    expect(block.textContent).toContain(`echo ${'x'.repeat(5000)}`);
    expect(block.textContent).toContain('second line');
  });
});

describe('Edit, Write and NotebookEdit cards', () => {
  it('shows Write with the path from the recording P2 as a link', () => {
    const { host } = render([call('Write', { file_path: '/work/b.txt', content: 'hello' })]);
    const card = cardOf(toggleOf('Write'));
    fireEvent.click(within(card).getByRole('link', { name: '/work/b.txt' }));
    expect(host.postedOf('open.file')).toEqual([{ type: 'open.file', path: '/work/b.txt' }]);
    open('Write');
    expect(card.querySelector('.tool-card-diff')).toBeNull();
  });

  it('shows an Edit as removed lines, then added lines, with labels and signs', () => {
    render([
      call('Edit', {
        file_path: 'src/a.ts',
        old_string: 'const a = 1;\nconst b = 2;\n',
        new_string: 'const a = 10;',
      }),
    ]);
    open('Edit');
    const lines = Array.from(document.querySelectorAll('.diff-line'));
    expect(lines.map((l) => l.textContent)).toEqual([
      'removed -const a = 1;',
      'removed -const b = 2;',
      'added +const a = 10;',
    ]);
    expect(lines[0]?.querySelector('.visually-hidden')?.textContent).toBe('removed ');
    expect(lines[2]?.querySelector('.visually-hidden')?.textContent).toBe('added ');
    expect(lines[0]?.querySelector('.diff-sign')?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByText(/Showing the first/)).toBeNull();
  });

  it('shows only added lines for an insertion and only removed lines for a deletion', () => {
    render([
      call('Edit', { file_path: 'a', old_string: '', new_string: 'new' }, { id: 'i' }),
      call('Edit', { file_path: 'b', old_string: 'old', new_string: '' }, { id: 'd' }),
    ]);
    for (const button of screen.getAllByRole('button', { name: 'Edit' })) fireEvent.click(button);
    expect(Array.from(document.querySelectorAll('.diff-line')).map((l) => l.textContent)).toEqual([
      'added +new',
      'removed -old',
    ]);
  });

  it('caps the before/after view at 40 lines and says so', () => {
    const many = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => `${prefix}${String(i)}`).join('\n');
    render([
      call('Edit', { file_path: 'a', old_string: many('o', 30), new_string: many('n', 30) }),
    ]);
    open('Edit');
    expect(document.querySelectorAll('.diff-line')).toHaveLength(DIFF_MAX_LINES);
    expect(screen.getByText('Showing the first 40 of 60 lines.')).toBeTruthy();
  });

  it('shows no diff when old_string or new_string is not a string', () => {
    render([call('Edit', { file_path: 'a', old_string: 1, new_string: 'x' })]);
    open('Edit');
    expect(document.querySelector('.tool-card-diff')).toBeNull();
    expect(screen.getByRole('link', { name: 'a' })).toBeTruthy();
  });

  it('shows NotebookEdit with the notebook path as a link', () => {
    const { host } = render([
      call('NotebookEdit', { notebook_path: 'nb/analysis.ipynb', new_source: 'x' }),
    ]);
    fireEvent.click(screen.getByRole('link', { name: 'nb/analysis.ipynb' }));
    expect(host.postedOf('open.file')).toEqual([{ type: 'open.file', path: 'nb/analysis.ipynb' }]);
    expect(toggleOf('Edit notebook')).toBeTruthy();
  });
});

describe('web, task, question and MCP cards', () => {
  it('shows a fetched URL as text, not a link, with the prompt', () => {
    render([call('WebFetch', { url: 'https://example.com/a?b=1', prompt: 'Summarise it' })]);
    open('Fetch');
    expect(screen.getAllByText('https://example.com/a?b=1').length).toBeGreaterThan(0);
    expect(screen.getByText('Summarise it')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
    expect(document.querySelector('a')).toBeNull();
  });

  it('shows the web search query', () => {
    render([call('WebSearch', { query: 'vitest jsdom' })]);
    expect(cardOf(toggleOf('Web search')).textContent).toContain('vitest jsdom');
  });

  it('shows a Task with its description as the title', () => {
    render([
      call('Task', { description: 'Survey the tests', prompt: 'p', subagent_type: 'general' }),
    ]);
    expect(cardOf(toggleOf('Survey the tests')).textContent).toContain('general');
  });

  it('shows AskUserQuestion with the count from the recording Q1', () => {
    render([
      call('AskUserQuestion', {
        questions: [
          {
            question: 'Which colour do you prefer?',
            header: 'Colour',
            options: [
              { label: 'Red', description: 'Choose red' },
              { label: 'Blue', description: 'Choose blue' },
            ],
            multiSelect: false,
          },
        ],
      }),
    ]);
    expect(toggleOf('Asked you 1 question')).toBeTruthy();
  });

  it('pluralises the question count', () => {
    render([call('AskUserQuestion', { questions: [{}, {}] })]);
    expect(toggleOf('Asked you 2 questions')).toBeTruthy();
  });

  it('splits an MCP name into server and tool', () => {
    render([
      call('mcp__github__create_issue', { title: 'Bug' }),
      call('mcp__my_server__a__b', {}, { id: 'x' }),
    ]);
    expect(cardOf(toggleOf('github: create_issue')).textContent).toContain('Bug');
    expect(toggleOf('my_server: a__b')).toBeTruthy();
  });

  it('shows a submitted plan', () => {
    render([call('mcp__agentcanopy__submit_plan', { plan: '# Plan' })]);
    expect(toggleOf('Submitted a plan')).toBeTruthy();
  });

  it('falls back to the generic card for a malformed MCP name and for unknown tools', () => {
    render([call('mcp__nope', { a: 'x' }), call('Skill', { skill: 'review' }, { id: 's' })]);
    expect(cardOf(toggleOf('mcp__nope')).textContent).toContain('x');
    expect(cardOf(toggleOf('Skill')).textContent).toContain('review');
  });
});

describe('every card keeps status, approval and the raw disclosure', () => {
  const samples: [string, unknown][] = [
    ['Read', { file_path: 'a.ts' }],
    ['Grep', { pattern: 'x' }],
    ['Glob', { pattern: '*.ts' }],
    ['Bash', { command: 'ls' }],
    ['PowerShell', { command: 'dir' }],
    ['Edit', { file_path: 'a.ts', old_string: 'a', new_string: 'b' }],
    ['Write', { file_path: 'a.ts', content: 'a' }],
    ['NotebookEdit', { notebook_path: 'a.ipynb' }],
    ['WebFetch', { url: 'https://x.test' }],
    ['WebSearch', { query: 'q' }],
    ['Task', { description: 'Do it' }],
    ['AskUserQuestion', { questions: [] }],
    ['mcp__s__t', {}],
    ['mcp__agentcanopy__submit_plan', {}],
    ['Other', { a: 1 }],
  ];

  it.each(samples)('%s', (name, input) => {
    render([
      call(name, input, {
        status: 'error',
        approval: 'policy',
        resultPreview: 'RESULT',
        resultTruncated: true,
      }),
    ]);
    const card = document.querySelector('.tool-card') as HTMLElement;
    const header = card.querySelector('.tool-card-header') as HTMLElement;
    expect(header.textContent).toContain('Failed');
    expect(header.textContent).toContain('Allowed by AgentCanopy');
    const toggle = within(card).getAllByRole('button')[0] as HTMLElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(card.textContent).toContain('RESULT');
    expect(card.textContent).toContain('Output truncated');
    const raw = Array.from(card.querySelectorAll('pre')).map((pre) => pre.textContent);
    expect(raw).toContain(JSON.stringify(input, null, 2));
  });
});

describe('nested calls', () => {
  it('draws calls of a Task inside its disclosure, and not at top level', () => {
    render([
      call('Task', { description: 'Survey' }, { id: 'task1' }),
      call('Read', { file_path: 'a.ts' }, { id: 'r1', parentId: 'task1' }),
      call('Grep', { pattern: 'x' }, { id: 'g1', parentId: 'task1' }),
    ]);
    expect(screen.queryByRole('link', { name: 'a.ts' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Read' })).toBeNull();

    open('Survey');
    const parent = cardOf(toggleOf('Survey'));
    const group = within(parent).getByRole('group', { name: 'Calls made by this one' });
    expect(within(group).getByRole('button', { name: 'Read' })).toBeTruthy();
    expect(within(group).getByRole('button', { name: 'Search for x' })).toBeTruthy();
    expect(within(group).getByRole('link', { name: 'a.ts' })).toBeTruthy();
    expect(group.closest('.tool-card-body')?.hasAttribute('hidden')).toBe(false);
    expect(within(group).getAllByRole('button', { name: /Read|Search/ })).toHaveLength(2);
  });

  it('nests deeper, and a nested card can be opened on its own', () => {
    render([
      call('Task', { description: 'Outer' }, { id: 't1' }),
      call('Task', { description: 'Inner' }, { id: 't2', parentId: 't1' }),
      call('Bash', { command: 'ls', description: 'List' }, { id: 'b1', parentId: 't2' }),
    ]);
    open('Outer');
    open('Inner');
    open('List');
    const outer = cardOf(toggleOf('Outer'));
    const inner = cardOf(toggleOf('Inner'));
    expect(outer.contains(inner)).toBe(true);
    expect(inner.contains(cardOf(toggleOf('List')))).toBe(true);
    expect(inner.classList.contains('tool-card--nested')).toBe(true);
    expect(outer.classList.contains('tool-card--nested')).toBe(false);
  });

  it('draws a call whose parent is not in the message at top level', () => {
    render([call('Read', { file_path: 'a.ts' }, { id: 'orphan', parentId: 'missing' })]);
    const card = cardOf(toggleOf('Read'));
    expect(card.classList.contains('tool-card--nested')).toBe(false);
    expect(card.parentElement?.closest('.tool-card')).toBeNull();
  });

  it('does not loop on calls that name each other as parents', () => {
    render([
      call('Task', { description: 'A' }, { id: 'a', parentId: 'b' }),
      call('Task', { description: 'B' }, { id: 'b', parentId: 'a' }),
      call('Task', { description: 'Self' }, { id: 's', parentId: 's' }),
    ]);
    // Both are drawn at top level (and each also inside the other once opened); nothing recurses.
    expect(toggleOf('Self')).toBeTruthy();
    for (const button of screen.getAllByRole('button', { name: /^[AB]$/ })) fireEvent.click(button);
    expect(screen.getAllByRole('button', { name: /^[AB]$/ }).length).toBeLessThanOrEqual(6);
  });

  it('updates a nested card when its call changes', () => {
    const h = renderWithHost(
      <MessageList />,
      makeState({
        active: makeActive('c1', {
          messages: [
            assistantMessage('a1', [
              { kind: 'tool', call: call('Task', { description: 'Outer' }, { id: 't1' }) },
              {
                kind: 'tool',
                call: call(
                  'Read',
                  { file_path: 'a.ts' },
                  { id: 'r1', parentId: 't1', status: 'running' },
                ),
              },
            ]),
          ],
        }),
      }),
    );
    open('Outer');
    expect(screen.getByText('Running')).toBeTruthy();
    h.host.emit({
      type: 'patch',
      seq: 1,
      ops: [
        { op: 'set', path: ['active', 'messages', 0, 'parts', 1, 'call', 'status'], value: 'done' },
      ],
    });
    expect(screen.queryByText('Running')).toBeNull();
    expect(within(cardOf(toggleOf('Read'))).getAllByText('Done')).toHaveLength(1);
  });
});

describe('malformed input', () => {
  const specialised = [
    'Read',
    'Grep',
    'Glob',
    'Bash',
    'PowerShell',
    'Edit',
    'Write',
    'NotebookEdit',
    'WebFetch',
    'WebSearch',
    'Task',
    'AskUserQuestion',
  ];
  const everyWrongInput: [string, unknown][] = [
    ['undefined', undefined],
    ['null', null],
    ['a string', 'text'],
    ['a number', 42],
    ['a boolean', true],
    ['an array', ['a', 'b']],
    ['an empty object', {}],
    ['unrelated fields', { x: 1 }],
    [
      'numbers in every field',
      {
        file_path: 1,
        notebook_path: 1,
        pattern: 1,
        path: 1,
        glob: 1,
        command: 1,
        description: 1,
        url: 1,
        query: 1,
        old_string: 1,
        new_string: 1,
        questions: 1,
        offset: 'a',
        limit: [],
      },
    ],
    [
      'nulls in every field',
      {
        file_path: null,
        pattern: null,
        command: null,
        url: null,
        query: null,
        description: null,
        questions: null,
      },
    ],
    [
      'empty strings',
      { file_path: '', pattern: '', command: '', url: '', query: '', description: '' },
    ],
    ['nested objects', { file_path: { a: 1 }, command: { b: [] }, questions: {} }],
  ];

  const cases = specialised.flatMap((name) =>
    everyWrongInput.map(([label, input]) => [name, label, input] as const),
  );

  it.each(cases)('%s with %s falls back to the generic card', (name, _label, input) => {
    render([call(name, input)]);
    // The generic card is titled with the tool name.
    const card = document.querySelector('.tool-card') as HTMLElement;
    expect(within(card).getAllByRole('button')[0]?.textContent).toBe(name);
    // And it can still be expanded.
    fireEvent.click(within(card).getAllByRole('button')[0] as HTMLElement);
    expect(card.querySelector('.tool-card-body')?.hasAttribute('hidden')).toBe(false);
    expect(card.querySelector('.tool-card-link')).toBeNull();
  });

  it('survives an input that cannot be turned into JSON', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    render([call('Read', cyclic), call('Other', 10n, { id: 'big' })]);
    for (const button of screen.getAllByRole('button')) fireEvent.click(button);
    expect(screen.getAllByText('(input cannot be shown)').length).toBeGreaterThan(0);
  });

  it('survives a hostile summary field on an unknown tool', () => {
    render([call('Other', { __proto__: { a: 1 }, toString: 'x', command: ['rm'] })]);
    expect(toggleOf('Other')).toBeTruthy();
  });
});

describe('truncated input', () => {
  it('shows the preview and a note for the { truncated, preview } shape', () => {
    render([
      call('Bash', { truncated: true, preview: '{"command":"echo aaaa' }, { inputTruncated: true }),
    ]);
    const card = cardOf(toggleOf('Bash'));
    expect(card.textContent).toContain('{"command":"echo aaaa');
    open('Bash');
    expect(screen.getByText('Input truncated')).toBeTruthy();
    expect(card.querySelector('pre')?.textContent).toBe('{"command":"echo aaaa');
  });

  it('recognises the shape even when inputTruncated is not set', () => {
    render([call('Write', { truncated: true, preview: 'PREVIEW' })]);
    open('Write');
    expect(document.querySelector('pre')?.textContent).toBe('PREVIEW');
    expect(screen.getByText('Input truncated')).toBeTruthy();
  });

  it('notes truncation flagged by inputTruncated alone and keeps the input', () => {
    render([call('Read', { file_path: 'a.ts' }, { inputTruncated: true })]);
    open('Read');
    expect(screen.getByText('Input truncated')).toBeTruthy();
    expect(document.body.textContent).toContain('"file_path": "a.ts"');
  });

  it('shows no note for a complete input', () => {
    render([call('Read', { file_path: 'a.ts' })]);
    open('Read');
    expect(screen.queryByText('Input truncated')).toBeNull();
    expect(screen.queryByText('Output truncated')).toBeNull();
  });
});

describe('tool card accessibility', () => {
  it('gives every control an accessible name and links the disclosure to its body', () => {
    render([
      call('Read', { file_path: 'a.ts' }, { id: 'r' }),
      call('Bash', { command: 'ls' }, { id: 'b' }),
    ]);
    for (const button of screen.getAllByRole('button')) {
      const name = button.getAttribute('aria-label') ?? button.textContent ?? '';
      expect(name.trim().length).toBeGreaterThan(0);
    }
    const toggle = toggleOf('Read');
    const controls = toggle.getAttribute('aria-controls') ?? '';
    expect(document.getElementById(controls)).not.toBeNull();
    // Status and approval are announced with the button.
    const described = document.getElementById(toggle.getAttribute('aria-describedby') ?? '');
    expect(described?.textContent).toContain('Done');
  });
});
