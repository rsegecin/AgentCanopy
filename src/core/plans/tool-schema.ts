import { z } from 'zod';
import { PlanContentSchema } from '../../shared';

/** What the model is told about each top-level field of the plan. */
const FIELD_DESCRIPTIONS: Record<string, string> = {
  title: 'A short title for the plan.',
  objective: 'What the plan achieves and why, in a few sentences.',
  requirements: 'The requirements the implementation must meet, one per entry.',
  analysis: 'Technical analysis of the current code and the problem, in Markdown.',
  architecture: 'The target design and how the parts fit together, in Markdown.',
  relevantFiles:
    'Files the plan creates, modifies, deletes or only reads, each with its action and role.',
  stages:
    "Ordered implementation stages. Give each a short stable id (such as s1); keep ids unchanged across revisions so the user's answers stay attached.",
  dependencies: 'External dependencies the plan needs (libraries, services, tools), one per entry.',
  diagrams:
    'Mermaid diagrams (flowchart, sequence, class, state or ER). Source only, no code fences.',
  alternatives:
    'Approaches that were considered, with pros and cons; mark the one the plan follows as chosen.',
  decisionPoints:
    'Choices between approaches that the user should make. Each option needs a stable id.',
  openQuestions:
    'Questions you need the user to answer before or during implementation. Keep ids stable across revisions.',
  testingStrategy: 'How the implementation will be tested, in Markdown.',
  acceptanceCriteria: 'Checks that show the plan is done, one per entry.',
  changeSummary:
    'What changed since the previous version, in one or two sentences. Empty for a first plan.',
};

/** The JSON Schema of the `submit_plan` tool input, with a description on every top-level field. */
export function planToolInputSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(PlanContentSchema, { io: 'input' }) as Record<string, unknown>;
  const rest = { ...generated };
  delete rest.$schema;
  const properties = (rest.properties ?? {}) as Record<string, Record<string, unknown>>;
  const described: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(properties)) {
    const description = FIELD_DESCRIPTIONS[name];
    described[name] = description === undefined ? property : { ...property, description };
  }
  return { ...rest, type: 'object', properties: described };
}
