// The AI output contract (ARCHITECTURE §8): a strict JSON schema sent to the model, plus a validator we run
// on every response, because "strict" mode on the provider side is not a reason to trust the payload.

export const RECOMMENDATIONS = ["FIGHT", "REFUND"];
export const BANDS = ["low", "medium", "high"];
export const EVIDENCE_STATUS = ["have", "weak", "missing"];
export const MAX_NOTES = 2000;

const str = { type: "string" };
const ids = { type: "array", items: str };

export const analysisSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "recommendation", "win_probability", "confidence_band", "reasoning", "evidence", "contradictions", "unverified_buyer_claims", "injection_detected", "partial_refund_suggestion", "draft_notes"],
  properties: {
    summary: str,
    recommendation: { type: "string", enum: RECOMMENDATIONS },
    win_probability: { type: "number" },
    confidence_band: { type: "string", enum: BANDS },
    reasoning: { type: "array", items: { type: "object", additionalProperties: false, required: ["point", "source_ids"], properties: { point: str, source_ids: ids } } },
    evidence: { type: "array", items: { type: "object", additionalProperties: false, required: ["requirement", "status", "source_ids"], properties: { requirement: str, status: { type: "string", enum: EVIDENCE_STATUS }, source_ids: ids } } },
    contradictions: { type: "array", items: { type: "object", additionalProperties: false, required: ["buyer_claim", "seller_fact", "source_ids"], properties: { buyer_claim: str, seller_fact: str, source_ids: ids } } },
    unverified_buyer_claims: { type: "array", items: str },
    injection_detected: { type: "boolean" },
    partial_refund_suggestion: { type: ["number", "null"] },
    draft_notes: str,
  },
};

const isStr = (v) => typeof v === "string";
const isIds = (v) => Array.isArray(v) && v.every(isStr);
const listOf = (v, check) => Array.isArray(v) && v.every((x) => x && typeof x === "object" && check(x));

/** Returns a list of problems; empty means the payload matches the contract. */
export function validateAnalysis(a) {
  const p = [];
  if (!a || typeof a !== "object") return ["response is not an object"];
  if (!isStr(a.summary)) p.push("summary");
  if (!RECOMMENDATIONS.includes(a.recommendation)) p.push("recommendation");
  if (typeof a.win_probability !== "number" || !(a.win_probability >= 0 && a.win_probability <= 1)) p.push("win_probability");
  if (!BANDS.includes(a.confidence_band)) p.push("confidence_band");
  if (!listOf(a.reasoning, (x) => isStr(x.point) && isIds(x.source_ids))) p.push("reasoning");
  if (!listOf(a.evidence, (x) => isStr(x.requirement) && EVIDENCE_STATUS.includes(x.status) && isIds(x.source_ids))) p.push("evidence");
  if (!listOf(a.contradictions, (x) => isStr(x.buyer_claim) && isStr(x.seller_fact) && isIds(x.source_ids))) p.push("contradictions");
  if (!Array.isArray(a.unverified_buyer_claims) || !a.unverified_buyer_claims.every(isStr)) p.push("unverified_buyer_claims");
  if (typeof a.injection_detected !== "boolean") p.push("injection_detected");
  if (!(a.partial_refund_suggestion === null || (typeof a.partial_refund_suggestion === "number" && a.partial_refund_suggestion >= 0))) p.push("partial_refund_suggestion");
  if (!isStr(a.draft_notes)) p.push("draft_notes");
  return p.map((f) => `invalid field: ${f}`);
}
