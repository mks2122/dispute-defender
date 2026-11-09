// Turns raw PayPal dispute JSON + store data into what the UI shows.
import { scenarioByKey, STORE } from "./store/catalog.js";
import { getSubmission, auditFor, latestAnalysis } from "./db.js";
import { linkRels } from "./paypal/client.js";
import { isResolved, isActionable, sellerHasActed } from "./disputes.js";

const SELLER_ACTIONS = ["provide_evidence", "accept_claim", "adjudicate"];

export const REASON_LABELS = {
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "Not as described",
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "Not received",
  UNAUTHORISED: "Unauthorized",
  DUPLICATE_TRANSACTION: "Duplicate",
  CREDIT_NOT_PROCESSED: "Credit not processed",
  CANCELED_RECURRING_BILLING: "Canceled recurring",
  PROBLEM_WITH_REMITTANCE: "Remittance problem",
  INCORRECT_AMOUNT: "Incorrect amount",
  PAYMENT_BY_OTHER_MEANS: "Paid by other means",
  OTHER: "Other",
};

/** One plain-language phase per dispute, so the seller knows what to do. */
export function phaseOf(d, submission) {
  if (isResolved(d)) return { key: "RESOLVED", label: "Resolved" };
  if (submission?.status === "pending") return { key: "SUBMITTING", label: "Sending to PayPal…" };
  if (submission?.status === "unknown") return { key: "SUBMITTING", label: "Confirming with PayPal…" };
  if (submission) return { key: "SUBMITTED", label: submission.action === "accept_claim" ? "Refund sent" : "Evidence submitted" };
  if (isActionable(d)) return { key: "ACTION_NEEDED", label: "Your response needed" };
  if (sellerHasActed(d)) return { key: "SUBMITTED", label: "Evidence submitted" };
  return { key: "PROCESSING", label: "PayPal is processing" };
}

export function buyerClaims(d) {
  return (d.evidences ?? [])
    .filter((e) => e.source === "SUBMITTED_BY_BUYER" && e.notes)
    .map((e) => ({ date: e.date, text: e.notes, source: "SUBMITTED_BY_BUYER" }));
}

export function toRow(row) {
  const d = JSON.parse(row.raw);
  const sc = scenarioByKey(row.scenario);
  const submission = getSubmission(row.id);
  const parsed = Number(d.dispute_amount?.value);
  const amount = Number.isFinite(parsed) ? parsed : 0;
  const phase = phaseOf(d, submission);
  const refunded = submission?.action === "accept_claim";
  return {
    id: row.id,
    scenario: row.scenario,
    item: sc?.title ?? "Unknown order",
    tags: [sc?.hero && "hero", sc?.agentic && "agent purchase", sc?.adversarial && "adversarial"].filter(Boolean),
    buyer: d.disputed_transactions?.[0]?.buyer?.name ?? sc?.buyer.name ?? "—",
    amount,
    currency: d.dispute_amount?.currency_code ?? "USD",
    reason: d.reason ?? null,
    reasonLabel: REASON_LABELS[d.reason] ?? d.reason ?? "Pending",
    stage: d.dispute_life_cycle_stage ?? null,
    status: d.status,
    phase: phase.key,
    phaseLabel: phase.label,
    // Chargeback funds are already debited: the full amount stays at risk until resolved or refunded.
    atRisk: phase.key === "RESOLVED" || refunded ? 0 : amount,
    paypalDue: d.seller_response_due_date ?? null,
    actions: linkRels(d).filter((r) => SELLER_ACTIONS.includes(r)),
    outcome: d.dispute_outcome?.outcome_code ?? null,
    createdAt: d.create_time ?? row.created_at,
    updatedAt: d.update_time ?? row.synced_at,
    image: sc?.records.find((r) => r.type === "listing")?.data.images?.[0] ?? null,
    ai: aiSummary(latestAnalysis(row.id)),
  };
}

function aiSummary(a) {
  if (!a) return null;
  const p = JSON.parse(a.payload);
  return { recommendation: p.recommendation, band: p.confidence_band, ev: p.ev.fight, guardOk: p.guard.ok, injection: p.injection_detected, provider: a.provider };
}

/** Full analysis for the case view. */
export function analysisView(a) {
  if (!a) return null;
  const p = JSON.parse(a.payload);
  return { id: a.id, createdAt: a.created_at, provider: a.provider, model: a.model, fallback: a.fallback, latencyMs: a.latency_ms, ...p };
}

export function toCase(row) {
  const d = JSON.parse(row.raw);
  const sc = scenarioByKey(row.scenario);
  return {
    ...toRow(row),
    store: STORE,
    buyerClaims: buyerClaims(d),
    records: sc?.records ?? [],
    requestedFromSeller: (d.evidences ?? []).filter((e) => e.source === "REQUESTED_FROM_SELLER").map((e) => e.evidence_type),
    allowedResponses: d.allowed_response_options ?? null,
    transaction: d.disputed_transactions?.[0] ?? null,
    submission: getSubmission(row.id),
    analysis: analysisView(latestAnalysis(row.id)),
    audit: auditFor(row.id),
    paypal: { status: d.status, stage: d.dispute_life_cycle_stage, channel: d.dispute_channel, outcome: d.dispute_outcome ?? null, links: linkRels(d) },
  };
}
