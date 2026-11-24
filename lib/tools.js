/**
 * The six model-facing tools.
 *
 * The contract worth remembering: `teamplan_commit` creates a plan in `pending`
 * and changes nothing else, and `teamplan_mark` refuses to move a step until
 * the user approved the plan. Approval therefore has exactly one author, and
 * the percent that the sidebar shows is always a percent the user agreed to.
 * @module dsh-teamplan/tools
 */
import { defineTool } from './spec.js';
import {
  calibrationOf,
  deriveStatus,
  isStalledStep,
  minutesBetween,
  newPlanId,
  normalizeAcceptance,
  normalizeDeliverables,
  normalizeSteps,
  nowStamp,
  planActuals,
  planPercent,
  planTotals,
  renderCalibration,
  renderChecklist,
  renderSummary,
  statusLabel,
  stepActual,
  stepMinutes,
} from './model.js';
import { getPlan, listPlans, patchPlan, planForSession, savePlan } from './store.js';

const FEASIBILITY_INPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    checked: { type: 'string', required: true, description: 'What you actually verified before proposing this step (a file you opened, a command you ran, a lookup you did).' },
    evidence: { type: 'string', required: true, description: 'One line of proof the check happened: path:line, command + result, or the URL you read.' },
    ok: { type: 'boolean', description: 'true when the premise of this step holds. Leave false/absent and the commit is refused.' },
  },
};

const STEP_INPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', description: 'Stable step id such as T1. Filled in from position when omitted.' },
    title: { type: 'string', required: true, description: 'What this step finishes, in one line.' },
    minutes: { type: 'number', description: 'Estimated minutes. This is the weight behind the percentage.' },
    dependsOn: { type: 'array', items: { type: 'string' }, description: 'Step ids that must finish first.' },
    note: { type: 'string', description: 'Optional one-line note shown in the hover card.' },
    feasibility: { ...FEASIBILITY_INPUT, description: 'Required for a multi-step plan: what you verified to be sure this step can actually be done.' },
  },
};

const DELIVERABLE_INPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    stepId: { type: 'string', description: 'Step that produces this artifact.' },
    path: { type: 'string', required: true, description: 'Repo-relative or absolute path the reviewer opens.' },
  },
};

function requireAgent(exec) {
  if (exec?.agent === undefined) {
    throw new Error('teamplan tools require a calling agent (exec.agent was undefined)');
  }
  return exec.agent;
}

function sessionIdOf(agent) {
  return agent.id;
}

async function resolvePlan(planId, agent) {
  const sessionId = sessionIdOf(agent);
  const plan = planId === undefined || planId.trim() === ''
    ? await planForSession(sessionId)
    : await getPlan(planId.trim());
  if (plan === undefined) {
    throw new Error(planId === undefined
      ? 'this session has no plan yet; call teamplan_commit first'
      : `plan ${planId} was not found`);
  }
  return plan;
}

function planPayload(plan, fallbackMinutes, options = {}) {
  const totals = planTotals(plan, fallbackMinutes);
  const actuals = planActuals(plan, fallbackMinutes);
  return {
    plan_id: plan.id,
    title: plan.title,
    status: deriveStatus(plan, options),
    status_label: statusLabel(plan, options),
    percent: planPercent(plan, fallbackMinutes),
    done_steps: totals.doneCount,
    total_steps: totals.count,
    done_minutes: totals.done,
    total_minutes: totals.total,
    estimated_minutes: actuals.estimated,
    actual_minutes: actuals.actual,
    ...(actuals.ratio === undefined ? {} : { est_ratio: actuals.ratio }),
    measured_steps: actuals.measured,
    untimed_steps: actuals.untimed,
    ...(plan.infeasibleAt === undefined
      ? {}
      : {
          infeasible: true,
          ...(plan.infeasibleStepId === undefined ? {} : { infeasible_step: plan.infeasibleStepId }),
          ...(plan.infeasibleNote === undefined ? {} : { infeasible_note: plan.infeasibleNote }),
        }),
    approved: plan.approvedAt !== undefined,
    steps: (plan.steps ?? []).map((step) => ({
      step_id: step.id,
      title: step.title,
      minutes: stepMinutes(step, fallbackMinutes),
      status: step.status,
      ...(isStalledStep(step, options.blockedAfterMinutes, options.now) ? { stalled: true } : {}),
      ...(step.note === undefined ? {} : { note: step.note }),
      ...(step.feasibility === undefined ? {} : { feasibility: step.feasibility }),
      ...(stepActual(step) === undefined ? {} : { actual_minutes: stepActual(step) }),
      ...(step.timed === undefined ? {} : { timed: step.timed }),
      ...(step.startedAt === undefined ? {} : { started_at: step.startedAt }),
      ...(step.doneAt === undefined ? {} : { done_at: step.doneAt }),
    })),
  };
}

/**
 * Register every tool on the calling context.
 * @param ctx - plugin context with a `tools` service.
 * @param options - resolved config values.
 */
export function registerTeamplanTools(ctx, options, runtime = { enforce: 'off', allowed: 0, refused: 0, steered: 0 }) {
  const fallbackMinutes = options.defaultStepMinutes;
  /** Stall heuristic inputs; recomputed per call so a long turn still expires. */
  const statusOptions = () => ({ blockedAfterMinutes: options.blockedAfterMinutes, now: Date.now() });

  ctx.tools.register(defineTool({
    name: 'teamplan_commit',
    description: 'Commit the plan for this session as pending review. Nothing else may move until the user approves it. Call this before starting work on anything that is not a one-line reply: the plan carries deliverables, acceptance criteria and per-step minute estimates, and its minutes are the weight behind the sidebar percentage. The returned checklist is what you paste to the user.',
    parameters: {
      title: { type: 'string', required: true, description: 'Short plan title, shown in the sidebar card.' },
      steps: {
        type: 'array',
        required: true,
        description: 'Ordered steps. Minutes here are the weight of the percentage, so estimate honestly.',
        items: STEP_INPUT,
      },
      deliverables: { type: 'array', description: 'Artifacts the plan produces, and where to find them.', items: DELIVERABLE_INPUT },
      acceptance: { type: 'array', items: { type: 'string' }, description: 'How the result is checked, one line per criterion.' },
      executor: {
        type: 'object',
        additionalProperties: false,
        description: 'Who does the work. Reserved for the dispatch phase; record it now so the plan is complete.',
        properties: {
          kind: { type: 'string', enum: ['self', 'subagent', 'team'], description: 'Executor kind.' },
          id: { type: 'string', description: 'Executor id when kind is not self.' },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          plan_id: { type: 'string', required: true },
          title: { type: 'string', required: true },
          status: { type: 'string', required: true },
          percent: { type: 'number', required: true },
          total_minutes: { type: 'number', required: true },
          total_steps: { type: 'number', required: true },
          checklist: { type: 'string', required: true },
          calibration: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `${value.checklist}\n\n计划已存为 ${value.plan_id}（待审核，${value.total_steps} 步 / ${value.total_minutes} 分钟）。请把这个清单贴给用户并等他确认；确认前不要开始执行。`,
      }],
    },
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const title = typeof args.title === 'string' ? args.title.trim() : '';
      if (title === '') throw new Error('title is required');
      const steps = normalizeSteps(args.steps, fallbackMinutes);
      if (steps.length === 0) throw new Error('steps must contain at least one step with a title');
      // Feasibility gate: a plan the user approves must never later discover it
      // could not run. A single-step plan is exempt — doing the one thing is
      // itself the check, and its premise cannot hide behind another step.
      if (steps.length > 1) {
        const blocked = steps.filter((step) => step.feasibility === undefined || step.feasibility.ok !== true);
        if (blocked.length > 0) {
          const detail = blocked
            .map((step) => {
              if (step.feasibility === undefined) return `${step.id}「${step.title}」缺 feasibility`;
              if (step.feasibility.evidence === '') return `${step.id}「${step.title}」的 feasibility 缺 evidence`;
              return `${step.id}「${step.title}」的检查没通过（ok=false）`;
            })
            .join('；');
          throw new Error([
            `可行性验证未通过：${detail}`,
            '提交前对每一步真的验一次，把「验了什么 + 证据」写进 feasibility，照这个格式：',
            '{"id":"T2","title":"改渲染","minutes":10,"feasibility":{"checked":"读 lib/render.js 找插入点","evidence":"lib/render.js:120-140 有容器函数","ok":true}}',
            '验完发现某一步确实做不了，就删掉或改写那一步再提交；不要把不可行的步骤列给用户批准。',
          ].join('\n'));
        }
      }
      const now = nowStamp();
      const existing = await planForSession(sessionIdOf(agent));
      const plan = {
        id: newPlanId(),
        sessionId: sessionIdOf(agent),
        title,
        steps,
        deliverables: normalizeDeliverables(args.deliverables),
        acceptance: normalizeAcceptance(args.acceptance),
        ...(args.executor === undefined ? {} : { executor: { kind: args.executor.kind ?? 'self', ...(args.executor.id === undefined ? {} : { id: args.executor.id }) } }),
        createdAt: now,
        updatedAt: now,
        ...(existing === undefined ? {} : { supersedes: existing.id }),
      };
      await savePlan(plan);
      const totals = planTotals(plan, fallbackMinutes);
      const calibration = renderCalibration(calibrationOf(await listPlans()));
      return {
        plan_id: plan.id,
        title: plan.title,
        status: deriveStatus(plan, statusOptions()),
        percent: planPercent(plan, fallbackMinutes),
        total_minutes: totals.total,
        total_steps: totals.count,
        checklist: `${renderChecklist(plan, fallbackMinutes)}\n\n${calibration}`,
        calibration,
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'teamplan_approve',
    description: 'Record the user\'s approval of the pending plan for this session. Call this only after the user has explicitly confirmed the plan in his own words; the plan id is not an approval. Pass his note so the approval carries its source.',
    parameters: {
      plan_id: { type: 'string', description: 'Plan to approve. Defaults to the live plan of this session.' },
      note: { type: 'string', description: 'The user\'s own words, quoted. Required: an approval with no source is not an approval.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          plan_id: { type: 'string', required: true },
          status: { type: 'string', required: true },
          approved_at: { type: 'string', required: true },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `已批准 ${value.plan_id}。${value.summary}` }],
    },
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const note = typeof args.note === 'string' ? args.note.trim() : '';
      if (note === '') throw new Error('note is required: quote the user\'s approval words');
      const plan = await resolvePlan(args.plan_id, agent);
      if (plan.approvedAt !== undefined) {
        const totals = planTotals(plan, fallbackMinutes);
        return {
          plan_id: plan.id,
          status: deriveStatus(plan, statusOptions()),
          approved_at: plan.approvedAt,
          summary: renderSummary(plan, fallbackMinutes),
          ...(totals.count === 0 ? {} : {}),
        };
      }
      const approvedAt = nowStamp();
      const updated = await patchPlan(plan.id, (draft) => {
        draft.approvedAt = approvedAt;
        draft.approvedNote = note;
        draft.updatedAt = approvedAt;
        return draft;
      });
      return {
        plan_id: updated.id,
        status: deriveStatus(updated, statusOptions()),
        approved_at: approvedAt,
        summary: renderSummary(updated, fallbackMinutes),
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'teamplan_mark',
    description: 'Move one step of the approved plan. Refused while the plan is still pending review. Mark a step done only when its result exists, and mark blocked with a note when it is genuinely stuck.',
    parameters: {
      plan_id: { type: 'string', description: 'Plan to update. Defaults to the live plan of this session.' },
      step_id: { type: 'string', required: true, description: 'Step id such as T2.' },
      status: {
        type: 'string',
        required: true,
        enum: ['doing', 'done', 'blocked', 'infeasible'],
        description: 'New step status. `infeasible` means the premise this step was approved on turned out to be false: it blocks the step, flags the plan, and needs a note saying what was wrong.',
      },
      note: { type: 'string', description: 'One line of evidence or the blocker. Shown in the hover card.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          plan_id: { type: 'string', required: true },
          step_id: { type: 'string', required: true },
          status: { type: 'string', required: true },
          percent: { type: 'number', required: true },
          done_steps: { type: 'number', required: true },
          total_steps: { type: 'number', required: true },
          step_minutes: { type: 'number', description: 'Minutes actually spent on this step, once it is done and timed.' },
          step_timed: { type: 'string', description: 'measured (start was stamped live), derived (start inferred from the previous step), or untimed.' },
          actual_minutes: { type: 'number' },
          est_ratio: { type: 'number' },
          infeasible: { type: 'boolean', description: 'The plan premise is now flagged as false; rewrite it with teamplan_update before continuing.' },
        },
      },
      render: (_args, value) => {
        const timing = value.step_minutes === undefined
          ? ''
          : ` 本步实耗 ${value.step_minutes} 分钟（${value.step_timed === 'derived' ? '起点头推导' : '实测'}）。`;
        const total = value.est_ratio === undefined ? '' : ` 全计划估/实 ${value.est_ratio}×。`;
        const route = value.infeasible === true
          ? ' 计划已标为「前提不成立」：请调用 teamplan_update 重写那一步（或 teamplan_commit 换计划），把清单重新贴给用户确认后再继续。'
          : '';
        return [{ type: 'text', text: `${value.step_id} → ${value.status}。进度 ${value.percent}%（${value.done_steps}/${value.total_steps} 步）。${timing}${total}${route}` }];
      },
    },
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const stepId = typeof args.step_id === 'string' ? args.step_id.trim() : '';
      if (stepId === '') throw new Error('step_id is required');
      const plan = await resolvePlan(args.plan_id, agent);
      if (plan.approvedAt === undefined) {
        throw new Error(`plan ${plan.id} is still pending review; paste the checklist and wait for the user, then call teamplan_approve`);
      }
      const status = args.status;
      if (deriveStatus(plan, statusOptions()) === 'done') {
        throw new Error(`plan ${plan.id} is already done; call teamplan_update to plan the next round`);
      }
      const current = (plan.steps ?? []).find((candidate) => candidate.id === stepId);
      if (current !== undefined && current.status === 'done' && status !== 'done') {
        throw new Error(`step ${stepId} is already done; a finished step never reopens, plan a new round with teamplan_update`);
      }
      const note = typeof args.note === 'string' ? args.note.trim() : '';
      // Declaring a premise false is the one status that must explain itself: it
      // is the only record of why an approved plan could not run, and the input
      // to the next round's rewrite.
      if (status === 'infeasible' && note === '') {
        throw new Error('status infeasible needs a note: say which premise failed and what you found instead, e.g. note: "读 lib/x.js:12 发现 render 不接受 options，这一步的改法不成立"');
      }
      const stepStatus = status === 'infeasible' ? 'blocked' : status;
      const at = nowStamp();
      let missing = false;
      const updated = await patchPlan(plan.id, (draft) => {
        const step = (draft.steps ?? []).find((candidate) => candidate.id === stepId);
        if (step === undefined) {
          missing = true;
          return undefined;
        }
        step.status = stepStatus;
        if (status === 'infeasible') {
          step.infeasible = true;
          draft.infeasibleAt = at;
          draft.infeasibleStepId = stepId;
          draft.infeasibleNote = note;
        }
        // `doing` starts the stall clock; finishing or blocking stops it, so a
        // step can never stay "running" long after it stopped being true.
        if (status === 'doing') {
          step.doingAt = at;
          if (step.startedAt === undefined) {
            step.startedAt = at;
            step.timed = 'measured';
          }
        } else {
          delete step.doingAt;
        }
        // Finishing a step without ever starting it leaves nothing to measure.
        // Derive the start from the previous finish (still wall clock) and say so
        // through `timed`, rather than reporting an invented duration.
        if (status === 'done') {
          step.doneAt = at;
          if (step.startedAt === undefined) {
            const prior = (draft.steps ?? [])
              .filter((candidate) => candidate.id !== step.id && candidate.doneAt !== undefined)
              .map((candidate) => candidate.doneAt)
              .sort()
              .pop();
            const start = prior ?? draft.approvedAt ?? draft.createdAt;
            if (start !== undefined && start !== at) {
              step.startedAt = start;
              step.timed = 'derived';
            }
          }
          if (step.startedAt !== undefined) {
            const spent = minutesBetween(step.startedAt, at);
            // A same-instant batch mark is not a measurement: 0 stays out of
            // `actualMinutes`, so the step counts as untimed instead of 0 minutes.
            if (spent !== undefined && spent > 0) step.actualMinutes = spent;
            else delete step.actualMinutes;
          }
        }
        if (note !== '') step.note = note;
        step.updatedAt = at;
        draft.updatedAt = at;
        draft.lastActivityAt = at;
        return draft;
      });
      if (missing) throw new Error(`plan ${plan.id} has no step ${stepId}`);
      const totals = planTotals(updated, fallbackMinutes);
      const actuals = planActuals(updated, fallbackMinutes);
      const finished = (updated.steps ?? []).find((candidate) => candidate.id === stepId);
      const spent = finished === undefined ? undefined : stepActual(finished);
      return {
        plan_id: updated.id,
        step_id: stepId,
        status,
        percent: planPercent(updated, fallbackMinutes),
        done_steps: totals.doneCount,
        total_steps: totals.count,
        ...(spent === undefined ? {} : { step_minutes: spent, step_timed: finished.timed ?? 'untimed' }),
        actual_minutes: actuals.actual,
        ...(actuals.ratio === undefined ? {} : { est_ratio: actuals.ratio }),
        ...(status === 'infeasible' ? { infeasible: true } : {}),
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'teamplan_status',
    description: 'Read the plan of this session: status, minute-weighted percent, and every step. Use it before marking steps, when the user asks where the work stands, and at the start of a turn that continues earlier work.',
    parameters: {
      plan_id: { type: 'string', description: 'Plan to read. Defaults to the live plan of this session.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          plan_id: { type: 'string', required: true },
          title: { type: 'string', required: true },
          status: { type: 'string', required: true },
          status_label: { type: 'string', required: true },
          percent: { type: 'number', required: true },
          done_steps: { type: 'number', required: true },
          total_steps: { type: 'number', required: true },
          done_minutes: { type: 'number', required: true },
          total_minutes: { type: 'number', required: true },
          estimated_minutes: { type: 'number', required: true },
          actual_minutes: { type: 'number', required: true },
          est_ratio: { type: 'number' },
          measured_steps: { type: 'number', required: true },
          untimed_steps: { type: 'number', required: true },
          infeasible: { type: 'boolean' },
          infeasible_step: { type: 'string' },
          infeasible_note: { type: 'string' },
          approved: { type: 'boolean', required: true },
          gate: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              enforce: { type: 'string', required: true },
              allowed: { type: 'number', required: true },
              refused: { type: 'number', required: true },
              steered: { type: 'number', required: true },
            },
          },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                step_id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                minutes: { type: 'number', required: true },
                status: { type: 'string', required: true },
                note: { type: 'string' },
                actual_minutes: { type: 'number' },
                timed: { type: 'string' },
                started_at: { type: 'string' },
                done_at: { type: 'string' },
                feasibility: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    checked: { type: 'string', required: true },
                    evidence: { type: 'string', required: true },
                    ok: { type: 'boolean', required: true },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `${value.title} · ${value.status_label} · ${value.percent}%（${value.done_steps}/${value.total_steps} 步，${value.done_minutes}/${value.total_minutes} 分钟）`,
          ...(value.infeasible === true
            ? [`前提不成立${value.infeasible_step === undefined ? '' : `（${value.infeasible_step}）`}：${value.infeasible_note ?? ''} → 调用 teamplan_update 重写这一步，重新给用户确认`]
            : []),
          ...(value.actual_minutes > 0
            ? [`估/实：${value.estimated_minutes} / ${value.actual_minutes} 分钟 → ${value.est_ratio}×（实测 ${value.measured_steps} 步，${value.untimed_steps} 步无计时）`]
            : []),
          ...value.steps.map((step) => {
            const spent = step.actual_minutes === undefined ? '' : ` · 实耗 ${step.actual_minutes} 分钟${step.timed === 'derived' ? '（起点推导）' : ''}`;
            return `- \`${step.step_id}\` ${step.title} · ${step.minutes} 分钟 · ${step.status}${spent}${step.note === undefined ? '' : ` · ${step.note}`}`;
          }),
          `闸门 ${value.gate.enforce} · 放行 ${value.gate.allowed} · 拦下 ${value.gate.refused} · 收尾提醒 ${value.gate.steered}`,
        ].join('\n'),
      }],
    },
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const plan = await resolvePlan(args.plan_id, agent);
      return {
        ...planPayload(plan, fallbackMinutes, statusOptions()),
        gate: {
          enforce: runtime.enforce,
          allowed: runtime.allowed,
          refused: runtime.refused,
          steered: runtime.steered,
        },
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'teamplan_update',
    description: 'Revise the plan of this session before work drifts away from it: retitle it, replace the step list, adjust deliverables or acceptance. Finished steps keep their status when their id survives. On a finished plan this opens the next round: the previous steps are archived into history, the new step list starts fresh, and the plan goes back to review until the user approves it again.',
    parameters: {
      plan_id: { type: 'string', description: 'Plan to revise. Defaults to the live plan of this session.' },
      title: { type: 'string', description: 'Replacement title.' },
      steps: { type: 'array', description: 'Replacement step list, in order. Replaces every step.', items: STEP_INPUT },
      deliverables: { type: 'array', description: 'Replacement deliverables.', items: DELIVERABLE_INPUT },
      acceptance: { type: 'array', items: { type: 'string' }, description: 'Replacement acceptance criteria.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          plan_id: { type: 'string', required: true },
          status: { type: 'string', required: true },
          round: { type: 'number', required: true },
          started_round: { type: 'boolean', required: true },
          percent: { type: 'number', required: true },
          total_steps: { type: 'number', required: true },
          total_minutes: { type: 'number', required: true },
          checklist: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.checklist}\n\n已更新 ${value.plan_id}（第 ${value.round} 轮）：${value.total_steps} 步 / ${value.total_minutes} 分钟 / ${value.percent}%。${value.started_round ? '\n\n上一轮已完成，这一轮已退回待审，等你批准后再动手。' : ''}`,
      }],
    },
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const plan = await resolvePlan(args.plan_id, agent);
      // A finished plan is the normal way a long session keeps going: rewriting
      // it opens a new round instead of being refused, so the gate's advice
      // ("start the next round") is always something this tool actually does.
      // An infeasible plan rewrites the same way: what the user approved is gone,
      // so the replacement has to come back to him for approval too.
      const startingNewRound = deriveStatus(plan, statusOptions()) === 'done' || plan.infeasibleAt !== undefined;
      const doneIds = new Set((plan.steps ?? []).filter((step) => step.status === 'done').map((step) => step.id));
      const finishedSteps = (plan.steps ?? []).map((step) => ({
        id: step.id,
        title: step.title,
        minutes: step.minutes,
        status: step.status,
      }));
      const at = nowStamp();
      const updated = await patchPlan(plan.id, (draft) => {
        if (typeof args.title === 'string' && args.title.trim() !== '') draft.title = args.title.trim();
        // A rewrite is the answer to "the premise was false", so it retires the
        // flag; leaving it set would keep the plan marked infeasible forever.
        delete draft.infeasibleAt;
        delete draft.infeasibleStepId;
        delete draft.infeasibleNote;
        if (startingNewRound) {
          const history = Array.isArray(draft.history) ? draft.history.slice() : [];
          history.push({ round: draft.round ?? 1, steps: finishedSteps });
          draft.history = history.slice(-10);
          draft.round = (draft.round ?? 1) + 1;
          // Back to review: the user approves every round, not just the first.
          delete draft.approvedAt;
          delete draft.approvedNote;
          delete draft.lastActivityAt;
          draft.steps = Array.isArray(args.steps)
            ? normalizeSteps(args.steps, fallbackMinutes)
            : (draft.steps ?? []).map((step) => ({ ...step, status: 'pending', note: step.note }));
        } else if (Array.isArray(args.steps)) {
          const steps = normalizeSteps(args.steps, fallbackMinutes);
          for (const step of steps) {
            if (doneIds.has(step.id) && step.status === 'pending') {
              step.status = 'done';
              step.carried = true;
            }
          }
          draft.steps = steps;
        }
        if (Array.isArray(args.deliverables)) draft.deliverables = normalizeDeliverables(args.deliverables);
        if (Array.isArray(args.acceptance)) draft.acceptance = normalizeAcceptance(args.acceptance);
        draft.updatedAt = at;
        return draft;
      });
      const totals = planTotals(updated, fallbackMinutes);
      const calibration = renderCalibration(calibrationOf(await listPlans()));
      return {
        plan_id: updated.id,
        status: deriveStatus(updated, statusOptions()),
        round: updated.round ?? 1,
        started_round: startingNewRound,
        percent: planPercent(updated, fallbackMinutes),
        total_steps: totals.count,
        total_minutes: totals.total,
        checklist: `${renderChecklist(updated, fallbackMinutes)}\n\n${calibration}`,
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'teamplan_ignore',
    description: 'Take a plan out of the sidebar without deleting it. Use it when the user says the plan is no longer relevant, or to clear a finished plan early. The record stays on disk.',
    parameters: {
      plan_id: { type: 'string', description: 'Plan to hide. Defaults to the live plan of this session.' },
      reason: { type: 'string', description: 'Why it no longer matters, in one line.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          plan_id: { type: 'string', required: true },
          ignored: { type: 'boolean', required: true },
          title: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `已从界面移除 ${value.plan_id}（${value.title}），记录仍在 plans.json 里。` }],
    },
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const plan = await resolvePlan(args.plan_id, agent);
      const at = nowStamp();
      await patchPlan(plan.id, (draft) => {
        draft.ignoredAt = at;
        if (typeof args.reason === 'string' && args.reason.trim() !== '') draft.ignoredReason = args.reason.trim();
        draft.updatedAt = at;
        return draft;
      });
      return { plan_id: plan.id, ignored: true, title: plan.title };
    },
  }));
}
