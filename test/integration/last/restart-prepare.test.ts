import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConversationIdSchema } from '../../../src/shared';
import {
  openViewSession,
  scenarioPath,
  useScenario,
  writeFilesScenario,
} from '../support/agent-turns';
import { activateExtension, waitFor, waitForAsync } from '../support/host';

/** Where the two VS Code launches of a run hand over what the second one has to find again. */
const MARKER_FILE = 'restart-marker.json';
const PENDING_FILE = 'restart-pending.txt';
const PROMPT_TEXT = 'create the restart file';

// Runs last in the `main` run (see `.vscode-test.mjs`): it leaves a named conversation and a pending
// change behind, which the `restart` run then looks for in a fresh VS Code window.
suite('restart: preparation', () => {
  test('leaves a renamed conversation and a pending change for the next launch', async () => {
    const api = await activateExtension();
    const [folder] = api.environment.folders();
    assert.ok(folder);

    const restore = useScenario(writeFilesScenario([{ name: PENDING_FILE, content: 'pending\n' }]));
    const session = await openViewSession(api);
    try {
      session.send({ type: 'turn.send', text: PROMPT_TEXT, mode: 'agent', model: 'default' });
      const state = await session.waitForTurns(1);
      const meta = state.active?.meta;
      assert.ok(meta, 'a conversation is active');
      assert.ok(state.active?.turns.every((turn) => turn.status === 'completed'));
      assert.ok(meta.sessionId, 'the conversation has a provider session');

      const title = `Restart marker ${randomUUID()}`;
      session.send({
        type: 'conversation.rename',
        conversationId: ConversationIdSchema.parse(meta.id),
        title,
      });
      await waitFor('the new title', () =>
        session.state().conversations.some((c) => c.id === meta.id && c.title === title)
          ? true
          : undefined,
      );

      const service = api.controller.review();
      assert.ok(service, 'the review service is available');
      await waitForAsync('the pending change', async () =>
        (await service.entries(folder.key)).some(
          (e) => e.path === PENDING_FILE && e.status === 'pending',
        ),
      );

      const marker = {
        conversationId: meta.id,
        title,
        sessionId: meta.sessionId,
        prompt: PROMPT_TEXT,
        pendingPath: PENDING_FILE,
        folderKey: folder.key,
      };
      fs.writeFileSync(
        path.join(path.dirname(scenarioPath()), MARKER_FILE),
        JSON.stringify(marker, null, 2),
      );
    } finally {
      session.dispose();
      restore();
    }
  });
});
