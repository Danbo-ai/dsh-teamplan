/**
 * dsh-teamplan host half.
 *
 * Registers the `teamplan_*` tools and the browser state route. Everything the
 * plugin owns hangs off this context, so disposing the plugin disposes both.
 *
 * No `Config` export on purpose: the plugin is dependency-free, so it resolves
 * its own defaults from the raw bundle config instead of pulling a schema
 * runtime in.
 * @module dsh-teamplan
 */
import { registerTeamplanTools } from './tools.js';
import { registerTeamplanRoutes } from './routes.js';
import { createTeamplanGate } from './gate.js';

export const name = 'teamplan';
export const inject = ['tools'];

const DEFAULTS = { retentionDays: 3, defaultStepMinutes: 10, blockedAfterMinutes: 15, enforce: 'writes' };

/** `off` | `writes` | `full`; anything else falls back to the safe default. */
const ENFORCE_MODES = new Set(['off', 'writes', 'full']);

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

/** Resolve config once so no tool re-reads an optional field. */
function resolveOptions(config) {
  return {
    retentionDays: positive(config?.retentionDays, DEFAULTS.retentionDays),
    defaultStepMinutes: positive(config?.defaultStepMinutes, DEFAULTS.defaultStepMinutes),
    blockedAfterMinutes: positive(config?.blockedAfterMinutes, DEFAULTS.blockedAfterMinutes),
    enforce: ENFORCE_MODES.has(config?.enforce) ? config.enforce : DEFAULTS.enforce,
  };
}

/**
 * Attach the two vetoes. Both are optional surfaces: a host without
 * `tools.guard` still gets the tools and the panel, it just loses the hard rule.
 */
function registerTeamplanGate(ctx, options, runtime) {
  // Registered even when enforcement is off: the guard then only counts, which
  // is how `teamplan_status` tells "switched off" from "never wired up".
  const gate = createTeamplanGate(options, runtime);
  ctx.effect(() => {
    if (typeof ctx.tools?.guard !== 'function') {
      ctx.logger.warn('teamplan: tools.guard unavailable, the write gate stays advisory');
      return () => {};
    }
    return ctx.tools.guard(gate.guard);
  }, 'teamplan: write gate');
  if (options.enforce !== 'full') return;
  ctx.effect(() => {
    const dispose = ctx.on('agent/turn-stopping', gate.turnStopping);
    return typeof dispose === 'function' ? dispose : () => {};
  }, 'teamplan: closing veto');
}

export function apply(ctx, config) {
  const options = resolveOptions(config);
  // Shared, live counters: the gate bumps them and `teamplan_status` reports
  // them, which is how a user can tell a working gate from a dead one.
  const runtime = { enforce: options.enforce, allowed: 0, refused: 0, steered: 0 };
  registerTeamplanTools(ctx, options, runtime);
  ctx.effect(() => registerTeamplanRoutes(ctx, options), 'teamplan: state route');
  registerTeamplanGate(ctx, options, runtime);
  ctx.logger.info(`teamplan: ready (enforce ${options.enforce}, retention ${options.retentionDays} days, fallback ${options.defaultStepMinutes} min/step)`);
}
