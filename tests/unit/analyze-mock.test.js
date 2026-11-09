import "./_env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeDispute, buildInput } from "../../server/ai/analyze.js";
import { mockAnalyze } from "../../server/ai/mock.js";
import { validateAnalysis } from "../../server/ai/schema.js";
import { upsertDispute, getDisputeRow, latestAnalysis } from "../../server/db.js";
import { SCENARIOS } from "../../server/store/catalog.js";
import { dispute } from "./fixtures.js";

const REASON = { "1330": "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED", "4853": "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED", "4855": "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", "4837": "UNAUTHORISED" };
const rowFor = (sc) => {
  const d = dispute({ id: `PP-M-${sc.key}`, reason: REASON[sc.reasonCode], amount: sc.amount.toFixed(2), evidences: [{ source: "SUBMITTED_BY_BUYER", evidence_type: "CREATE", notes: sc.buyerNote }] });
  upsertDispute(d, { scenario: sc.key, batch: "B1" });
  return getDisputeRow(d.dispute_id);
};
const EXPECTED = { "nad-wallet": "FIGHT", "inr-phonecase": "REFUND", "nad-jacket": "REFUND", "unauth-history": "FIGHT", "agent-within": "FIGHT", "agent-over-cap": "REFUND", "injection-note": "FIGHT", "image-injection": "FIGHT" };

for (const sc of SCENARIOS) {
  test(`mock model: ${sc.key} → ${EXPECTED[sc.key]}, schema-valid, guard-clean`, async () => {
    const row = rowFor(sc);
    const a = mockAnalyze(buildInput(row));
    assert.deepEqual(validateAnalysis(a), []);
    assert.equal(a.recommendation, EXPECTED[sc.key]);
    await analyzeDispute(row.id);
    const stored = JSON.parse(latestAnalysis(row.id).payload);
    assert.equal(stored.guard.ok, true, stored.guard.errors.join("; "));
    assert.equal(latestAnalysis(row.id).provider, "mock");
  });
}

test("the injection scenario is flagged and its fake claims listed as unverified", async () => {
  const row = rowFor(SCENARIOS.find((s) => s.key === "injection-note"));
  await analyzeDispute(row.id);
  const p = JSON.parse(latestAnalysis(row.id).payload);
  assert.equal(p.injection_detected, true);
  assert.ok(p.unverified_buyer_claims.length >= 2);
  assert.doesNotMatch(p.draft_notes, /1Z999AA10123456784/);
});

test("analyzeDispute is single-flight per dispute", async () => {
  const row = rowFor(SCENARIOS[0]);
  const [a, b] = [analyzeDispute(row.id), analyzeDispute(row.id)];
  assert.equal(a, b);
  await a;
});
