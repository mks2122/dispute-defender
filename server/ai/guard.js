// The safety gate between the model and PayPal (ARCHITECTURE §5.4, ENGINEERING-PRACTICES §7).
// Approve is blocked unless every checkable fact in the draft traces to a SELLER-asserted record or the
// dispute's own seller-side data. Buyer-authored text never verifies a fact. A quote of the buyer is allowed
// only if it really is the buyer's words, and only as a report: it can't be endorsed as true. Pure function.
import { extractFacts, factIndex, factKnown, splitRecords, normalizeText, isBuyerAuthored, wordsToNumber } from "./facts.js";
import { checkMandate } from "./mandate.js";
import { MAX_NOTES } from "./schema.js";

const MAX_QUOTE = 300;
// "The buyer alleges "A"", including chains: "The buyer alleges "A" and "B"" (every quote in the chain is checked).
const BUYER_QUOTE = /\bthe buyer (?:alleges|claims|states|says|wrote)\b[^"“]{0,40}((?:["“][^"”]{0,2000}["”](?:\s*(?:,\s*and|,|;|and)\s*(?=["“]))?)+)/gi;
const QUOTED = /["“]([^"”]{0,2000})["”]/g;
const squash = (s) => normalizeText(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const compact = (s) => normalizeText(s).toLowerCase().replace(/[^a-z0-9]/g, "");
// Words that treat a quoted buyer statement as true ("…", which matches our label).
const ENDORSE = /\b(match(es|ed)?|consistent with|confirm(s|ed)?|corroborat\w*|agrees? with|(is|was|are) (correct|accurate|true|right|valid|genuine)|lines? up|checks? out|verif(y|ies|ied)|as (shown|recorded|logged) in our)\b/i;
const NOT = /\b(not|no|never|nothing|none)\b|n't\b/i;

// What the records say, scoped to the record types that can actually show each event.
// Keyword searches never run over listings, orders or policies, so a product called "phone case" or a
// policy mentioning "fraud" can't support a claim about a call or a fraud history.
const CONTACT_TYPES = new Set(["message", "message_log", "note"]);
const EVIDENCE_TYPES = new Set(["message", "message_log", "note", "shipment", "supplier_cert", "prior_order"]);
const jsonOf = (rs) => JSON.stringify(rs).toLowerCase();

// Claims that something HAPPENED. Each needs a seller record that shows it. Negated, conditional, offered or
// reported mentions ("no return was received", "we will refund once…", "the buyer alleges a refund was agreed")
// don't make the claim.
const ASSERTIONS = [
  { re: /\b(agree[sd]?|agreeing|agreement|promised?|settled|settlement|arranged)\b/i, supported: (s) => /\b(agree|promise|settle)/.test(s.sellerContact), msg: "claims an agreement with the buyer that isn't in your records" },
  { re: /\b(refunded|reimbursed|compensated|credited|money back|(we|i)\s+(did\s+|have\s+|had\s+|already\s+)?refund(ed)?\b|did (we|i) refund|(sent|gave|given|issued|processed|paid|provided|made|completed)\b[^.;:]{0,30}\b(refund|reimbursement|credit)|(refund|reimbursement)\b[^.;:]{0,20}\b(was|has been|had been|is)\s+(issued|sent|processed|paid|completed))\b/i, supported: (s) => s.refunded, msg: "claims a refund or compensation was issued, which isn't in your records" },
  { re: /\b(returned|sent (it|them|the [a-z]+) back|(got|received|have|took|taken) (it|them|the [a-z]+( [a-z]+)?) back|return (was received|arrived|came back|reached us)|(parcel|package|item|return) (arrived|came) back|back (at|in) our (warehouse|store|shop|stock))\b/i, supported: (s) => s.returned, msg: "claims the item was returned, which isn't in your records" },
  { re: /\b(phoned|called (us|me|our)|on the phone|phone call|admitted|admits|confessed|acknowledged)\b/i, supported: (s) => s.phoned || /\b(phone|called|call log|admit|confess|acknowledg)/.test(s.sellerContact), msg: "describes a call or an admission by the buyer that isn't in your records" },
  { re: /\b(police|fraud(ulent|ster)?|scam(mer|ming)?|criminal|thie(f|ves)|theft|stole|liar|lying|abus(e|ive)|serial (disputer|chargeback)|blacklist(ed)?|(history|record|pattern) of (chargebacks|disputes|abuse|fraud))\b/i, supported: (s) => s.accusation, msg: "accuses the buyer (fraud, theft, abuse, police) without anything in your records to back it up" },
  { re: /\b(cctv|camera|footage|video|witness(es)?|bank (confirmed|verified|said|told|reported)|(card )?issuer (confirmed|verified|said)|carrier (confirmed|verified|said)|confirmed by the (bank|carrier|issuer))\b/i, supported: (s) => /\b(cctv|camera|footage|video|witness|bank|issuer|carrier_confirmation)/.test(s.evidence), msg: "cites evidence (camera footage, a bank or carrier confirmation, a witness) that isn't in your records" },
  { re: /\b(delivered|signed for|received (it|the (item|order|package|parcel|goods)))\b/i, supported: (s) => s.delivered, msg: "says the item was delivered, but your records show no delivery" },
  { re: /\b(we|i|our team|the seller|our store|our support)\s+(?:[a-z]+\s+){0,2}?(replied|responded|answered|wrote back|got back|reached out|contacted|emailed|messaged)\b/i, supported: (s) => s.sellerReplied, msg: "says you replied to or contacted the buyer, but your records show no reply" },
  { re: /\b(never|did not|didn't|has not|hasn't|have not|haven't)\s+(contact(ed)?|message[ds]?|e-?mail(ed)?|reach(ed)? out|complain(ed)?|ask(ed)?|request(ed)?|use[ds]?|raise[ds]?)\b/i, supported: (s) => !s.buyerWrote, msg: "says the buyer never got in touch or never asked, but your records log messages from the buyer", negative: true },
];
const MANDATE_OK = /\b(within|under|below|inside|compl(ied|iant|ies) with|consistent with|authori[sz]ed by|permitted by|allowed by|covered by|in line with|respected|honou?red)\b[^.;]{0,50}\b(mandate|cap|limit|authori[sz]ation)/i;

const SUBORDINATE = /\b(if|once|until|unless|upon|provided that|as soon as)\b/i;
const MODAL = /\b(will|would|can|could|shall|should|may|might|happy to|glad to|willing to|ready to|able to|offer(ed)? to|plan to|going to)\b|'(ll|d)\b/i;
const SUBJECTS = /\b(we|i|they|you|he|she|the buyer|the seller|our team|our store)\b/gi;
const NEGATION = /\b(no|not|never|without|nothing|none|neither|nor)\b|n't\b/i;
// A denial attached right after the event: "the refund agreement is not supported", "returned nothing".
const DENIED_AFTER = /^\s*(?:(?:[a-z']+\s+){0,3}?(?:is|was|are|were|has been|have been|remains?|does|did|do)\s+(?:not|never|un[a-z]+|false|contradicted|disputed|denied|baseless)\b|(?:[a-z']+\s+){0,3}?(?:isn't|wasn't|aren't|weren't|doesn't|didn't|hasn't|haven't)\b|(?:nothing|none|no)\b)/i;

// Reported speech: "The buyer alleges that a refund was agreed" reports the buyer's claim, it doesn't make it.
// The report ends at the first clause boundary: "The buyer wrote to us and we refunded them" makes the claim.
const REPORTED = /\bthe buyer(?:'s)? (?:alleges|alleged|claims|claimed|says|said|states|stated|asserts|asserted|wrote|contends|cited|insists|argues)\b/gi;
const REPORT_ENDS = /[;:]|,(?!\s*that\b)|\b(but|however|although|whereas|yet|so|then|which|while|because|since|and)\b(?!\s+that\b)/i;

const lastAfter = (s, re) => { let at = 0; for (const m of s.matchAll(re)) at = m.index + m[0].length; return s.slice(at); };

/** Does the text make this claim? Denials, conditionals/offers and reported buyer claims don't count. */
function asserts(a, text) {
  const re = new RegExp(a.re.source, "gi");
  for (const m of text.matchAll(re)) {
    if (a.negative) return true;
    const sentence = text.slice(Math.max(0, m.index - 200), m.index).split(/[.!?](?:\s|$)/).pop();
    const clause = sentence.split(/[,;:]/).pop().slice(-80);         // since the last punctuation
    const own = lastAfter(clause, SUBJECTS);                          // since the last subject ("we", "the buyer")
    if (NEGATION.test(own.replace(/\bnot only\b/gi, ""))) continue;
    if (SUBORDINATE.test(clause) || MODAL.test(own)) continue;
    if (DENIED_AFTER.test(text.slice(m.index + m[0].length, m.index + m[0].length + 60))) continue;
    const reported = [...sentence.matchAll(REPORTED)].pop();
    if (reported && !REPORT_ENDS.test(sentence.slice(reported.index + reported[0].length))) continue;
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
const AFTER_WINDOW = 45;

/** The event a date belongs to: the closest event word before it in the same sentence, else the first one after. */
function eventFor(text, at, len) {
  let start = Math.max(0, at - WINDOW);
  const before = text.slice(start, at);
  const stop = Math.max(before.lastIndexOf(". "), before.lastIndexOf("; "), before.lastIndexOf("! "), before.lastIndexOf("? "));
  if (stop >= 0) start += stop + 2;
  let best = null;
  for (const ev of EVENTS) for (const m of text.slice(start, at).matchAll(ev.re)) if (!best || m.index >= best.index) best = { ev, index: m.index };
  if (best) return best.ev;
  // "On 2026-10-21 the wallet was delivered": a date that opens its clause belongs to the event that follows.
  if (!/^(?:on|by|as of)?$/i.test(text.slice(start, at).split(/[,;:]/).pop().trim())) return null;
  const after = text.slice(at + len, at + len + AFTER_WINDOW).split(/[.;!?](?:\s|$)|,\s|\band\b/)[0];
  for (const ev of EVENTS) for (const m of after.matchAll(ev.re)) if (!best || m.index < best.index) best = { ev, index: m.index };
  return best?.ev ?? null;
}

function eventDateErrors(text, facts, records) {
  const errors = [];
  for (const f of facts) {
    if (f.kind !== "date" && f.kind !== "monthday") continue;
    for (let at = text.indexOf(f.raw); at >= 0; at = text.indexOf(f.raw, at + 1)) {
      const ev = eventFor(text, at, f.raw.length);
      if (!ev) continue;
      const allowed = [...new Set(records.flatMap(ev.dates).filter(Boolean).map(String))];
      const values = [].concat(f.value);
      const ok = allowed.some((d) => values.includes(f.kind === "date" ? d.slice(0, 10) : d.slice(5, 10)));
      if (!ok) errors.push(allowed.length ? `“${f.raw}” is not the ${ev.label} date in your records (${allowed.join(", ")}).` : `“${f.raw}” is given as a ${ev.label} date, but your records have none.`);
    }
  }
  return errors;
}

/** Any name given as the person who signed must match the signature on a shipment record. */
const NAME = "([A-Z][\\w.'-]*(?:\\s+[A-Z][\\w.'-]*){0,3})";
const SIGNATURES = [
  /\bsigned(?: for)? by ([^,;()\n]{1,40}?)(?=\s*(?:[,;()\n]|\b(?:at|on|and|in|who)\b|$))/gi,          // "signed for by NAME"
  new RegExp(`${NAME}\\s+signed\\b`, "g"),                                                              // "NAME signed for it"
  new RegExp(`\\b[Ss]ignature\\b[^.:\\n]{0,30}?(?::|\\bwas\\b|\\bis\\b|\\bfrom\\b|\\bof\\b)\\s*${NAME}`, "g"), // "Signature on delivery: NAME"
];
const NOT_NAMES = new Set(["THE", "THEBUYER", "BUYER", "IT", "HE", "SHE", "THEY", "WE", "I", "SOMEONE", "RECIPIENT", "THERECIPIENT", "A", "AN", "AND", "ON", "THEN", "WHO", "NOBODY", "NOONE"]);
const letters = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z]/g, "");
function signatureErrors(text, records) {
  const known = records.filter((r) => r.type === "shipment" && r.data.signed_by).map((r) => letters(r.data.signed_by));
  const errors = [];
  for (const re of SIGNATURES) {
    for (const m of text.matchAll(re)) {
      const raw = m[1].trim().replace(/[.]$/, "");
      const name = letters(raw);
      if (!name || NOT_NAMES.has(name) || /^(THE|A|AN)[A-Z]*$/.test(name) && NOT_NAMES.has(name.replace(/^(THE|A|AN)/, ""))) continue;
      if (!known.some((k) => name.includes(k))) errors.push(`“${raw}” as the signature doesn't match your shipment records${known.length ? "" : " (there is no signature on file)"}.`);
    }
  }
  return errors;
}

/**
 * Can the records back "N <things>"? Orders and messages may be counted up to what the records hold (the draft
 * may describe a subset: "two of the three earlier orders"); disputes, chargebacks, refunds and the like need
 * a count the seller actually recorded.
 */
function countChecker(records, sellerText) {
  const n = (f) => records.filter(f).length;
  const orders = n((r) => r.type === "prior_order") + n((r) => r.type === "order");
  const messages = n((r) => r.type === "message") + records.filter((r) => r.type === "message_log").reduce((s, r) => s + (Array.isArray(r.data?.messages) ? r.data.messages.length : 0), 0);
  const recorded = new Set([n((r) => r.type === "prior_order" && r.data?.disputed === true)]);
  for (const m of sellerText.matchAll(/"[a-z_]*(?:count|chargebacks|disputes|claims|refunds|returns|complaints)[a-z_]*"\s*:\s*(\d{1,4})\b/g)) recorded.add(Number(m[1]));
  for (const m of sellerText.matchAll(/\b(\d{1,4}|[a-z]+(?:[\s-][a-z]+)?)\s+(?:[a-z-]+\s+){0,2}?(chargebacks|disputes|claims|complaints|refunds|returns|cases)\b/g)) {
    const v = /^\d+$/.test(m[1]) ? Number(m[1]) : wordsToNumber(m[1]);
    if (v != null) recorded.add(v);
  }
  recorded.delete(0);
  return (value, raw) => {
    const noun = /([a-z]+)\s*$/i.exec(raw)?.[1].toLowerCase() ?? "";
    if (/^(orders|purchases|transactions)$/.test(noun)) return value <= orders;
    if (/^(messages|emails)$/.test(noun)) return value <= messages;
    return recorded.has(value);
  };
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
  const sellerCompact = compact(seller.text);
  const buyer = factIndex(allBuyer);
  const buyerSquashed = allBuyer.map(squash);
  const recordIds = new Set(records.map((r) => r.id));
  let verified = 0;

  // Genuine, short quotes of the buyer may contain the buyer's own claims, but only as a report:
  // endorsing one ("…", which matches our label) is an error. Anything else stays checkable.
  const source = normalizeText(text);
  const checkable = source.replace(BUYER_QUOTE, (whole, chain, offset) => {
    let allGenuine = true;
    for (const [, quoted] of chain.matchAll(QUOTED)) {
      const q = squash(quoted);
      const genuine = q.length > 0 && quoted.length <= MAX_QUOTE && buyerSquashed.some((b) => b.includes(q));
      if (!genuine) {
        allGenuine = false;
        errors.push(quoted.length > MAX_QUOTE ? "A quote attributed to the buyer is too long; quote only their key words." : "A quote attributed to the buyer doesn't match anything the buyer actually wrote.");
      }
    }
    const rest = source.slice(offset + whole.length).split(/[.!?](?:\s|$)/)[0];
    if (allGenuine && ENDORSE.test(rest) && !NOT.test(rest)) errors.push("The response treats the buyer's quoted words as true. Buyer text can't confirm a fact; cite your own records instead.");
    return allGenuine ? whole.slice(0, whole.length - chain.length) : whole;
  });

  const plain = checkable;
  const facts = extractFacts(checkable);
  errors.push(...eventDateErrors(plain, facts, records), ...signatureErrors(plain, records));
  const countKnown = countChecker(sellerFacts, seller.text);
  for (const f of facts) {
    if (f.kind === "unreadable") { errors.push(`“${f.raw}” can't be checked. Write dates as YYYY-MM-DD and numbers in digits.`); continue; }
    let known;
    if (f.kind === "record") known = recordIds.has(f.value) || seller.text.includes(f.value.toLowerCase()) || sellerCompact.includes(compact(f.value));
    else if (f.kind === "ip") known = seller.text.includes(f.value);
    else if (f.kind === "phone") known = sellerCompact.includes(f.value);
    else if (f.kind === "count") known = countKnown(f.value, f.raw);
    else known = factKnown(seller, f);
    if (known) { verified++; continue; }
    const fromBuyer = !["record", "count"].includes(f.kind) && (f.kind === "ip" || f.kind === "phone" ? compact(buyer.text).includes(compact(f.value)) : factKnown(buyer, f));
    errors.push(fromBuyer
      ? `“${f.raw}” comes only from the buyer. Quote it as The buyer alleges “…”, or remove it.`
      : `“${f.raw}” doesn't match anything in your records.`);
  }

  const contact = sellerFacts.filter((r) => CONTACT_TYPES.has(r.type) && !isBuyerAuthored(r));
  const sellerMessages = records.filter((r) => r.type === "message" && r.data?.from === "seller");
  const logEntries = records.filter((r) => r.type === "message_log").flatMap((r) => (Array.isArray(r.data?.messages) ? r.data.messages : []));
  const support = {
    sellerContact: jsonOf(contact),
    refunded: /refund_issued|"refunds":\[[^\]]/.test(JSON.stringify(sellerFacts)),
    returned: /"returns_received":\[[^\]]/.test(JSON.stringify(sellerFacts)),
    phoned: records.some((r) => /^(phone|call)$/i.test(String(r.data?.channel ?? ""))),
    accusation: /\b(police|fraud|scam|criminal|theft|abuse)/.test(jsonOf(sellerFacts.filter((r) => ["note", "prior_order", "message_log"].includes(r.type)))) || records.some((r) => r.type === "prior_order" && r.data?.disputed === true),
    evidence: jsonOf(sellerFacts.filter((r) => EVIDENCE_TYPES.has(r.type) && !isBuyerAuthored(r))),
    buyerWrote: records.some(isBuyerAuthored) || logEntries.some((e) => e?.from === "buyer"),
    delivered: records.some((r) => r.type === "shipment" && r.data?.delivered),
    sellerReplied: (sellerMessages.length > 0 || logEntries.some((e) => e?.from === "seller")) && !records.some((r) => r.data?.seller_replied === false),
  };
  for (const a of ASSERTIONS) if (asserts(a, plain) && !a.supported(support)) errors.push(`The response ${a.msg}.`);

  // The mandate verdict is computed by code; the draft can't contradict it.
  const mandate = checkMandate(records);
  if (mandate && !mandate.within && asserts({ re: MANDATE_OK }, plain)) {
    errors.push(`The response says the purchase was within the buyer's mandate, but the mandate check failed (${mandate.checks.filter((c) => !c.ok).map((c) => c.label.toLowerCase()).join(", ")}).`);
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
