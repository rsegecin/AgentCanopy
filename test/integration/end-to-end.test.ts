import * as assert from 'node:assert';
import { applyPatch, type HostMessage, type ViewState } from '../../src/shared';
import { activateExtension, waitFor } from './support/host';

/** The first answer of the fake CLI scenario: "pong". */
function assistantTexts(state: ViewState): string[] {
  return (state.active?.messages ?? []).flatMap((message) =>
    message.role === 'assistant'
      ? message.parts.flatMap((part) => (part.kind === 'text' ? [part.text] : []))
      : [],
  );
}

suite('end to end with the fake CLI', () => {
  test('a turn runs through the real stack and completes', async () => {
    const { controller } = await activateExtension();
    let state: ViewState | undefined;
    const received: HostMessage[] = [];
    const handle = controller.attachView('panel', {
      post(message) {
        received.push(message);
        if (message.type === 'init') state = message.state;
        else if (message.type === 'patch' && state) state = applyPatch(state, message.ops);
      },
    });
    try {
      handle.receive({ type: 'ready' });
      await waitFor('the initial state', () => state);
      handle.receive({ type: 'turn.send', text: 'ping', mode: 'ask', model: 'default' });

      const done = await waitFor('a completed turn that answered "pong"', () => {
        const turns = state?.active?.turns ?? [];
        const completed = turns.some((turn) => turn.status === 'completed');
        return completed && state && assistantTexts(state).some((t) => t.includes('pong'))
          ? state
          : undefined;
      });

      assert.ok(done.active, 'a conversation is active');
      assert.ok(
        done.conversations.some((c) => c.id === done.active?.meta.id),
        'the conversation is in the list',
      );
      assert.ok(
        received.some((m) => m.type === 'patch'),
        'patches were posted',
      );
    } finally {
      handle.dispose();
    }
  });
});
