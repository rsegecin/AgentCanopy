import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ConversationIdSchema } from '../../../src/shared';
import { openViewSession, scenarioPath } from '../support/agent-turns';
import { activateExtension, waitFor, waitForAsync } from '../support/host';

interface Marker {
  conversationId: string;
  title: string;
  sessionId: string;
  prompt: string;
  pendingPath: string;
  folderKey: string;
}

// Runs in the `restart` run: a second VS Code launch with the same profile and workspace folder as
// the `main` run, after `last/restart-prepare.test.ts` left its marker file behind.
suite('restart: what a new window finds', () => {
  const root = (): string => path.dirname(scenarioPath());
  let marker: Marker;

  suiteSetup(() => {
    const file = path.join(root(), 'restart-marker.json');
    assert.ok(fs.existsSync(file), 'the main run did not leave a marker: did it run first?');
    marker = JSON.parse(fs.readFileSync(file, 'utf8')) as Marker;
  });

  test('the conversation is listed with its title and opens with its messages', async () => {
    const api = await activateExtension();
    const session = await openViewSession(api);
    try {
      const summary = await waitFor('the stored conversation in the list', () =>
        session.state().conversations.find((c) => c.id === marker.conversationId),
      );
      assert.strictEqual(summary.title, marker.title);

      session.send({
        type: 'conversation.open',
        conversationId: ConversationIdSchema.parse(marker.conversationId),
      });
      const active = await waitFor('the conversation to open', () => {
        const current = session.state().active;
        return current?.meta.id === marker.conversationId && current.messages.length > 0
          ? current
          : undefined;
      });
      const user = active.messages.find((m) => m.role === 'user');
      assert.ok(user && user.role === 'user');
      assert.strictEqual(user.text, marker.prompt);
      assert.ok(
        active.messages.some(
          (m) =>
            m.role === 'assistant' && m.parts.some((p) => p.kind === 'text' && p.text === 'done'),
        ),
        'the assistant answer is there',
      );
      assert.strictEqual(active.meta.sessionId, marker.sessionId);
    } finally {
      session.dispose();
    }
  });

  test('the pending change is still listed for review', async () => {
    const api = await activateExtension();
    const folder = api.environment.folders()[0];
    assert.ok(folder);
    assert.strictEqual(folder.key, marker.folderKey, 'the folder key is stable across launches');
    const service = await waitFor('the review service', () => api.controller.review());
    const entry = await waitForAsync('the pending entry', async () =>
      (await service.entries(folder.key)).find(
        (e) => e.path === marker.pendingPath && e.status === 'pending',
      ),
    );
    assert.strictEqual(entry.changeType, 'created');
  });

  test('a new turn resumes the stored provider session', async () => {
    const recordPath = process.env.FAKE_CLAUDE_RECORD;
    assert.ok(recordPath, 'FAKE_CLAUDE_RECORD must be set for the restart run');
    fs.rmSync(recordPath, { force: true });

    const api = await activateExtension();
    const session = await openViewSession(api);
    try {
      const conversationId = ConversationIdSchema.parse(marker.conversationId);
      session.send({ type: 'conversation.open', conversationId });
      await waitFor('the conversation to open', () =>
        session.state().active?.meta.id === marker.conversationId ? true : undefined,
      );
      session.send({
        type: 'turn.send',
        conversationId,
        text: 'and again',
        mode: 'agent',
        model: 'default',
      });
      await session.waitForTurns(2);
    } finally {
      session.dispose();
    }

    const recorded = JSON.parse(fs.readFileSync(recordPath, 'utf8')) as { argv: string[] };
    const at = recorded.argv.indexOf('--resume');
    assert.ok(at >= 0, `--resume is missing from ${recorded.argv.join(' ')}`);
    assert.strictEqual(recorded.argv[at + 1], marker.sessionId);
  });
});
