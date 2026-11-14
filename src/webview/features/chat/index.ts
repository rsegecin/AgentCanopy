import { PromptPart } from './PromptCards';
import { registerPartRenderer } from './registry';

export { Composer } from './Composer';
export { QueuedMessage } from './QueuedMessage';
export { DiagramBlock } from './DiagramBlock';
export { CodeBlock } from './CodeBlock';
export { Markdown } from './Markdown';
export { MessageList } from './MessageList';
export { ToolCard } from './ToolCard';
export { registerPartRenderer } from './registry';
export type { PartRendererProps } from './registry';

// Prompts are drawn as cards in the log; a missing prompt falls back to the one-line placeholder.
registerPartRenderer('prompt', PromptPart);
