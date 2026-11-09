// Deterministic fact handling shared by the guard, the mock model and the prompt:
// - extract checkable facts (tracking numbers, money, dates, record ids) from free text
// - check buyer statements against seller records
// - detect prompt-injection attempts in untrusted text
// Pure functions, no I/O.

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, "0");

/** Facts that can be verified against records. */
export function extractFacts(text) {
  const t = String(text ?? "");
  const facts = [];
  for (const m of t.matchAll(/\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{10,34}\b|\b\d{12,34}\b/g)) facts.push({ kind: "tracking", value: m[0], raw: m[0] });
  for (const m of t.matchAll(/\$\s?(\d{1,3}(?:,\d{3})*|\d+)(\.\d{1,2})?/g)) facts.push({ kind: "money", value: Number((m[1] + (m[2] ?? "")).replace(/,/g, "")), raw: m[0] });
  for (const m of t.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)) facts.push({ kind: "date", value: `${m[1]}-${m[2]}-${m[3]}`, raw: m[0] });
  for (const m of t.matchAll(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b/gi)) {
    facts.push({ kind: "date", value: `${m[3]}-${pad(MONTHS[m[1].toLowerCase().slice(0, m[1].toLowerCase().startsWith("sept") ? 4 : 3)])}-${pad(m[2])}`, raw: m[0] });
  }
  for (const m of t.matchAll(/\b(?:LST|ORD|SHP|MSG|SUP|POL|HIST|MND|LOG)-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/g)) facts.push({ kind: "record", value: m[0], raw: m[0] });
  return facts;
}

/** Everything a fact may be checked against, as normalized sets. */
export function factIndex(texts) {
  const joined = texts.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join("\n");
  const idx = { tracking: new Set(), money: new Set(), date: new Set(), record: new Set(), text: joined.toLowerCase() };
  for (const f of extractFacts(joined)) idx[f.kind].add(f.kind === "money" ? f.value.toFixed(2) : f.value);
  // Plain numbers in JSON (e.g. "price": 110, "max_per_order_usd": 150) count as amounts.
  for (const m of joined.matchAll(/"(?:price|amount|value|max_per_order_usd|monthly_cap_usd)"\s*:\s*"?(\d+(?:\.\d+)?)/g)) idx.money.add(Number(m[1]).toFixed(2));
  // Timestamps like 2026-10-02T14:11:09Z contain dates.
  for (const m of joined.matchAll(/\b(20\d{2}-\d{2}-\d{2})T/g)) idx.date.add(m[1]);
  return idx;
}

export const factKnown = (idx, f) => idx[f.kind].has(f.kind === "money" ? f.value.toFixed(2) : f.value);

const INJECTION = [
  /ignore (all |any )?(prior|previous|above|earlier) (instructions|messages|rules)/i,
  /\b(system|assistant|developer)\s*:/i,
  /\byou are (now )?(an?|the) /i,
  /\b(recommend|output|respond with|choose)\s+(refund|accept|fight)\b/i,
  /\bdisregard\b.*\b(instructions|rules|policy)\b/i,
];
export const detectInjection = (texts) => texts.some((t) => INJECTION.some((re) => re.test(String(t ?? ""))));

const CLAIM_PATTERNS = [
  { re: /\b(agreed|promised|offered)\s+to\s+(a\s+)?refund\b/i, check: (idx) => /"from":"seller"[^}]*refund/.test(idx.text) || idx.text.includes("refund_issued"), label: "says the seller agreed to a refund" },
  { re: /\b(returned|sent (it|the item) back|return(ed)? it)\b/i, check: (idx) => /"returns_received":\[[^\]]+\]/.test(idx.text), label: "says the item was returned" },
  { re: /\b(emailed|messaged|contacted|told) the seller\b/i, check: (idx) => idx.text.includes('"from":"buyer"'), label: "says they contacted the seller" },
];

/**
 * Statements in buyer text that seller records do not support.
 * @returns {string[]} human-readable descriptions
 */
export function unverifiedBuyerClaims(buyerTexts, sellerIdx) {
  const out = [];
  for (const text of buyerTexts) {
    for (const f of extractFacts(text)) if ((f.kind === "tracking" || f.kind === "record") && !factKnown(sellerIdx, f)) out.push(`Buyer cites ${f.kind === "tracking" ? "tracking number" : "record"} ${f.value}, which is not in your records`);
    for (const c of CLAIM_PATTERNS) if (c.re.test(text) && !c.check(sellerIdx)) out.push(`Buyer ${c.label}; nothing in your records supports this`);
  }
  return [...new Set(out)];
}
