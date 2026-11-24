/**
 * Plan model: normalization, minute-weighted progress, status derivation and
 * the review checklist the model pastes to the user.
 *
 * Every surface reads tone from `toneOf()` so the badge, the hover card and
 * the footer entry can never disagree about what a plan looks like.
 * @module dsh-teamplan/model
 */

/** Step lifecycle. `doing` is advisory; percent only grows on `done`. */
export const STEP_STATUSES = ['pending', 'doing', 'done', 'blocked'];

/** Plan lifecycle as derived from its own fields, never stored separately. */
export const PLAN_STATUSES = ['pending', 'active', 'blocked', 'stalled', 'done', 'ignored'];

const FALLBACK_MINUTES = 10;

/** `plan-20261119-1542-ab12` — readable, sortable, collision-resistant. */
export function newPlanId(now = Date.now()) {
  const d = new Date(now);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  return `plan-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Minutes are the weight of one step; unknown or silly values fall back. */
export function stepMinutes(step, fallback = FALLBACK_MINUTES) {
  const value = Number(step?.minutes);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.round(value);
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

/** Minutes between two ISO stamps, never negative; `undefined` if unparsable. */
export function minutesBetween(fromIso, toIso) {
  const from = Date.parse(typeof fromIso === 'string' ? fromIso : '');
  const to = Date.parse(typeof toIso === 'string' ? toIso : '');
  if (!Number.isFinite(from) || !Number.isFinite(to)) return undefined;
  return round1(Math.max(0, (to - from) / 60_000));
}

/** Actual minutes of one finished step, or `undefined` when it was never timed. */
export function stepActual(step) {
  const value = Number(step?.actualMinutes);
  return Number.isFinite(value) && value > 0 ? round1(value) : undefined;
}

/**
 * Estimated vs actual minutes of one plan.
 *
 * `actual` only counts steps that really finished; `measured` means a start was
 * stamped live, `derived` means the start was inferred from the previous step's
 * finish (still wall clock, but it may include idle gaps). Nothing is invented:
 * a step with no timing data counts as `untimed` and stays out of `actual`.
 */
export function planActuals(plan, fallbackMinutes = FALLBACK_MINUTES) {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  let estimated = 0;
  let doneEstimate = 0;
  let actual = 0;
  let measured = 0;
  let derived = 0;
  let untimed = 0;
  for (const step of steps) {
    const minutes = stepMinutes(step, fallbackMinutes);
    estimated += minutes;
    if (step.status !== 'done') continue;
    doneEstimate += minutes;
    const value = stepActual(step);
    if (value === undefined) {
      untimed += 1;
      continue;
    }
    actual += value;
    if (step.timed === 'derived') derived += 1;
    else measured += 1;
  }
  const ratio = actual > 0 ? round2(estimated / actual) : undefined;
  const doneRatio = actual > 0 ? round2(doneEstimate / actual) : undefined;
  return {
    estimated,
    doneEstimate,
    actual: round1(actual),
    ratio,
    doneRatio,
    measured,
    derived,
    untimed,
    timed: measured + derived,
  };
}

/**
 * Estimate calibration across finished plans: the median estimate/actual ratio.
 *
 * This is the number that makes the next estimate honest: `median > 1` means
 * plans were estimated larger than they really ran. Only plans with at least one
 * timed, finished step count as a sample.
 */
export function calibrationOf(plans, { limit = 30 } = {}) {
  const rows = [];
  for (const plan of Array.isArray(plans) ? plans : []) {
    if (plan?.approvedAt === undefined) continue;
    const actuals = planActuals(plan);
    if (actuals.actual <= 0 || !Number.isFinite(actuals.ratio)) continue;
    rows.push({
      id: plan.id,
      title: plan.title,
      approvedAt: plan.approvedAt,
      estimated: actuals.estimated,
      actual: actuals.actual,
      ratio: actuals.ratio,
      timed: actuals.timed,
      untimed: actuals.untimed,
    });
  }
  rows.sort((left, right) => String(right.approvedAt).localeCompare(String(left.approvedAt)));
  const recent = rows.slice(0, Math.max(1, limit));
  const ratios = recent.map((row) => row.ratio).sort((left, right) => left - right);
  const median = ratios.length === 0 ? undefined : ratios[Math.floor(ratios.length / 2)];
  const worst = [...recent].sort((left, right) => right.ratio - left.ratio).slice(0, 3);
  return { samples: recent.length, median, rows: recent.slice(0, 5), worst };
}

/** One-line calibration for the checklist / commit receipt. */
export function renderCalibration(calibration) {
  if (!calibration || calibration.samples === 0 || !Number.isFinite(calibration.median)) {
    return '历史校准：还不够样本（要等计划跑完、并记录到真实耗时），先把每一步的分钟按实际经验写。';
  }
  const direction = calibration.median >= 1 ? '估算偏大' : '估算偏小';
  const factor = calibration.median >= 1 ? calibration.median : round2(1 / calibration.median);
  const worst = (calibration.worst ?? [])
    .map((row) => `${row.title}（${row.estimated}/${row.actual} 分钟，${row.ratio}×）`)
    .join('、');
  return `历史校准：近 ${calibration.samples} 份完成计划 估/实中位 ${calibration.median}×（${direction} ${factor} 倍）${worst === '' ? '' : `；偏差最大：${worst}`}`;
}

/**
 * 前置验证：计划提交前对这一步真的做过的检查。
 * `ok: true` 表示检查通过；`ok: false` 表示检查过但不通过（提交会被拒）。
 */
export function normalizeFeasibility(raw) {
  if (raw === null || typeof raw !== 'object') return undefined;
  const checked = typeof raw.checked === 'string' ? raw.checked.trim() : '';
  if (checked === '') return undefined;
  const evidence = typeof raw.evidence === 'string' ? raw.evidence.trim() : '';
  return { checked, evidence, ok: raw.ok === true && evidence !== '' };
}

/**
 * Normalize caller-supplied steps into durable ones.
 *
 * Ids are `T1..Tn` in input order so the checklist, the tool arguments and the
 * rendered rows all use one stable vocabulary. A caller that already passes an
 * id keeps it when it is still unique.
 * @param raw - steps as they arrived from the tool call.
 * @param fallbackMinutes - weight for steps that declare none.
 * @returns durable steps.
 */
export function normalizeSteps(raw, fallbackMinutes = FALLBACK_MINUTES) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const steps = [];
  raw.forEach((entry) => {
    const title = typeof entry?.title === 'string' ? entry.title.trim() : '';
    if (title === '') return;
    // Fall back to the step's position among the kept steps, so dropping an
    // empty entry never leaves a hole like T1, T3 in the checklist.
    const position = steps.length + 1;
    let id = typeof entry?.id === 'string' && entry.id.trim() !== '' ? entry.id.trim() : `T${position}`;
    if (seen.has(id)) id = `T${position}`;
    seen.add(id);
    const status = STEP_STATUSES.includes(entry?.status) ? entry.status : 'pending';
    const step = {
      id,
      title,
      minutes: stepMinutes(entry, fallbackMinutes),
      status,
    };
    if (typeof entry?.note === 'string' && entry.note.trim() !== '') step.note = entry.note.trim();
    if (Array.isArray(entry?.dependsOn) && entry.dependsOn.length > 0) {
      step.dependsOn = entry.dependsOn.filter((value) => typeof value === 'string' && value.trim() !== '');
    }
    // Timing evidence survives a same-round revision; a new round resets the
    // steps wholesale, so a previous round's numbers never leak into this one.
    if (typeof entry?.startedAt === 'string' && entry.startedAt !== '') step.startedAt = entry.startedAt;
    if (typeof entry?.doneAt === 'string' && entry.doneAt !== '') step.doneAt = entry.doneAt;
    const actual = Number(entry?.actualMinutes);
    if (Number.isFinite(actual) && actual > 0) step.actualMinutes = round1(actual);
    if (entry?.timed === 'measured' || entry?.timed === 'derived') step.timed = entry.timed;
    if (entry?.autoStarted === true) step.autoStarted = true;
    const feasibility = normalizeFeasibility(entry?.feasibility);
    if (feasibility !== undefined) step.feasibility = feasibility;
    steps.push(step);
  });
  return steps;
}

/** Deliverables are `{stepId, path}` pairs; the path is what a reviewer reads. */
export function normalizeDeliverables(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      const stepId = typeof entry?.stepId === 'string' ? entry.stepId.trim() : '';
      const path = typeof entry?.path === 'string' ? entry.path.trim() : '';
      if (path === '') return undefined;
      return stepId === '' ? { path } : { stepId, path };
    })
    .filter((entry) => entry !== undefined);
}

/** Acceptance criteria are plain strings; empty ones carry no information. */
export function normalizeAcceptance(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry !== '');
}

/** Minute totals behind the percentage, exposed so the UI can show both. */
export function planTotals(plan, fallbackMinutes = FALLBACK_MINUTES) {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  let total = 0;
  let done = 0;
  let doing = 0;
  let blocked = 0;
  let doneCount = 0;
  for (const step of steps) {
    const minutes = stepMinutes(step, fallbackMinutes);
    total += minutes;
    if (step.status === 'done') {
      done += minutes;
      doneCount += 1;
    } else if (step.status === 'doing') {
      doing += minutes;
    } else if (step.status === 'blocked') {
      blocked += minutes;
    }
  }
  return { total, done, doing, blocked, count: steps.length, doneCount };
}

/**
 * Minute-weighted completion.
 *
 * A five-minute step and a fifty-minute step must not move the bar by the same
 * amount, so weight beats count here; the count is rendered beside it.
 */
export function planPercent(plan, fallbackMinutes = FALLBACK_MINUTES) {
  const totals = planTotals(plan, fallbackMinutes);
  if (totals.total === 0) return 0;
  return Math.round((totals.done / totals.total) * 100);
}

/**
 * Whether a step has been `doing` for longer than the stall threshold.
 *
 * A step nobody reports on is the common failure mode, so the model does not
 * have to admit it: silence past the threshold is itself the signal.
 */
export function isStalledStep(step, blockedAfterMinutes, now = Date.now()) {
  if (step?.status !== 'doing') return false;
  const limit = Number(blockedAfterMinutes);
  if (!Number.isFinite(limit) || limit <= 0) return false;
  const since = Date.parse(step.doingAt ?? '');
  if (!Number.isFinite(since)) return false;
  return now - since > limit * 60_000;
}

/**
 * Status is derived from fields, so a stale stored status can never win.
 * @param plan - stored plan.
 * @param options - `{ blockedAfterMinutes, now }` for the stall heuristic.
 */
export function deriveStatus(plan, options = {}) {
  if (plan?.ignoredAt !== undefined) return 'ignored';
  if (plan?.approvedAt === undefined) return 'pending';
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  if (steps.length > 0 && steps.every((step) => step.status === 'done')) return 'done';
  if (steps.some((step) => step.status === 'blocked')) return 'blocked';
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  if (steps.some((step) => isStalledStep(step, options.blockedAfterMinutes, now))) return 'stalled';
  return 'active';
}

/** Single colour entry point: pending grey, active blue, blocked orange, done green. */
export function toneOf(plan, options = {}) {
  switch (deriveStatus(plan, options)) {
    case 'pending':
    case 'ignored':
      return 'grey';
    case 'blocked':
    case 'stalled':
      return 'orange';
    case 'done':
      return 'green';
    default:
      return 'blue';
  }
}

/** Compact Chinese status label used by every surface. */
export function statusLabel(plan, options = {}) {
  const status = deriveStatus(plan, options);
  // A blocked step says "something stopped me"; an infeasible plan says "the
  // premise this plan was approved on never held". The user needs to see which.
  if (status === 'blocked' && plan?.infeasibleAt !== undefined) return '前提不成立';
  switch (status) {
    case 'pending':
      return '待审核';
    case 'blocked':
      return '受阻';
    case 'stalled':
      return '可能受阻';
    case 'done':
      return '已完成';
    case 'ignored':
      return '已忽略';
    default:
      return '进行中';
  }
}

/** ISO stamp for `updatedAt`/`approvedAt` bookkeeping. */
export function nowStamp(now = Date.now()) {
  return new Date(now).toISOString();
}

function formatDepends(step, steps) {
  const list = Array.isArray(step.dependsOn) ? step.dependsOn : [];
  if (list.length === 0) return '无依赖';
  const known = new Map(steps.map((candidate) => [candidate.id, candidate.title]));
  return `依赖 ${list.map((id) => (known.has(id) ? `${id} ${known.get(id)}` : id)).join('、')}`;
}

/**
 * The review checklist.
 *
 * Rendered verbatim into the conversation so the user reviews the same text the
 * tools will act on: deliverables first, then acceptance, then steps.
 */
export function renderChecklist(plan, fallbackMinutes = FALLBACK_MINUTES) {
  const totals = planTotals(plan, fallbackMinutes);
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  const deliverables = Array.isArray(plan.deliverables) ? plan.deliverables : [];
  const acceptance = Array.isArray(plan.acceptance) ? plan.acceptance : [];
  const lines = [];
  lines.push(`### 计划「${plan.title}」待审核（${plan.id}）`);
  lines.push('');
  if (deliverables.length > 0) {
    lines.push(`**交付物（${deliverables.length} 项）**`);
    deliverables.forEach((item, index) => {
      lines.push(`${index + 1}. ${item.stepId === undefined ? '' : `\`${item.stepId}\` → `}${item.path}`);
    });
    lines.push('');
  }
  if (acceptance.length > 0) {
    lines.push('**验收口径**');
    acceptance.forEach((item) => lines.push(`- ${item}`));
    lines.push('');
  }
  lines.push(`**共 ${steps.length} 步，预计 ${totals.total} 分钟**`);
  if (steps.length === 1 && steps[0].feasibility === undefined) {
    lines.push('（单步计划：免前置验证，一步就能看出前提是否成立）');
  }
  steps.forEach((step, index) => {
    const minutes = stepMinutes(step, fallbackMinutes);
    lines.push(`${index + 1}. \`${step.id}\` ${step.title} · ${minutes} 分钟 · ${formatDepends(step, steps)}`);
    const feasibility = step.feasibility;
    if (feasibility !== undefined) {
      const mark = feasibility.ok ? '已验证' : '检查未通过';
      const evidence = feasibility.evidence === '' ? '' : ` · ${feasibility.evidence}`;
      lines.push(`   - 前置验证（${mark}）：${feasibility.checked}${evidence}`);
    }
  });
  return lines.join('\n');
}

/** One-line status line used by `teamplan_status` and the hover card footer. */
export function renderSummary(plan, fallbackMinutes = FALLBACK_MINUTES) {
  const totals = planTotals(plan, fallbackMinutes);
  const percent = planPercent(plan, fallbackMinutes);
  const actuals = planActuals(plan, fallbackMinutes);
  const timing =
    actuals.actual > 0
      ? ` · 实耗 ${actuals.actual} 分钟（估 ${actuals.estimated} 分钟，${actuals.ratio}×）`
      : '';
  return `${plan.title} · ${statusLabel(plan)} · ${percent}% （${totals.doneCount}/${totals.count} 步，${totals.done}/${totals.total} 分钟）${timing}`;
}
