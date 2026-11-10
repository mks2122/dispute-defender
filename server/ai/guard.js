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
// Negated mentions ("no return was received", "never agreed") deny the event, so they don't count as claims.
const ASSERTIONS = [
  { re: /\b(agreed|agreement|promised|settled|arranged)\b/i, supported: (s) => /\b(agreed|agreement|promised|settled)\b/i.test(s.sellerMessages), msg: "claims an agreement with the buyer that isn't in your records" },
  { re: /\b(refunded|reimbursed|compensated|credited|issued (a |the )?refund|refund (was|has been|had been) (issued|sent|processed))\b/i, supported: (s) => /refund_issued|"refunds":\[[^\]]/.test(s.all), msg: "claims a refund or compensation was issued, which isn't in your records" },
  { re: /\b(returned|sent (it|the item|them) back|received (it|the item|the return) back|return was received)\b/i, supported: (s) => /"returns_received":\[[^\]]/.test(s.all), msg: "claims the item was returned, which isn't in your records" },
  { re: /\b(phoned|called (us|me|our)|on the phone|admitted|admits|confessed|acknowledged)\b/i, supported: (s) => /\b(phone|call|admit|confess|acknowledg)/i.test(s.all), msg: "describes a call or an admission by the buyer that isn't in your records" },
  { re: /\b(police|fraud(ulent|ster)?|scam(mer)?|criminal|history of (chargebacks|disputes|abuse))\b/i, supported: (s) => /\b(police|fraud|scam|criminal)/i.test(s.all), msg: "accuses the buyer (fraud, police) without anything in your records to back it up" },
  { re: /\b(never|did not|didn't|has not|hasn't|have not|haven't)\s+(contact(ed)?|message[ds]?|e-?mail(ed)?|reach(ed)? out|complain(ed)?|ask(ed)?|request(ed)?|use[ds]?|raise[ds]?)\b/i, supported: (s) => !s.buyerWrote, msg: "says the buyer never got in touch or never asked, but your records log messages from the buyer", negative: true },
];
const NEGATION = /\b(no|not|never|without|nothing|none|neither|nor)\b|n't\b/i;

// Reported speech: "The buyer alleges that a refund was agreed" reports the buyer's claim, it doesn't make it,
// unless the sentence turns ("..., but we refunded them") before the event word.
const REPORTED = /\bthe buyer (?:alleges|claims|says|states|asserts|wrote|contends)\b/gi;
const TURN = /\b(but|however|although|whereas|yet)\b/i;

/** Does the text make this claim? Denials ("no return was received") and reported buyer claims don't count. */
function asserts(a, text) {
  const re = new RegExp(a.re.source, "gi");
  for (const m of text.matchAll(re)) {
    if (a.negative) return true;
    const clause = text.slice(Math.max(0, m.index - 40), m.index).split(/[.;!?]\s/).pop();
    if (NEGATION.test(clause)) continue;
    const sentence = text.slice(Math.max(0, m.index - 160), m.index).split(/[.;!?]\s/).pop();
    const reported = [...sentence.matchAll(REPORTED)].pop();
    if (reported && !TURN.test(sentence.slice(reported.index))) continue;
    return true;
  }
  return false;
}

// A date must belong to the event it is attached to: "delivered on X" must be a delivery date in the records.
const EVENTS = [
  { re: /\bdeliver(?:ed|y)\b/gi, label: "delivery", dates: (r) => (r.type === "shipment" ? [r.data.delivered] : []) },
  { re: /\b(?:shipped|dispatched|sent out)\b/gi, label: "shipping", dates: (r) => (r.type === "shipment" ? [r.data.shipped] : []) },
  { re: /\b(?:placed|ordered|purchased|bought)\b/gi, label: "order", dates: (r) => (r.type === "order" || r.type === "prior_order" ? [r.data.placed] : []) },
];
const WINDOW = 60;

/** The event keyword closest before `at`, in the same sentence and at most WINDOW characters back. */
function eventBefore(text, at) {
  let start = Math.max(0, at - WINDOW);
  const before = text.slice(start, at);
  const stop = Math.max(before.lastIndexOf(". "), before.lastIndexOf("; "), before.lastIndexOf("! "), before.lastIndexOf("? "));
  if (stop >= 0) start += stop + 2;
  let best = null;
  for (const ev of EVENTS) for (const m of text.slice(start, at).matchAll(ev.re)) if (!best || m.index >= best.index) best = { ev, index: m.index };
  return best?.ev ?? null;
}

function eventDateErrors(text, facts, records) {
  const errors = [];
  for (const f of facts) {
    if (f.kind !== "date" && f.kind !== "monthday") continue;
    for (let at = text.indexOf(f.raw); at >= 0; at = text.indexOf(f.raw, at + 1)) {
      const ev = eventBefore(text, at);
      if (!ev) continue;
      const allowed = [...new Set(records.flatMap(ev.dates).filter(Boolean).map(String))];
      const values = [].concat(f.value);
      const ok = allowed.some((d) => values.includes(f.kind === "date" ? d.slice(0, 10) : d.slice(5, 10)));
      if (!ok) errors.push(allowed.length ? `“${f.raw}” is not the ${ev.label} date in your records (${allowed.join(", ")}).` : `“${f.raw}” is given as a ${ev.label} date, but your records have none.`);
    }
  }
  return errors;
}

/** "signed for by NAME" must match the signature on a shipment record. */
const SIGNED_BY = /\bsigned(?: for)? by ([^,;()\n]{1,40}?)(?=\s*(?:[,;()\n]|\b(?:at|on|and|in|who)\b|$))/gi;
const letters = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z]/g, "");
function signatureErrors(text, records) {
  const known = records.filter((r) => r.type === "shipment" && r.data.signed_by).map((r) => letters(r.data.signed_by));
  const errors = [];
  for (const m of text.matchAll(SIGNED_BY)) {
    const name = letters(m[1]);
    if (name && !known.includes(name)) errors.push(`“signed for by ${m[1].trim()}” doesn't match the signature in your shipment records${known.length ? "" : " (there is none)"}.`);
  }
  return errors;
}

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

  const plain = normalizeText(checkable);
  const facts = extractFacts(checkable);
  errors.push(...eventDateErrors(plain, facts, records), ...signatureErrors(plain, records));
  for (const f of facts) {
    // A record-shaped token is fine if it is a record id, or a value that appears in seller data (e.g. a batch number).
    const known = f.kind === "record" ? recordIds.has(f.value) || seller.text.includes(f.value.toLowerCase()) : factKnown(seller, f);
    if (known) { verified++; continue; }
    const fromBuyer = f.kind !== "record" && factKnown(buyer, f);
    errors.push(fromBuyer
      ? `“${f.raw}” comes only from the buyer. Quote it as The buyer alleges “…”, or remove it.`
      : `“${f.raw}” doesn't match anything in your records.`);
  }
  const support = { sellerMessages: JSON.stringify(records.filter((r) => r.data?.from === "seller")), all: JSON.stringify(sellerFacts), buyerWrote: records.some((r) => r.data?.from === "buyer") };
  for (const a of ASSERTIONS) if (asserts(a, plain) && !a.supported(support)) errors.push(`The response ${a.msg}.`);
  for (const id of citedIds) if (!recordIds.has(id)) errors.push(`The analysis cites ${id}, which is not one of your records.`);

  return { ok: errors.length === 0, errors: [...new Set(errors)], verified };
}

/** Expected value of fighting. The chargeback fee is sunk either way, so refunding is the zero baseline. */
export function expectedValue(winProbability, amount, timeCost) {
  const fight = Math.round((winProbability * amount - timeCost) * 100) / 100;
  return { fight, refund: 0, favours: fight > 0 ? "FIGHT" : "REFUND", timeCost };
}

export const bandFor = (p) => (p >= 0.65 ? "high" : p >= 0.35 ? "medium" : "low");
