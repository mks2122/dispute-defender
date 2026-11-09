// The safety gate between the model and PayPal (ARCHITECTURE §5.4, ENGINEERING-PRACTICES §7).
// Approve is blocked unless every checkable fact in the draft traces to a SELLER record or the dispute's own
// seller-side data. Facts found only in buyer text are reported as such. Pure function.
import { extractFacts, factIndex, factKnown } from "./facts.js";
import { MAX_NOTES } from "./schema.js";

const BUYER_QUOTE = /\bthe buyer (?:alleges|claims|states|says|wrote)\b[^"“]{0,40}["“][^"”]*["”]/gi;

const ASSERTIONS = [
  { re: /\b(we|i|seller)\s+(have\s+|had\s+)?(already\s+)?(agreed|promised)\b/i, msg: "claims an agreement with the buyer that isn't in your records" },
  { re: /\b(refund(ed)?\s+(has been|was)\s+(issued|sent)|already refunded)\b/i, msg: "claims a refund was issued, which isn't in your records" },
];

/**
 * @param {string} notes the draft the seller would submit
 * @param {{records: object[], sellerContext: object, buyerTexts: string[], citedIds?: string[]}} ctx
 * @returns {{ok: boolean, errors: string[], verified: number}}
 */
export function guardDraft(notes, { records, sellerContext, buyerTexts = [], citedIds = [] }) {
  const errors = [];
  const text = String(notes ?? "");
  if (!text.trim()) errors.push("The response is empty.");
  if (text.length > MAX_NOTES) errors.push(`The response is ${text.length} characters; PayPal allows ${MAX_NOTES}.`);

  const seller = factIndex([...records, sellerContext]);
  const buyer = factIndex(buyerTexts);
  const recordIds = new Set(records.map((r) => r.id));
  let verified = 0;
  // An explicit quote of the buyer (The buyer alleges "...") is allowed to contain the buyer's own claims.
  const checkable = text.replace(BUYER_QUOTE, "");

  for (const f of extractFacts(checkable)) {
    if (f.kind === "record" ? recordIds.has(f.value) : factKnown(seller, f)) { verified++; continue; }
    const fromBuyer = f.kind !== "record" && factKnown(buyer, f);
    errors.push(fromBuyer
      ? `“${f.raw}” comes only from the buyer's statement. Quote it as “the buyer alleges …” or remove it.`
      : `“${f.raw}” doesn't match anything in your records.`);
  }
  for (const a of ASSERTIONS) {
    if (a.re.test(checkable) &&!/(agreed|promised|refund issued)/i.test(JSON.stringify(records.filter((r) => r.data?.from === "seller")))) errors.push(`The response ${a.msg}.`);
  }
  for (const id of citedIds) if (!recordIds.has(id)) errors.push(`The analysis cites ${id}, which is not one of your records.`);

  return { ok: errors.length === 0, errors: [...new Set(errors)], verified };
}

/** Expected value of fighting. The chargeback fee is sunk either way, so refunding is the zero baseline. */
export function expectedValue(winProbability, amount, timeCost) {
  const fight = Math.round((winProbability * amount - timeCost) * 100) / 100;
  return { fight, refund: 0, favours: fight > 0 ? "FIGHT" : "REFUND", timeCost };
}

export const bandFor = (p) => (p >= 0.65 ? "high" : p >= 0.35 ? "medium" : "low");
