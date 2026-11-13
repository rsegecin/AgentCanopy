import type { PlanContent, PlanDoc, PlanUserDecision } from '../../shared';
import { sha256Hex } from '../util';

const MAX_INTERACTIVE_DECISIONS = 20;
const MAX_LABEL_LENGTH = 60;

/** Collapses line breaks so a value fits on one line. */
function line(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

/** Free Markdown: dropped when blank, otherwise passed through without leading blank lines or trailing space. */
function prose(text: string): string {
  return text.replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd();
}

function bullets(items: readonly string[]): string {
  return items.map((item) => `- ${item.replace(/\r?\n/g, '\n  ')}`).join('\n');
}

function cell(text: string): string {
  return line(text).replace(/\|/g, '\\|');
}

function section(heading: string, body: string): string[] {
  return body.trim() === '' ? [] : [`## ${heading}\n\n${body}`];
}

function fenceFor(source: string): string {
  let longest = 0;
  for (const run of source.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

function filesTable(files: PlanContent['relevantFiles']): string {
  if (files.length === 0) return '';
  const rows = files.map((file) => `| ${cell(file.path)} | ${file.action} | ${cell(file.role)} |`);
  return ['| Path | Action | Role |', '| --- | --- | --- |', ...rows].join('\n');
}

function stagesBody(stages: PlanContent['stages']): string {
  const titleById = new Map<string, string>();
  for (const stage of stages) if (!titleById.has(stage.id)) titleById.set(stage.id, stage.title);
  return stages
    .map((stage, index) => {
      const blocks = [`### ${index + 1}. ${line(stage.title)} (${line(stage.id)})`];
      const description = prose(stage.description);
      if (description !== '') blocks.push(description);
      if (stage.dependsOn.length > 0) {
        const names = stage.dependsOn.map((id) => line(titleById.get(id) ?? id));
        blocks.push(`Depends on: ${names.join(', ')}`);
      }
      if (stage.files.length > 0) blocks.push(`Files:\n${bullets(stage.files)}`);
      if (stage.acceptance.length > 0) blocks.push(`Acceptance:\n${bullets(stage.acceptance)}`);
      return blocks.join('\n\n');
    })
    .join('\n\n');
}

function diagramsBody(diagrams: PlanContent['diagrams']): string {
  return diagrams
    .map((diagram) => {
      const source = diagram.mermaid.replace(/\s+$/, '');
      const fence = fenceFor(source);
      return `### ${line(diagram.title)}\n\n${fence}mermaid\n${source}\n${fence}`;
    })
    .join('\n\n');
}

function alternativesBody(alternatives: PlanContent['alternatives']): string {
  return alternatives
    .map((alternative) => {
      const blocks = [`### ${line(alternative.title)}${alternative.chosen ? ' (chosen)' : ''}`];
      const summary = prose(alternative.summary);
      if (summary !== '') blocks.push(summary);
      if (alternative.pros.length > 0) blocks.push(`Pros:\n${bullets(alternative.pros)}`);
      if (alternative.cons.length > 0) blocks.push(`Cons:\n${bullets(alternative.cons)}`);
      return blocks.join('\n\n');
    })
    .join('\n\n');
}

function optionLines(
  options: ReadonlyArray<{ id: string; label: string; description: string }>,
  recommendedId?: string,
): string[] {
  return options.map((option) => {
    const recommended = option.id === recommendedId ? ' (recommended)' : '';
    const description = line(option.description);
    return `  - ${line(option.id)}: ${line(option.label)}${recommended}${description === '' ? '' : ` - ${description}`}`;
  });
}

function decisionPointsBody(points: PlanContent['decisionPoints']): string {
  return points
    .map((point) =>
      [
        `- ${line(point.id)}: ${line(point.question)}`,
        ...optionLines(point.options, point.recommendedOptionId),
      ].join('\n'),
    )
    .join('\n');
}

function openQuestionsBody(questions: PlanContent['openQuestions']): string {
  return questions
    .map((question) =>
      [
        `- ${line(question.id)} (${question.kind}): ${line(question.question)}`,
        ...optionLines(question.options),
      ].join('\n'),
    )
    .join('\n');
}

/**
 * The canonical Markdown of a plan version. Deterministic, and the text the content hash and the
 * execution prompt are built from. `changeSummary` is not part of it.
 */
export function renderPlanMarkdown(content: PlanContent): string {
  const parts: string[] = [`# ${line(content.title)}`];
  parts.push(...section('Objective', prose(content.objective)));
  parts.push(...section('Requirements', bullets(content.requirements)));
  parts.push(...section('Analysis', prose(content.analysis)));
  parts.push(...section('Architecture', prose(content.architecture)));
  parts.push(...section('Relevant files', filesTable(content.relevantFiles)));
  parts.push(...section('Stages', stagesBody(content.stages)));
  parts.push(...section('Dependencies', bullets(content.dependencies)));
  parts.push(...section('Diagrams', diagramsBody(content.diagrams)));
  parts.push(...section('Alternatives considered', alternativesBody(content.alternatives)));
  parts.push(...section('Decisions to make', decisionPointsBody(content.decisionPoints)));
  parts.push(...section('Open questions', openQuestionsBody(content.openQuestions)));
  parts.push(...section('Testing strategy', prose(content.testingStrategy)));
  parts.push(...section('Acceptance criteria', bullets(content.acceptanceCriteria)));
  return `${parts.join('\n\n')}\n`;
}

export function planContentHash(content: PlanContent): string {
  return sha256Hex(renderPlanMarkdown(content));
}

function diagramLabel(title: string): string {
  const cleaned = title
    .replace(/[\r\n]+/g, ' ')
    .replace(/"/g, "'")
    .replace(/[`[\]{}<>|#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(cleaned).slice(0, MAX_LABEL_LENGTH).join('').trim();
}

/** Mermaid source for the stage dependency graph, or undefined when no stage has a dependency. */
export function stageDependencyDiagram(content: PlanContent): string | undefined {
  const indexById = new Map<string, number>();
  content.stages.forEach((stage, index) => {
    if (!indexById.has(stage.id)) indexById.set(stage.id, index);
  });
  const edges: string[] = [];
  content.stages.forEach((stage, index) => {
    for (const id of stage.dependsOn) {
      const from = indexById.get(id);
      if (from !== undefined) edges.push(`  s${from} --> s${index}`);
    }
  });
  if (edges.length === 0) return undefined;
  const nodes = content.stages.map(
    (stage, index) => `  s${index}["${diagramLabel(stage.title) || `Stage ${index + 1}`}"]`,
  );
  return ['flowchart TD', ...nodes, ...edges].join('\n');
}

/** Stops text inside a tagged block from closing it early. */
function escapeClosingTags(text: string, tags: readonly string[]): string {
  const pattern = new RegExp(`</(?=(?:${tags.join('|')})>)`, 'gi');
  return text.replace(pattern, '<\\/');
}

function applicableDecisions(plan: PlanDoc, version: number): PlanUserDecision[] {
  const content = plan.versions.find((candidate) => candidate.version === version)?.content;
  if (!content) return [];
  const points = new Set(content.decisionPoints.map((point) => point.id));
  const questions = new Set(content.openQuestions.map((question) => question.id));
  const kept = plan.decisions.filter((decision) => {
    if (decision.kind === 'decision-point') return points.has(decision.targetId);
    if (decision.kind === 'open-question') return questions.has(decision.targetId);
    return true;
  });
  const interactive = kept.filter((decision) => decision.kind === 'interactive-question');
  const dropped = new Set(
    interactive.slice(0, Math.max(0, interactive.length - MAX_INTERACTIVE_DECISIONS)),
  );
  return kept.filter((decision) => !dropped.has(decision));
}

function decisionsBlock(
  plan: PlanDoc,
  version: number,
  tags: readonly string[],
): string | undefined {
  const decisions = applicableDecisions(plan, version);
  if (decisions.length === 0) return undefined;
  const lines = decisions.map((decision) =>
    escapeClosingTags(
      `- ${decision.kind} ${line(decision.targetId)}: ${decision.values.map(line).join(', ')}`,
      tags,
    ),
  );
  return `<user-decisions>\n${lines.join('\n')}\n</user-decisions>`;
}

/** The plan as it goes into the prompt's context block. Empty when the plan has no version. */
export function renderPlanBlock(plan: PlanDoc, options: { locked: boolean }): string {
  const latest = plan.versions[plan.versions.length - 1];
  if (!latest) return '';
  const tags = ['current-plan', 'user-decisions'];
  const markdown = escapeClosingTags(renderPlanMarkdown(latest.content), tags);
  const parts = [`<current-plan version="${latest.version}">\n${markdown}</current-plan>`];
  const decisions = decisionsBlock(plan, latest.version, tags);
  if (decisions !== undefined) parts.push(decisions);
  parts.push(
    options.locked
      ? 'The plan is locked: do not call submit_plan in this turn.'
      : "To change the plan, call submit_plan with the complete revised plan, keeping ids stable and honouring the user's decisions.",
  );
  return parts.join('\n\n');
}

/** The prompt that starts the execution turn. Throws when the version does not exist. */
export function renderExecutionPrompt(plan: PlanDoc, version: number): string {
  const target = plan.versions.find((candidate) => candidate.version === version);
  if (!target) throw new Error(`Plan ${plan.id} has no version ${version}`);
  const tags = ['approved-plan', 'user-decisions'];
  const markdown = escapeClosingTags(renderPlanMarkdown(target.content), tags);
  const parts = [
    `The user approved version ${version} of the plan. Implement it now, stage by stage, in order of dependencies. Do not go beyond the plan; if something in it turns out to be wrong or impossible, stop and say so.`,
    `<approved-plan version="${version}">\n${markdown}</approved-plan>`,
  ];
  const decisions = decisionsBlock(plan, version, tags);
  if (decisions !== undefined) parts.push(decisions);
  return parts.join('\n\n');
}

/** Decision points and open questions of a version that the user has not answered yet. */
export function unansweredCount(plan: PlanDoc, version: number): number {
  const content = plan.versions.find((candidate) => candidate.version === version)?.content;
  if (!content) return 0;
  const answered = (kind: PlanUserDecision['kind'], id: string): boolean =>
    plan.decisions.some((decision) => decision.kind === kind && decision.targetId === id);
  return (
    content.decisionPoints.filter((point) => !answered('decision-point', point.id)).length +
    content.openQuestions.filter((question) => !answered('open-question', question.id)).length
  );
}
