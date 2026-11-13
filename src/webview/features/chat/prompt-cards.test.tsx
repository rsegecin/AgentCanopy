// @vitest-environment jsdom
import { fireEvent, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prompt } from '../../../shared';
import {
  assistantMessage,
  makeActive,
  makePermissionPrompt,
  makeQuestionPrompt,
  makeState,
  makeTurn,
  promptId,
  userMessage,
} from '../../test-support/fixtures';
import { renderWithHost } from '../../test-support/harness';
import { Composer } from './Composer';
import { MessageList } from './MessageList';
import { PromptPart } from './PromptCards';
import { registerPartRenderer } from './registry';

let unregister: () => void;
beforeEach(() => {
  unregister = registerPartRenderer('prompt', PromptPart);
});
afterEach(() => {
  unregister();
  vi.restoreAllMocks();
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

function stateWith(prompts: Prompt[]) {
  return makeState({
    active: makeActive('c1', {
      turns: [makeTurn({ status: 'running' })],
      messages: [
        userMessage('u1', 'ask me'),
        assistantMessage(
          'a1',
          prompts.map((p) => ({ kind: 'prompt' as const, promptId: p.id })),
        ),
      ],
      prompts,
    }),
  });
}

const QUESTION = 'Which colour do you prefer?';
const submit = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Submit' });

describe('question card', () => {
  it('shows the header, the question as the group label and the options with descriptions', () => {
    renderWithHost(<MessageList />, stateWith([makeQuestionPrompt('q1')]));
    const card = screen.getByRole('group', { name: `Question from the agent: ${QUESTION}` });
    expect(within(card).getByText('Colour')).toBeTruthy();
    const group = within(card).getByRole('radiogroup', { name: QUESTION });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('aria-labelledby') && r.id)).toHaveLength(3);
    expect(within(group).getByRole('radio', { name: 'Red' })).toBeTruthy();
    expect(within(group).getByRole('radio', { name: 'Blue' })).toBeTruthy();
    expect(within(group).getByRole('radio', { name: 'Other' })).toBeTruthy();
    expect(within(group).getByText('Choose red')).toBeTruthy();
    expect(
      within(group).getByRole('radio', { name: 'Red' }).getAttribute('aria-describedby'),
    ).toBeTruthy();
    expect(within(group).getByRole('textbox', { name: /Other answer/ })).toBeTruthy();
  });

  it('posts a single choice exactly, and only when an answer is given', () => {
    const { host } = renderWithHost(<MessageList />, stateWith([makeQuestionPrompt('q1')]));
    expect(submit().disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'Blue' }));
    expect(submit().disabled).toBe(false);
    fireEvent.click(screen.getByRole('radio', { name: 'Red' }));
    fireEvent.click(submit());
    expect(host.postedOf('prompt.answer')).toEqual([
      {
        type: 'prompt.answer',
        promptId: promptId('q1'),
        displayHash: 'hash-q1',
        answer: { kind: 'question', answers: { [QUESTION]: ['Red'] } },
      },
    ]);
  });

  it('disables the form after posting, until the state changes', () => {
    const { host, init } = renderWithHost(<MessageList />, stateWith([makeQuestionPrompt('q1')]));
    fireEvent.click(screen.getByRole('radio', { name: 'Red' }));
    fireEvent.click(submit());
    expect(submit().disabled).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Blue' }).disabled).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: /Other/ }).disabled).toBe(true);
    fireEvent.submit(submit().closest('form') as HTMLFormElement);
    expect(host.postedOf('prompt.answer')).toHaveLength(1);

    // The host answers with a changed prompt: the card is read-only.
    init(
      stateWith([makeQuestionPrompt('q1', { state: 'answered', answered: { [QUESTION]: 'Red' } })]),
      1,
    );
    expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull();
  });

  it('unlocks the form when the prompt object changes but stays pending', () => {
    const { init } = renderWithHost(<MessageList />, stateWith([makeQuestionPrompt('q1')]));
    fireEvent.click(screen.getByRole('radio', { name: 'Red' }));
    fireEvent.click(submit());
    expect(submit().disabled).toBe(true);
    init(stateWith([makeQuestionPrompt('q1')]), 1);
    expect(submit().disabled).toBe(false);
  });

  it('chooses Other by typing in its field, and posts the text', () => {
    const { host } = renderWithHost(<MessageList />, stateWith([makeQuestionPrompt('q1')]));
    fireEvent.click(screen.getByRole('radio', { name: 'Red' }));
    fireEvent.change(screen.getByRole('textbox', { name: /Other answer/ }), {
      target: { value: '  Purple  ' },
    });
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Other' }).checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Red' }).checked).toBe(false);
    fireEvent.click(submit());
    expect(host.postedOf('prompt.answer')[0]?.answer).toEqual({
      kind: 'question',
      answers: { [QUESTION]: ['Purple'] },
    });
  });

  it('needs text when Other is chosen, and an option is chosen again by clicking it', () => {
    const { host } = renderWithHost(<MessageList />, stateWith([makeQuestionPrompt('q1')]));
    fireEvent.click(screen.getByRole('radio', { name: 'Other' }));
    expect(submit().disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: /Other answer/ }), {
      target: { value: '   ' },
    });
    expect(submit().disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'Blue' }));
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Other' }).checked).toBe(false);
    fireEvent.click(submit());
    expect(host.postedOf('prompt.answer')[0]?.answer).toEqual({
      kind: 'question',
      answers: { [QUESTION]: ['Blue'] },
    });
  });

  const multi = () =>
    makeQuestionPrompt('q2', {
      questions: [
        {
          question: 'Which fruits?',
          header: 'Fruit',
          multiSelect: true,
          options: [
            { label: 'Apple', description: 'Crisp' },
            { label: 'Pear', description: 'Soft' },
            { label: 'Plum', description: '' },
          ],
        },
      ],
    });

  it('uses checkboxes for a multi-select question and posts the labels in option order', () => {
    const { host } = renderWithHost(<MessageList />, stateWith([multi()]));
    const group = screen.getByRole('group', { name: 'Which fruits?' });
    expect(within(group).getAllByRole('checkbox')).toHaveLength(4);
    expect(screen.queryByRole('radio')).toBeNull();
    fireEvent.click(within(group).getByRole('checkbox', { name: 'Plum' }));
    fireEvent.click(within(group).getByRole('checkbox', { name: 'Apple' }));
    fireEvent.click(within(group).getByRole('checkbox', { name: 'Pear' }));
    fireEvent.click(within(group).getByRole('checkbox', { name: 'Pear' }));
    fireEvent.click(submit());
    expect(host.postedOf('prompt.answer')[0]?.answer).toEqual({
      kind: 'question',
      answers: { 'Which fruits?': ['Apple', 'Plum'] },
    });
  });

  it('adds the Other text to the labels for a multi-select question', () => {
    const { host } = renderWithHost(<MessageList />, stateWith([multi()]));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pear' }));
    fireEvent.change(screen.getByRole('textbox', { name: /Other answer/ }), {
      target: { value: 'Fig' },
    });
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Other' }).checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Pear' }).checked).toBe(true);
    fireEvent.click(submit());
    expect(host.postedOf('prompt.answer')[0]?.answer).toEqual({
      kind: 'question',
      answers: { 'Which fruits?': ['Pear', 'Fig'] },
    });
  });

  it('accepts Other alone for a multi-select question, and not an empty Other', () => {
    const { host } = renderWithHost(<MessageList />, stateWith([multi()]));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Other' }));
    expect(submit().disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: /Other answer/ }), {
      target: { value: 'Fig' },
    });
    fireEvent.click(submit());
    expect(host.postedOf('prompt.answer')[0]?.answer).toEqual({
      kind: 'question',
      answers: { 'Which fruits?': ['Fig'] },
    });
  });

  it('needs an answer to every question before Submit is enabled', () => {
    const two = makeQuestionPrompt('q3', {
      questions: [...makeQuestionPrompt('x').questions, ...multi().questions],
    });
    const { host } = renderWithHost(<MessageList />, stateWith([two]));
    expect(screen.getAllByRole('radiogroup')).toHaveLength(1);
    fireEvent.click(screen.getByRole('radio', { name: 'Red' }));
    expect(submit().disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Apple' }));
    expect(submit().disabled).toBe(false);
    fireEvent.click(submit());
    expect(host.postedOf('prompt.answer')[0]?.answer).toEqual({
      kind: 'question',
      answers: { [QUESTION]: ['Red'], 'Which fruits?': ['Apple'] },
    });
  });

  it('keeps the selections across an unmount and a remount of the log', () => {
    function Switcher() {
      const [shown, setShown] = useState(true);
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setShown((v) => !v);
            }}
          >
            Toggle
          </button>
          {shown && <MessageList />}
        </>
      );
    }
    renderWithHost(<Switcher />, stateWith([makeQuestionPrompt('q1')]));
    fireEvent.click(screen.getByRole('radio', { name: 'Blue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Toggle' }));
    expect(screen.queryByRole('radio')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Toggle' }));
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Blue' }).checked).toBe(true);
    expect(submit().disabled).toBe(false);
  });

  it('restores selections from the saved UI state', () => {
    const first = renderWithHost(<MessageList />, stateWith([multi()]));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pear' }));
    fireEvent.change(screen.getByRole('textbox', { name: /Other answer/ }), {
      target: { value: 'Fig' },
    });
    first.services.ui.flush();
    const saved = first.host.saved;
    first.unmount();

    renderWithHost(<MessageList />, stateWith([multi()]), saved);
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Pear' }).checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Apple' }).checked).toBe(false);
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Other' }).checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: /Other answer/ }).value).toBe(
      'Fig',
    );
    expect(submit().disabled).toBe(false);
  });

  it('keeps selections per prompt', () => {
    const a = makeQuestionPrompt('qa');
    const b = makeQuestionPrompt('qb');
    renderWithHost(<MessageList />, stateWith([a, b]));
    const groups = screen.getAllByRole('radiogroup');
    fireEvent.click(within(groups[0] as HTMLElement).getByRole('radio', { name: 'Red' }));
    expect(
      within(groups[1] as HTMLElement).getByRole<HTMLInputElement>('radio', { name: 'Red' })
        .checked,
    ).toBe(false);
  });

  it('ignores a saved selection of an option that no longer exists', () => {
    const first = renderWithHost(<MessageList />, stateWith([makeQuestionPrompt('q1')]));
    fireEvent.click(screen.getByRole('radio', { name: 'Blue' }));
    first.services.ui.flush();
    const saved = first.host.saved;
    first.unmount();
    const changed = makeQuestionPrompt('q1', {
      questions: [
        {
          question: QUESTION,
          header: 'Colour',
          multiSelect: false,
          options: [{ label: 'Green', description: '' }],
        },
      ],
    });
    renderWithHost(<MessageList />, stateWith([changed]), saved);
    expect(submit().disabled).toBe(true);
  });

  it('shows an answered question read-only with the chosen answer', () => {
    renderWithHost(
      <MessageList />,
      stateWith([
        makeQuestionPrompt('q1', { state: 'answered', answered: { [QUESTION]: 'Red, Blue' } }),
      ]),
    );
    const card = screen.getByRole('group', { name: /Question from the agent/ });
    expect(within(card).getByText(QUESTION)).toBeTruthy();
    expect(within(card).getByText('Red, Blue')).toBeTruthy();
    expect(within(card).queryByRole('radio')).toBeNull();
    expect(within(card).queryByRole('button')).toBeNull();
    expect(screen.queryByText('Needs your answer')).toBeNull();
  });

  it('shows an answered question without a recorded answer', () => {
    renderWithHost(<MessageList />, stateWith([makeQuestionPrompt('q1', { state: 'answered' })]));
    expect(screen.getByText('No answer recorded')).toBeTruthy();
  });

  it('shows an expired and a cancelled question', () => {
    renderWithHost(
      <MessageList />,
      stateWith([
        makeQuestionPrompt('q1', { state: 'expired' }),
        makeQuestionPrompt('q2', { state: 'cancelled' }),
      ]),
    );
    expect(screen.getByText('This question expired because the turn ended.')).toBeTruthy();
    expect(screen.getByText('This question was cancelled.')).toBeTruthy();
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('names a card with several questions after the first', () => {
    const two = makeQuestionPrompt('q3', {
      questions: [...makeQuestionPrompt('x').questions, ...multi().questions],
    });
    renderWithHost(<MessageList />, stateWith([two]));
    expect(
      screen.getByRole('group', { name: `Question from the agent: ${QUESTION} (and 1 more)` }),
    ).toBeTruthy();
  });
});

describe('permission card', () => {
  const card = () =>
    screen.getByRole('group', { name: 'Permission request: Run a terminal command' });

  it('shows the title, the detail and one button per choice in order', () => {
    renderWithHost(<MessageList />, stateWith([makePermissionPrompt('p1')]));
    const group = card();
    expect(within(group).getByText('Run a terminal command')).toBeTruthy();
    expect(within(group).getByText("printf 'hello' > /work/a.txt && cat /work/a.txt").tagName).toBe(
      'PRE',
    );
    expect(
      within(group)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Allow once', 'Always allow', 'Deny']);
  });

  it('orders the buttons canonically and shows only the choices offered', () => {
    renderWithHost(
      <MessageList />,
      stateWith([makePermissionPrompt('p1', { choices: ['deny', 'allow-once'] })]),
    );
    expect(
      within(card())
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Allow once', 'Deny']);
  });

  it.each([
    ['Allow once', 'allow-once'],
    ['Always allow', 'allow-always'],
    ['Deny', 'deny'],
  ] as const)('%s posts %s with the displayed hash', (label, choice) => {
    const { host } = renderWithHost(<MessageList />, stateWith([makePermissionPrompt('p1')]));
    fireEvent.click(within(card()).getByRole('button', { name: label }));
    expect(host.postedOf('prompt.answer')).toEqual([
      {
        type: 'prompt.answer',
        promptId: promptId('p1'),
        displayHash: 'hash-p1',
        answer: { kind: 'permission', choice },
      },
    ]);
  });

  it('sends the feedback with a Deny only', () => {
    const { host } = renderWithHost(<MessageList />, stateWith([makePermissionPrompt('p1')]));
    fireEvent.change(
      within(card()).getByRole('textbox', {
        name: 'Tell the agent what to do instead (optional)',
      }),
      { target: { value: '  use npm ci instead  ' } },
    );
    fireEvent.click(within(card()).getByRole('button', { name: 'Deny' }));
    expect(host.postedOf('prompt.answer')[0]?.answer).toEqual({
      kind: 'permission',
      choice: 'deny',
      feedback: 'use npm ci instead',
    });
  });

  it('does not send the feedback with an allow', () => {
    const { host } = renderWithHost(<MessageList />, stateWith([makePermissionPrompt('p1')]));
    fireEvent.change(within(card()).getByRole('textbox'), { target: { value: 'ignored' } });
    fireEvent.click(within(card()).getByRole('button', { name: 'Allow once' }));
    expect(host.postedOf('prompt.answer')[0]?.answer).toEqual({
      kind: 'permission',
      choice: 'allow-once',
    });
  });

  it('disables the buttons after an answer was posted', () => {
    const { host } = renderWithHost(<MessageList />, stateWith([makePermissionPrompt('p1')]));
    fireEvent.click(within(card()).getByRole('button', { name: 'Deny' }));
    for (const button of within(card()).getAllByRole<HTMLButtonElement>('button')) {
      expect(button.disabled).toBe(true);
    }
    fireEvent.click(within(card()).getByRole('button', { name: 'Allow once' }));
    expect(host.postedOf('prompt.answer')).toHaveLength(1);
  });

  it('shows the rule Always allow would add, and the project-code warning', () => {
    renderWithHost(
      <MessageList />,
      stateWith([
        makePermissionPrompt('p1', {
          alwaysRule: { rule: 'Bash(npm test:*)', runsProjectCode: true },
        }),
      ]),
    );
    const group = card();
    const rule = within(group).getByText(/Always allow would add the rule:/);
    expect(rule.textContent).toBe('Always allow would add the rule: Bash(npm test:*)');
    expect(rule.querySelector('code')?.textContent).toBe('Bash(npm test:*)');
    expect(
      within(group).getByText(
        'This command runs code from the project, which can do anything you can do.',
      ),
    ).toBeTruthy();
    // The rule comes after the buttons.
    const buttons = within(group).getByRole('button', { name: 'Deny' });
    expect(buttons.compareDocumentPosition(rule) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows the rule without the warning when it does not run project code', () => {
    renderWithHost(
      <MessageList />,
      stateWith([
        makePermissionPrompt('p1', {
          alwaysRule: { rule: 'Read(src/**)', runsProjectCode: false },
        }),
      ]),
    );
    expect(screen.getByText(/Always allow would add the rule:/)).toBeTruthy();
    expect(screen.queryByText(/runs code from the project/)).toBeNull();
  });

  it('shows neither without a rule', () => {
    renderWithHost(<MessageList />, stateWith([makePermissionPrompt('p1')]));
    expect(screen.queryByText(/Always allow would add the rule/)).toBeNull();
    expect(screen.queryByText(/runs code from the project/)).toBeNull();
  });

  it('shows a 5,000-character command in full, in a monospace block that does not scroll', () => {
    const command = `${'echo hello && '.repeat(400)}done`.slice(0, 5000);
    expect(command).toHaveLength(5000);
    renderWithHost(<MessageList />, stateWith([makePermissionPrompt('p1', { detail: command })]));
    const block = within(card()).getByRole('region', { name: 'Full text of the request' });
    expect(block.tagName).toBe('PRE');
    expect(block.textContent).toBe(command);
    // It grows with its text instead of scrolling inside a box of its own.
    expect(block.hasAttribute('tabindex')).toBe(false);
    expect(block.classList.contains('prompt-detail')).toBe(true);
  });

  it('puts the input preview in a Details disclosure', () => {
    renderWithHost(
      <MessageList />,
      stateWith([makePermissionPrompt('p1', { inputPreview: '{ "command": "ls" }' })]),
    );
    const details = within(card()).getByText('Details').closest('details');
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain('{ "command": "ls" }');
  });

  it('omits an empty Details disclosure', () => {
    renderWithHost(<MessageList />, stateWith([makePermissionPrompt('p1', { inputPreview: '' })]));
    expect(screen.queryByText('Details')).toBeNull();
  });

  it.each([
    ['allow-once', 'You allowed this once'],
    ['allow-always', 'You always allow this'],
    ['deny', 'You denied this'],
  ] as const)('shows an answered request (%s) read-only', (answered, text) => {
    renderWithHost(
      <MessageList />,
      stateWith([makePermissionPrompt('p1', { state: 'answered', answered })]),
    );
    expect(within(card()).getByText(text)).toBeTruthy();
    expect(within(card()).queryByRole('button')).toBeNull();
    expect(within(card()).queryByRole('textbox')).toBeNull();
  });

  it('shows an expired and a cancelled request read-only', () => {
    renderWithHost(
      <MessageList />,
      stateWith([
        makePermissionPrompt('p1', { state: 'expired' }),
        makePermissionPrompt('p2', { state: 'cancelled' }),
      ]),
    );
    expect(screen.getByText('This request expired because the turn ended.')).toBeTruthy();
    expect(screen.getByText('This request was cancelled.')).toBeTruthy();
    expect(document.querySelector('.prompt-card button')).toBeNull();
  });
});

describe('prompt cards in the log', () => {
  it('falls back to the placeholder line when the prompt is missing', () => {
    renderWithHost(
      <MessageList />,
      makeState({
        active: makeActive('c1', {
          messages: [assistantMessage('a1', [{ kind: 'prompt', promptId: promptId('gone') }])],
        }),
      }),
    );
    expect(screen.getByText('Waiting for your answer')).toBeTruthy();
    expect(screen.queryByRole('group')).toBeNull();
  });

  it('marks only the first pending prompt as needing an answer', () => {
    renderWithHost(
      <MessageList />,
      stateWith([
        makeQuestionPrompt('q0', { state: 'answered', answered: { [QUESTION]: 'Red' } }),
        makePermissionPrompt('p1'),
        makeQuestionPrompt('q2'),
      ]),
    );
    const marks = screen.getAllByText('Needs your answer');
    expect(marks).toHaveLength(1);
    expect(marks[0]?.closest('[role="group"]')?.getAttribute('aria-label')).toBe(
      'Permission request: Run a terminal command',
    );
  });

  it('moves the marker when the first prompt is answered', () => {
    const { init } = renderWithHost(
      <MessageList />,
      stateWith([makePermissionPrompt('p1'), makeQuestionPrompt('q2')]),
    );
    init(
      stateWith([
        makePermissionPrompt('p1', { state: 'answered', answered: 'deny' }),
        makeQuestionPrompt('q2'),
      ]),
      1,
    );
    expect(
      screen.getByText('Needs your answer').closest('[role="group"]')?.getAttribute('aria-label'),
    ).toMatch(/^Question from the agent/);
  });

  it('scrolls a new pending prompt into view without taking focus', () => {
    const scrollIntoView = vi.fn();
    (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView = scrollIntoView;
    const { init } = renderWithHost(
      <>
        <MessageList />
        <Composer />
      </>,
      stateWith([]),
    );
    const box = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' });
    box.focus();
    expect(scrollIntoView).not.toHaveBeenCalled();
    init(stateWith([makeQuestionPrompt('q1')]), 1);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(box);
  });

  it('does not scroll a prompt that is not the first pending one', () => {
    const scrollIntoView = vi.fn();
    (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView = scrollIntoView;
    renderWithHost(<MessageList />, stateWith([makeQuestionPrompt('q0', { state: 'cancelled' })]));
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('only marks prompts of the open conversation', () => {
    renderWithHost(
      <MessageList />,
      makeState({
        active: makeActive('c1', { messages: [], prompts: [makeQuestionPrompt('q1')] }),
      }),
    );
    expect(screen.queryByText('Needs your answer')).toBeNull();
  });
});

describe('prompt card accessibility', () => {
  it('gives every button, input and group an accessible name', () => {
    renderWithHost(
      <MessageList />,
      stateWith([
        makeQuestionPrompt('q1'),
        makePermissionPrompt('p1', { alwaysRule: { rule: 'r', runsProjectCode: true } }),
      ]),
    );
    const nameOf = (el: HTMLElement) => {
      const label = el.getAttribute('aria-label');
      if (label) return label;
      const by = el.getAttribute('aria-labelledby');
      if (by)
        return by
          .split(' ')
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' ');
      const wrapped = el.closest('label')?.textContent;
      if (wrapped) return wrapped;
      const id = el.getAttribute('id');
      const forLabel = id ? document.querySelector(`label[for="${id}"]`)?.textContent : null;
      return forLabel ?? el.textContent ?? '';
    };
    for (const el of screen.getAllByRole('button')) {
      if (el.closest('.prompt-card')) expect(nameOf(el).trim()).not.toBe('');
    }
    for (const el of document.querySelectorAll<HTMLElement>('.prompt-card input')) {
      expect(nameOf(el).trim()).not.toBe('');
    }
    const cards = document.querySelectorAll('.prompt-card');
    expect(cards).toHaveLength(2);
    for (const group of cards) {
      expect(group.getAttribute('role')).toBe('group');
      expect(group.getAttribute('aria-label')).toBeTruthy();
    }
    for (const group of screen.getAllByRole('radiogroup')) {
      expect(group.getAttribute('aria-labelledby')).toBeTruthy();
    }
  });
});
