import { describe, expect, it } from 'vitest';
import {
  ApprovalSourceSchema,
  AttachmentSchema,
  ConversationMetaSchema,
  DEFAULT_SETTINGS,
  MAX_IMAGE_BASE64_LENGTH,
  MAX_IMAGE_BYTES,
  EMPTY_VIEW_STATE,
  FolderPermissionsSchema,
  HostMessageSchema,
  PERMISSION_SWITCHES,
  PermissionPromptSchema,
  PlanContentSchema,
  RelPathSchema,
  SavedPermissionSchema,
  SettingsSchema,
  UserMessageSchema,
  ViewStateSchema,
  WebviewMessageSchema,
} from './index';

describe('shared contracts', () => {
  it('accepts the default settings and the empty view state', () => {
    expect(SettingsSchema.parse(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
    expect(ViewStateSchema.parse(EMPTY_VIEW_STATE)).toEqual(EMPTY_VIEW_STATE);
  });

  it('has the Auto settings, on and off by default', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ agentAuto: true, agentAutoWebTools: true });
    expect(EMPTY_VIEW_STATE.agentAuto).toEqual({ offered: false, commands: false });
    expect(EMPTY_VIEW_STATE.draftAgentAuto).toBe(false);
  });

  it('accepts the auto approval source', () => {
    expect(ApprovalSourceSchema.safeParse('auto').success).toBe(true);
    expect(ApprovalSourceSchema.safeParse('automatic').success).toBe(false);
  });

  it('parses a conversation meta with and without agentAuto', () => {
    const meta = {
      id: 'c1',
      title: 'T',
      createdAt: 1,
      updatedAt: 1,
      folder: 'f1',
      providerId: 'claude',
      model: 'default',
      mode: 'agent',
      planLocked: false,
    };
    expect(ConversationMetaSchema.parse(meta)).not.toHaveProperty('agentAuto');
    expect(ConversationMetaSchema.parse({ ...meta, agentAuto: true }).agentAuto).toBe(true);
    expect(ConversationMetaSchema.safeParse({ ...meta, agentAuto: 'yes' }).success).toBe(false);
  });

  it('parses a user message with and without auto', () => {
    const message = {
      role: 'user',
      id: 'm1',
      turnId: 't1',
      createdAt: 1,
      text: 'hi',
      mode: 'agent',
      attachments: [],
    };
    expect(UserMessageSchema.parse(message)).not.toHaveProperty('auto');
    expect(UserMessageSchema.parse({ ...message, auto: true }).auto).toBe(true);
    expect(UserMessageSchema.safeParse({ ...message, auto: 1 }).success).toBe(false);
  });

  it('parses the Auto webview message', () => {
    expect(WebviewMessageSchema.safeParse({ type: 'conversation.setAuto', on: true }).success).toBe(
      true,
    );
    expect(
      WebviewMessageSchema.safeParse({
        type: 'conversation.setAuto',
        conversationId: 'c1',
        on: false,
      }).success,
    ).toBe(true);
    expect(WebviewMessageSchema.safeParse({ type: 'conversation.setAuto' }).success).toBe(false);
  });

  it('starts with no permissions and parses the permissions state', () => {
    expect(EMPTY_VIEW_STATE.permissions).toEqual({ folder: null, switches: [], saved: [] });
    expect(EMPTY_VIEW_STATE.policySettings).toEqual({
      editApproval: 'auto',
      alwaysAskCommands: false,
      askWebTools: false,
      autoOffered: false,
      autoWebTools: false,
      sandbox: false,
    });
    expect(PERMISSION_SWITCHES).toEqual(['read-outside', 'web-fetch', 'web-search']);
    const permissions = {
      folder: 'f1',
      switches: ['read-outside'],
      saved: [
        { id: 'a1', kind: 'read-directory', text: 'D:\\libs\\shared' },
        { id: 'a5', kind: 'edit-directory', text: 'D:\\libs\\docs' },
        { id: 'a2', kind: 'web-site', text: 'docs.example.com' },
        { id: 'a3', kind: 'command', text: 'npm test', shell: 'powershell', runsProjectCode: true },
        { id: 'a4', kind: 'mcp-tool', text: 'mcp__docs__search' },
      ],
    };
    expect(FolderPermissionsSchema.safeParse(permissions).success).toBe(true);
    expect(
      FolderPermissionsSchema.safeParse({ ...permissions, switches: ['commands'] }).success,
    ).toBe(false);
    expect(SavedPermissionSchema.safeParse({ id: 'a1', kind: 'edit', text: 'x' }).success).toBe(
      false,
    );
    expect(
      SavedPermissionSchema.safeParse({ id: 'a'.repeat(65), kind: 'web-site', text: 'x' }).success,
    ).toBe(false);
  });

  it('parses a permission prompt with and without the kind of its always rule', () => {
    const prompt = {
      id: 'p1',
      conversationId: 'c1',
      turnId: 't1',
      toolCallId: 'toolu_1',
      createdAt: 1,
      state: 'pending',
      displayHash: 'h',
      kind: 'permission',
      toolName: 'Bash',
      category: 'command',
      title: 'Run a terminal command',
      detail: 'npm test',
      inputPreview: '{}',
      choices: ['allow-once', 'allow-always', 'deny'],
    };
    // As stored before the kind existed.
    const stored = PermissionPromptSchema.parse({
      ...prompt,
      alwaysRule: { rule: 'Bash(npm test)', runsProjectCode: true },
    });
    expect(stored.alwaysRule).toEqual({ rule: 'Bash(npm test)', runsProjectCode: true });
    for (const kind of ['command', 'tool', 'read-directory', 'edit-directory', 'web-site']) {
      const parsed = PermissionPromptSchema.parse({
        ...prompt,
        alwaysRule: { kind, rule: 'x', runsProjectCode: false },
      });
      expect(parsed.alwaysRule?.kind).toBe(kind);
    }
    expect(
      PermissionPromptSchema.safeParse({
        ...prompt,
        alwaysRule: { kind: 'delete-directory', rule: 'x', runsProjectCode: false },
      }).success,
    ).toBe(false);
  });

  it('parses the permissions webview messages', () => {
    expect(WebviewMessageSchema.safeParse({ type: 'permissions.remove', id: 'a1' }).success).toBe(
      true,
    );
    for (const bad of [
      { type: 'permissions.remove' },
      { type: 'permissions.remove', id: '' },
      { type: 'permissions.remove', id: 'a'.repeat(65) },
      { type: 'permissions.setSwitch', name: 'read-outside' },
      { type: 'permissions.setSwitch', name: 'commands', on: true },
      { type: 'permissions.setSwitch', name: 'web-fetch', on: 'yes' },
    ]) {
      expect(WebviewMessageSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    for (const name of PERMISSION_SWITCHES) {
      expect(
        WebviewMessageSchema.safeParse({ type: 'permissions.setSwitch', name, on: true }).success,
      ).toBe(true);
    }
    expect(WebviewMessageSchema.safeParse({ type: 'permissions.addDirectory' }).success).toBe(true);
    expect(WebviewMessageSchema.safeParse({ type: 'settings.open' }).success).toBe(true);
    // No message carries a folder or a path: the host uses the folder the view shows.
    const added = WebviewMessageSchema.parse({ type: 'permissions.addDirectory', path: 'C:\\' });
    expect(added).toEqual({ type: 'permissions.addDirectory' });
    const addedForEdits = WebviewMessageSchema.parse({
      type: 'permissions.addEditDirectory',
      path: 'C:\\',
    });
    expect(addedForEdits).toEqual({ type: 'permissions.addEditDirectory' });
    expect(
      HostMessageSchema.safeParse({
        type: 'event',
        event: { kind: 'show-tab', tab: 'permissions' },
      }).success,
    ).toBe(true);
  });

  it('rejects paths that leave the folder', () => {
    for (const bad of ['/etc/passwd', '../x', 'a/../../x', 'C:/x', '']) {
      expect(RelPathSchema.safeParse(bad).success, bad).toBe(false);
    }
    expect(RelPathSchema.safeParse('src/a..b/c.ts').success).toBe(true);
  });

  it('rejects unknown and malformed webview messages', () => {
    expect(WebviewMessageSchema.safeParse({ type: 'nope' }).success).toBe(false);
    expect(
      WebviewMessageSchema.safeParse({ type: 'turn.send', text: '', mode: 'ask', model: 'x' })
        .success,
    ).toBe(false);
    expect(
      WebviewMessageSchema.safeParse({ type: 'turn.send', text: 'hi', mode: 'root', model: 'x' })
        .success,
    ).toBe(false);
    expect(
      WebviewMessageSchema.safeParse({ type: 'review.rejectFile', path: '../../etc/hosts' })
        .success,
    ).toBe(false);
    expect(
      WebviewMessageSchema.safeParse({
        type: 'turn.send',
        text: 'hi',
        mode: 'ask',
        model: 'default',
      }).success,
    ).toBe(true);
  });

  it('accepts image references and pasted images within the limits', () => {
    const id = 'a'.repeat(64);
    const image = { kind: 'image', id, mediaType: 'image/png', bytes: 120 };
    expect(AttachmentSchema.safeParse(image).success).toBe(true);
    for (const bad of [
      { ...image, id: 'A'.repeat(64) },
      { ...image, id: '../x' },
      { ...image, mediaType: 'image/svg+xml' },
      { ...image, bytes: 0 },
      { ...image, bytes: MAX_IMAGE_BYTES + 1 },
    ]) {
      expect(AttachmentSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    const paste = { type: 'context.pasteImage', mediaType: 'image/png', data: 'iVBORw0KGgo=' };
    expect(WebviewMessageSchema.safeParse(paste).success).toBe(true);
    expect(WebviewMessageSchema.safeParse({ ...paste, data: '' }).success).toBe(false);
    expect(
      WebviewMessageSchema.safeParse({ ...paste, data: 'A'.repeat(MAX_IMAGE_BASE64_LENGTH + 1) })
        .success,
    ).toBe(false);
    expect(WebviewMessageSchema.safeParse({ ...paste, mediaType: 'application/pdf' }).success).toBe(
      false,
    );
    expect(MAX_IMAGE_BASE64_LENGTH).toBe(Math.ceil(MAX_IMAGE_BYTES / 3) * 4);
  });

  it('validates host messages', () => {
    expect(
      HostMessageSchema.safeParse({ type: 'init', seq: 0, state: EMPTY_VIEW_STATE }).success,
    ).toBe(true);
    expect(HostMessageSchema.safeParse({ type: 'patch', seq: 1, ops: [] }).success).toBe(false);
  });

  it('fills plan defaults and converts to JSON Schema', async () => {
    const plan = PlanContentSchema.parse({
      title: 'Demo',
      objective: 'Show the schema',
      stages: [{ id: 's1', title: 'One', description: 'Do it' }],
    });
    expect(plan.stages[0]?.dependsOn).toEqual([]);
    const { z } = await import('zod');
    const schema = z.toJSONSchema(PlanContentSchema, { io: 'input' }) as {
      type?: string;
      required?: string[];
    };
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(expect.arrayContaining(['title', 'objective', 'stages']));
    expect(schema.required).not.toContain('analysis');
  });
});
