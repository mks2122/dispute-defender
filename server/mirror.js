// Durable mirror of the SQLite cache in Turso (hosted libSQL). Optional: without TURSO_DATABASE_URL the app
// behaves exactly as before. The local SQLite stays the working database, so every check that must be
// atomic (submission claims, locks) still runs locally and synchronously. This module only:
//   1. on boot, replaces the local cache with the rows saved in Turso (restore), and
//   2. after every write, copies the changed row's latest state to Turso (write-behind, coalesced).
// The ONLY module that talks to Turso. PayPal remains the source of truth for disputes; what the mirror
// preserves across restarts is our own history: analyses, the activity feed, submissions and pool state.
import { createClient } from "@libsql/client/web";
import { SCHEMA, MIRRORED, readRow, restoreAll, setChangeListener } from "./db.js";
import { config } from "./config.js";
import { log } from "./log.js";

const FLUSH_DELAY_MS = 300;
const RETRY_DELAY_MS = 5_000;

let client = null;
const dirty = new Map(); // "table\u0000key" -> { table, key }; latest row state is read at flush time
let timer = null;
let flushing = null;

export const mirrorEnabled = () => client != null;

/** Upsert or delete statement that makes the remote row match the local one. */
function statementFor({ table, key }) {
  const row = readRow(table, key);
  const pk = MIRRORED[table];
  if (!row) return { sql: `DELETE FROM ${table} WHERE ${pk} = ?`, args: [key] };
  const cols = Object.keys(row);
  return { sql: `INSERT OR REPLACE INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, args: cols.map((c) => row[c]) };
}

function schedule(delay) {
  if (timer || !client) return;
  timer = setTimeout(() => { timer = null; flush().catch(() => {}); }, delay);
  timer.unref();
}

function track(table, key) {
  dirty.set(`${table}\u0000${key}`, { table, key });
  schedule(FLUSH_DELAY_MS);
}

/**
 * Send every pending change in one atomic batch. Concurrent callers share the in-flight flush.
 * On failure the changes stay pending and a retry is scheduled; returns false.
 */
export function flush() {
  if (!client) return Promise.resolve(true);
  if (flushing) return flushing;
  flushing = (async () => {
    while (dirty.size) {
      const items = [...dirty.entries()];
      dirty.clear();
      try {
        await client.batch(items.map(([, it]) => statementFor(it)), "write");
      } catch (e) {
        for (const [k, it] of items) if (!dirty.has(k)) dirty.set(k, it);
        log.error("mirror", `could not save ${items.length} change(s) to Turso; retrying`, e);
        schedule(RETRY_DELAY_MS);
        return false;
      }
    }
    return true;
  })().finally(() => { flushing = null; });
  return flushing;
}

/**
 * Connect, make sure the schema exists, and restore the local cache from Turso.
 * Must finish before the server serves requests or syncs. If Turso is unreachable the app still starts on
 * the empty cache (PayPal rebuilds it) but does NOT mirror, so the saved history isn't overwritten.
 * @param {{ client?: object }} [opts] inject a client (tests)
 */
export async function startMirror(opts = {}) {
  if (!opts.client && !config.tursoUrl) return false;
  if (client) throw new Error("mirror already started");
  const c = opts.client ?? createClient({ url: config.tursoUrl, authToken: config.tursoToken || undefined });
  try {
    const ddl = SCHEMA.split(";").map((s) => s.trim()).filter(Boolean);
    await c.batch(ddl, "write");
    const results = await c.batch(Object.keys(MIRRORED).map((t) => `SELECT * FROM ${t}`), "read");
    const tables = Object.fromEntries(Object.keys(MIRRORED).map((t, i) => [t, results[i].rows.map((r) => plain(r, results[i].columns))]));
    restoreAll(tables);
    client = c;
    setChangeListener(track);
    const counts = Object.entries(tables).map(([t, rows]) => `${rows.length} ${t}`).join(", ");
    log.info("mirror", `restored from Turso: ${counts}`);
    return true;
  } catch (e) {
    log.error("mirror", "Turso unavailable: running without the durable mirror", e);
    try { c.close(); } catch { /* already closed */ }
    return false;
  }
}

/** Flush what's pending (bounded wait), then disconnect. Used on shutdown. */
export async function stopMirror(timeoutMs = 5_000) {
  if (!client) return;
  setChangeListener(null);
  if (timer) { clearTimeout(timer); timer = null; }
  const ok = await Promise.race([flush(), new Promise((r) => setTimeout(() => r(false), timeoutMs).unref())]);
  if (!ok) log.warn("mirror", `${dirty.size} change(s) not saved to Turso before shutdown`);
  client.close();
  client = null;
  dirty.clear();
}

/** libSQL rows are array-like objects; turn one into a plain { column: value } with JS numbers. */
function plain(row, columns) {
  return Object.fromEntries(columns.map((c, i) => {
    const v = row[i];
    return [c, typeof v === "bigint" ? Number(v) : v];
  }));
}
