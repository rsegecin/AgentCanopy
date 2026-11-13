import { PlanContentSchema } from '../../shared';
import type { PlanContent } from '../../shared';

const MAX_LINES = 10;
const MAX_LINE_LENGTH = 300;

export type ParsedPlan = { ok: true; content: PlanContent } | { ok: false; message: string };

interface Problem {
  path: string;
  message: string;
}

function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = '';
  for (const part of path) {
    if (typeof part === 'number') out += `[${part}]`;
    else out += out === '' ? String(part) : `.${String(part)}`;
  }
  return out === '' ? 'plan' : out;
}

function singleLine(text: string): string {
  const flat = text.replace(/\s*[\r\n]+\s*/g, ' ').trim();
  return flat.length > MAX_LINE_LENGTH ? `${flat.slice(0, MAX_LINE_LENGTH - 3)}...` : flat;
}

function failure(problems: Problem[]): { ok: false; message: string } {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const problem of problems) {
    const line = `- ${problem.path}: ${singleLine(problem.message)}`;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
    if (lines.length === MAX_LINES) break;
  }
  return {
    ok: false,
    message: [
      'The plan was not saved because it is not valid:',
      ...lines,
      'Fix these and call submit_plan again with the complete plan.',
    ].join('\n'),
  };
}

function duplicateIds(
  items: ReadonlyArray<{ id: string }>,
  pathOf: (index: number) => string,
  what: string,
  problems: Problem[],
): void {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(item.id)) {
      problems.push({ path: `${pathOf(index)}.id`, message: `duplicate ${what} id "${item.id}"` });
    }
    seen.add(item.id);
  });
}

/** Finds one cycle among the stages, as a list of ids that starts and ends with the same id. */
function findCycle(stages: PlanContent['stages']): string[] | undefined {
  const indexById = new Map<string, number>();
  stages.forEach((stage, index) => {
    if (!indexById.has(stage.id)) indexById.set(stage.id, index);
  });
  const edges = stages.map((stage, index) =>
    stage.dependsOn
      .map((id) => indexById.get(id))
      .filter((target): target is number => target !== undefined && target !== index),
  );
  const state = new Array<0 | 1 | 2>(stages.length).fill(0);
  const stack: number[] = [];
  const visit = (node: number): number[] | undefined => {
    state[node] = 1;
    stack.push(node);
    for (const next of edges[node] ?? []) {
      if (state[next] === 1) return [...stack.slice(stack.indexOf(next)), next];
      if (state[next] === 0) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    state[node] = 2;
    return undefined;
  };
  for (let node = 0; node < stages.length; node++) {
    if (state[node] === 0) {
      const found = visit(node);
      if (found) return found.map((index) => stages[index]?.id ?? '?');
    }
  }
  return undefined;
}

function semanticProblems(content: PlanContent): Problem[] {
  const problems: Problem[] = [];
  duplicateIds(content.stages, (i) => `stages[${i}]`, 'stage', problems);
  duplicateIds(content.diagrams, (i) => `diagrams[${i}]`, 'diagram', problems);
  duplicateIds(content.alternatives, (i) => `alternatives[${i}]`, 'alternative', problems);
  duplicateIds(content.decisionPoints, (i) => `decisionPoints[${i}]`, 'decision point', problems);
  duplicateIds(content.openQuestions, (i) => `openQuestions[${i}]`, 'open question', problems);

  const stageIds = new Set(content.stages.map((stage) => stage.id));
  content.stages.forEach((stage, index) => {
    stage.dependsOn.forEach((id, position) => {
      const path = `stages[${index}].dependsOn[${position}]`;
      if (id === stage.id) problems.push({ path, message: 'a stage cannot depend on itself' });
      else if (!stageIds.has(id)) problems.push({ path, message: `no stage has the id "${id}"` });
    });
  });
  const cycle = findCycle(content.stages);
  if (cycle) {
    problems.push({ path: 'stages', message: `dependency cycle ${cycle.join(' -> ')}` });
  }

  content.decisionPoints.forEach((point, index) => {
    const base = `decisionPoints[${index}]`;
    duplicateIds(point.options, (i) => `${base}.options[${i}]`, 'option', problems);
    if (
      point.recommendedOptionId !== undefined &&
      !point.options.some((option) => option.id === point.recommendedOptionId)
    ) {
      problems.push({
        path: `${base}.recommendedOptionId`,
        message: `"${point.recommendedOptionId}" is not an option of this decision point`,
      });
    }
  });
  content.openQuestions.forEach((question, index) => {
    const base = `openQuestions[${index}]`;
    duplicateIds(question.options, (i) => `${base}.options[${i}]`, 'option', problems);
    if (question.kind !== 'text' && question.options.length < 2) {
      problems.push({
        path: `${base}.options`,
        message: `a ${question.kind} question needs at least two options`,
      });
    }
  });
  return problems;
}

/** Validates the raw tool input as plan content, with the checks a schema cannot express. */
export function parsePlanContent(raw: unknown): ParsedPlan {
  const parsed = PlanContentSchema.safeParse(raw);
  if (!parsed.success) {
    return failure(
      parsed.error.issues.map((issue) => ({
        path: formatPath(issue.path),
        message: issue.message,
      })),
    );
  }
  const problems = semanticProblems(parsed.data);
  if (problems.length > 0) return failure(problems);
  return { ok: true, content: parsed.data };
}
