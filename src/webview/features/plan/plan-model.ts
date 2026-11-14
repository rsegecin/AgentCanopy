import type { PlanContent, PlanDoc, PlanUserDecision, PlanVersion } from '../../../shared';

/** The newest version of a plan, or undefined when it has none. */
export function latestVersion(plan: PlanDoc): PlanVersion | undefined {
  let latest: PlanVersion | undefined;
  for (const version of plan.versions) {
    if (!latest || version.version > latest.version) latest = version;
  }
  return latest;
}

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

type Kind = 'decision-point' | 'open-question';

/** The user's current answer to a decision point or open question: the newest one recorded. */
export function currentDecision(
  decisions: readonly PlanUserDecision[],
  kind: Kind,
  targetId: string,
): PlanUserDecision | undefined {
  let found: PlanUserDecision | undefined;
  for (const d of decisions) {
    if (d.kind === kind && d.targetId === targetId && (!found || d.decidedAt >= found.decidedAt)) {
      found = d;
    }
  }
  return found;
}

/** How many decision points and open questions of this version have no answer. */
export function countUnanswered(
  content: PlanContent,
  decisions: readonly PlanUserDecision[],
): number {
  const points = content.decisionPoints.filter(
    (p) => currentDecision(decisions, 'decision-point', p.id) === undefined,
  );
  const questions = content.openQuestions.filter(
    (q) => currentDecision(decisions, 'open-question', q.id) === undefined,
  );
  return points.length + questions.length;
}

export interface DecisionSummary {
  decision: PlanUserDecision;
  /** The question as the latest version words it, or the stored target when it is gone. */
  question: string;
  values: string[];
  /** True when the target no longer exists in the latest version. */
  orphan: boolean;
}

/** Every recorded decision, described with the wording of the latest version where it still exists. */
export function summarizeDecisions(
  content: PlanContent,
  decisions: readonly PlanUserDecision[],
): DecisionSummary[] {
  return [...decisions]
    .sort((a, b) => a.decidedAt - b.decidedAt)
    .map((decision): DecisionSummary => {
      if (decision.kind === 'interactive-question') {
        return { decision, question: decision.targetId, values: decision.values, orphan: false };
      }
      const options =
        decision.kind === 'decision-point'
          ? content.decisionPoints.find((p) => p.id === decision.targetId)
          : content.openQuestions.find((q) => q.id === decision.targetId);
      if (!options) {
        return { decision, question: decision.targetId, values: decision.values, orphan: true };
      }
      const labels = new Map(options.options.map((o) => [o.id, o.label] as const));
      return {
        decision,
        question: options.question,
        values: decision.values.map((v) => labels.get(v) ?? v),
        orphan: false,
      };
    });
}
