// Creates demo disputes in the PayPal sandbox: card sale (custom_id = scenario) → process-chargeback.
// New chargebacks need ~4-5 min to become actionable (WAITING_FOR_SELLER_RESPONSE), so disputes go into a
// pre-warmed pool; the running server hands them out (sync top-up / Reset demo).
//
// CLI: npm run seed -- [--per N] [--only key1,key2] [--no-wait] [--force]
import { pathToFileURL } from "node:url";
import { createCardSale, createChargeback, getDispute } from "./client.js";
import { SCENARIOS, customIdFor, scenarioByKey } from "../store/catalog.js";
import { upsertDispute, audit, setMeta, countAuditSince, tryLock, releaseLock, breakLock, isLocked } from "../db.js";
import { isActionable, isResolved } from "../disputes.js";
import { config } from "../config.js";
import { log, describeError } from "../log.js";

const REFILL_LOCK = "refill";
const REFILL_LOCK_TTL_MS = 20 * 60_000;
let stopping = false;
let refilling = false;

/** Ask any running refill to stop at its next step (called on shutdown). */
export const stopRefill = () => { stopping = true; };
export const isRefilling = () => refilling || isLocked(REFILL_LOCK);

/** Sleep that ends early when a refill is stopped (so shutdown never waits on it). */
async function pause(ms) {
  const until = Date.now() + ms;
  while (!stopping && Date.now() < until) await new Promise((r) => setTimeout(r, Math.min(1000, until - Date.now())));
}

/** Create one dispute for a scenario and record it in the pool. Returns the dispute id. */
export async function seedScenario(sc) {
  // Counted BEFORE any PayPal call: failed attempts still create real sales, so they must hit the hourly cap.
  audit(null, "seed_attempt", { scenario: sc.key });
  const sale = await createCardSale({ amount: sc.amount, description: sc.title, customId: customIdFor(sc.key), cardName: sc.buyer.name });
  setMeta("merchant_id", sale.merchantId);
  const id = await createChargeback({
    merchantId: sale.merchantId,
    captureId: sale.captureId,
    amount: sc.amount,
    reasonCode: sc.reasonCode,
    cardBrand: sc.cardBrand,
    notes: sc.buyerNote,
  });
  // Placeholder until sync fetches the real dispute (GET by id works immediately; list lags).
  upsertDispute(
    { dispute_id: id, status: "OPEN", create_time: new Date().toISOString(), dispute_amount: { currency_code: "USD", value: sc.amount.toFixed(2) }, disputed_transactions: [{ seller_transaction_id: sale.captureId }], links: [] },
    { scenario: sc.key, batch: "pool" },
  );
  audit(id, "seeded", { scenario: sc.key, reason_code: sc.reasonCode });
  return id;
}

/** Poll until every dispute is actionable (or resolved), or until timeout. */
export async function waitUntilActionable(ids, { timeoutMs = 15 * 60_000, intervalMs = 20_000, onReady = () => {} } = {}) {
  const pending = new Set(ids);
  const ready = [];
  const deadline = Date.now() + timeoutMs;
  while (pending.size && Date.now() < deadline && !stopping) {
    for (const id of [...pending]) {
      try {
        const d = await getDispute(id);
        upsertDispute(d);
        if (isActionable(d) || isResolved(d)) { pending.delete(id); ready.push(id); onReady(id, d); }
      } catch (e) {
        log.warn("seed", `poll ${id} failed: ${describeError(e)}`);
      }
    }
    if (pending.size) await pause(intervalMs);
  }
  for (const id of pending) audit(id, "stuck", { after_ms: timeoutMs });
  return { ready, stuck: [...pending] };
}

/** Seeds within the hourly cap, under an atomic cross-process lock. Returns null if the lock is held. */
async function seedMany(keys, { wait = true, onReady } = {}) {
  const owner = tryLock(REFILL_LOCK, REFILL_LOCK_TTL_MS);
  if (!owner) return null;
  refilling = true;
  try {
    const used = countAuditSince("seed_attempt", new Date(Date.now() - 3600_000).toISOString());
    const budget = Math.max(0, config.maxSeedsPerHour - used);
    if (budget < keys.length) log.warn("seed", `hourly cap: seeding ${budget} of ${keys.length} requested`);
    const ids = [];
    for (const key of keys.slice(0, budget)) {
      if (stopping) break;
      try { ids.push(await seedScenario(scenarioByKey(key))); log.info("seed", `${key} created`); }
      catch (e) { log.error("seed", `${key} failed`, e); audit(null, "seed_failed", { scenario: key, error: describeError(e) }); }
    }
    const result = wait ? await waitUntilActionable(ids, { onReady }) : { ready: [], stuck: [] };
    return { ids, ...result };
  } finally {
    refilling = false;
    releaseLock(REFILL_LOCK, owner);
  }
}

/** Server-side: top the pool up for scenarios below target. Single-flight across processes, hourly cap. */
export async function refillPool(needs) {
  if (!needs.length || isRefilling()) return { started: false };
  const r = await seedMany(needs, { onReady: (id, d) => log.info("seed", `ready ${id} ${d.status}`) });
  return r ? { started: true, ...r } : { started: false };
}

// ---------- CLI ----------
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const per = Number(opt("--per") ?? 1);
  const only = opt("--only")?.split(",").filter(Boolean);
  for (const k of only ?? []) if (!scenarioByKey(k)) { log.error("seed", `unknown scenario ${k}`); process.exit(2); }
  const keys = (only ?? SCENARIOS.map((s) => s.key)).flatMap((k) => Array(per).fill(k));

  if (isLocked(REFILL_LOCK)) {
    if (!args.includes("--force")) { log.error("seed", "another refill holds the lock (<20 min old). Wait, or pass --force."); process.exit(1); }
    log.warn("seed", "--force: breaking the existing refill lock");
    breakLock(REFILL_LOCK);
  }
  log.info("seed", `seeding ${keys.length} dispute(s): ${keys.join(", ")}`);
  const r = await seedMany(keys, { wait: !args.includes("--no-wait"), onReady: (id, d) => log.info("seed", `ready ${id} ${d.reason} ${d.status}`) });
  if (!r) { log.error("seed", "could not take the refill lock"); process.exit(1); }
  log.info("seed", `created ${r.ids.length}, ready ${r.ready.length}, stuck ${r.stuck.length}${r.stuck.length ? ` → ${r.stuck.join(", ")}` : ""}`);
  log.info("seed", "the running server adds ready disputes to the inbox on its next sync (≤30 s).");
}
