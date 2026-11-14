// @vitest-environment jsdom
import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MessagePart, PlanDoc } from '../../../shared';
import { App } from '../../app/App';
import {
  assistantMessage,
  convId,
  makeActive,
  makePlanContent,
  makePlanDoc,
  makePlanVersion,
  makeQuestionPrompt,
  makeState,
  makeToolCall,
  makeTurn,
  planId,
  promptId,
  turnId,
  userMessage,
} from '../../test-support/fixtures';
import { renderWithHost } from '../../test-support/harness';
import { Composer } from '../chat/Composer';
import { MessageList } from '../chat/MessageList';
import { registerPartRenderer } from '../chat/registry';
import { PlanUpdateCard } from './PlanUpdateCard';

const PLAN = planId('plan1');

function stateWith(plan: PlanDoc | null, extra: Parameters<typeof makeActive>[1] = {}) {
  return makeState({ active: makeActive('c1', { plan, ...extra }) });
}

const tab = (name: string) => screen.queryByRole('tab', { name });

describe('the Plan tab is gone', () => {
  it('never appears, whether or not the conversation has a plan', () => {
    const { init } = renderWithHost(<App />, stateWith(null));
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Chat', 'History']);
    init(stateWith(makePlanDoc()), 1);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Chat', 'History']);
    expect(tab('Plan')).toBeNull();
  });

  it('shows the plan in the chat, as a card, and nowhere else', () => {
    renderWithHost(<App />, stateWith(makePlanDoc()));
    expect(screen.getByRole('region', { name: 'Add caching' })).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Objective' })).toBeNull();
  });

  it('moves between the two tabs with the arrow keys', () => {
    renderWithHost(<App />, stateWith(makePlanDoc()));
    fireEvent.keyDown(tab('Chat') as HTMLElement, { key: 'ArrowRight' });
    expect(tab('History')?.getAttribute('aria-selected')).toBe('true');
  });

  it('has every button of the chat with a plan named', () => {
    renderWithHost(<App />, stateWith(makePlanDoc()));
    for (const button of screen.getAllByRole('button')) {
      const name = button.getAttribute('aria-label') ?? button.textContent ?? '';
      expect(name.trim(), button.outerHTML).not.toBe('');
    }
  });
});

describe('the plan request and the execution message', () => {
  const EXEC = turnId('t-exec');
  const doc = (executionTurnId?: ReturnType<typeof turnId>) =>
    makePlanDoc({
      versions: [makePlanVersion(1), makePlanVersion(2)],
      approvals: [
        {
          version: 2,
          contentHash: 'hash-v2',
          approvedAt: 1_700_000_900_000,
          ...(executionTurnId ? { executionTurnId } : {}),
        },
      ],
    });
  const articles = () => screen.getAllByRole('article', { name: 'You' });

  it('labels a user message of Plan mode "Plan request" with an icon, above its text', () => {
    renderWithHost(
      <MessageList />,
      stateWith(null, { messages: [userMessage('u1', 'Add caching please', { mode: 'plan' })] }),
    );
    const [article] = articles() as [HTMLElement];
    const label = within(article).getByText('Plan request');
    expect(label.parentElement?.querySelector('.codicon-checklist')).not.toBeNull();
    const text = article.querySelector('.user-text') as HTMLElement;
    expect(text.textContent).toBe('Add caching please');
    expect(label.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders the message of the approved turn as "Plan approved: executing version N"', () => {
    renderWithHost(
      <MessageList />,
      stateWith(doc(EXEC), {
        messages: [
          userMessage('u1', 'plan it', { mode: 'plan' }),
          userMessage('u2', 'Execute plan version 2', { mode: 'agent', turnId: EXEC }),
        ],
      }),
    );
    const [, executing] = articles() as [HTMLElement, HTMLElement];
    const label = within(executing).getByText('Plan approved: executing version 2');
    expect(label.parentElement?.querySelector('.codicon-play')).not.toBeNull();
    expect(within(executing).queryByText('Execute plan version 2')).toBeNull();
    expect(executing.querySelector('.user-text')).toBeNull();
    expect(within(executing).queryByText('Plan request')).toBeNull();
  });

  it('takes the version from the approval, not from the text', () => {
    renderWithHost(
      <MessageList />,
      stateWith(doc(EXEC), {
        messages: [userMessage('u2', 'Execute plan version 9', { mode: 'agent', turnId: EXEC })],
      }),
    );
    expect(screen.getByText('Plan approved: executing version 2')).toBeTruthy();
  });

  it('does not recognise a user message with the same text but no approval', () => {
    renderWithHost(
      <MessageList />,
      stateWith(doc(), {
        messages: [
          userMessage('u2', 'Execute plan version 2', { mode: 'agent', turnId: turnId('t-other') }),
        ],
      }),
    );
    expect(screen.queryByText(/Plan approved/)).toBeNull();
    expect(screen.getByText('Execute plan version 2')).toBeTruthy();
    expect(screen.getByText('Agent')).toBeTruthy();
  });

  it('does not recognise it without any plan', () => {
    renderWithHost(
      <MessageList />,
      stateWith(null, {
        messages: [userMessage('u2', 'Execute plan version 2', { turnId: EXEC })],
      }),
    );
    expect(screen.queryByText(/Plan approved/)).toBeNull();
    expect(screen.getByText('Execute plan version 2')).toBeTruthy();
  });
});

describe('the submit_plan tool card', () => {
  const submit = (status: 'running' | 'done' | 'error' | 'denied') =>
    stateWith(null, {
      messages: [
        userMessage('u1', 'plan it', { mode: 'plan' }),
        assistantMessage('a1', [
          { kind: 'text', text: 'Submitting.' },
          {
            kind: 'tool',
            call: makeToolCall({
              id: 'toolu_s',
              name: 'mcp__agentcanopy__submit_plan',
              input: { plan: '# Plan' },
              status,
            }),
          },
        ]),
      ],
    });

  it('renders nothing once it is done', () => {
    renderWithHost(<MessageList />, submit('done'));
    expect(screen.getByText('Submitting.')).toBeTruthy();
    expect(screen.queryByText('Submitted a plan')).toBeNull();
    expect(document.querySelector('.tool-card')).toBeNull();
  });

  it.each(['running', 'error', 'denied'] as const)('renders as before while it is %s', (status) => {
    renderWithHost(<MessageList />, submit(status));
    expect(screen.getByText('Submitted a plan')).toBeTruthy();
    expect(document.querySelector('.tool-card')).not.toBeNull();
  });

  it('hides only the submit_plan call, not other tools that are done', () => {
    renderWithHost(
      <MessageList />,
      stateWith(null, {
        messages: [
          assistantMessage('a1', [
            { kind: 'tool', call: makeToolCall({ id: 'toolu_r', name: 'mcp__s__t' }) },
            {
              kind: 'tool',
              call: makeToolCall({ id: 'toolu_s', name: 'mcp__agentcanopy__submit_plan' }),
            },
          ]),
        ],
      }),
    );
    expect(document.querySelectorAll('.tool-card')).toHaveLength(1);
  });
});

describe('Plan options', () => {
  const PLAN_TURN = turnId('t-plan');
  const AGENT_TURN = turnId('t-agent');
  const prompt = (turn: ReturnType<typeof turnId>, over = {}) =>
    makeQuestionPrompt('q1', { turnId: turn, ...over });
  const state = (turn: ReturnType<typeof turnId>, over = {}) =>
    makeState({
      active: makeActive('c1', {
        turns: [
          makeTurn({ id: PLAN_TURN, mode: 'plan' }),
          makeTurn({ id: AGENT_TURN, mode: 'agent' }),
        ],
        prompts: [prompt(turn, over)],
        messages: [
          assistantMessage('a1', [{ kind: 'prompt', promptId: promptId('q1') }], { turnId: turn }),
        ],
      }),
    });

  it('presents a pending question of a Plan turn as "Plan options"', () => {
    renderWithHost(<MessageList />, state(PLAN_TURN));
    const card = screen.getByRole('group', {
      name: 'Plan options: Which colour do you prefer?',
    });
    expect(within(card).getByText('Plan options')).toBeTruthy();
    expect(card.classList.contains('prompt-card--plan')).toBe(true);
    expect(within(card).getByText('Needs your answer')).toBeTruthy();
    expect(within(card).getByRole('radio', { name: 'Red' })).toBeTruthy();
  });

  it('keeps answering as it is', () => {
    const { host } = renderWithHost(<MessageList />, state(PLAN_TURN));
    fireEvent.click(screen.getByRole('radio', { name: 'Blue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(host.postedOf('prompt.answer')).toEqual([
      {
        type: 'prompt.answer',
        promptId: promptId('q1'),
        displayHash: 'hash-q1',
        answer: { kind: 'question', answers: { 'Which colour do you prefer?': ['Blue'] } },
      },
    ]);
  });

  it('keeps the label and the record of what was chosen once answered', () => {
    renderWithHost(
      <MessageList />,
      state(PLAN_TURN, { state: 'answered', answered: { 'Which colour do you prefer?': 'Blue' } }),
    );
    const card = screen.getByRole('group', { name: /^Plan options: / });
    expect(within(card).getByText('Plan options')).toBeTruthy();
    expect(within(card).getByText('Which colour do you prefer?')).toBeTruthy();
    expect(within(card).getByText('Blue')).toBeTruthy();
    expect(card.querySelector('dl.plan-decision-record')).not.toBeNull();
    expect(within(card).queryByRole('radio')).toBeNull();
    expect(within(card).queryByText('Needs your answer')).toBeNull();
  });

  it('is unchanged in the other modes', () => {
    renderWithHost(<MessageList />, state(AGENT_TURN));
    const card = screen.getByRole('group', {
      name: 'Question from the agent: Which colour do you prefer?',
    });
    expect(within(card).queryByText('Plan options')).toBeNull();
    expect(card.classList.contains('prompt-card--plan')).toBe(false);
  });

  it('is unchanged when the turn of the prompt is not known', () => {
    renderWithHost(<MessageList />, state(turnId('t-unknown')));
    expect(screen.getByRole('group', { name: /^Question from the agent: / })).toBeTruthy();
    expect(screen.queryByText('Plan options')).toBeNull();
  });

  it('does not touch a permission request of a Plan turn', () => {
    renderWithHost(
      <MessageList />,
      makeState({
        active: makeActive('c1', {
          turns: [makeTurn({ id: PLAN_TURN, mode: 'plan' })],
          prompts: [
            {
              ...makeQuestionPrompt('q2'),
              kind: 'permission',
              toolName: 'Bash',
              category: 'command',
              title: 'Run a terminal command',
              detail: 'ls',
              inputPreview: '',
              choices: ['allow-once'],
              turnId: PLAN_TURN,
            } as never,
          ],
          messages: [
            assistantMessage('a1', [{ kind: 'prompt', promptId: promptId('q2') }], {
              turnId: PLAN_TURN,
            }),
          ],
        }),
      }),
    );
    expect(
      screen.getByRole('group', { name: 'Permission request: Run a terminal command' }),
    ).toBeTruthy();
    expect(screen.queryByText('Plan options')).toBeNull();
  });
});

describe('the whole sequence in one conversation', () => {
  let off: () => void;
  beforeEach(() => {
    off = registerPartRenderer('plan-update', PlanUpdateCard);
  });
  afterEach(() => {
    off();
  });

  it('shows the request, options, older card, current card, execution message and activity in order', () => {
    const PLAN_TURN = turnId('t-plan');
    const EXEC = turnId('t-exec');
    const doc = makePlanDoc({
      versions: [
        makePlanVersion(1, { content: makePlanContent({ title: 'First idea' }) }),
        makePlanVersion(2, { content: makePlanContent({ title: 'Second idea' }) }),
      ],
      decisions: [
        { targetId: 'Which colour?', kind: 'interactive-question', values: ['Red'], decidedAt: 5 },
      ],
      approvals: [{ version: 2, contentHash: 'hash-v2', approvedAt: 9, executionTurnId: EXEC }],
    });
    const parts = (...p: MessagePart[]) => p;
    renderWithHost(
      <MessageList />,
      stateWith(doc, {
        turns: [makeTurn({ id: PLAN_TURN, mode: 'plan' }), makeTurn({ id: EXEC, mode: 'agent' })],
        prompts: [
          makeQuestionPrompt('q1', {
            turnId: PLAN_TURN,
            state: 'answered',
            answered: { 'Which colour do you prefer?': 'Red' },
          }),
        ],
        messages: [
          userMessage('u1', 'Add caching', { mode: 'plan', turnId: PLAN_TURN }),
          assistantMessage(
            'a1',
            parts(
              {
                kind: 'tool',
                call: makeToolCall({ id: 't1', name: 'Read', input: { file_path: 'a.ts' } }),
              },
              { kind: 'prompt', promptId: promptId('q1') },
              { kind: 'plan-update', planId: PLAN, version: 1 },
              { kind: 'plan-update', planId: PLAN, version: 2 },
            ),
            { turnId: PLAN_TURN },
          ),
          userMessage('u2', 'Execute plan version 2', { mode: 'agent', turnId: EXEC }),
          assistantMessage('a2', parts({ kind: 'text', text: 'Working on it.' }), { turnId: EXEC }),
        ],
      }),
    );
    const order = [
      'Plan request',
      'Plan options',
      'Plan version 1',
      'Second idea',
      'Plan approved: executing version 2',
      'Working on it.',
    ].map((text) => screen.getAllByText(text)[0] as HTMLElement);
    for (let i = 1; i < order.length; i++) {
      expect(
        (order[i - 1] as HTMLElement).compareDocumentPosition(order[i] as HTMLElement) &
          Node.DOCUMENT_POSITION_FOLLOWING,
        order[i]?.textContent ?? '',
      ).toBeTruthy();
    }
    expect(document.querySelectorAll('.plan-card')).toHaveLength(2);
    expect(within(current()).getByText('Which colour?')).toBeTruthy();
  });

  function current() {
    return document.querySelector<HTMLElement>('.plan-card--current') as HTMLElement;
  }
});

describe('Composer with a plan', () => {
  const PLAN_HINT_OFF = 'The agent may revise the plan.';
  const PLAN_HINT_ON = 'The plan is locked. The agent can only answer questions about it.';
  const lock = () => screen.getByRole('button', { name: 'Lock plan' });

  function withMode(mode: 'ask' | 'plan' | 'agent', locked = false, plan = true) {
    return stateWith(plan ? makePlanDoc() : null, { meta: { mode, planLocked: locked } });
  }

  it('shows a lock toggle and the unlocked hint in Plan mode', () => {
    renderWithHost(<Composer />, withMode('plan'));
    expect(lock().getAttribute('aria-pressed')).toBe('false');
    expect(lock().getAttribute('title')).toMatch(/cannot change it/);
    expect(screen.getByText(PLAN_HINT_OFF)).toBeTruthy();
  });

  it('puts the toggle in the mode row, next to the mode selector', () => {
    renderWithHost(<Composer />, withMode('plan'));
    const row = lock().closest('.composer-modes');
    expect(row?.querySelector('[role="radiogroup"]')).not.toBeNull();
  });

  it('shows the locked hint and a pressed toggle when the plan is locked', () => {
    renderWithHost(<Composer />, withMode('plan', true));
    expect(lock().getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText(PLAN_HINT_ON)).toBeTruthy();
    expect(screen.queryByText(PLAN_HINT_OFF)).toBeNull();
  });

  it('posts plan.setLocked, and follows the host', () => {
    const { host, init } = renderWithHost(<Composer />, withMode('plan'));
    fireEvent.click(lock());
    expect(host.postedOf('plan.setLocked')).toEqual([
      { type: 'plan.setLocked', conversationId: convId('c1'), locked: true },
    ]);
    expect(lock().getAttribute('aria-pressed')).toBe('false');
    init(withMode('plan', true), 1);
    fireEvent.click(lock());
    expect(host.postedOf('plan.setLocked')[1]?.locked).toBe(false);
  });

  it('says the plan is attached read-only in Ask mode, without a toggle', () => {
    renderWithHost(<Composer />, withMode('ask'));
    expect(screen.getByText('The plan is attached read-only.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Lock plan' })).toBeNull();
  });

  it('says nothing about the plan in Agent mode', () => {
    renderWithHost(<Composer />, withMode('agent'));
    expect(document.querySelector('.composer-hint')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Lock plan' })).toBeNull();
  });

  it('says nothing without a plan', () => {
    renderWithHost(<Composer />, withMode('plan', false, false));
    expect(document.querySelector('.composer-hint')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Lock plan' })).toBeNull();
  });

  it('keeps the lock usable while a turn runs', () => {
    renderWithHost(
      <Composer />,
      stateWith(makePlanDoc(), {
        meta: { mode: 'plan' },
        turns: [makeTurn({ status: 'running' })],
      }),
    );
    expect((lock() as HTMLButtonElement).disabled).toBe(false);
  });
});
