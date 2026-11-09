// The approval gate (ARCHITECTURE §5.5): the only path that changes a dispute in PayPal.
// Order of operations matters: claim (UNIQUE row) → re-read dispute → act only on a live link → record.
import { getDisputeRow, upsertDispute, latestAnalysis, claimSubmission, finishSubmission, releaseSubmission, unknownSubmissions, markStalePendingUnknown, audit } from "./db.js";

const RECONCILE_AFTER_MS = 10 * 60_000;
import { getDispute, linkRels, provideEvidence, acceptClaim, PayPalError } from "./paypal/client.js";
import { checkDraft, buildInput } from "./ai/analyze.js";
import { renderPdf } from "./evidence/pdf.js";
import { MAX_NOTES } from "./ai/schema.js";
import { isActionable, sellerHasActed } from "./disputes.js";
import { log } from "./log.js";

export class SubmitError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.expose = true; Object.assign(this, extra); }
}

const CARRIERS = new Set(["UPS", "USPS", "FEDEX", "DHL"]);
const ACTION = { FIGHT: "provide_evidence", REFUND: "accept_claim" };

/** PayPal evidence entries for the reason, using only verified evidence types. */
export function buildEvidences(dispute, records, notes) {
  if (dispute.reason === "UNAUTHORISED") return [{ evidence_type: "DETAILS_OF_PURCHASE", notes }];
  const shp = records.find((r) => r.type === "shipment");
  const carrier = String(shp?.data.carrier ?? "").toUpperCase();
  if (shp?.data.tracking && CARRIERS.has(carrier)) {
    return [{ evidence_type: "PROOF_OF_FULFILLMENT", evidence_info: { tracking_info: [{ carrier_name: carrier, tracking_number: shp.data.tracking }] }, notes }];
  }
  return [{ evidence_type: "OTHER", notes }];
}

/** Evidence packet PDF: the approved response plus every cited seller record. */
export function buildPacket(dispute, records, notes, analysis) {
  const cited = new Set([...(analysis?.reasoning ?? []), ...(analysis?.evidence ?? []), ...(analysis?.contradictions ?? [])].flatMap((x) => x.source_ids));
  const sections = [
    { heading: "Seller response", body: notes },
    ...records.filter((r) => cited.has(r.id) || r.type === "shipment" || r.type === "order").map((r) => ({
      heading: `${r.title} (${r.id})`,
      body: Object.entries(r.data).map(([k, v]) => `${k.replace(/_/g, " ")}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join("\n"),
    })),
  ];
  if (analysis?.mandate) sections.push({ heading: "AI-agent mandate check", body: analysis.mandate.checks.map((c) => `${c.ok ? "PASS" : "FAIL"} ${c.label}: ${c.detail}`).join("\n") });
  return { name: `evidence-${dispute.dispute_id}.pdf`, type: "application/pdf", data: renderPdf({ title: `Evidence packet: dispute ${dispute.dispute_id}`, sections }) };
}

/**
 * @param {string} disputeId
 * @param {{decision: "FIGHT"|"REFUND", notes: string, analysisId: number}} body
 */
export async function submitDecision(disputeId, { decision, notes, analysisId }) {
  const row = getDisputeRow(disputeId);
  if (!row || row.batch === "retired") throw new SubmitError(404, "Dispute not found in this demo.");
  if (typeof decision !== "string" || !Object.hasOwn(ACTION, decision)) throw new SubmitError(400, "Choose FIGHT or REFUND.");
  const text = typeof notes === "string" ? notes.trim() : "";
  if (!text) throw new SubmitError(400, "Add a response before submitting.");
  if (text.length > MAX_NOTES) throw new SubmitError(400, `The response is ${text.length} characters; PayPal allows ${MAX_NOTES}.`);
  const analysisRow = latestAnalysis(disputeId);
  if (!analysisRow || analysisRow.id !== Number(analysisId)) throw new SubmitError(409, "The analysis changed since you opened this dispute. Review the latest one and try again.");
  const analysis = JSON.parse(analysisRow.payload);

  // Every note that goes to PayPal is fact-checked, including a refund's acceptance note.
  const guard = checkDraft(row, text, analysis);
  if (!guard.ok) throw new SubmitError(422, "Some facts in the response couldn't be verified against your records.", { errors: guard.errors });

  const action = ACTION[decision];
  if (!claimSubmission(disputeId, action, analysisRow.id)) throw new SubmitError(409, "A response for this dispute was already sent.");

  // Nothing has been sent yet: any failure here releases the claim so the seller can retry.
  let live;
  try {
    live = await getDispute(disputeId);
    upsertDispute(live);
  } catch (e) {
    releaseSubmission(disputeId);
    throw e;
  }
  if (!linkRels(live).includes(action)) {
    releaseSubmission(disputeId);
    throw new SubmitError(409, decision === "FIGHT" ? "PayPal isn't accepting evidence on this dispute right now." : "PayPal isn't offering a refund action on this dispute right now.");
  }

  const { records } = buildInput(getDisputeRow(disputeId));
  try {
    if (decision === "FIGHT") await provideEvidence(disputeId, { evidences: buildEvidences(live, records, text), file: buildPacket(live, records, text, analysis) });
    else await acceptClaim(disputeId, text);
  } catch (e) {
    if (e instanceof PayPalError && e.status >= 400 && e.status < 500) {
      // PayPal definitively rejected it: nothing happened, allow another attempt.
      releaseSubmission(disputeId);
      audit(disputeId, "submit_rejected", { action, status: e.status, issue: e.issue, debug_id: e.debugId });
      throw new SubmitError(422, "PayPal rejected the response.", { issue: e.issue, debugId: e.debugId });
    }
    // Timeout / 5xx / network: PayPal may or may not have acted. Never resend automatically.
    finishSubmission(disputeId, "unknown", { error: e.name });
    audit(disputeId, "submit_unconfirmed", { action });
    log.error("submit", `${action} on ${disputeId} unconfirmed`, e);
    return { status: "unknown", action };
  }

  finishSubmission(disputeId, "done", { action });
  audit(disputeId, decision === "FIGHT" ? "evidence_submitted" : "refund_accepted", { analysis_id: analysisRow.id });
  try { upsertDispute(await getDispute(disputeId)); } catch (e) { log.warn("submit", `post-submit refresh failed: ${e.message}`); }
  return { status: "done", action };
}

/**
 * Sync hook: resolve submissions PayPal never confirmed. If the dispute shows the seller acted (or moved on),
 * it was done; if it's still waiting with no seller evidence, nothing happened and the seller may retry.
 */
export async function reconcileSubmissions() {
  // In-flight submits can legitimately take minutes (GET retries + action timeout); never touch them.
  // A `pending` row older than the window can only come from a crash mid-submit, so it becomes `unknown`.
  const cutoff = new Date(Date.now() - RECONCILE_AFTER_MS).toISOString();
  markStalePendingUnknown(cutoff);
  // Release only after PayPal has had ample time to apply a late-processed request.
  const stale = unknownSubmissions(cutoff);
  for (const s of stale) {
    try {
      const d = await getDispute(s.dispute_id);
      upsertDispute(d);
      if (sellerHasActed(d) || !isActionable(d)) { finishSubmission(s.dispute_id, "done", { reconciled: true }); audit(s.dispute_id, "submit_confirmed", null); }
      else { releaseSubmission(s.dispute_id); audit(s.dispute_id, "submit_not_received", null); }
    } catch (e) {
      log.error("submit", `reconcile ${s.dispute_id} failed`, e);
    }
  }
  return stale.length;
}
