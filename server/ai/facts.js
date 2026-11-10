// Deterministic fact handling shared by the guard, the mock model and the prompt:
// - extract checkable facts (tracking numbers, money, dates, record ids) from free text
// - split seller records into trusted facts vs buyer-authored text
// - check buyer statements against seller records; detect prompt injection
// Pure functions, no I/O.
//
// Known limit (documented in ARCHITECTURE §8): names, quantities, times and relative dates ("3 days late")
// are not machine-checked; the seller reviews every draft before it is sent.

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_RE = "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?";
const pad = (n) => String(n).padStart(2, "0");
const iso = (y, m, d) => (m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${pad(m)}-${pad(d)}` : null);

// Cyrillic and Greek letters that look like Latin ones ("rеfunded" with a Cyrillic е).
const HOMOGLYPHS = {
  "а": "a", "в": "b", "е": "e", "ё": "e", "к": "k", "м": "m", "н": "h", "о": "o", "р": "p", "с": "c", "т": "t", "у": "y", "х": "x", "ѕ": "s", "і": "i", "ї": "i", "ј": "j", "ԁ": "d", "ӏ": "l", "ԛ": "q", "ԝ": "w", "ү": "y", "һ": "h",
  "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H", "О": "O", "Р": "P", "С": "C", "Т": "T", "У": "Y", "Х": "X", "Ѕ": "S", "І": "I", "Ј": "J",
  "α": "a", "ε": "e", "ι": "i", "κ": "k", "ν": "v", "ο": "o", "ρ": "p", "τ": "t", "υ": "u", "χ": "x",
  "Α": "A", "Β": "B", "Ε": "E", "Ζ": "Z", "Η": "H", "Ι": "I", "Κ": "K", "Μ": "M", "Ν": "N", "Ο": "O", "Ρ": "P", "Τ": "T", "Υ": "Y", "Χ": "X",
};
const HOMOGLYPH_RE = new RegExp(`[${Object.keys(HOMOGLYPHS).join("")}]`, "g");

/**
 * NFKC, invisible characters removed, look-alike letters and Arabic-Indic digits mapped to ASCII, and every
 * dash/quote variant mapped to ASCII, so look-alikes can't dodge the patterns.
 */
export function normalizeText(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .replace(/[\p{Cf}\u034F\u115F\u1160\u3164\uFFA0]/gu, "")
    .replace(HOMOGLYPH_RE, (c) => HOMOGLYPHS[c])
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0))
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, "-")
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"');
}

const ORDINAL_WORD = "(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth|(?:twenty|thirty)[- ]?(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth))";
const MONTH_NAME = "(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)";
const NUMBER_WORD = "(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)";
const NUM_VALUES = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const NUM_WORD = `(?:${Object.keys(NUM_VALUES).join("|")}|hundred|thousand)`;
/** "two hundred and fifty" → 250; null if it isn't a number. */
export function wordsToNumber(s) {
  let total = 0, cur = 0, any = false;
  for (const w of String(s).toLowerCase().split(/[\s-]+/).filter(Boolean)) {
    if (w === "and" || w === "a" || w === "an") continue;
    if (Object.hasOwn(NUM_VALUES, w)) { cur += NUM_VALUES[w]; any = true; }
    else if (w === "hundred") { cur = (cur || 1) * 100; any = true; }
    else if (w === "thousand") { total += (cur || 1) * 1000; cur = 0; any = true; }
    else return null;
  }
  return any ? total + cur : null;
}
const WORD_NUMBER = `(?:an?\\s+)?${NUM_WORD}(?:[\\s-]+(?:and[\\s-]+)?${NUM_WORD})*`;
// Counts of things that make a case ("3 earlier orders", "fourteen chargebacks"): each must match the records.
const COUNTED = "(chargebacks|disputes|claims|complaints|orders|purchases|refunds|returns|cases|messages|emails|transactions)";
const PHONE = /(?<![\d-])(?:\(\d{3}\)\s?|\d{3}[-. ])\d{3}[-. ]\d{4}(?![\d-])/g;

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
    if (/^\d{3}[-. ]\d{3}[-. ]\d{4}$/.test(m[0])) continue; // a phone number, checked below
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
  // Amounts in words: "two hundred dollars", "fifty bucks".
  for (const m of t.matchAll(new RegExp(`\\b(${WORD_NUMBER})\\s+(?:us\\s+)?(?:dollars?|bucks|usd)\\b`, "gi"))) push("money", wordsToNumber(m[1]), m[0]);
  for (const m of t.matchAll(/\b(?:total|fee|fees|cost|price|paid|charged|amount|refund)(?:\s+(?:was|is|were|of|came to|totall?ed))?\s*:?\s+(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?\b(?![%/-]|\s?(?:days?|weeks?|months?|years?|items?|cm|mm|kg|g)\b)/gi)) push("money", num(m[1] + (m[2] ?? "")), m[0]);

  // Dates: ISO, 2026/10/25, 10/25/2026 (or 25/10/2026: either reading may match), "Oct 25, 2026", "25 Oct 2026", "Oct. 25th" (no year).
  for (const m of t.matchAll(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/g)) push("date", iso(m[1], +m[2], +m[3]), m[0]);
  for (const m of t.matchAll(/\b(\d{1,2})[/.](\d{1,2})[/.](20\d{2})\b/g)) push("date", [iso(m[3], +m[1], +m[2]), iso(m[3], +m[2], +m[1])].filter(Boolean), m[0]);
  for (const m of t.matchAll(new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d{2}))?\\b`, "gi"))) {
    const mon = MONTHS[m[1].toLowerCase().slice(0, 3)];
    if (m[3]) push("date", iso(m[3], mon, +m[2]), m[0]); else push("monthday", `${pad(mon)}-${pad(+m[2])}`, m[0]);
  }
  // "25 Oct 2026", "3 October", "the 3rd of October 2026".
  for (const m of t.matchAll(new RegExp(`\\b(\\d{1,2})(st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}(?:,?\\s+(20\\d{2}))?(?![a-z])`, "gi"))) {
    const mon = MONTHS[m[3].toLowerCase().slice(0, 3)];
    if (m[4]) push("date", iso(m[4], mon, +m[1]), m[0]);
    else if (!(m[3] === "may" && !m[2])) push("monthday", `${pad(mon)}-${pad(+m[1])}`, m[0]); // "3 may be" is not a date
  }
  // Two-digit years: "21.10.26", "10/21/26" (either reading may match).
  for (const m of t.matchAll(/(?<![\d./])(\d{1,2})[/.](\d{1,2})[/.](\d{2})(?!\d|[./]\d)/g)) {
    const y = `20${m[3]}`;
    push("date", [iso(y, +m[1], +m[2]), iso(y, +m[2], +m[1])].filter(Boolean), m[0]);
  }
  // Year-less numeric dates ("10/25"): either reading may match a seller date's month and day.
  for (const m of t.matchAll(/(?<![\d/.])(\d{1,2})\/(\d{1,2})(?![\d/])/g)) {
    const a = +m[1], b = +m[2];
    const readings = [a <= 12 && b <= 31 && `${pad(a)}-${pad(b)}`, b <= 12 && a <= 31 && `${pad(b)}-${pad(a)}`].filter(Boolean);
    if (readings.length) push("monthday", readings, m[0]);
  }

  // IP addresses and phone numbers must be in the records too.
  for (const m of t.matchAll(/(?<![\d.])(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?!\d|\.\d)/g)) push("ip", m[0], m[0]);
  for (const m of t.matchAll(PHONE)) push("phone", m[0].replace(/\D/g, ""), m[0]);
  // Counts: "3 earlier orders", "fourteen chargebacks".
  for (const m of t.matchAll(new RegExp(`\\b(\\d{1,4}|${WORD_NUMBER})\\s+(?:[a-z-]+\\s+){0,2}?${COUNTED}\\b`, "gi"))) {
    const n = /^\d+$/.test(m[1]) ? Number(m[1]) : wordsToNumber(m[1]);
    if (n != null && n !== 1) push("count", n, m[0]);
  }

  // Dates and numbers the patterns can't read are not let through silently: misspelled months
  // ("Ocotber 26, 2026"), dates in words ("the twenty-sixth of October"), numbers spelled out digit by digit.
  for (const m of t.matchAll(/\b([A-Za-z]{3,10})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b/g)) {
    if (!new RegExp(`^${MONTH_RE}$`, "i").test(m[1]) && /^[a-z]+$/i.test(m[1]) && looksLikeMonth(m[1])) push("unreadable", m[0], m[0]);
  }
  for (const m of t.matchAll(new RegExp(`\\b(?:the\\s+)?${ORDINAL_WORD}\\s+(?:of\\s+)?${MONTH_NAME}\\b|\\b${MONTH_NAME}\\s+(?:the\\s+)?${ORDINAL_WORD}\\b`, "gi"))) push("unreadable", m[0], m[0]);
  for (const m of t.matchAll(new RegExp(`\\b${NUMBER_WORD}(?:[\\s,-]+(?:[a-z]\\b[\\s,-]+)?${NUMBER_WORD}){5,}\\b`, "gi"))) push("unreadable", m[0], m[0]);

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

/** A word that is probably a misspelled month: shares its first letter and most letters with one. */
function looksLikeMonth(word) {
  const w = word.toLowerCase();
  const names = ["january", "february", "march", "april", "june", "july", "august", "september", "october", "november", "december"];
  return names.some((n) => n[0] === w[0] && Math.abs(n.length - w.length) <= 2 && [...new Set(w)].filter((c) => n.includes(c)).length >= Math.min(4, new Set(w).size));
}

/** Everything a fact may be checked against, as normalized sets. */
export function factIndex(texts) {
  const joined = texts.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join("\n");
  const idx = { tracking: new Set(), money: new Set(), date: new Set(), monthday: new Set(), record: new Set(), unreadable: new Set(), ip: new Set(), phone: new Set(), count: new Set(), text: joined.toLowerCase() };
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
  const sellerFacts = records.map((r) => (isBuyerAuthored(r) ? { ...r, data: { ...r.data, text: undefined } } : r));
  const buyerTexts = records.filter((r) => isBuyerAuthored(r) && r.data?.text).map((r) => String(r.data.text));
  return { sellerFacts, buyerTexts };
}

/** A message is the buyer's unless the seller's system marks it as the seller's own (safe default). */
export const isBuyerAuthored = (r) => r.data?.from === "buyer" || (r.type === "message" && r.data?.from !== "seller");

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
  /\bnote to (the )?(reviewer|ai|assistant|system|model|bot|agent|grader)\b/i,
  /\b(refund(ing)?|accept(ing)?( the claim)?|fight(ing)?) is the only (reasonable|acceptable|correct|right|possible|fair) (result|outcome|option|answer|choice|decision)\b/i,
  /\bonly (reasonable|acceptable|correct|right|possible) (result|outcome|option|answer|decision) is\b/i,
  /\b(please|kindly)\s+(recommend|choose|select|output|mark|classify|decide)\b/i,
  /\b(if you are|as an?) (an? )?(ai|language model|llm|assistant|bot)\b/i,
  // Common non-English forms (Spanish, Portuguese, French, German).
  /\b(ignora|ignore|ignorez|ignoriere|olvida|oublie|vergiss)\b.{0,40}\b(instrucciones|instruções|instructions|anweisungen|reglas|règles|regeln|anteriores|précédentes|vorherigen)\b/i,
  /\b(recomienda|recomende|recommande|empfiehl)\b.{0,30}\b(reembolso|remboursement|rückerstattung|erstattung)\b/i,
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

/**
 * In a draft, drop injected sentences from buyer quotes ("... IGNORE ALL PRIOR INSTRUCTIONS ...") so the
 * instruction is never forwarded to PayPal. What's left of the quote is still the buyer's own words.
 */
export function stripInjectionFromQuotes(text) {
  return String(text ?? "").replace(/(["“])([^"”]{1,2000})(["”])/g, (whole, open, inner, close) => {
    const sentences = inner.split(/(?<=[.!?;])\s+/);
    const kept = sentences.filter((s) => !INJECTION.some((re) => re.test(normalizeText(s))));
    if (kept.length === sentences.length) return whole;
    return kept.length ? `${open}${kept.join(" ").replace(/[;,]\s*$/, ".")}${close}` : "";
  }).replace(/\s{2,}/g, " ").replace(/\s+([.,;])/g, "$1").trim();
}

/** Remove anything that could close our prompt delimiters from untrusted text. */
export const sanitizeUntrusted = (t) => normalizeText(t).replace(/<<<|>>>|BUYER_TEXT/gi, "");
