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
    if (type === "message" && data.from != null && data.from !== "buyer" && data.from !== "seller") throw new ImportError(`${id}: a message's "from" must be "buyer" or "seller".`);
    return { id, type, title, data };
  });
  return { records, warnings };
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
    const id = (r[col.id] ?? "").trim();
    if (!id) throw new ImportError(`CSV row ${n + 2} has no id.`);
    const rec = byId.get(id.toUpperCase()) ?? { id, type: r[col.type], title: col.title >= 0 ? r[col.title] : "", data: {} };
    const field = (r[col.field] ?? "").trim();
    if (field) rec.data[field] = csvValue(r[col.value] ?? "");
    byId.set(id.toUpperCase(), rec);
  }
  return [...byId.values()];
}

/** CSV cells are strings; obvious numbers, booleans, nulls and JSON lists/objects are converted. */
function csvValue(s) {
  const t = s.trim();
  // Only short numbers become numbers: tracking numbers, zip codes and ids stay text (precision and leading zeros).
  if (/^-?(0|[1-9]\d{0,11})(\.\d{1,4})?$/.test(t)) return Number(t);
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
