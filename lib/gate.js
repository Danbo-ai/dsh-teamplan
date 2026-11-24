/**
 * The plan gate.
 *
 * Two mechanisms, weakest first, exactly as the host documents them:
 *
 * - `ctx.tools.guard()` is a synchronous, order-independent veto. It refuses a
 *   write tool call when this session has no approved plan, which is the only
 *   way to make "write a plan first" a hard rule instead of advice.
 * - `agent/turn-stopping` is the closing veto: when a turn that produced write
 *   attempts tries to close without a plan, the listener steers one message and
 *   the machine runs another step. At most once per turn, so a determined model
 *   cannot be trapped in a steering loop.
 *
 * A denial never forgets the verdict: `teamplan_commit` stays callable, so the
 * model always has a way out of the refusal.
 * @module dsh-teamplan/gate
 */
import { randomUUID } from 'node:crypto';
import { deriveStatus, nowStamp } from './model.js';
import { patchPlan, planForSessionSync, plansForSessionSync } from './store.js';

/** Tools that change files. `ops_bash` is judged by its command text. */
const WRITE_TOOLS = new Set(['write', 'edit', 'apply_patch', 'ops_bash']);

/**
 * Shell commands that write. Deliberately conservative: a false positive
 * blocks a read-only command and costs one turn, a false negative silently
 * lets an unplanned edit through.
 */
const BASH_WRITE = /(?:^|[^<>&=|])\s*>>?\s*(?![>&])|\btee\b|\brm\b|\brmdir\b|\bmv\b|\bcp\b|\bmkdir\b|\btouch\b|\bchmod\b|\bln\b|\bsed\s+-i\b|\bgit\s+(?:commit|apply|checkout|reset|rm|mv|add)\b|\b(?:npm|pnpm|yarn)\s+(?:i|install|add|remove|uninstall)\b|writeFileSync|Set-Content|Out-File|\bcopy\b|\bdel\b|\bmove\b/i;

/**
 * Redirections that are not writes: discarding output and duplicating a file
 * descriptor. They are stripped before the write test, so `ls 2>/dev/null` and
 * `cmd 2>&1 | head` stay readable while `cmd > file 2>/dev/null` is still a
 * write because of the first redirection.
 */
const NULL_SINK = /&?[0-9]?>>?\s*(?:\/dev\/null|\$null|nul)\b/gi;
const FD_DUP = /[0-9]?>&[0-9]/g;

/**
 * Whether one call changes files.
 * @param name - tool name as the executor reports it.
 * @param args - parsed arguments.
 */
export function isWriteCall(name, args) {
  if (!WRITE_TOOLS.has(name)) return false;
  if (name !== 'ops_bash') return true;
  const command = typeof args?.command === 'string' ? args.command : '';
  const script = typeof args?.script_path === 'string' ? args.script_path : '';
  // A script file is opaque here, so treat it as a write: the plan gate is
  // allowed to be blunt, and an approved plan makes it free.
  if (script !== '') return true;
  const meaningful = command.replace(NULL_SINK, ' ').replace(FD_DUP, ' ');
  return BASH_WRITE.test(meaningful);
}

/** Subagents inherit the plan of the session that created them. */
function isSubagent(agent) {
  const header = agent?.session?.header;
  if (header === undefined) return false;
  return header.origin === 'subagent' || header.parentSession !== undefined;
}

/**
 * Why a write call is refused, or `undefined` when it may run.
 * @param agent - calling agent.
 * @param options - resolved config values.
 */
export function refusalFor(agent, options) {
  if (agent === undefined || isSubagent(agent)) return undefined;
  const sessionId = agent.id;
  if (typeof sessionId !== 'string' || sessionId === '') return undefined;
  const plan = planForSessionSync(sessionId);
  if (plan === undefined) {
    const ignored = plansForSessionSync(sessionId)[0];
    if (ignored !== undefined) {
      return `计划 ${ignored.id} 已被忽略：这一轮工作先调用 teamplan_commit 重新提交计划。`;
    }
    return '先写计划再动手：这个会话还没有计划。调用 teamplan_commit 提交标题、步骤（含分钟估算）、交付物与验收口径，把返回的清单贴给用户并等他确认，然后 teamplan_approve。这一步之前只有只读操作和 teamplan_* 工具可用。';
  }
  const status = deriveStatus(plan, { blockedAfterMinutes: options.blockedAfterMinutes });
  if (status === 'pending') {
    return `计划 ${plan.id} 还在待审核：把清单原样贴给用户，用他的话调用 teamplan_approve，然后再动手。`;
  }
  if (status === 'ignored') {
    return `计划 ${plan.id} 已被忽略：重新调用 teamplan_commit 提交这一轮的计划。`;
  }
  if (status === 'done') {
    return `计划 ${plan.id} 已完成：这一步属于新一轮，先调用 teamplan_update 传这一轮的步骤开新一轮（会退回待审，等你批准），或者用 teamplan_commit 另起一份计划。`;
  }
  // active / blocked / stalled keep working: a blocked step usually needs the
  // very write the gate would otherwise refuse.
  return undefined;
}

/**
 * Build the guard and the closing veto over one shared per-agent state.
 * @param options - resolved config values (`enforce`, `blockedAfterMinutes`).
 */
export function createTeamplanGate(options, runtime = { refused: 0, allowed: 0, steered: 0 }) {
  /** Agents that attempted a write since the last steering round. */
  const attempted = new Set();
  /** Last turn each agent was steered in, so one turn gets at most one veto. */
  const steeredTurn = new Map();

  const guard = (execution) => {
    const agent = execution?.agent;
    if (agent === undefined || isSubagent(agent)) return undefined;
    if (!isWriteCall(execution?.name, execution?.arguments)) return undefined;
    // Counted even when the gate is off: `teamplan_status` must be able to tell
    // "switched off" from "never wired up".
    if (options.enforce === 'off') {
      runtime.allowed += 1;
      return undefined;
    }
    attempted.add(agent.id);
    const refusal = refusalFor(agent, options);
    if (refusal === undefined) {
      runtime.allowed += 1;
      startNextStep(agent);
    } else runtime.refused += 1;
    return refusal;
  };

  /**
   * Stamp the start of the next ready step when work actually begins.
   *
   * The model habitually skips `teamplan_mark doing` and jumps straight to
   * `done`, which left nothing to measure — 0 of 25 existing plans ever recorded
   * a start. A write the gate just allowed is evidence that work on the approved
   * plan began, so the first one opens the next step whose dependencies are all
   * finished. It is recorded as `derived`, not `measured`: a write infers which
   * step started, it does not assert it, and the label must not overstate what
   * we know.
   */
  const startNextStep = (agent) => {
    const sessionId = agent.id;
    const plan = planForSessionSync(sessionId);
    if (plan === undefined || plan.approvedAt === undefined) return;
    const status = deriveStatus(plan, { blockedAfterMinutes: options.blockedAfterMinutes });
    if (status !== 'active' && status !== 'blocked' && status !== 'stalled') return;
    const steps = plan.steps ?? [];
    if (steps.some((step) => step.status === 'doing')) return;
    const doneIds = new Set(steps.filter((step) => step.status === 'done').map((step) => step.id));
    const next = steps.find(
      (step) => step.status === 'pending' && (step.dependsOn ?? []).every((id) => doneIds.has(id)),
    );
    if (next === undefined || next.startedAt !== undefined) return;
    const at = nowStamp();
    void patchPlan(plan.id, (draft) => {
      const step = (draft.steps ?? []).find((candidate) => candidate.id === next.id);
      if (step === undefined || step.status !== 'pending' || step.startedAt !== undefined) return undefined;
      step.startedAt = at;
      step.timed = 'derived';
      step.autoStarted = true;
      draft.updatedAt = at;
      draft.lastActivityAt = at;
      return draft;
    }).catch(() => {
      // Timing is evidence, never a precondition: a failed stamp must not turn
      // an allowed write into a refusal.
    });
  };

  const turnStopping = (payload) => {
    if (options.enforce !== 'full') return;
    const agent = payload?.agent;
    if (agent === undefined || isSubagent(agent)) return;
    const sessionId = agent.id;
    if (steeredTurn.get(sessionId) === payload.turn) return;
    const plan = planForSessionSync(sessionId);
    const status = plan === undefined ? undefined : deriveStatus(plan, { blockedAfterMinutes: options.blockedAfterMinutes });
    const pending = plan !== undefined && status === 'pending';
    // A turn that only chatted stays free: the rule the user asked for is that
    // work needs a plan, not that every reply does.
    if (plan !== undefined && !pending) {
      attempted.delete(sessionId);
      return;
    }
    if (!pending && !attempted.has(sessionId)) return;
    steeredTurn.set(sessionId, payload.turn);
    attempted.delete(sessionId);
    runtime.steered += 1;
    const text = pending
      ? `计划 ${plan.id} 还没批准。把清单原样贴给用户，用他的原话调用 teamplan_approve；不要在这个回合结束前继续改动文件。`
      : '这个回合改了文件但还没有计划。下一步先调用 teamplan_commit 提交计划（标题、步骤与分钟、交付物、验收口径），把清单贴给用户，等他确认后再动手。';
    try {
      agent.steer({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'teamplan' },
      });
    } catch {
      // Steering is a nudge, never a correctness requirement: if the agent is
      // already closing, the next turn still sees the same refusal.
    }
  };

  return { guard, turnStopping };
}
