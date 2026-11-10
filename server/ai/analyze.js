// AI orchestration (application layer): build the input, call the configured provider, validate, then
// enrich with code-computed checks (guard, EV, mandate) and store. Never throws to callers for model
// problems: if the real model fails, the deterministic mock stands in and the result says so.
import { config, aiProviderName } from "../config.js";
import { getDisputeRow, saveAnalysis, latestAnalysis, audit } from "../db.js";
import { scenarioByKey } from "../store/catalog.js";
import { validateAnalysis } from "./schema.js";
import { guardDraft, expectedValue, bandFor } from "./guard.js";
import { checkMandate } from "./mandate.js";
import { factIndex, unverifiedBuyerClaims, detectInjection, splitRecords, stripInjectionFromQuotes } from "./facts.js";
import { mockAnalyze } from "./mock.js";
import { openaiAnalyze } from "./openai.js";
import { log } from "../log.js";
import { mapLimit } from "../util.js";

/** Everything the model and the guard need about one dispute. */
export function buildInput(row) {
  const dispute = JSON.parse(row.raw);
  const records = scenarioByKey(row.scenario)?.records ?? [];
  const { sellerFacts, buyerTexts: loggedBuyerTexts } = splitRecords(records);
  const buyerTexts = [
    ...(dispute.evidences ?? []).filter((e) => e.source === "SUBMITTED_BY_BUYER" && e.notes).map((e) => e.notes),
    ...loggedBuyerTexts,
  ];
  const sellerIdx = factIndex(sellerFacts);
  const imagePaths = [
    ...records.filter((r) => r.type === "listing").flatMap((r) => (r.data.images ?? []).map((path) => ({ path, label: `seller listing photo (${r.id})`, trusted: true }))),
    ...records.filter((r) => r.data?.packing_photo).map((r) => ({ path: r.data.packing_photo, label: `seller packing photo (${r.id})`, trusted: true })),
    ...records.filter((r) => r.data?.attachment).map((r) => ({ path: r.data.attachment, label: `photo sent by the buyer (${r.id})`, trusted: false })),
  ];
  return {
    dispute,
    records,
    buyerTexts,
    mandate: checkMandate(records),
    unverifiedClaims: unverifiedBuyerClaims(buyerTexts, sellerIdx),
    injection: detectInjection(buyerTexts),
    requestedEvidence: (dispute.evidences ?? []).filter((e) => e.source === "REQUESTED_FROM_SELLER").map((e) => e.evidence_type),
    imagePaths,
  };
}

/** Seller-side facts from PayPal that the draft may legitimately mention. */
export const sellerContext = (dispute) => ({
  dispute_id: dispute.dispute_id,
  amount: dispute.dispute_amount?.value,
  seller_transaction_id: dispute.disputed_transactions?.[0]?.seller_transaction_id,
});

const usd = (n) => `${n < 0 ? "-" : ""}${Math.abs(n).toFixed(2)}`;

const citedIds = (a) => [...a.reasoning, ...a.evidence, ...a.contradictions].flatMap((x) => x.source_ids);

/** Runs the guard for any draft text (used for the model's draft and for seller edits). */
export function checkDraft(row, notes, analysisPayload) {
  const input = buildInput(row);
  return guardDraft(notes, { records: input.records, sellerContext: sellerContext(input.dispute), buyerTexts: input.buyerTexts, citedIds: analysisPayload ? citedIds(analysisPayload) : [] });
}

async function runProvider(name, input) {
  if (name === "openai") return openaiAnalyze(input);
  return { analysis: mockAnalyze(input), model: "dispute-defender-mock-1", usage: null };
}

const inFlight = new Map();

/** Analyse one dispute (single-flight per dispute). Returns the stored analysis row id. */
export function analyzeDispute(disputeId) {
  if (inFlight.has(disputeId)) return inFlight.get(disputeId);
  const p = doAnalyze(disputeId).finally(() => inFlight.delete(disputeId));
  inFlight.set(disputeId, p);
  return p;
}

async function doAnalyze(disputeId) {
  const row = getDisputeRow(disputeId);
  if (!row) throw new Error(`unknown dispute ${disputeId}`);
  const input = buildInput(row);
  const wanted = aiProviderName();
  const started = Date.now();
  let provider = wanted, out, fallback = null;
  try {
    out = await runProvider(wanted, input);
    const problems = validateAnalysis(out.analysis);
    if (problems.length) throw Object.assign(new Error(`schema: ${problems.join(", ")}`), { code: "bad_schema" });
  } catch (e) {
    if (wanted === "mock") throw e; // the mock failing is a bug, not an outage
    log.error("ai", `${wanted} analysis failed for ${disputeId}; using the mock`, e);
    fallback = e.code ?? "error";
    provider = "mock";
    out = await runProvider("mock", input);
  }
  const latencyMs = Date.now() - started;
  // A quoted buyer instruction ("IGNORE ALL PRIOR INSTRUCTIONS…") must never be forwarded to PayPal.
  const a = { ...out.analysis, draft_notes: stripInjectionFromQuotes(out.analysis.draft_notes) };
  const amount = Number(input.dispute.dispute_amount?.value ?? 0);
  const ev = expectedValue(a.win_probability, amount, config.aiTimeCostUsd);
  const guard = guardDraft(a.draft_notes, { records: input.records, sellerContext: sellerContext(input.dispute), buyerTexts: input.buyerTexts, citedIds: citedIds(a) });
  const warnings = [];
  // Fighting with a negative expected value wastes the seller's time; refunding a case the records say the buyer
  // is right about is honest even when a long-shot fight would "pay" on paper, so that only gets a note.
  if (a.recommendation === "FIGHT" && ev.fight <= 0) warnings.push(`Fighting is expected to cost more than it recovers (${usd(ev.fight)}). Consider refunding.`);
  if (a.recommendation === "REFUND" && ev.fight > 0) warnings.push(`A long-shot fight is worth ${usd(ev.fight)} on paper, but your records support the buyer, so refunding is the honest choice.`);
  // Proof of refund only matters after refunding, so it never counts as a gap in a fight.
  if (a.recommendation === "FIGHT" && a.evidence.some((x) => x.status === "missing" && !/refund/i.test(x.requirement))) warnings.push("Some evidence PayPal usually needs is missing.");
  // Code-level backstop for prompt injection: an injection that pushes for a refund and a REFUND verdict
  // together deserve a second look, whatever the model's reasons.
  if ((a.injection_detected || input.injection) && a.recommendation === "REFUND") warnings.push("The buyer's text tried to steer the AI, and this recommendation is what it asked for. Check that the reasoning stands on your records alone before refunding.");
  // The band is always recomputed from the probability below; a mismatch isn't worth the seller's attention.

  const payload = {
    ...a,
    confidence_band: bandFor(a.win_probability),
    injection_detected: a.injection_detected || input.injection,
    unverified_buyer_claims: [...new Set([...input.unverifiedClaims, ...a.unverified_buyer_claims])],
    ev, guard, warnings,
    mandate: input.mandate,
  };
  const id = saveAnalysis({ disputeId, provider, model: out.model, fallback, latencyMs, usage: out.usage, payload });
  audit(disputeId, "ai_analyzed", { provider, model: out.model, fallback, latency_ms: latencyMs, usage: out.usage, recommendation: a.recommendation, guard_ok: guard.ok });
  return id;
}

/** Sync hook: analyse disputes that have no analysis yet. Never throws. */
export async function analyzeMissing(rows) {
  const todo = rows.filter((r) => !latestAnalysis(r.id));
  if (!todo.length) return 0;
  const results = await mapLimit(todo, 2, (r) => analyzeDispute(r.id));
  for (const f of results.filter((x) => !x.ok)) log.error("ai", `auto-analysis failed for ${f.item.id}`, f.error);
  return results.filter((x) => x.ok).length;
}
