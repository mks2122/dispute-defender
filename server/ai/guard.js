// The safety gate between the model and PayPal (ARCHITECTURE §5.4, ENGINEERING-PRACTICES §7).
// Approve is blocked unless every checkable fact in the draft traces to a SELLER-asserted record or the
// dispute's own seller-side data. Buyer-authored text never verifies a fact. A quote of the buyer is allowed
// only if it really is the buyer's words. Pure function.
import { extractFacts, factIndex, factKnown, splitRecords, normalizeText } from "./facts.js";
import { MAX_NOTES } from "./schema.js";

const MAX_QUOTE = 300;
const BUYER_QUOTE = /\bthe buyer (?:alleges|claims|states|says|wrote)\b[^"“]{0,40}["“]([^"”]{0,2000})["”]/gi;
const squash = (s) => normalizeText(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Claims that something HAPPENED between buyer and seller. Each needs a seller record that shows it.
const ASSERTIONS = [
  { re: /\b(agreed|agreement|promised|settled|arranged)\b/i, supported: (s) => /\b(agreed|agreement|promised|settled)\b/i.test(s.sellerMessages), msg: "claims an agreement with the buyer that isn't in your records" },
  { re: /\b(refunded|reimbursed|compensated|credited|issued (a |the )?refund|refund (was|has been|had been) (issued|sent|processed))\b/i, supported: (s) => /refund_issued|"refunds":\[[^\]]/.test(s.all), msg: "claims a refund or compensation was issued, which isn't in your records" },
  { re: /\b(returned|sent (it|the item|them) back|received (it|the item|the return) back|return was received)\b/i, supported: (s) => /"returns_received":\[[^\]]/.test(s.all), msg: "claims the item was returned, which isn't in your records" },
];

/**
 * @param {string} notes the draft the seller would submit
 * @param {{records: object[], sellerContext: object, buyerTexts: string[], citedIds?: string[]}} ctx
 *        buyerTexts: every buyer-authored text (PayPal notes + logged buyer messages)
 * @returns {{ok: boolean, errors: string[], verified: number}}
 */
export function guardDraft(notes, { records, sellerContext, buyerTexts = [], citedIds = [] }) {
  const errors = [];
  const text = String(notes ?? "");
  if (!text.trim()) errors.push("The response is empty.");
  if (text.length > MAX_NOTES) errors.push(`The response is ${text.length} characters; PayPal allows ${MAX_NOTES}.`);

  const { sellerFacts, buyerTexts: loggedBuyerTexts } = splitRecords(records);
  const allBuyer = [...buyerTexts, ...loggedBuyerTexts];
  const seller = factIndex([...sellerFacts, sellerContext]);
  const buyer = factIndex(allBuyer);
  const buyerSquashed = allBuyer.map(squash);
  const recordIds = new Set(records.map((r) => r.id));
  let verified = 0;

  // Genuine, short quotes of the buyer may contain the buyer's own claims; anything else stays checkable.
  const checkable = text.replace(BUYER_QUOTE, (whole, quoted) => {
    const q = squash(quoted);
    const genuine = q.length > 0 && quoted.length <= MAX_QUOTE && buyerSquashed.some((b) => b.includes(q));
    if (!genuine) errors.push(quoted.length > MAX_QUOTE ? "A quote attributed to the buyer is too long; quote only their key words." : "A quote attributed to the buyer doesn't match anything the buyer actually wrote.");
    return genuine ? "" : whole;
  });

  for (const f of extractFacts(checkable)) {
    // A record-shaped token is fine if it is a record id, or a value that appears in seller data (e.g. a batch number).
    const known = f.kind === "record" ? recordIds.has(f.value) || seller.text.includes(f.value.toLowerCase()) : factKnown(seller, f);
    if (known) { verified++; continue; }
    const fromBuyer = f.kind !== "record" && factKnown(buyer, f);
    errors.push(fromBuyer
      ? `“${f.raw}” comes only from the buyer. Quote it as The buyer alleges “…”, or remove it.`
      : `“${f.raw}” doesn't match anything in your records.`);
  }
  const support = { sellerMessages: JSON.stringify(records.filter((r) => r.data?.from === "seller")), all: JSON.stringify(sellerFacts) };
  const plain = normalizeText(checkable);
  for (const a of ASSERTIONS) if (a.re.test(plain) && !a.supported(support)) errors.push(`The response ${a.msg}.`);
  for (const id of citedIds) if (!recordIds.has(id)) errors.push(`The analysis cites ${id}, which is not one of your records.`);

  return { ok: errors.length === 0, errors: [...new Set(errors)], verified };
}

/** Expected value of fighting. The chargeback fee is sunk either way, so refunding is the zero baseline. */
export function expectedValue(winProbability, amount, timeCost) {
  const fight = Math.round((winProbability * amount - timeCost) * 100) / 100;
  return { fight, refund: 0, favours: fight > 0 ? "FIGHT" : "REFUND", timeCost };
}

export const bandFor = (p) => (p >= 0.65 ? "high" : p >= 0.35 ? "medium" : "low");
