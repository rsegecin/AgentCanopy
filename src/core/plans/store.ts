import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { PlanDocSchema } from '../../shared';
import type {
  ConversationId,
  PlanDoc,
  PlanId,
  PlanUserDecision,
  PlanVersion,
  TurnId,
} from '../../shared';
import { silentLogger, systemClock } from '../contracts/ports';
import type { Clock, Logger } from '../contracts/ports';
import { ensurePrivateDir, newId, readJsonFile, writeFileAtomic } from '../util';
import { planContentHash } from './render';
import { parsePlanContent } from './validate';

const MAX_VALUES = 20;
const MAX_VALUE_LENGTH = 4000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type SubmitResult =
  { ok: true; plan: PlanDoc; version: number; unchanged: boolean } | { ok: false; message: string };

export type ApproveResult =
  | { ok: true; plan: PlanDoc }
  | { ok: false; reason: 'unknown-plan' | 'unknown-version' | 'hash-mismatch' };

export interface PlanStore {
  init(): Promise<void>;
  get(id: PlanId): Promise<PlanDoc | undefined>;
  /** Validates `raw` as plan content and appends it as a new version. Creates the plan when `planId` is absent. */
  submit(input: {
    conversationId: ConversationId;
    planId?: PlanId;
    raw: unknown;
  }): Promise<SubmitResult>;
  /** Records the user's answer for a decision point, open question or interactive question, replacing an earlier one for the same target and kind. */
  decide(
    planId: PlanId,
    decision: { targetId: string; kind: PlanUserDecision['kind']; values: string[] },
  ): Promise<PlanDoc>;
  /** Appends a copy of an earlier version as the newest version, authored by the user. */
  revert(planId: PlanId, version: number): Promise<PlanDoc>;
  /** Records an approval after checking that the version exists and its hash matches. */
  approve(planId: PlanId, version: number, contentHash: string): Promise<ApproveResult>;
  /** Links the latest approval of that version to the turn that executes it. */
  setExecutionTurn(planId: PlanId, version: number, turnId: TurnId): Promise<PlanDoc>;
  /**
   * Copies a plan for a branch: new id, the given conversation, same versions and decisions, no
   * approvals. `upToVersion` keeps versions up to that number and the decisions made on them;
   * `upToTime` keeps versions created, and decisions made, at or before that time. When both are
   * given, both limits apply. Returns undefined when no version remains.
   */
  copy(
    planId: PlanId,
    toConversationId: ConversationId,
    options?: { upToVersion?: number; upToTime?: number },
  ): Promise<PlanDoc | undefined>;
  delete(planId: PlanId): Promise<void>;
}

export interface PlanStoreOptions {
  dir: string;
  clock?: Clock;
  logger?: Logger;
}

function latestOf(plan: PlanDoc): PlanVersion | undefined {
  return plan.versions[plan.versions.length - 1];
}

class UnknownPlanError extends Error {
  constructor(id: string) {
    super(`Unknown plan ${id}`);
  }
}

function unknownPlan(id: string): Error {
  return new UnknownPlanError(id);
}

export function createPlanStore(options: PlanStoreOptions): PlanStore {
  const { dir } = options;
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? silentLogger;
  /** The tail of each plan's write queue. */
  const queues = new Map<string, Promise<unknown>>();

  const fileOf = (id: string): string => join(dir, `${id}.json`);

  async function read(id: string): Promise<PlanDoc | undefined> {
    if (!SAFE_ID.test(id)) return undefined;
    let raw: unknown;
    try {
      raw = await readJsonFile(fileOf(id));
    } catch (error) {
      logger.warn('Could not read a plan file', { planId: id, error: String(error) });
      return undefined;
    }
    if (raw === undefined) return undefined;
    const parsed = PlanDocSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn('Ignoring an invalid plan file', { planId: id, error: parsed.error.message });
      return undefined;
    }
    if (parsed.data.id !== id) {
      logger.warn('Ignoring a plan file whose id does not match its name', { planId: id });
      return undefined;
    }
    return parsed.data;
  }

  async function write(plan: PlanDoc): Promise<void> {
    await writeFileAtomic(fileOf(plan.id), `${JSON.stringify(plan, null, 2)}\n`);
  }

  /** Runs `task` after every earlier task for the same plan has finished. */
  function enqueue<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = queues.get(id) ?? Promise.resolve();
    const result = previous.then(task, task);
    const tail = result.catch(() => undefined);
    queues.set(id, tail);
    void tail.then(() => {
      if (queues.get(id) === tail) queues.delete(id);
    });
    return result;
  }

  /** Reads the plan, applies `change`, and writes the result, all inside the plan's queue. */
  function update(
    id: string,
    change: (plan: PlanDoc) => PlanDoc | Promise<PlanDoc>,
  ): Promise<PlanDoc> {
    return enqueue(id, async () => {
      const plan = await read(id);
      if (!plan) throw unknownPlan(id);
      const next = await change(plan);
      await write(next);
      return next;
    });
  }

  function appendVersion(
    plan: PlanDoc,
    version: Omit<PlanVersion, 'version' | 'createdAt'>,
  ): PlanDoc {
    const number = (latestOf(plan)?.version ?? 0) + 1;
    return {
      ...plan,
      versions: [...plan.versions, { ...version, version: number, createdAt: clock.now() }],
    };
  }

  function checkDecision(
    plan: PlanDoc,
    decision: { targetId: string; kind: PlanUserDecision['kind']; values: string[] },
    values: string[],
  ): void {
    const { targetId, kind } = decision;
    if (targetId.length === 0 || targetId.length > 1000) {
      throw new Error('The decision target id must be 1 to 1000 characters');
    }
    if (kind === 'interactive-question') return;
    const content = latestOf(plan)?.content;
    if (kind === 'decision-point') {
      const point = content?.decisionPoints.find((candidate) => candidate.id === targetId);
      if (!point) throw new Error(`The plan has no decision point ${targetId}`);
      const only = values[0];
      if (values.length !== 1 || only === undefined) {
        throw new Error('A decision point takes exactly one option');
      }
      if (!point.options.some((option) => option.id === only)) {
        throw new Error(`"${only}" is not an option of decision point ${targetId}`);
      }
      return;
    }
    const question = content?.openQuestions.find((candidate) => candidate.id === targetId);
    if (!question) throw new Error(`The plan has no open question ${targetId}`);
    if (question.kind === 'single') {
      const only = values[0];
      if (values.length !== 1 || only === undefined) {
        throw new Error('A single-choice question takes exactly one option');
      }
      if (!question.options.some((option) => option.id === only)) {
        throw new Error(`"${only}" is not an option of open question ${targetId}`);
      }
    } else if (question.kind === 'text' && values.length !== 1) {
      throw new Error('A text question takes exactly one answer');
    }
  }

  return {
    async init() {
      await ensurePrivateDir(dir);
    },

    get: (id) => read(id),

    async submit(input) {
      const parsed = parsePlanContent(input.raw);
      if (!parsed.ok) return parsed;
      const content = parsed.content;
      const contentHash = planContentHash(content);
      const apply = (plan: PlanDoc): { plan: PlanDoc; unchanged: boolean } => {
        const latest = latestOf(plan);
        if (latest && latest.contentHash === contentHash) return { plan, unchanged: true };
        return {
          plan: appendVersion(plan, { author: 'agent', content, contentHash }),
          unchanged: false,
        };
      };
      const planId = input.planId ?? newId<PlanId>();
      return enqueue(planId, async (): Promise<SubmitResult> => {
        let plan = await read(planId);
        if (!plan) {
          if (input.planId !== undefined) throw unknownPlan(planId);
          plan = {
            id: planId,
            conversationId: input.conversationId,
            createdAt: clock.now(),
            versions: [],
            decisions: [],
            approvals: [],
          };
        }
        const result = apply(plan);
        if (!result.unchanged) await write(result.plan);
        const version = latestOf(result.plan)?.version ?? 1;
        return { ok: true, plan: result.plan, version, unchanged: result.unchanged };
      });
    },

    decide(planId, decision) {
      const values = decision.values.map((value) => value.trim()).filter((value) => value !== '');
      return update(planId, (plan) => {
        if (values.length === 0) throw new Error('At least one non-empty value is required');
        if (values.length > MAX_VALUES) throw new Error(`At most ${MAX_VALUES} values are allowed`);
        if (values.some((value) => value.length > MAX_VALUE_LENGTH)) {
          throw new Error(`A value can have at most ${MAX_VALUE_LENGTH} characters`);
        }
        checkDecision(plan, decision, values);
        const entry: PlanUserDecision = {
          targetId: decision.targetId,
          kind: decision.kind,
          values,
          decidedAt: clock.now(),
          ...(latestOf(plan) ? { planVersion: latestOf(plan)?.version } : {}),
        };
        const others = plan.decisions.filter(
          (existing) => !(existing.targetId === entry.targetId && existing.kind === entry.kind),
        );
        return { ...plan, decisions: [...others, entry] };
      });
    },

    revert(planId, version) {
      return update(planId, (plan) => {
        const source = plan.versions.find((candidate) => candidate.version === version);
        if (!source) throw new Error(`Plan ${planId} has no version ${version}`);
        return appendVersion(plan, {
          author: 'user',
          content: structuredClone(source.content),
          contentHash: source.contentHash,
          restoredFrom: source.version,
        });
      });
    },

    async approve(planId, version, contentHash) {
      let outcome: ApproveResult | undefined;
      try {
        await update(planId, (plan) => {
          const target = plan.versions.find((candidate) => candidate.version === version);
          if (!target) {
            outcome = { ok: false, reason: 'unknown-version' };
            return plan;
          }
          if (target.contentHash !== contentHash) {
            outcome = { ok: false, reason: 'hash-mismatch' };
            return plan;
          }
          const next: PlanDoc = {
            ...plan,
            approvals: [...plan.approvals, { version, contentHash, approvedAt: clock.now() }],
          };
          outcome = { ok: true, plan: next };
          return next;
        });
      } catch (error) {
        if (error instanceof UnknownPlanError) {
          return { ok: false, reason: 'unknown-plan' };
        }
        throw error;
      }
      return outcome ?? { ok: false, reason: 'unknown-plan' };
    },

    setExecutionTurn(planId, version, turnId) {
      return update(planId, (plan) => {
        let index = -1;
        plan.approvals.forEach((approval, position) => {
          if (approval.version === version) index = position;
        });
        if (index < 0) throw new Error(`Version ${version} of plan ${planId} has no approval`);
        return {
          ...plan,
          approvals: plan.approvals.map((approval, position) =>
            position === index ? { ...approval, executionTurnId: turnId } : approval,
          ),
        };
      });
    },

    async copy(planId, toConversationId, options = {}) {
      const source = await read(planId);
      if (!source) return undefined;
      const cloned = structuredClone(source);
      // A branch taken at an earlier point gets the plan as it stood then: later versions and the
      // decisions made after them are left out.
      const { upToVersion, upToTime } = options;
      const versions = cloned.versions.filter(
        (v) =>
          (upToVersion === undefined || v.version <= upToVersion) &&
          (upToTime === undefined || v.createdAt <= upToTime),
      );
      if (versions.length === 0) return undefined;
      const decisions = cloned.decisions.filter(
        (d) =>
          (upToVersion === undefined ||
            d.planVersion === undefined ||
            d.planVersion <= upToVersion) &&
          (upToTime === undefined || d.decidedAt <= upToTime),
      );
      const copy: PlanDoc = {
        ...cloned,
        versions,
        decisions,
        id: newId<PlanId>(),
        conversationId: toConversationId,
        createdAt: clock.now(),
        approvals: [],
      };
      await write(copy);
      return copy;
    },

    async delete(planId) {
      if (!SAFE_ID.test(planId)) return;
      await enqueue(planId, () => fs.rm(fileOf(planId), { force: true }));
    },
  };
}
