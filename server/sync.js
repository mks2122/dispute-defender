// Keeps the SQLite cache in step with PayPal. Safe to run on an empty DB: it rebuilds the pool and
// active batch from PayPal alone (dispute → capture.custom_id → scenario), so Render redeploys lose nothing.
import { listAllDisputes, getDispute, getCapture } from "./paypal/client.js";
import { scenarioFromCustomId } from "./store/catalog.js";
import { getDisputeRow, upsertDispute, setMeta, getMeta, liveRows } from "./db.js";
import { activeBatch, topUpBatch, retireDeadPoolRows, ensureRefill } from "./pool.js";
import { isResolved, sellerHasActed, isActionable, ageMs, STUCK_AFTER_MS } from "./disputes.js";
import { mapLimit } from "./util.js";
import { log, describeError } from "./log.js";

let syncedOnce = false;
let running = false;
/** True after the first successful sync in this process (the DB reflects PayPal). */
export const hasSyncedOnce = () => syncedOnce;

/** Where should a dispute we've never seen go? Unused + ours → pool; anything else → retired. */
export function classifyNew(d, scenario) {
  if (!scenario || isResolved(d) || sellerHasActed(d)) return "retired";
  if (isActionable(d) || d.status === "OPEN") return "pool";
  // UNDER_REVIEW: fresh disputes pass through it on the way to WAITING; old ones were acted on or are stuck.
  return ageMs(d) < STUCK_AFTER_MS ? "pool" : "retired";
}

async function discover(summary) {
  const d = await getDispute(summary.dispute_id);
  const txn = d.disputed_transactions?.[0]?.seller_transaction_id;
  let scenario = null;
  if (txn) {
    try { scenario = scenarioFromCustomId((await getCapture(txn)).custom_id)?.key ?? null; }
    catch (e) {
      // Only a 404 means "not ours". Anything transient propagates, so the next tick retries (never retire on a hiccup).
      if (e.status !== 404) throw e;
    }
  }
  upsertDispute(d, { scenario, batch: classifyNew(d, scenario) });
}

/** Logs every failure and returns a user-safe summary (no PayPal messages leave the server). */
function report(step, results) {
  const failed = results.filter((r) => !r.ok);
  for (const f of failed) log.error("sync", `${step} ${f.item?.dispute_id ?? f.item?.id ?? "?"} failed`, f.error);
  return failed.length ? `${failed.length} of ${results.length} PayPal ${step} call(s) failed` : null;
}

export async function syncOnce() {
  if (running) return { skipped: true };
  running = true;
  const started = Date.now();
  try {
    // 1. Discover disputes we don't know yet.
    const listed = await listAllDisputes();
    const unknown = listed.filter((s) => !getDisputeRow(s.dispute_id));
    const discoverProblem = report("discovery", await mapLimit(unknown, 4, discover));

    // 2. Refresh live disputes in the active batch and the pool.
    const live = liveRows(activeBatch()).filter((r) => !isResolved(JSON.parse(r.raw)));
    const refreshProblem = report("refresh", await mapLimit(live, 4, async (r) => upsertDispute(await getDispute(r.id))));

    // 3. Stop polling pool disputes that can never be used, then fill any scenario missing from the inbox.
    const retired = retireDeadPoolRows();
    const top = topUpBatch();
    if (top.changed) log.info("sync", `batch ${top.batch}: +${top.picked.length} dispute(s)`);

    const problem = [discoverProblem, refreshProblem].filter(Boolean).join("; ");
    setMeta("last_sync_at", new Date().toISOString());
    setMeta("last_sync_error", problem);
    syncedOnce = true;

    // 4. Keep the reserve pool topped up (single-flight across processes, hourly cap).
    ensureRefill();
    return { discovered: unknown.length, refreshed: live.length, retired, ms: Date.now() - started, problem: problem || null };
  } catch (e) {
    log.error("sync", "sync failed", e);
    setMeta("last_sync_error", `Could not reach PayPal (${describeError(e).startsWith("PayPal") ? `PayPal ${e.status}` : "network"})`);
    return { error: true };
  } finally {
    running = false;
  }
}

/** Starts the loop; the caller owns the returned timer and must clear it on shutdown. */
export function startSyncLoop(intervalMs) {
  const tick = async () => {
    const r = await syncOnce();
    if (r.discovered) log.info("sync", `discovered ${r.discovered}, refreshed ${r.refreshed} in ${r.ms}ms`);
  };
  tick();
  return setInterval(tick, intervalMs);
}

/** User-safe sync status (the stored error is already a generic summary). */
export const syncStatus = () => ({ lastSyncAt: getMeta("last_sync_at"), lastError: getMeta("last_sync_error") || null });
