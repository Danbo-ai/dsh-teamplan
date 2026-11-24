/**
 * Durable plan storage.
 *
 * One JSON document under `$DSH_HOME/storages/dsh-teamplan/plans.json`, keyed
 * by plan id. Writes serialize through a single promise chain and land with
 * write-temp-then-rename, so a crash mid-write leaves the previous document
 * intact instead of a half-written file.
 * @module dsh-teamplan/store
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DOCUMENT_VERSION = 1;

/** Directory holding our storage document. */
export function storageRoot() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh');
  return join(home, 'storages', 'dsh-teamplan');
}

/** Absolute path of `plans.json`. */
export function plansFile() {
  return join(storageRoot(), 'plans.json');
}

function emptyDocument() {
  return { version: DOCUMENT_VERSION, plans: {} };
}

/** Serialize writers so two concurrent tool calls cannot interleave. */
let chain = Promise.resolve();
function serialize(task) {
  const next = chain.then(task, task);
  chain = next.then(() => undefined, () => undefined);
  return next;
}

async function readDocument() {
  let text;
  try {
    text = await readFile(plansFile(), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyDocument();
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A corrupt document is not worth losing history over: keep it aside and
    // start clean so the tools keep working.
    const aside = `${plansFile()}.corrupt-${Date.now()}`;
    await rename(plansFile(), aside).catch(() => undefined);
    return emptyDocument();
  }
  if (parsed === null || typeof parsed !== 'object' || typeof parsed.plans !== 'object' || parsed.plans === null) {
    return emptyDocument();
  }
  return { version: DOCUMENT_VERSION, plans: parsed.plans };
}

async function writeDocument(document) {
  await mkdir(storageRoot(), { recursive: true });
  const target = plansFile();
  const temp = `${target}.tmp`;
  await writeFile(temp, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  await rename(temp, target);
}

/** Every stored plan, in insertion order. */
export async function listPlans() {
  const document = await readDocument();
  return Object.values(document.plans);
}

/** One plan by id, or undefined. */
export async function getPlan(planId) {
  const document = await readDocument();
  return document.plans[planId];
}

/** The live plan for a session: the newest one that was not ignored. */
export async function planForSession(sessionId) {
  const plans = await listPlans();
  const owned = plans.filter((plan) => plan.sessionId === sessionId && plan.ignoredAt === undefined);
  if (owned.length === 0) return undefined;
  owned.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  return owned[0];
}

/** Insert or replace one plan. */
export async function savePlan(plan) {
  return serialize(async () => {
    const document = await readDocument();
    document.plans[plan.id] = plan;
    await writeDocument(document);
    return plan;
  });
}

/**
 * Read-modify-write one plan atomically.
 * @returns the updated plan, or undefined when the id is unknown.
 */
export async function patchPlan(planId, mutate) {
  return serialize(async () => {
    const document = await readDocument();
    const current = document.plans[planId];
    if (current === undefined) return undefined;
    const draft = structuredClone(current);
    const next = (await mutate(draft)) ?? draft;
    document.plans[planId] = next;
    await writeDocument(document);
    return next;
  });
}

/** Apply one mutation to every plan (used by retention pruning). */
export async function patchAllPlans(mutate) {
  return serialize(async () => {
    const document = await readDocument();
    const ids = Object.keys(document.plans);
    if (ids.length === 0) return [];
    let changed = false;
    const touched = [];
    for (const id of ids) {
      const draft = structuredClone(document.plans[id]);
      const next = await mutate(draft);
      if (next === undefined) continue;
      document.plans[id] = next;
      changed = true;
      touched.push(next);
    }
    if (changed) await writeDocument(document);
    return touched;
  });
}

// ---------------------------------------------------------------------------
// Synchronous read for the write gate
//
// `ctx.tools.guard()` is synchronous, so the gate cannot await the document.
// Plans only change through this module, and every writer renames a temp file
// into place, so a stat-triggered sync read is cheap and never sees a partial
// file. The cache key is the file's mtime plus size: one stat per guarded call.
// ---------------------------------------------------------------------------

let syncCache = { stamp: '', plans: {} };

function syncDocument() {
  const target = plansFile();
  let stat;
  try {
    stat = statSync(target);
  } catch {
    syncCache = { stamp: '', plans: {} };
    return syncCache;
  }
  const stamp = `${stat.mtimeMs}:${stat.size}`;
  if (syncCache.stamp === stamp) return syncCache;
  let plans = {};
  try {
    const parsed = JSON.parse(readFileSync(target, 'utf8'));
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.plans === 'object' && parsed.plans !== null) {
      plans = parsed.plans;
    }
  } catch {
    plans = {};
  }
  syncCache = { stamp, plans };
  return syncCache;
}

/** Every plan a session owns, newest first, read synchronously (gate path). */
export function plansForSessionSync(sessionId) {
  return Object.values(syncDocument().plans)
    .filter((plan) => plan.sessionId === sessionId)
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

/** The live plan for a session, read synchronously (gate path). */
export function planForSessionSync(sessionId) {
  return plansForSessionSync(sessionId).find((plan) => plan.ignoredAt === undefined);
}
