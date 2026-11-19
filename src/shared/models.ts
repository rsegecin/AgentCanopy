/**
 * A model choice is what the model selector stores: a provider's alias or id, optionally followed by
 * `+delegate`. The suffix asks the model to orchestrate an Agent turn and hand routine work to
 * subagents on faster models. `+` is not a character a provider's model name may hold, so a choice
 * with the suffix can never be mistaken for a model, and only the part before it is sent on.
 */
export const DELEGATE_SUFFIX = '+delegate';

/** What a delegate choice is called in the selector, after the model's own label. */
export const DELEGATE_LABEL = 'orchestrate and delegate';

export interface ModelChoice {
  /** The provider's alias or id: the choice without the suffix. */
  model: string;
  delegate: boolean;
}

/** Splits a choice. The suffix alone, with no model before it, is not a delegate choice. */
export function parseModelChoice(choice: string): ModelChoice {
  if (choice.length > DELEGATE_SUFFIX.length && choice.endsWith(DELEGATE_SUFFIX)) {
    return { model: choice.slice(0, -DELEGATE_SUFFIX.length), delegate: true };
  }
  return { model: choice, delegate: false };
}

/** The delegate choice of a model. */
export function delegateChoice(model: string): string {
  return `${model}${DELEGATE_SUFFIX}`;
}

/** The selector label of a delegate choice, from the label of its model. */
export function delegateLabel(modelLabel: string): string {
  return `${modelLabel} · ${DELEGATE_LABEL}`;
}
