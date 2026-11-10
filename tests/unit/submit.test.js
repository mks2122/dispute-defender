import { blockedFetch } from "./_env.js";
import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { submitDecision, buildEvidences, reconcileSubmissions } from "../../server/submit.js";
import { analyzeDispute } from "../../server/ai/analyze.js";
import { upsertDispute, latestAnalysis, getSubmission, __testDb as db } from "../../server/db.js";
import { scenarioByKey } from "../../server/store/catalog.js";
import { renderPdf } from "../../server/evidence/pdf.js";
import { dispute } from "./fixtures.js";

const sc = scenarioByKey("nad-wallet");
let n = 0, current;

/** Fake PayPal: GET dispute returns `state`; dispute actions return `action` (or throw). Records every call. */
function fakePayPal({ state, action = { status: 200, body: {} } }) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (path === "/v1/oauth2/token") return new Response(JSON.stringify({ access_token: "t", expires_in: 32400 }), { status: 200 });
    calls.push({ method: init.method ?? "GET", path, body: init.body });
    if ((init.method ?? "GET") === "GET") return new Response(JSON.stringify(state()), { status: 200 });
    if (action.throw) throw action.throw;
    return new Response(JSON.stringify(action.body ?? {}), { status: action.status });
  };
  return calls;
}
afterEach(() => { globalThis.fetch = blockedFetch; });

beforeEach(async () => {
  current = dispute({ id: `PP-S-${++n}`, amount: "110.00", evidences: [{ source: "SUBMITTED_BY_BUYER", evidence_type: "CREATE", notes: sc.buyerNote }] });
  upsertDispute(current, { scenario: sc.key, batch: "B1" });
  await analyzeDispute(current.dispute_id);
});
const analysisId = () => latestAnalysis(current.dispute_id).id;
const draft = () => JSON.parse(latestAnalysis(current.dispute_id).payload).draft_notes;

test("FIGHT: sends provide-evidence once, multipart with tracking + PDF, and records it", async () => {
  const calls = fakePayPal({ state: () => current });
  const r = await submitDecision(current.dispute_id, { decision: "FIGHT", notes: draft(), analysisId: analysisId() });
  assert.equal(r.status, "done");
  const posts = calls.filter((c) => c.method === "POST");
  assert.equal(posts.length, 1);
  assert.match(posts[0].path, /provide-evidence$/);
  const form = posts[0].body;
  assert.ok(form instanceof FormData);
  const input = JSON.parse(await form.get("input").text());
  assert.equal(input.evidences[0].evidence_type, "PROOF_OF_FULFILLMENT");
  assert.equal(input.evidences[0].evidence_info.tracking_info[0].tracking_number, "1Z84X7E90312345678");
  assert.match(form.get("evidence-file").name, /\.pdf$/);
  assert.equal(getSubmission(current.dispute_id).status, "done");
});

test("a second submit is refused (UNIQUE claim): no double action reaches PayPal", async () => {
  const calls = fakePayPal({ state: () => current });
  await submitDecision(current.dispute_id, { decision: "FIGHT", notes: draft(), analysisId: analysisId() });
  await assert.rejects(submitDecision(current.dispute_id, { decision: "FIGHT", notes: draft(), analysisId: analysisId() }), { status: 409 });
  assert.equal(calls.filter((c) => c.method === "POST").length, 1);
});

test("FIGHT with an unverifiable fact is blocked before anything is sent", async () => {
  const calls = fakePayPal({ state: () => current });
  await assert.rejects(submitDecision(current.dispute_id, { decision: "FIGHT", notes: "Tracking 1Z000FAKE0000000000 proves delivery.", analysisId: analysisId() }), (e) => e.status === 422 && e.errors.length === 1);
  assert.equal(calls.length, 0);
  assert.equal(getSubmission(current.dispute_id), null);
});

test("no live provide_evidence link → 409 and the claim is released", async () => {
  fakePayPal({ state: () => ({ ...current, links: [{ rel: "self" }] }) });
  await assert.rejects(submitDecision(current.dispute_id, { decision: "FIGHT", notes: draft(), analysisId: analysisId() }), { status: 409 });
  assert.equal(getSubmission(current.dispute_id), null);
});

test("PayPal 4xx rejection releases the claim so the seller can retry", async () => {
  fakePayPal({ state: () => current, action: { status: 422, body: { debug_id: "d1", details: [{ issue: "INVALID_EVIDENCE" }] } } });
  await assert.rejects(submitDecision(current.dispute_id, { decision: "FIGHT", notes: draft(), analysisId: analysisId() }), (e) => e.status === 422 && e.issue === "INVALID_EVIDENCE");
  assert.equal(getSubmission(current.dispute_id), null);
});

test("timeout on the action → 'unknown' (never resent); reconcile confirms or releases", async () => {
  fakePayPal({ state: () => current, action: { throw: Object.assign(new Error("timeout"), { name: "TimeoutError" }) } });
  const r = await submitDecision(current.dispute_id, { decision: "FIGHT", notes: draft(), analysisId: analysisId() });
  assert.equal(r.status, "unknown");
  assert.equal(getSubmission(current.dispute_id).status, "unknown");
  // PayPal shows nothing happened → released for retry
  db.prepare("UPDATE submissions SET at = '2000-01-01T00:00:00Z' WHERE dispute_id = ?").run(current.dispute_id);
  fakePayPal({ state: () => current });
  await reconcileSubmissions();
  assert.equal(getSubmission(current.dispute_id), null);
});

test("stale analysis id → 409; REFUND sends accept-claim with type REFUND", async () => {
  const calls = fakePayPal({ state: () => current });
  await assert.rejects(submitDecision(current.dispute_id, { decision: "REFUND", notes: "Refunding.", analysisId: 999999 }), { status: 409 });
  await submitDecision(current.dispute_id, { decision: "REFUND", notes: "We accept this claim.", analysisId: analysisId() });
  const post = calls.find((c) => c.method === "POST");
  assert.match(post.path, /accept-claim$/);
  assert.deepEqual(JSON.parse(post.body), { note: "We accept this claim.", accept_claim_type: "REFUND" });
});

test("evidence types per reason use only sandbox-verified values", () => {
  const recs = sc.records;
  assert.equal(buildEvidences({ reason: "UNAUTHORISED" }, recs, "n")[0].evidence_type, "DETAILS_OF_PURCHASE");
  assert.equal(buildEvidences({ reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED" }, recs, "n")[0].evidence_type, "PROOF_OF_FULFILLMENT");
  assert.equal(buildEvidences({ reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED" }, scenarioByKey("inr-phonecase").records, "n")[0].evidence_type, "OTHER");
});

test("renderPdf produces a structurally valid PDF and escapes hostile text", () => {
  const buf = renderPdf({ title: "T (x)", sections: [{ heading: "H", body: "a\\b (c) ✓ " + "word ".repeat(2000) }] });
  const s = buf.toString("latin1");
  assert.ok(s.startsWith("%PDF-1.4"));
  assert.ok(s.trimEnd().endsWith("%%EOF"));
  const xref = Number(/startxref\n(\d+)/.exec(s)[1]);
  assert.equal(s.slice(xref, xref + 4), "xref");
  assert.match(s, /\/Count [2-9]/); // long body spans pages
  assert.match(s, /\\\(c\\\)/);
});

test("in-flight (pending) claims are never released by reconcile; stale ones become unknown first", async () => {
  db.prepare("INSERT INTO submissions (dispute_id, action, at, status) VALUES (?, 'provide_evidence', ?, 'pending')").run(current.dispute_id, new Date().toISOString());
  fakePayPal({ state: () => current });
  await reconcileSubmissions();
  assert.equal(getSubmission(current.dispute_id).status, "pending");
  db.prepare("UPDATE submissions SET at = '2000-01-01T00:00:00Z' WHERE dispute_id = ?").run(current.dispute_id);
  await reconcileSubmissions(); // stale pending → unknown → (still WAITING, no seller evidence) released
  assert.equal(getSubmission(current.dispute_id), null);
});

test("decision must be a plain string (no array coercion)", async () => {
  fakePayPal({ state: () => current });
  await assert.rejects(submitDecision(current.dispute_id, { decision: ["FIGHT"], notes: draft(), analysisId: analysisId() }), { status: 400 });
});

test("refund notes are fact-checked too", async () => {
  const calls = fakePayPal({ state: () => current });
  await assert.rejects(submitDecision(current.dispute_id, { decision: "REFUND", notes: "We already refunded $999 last week.", analysisId: analysisId() }), { status: 422 });
  assert.equal(calls.length, 0);
});

test("renderPdf keeps typographic punctuation the model writes (no 'buyer?s')", () => {
  const pdf = renderPdf({ title: "Evidence", sections: [{ heading: "Seller response", body: "The buyer’s “claim” — delivered on 2026-10-25… €5" }] }).toString("latin1");
  assert.match(pdf, /buyer\x92s \x93claim\x94 \x97 delivered/);
  assert.doesNotMatch(pdf, /buyer\?s/);
});
