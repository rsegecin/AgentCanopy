import { createContext } from 'react';
import type { Prompt } from '../../../shared';

/**
 * Where `prompt` parts look their prompt up. Null (the default) means the open conversation's
 * `active.prompts`; a side question card provides its own list, because its turn's prompts are not
 * the open conversation's.
 */
export const PromptScope = createContext<readonly Prompt[] | null>(null);
