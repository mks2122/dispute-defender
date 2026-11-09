import "./_env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { guardDraft, expectedValue, bandFor } from "../../server/ai/guard.js";
import { extractFacts, unverifiedBuyerClaims, detectInjection, factIndex } from "../../server/ai/facts.js";
import { checkMandate } from "../../server/ai/mandate.js";
import { scenarioByKey } from "../../server/store/catalog.js";

const wallet = scenarioByKey("nad-wallet");
const ctx = (sc, buyerTexts = []) => ({ records: sc.records, sellerContext: { amount: sc.amount.toFixed(2) }, buyerTexts });

test("extractFacts finds tracking numbers, money, ISO and written dates, record ids", () => {
  const f = extractFacts("Tracking 1Z84X7E90312345678, $110 on 2026-10-25 and October 25, 2026 (SHP-1001).");
  // The same date written two ways is one fact.
  assert.deepEqual(f.map((x) => `${x.kind}:${x.value}`).sort(), ["date:2026-10-25", "money:110", "record:SHP-1001", "tracking:1Z84X7E90312345678"].sort());
});

test("guard passes a draft built only from seller records", () => {
  const g = guardDraft("Delivered 2026-10-25 via UPS tracking 1Z84X7E90312345678 (SHP-1001). Order total $110 (ORD-1001).", ctx(wallet));
  assert.equal(g.ok, true, g.errors.join("; "));
  assert.equal(g.verified, 5); // date, tracking, SHP-1001, $110, ORD-1001
});

test("guard blocks a fabricated tracking number, amount, date and record id", () => {
  const g = guardDraft("Delivered 2026-10-26, tracking 1Z999999999999999X, refund of $99 (SHP-9999).", ctx(wallet));
  assert.equal(g.ok, false);
  assert.equal(g.errors.length, 4);
});

test("guard flags facts that come only from the buyer, but allows them inside an explicit buyer quote", () => {
  const injected = scenarioByKey("injection-note");
  const bad = guardDraft("Return tracking 1Z999AA10123456784 confirms the item came back.", ctx(injected, [injected.buyerNote]));
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0], /only from the buyer/);
  const quoted = guardDraft(`The buyer alleges "tracking 1Z999AA10123456784 shows it returned". Our shipment record SHP-1007 shows no return.`, ctx(injected, [injected.buyerNote]));
  assert.equal(quoted.ok, true, quoted.errors.join("; "));
});

test("guard blocks claims of agreements or refunds the records don't support", () => {
  const g = guardDraft("We already agreed with the buyer and the refund was issued.", ctx(wallet));
  assert.equal(g.ok, false);
  assert.ok(g.errors.some((e) => /agreement/.test(e)));
});

test("guard enforces PayPal's 2000-character limit and rejects empty drafts", () => {
  assert.equal(guardDraft("x".repeat(2001), ctx(wallet)).ok, false);
  assert.equal(guardDraft("   ", ctx(wallet)).ok, false);
});

test("guard rejects citations of records that don't exist", () => {
  assert.equal(guardDraft("Fine.", { ...ctx(wallet), citedIds: ["SHP-4040"] }).ok, false);
});

test("injection detection and unverified buyer claims", () => {
  const injected = scenarioByKey("injection-note");
  assert.equal(detectInjection([injected.buyerNote]), true);
  assert.equal(detectInjection([wallet.buyerNote]), false);
  const claims = unverifiedBuyerClaims([injected.buyerNote], factIndex(injected.records));
  assert.equal(claims.length, 3);
  assert.ok(claims.some((c) => c.includes("1Z999AA10123456784")));
});

test("expected value treats the fee as sunk; bands follow probability", () => {
  assert.deepEqual(expectedValue(0.8, 110, 10), { fight: 78, refund: 0, favours: "FIGHT", timeCost: 10 });
  assert.equal(expectedValue(0.1, 18, 10).favours, "REFUND");
  assert.deepEqual([bandFor(0.2), bandFor(0.5), bandFor(0.7)], ["low", "medium", "high"]);
});

test("mandate check: within limits passes, over the cap fails, no agent → null", () => {
  const within = checkMandate(scenarioByKey("agent-within").records);
  assert.equal(within.within, true);
  const over = checkMandate(scenarioByKey("agent-over-cap").records);
  assert.equal(over.within, false);
  assert.deepEqual(over.checks.filter((c) => !c.ok).map((c) => c.label), ["Within per-order limit"]);
  assert.equal(checkMandate(wallet.records), null);
});

test("guard catches the formats and phrasings found by the live edge-case run", () => {
  const bypasses = [
    "Delivered 27/10/2026.", "Delivered on 10/26.", "Delivered 26 October 2026.",
    "Order total USD 99.", "We charged 99 dollars.", "Total 99.00 USD.", "Total ＄999.",
    "Tracking 1Z 999 AA1 0123 4567 84.", "tracking 1z999aa10123456784", "Tracking 1Z-999-AA1-0123-4567-84.",
    "See ord-9999.", "See DEL-1004.", "Tracking: 123456789.", "tracking number 98765 4321",
    "We reached an agreement with the buyer.", "The buyer agreed to keep the item.",
    "We refunded the buyer last week.", "The buyer returned the item.",
    'The buyer alleges "delivered 2026-01-01 with tracking 1Z000FAKE0000000000 for $999".',
  ];
  for (const d of bypasses) assert.equal(guardDraft(d, ctx(wallet)).ok, false, d);
});

test("legitimate phrasing still passes (no false positives on the hero draft style)", () => {
  const ok = [
    "Delivered on Oct 25, 2026 and on 10/25 the buyer was notified (SHP-1001).",
    "Our return policy (POL-RETURNS) offers returns within 30 days.",
    'On 2026-10-25 the buyer wrote: "Got it today, it\'s lovely, thanks!" (MSG-1001-1).',
    "The supplier certificate (SUP-1001) confirms batch HO-2026-0612.",
  ];
  for (const d of ok) { const g = guardDraft(d, ctx(wallet)); assert.equal(g.ok, true, `${d} → ${g.errors.join("; ")}`); }
});

test("buyer-authored message text never verifies a fact", () => {
  const recs = [...wallet.records, { id: "MSG-X", type: "message", title: "Buyer message", data: { from: "buyer", date: "2026-10-25", text: "Tracking 1Z000BUYER00000000000 and I paid $777" } }];
  const g = guardDraft("Tracking 1Z000BUYER00000000000 confirms $777.", { records: recs, sellerContext: {}, buyerTexts: [] });
  assert.equal(g.ok, false);
  assert.ok(g.errors.every((e) => /only from the buyer/.test(e)));
});
