import "./_env.js";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { activateBatch, topUpBatch, poolNeeds, activeBatch, retireDeadPoolRows } from "../../server/pool.js";
import { classifyNew } from "../../server/sync.js";
import { upsertDispute, disputesInBatch, getDisputeRow, setMeta, __testDb as db } from "../../server/db.js";
import { SCENARIOS } from "../../server/store/catalog.js";
import { dispute } from "./fixtures.js";

const seed = (scenario, opts = {}, batch = "pool") => { const d = dispute(opts); upsertDispute(d, { scenario, batch }); return d.dispute_id; };

beforeEach(() => {
  db.exec("DELETE FROM disputes; DELETE FROM submissions; DELETE FROM meta; DELETE FROM audit; DELETE FROM locks;");
});

test("activateBatch picks one fresh pool dispute per scenario", () => {
  const ids = SCENARIOS.map((s) => seed(s.key));
  const r = activateBatch();
  assert.equal(r.changed, true);
  assert.deepEqual(new Set(r.picked), new Set(ids));
  assert.equal(disputesInBatch(activeBatch()).length, SCENARIOS.length);
});

test("activateBatch is a no-op (and keeps the inbox) when the pool has nothing fresh", () => {
  SCENARIOS.forEach((s) => seed(s.key));
  const first = activateBatch();
  const second = activateBatch();
  assert.equal(second.changed, false);
  assert.equal(activeBatch(), first.batch);
  assert.equal(disputesInBatch(first.batch).length, SCENARIOS.length);
});

test("reset never shrinks the inbox: untouched disputes carry over, acted-on ones retire", () => {
  const [a, b] = SCENARIOS;
  const oldA = seed(a.key);
  const oldB = seed(b.key);
  activateBatch();
  db.prepare("INSERT INTO submissions (dispute_id, action, at) VALUES (?, 'provide_evidence', ?)").run(oldA, new Date().toISOString());
  const newA = seed(a.key); // only scenario A has a fresh replacement
  const r = activateBatch();
  assert.deepEqual(r.picked, [newA]);
  assert.deepEqual(r.carried, [oldB]);
  assert.equal(getDisputeRow(oldA).batch, "retired");
  assert.equal(getDisputeRow(oldB).batch, r.batch);
});

test("processing pool disputes are never handed out", () => {
  seed(SCENARIOS[0].key, { status: "UNDER_REVIEW", ageMin: 2 });
  const r = activateBatch();
  assert.equal(r.changed, false);
  assert.deepEqual(r.picked, []);
});

test("topUpBatch fills only scenarios missing from the active batch", () => {
  const [a, b] = SCENARIOS;
  seed(a.key);
  activateBatch();
  const spareA = seed(a.key);
  const freshB = seed(b.key);
  const r = topUpBatch();
  assert.deepEqual(r.picked, [freshB]);
  assert.equal(getDisputeRow(spareA).batch, "pool"); // A already shown; spare stays in reserve
});

test("poolNeeds ignores disputes stuck processing for more than 15 minutes", () => {
  setMeta("active_batch", "none");
  for (const s of SCENARIOS) seed(s.key, { status: "UNDER_REVIEW", ageMin: s.key === "nad-wallet" ? 40 : 3 });
  assert.deepEqual(poolNeeds(), ["nad-wallet"]);
});

test("classifyNew: what happens to a dispute first seen after a DB wipe", () => {
  assert.equal(classifyNew(dispute(), "nad-wallet"), "pool");
  assert.equal(classifyNew(dispute(), null), "retired"); // not ours
  assert.equal(classifyNew(dispute({ status: "RESOLVED" }), "nad-wallet"), "retired");
  assert.equal(classifyNew(dispute({ status: "UNDER_REVIEW", evidences: [{ source: "SUBMITTED_BY_SELLER" }] }), "nad-wallet"), "retired");
  assert.equal(classifyNew(dispute({ status: "UNDER_REVIEW", ageMin: 3 }), "nad-wallet"), "pool");
  assert.equal(classifyNew(dispute({ status: "UNDER_REVIEW", ageMin: 60 }), "nad-wallet"), "retired");
});

test("retireDeadPoolRows retires resolved, acted-on and stuck pool disputes, keeps live ones", () => {
  const key = SCENARIOS[0].key;
  const fresh = seed(key);
  const processing = seed(key, { status: "UNDER_REVIEW", ageMin: 3 });
  const stuck = seed(key, { status: "UNDER_REVIEW", ageMin: 30 });
  const resolved = seed(key, { status: "RESOLVED" });
  const acted = seed(key, { status: "UNDER_REVIEW", ageMin: 3, evidences: [{ source: "SUBMITTED_BY_SELLER" }] });
  assert.equal(retireDeadPoolRows(), 3);
  for (const id of [fresh, processing]) assert.equal(getDisputeRow(id).batch, "pool");
  for (const id of [stuck, resolved, acted]) assert.equal(getDisputeRow(id).batch, "retired");
});
