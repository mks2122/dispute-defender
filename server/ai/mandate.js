// Deterministic check of an AI-agent purchase against the buyer-signed purchase mandate.
// Facts here are computed by code (not the model), fed to the model as TRUSTED, and shown in the UI.

const usd = (n) => `$${Number(n).toFixed(2).replace(/\.00$/, "")}`;

/**
 * @param {{id:string,type:string,data:object}[]} records seller records for the dispute
 * @returns {null | {applies:true, within:boolean, agent:string, checks:{label:string, ok:boolean, detail:string, source_ids:string[]}[]}}
 */
export function checkMandate(records) {
  const order = records.find((r) => r.type === "order" && r.data?.placed_by_agent);
  if (!order) return null;
  const agentId = /agt_[a-z0-9]+/i.exec(order.data.placed_by_agent)?.[0] ?? null;
  const mandate = records.find((r) => r.type === "agent_mandate" && (!agentId || r.data.agent_id === agentId));
  const ids = [order.id, mandate?.id].filter(Boolean);
  if (!mandate) {
    return { applies: true, within: false, agent: order.data.placed_by_agent, checks: [{ label: "Signed mandate on file", ok: false, detail: "No purchase mandate found for this agent.", source_ids: [order.id] }] };
  }
  const m = mandate.data;
  const total = order.data.items.reduce((s, i) => s + i.price * i.qty, 0);
  const categories = [...new Set(order.data.items.map((i) => i.category).filter(Boolean))];
  const placed = new Date(order.data.placed);
  const checks = [
    { label: "Agent matches mandate", ok: m.agent_id === agentId, detail: `${order.data.placed_by_agent} vs mandate agent ${m.agent_id}`, source_ids: ids },
    { label: "Category allowed", ok: categories.length > 0 && categories.every((c) => m.allowed_categories.includes(c)), detail: `${categories.join(", ") || "unknown"} (allowed: ${m.allowed_categories.join(", ")})`, source_ids: ids },
    { label: "Within per-order limit", ok: total <= m.max_per_order_usd, detail: `${usd(total)} vs limit ${usd(m.max_per_order_usd)}`, source_ids: ids },
    { label: "Mandate valid on purchase date", ok: placed >= new Date(m.valid_from) && placed <= new Date(m.valid_until), detail: `${order.data.placed} within ${m.valid_from} to ${m.valid_until}`, source_ids: ids },
    { label: "Buyer consented before purchase", ok: new Date(m.consent_at) <= placed, detail: `consent ${m.consent_at.slice(0, 10)}, purchase ${order.data.placed}`, source_ids: [mandate.id] },
  ];
  return { applies: true, within: checks.every((c) => c.ok), agent: order.data.placed_by_agent, checks };
}
