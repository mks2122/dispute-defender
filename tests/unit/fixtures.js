// Dispute JSON shaped like real sandbox responses (see scripts/probe-results.json).
let seq = 0;
const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();

export function dispute({ id, status = "WAITING_FOR_SELLER_RESPONSE", reason = "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED", amount = "110.00", ageMin = 10, links, evidences, outcome } = {}) {
  const dispute_id = id ?? `PP-T-${String(++seq).padStart(4, "0")}`;
  const rels = links ?? (status === "WAITING_FOR_SELLER_RESPONSE" ? ["self", "accept_claim", "provide_evidence"] : ["self", "provide_supporting_info"]);
  return {
    dispute_id,
    create_time: minutesAgo(ageMin),
    update_time: minutesAgo(0),
    status,
    reason,
    dispute_amount: { currency_code: "USD", value: amount },
    dispute_life_cycle_stage: "CHARGEBACK",
    seller_response_due_date: status === "WAITING_FOR_SELLER_RESPONSE" ? "2026-11-20T04:59:59.000Z" : undefined,
    disputed_transactions: [{ seller_transaction_id: `CAP-${dispute_id}`, buyer: { name: "Test Buyer" } }],
    evidences: evidences ?? [{ evidence_type: "CREATE", source: "SUBMITTED_BY_BUYER", notes: "Not as pictured.", date: minutesAgo(ageMin) }],
    ...(outcome ? { dispute_outcome: { outcome_code: outcome } } : {}),
    links: rels.map((rel) => ({ rel, href: `https://api-m.sandbox.paypal.com/v1/customer/disputes/${dispute_id}/${rel}`, method: rel === "self" ? "GET" : "POST" })),
  };
}
