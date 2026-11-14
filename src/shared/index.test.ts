import { describe, expect, it } from 'vitest';
import {
  ApprovalSourceSchema,
  AttachmentSchema,
  ConversationMetaSchema,
  DEFAULT_SETTINGS,
  MAX_IMAGE_BASE64_LENGTH,
  MAX_IMAGE_BYTES,
  EMPTY_VIEW_STATE,
  HostMessageSchema,
  PlanContentSchema,
  RelPathSchema,
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
    expect(DEFAULT_SETTINGS).toMatchObject({ agentAuto: true, agentAutoWebTools: false });
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
