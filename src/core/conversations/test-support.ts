import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AssistantMessage,
  ConversationId,
  FolderKey,
  Message,
  MessageId,
  MessagePart,
  PermissionPrompt,
  ToolCallStatus,
  Turn,
  TurnId,
  UserMessage,
} from '../../shared';
import type { Clock } from '../contracts/ports';
import { createConversationStore } from './store';
import type { ConversationStore, ConversationStoreOptions } from './store';

/** Helpers for the conversation tests. Not part of the module's public surface. */

export const FOLDER = 'folder-1' as FolderKey;

export async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), 'agc-conv-'));
}

const opened: ConversationStore[] = [];

/** A store that is flushed before its directory is removed, so no background index write races the cleanup. */
export function trackedStore(options: ConversationStoreOptions): ConversationStore {
  const store = createConversationStore(options);
  opened.push(store);
  return store;
}

export async function removeDir(dir: string): Promise<void> {
  await Promise.all(opened.splice(0).map((store) => store.flush()));
  await fs.rm(dir, { recursive: true, force: true });
}

export function fakeClock(start = 1_000): Clock & { advance(ms?: number): void } {
  let now = start;
  return {
    now: () => now,
    advance: (ms = 1) => {
      now += ms;
    },
  };
}

export function turn(id: string, overrides: Partial<Turn> = {}): Turn {
  return {
    id: id as TurnId,
    mode: 'agent',
    model: 'm',
    startedAt: 10,
    status: 'completed',
    ...overrides,
  };
}

export function userMessage(
  id: string,
  turnId: string,
  text: string,
  overrides: Partial<UserMessage> = {},
): UserMessage {
  return {
    role: 'user',
    id: id as MessageId,
    turnId: turnId as TurnId,
    createdAt: 20,
    text,
    mode: 'agent',
    attachments: [],
    ...overrides,
  };
}

export function assistantMessage(
  id: string,
  turnId: string,
  parts: MessagePart[],
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: 'assistant',
    id: id as MessageId,
    turnId: turnId as TurnId,
    createdAt: 30,
    parts,
    ...overrides,
  };
}

export function text(value: string): MessagePart {
  return { kind: 'text', text: value };
}

export function toolPart(name: string, status: ToolCallStatus, id = `call-${name}`): MessagePart {
  return {
    kind: 'tool',
    call: {
      id,
      name,
      input: { secretish: 'input-of-' + name },
      inputTruncated: false,
      status,
      resultPreview: 'output-of-' + name,
      parentId: null,
      startedAt: 40,
    },
  };
}

export function permissionPrompt(
  id: string,
  conversationId: ConversationId,
  turnId: string,
): PermissionPrompt {
  return {
    id: id as PermissionPrompt['id'],
    conversationId,
    turnId: turnId as TurnId,
    toolCallId: 'call-1',
    createdAt: 50,
    state: 'pending',
    displayHash: 'hash',
    kind: 'permission',
    toolName: 'Bash',
    category: 'command',
    title: 'Run a terminal command',
    detail: 'ls',
    inputPreview: '{}',
    choices: ['allow-once', 'deny'],
  };
}

export function messageIds(messages: Message[]): string[] {
  return messages.map((message) => message.id);
}
