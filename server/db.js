// SQLite cache (Node's built-in node:sqlite). PayPal + the committed store catalog are the source of truth;
// this file can be wiped (e.g. Render redeploy) and is rebuilt by sync. The ONLY module that runs SQL.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";

mkdirSync(dirname(config.dbPath), { recursive: true });
const db = new DatabaseSync(config.dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;              -- the seed CLI and the server may share the file
  CREATE TABLE IF NOT EXISTS disputes (
    id          TEXT PRIMARY KEY,
    batch       TEXT NOT NULL DEFAULT 'pool',     -- 'pool' | batch id shown in inbox | 'retired'
    scenario    TEXT,                             -- store scenario key, null for unknown disputes
    seller_txn  TEXT,
    status      TEXT,
    raw         TEXT NOT NULL,                    -- latest dispute JSON from PayPal
    created_at  TEXT,
    synced_at   TEXT
  );
  CREATE INDEX IF NOT EXISTS disputes_batch ON disputes(batch);
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS locks (name TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS submissions (
    dispute_id  TEXT PRIMARY KEY,                 -- UNIQUE: one PayPal action per dispute, survives restarts
    action      TEXT NOT NULL,                    -- provide_evidence | accept_claim
    at          TEXT NOT NULL,
    result      TEXT,
    status      TEXT NOT NULL DEFAULT 'done',     -- pending | done | unknown (sent, PayPal didn't confirm)
    analysis_id INTEGER
  );
  CREATE TABLE IF NOT EXISTS analyses (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    dispute_id  TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    provider    TEXT NOT NULL,                    -- openai | mock
    model       TEXT NOT NULL,
    fallback    TEXT,                             -- why the mock stood in for the configured model, if it did
    latency_ms  INTEGER,
    usage       TEXT,
    payload     TEXT NOT NULL                     -- validated analysis + guard + EV + mandate (JSON)
  );
  CREATE INDEX IF NOT EXISTS analyses_dispute ON analyses(dispute_id, id);
  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL, dispute_id TEXT, event TEXT NOT NULL, detail TEXT
  );
`);

// Idempotent migrations for caches created by earlier versions (CREATE IF NOT EXISTS won't add columns).
const columns = (table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
const subCols = columns("submissions");
if (!subCols.has("status")) db.exec("ALTER TABLE submissions ADD COLUMN status TEXT NOT NULL DEFAULT 'done'");
if (!subCols.has("analysis_id")) db.exec("ALTER TABLE submissions ADD COLUMN analysis_id INTEGER");

const now = () => new Date().toISOString();

export function closeDb() {
  if (db.isOpen) db.close();
}

// ---------- meta ----------
export const getMeta = (key) => db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
export const setMeta = (key, value) =>
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value));

// ---------- locks (atomic, cross-process, expiring) ----------
/** Try to take a named lock. Returns an owner token, or null if someone else holds an unexpired lock. */
export function tryLock(name, ttlMs) {
  const owner = randomUUID();
  const t = Date.now();
  const r = db.prepare(`
    INSERT INTO locks (name, owner, expires_at) VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
    WHERE locks.expires_at < ?
  `).run(name, owner, t + ttlMs, t);
  return r.changes === 1 ? owner : null;
}
export const releaseLock = (name, owner) => db.prepare("DELETE FROM locks WHERE name = ? AND owner = ?").run(name, owner);
/** Operator override (seed CLI --force): drop a lock regardless of owner. */
export const breakLock = (name) => db.prepare("DELETE FROM locks WHERE name = ?").run(name);
export const isLocked = (name) => (db.prepare("SELECT expires_at FROM locks WHERE name = ?").get(name)?.expires_at ?? 0) > Date.now();

// ---------- disputes ----------
export function upsertDispute(d, { scenario, batch } = {}) {
  const existing = getDisputeRow(d.dispute_id);
  const sellerTxn = d.disputed_transactions?.[0]?.seller_transaction_id ?? existing?.seller_txn ?? null;
  db.prepare(`
    INSERT INTO disputes (id, batch, scenario, seller_txn, status, raw, created_at, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      scenario = COALESCE(excluded.scenario, disputes.scenario),
      seller_txn = COALESCE(excluded.seller_txn, disputes.seller_txn),
      status = excluded.status, raw = excluded.raw, synced_at = excluded.synced_at, created_at = excluded.created_at
  `).run(d.dispute_id, batch ?? existing?.batch ?? "pool", scenario ?? null, sellerTxn, d.status ?? null, JSON.stringify(d), d.create_time ?? existing?.created_at ?? now(), now());
}

export const getDisputeRow = (id) => db.prepare("SELECT * FROM disputes WHERE id = ?").get(id) ?? null;
export const disputesInBatch = (batch) => db.prepare("SELECT * FROM disputes WHERE batch = ? ORDER BY created_at DESC").all(batch);
export const setBatch = (id, batch) => db.prepare("UPDATE disputes SET batch = ? WHERE id = ?").run(batch, id);
export const poolRows = () => db.prepare("SELECT * FROM disputes WHERE batch = 'pool' ORDER BY created_at ASC").all();
/** Disputes the sync loop keeps fresh: the pool plus the active batch. */
export const liveRows = (batch) => db.prepare("SELECT * FROM disputes WHERE batch IN ('pool', ?)").all(batch ?? "");

// ---------- submissions ----------
export const getSubmission = (id) => db.prepare("SELECT * FROM submissions WHERE dispute_id = ?").get(id) ?? null;
/** Atomically claim the right to act on a dispute. Returns false if a submission already exists. */
export const claimSubmission = (disputeId, action, analysisId) =>
  db.prepare("INSERT OR IGNORE INTO submissions (dispute_id, action, at, status, analysis_id) VALUES (?, ?, ?, 'pending', ?)").run(disputeId, action, now(), analysisId ?? null).changes === 1;
export const finishSubmission = (disputeId, status, result) =>
  db.prepare("UPDATE submissions SET status = ?, result = ?, at = ? WHERE dispute_id = ?").run(status, result == null ? null : JSON.stringify(result), now(), disputeId);
/** Release a claim when PayPal definitively did NOT act (so the seller can try again). */
export const releaseSubmission = (disputeId) => db.prepare("DELETE FROM submissions WHERE dispute_id = ?").run(disputeId);
export const unknownSubmissions = (olderThanIso) => db.prepare("SELECT * FROM submissions WHERE status IN ('unknown', 'pending') AND at < ?").all(olderThanIso);

// ---------- analyses ----------
export function saveAnalysis({ disputeId, provider, model, fallback, latencyMs, usage, payload }) {
  return Number(db.prepare("INSERT INTO analyses (dispute_id, created_at, provider, model, fallback, latency_ms, usage, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(disputeId, now(), provider, model, fallback ?? null, latencyMs ?? null, usage == null ? null : JSON.stringify(usage), JSON.stringify(payload)).lastInsertRowid);
}
export const latestAnalysis = (disputeId) => db.prepare("SELECT * FROM analyses WHERE dispute_id = ? ORDER BY id DESC LIMIT 1").get(disputeId) ?? null;

// ---------- audit ----------
export function audit(disputeId, event, detail) {
  db.prepare("INSERT INTO audit (at, dispute_id, event, detail) VALUES (?, ?, ?, ?)").run(now(), disputeId ?? null, event, detail == null ? null : JSON.stringify(detail));
}
export const countAuditSince = (event, sinceIso) =>
  db.prepare("SELECT COUNT(*) AS n FROM audit WHERE event = ? AND at >= ?").get(event, sinceIso).n;
/** Seller-facing activity: event names and times only (detail stays server-side). */
export const auditFor = (id) => db.prepare("SELECT at, event FROM audit WHERE dispute_id = ? ORDER BY id").all(id);

/** Test-only escape hatch (never imported by server code; lint-enforced). */
export const __testDb = db;
