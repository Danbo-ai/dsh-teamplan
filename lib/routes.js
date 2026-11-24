/**
 * Browser-facing state route.
 *
 * The sidebar badge polls `/plugins/dsh-teamplan/state`, so this route is the
 * only place that decides what a plan looks like to the client: percent, tone,
 * status label and the steps the hover card renders. Keeping the derivation
 * here means the browser never re-implements the percentage.
 * @module dsh-teamplan/routes
 */
import { createHash } from 'node:crypto';
import {
  deriveStatus,
  isStalledStep,
  planPercent,
  planTotals,
  statusLabel,
  stepMinutes,
  toneOf,
} from './model.js';
import { listPlans, patchPlan } from './store.js';

const STATE_PATH = '/plugins/dsh-teamplan/state';
const DISMISS_PATH = '/plugins/dsh-teamplan/dismiss';

/** Body ceiling for the dismiss call; a plan id is the only expected payload. */
const MAX_BODY_BYTES = 64 * 1024;

/** Candidate service keys for the web server, newest first. */
const WEB_SERVER_KEYS = ['webServer', 'httpServer'];

function matchesEntityTag(header, tag) {
  if (typeof header !== 'string') return false;
  if (header.trim() === '*') return true;
  return header.split(',').some((entry) => entry.trim().replace(/^W\//, '') === tag);
}

/**
 * The wire shape of one plan.
 * @param plan - stored plan.
 * @param fallbackMinutes - weight for steps without minutes.
 * @param options - `{ blockedAfterMinutes, now }` for the stall heuristic.
 */
export function planStateRow(plan, fallbackMinutes, options = {}) {
  const totals = planTotals(plan, fallbackMinutes);
  return {
    planId: plan.id,
    sessionId: plan.sessionId,
    title: plan.title,
    status: deriveStatus(plan, options),
    statusLabel: statusLabel(plan, options),
    tone: toneOf(plan, options),
    percent: planPercent(plan, fallbackMinutes),
    doneSteps: totals.doneCount,
    totalSteps: totals.count,
    doneMinutes: totals.done,
    totalMinutes: totals.total,
    approved: plan.approvedAt !== undefined,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    steps: (plan.steps ?? []).map((step) => ({
      id: step.id,
      title: step.title,
      minutes: stepMinutes(step, fallbackMinutes),
      status: step.status,
      ...(isStalledStep(step, options.blockedAfterMinutes, options.now) ? { stalled: true } : {}),
      ...(step.note === undefined ? {} : { note: step.note }),
    })),
  };
}

/**
 * Whether a finished plan has outlived its retention window.
 *
 * Retention is a read-time filter on purpose: expiry hides the row but keeps
 * the record, so a plan can never be destroyed by a timer.
 */
function isRetired(plan, retentionDays, now, options = {}) {
  if (plan.ignoredAt !== undefined || plan.prunedAt !== undefined) return true;
  if (deriveStatus(plan, options) !== 'done') return false;
  if (retentionDays === undefined || retentionDays <= 0) return false;
  const finished = Date.parse(plan.updatedAt ?? plan.createdAt ?? '');
  if (!Number.isFinite(finished)) return false;
  return now - finished > retentionDays * 86_400_000;
}

/**
 * Build the whole payload, optionally narrowed to one session.
 *
 * `plans` holds everything still in flight and `done` holds finished plans that
 * are inside the retention window, because the floating panel shows them on
 * separate tabs. Ignored and retired plans are never included.
 * @returns `{plans, done, counts}`
 */
export async function buildState(sessionId, options) {
  const fallbackMinutes = options.fallbackMinutes;
  const retentionDays = options.retentionDays;
  const now = options.now ?? Date.now();
  const statusOptions = { blockedAfterMinutes: options.blockedAfterMinutes, now };
  const plans = await listPlans();
  const rows = plans
    .filter((plan) => !isRetired(plan, retentionDays, now, statusOptions))
    .filter((plan) => sessionId === undefined || plan.sessionId === sessionId)
    .map((plan) => planStateRow(plan, fallbackMinutes, statusOptions));
  const byNewest = (left, right) => String(right.createdAt).localeCompare(String(left.createdAt));
  const done = rows.filter((row) => row.status === 'done').sort(byNewest);
  const active = rows.filter((row) => row.status !== 'done').sort(byNewest);
  return { plans: active, done, counts: { active: active.length, done: done.length } };
}

function writeJsonWithEtag(req, res, body) {
  const tag = `"${createHash('sha256').update(body).digest('base64url')}"`;
  const headers = { 'cache-control': 'no-store', etag: `W/${tag}` };
  if ((req.method === 'GET' || req.method === 'HEAD') && matchesEntityTag(req.headers['if-none-match'], tag)) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, { ...headers, 'content-type': 'application/json; charset=utf-8' });
  res.end(req.method === 'HEAD' ? undefined : body);
}

/** Collect a small JSON body without buffering an unbounded request. */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text === '') {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('body is not json'));
      }
    });
    req.on('error', reject);
  });
}

function deny(res, status, error) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ error }));
}

/**
 * Register the state route once the web server and the connection fence are
 * both bound. Both may bind after this plugin under concurrent activation, so
 * we try at mount, through `ctx.inject`, and again on each service binding.
 *
 * The Connection service is fetched per request: it is a service object, not a
 * getter, and a stale reference would outlive a host reload of the fence.
 * @param ctx - plugin context.
 * @param options - resolved config values.
 * @returns a disposer for the registration.
 */
export function registerTeamplanRoutes(ctx, options) {
  const fallbackMinutes = options.defaultStepMinutes;
  const state = { registered: false, disposers: [] };

  const read = (key) => {
    try {
      return ctx.get(key);
    } catch {
      return undefined;
    }
  };

  const fence = (req, res) => {
    const gate = read('connection');
    if (gate === undefined) {
      deny(res, 503, 'authentication unavailable');
      return false;
    }
    const rejection = gate.requestRejection(req);
    if (rejection !== undefined) {
      deny(res, rejection, rejection === 503 ? 'authentication unavailable' : 'unauthorized');
      return false;
    }
    return true;
  };

  const handler = async (req, res) => {
    if (!fence(req, res)) return;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' });
      res.end();
      return;
    }
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      const session = url.searchParams.get('session')?.trim();
      const payload = await buildState(
        session === undefined || session === '' ? undefined : session,
        { fallbackMinutes, retentionDays: options.retentionDays, blockedAfterMinutes: options.blockedAfterMinutes },
      );
      writeJsonWithEtag(req, res, JSON.stringify(payload));
    } catch {
      deny(res, 500, 'failed to read plans');
    }
  };

  /** Hide one finished plan: never a delete, the record stays on disk. */
  /**
   * Mark plans as read. A plan leaves both tabs once it carries `ignoredAt`;
   * the record itself stays in `plans.json` so the audit trail survives.
   *
   * Accepts one of:
   *   `{ planId }`            a single plan
   *   `{ planIds: [...] }`    an explicit batch
   *   `{ scope: 'active' | 'done' }`  every row currently visible on that tab
   */
  const dismissHandler = async (req, res) => {
    if (!fence(req, res)) return;
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' });
      res.end();
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      deny(res, error?.message === 'body too large' ? 413 : 400, error?.message ?? 'bad request');
      return;
    }

    const wanted = [];
    const single = typeof body?.planId === 'string' ? body.planId.trim() : '';
    if (single !== '') wanted.push(single);
    if (Array.isArray(body?.planIds)) {
      for (const id of body.planIds) {
        if (typeof id === 'string' && id.trim() !== '') wanted.push(id.trim());
      }
    }
    const scope = typeof body?.scope === 'string' ? body.scope : '';
    if (wanted.length === 0 && scope !== '') {
      if (scope !== 'active' && scope !== 'done') {
        deny(res, 400, "scope must be 'active' or 'done'");
        return;
      }
      try {
        const snapshot = await buildState(undefined, {
          fallbackMinutes,
          retentionDays: options.retentionDays,
          blockedAfterMinutes: options.blockedAfterMinutes,
        });
        const rows = scope === 'active' ? snapshot.plans : snapshot.done;
        for (const row of rows) wanted.push(row.planId);
      } catch {
        deny(res, 500, 'failed to read plans');
        return;
      }
      if (wanted.length === 0) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: true, dismissed: 0, planIds: [] }));
        return;
      }
    }
    if (wanted.length === 0) {
      deny(res, 400, 'planId or scope is required');
      return;
    }

    try {
      const at = new Date().toISOString();
      const dismissed = [];
      for (const planId of new Set(wanted)) {
        const updated = await patchPlan(planId, (plan) => {
          plan.ignoredAt = at;
          plan.ignoredReason = 'read';
          plan.updatedAt = at;
          return plan;
        });
        if (updated !== undefined) dismissed.push(planId);
      }
      if (dismissed.length === 0) {
        deny(res, 404, 'no such plan');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({
        ok: true,
        dismissed: dismissed.length,
        planIds: dismissed,
        ...(single === '' ? {} : { planId: single }),
      }));
    } catch {
      deny(res, 500, 'failed to dismiss plan');
    }
  };

  const attempt = () => {
    if (state.registered) return;
    const server = read(WEB_SERVER_KEYS[0]) ?? read(WEB_SERVER_KEYS[1]);
    if (server === undefined || typeof server.register !== 'function') return;
    try {
      const disposeState = server.register({ kind: 'exact', path: STATE_PATH, handler });
      const disposeDismiss = server.register({ kind: 'exact', path: DISMISS_PATH, handler: dismissHandler });
      state.disposers = [disposeState, disposeDismiss];
      state.registered = true;
    } catch {
      state.registered = false;
    }
  };

  attempt();
  try {
    ctx.inject?.(['webServer'], () => attempt());
  } catch {
    /* injection is a best-effort retry path */
  }
  ctx.on?.('internal/service', () => {
    attempt();
  });

  return () => {
    for (const dispose of state.disposers) dispose?.();
    state.disposers = [];
    state.registered = false;
  };
}

export { DISMISS_PATH, STATE_PATH };
