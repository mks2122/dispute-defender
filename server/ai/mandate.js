// Deterministic check of an AI-agent purchase against the buyer-signed purchase mandate.
// Facts here are computed by code (not the model), fed to the model as TRUSTED, and shown in the UI.
// Records may be seller-imported, so every field is optional: a missing field fails its check, never throws.

const usd = (n) => (Number.isFinite(Number(n)) ? `$${Number(n).toFixed(2).replace(/\.00$/, "")}` : "unknown");
const list = (v) => (Array.isArray(v) ? v.map(String) : []);
const time = (v) => { const t = Date.parse(String(v ?? "")); return Number.isFinite(t) ? t : null; };
const day = (v) => (typeof v === "string" && v ? v.slice(0, 10) : "unknown");

/**
 * @param {{id:string,type:string,data:object}[]} records seller records for the dispute
 * @returns {null | {applies:true, within:boolean, agent:string, checks:{label:string, ok:boolean, detail:string, source_ids:string[]}[]}}
 */
export function checkMandate(records) {
  const order = records.find((r) => r.type === "order" && r.data?.placed_by_agent);
  if (!order) return null;
  const placedBy = String(order.data.placed_by_agent);
  const agentId = /agt_[a-z0-9]+/i.exec(placedBy)?.[0] ?? null;
  const mandate = records.find((r) => r.type === "agent_mandate" && (!agentId || r.data?.agent_id === agentId));
  const ids = [order.id, mandate?.id].filter(Boolean);
  if (!mandate) {
    return { applies: true, within: false, agent: placedBy, checks: [{ label: "Signed mandate on file", ok: false, detail: "No purchase mandate found for this agent.", source_ids: [order.id] }] };
  }
  const m = mandate.data ?? {};
  const items = Array.isArray(order.data.items) ? order.data.items : [];
  const total = items.reduce((s, i) => s + Number(i?.price ?? NaN) * Number(i?.qty ?? 1), 0);
  const categories = [...new Set(items.map((i) => i?.category).filter(Boolean).map(String))];
  const allowed = list(m.allowed_categories);
  const placed = time(order.data.placed), from = time(m.valid_from), until = time(m.valid_until), consent = time(m.consent_at);
  const cap = Number(m.max_per_order_usd);
  const checks = [
    { label: "Agent matches mandate", ok: !!agentId && m.agent_id === agentId, detail: `${placedBy} vs mandate agent ${m.agent_id ?? "unknown"}`, source_ids: ids },
    { label: "Category allowed", ok: categories.length > 0 && categories.every((c) => allowed.includes(c)), detail: `${categories.join(", ") || "unknown"} (allowed: ${allowed.join(", ") || "none listed"})`, source_ids: ids },
    { label: "Within per-order limit", ok: items.length > 0 && Number.isFinite(total) && Number.isFinite(cap) && total <= cap, detail: `${usd(total)} vs limit ${usd(cap)}`, source_ids: ids },
    { label: "Mandate valid on purchase date", ok: placed != null && from != null && until != null && placed >= from && placed <= until, detail: `${day(order.data.placed)} within ${day(m.valid_from)} to ${day(m.valid_until)}`, source_ids: ids },
    { label: "Buyer consented before purchase", ok: consent != null && placed != null && consent <= placed, detail: `consent ${day(m.consent_at)}, purchase ${day(order.data.placed)}`, source_ids: [mandate.id] },
  ];
  return { applies: true, within: checks.every((c) => c.ok), agent: placedBy, checks };
}
