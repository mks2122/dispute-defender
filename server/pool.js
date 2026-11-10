// The inbox shows one "batch": at most one dispute per scenario.
// Fresh, actionable disputes wait in the pool; Reset swaps them in, and sync tops up any scenario
// missing from the batch. A batch never shrinks: if a scenario has no fresh pool dispute, the current
// untouched one is carried over instead of being retired.
import { getMeta, setMeta, disputesInBatch, setBatch, getSubmission, audit, poolRows, retiredUnknownRows } from "./db.js";
import { SCENARIOS } from "./store/catalog.js";
import { config } from "./config.js";
import { isActionable, isProcessing, isResolved, isDeadInPool } from "./disputes.js";
import { refillPool, isRefilling } from "./paypal/seed.js";
import { log } from "./log.js";

const parse = (row) => JSON.parse(row.raw);
const isFresh = (row) => isActionable(parse(row)) && !getSubmission(row.id);
const untouched = (row) => !getSubmission(row.id) && !isResolved(parse(row));

export const activeBatch = () => getMeta("active_batch");

export function poolSummary() {
  const rows = poolRows();
  return SCENARIOS.map((s) => {
    const mine = rows.filter((r) => r.scenario === s.key);
    return { scenario: s.key, ready: mine.filter(isFresh).length, processing: mine.filter((r) => isProcessing(parse(r), r.created_at)).length };
  });
}

/** Scenarios whose pool (ready + processing) is below target, so a refill should seed them. */
export const poolNeeds = () =>
  poolSummary().filter((p) => p.ready + p.processing < config.poolPerScenario).map((p) => p.scenario);

/** Pool disputes that can never be handed out (resolved, acted on, stuck) are retired so sync stops polling them. */
export function retireDeadPoolRows() {
  const dead = poolRows().filter((r) => isDeadInPool(parse(r), r.created_at));
  for (const r of dead) setBatch(r.id, "retired");
  if (dead.length) audit(null, "pool_retired", { ids: dead.map((r) => r.id) });
  return dead.length;
}

/**
 * Disputes from outside the store that still need a response join the inbox as "external", so the seller can
 * import their records. (Older caches retired them; this brings them back without a DB wipe.)
 */
export function adoptExternalRows() {
  const adopted = retiredUnknownRows().filter((r) => isActionable(parse(r)) && !getSubmission(r.id));
  for (const r of adopted) setBatch(r.id, "external");
  return adopted.length;
}

/** Disputes from outside the store, newest first. */
export const externalRows = () => disputesInBatch("external");

/**
 * New batch = a fresh pool dispute per scenario, or the previous batch's untouched dispute for that
 * scenario when the pool has none. Acted-on disputes from the previous batch are retired.
 */
export function activateBatch() {
  const prev = activeBatch();
  const prevRows = prev ? disputesInBatch(prev) : [];
  const pool = poolRows();
  const picked = [], carried = [], missing = [];
  for (const s of SCENARIOS) {
    const fresh = pool.find((r) => r.scenario === s.key && isFresh(r));
    if (fresh) { picked.push(fresh.id); continue; }
    const keep = prevRows.find((r) => r.scenario === s.key && untouched(r));
    if (keep) carried.push(keep.id); else missing.push(s.key);
  }
  if (!picked.length) return { batch: prev, picked, carried, missing, changed: false };

  const batch = `B${Date.now().toString(36).toUpperCase()}`;
  const keepIds = new Set([...picked, ...carried]);
  for (const r of prevRows) if (!keepIds.has(r.id)) setBatch(r.id, "retired");
  for (const id of keepIds) setBatch(id, batch);
  setMeta("active_batch", batch);
  setMeta("active_batch_at", new Date().toISOString());
  audit(null, "batch_activated", { batch, picked, carried, missing, previous: prev });
  return { batch, picked, carried, missing, changed: true };
}

/** Sync tick: fill any scenario missing from the active batch with a fresh pool dispute. */
export function topUpBatch() {
  const batch = activeBatch();
  if (!batch) return activateBatch();
  const have = new Set(disputesInBatch(batch).map((r) => r.scenario));
  const pool = poolRows();
  const added = [];
  for (const s of SCENARIOS) {
    if (have.has(s.key)) continue;
    const fresh = pool.find((r) => r.scenario === s.key && isFresh(r));
    if (fresh) { setBatch(fresh.id, batch); added.push(fresh.id); }
  }
  if (added.length) audit(null, "batch_topped_up", { batch, added });
  return { batch, picked: added, carried: [], missing: [], changed: added.length > 0 };
}

/** Start a background refill if the pool is short. Never throws; returns whether a refill is running. */
export function ensureRefill() {
  const needs = poolNeeds();
  if (needs.length && !isRefilling()) {
    refillPool(needs).catch((e) => log.error("refill", "refill failed", e));
  }
  return isRefilling();
}

export class ResetError extends Error {
  constructor(status, message) { super(message); this.status = status; this.expose = true; }
}

/**
 * "Reset demo": swap in fresh disputes, then top the pool back up.
 * Synchronous between the cooldown check and the write, so concurrent requests can't interleave
 * (Node runs it to completion on one thread); the cooldown is persisted in meta.
 */
export function resetDemo() {
  const last = Number(getMeta("last_reset_at") ?? 0);
  const wait = last + config.resetCooldownMs - Date.now();
  if (wait > 0) throw new ResetError(429, `Reset is cooling down. Try again in ${Math.ceil(wait / 1000)}s.`);
  const result = activateBatch();
  if (result.changed) setMeta("last_reset_at", Date.now()); // a no-op reset doesn't burn the cooldown
  audit(null, "reset_requested", { changed: result.changed, picked: result.picked.length, carried: result.carried.length });
  return { ...result, refilling: ensureRefill() };
}
