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
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, basename } from "node:path";

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

// Seller photos live with the web app's store images. Only these paths are ever read from disk.
const STORE_DIR = fileURLToPath(new URL("../web/public/store/", import.meta.url));
const PHOTO_PATH = /^\/store\/([\w-]+\.(png|jpe?g|gif))$/i;
const PHOTO_FIELDS = new Set(["images", "packing_photo"]);
const MAX_PHOTOS = 8; // PayPal takes up to 10 files per submission; one is the PDF
const MAX_PHOTO_BYTES = 5_000_000;

/** The seller's own photos (listing and packing) as PayPal evidence files. Buyer attachments are never sent back. */
export function sellerPhotos(records) {
  const seen = new Set();
  const out = [];
  for (const r of records) {
    if (r.data?.from === "buyer" || r.type === "message") continue;
    for (const [k, v] of Object.entries(r.data ?? {})) {
      if (!PHOTO_FIELDS.has(k)) continue;
      for (const p of [].concat(v)) {
        const m = typeof p === "string" ? PHOTO_PATH.exec(p) : null;
        if (!m || seen.has(m[1]) || out.length >= MAX_PHOTOS) continue;
        seen.add(m[1]);
        const file = join(STORE_DIR, m[1]);
        try {
          if (statSync(file).size > MAX_PHOTO_BYTES) continue;
          const ext = m[2].toLowerCase();
          out.push({ name: `${r.id}-${m[1]}`, file: m[1], type: ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : "image/jpeg", data: readFileSync(file), recordId: r.id, label: k === "packing_photo" ? "packing photo" : "listing photo" });
        } catch { log.warn("submit", `photo ${m[1]} for ${r.id} is missing; not attached`); }
      }
    }
  }
  return out;
}

/** A record field as packet text: photo paths become the name of the attached file, never a local path. */
function fieldText(k, v, photos) {
  if (PHOTO_FIELDS.has(k) || k === "attachment") {
    const names = [].concat(v).map((p) => photos.find((f) => f.file === basename(String(p)))?.name).filter(Boolean);
    return names.length ? `${k.replace(/_/g, " ")}: attached as ${names.join(", ")}` : null;
  }
  return `${k.replace(/_/g, " ")}: ${typeof v === "object" ? JSON.stringify(v) : v}`;
}

/** Evidence packet PDF: the approved response, every cited seller record, and a list of the attached photos. */
export function buildPacket(dispute, records, notes, analysis, photos = []) {
  const cited = new Set([...(analysis?.reasoning ?? []), ...(analysis?.evidence ?? []), ...(analysis?.contradictions ?? [])].flatMap((x) => x.source_ids));
  const sections = [
    { heading: "Seller response", body: notes },
    ...records.filter((r) => cited.has(r.id) || r.type === "shipment" || r.type === "order").map((r) => ({
      heading: `${r.title} (${r.id})`,
      body: Object.entries(r.data).map(([k, v]) => fieldText(k, v, photos)).filter(Boolean).join("\n"),
    })),
  ];
  if (photos.length) sections.push({ heading: "Attached photos", body: photos.map((p) => `${p.name}: seller ${p.label} (${p.recordId})`).join("\n") });
  if (analysis?.mandate) sections.push({ heading: "AI-agent mandate check", body: analysis.mandate.checks.map((c) => `${c.ok ? "PASS" : "FAIL"} ${c.label}: ${c.detail}`).join("\n") });
  return { name: `evidence-${dispute.dispute_id}.pdf`, type: "application/pdf", data: renderPdf({ title: `Evidence packet: dispute ${dispute.dispute_id}`, sections }) };
}

/**
 * @param {string} disputeId
 * @param {{decision: "FIGHT"|"REFUND", notes: string, analysisId: number}} body
 */
export async function submitDecision(disputeId, { decision, notes, analysisId }) {
  const row = getDisputeRow(disputeId);
  if (!row || row.batch === "retired") throw new SubmitError(404, "Dispute not found.");
  if (typeof decision !== "string" || !Object.hasOwn(ACTION, decision)) throw new SubmitError(400, "Choose FIGHT or REFUND.");
  const text = typeof notes === "string" ? notes.trim() : "";
  if (!text) throw new SubmitError(400, "Add a response before submitting.");
  if (text.length > MAX_NOTES) throw new SubmitError(400, `The response is ${text.length} characters; PayPal allows ${MAX_NOTES}.`);
  const analysisRow = latestAnalysis(disputeId);
  // A refund needs no analysis: a seller may refund a dispute they have no records for. Fighting always needs one.
  const refundWithoutAnalysis = decision === "REFUND" && !analysisRow && analysisId == null;
  if (!refundWithoutAnalysis && (!analysisRow || analysisRow.id !== Number(analysisId))) throw new SubmitError(409, "The analysis changed since you opened this dispute. Review the latest one and try again.");
  const analysis = analysisRow ? JSON.parse(analysisRow.payload) : null;

  // Every note that goes to PayPal is fact-checked, including a refund's acceptance note.
  const guard = checkDraft(row, text, analysis);
  if (!guard.ok) throw new SubmitError(422, "Some facts in the response couldn't be verified against your records.", { errors: guard.errors });

  const action = ACTION[decision];
  if (!claimSubmission(disputeId, action, analysisRow?.id ?? null)) throw new SubmitError(409, "A response for this dispute was already sent.");

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
    if (decision === "FIGHT") {
      const photos = sellerPhotos(records);
      await provideEvidence(disputeId, { evidences: buildEvidences(live, records, text), files: [buildPacket(live, records, text, analysis, photos), ...photos] });
    }
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
  audit(disputeId, decision === "FIGHT" ? "evidence_submitted" : "refund_accepted", { analysis_id: analysisRow?.id ?? null });
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
