import "./_env.js";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA, setMeta, getMeta, upsertDispute, getDisputeRow, claimSubmission, releaseSubmission, getSubmission, audit, saveAnalysis, latestAnalysis, recentActivity, tryLock, __testDb as db } from "../../server/db.js";
import { startMirror, stopMirror, flush, mirrorEnabled } from "../../server/mirror.js";
import { dispute } from "./fixtures.js";

/** Fake Turso: the libSQL client surface the mirror uses (batch, close), backed by an in-memory SQLite. */
function fakeTurso() {
  const remote = new DatabaseSync(":memory:");
  const fake = {
    remote,
    down: false,
    batches: 0,
    async batch(stmts) {
      if (this.down) throw new Error("connect ECONNREFUSED");
      this.batches++;
      remote.exec("BEGIN");
      try {
        const out = stmts.map((s) => {
          const { sql, args = [] } = typeof s === "string" ? { sql: s } : s;
          const st = remote.prepare(sql);
          if (/^\s*SELECT/i.test(sql)) {
            const objs = st.all(...args);
            const columns = st.columns().map((c) => c.name);
            return { columns, rows: objs.map((o) => columns.map((c) => o[c])) };
          }
          st.run(...args);
          return { columns: [], rows: [] };
        });
        remote.exec("COMMIT");
        return out;
      } catch (e) {
        remote.exec("ROLLBACK");
        throw e;
      }
    },
    close() {},
  };
  return fake;
}
const remoteRow = (fake, sql, ...args) => fake.remote.prepare(sql).get(...args) ?? null;

afterEach(() => stopMirror());

test("Turso unreachable at boot: the app starts without mirroring, so saved history is never overwritten", async () => {
  const fake = fakeTurso();
  fake.down = true;
  assert.equal(await startMirror({ client: fake }), false);
  assert.equal(mirrorEnabled(), false);
  setMeta("probe", "1");
  assert.equal(await flush(), true);
  assert.equal(fake.batches, 0);
});

test("boot restores the local cache from Turso (and drops stale local rows and locks)", async () => {
  const fake = fakeTurso();
  fake.remote.exec(SCHEMA);
  const d = dispute({});
  fake.remote.prepare("INSERT INTO disputes (id, batch, scenario, status, raw, created_at, synced_at) VALUES (?, 'B1', 'nad-wallet', ?, ?, ?, ?)")
    .run(d.dispute_id, d.status, JSON.stringify(d), d.create_time, d.create_time);
  fake.remote.prepare("INSERT INTO meta (key, value) VALUES ('active_batch', 'B1')").run();
  fake.remote.prepare("INSERT INTO audit (id, at, dispute_id, event) VALUES (41, '2026-11-10T00:00:00Z', ?, 'evidence_submitted')").run(d.dispute_id);
  fake.remote.prepare("INSERT INTO analyses (id, dispute_id, created_at, provider, model, payload) VALUES (7, ?, '2026-11-10T00:00:00Z', 'mock', 'mock', '{}')").run(d.dispute_id);

  setMeta("stale", "local only");
  assert.ok(tryLock("refill", 60_000));

  assert.equal(await startMirror({ client: fake }), true);
  assert.equal(getMeta("active_batch"), "B1");
  assert.equal(getMeta("stale"), null);
  assert.equal(getDisputeRow(d.dispute_id).scenario, "nad-wallet");
  assert.equal(latestAnalysis(d.dispute_id).id, 7);
  assert.deepEqual(recentActivity(5).map((a) => a.event), ["evidence_submitted"]);
  assert.ok(tryLock("refill", 60_000), "locks are process-local and cleared on restore");

  // New rows continue after the restored ids instead of colliding with them.
  assert.ok(saveAnalysis({ disputeId: d.dispute_id, provider: "mock", model: "mock", payload: {} }) > 7);
  audit(d.dispute_id, "analysis_completed", null);
  assert.ok(db.prepare("SELECT MAX(id) AS m FROM audit").get().m > 41);
  await flush();
});

test("every write reaches Turso with its latest state; deletes are mirrored too", async () => {
  const fake = fakeTurso();
  assert.equal(await startMirror({ client: fake }), true);
  const d = dispute({});

  upsertDispute(d, { scenario: "inr-phonecase", batch: "pool" });
  setMeta("active_batch", "B2");
  setMeta("active_batch", "B3"); // coalesced: only the latest value matters
  assert.equal(claimSubmission(d.dispute_id, "provide_evidence", 1), true);
  audit(d.dispute_id, "evidence_submitted", { ok: true });
  assert.equal(await flush(), true);

  assert.equal(remoteRow(fake, "SELECT value FROM meta WHERE key = 'active_batch'").value, "B3");
  assert.equal(remoteRow(fake, "SELECT scenario FROM disputes WHERE id = ?", d.dispute_id).scenario, "inr-phonecase");
  assert.equal(remoteRow(fake, "SELECT status FROM submissions WHERE dispute_id = ?", d.dispute_id).status, "pending");
  assert.equal(remoteRow(fake, "SELECT event FROM audit ORDER BY id DESC LIMIT 1").event, "evidence_submitted");
  assert.equal(remoteRow(fake, "SELECT name FROM sqlite_master WHERE name = 'locks'")?.name, "locks", "schema created remotely");
  assert.equal(remoteRow(fake, "SELECT COUNT(*) AS n FROM locks").n, 0, "locks are never mirrored");

  releaseSubmission(d.dispute_id);
  assert.equal(await flush(), true);
  assert.equal(getSubmission(d.dispute_id), null);
  assert.equal(remoteRow(fake, "SELECT * FROM submissions WHERE dispute_id = ?", d.dispute_id), null);
});

test("a Turso outage keeps changes pending and delivers them once it recovers", async () => {
  const fake = fakeTurso();
  assert.equal(await startMirror({ client: fake }), true);
  fake.down = true;
  setMeta("during_outage", "kept");
  assert.equal(await flush(), false);
  assert.equal(remoteRow(fake, "SELECT value FROM meta WHERE key = 'during_outage'"), null);

  fake.down = false;
  assert.equal(await flush(), true);
  assert.equal(remoteRow(fake, "SELECT value FROM meta WHERE key = 'during_outage'").value, "kept");
});

test("shutdown flushes pending changes and stops tracking", async () => {
  const fake = fakeTurso();
  assert.equal(await startMirror({ client: fake }), true);
  setMeta("before_shutdown", "saved");
  await stopMirror();
  assert.equal(remoteRow(fake, "SELECT value FROM meta WHERE key = 'before_shutdown'").value, "saved");
  assert.equal(mirrorEnabled(), false);
  const before = fake.batches;
  setMeta("after_shutdown", "local only");
  await flush();
  assert.equal(fake.batches, before);
});
