// Parses and validates seller records a seller imports for a dispute that isn't in the store catalog.
// Pure: text in, { records, warnings } out, or an ImportError with a message the seller can act on.
// Accepts JSON (an array of records, or { "records": [...] }) or CSV with the columns id,type,title,field,value
// (one row per field; rows that share an id become one record).

export class ImportError extends Error {
  constructor(message) { super(message); this.status = 400; this.expose = true; }
}

const MAX_TEXT = 64_000;
const MAX_RECORDS = 40;
const MAX_KEYS = 30;
const MAX_STRING = 2_000;
const MAX_ARRAY = 50;
const MAX_DEPTH = 3;
const ID = /^[A-Z][A-Z0-9]{1,9}(?:-[A-Z0-9]{1,12}){1,3}$/;
const STORE_IMAGE = /^\/store\/[\w.-]+\.(?:png|jpe?g|webp)$/i;
const IMAGE_FIELDS = new Set(["images", "attachment", "packing_photo"]);

/** Record types the analysis understands, with the title used when none is given. */
export const RECORD_TYPES = {
  order: "Order",
  shipment: "Shipment",
  listing: "Product listing",
  message: "Message",
  message_log: "Message history",
  policy: "Policy",
  supplier_cert: "Supplier certificate",
  prior_order: "Earlier order",
  agent_mandate: "AI-agent purchase mandate",
  note: "Seller note",
};

/** @returns {{records: {id: string, type: string, title: string, data: object}[], warnings: string[]}} */
export function parseRecords(text) {
  if (typeof text !== "string" || !text.trim()) throw new ImportError("Paste or upload your records first.");
  if (text.length > MAX_TEXT) throw new ImportError(`That's ${text.length.toLocaleString()} characters; the limit is ${MAX_TEXT.toLocaleString()}.`);
  const trimmed = text.trim();
  const raw = trimmed.startsWith("[") || trimmed.startsWith("{") ? fromJson(trimmed) : fromCsv(trimmed);
  if (!raw.length) throw new ImportError("No records found.");
  if (raw.length > MAX_RECORDS) throw new ImportError(`That's ${raw.length} records; the limit is ${MAX_RECORDS}.`);

  const warnings = [];
  const seen = new Set();
  const records = raw.map((r, i) => {
    const where = `Record ${i + 1}`;
    if (!isPlainObject(r)) throw new ImportError(`${where} must be an object with id, type, title and data.`);
    const id = String(r.id ?? "").trim().toUpperCase();
    if (!ID.test(id)) throw new ImportError(`${where}: "${String(r.id ?? "").slice(0, 40)}" isn't a valid id. Use something like ORD-1001 or SHP-1001.`);
    if (seen.has(id)) throw new ImportError(`${where}: the id ${id} is used twice.`);
    seen.add(id);
    const type = String(r.type ?? "").trim().toLowerCase();
    if (!Object.hasOwn(RECORD_TYPES, type)) throw new ImportError(`${id}: type "${String(r.type ?? "").slice(0, 30)}" isn't supported. Use one of: ${Object.keys(RECORD_TYPES).join(", ")}.`);
    const title = r.title == null || r.title === "" ? RECORD_TYPES[type] : String(r.title).slice(0, 80);
    if (r.data != null && !isPlainObject(r.data)) throw new ImportError(`${id}: data must be an object.`);
    const data = clean(r.data ?? {}, id, 1, warnings);
    // Who wrote a message decides whether it can verify facts, so it must be stated; other records are the seller's own.
    if (type === "message" && data.from !== "buyer" && data.from !== "seller") throw new ImportError(`${id}: a message needs "from": "buyer" or "seller".`);
    if (type !== "message" && Object.hasOwn(data, "from")) throw new ImportError(`${id}: only message records have "from". Put buyer messages in their own message records.`);
    if (type === "agent_mandate") checkMandateRecord(id, data);
    if (type === "order" && data.placed_by_agent != null) checkAgentOrder(id, data);
    return { id, type, title, data };
  });
  return { records, warnings };
}

const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) && Number.isFinite(Date.parse(v));
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** An AI-agent purchase mandate is checked by code, so every field the check uses must be there and well-formed. */
function checkMandateRecord(id, d) {
  const missing = [];
  if (typeof d.agent_id !== "string" || !d.agent_id) missing.push("agent_id (text)");
  if (!Array.isArray(d.allowed_categories) || !d.allowed_categories.length) missing.push("allowed_categories (a list)");
  if (!isNum(d.max_per_order_usd)) missing.push("max_per_order_usd (a number)");
  for (const k of ["valid_from", "valid_until", "consent_at"]) if (!isDate(d[k])) missing.push(`${k} (YYYY-MM-DD)`);
  if (missing.length) throw new ImportError(`${id}: an agent mandate needs ${missing.join(", ")}.`);
}

function checkAgentOrder(id, d) {
  const items = d.items;
  if (!isDate(d.placed) || !Array.isArray(items) || !items.length || !items.every((i) => i && typeof i === "object" && isNum(i.price) && (i.qty == null || isNum(i.qty)))) {
    throw new ImportError(`${id}: an order placed by an AI agent needs "placed" (YYYY-MM-DD) and "items", each with a numeric "price" (and "qty").`);
  }
}

function clean(obj, id, depth, warnings) {
  const keys = Object.keys(obj);
  if (keys.length > MAX_KEYS) throw new ImportError(`${id}: too many fields (limit ${MAX_KEYS}).`);
  const out = {};
  for (const k of keys) {
    if (!/^[A-Za-z][\w ]{0,39}$/.test(k)) throw new ImportError(`${id}: the field name "${k.slice(0, 40)}" isn't allowed.`);
    if (IMAGE_FIELDS.has(k)) {
      // Photos can't be uploaded here; only images already in the store folder are kept.
      const kept = [].concat(obj[k]).filter((v) => typeof v === "string" && STORE_IMAGE.test(v));
      if (kept.length !== [].concat(obj[k]).filter((v) => v != null).length) warnings.push(`${id}: photos can't be imported, so "${k}" was left out.`);
      if (kept.length) out[k] = Array.isArray(obj[k]) ? kept : kept[0];
      continue;
    }
    out[k] = value(obj[k], id, depth, warnings);
  }
  return out;
}

function value(v, id, depth, warnings) {
  if (v == null || typeof v === "boolean") return v ?? null;
  if (typeof v === "number") { if (!Number.isFinite(v)) throw new ImportError(`${id}: numbers must be finite.`); return v; }
  if (typeof v === "string") { if (v.length > MAX_STRING) throw new ImportError(`${id}: a value is over ${MAX_STRING} characters.`); return v; }
  if (depth >= MAX_DEPTH) throw new ImportError(`${id}: the data is nested too deeply.`);
  if (Array.isArray(v)) { if (v.length > MAX_ARRAY) throw new ImportError(`${id}: a list has more than ${MAX_ARRAY} items.`); return v.map((x) => value(x, id, depth + 1, warnings)); }
  if (isPlainObject(v)) return clean(v, id, depth + 1, warnings);
  throw new ImportError(`${id}: unsupported value.`);
}

const isPlainObject = (v) => v != null && typeof v === "object" && !Array.isArray(v);

function fromJson(text) {
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new ImportError("That isn't valid JSON. Check for a missing comma or quote."); }
  if (Array.isArray(parsed)) return parsed;
  if (isPlainObject(parsed) && Array.isArray(parsed.records)) return parsed.records;
  throw new ImportError('JSON must be a list of records, or { "records": [...] }.');
}

function fromCsv(text) {
  const rows = csvRows(text);
  const header = (rows.shift() ?? []).map((h) => h.trim().toLowerCase());
  const col = Object.fromEntries(["id", "type", "title", "field", "value"].map((c) => [c, header.indexOf(c)]));
  if (col.id < 0 || col.type < 0 || col.field < 0 || col.value < 0) throw new ImportError("CSV needs a header row with the columns id, type, title, field, value.");
  const byId = new Map();
  for (const [n, r] of rows.entries()) {
    if (r.every((c) => !c.trim())) continue;
    const row = n + 2;
    const id = (r[col.id] ?? "").trim();
    if (!id) throw new ImportError(`CSV row ${row} has no id.`);
    const type = (r[col.type] ?? "").trim();
    const rec = byId.get(id.toUpperCase()) ?? { id, type, title: col.title >= 0 ? r[col.title] : "", data: {} };
    if (type && rec.type && type.toLowerCase() !== String(rec.type).toLowerCase()) throw new ImportError(`CSV row ${row}: ${id} was already given the type "${rec.type}".`);
    const field = (r[col.field] ?? "").trim();
    if (field) {
      if (Object.hasOwn(rec.data, field)) throw new ImportError(`CSV row ${row}: ${id} has the field "${field}" twice.`);
      rec.data[field] = csvValue(r[col.value] ?? "", field);
    }
    byId.set(id.toUpperCase(), rec);
  }
  return [...byId.values()];
}

// Identifiers are text even when they're all digits: tracking numbers, zip codes, phone numbers, SKUs.
const TEXT_FIELD = /(tracking|zip|postal|postcode|phone|sku|serial|batch|lot|code|account|card|_id$|^id$|number$)/i;

/** CSV cells are strings; obvious numbers, booleans, nulls and JSON lists/objects are converted. */
function csvValue(s, field = "") {
  const t = s.trim();
  if (TEXT_FIELD.test(field)) return t === "" || t === "null" ? null : t;
  // Only short numbers become numbers: long digit strings stay text (precision and leading zeros).
  if (/^-?(0|[1-9]\d{0,8})(\.\d{1,4})?$/.test(t)) return Number(t);
  if (t === "true" || t === "false") return t === "true";
  if (t === "" || t === "null") return null;
  if (t.startsWith("[") || t.startsWith("{")) { try { return JSON.parse(t); } catch { return t; } }
  return t;
}

/** RFC 4180-style CSV: quoted fields, doubled quotes, commas and newlines inside quotes. */
function csvRows(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (quoted) throw new ImportError("The CSV has an unclosed quote.");
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
