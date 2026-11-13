import type { ComponentType } from 'react';
import type { ConversationId, MessageId, MessagePart, TurnId } from '../../../shared';

export type PartKind = MessagePart['kind'];

export interface PartRendererProps<K extends PartKind = PartKind> {
  part: Extract<MessagePart, { kind: K }>;
  /** The message's id and turn, not the message itself: that object changes with every streamed token. */
  messageId: MessageId;
  turnId: TurnId;
  conversationId: ConversationId;
}

const overrides: Partial<Record<PartKind, unknown>> = {};

/**
 * Replaces how a kind of message part is rendered (for example the plan and prompt placeholders).
 * Components must be pure functions of their props and may read the view state with `useViewState`.
 * Returns a function that removes the override again.
 */
export function registerPartRenderer<K extends PartKind>(
  kind: K,
  component: ComponentType<PartRendererProps<K>>,
): () => void {
  overrides[kind] = component;
  return () => {
    if (overrides[kind] === component) delete overrides[kind];
  };
}

/** The registered override for a kind, if any. */
export function getPartRenderer(kind: PartKind): ComponentType<PartRendererProps> | undefined {
  return overrides[kind] as ComponentType<PartRendererProps> | undefined;
}
