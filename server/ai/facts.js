// Deterministic fact handling shared by the guard, the mock model and the prompt:
// - extract checkable facts (tracking numbers, money, dates, record ids) from free text
// - split seller records into trusted facts vs buyer-authored text
// - check buyer statements against seller records; detect prompt injection
// Pure functions, no I/O.
//
// Known limit (documented in ARCHITECTURE §8): names, quantities, times and relative dates ("3 days late")
// are not machine-checked; the seller reviews every draft before it is sent.

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_RE = "(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?";
const pad = (n) => String(n).padStart(2, "0");
const iso = (y, m, d) => (m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${pad(m)}-${pad(d)}` : null);

/** NFKC + map Arabic-Indic digits, so look-alike characters can't dodge the patterns. */
export function normalizeText(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0));
}

/** Facts that can be verified against records. Values are normalized for comparison. */
export function extractFacts(text) {
  const t = normalizeText(text);
  const up = t.toUpperCase();
  const facts = [];
  const push = (kind, value, raw) => value != null && facts.push({ kind, value, raw });

  // Tracking: contiguous (any case), or grouped with spaces/dashes ("1Z 84X7 E903 1234 5678").
  for (const m of up.matchAll(/\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{10,34}\b|\b\d{12,34}\b/g)) push("tracking", m[0], m[0]);
  // Every group must contain a digit, so ordinary words ("ORDER WAS PLACED") never chain into a "tracking number".
  for (const m of up.matchAll(/\b(?=[A-Z]{0,5}\d)[A-Z0-9]{2,6}(?:[ -](?=[A-Z]{0,5}\d)[A-Z0-9]{2,6}){2,7}\b/g)) {
    const joined = m[0].replace(/[ -]/g, "");
    if (joined.length >= 10 && (joined.match(/\d/g) ?? []).length >= 6 && !/^\d{4}-\d{2}-\d{2}/.test(m[0])) push("tracking", joined, m[0]);
  }
  // Context: anything introduced as a tracking number is one, however short ("tracking: 123456789").
  // Only digit-bearing groups are taken, so following words ("... AND WAS DELIVERED") never join the number.
  for (const m of up.matchAll(/\bTRACKING(?:\s+(?:NUMBER|NO\.?|#|ID|CODE))?\s*[:#]?\s*([A-Z0-9]*\d[A-Z0-9]*(?:[ -][A-Z0-9]*\d[A-Z0-9]*){0,7})/g)) {
    const joined = m[1].replace(/[ -]/g, "");
    if (joined.length >= 5) push("tracking", joined, m[1]);
  }
  // Record ids: our known prefixes (any case), or anything shaped like PREFIX-1234[-x] (e.g. an invented "DEL-1004").
  const seen = new Set();
  for (const m of up.matchAll(/\b(?:LST|ORD|SHP|MSG|SUP|POL|HIST|MND|LOG)-[A-Z0-9]+(?:-[A-Z0-9]+)*\b|\b[A-Z]{2,5}-\d{3,}(?:-[A-Z0-9]+)*\b/g)) {
    if (!seen.has(m[0])) { seen.add(m[0]); push("record", m[0], m[0]); }
  }

  // Money: $110, $1,234.50, USD 110, 110 USD, 110 dollars, €/£ amounts.
  const num = (s) => Number(s.replace(/,/g, ""));
  for (const m of t.matchAll(/[$€£]\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?/g)) push("money", num(m[1] + (m[2] ?? "")), m[0]);
  for (const m of t.matchAll(/\b(?:USD|EUR|GBP)\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?\b/gi)) push("money", num(m[1] + (m[2] ?? "")), m[0]);
  for (const m of t.matchAll(/\b(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?\s?(?:USD|EUR|GBP|dollars?|bucks)\b/gi)) push("money", num(m[1] + (m[2] ?? "")), m[0]);
  // Bare amounts: anything with cents ("110.00", "9.99"), or a number after a money word ("total was 110", "fee of 15").
  for (const m of t.matchAll(/(?<![\d$€£.,/-])(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})(?![\d.])/g)) push("money", num(`${m[1]}.${m[2]}`), m[0]);
  for (const m of t.matchAll(/\b(?:total|fee|fees|cost|price|paid|charged|amount|refund)(?:\s+(?:was|is|were|of|came to|totall?ed))?\s*:?\s+(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?\b(?![%/-]|\s?(?:days?|weeks?|months?|years?|items?|cm|mm|kg|g)\b)/gi)) push("money", num(m[1] + (m[2] ?? "")), m[0]);

  // Dates: ISO, 2026/10/25, 10/25/2026 (or 25/10/2026: either reading may match), "Oct 25, 2026", "25 Oct 2026", "Oct. 25th" (no year).
  for (const m of t.matchAll(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/g)) push("date", iso(m[1], +m[2], +m[3]), m[0]);
  for (const m of t.matchAll(/\b(\d{1,2})[/.](\d{1,2})[/.](20\d{2})\b/g)) push("date", [iso(m[3], +m[1], +m[2]), iso(m[3], +m[2], +m[1])].filter(Boolean), m[0]);
  for (const m of t.matchAll(new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d{2}))?\\b`, "gi"))) {
    const mon = MONTHS[m[1].toLowerCase().slice(0, 3)];
    if (m[3]) push("date", iso(m[3], mon, +m[2]), m[0]); else push("monthday", `${pad(mon)}-${pad(+m[2])}`, m[0]);
  }
  for (const m of t.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_RE},?\\s+(20\\d{2})\\b`, "gi"))) push("date", iso(m[3], MONTHS[m[2].toLowerCase().slice(0, 3)], +m[1]), m[0]);
  // Year-less numeric dates ("10/25"): either reading may match a seller date's month and day.
  for (const m of t.matchAll(/(?<![\d/.])(\d{1,2})\/(\d{1,2})(?![\d/])/g)) {
    const a = +m[1], b = +m[2];
    const readings = [a <= 12 && b <= 31 && `${pad(a)}-${pad(b)}`, b <= 12 && a <= 31 && `${pad(b)}-${pad(a)}`].filter(Boolean);
    if (readings.length) push("monthday", readings, m[0]);
  }

  // A numeric date whose two readings are identical collapses to one value; the same fact found by two
  // patterns (e.g. a tracking number matched both bare and after the word "tracking") counts once.
  const unique = new Map();
  for (const f of facts) {
    const g = Array.isArray(f.value) && f.value.length === 1 ? { ...f, value: f.value[0] } : f;
    if (Array.isArray(g.value) && !g.value.length) continue;
    const key = `${g.kind}:${[].concat(g.value).join("|")}`;
    if (!unique.has(key)) unique.set(key, g);
  }
  return [...unique.values()];
}

/** Everything a fact may be checked against, as normalized sets. */
export function factIndex(texts) {
  const joined = texts.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join("\n");
  const idx = { tracking: new Set(), money: new Set(), date: new Set(), monthday: new Set(), record: new Set(), text: joined.toLowerCase() };
  for (const f of extractFacts(joined)) for (const v of [].concat(f.value)) idx[f.kind].add(f.kind === "money" ? v.toFixed(2) : v);
  // Plain numbers in JSON (e.g. "price": 110, "max_per_order_usd": 150) count as amounts.
  for (const m of joined.matchAll(/"(?:price|amount|value|max_per_order_usd|monthly_cap_usd)"\s*:\s*"?(\d+(?:\.\d+)?)/g)) idx.money.add(Number(m[1]).toFixed(2));
  for (const m of joined.matchAll(/\b(20\d{2}-\d{2}-\d{2})T/g)) idx.date.add(m[1]);
  for (const d of idx.date) idx.monthday.add(d.slice(5));
  return idx;
}

export function factKnown(idx, f) {
  return [].concat(f.value).some((v) => idx[f.kind].has(f.kind === "money" ? v.toFixed(2) : v));
}

/**
 * Split records into what the SELLER asserts (trusted facts) and what the BUYER wrote.
 * Buyer messages are logged by the seller's system: their id, date and attachments are trusted metadata,
 * but their text is the buyer's claim and must never verify a fact.
 */
export function splitRecords(records) {
  const sellerFacts = records.map((r) => (r.data?.from === "buyer" ? { ...r, data: { ...r.data, text: undefined } } : r));
  const buyerTexts = records.filter((r) => r.data?.from === "buyer" && r.data.text).map((r) => r.data.text);
  return { sellerFacts, buyerTexts };
}

// Phrasings that address the AI instead of the seller. A heuristic flag for the UI and the audit log only:
// the real defence is structural (buyer text is fenced as UNTRUSTED data in the prompt, and the guard
// rejects any fact that only the buyer asserts), so a missed phrasing can't change what gets sent.
const INJECTION = [
  /\b(ignore|disregard|forget|override)\b.{0,30}\b(instructions?|prompts?|rules|guidelines|messages?|everything|what you (were|have been) told|told (you )?before)\b/i,
  /\b(ignore|disregard)\s+(all|any|the|everything)?\s*(above|previous|prior|earlier)\b/i,
  /\b(system|assistant|developer)\s*:/i,
  /\byou are (now )?(an?|the) /i,
  /\b(recommend|output|respond with|choose|select|return)\s+(a\s+)?(refund|accept|fight)\b/i,
  /\bnew (task|instructions?|role|objective)\b/i,
  /\b(ai|bot|model|assistant|reviewer|grader|llm)\b.{0,40}\b(verdict|recommendation|decision|answer)\b/i,
  /\b(correct|right|required|final) (verdict|answer|decision|recommendation) is\b/i,
];
export const detectInjection = (texts) => texts.some((t) => INJECTION.some((re) => re.test(normalizeText(t))));

const CLAIM_PATTERNS = [
  { re: /\b(agreed|promised|offered)\s+to\s+(a\s+)?refund\b/i, check: (idx) => /"from":"seller"[^}]*refund/.test(idx.text) || idx.text.includes("refund_issued"), label: "says the seller agreed to a refund" },
  { re: /\b(returned|sent (it|the item) back|return(ed)? it)\b/i, check: (idx) => /"returns_received":\[[^\]]+\]/.test(idx.text), label: "says the item was returned" },
  // A logged buyer message (seller-side record of contact) supports "I contacted the seller".
  { re: /\b(emailed|messaged|contacted|told) the seller\b/i, check: (idx) => idx.text.includes('"from":"buyer"'), label: "says they contacted the seller" },
];

/**
 * Statements in buyer text that seller records do not support.
 * @param {string[]} buyerTexts
 * @param {object} sellerIdx factIndex of splitRecords(records).sellerFacts
 */
export function unverifiedBuyerClaims(buyerTexts, sellerIdx) {
  const out = [];
  for (const text of buyerTexts) {
    for (const f of extractFacts(text)) {
      if ((f.kind === "tracking" || f.kind === "record") && !factKnown(sellerIdx, f)) out.push(`Buyer cites ${f.kind === "tracking" ? "tracking number" : "record"} ${f.raw}, which is not in your records`);
    }
    for (const c of CLAIM_PATTERNS) if (c.re.test(normalizeText(text)) && !c.check(sellerIdx)) out.push(`Buyer ${c.label}; nothing in your records supports this`);
  }
  return [...new Set(out)];
}

/** Remove anything that could close our prompt delimiters from untrusted text. */
export const sanitizeUntrusted = (t) => normalizeText(t).replace(/<<<|>>>|BUYER_TEXT/gi, "");
