// Sandbox feasibility probe for Dispute Defender.
// Runs every PayPal Disputes API step the app depends on and reports PASS/FAIL per step.
// Usage: node --env-file=.env scripts/sandbox-probe.mjs
// Writes full request/response log to scripts/probe-results.json

import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const BASE = "https://api-m.sandbox.paypal.com";
const { PAYPAL_CLIENT_ID: CLIENT_ID, PAYPAL_CLIENT_SECRET: CLIENT_SECRET, TEST_CARD_NUMBER = "4111111111111111" } = process.env;
let MERCHANT_ID = process.env.PAYPAL_MERCHANT_ID || "";
let BUYER_EMAIL = process.env.PAYPAL_BUYER_EMAIL || "";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Missing PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const log = [];
const results = [];
const step = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const skip = (name, why) => {
  results.push({ name, ok: null, detail: why });
  console.log(`SKIP  ${name}  — ${why}`);
};

let token;
async function call(method, path, { json, form, headers = {} } = {}) {
  const h = { Authorization: `Bearer ${token}`, ...headers };
  let body;
  if (json !== undefined) {
    h["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  } else if (form) {
    body = form; // fetch sets multipart boundary
  }
  const res = await fetch(BASE + path, { method, headers: h, body });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  log.push({ method, path, status: res.status, debug_id: res.headers.get("paypal-debug-id"), request: json ?? (form ? "<multipart>" : undefined), response: data });
  return { status: res.status, data };
}
const errMsg = (r) => `HTTP ${r.status} ${r.data?.name ?? ""} ${r.data?.message ?? r.data?.error_description ?? ""} ${JSON.stringify(r.data?.details ?? "").slice(0, 300)}`.trim();
const hasLink = (d, rel) => (d?.links ?? []).some((l) => l.rel === rel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Unsigned buyer assertion, as in PayPal's sandbox docs sample: {"alg":"none"} . {"iss":client_id,"email":buyer}
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const buyerAssertion = () => `${b64u({ alg: "none", typ: "JWT" })}.${b64u({ iss: CLIENT_ID, email: BUYER_EMAIL })}.`;

async function main() {
  // 1. OAuth token + scopes
  const tr = await fetch(BASE + "/v1/oauth2/token", {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const tj = await tr.json();
  if (!tj.access_token) { step("1. OAuth token", false, JSON.stringify(tj)); return; }
  token = tj.access_token;
  const scopes = tj.scope.split(" ").filter((s) => s.includes("dispute"));
  step("1. OAuth token", true, `dispute scopes: ${scopes.map((s) => s.split("/").pop()).join(", ") || "NONE"}`);

  // 2. Transaction to dispute. Preferred: IDs from a buyer "Send money" payment (set in .env).
  let captureId = process.env.SELLER_TXN_ID || "";
  const buyerTxnId = process.env.BUYER_TXN_ID || "";
  if (captureId || buyerTxnId) {
    step("2. Transaction ids from .env", true, `seller=${captureId || "-"} buyer=${buyerTxnId || "-"}`);
  } else {
  const order = await call("POST", "/v2/checkout/orders", {
    headers: { "PayPal-Request-Id": randomUUID() },
    json: {
      intent: "CAPTURE",
      purchase_units: [{ reference_id: "probe", description: "Handmade leather wallet (probe)", amount: { currency_code: "USD", value: "110.00" } }],
      payment_source: { card: { number: TEST_CARD_NUMBER, expiry: "2030-12", name: "Probe Buyer", security_code: "123" } },
    },
  });
  captureId = order.data?.purchase_units?.[0]?.payments?.captures?.[0]?.id;
  MERCHANT_ID ||= order.data?.purchase_units?.[0]?.payee?.merchant_id;
  if (!MERCHANT_ID && order.data?.id) MERCHANT_ID = (await call("GET", `/v2/checkout/orders/${order.data.id}`)).data?.purchase_units?.[0]?.payee?.merchant_id;
  if (!captureId && order.status < 300 && order.data?.id) {
    const cap = await call("POST", `/v2/checkout/orders/${order.data.id}/capture`, { headers: { "PayPal-Request-Id": randomUUID() }, json: {} });
    captureId = cap.data?.purchase_units?.[0]?.payments?.captures?.[0]?.id;
    if (!captureId) log.push({ note: "capture failed", detail: errMsg(cap) });
  }
  step("2. Card order + capture", !!captureId, captureId ? `capture/seller txn id ${captureId}` : errMsg(order));

  // 2b. Fallback: PayPal-wallet order approved by the sandbox buyer in a browser.
  if (!captureId) {
    const wo = await call("POST", "/v2/checkout/orders", {
      headers: { "PayPal-Request-Id": randomUUID() },
      json: {
        intent: "CAPTURE",
        purchase_units: [{ reference_id: "probe", description: "Handmade leather wallet (probe)", amount: { currency_code: "USD", value: "110.00" } }],
        payment_source: { paypal: { experience_context: { return_url: "https://example.com/approved", cancel_url: "https://example.com/cancel", user_action: "PAY_NOW", shipping_preference: "NO_SHIPPING" } } },
      },
    });
    const approve = wo.data?.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
    if (!approve) { step("2b. Wallet order", false, errMsg(wo)); }
    else {
      console.log(`\n>>> APPROVE_URL ${approve}\n>>> Log in as the sandbox PERSONAL account and pay. Waiting up to 10 min...\n`);
      let st;
      for (let i = 0; i < 120; i++) {
        st = (await call("GET", `/v2/checkout/orders/${wo.data.id}`)).data?.status;
        if (st === "APPROVED") break;
        await sleep(5000);
      }
      if (st !== "APPROVED") step("2b. Wallet order approved", false, `status ${st}`);
      else {
        const cap = await call("POST", `/v2/checkout/orders/${wo.data.id}/capture`, { headers: { "PayPal-Request-Id": randomUUID() }, json: {} });
        const pu = cap.data?.purchase_units?.[0];
        captureId = pu?.payments?.captures?.[0]?.id;
        MERCHANT_ID ||= pu?.payee?.merchant_id;
        BUYER_EMAIL ||= cap.data?.payer?.email_address;
        step("2b. Wallet order + capture", !!captureId, captureId ? `txn ${captureId}, merchant ${MERCHANT_ID}, buyer ${BUYER_EMAIL}` : errMsg(cap));
      }
    }
  }
  } // end: no txn ids in .env

  // 3a. Chargeback via process-chargeback (merchant token only)
  let cbDisputeId;
  if (!captureId) skip("3a. process-chargeback", "no capture id");
  else if (!MERCHANT_ID) skip("3a. process-chargeback", "PAYPAL_MERCHANT_ID not set");
  else {
    const now = new Date();
    const due = new Date(now.getTime() + 10 * 864e5);
    const cb = await call("POST", "/v2/customer-support/process-chargeback", {
      json: {
        adjacency: "PAYPAL", file_layout: "ATCK_CB", merchant_id: MERCHANT_ID,
        financial_institution: { processor: "FDMS" },
        transaction: { id_enc: captureId, amount: { currency_code: "USD", value: "110.00" } },
        instrument: { instrument_type: "CARD", card_brand: "VISA", credit_card_transaction_id: String(Date.now()), external: false },
        dispute: {
          id: null, stage: "CHARGEBACK", status: "2",
          response_date: due.toISOString(), receive_date: now.toISOString(), money_movement_date: now.toISOString(),
          amount: { currency_code: "USD", value: "110.00" },
          event_code: "CHARGEBACK_INITIATED", event_type: "DEBIT", chargeback_type: "REPORTED_TO_PROCESSOR",
          processor_info: { reference_number: String(Date.now()) + "0000000000", reason_code: "1330", notes: "PROBE" },
        },
      },
    });
    cbDisputeId = cb.data?.dispute_id;
    step("3a. process-chargeback", !!cbDisputeId, cbDisputeId ?? errMsg(cb));
  }

  // 3b. Buyer-side SNAD dispute via create-dispute + unsigned assertion
  let snadId;
  if (!BUYER_EMAIL) skip("3b. create SNAD dispute (buyer assertion)", "PAYPAL_BUYER_EMAIL not set");
  else if (!(buyerTxnId || captureId)) skip("3b. create SNAD dispute (buyer assertion)", "no transaction id");
  else {
    const fd = new FormData();
    fd.append("input", new Blob([JSON.stringify({
      disputed_transactions: [{ buyer_transaction_id: buyerTxnId || captureId }],
      reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
      dispute_amount: { currency_code: "USD", value: "110.00" },
      extensions: { merchant_contacted: true, merchandize_dispute_properties: { issue_type: "PRODUCT" } },
    })], { type: "application/json" }));
    const cd = await call("POST", "/v1/customer/disputes", { form: fd, headers: { "PayPal-Auth-Assertion": buyerAssertion() } });
    const self = cd.data?.links?.find((l) => l.rel === "self")?.href;
    snadId = self?.split("/").pop();
    step("3b. create SNAD dispute (buyer assertion)", !!snadId, snadId ?? errMsg(cd) + " (card guest txn may not belong to buyer — retry with a buyer-account txn id)");
  }

  // 4. List disputes (the core read path, independent of seeding)
  const list = await call("GET", "/v1/customer/disputes?page_size=50");
  const items = list.data?.items ?? [];
  step("4. List disputes", list.status === 200, `${items.length} dispute(s): ${items.slice(0, 5).map((d) => `${d.dispute_id}[${d.reason}/${d.status}]`).join(", ")}`);

  const target = cbDisputeId || snadId || items.find((d) => !String(d.status).startsWith("RESOLVED"))?.dispute_id;
  if (!target) { skip("5-8. lifecycle", "no dispute to operate on"); return; }

  // 5. Dispute detail (may lag a few minutes after creation)
  let det;
  for (let i = 0; i < 6; i++) {
    det = await call("GET", `/v1/customer/disputes/${target}`);
    if (det.status === 200) break;
    await sleep(10000);
  }
  const d = det.data;
  step("5. Get dispute detail", det.status === 200,
    det.status === 200 ? `${target} reason=${d.reason} status=${d.status} stage=${d.dispute_life_cycle_stage} due=${d.seller_response_due_date ?? "-"} actions=[${(d.links ?? []).map((l) => l.rel).join(",")}]` : errMsg(det));

  // 6. require-evidence (sandbox-only) to put it in WAITING_FOR_SELLER_RESPONSE
  if (hasLink(d, "require_evidence") || hasLink(d, "require-evidence")) {
    const re = await call("POST", `/v1/customer/disputes/${target}/require-evidence`, { json: { action: "SELLER_EVIDENCE" } });
    step("6. require-evidence (sandbox)", re.status < 300, re.status < 300 ? "→ WAITING_FOR_SELLER_RESPONSE" : errMsg(re));
    await sleep(5000);
  } else skip("6. require-evidence (sandbox)", `no link in status ${d.status}`);

  // 7. provide-evidence with a tracking number + PDF file
  const d2 = (await call("GET", `/v1/customer/disputes/${target}`)).data;
  if (hasLink(d2, "provide_evidence") || hasLink(d2, "provide-evidence")) {
    const pdf = "%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF";
    const fd = new FormData();
    fd.append("input", new Blob([JSON.stringify({
      evidences: [{
        evidence_type: "PROOF_OF_FULFILLMENT",
        evidence_info: { tracking_info: [{ carrier_name: "UPS", tracking_number: "1Z999AA10123456784" }] },
        notes: "Delivered and signed for. Listing photos match item shipped. (probe)",
      }],
    })], { type: "application/json" }));
    fd.append("evidence-file", new Blob([pdf], { type: "application/pdf" }), "delivery-proof.pdf");
    const pe = await call("POST", `/v1/customer/disputes/${target}/provide-evidence`, { form: fd });
    step("7. provide-evidence (tracking + file)", pe.status < 300, pe.status < 300 ? "evidence accepted" : errMsg(pe));
    await sleep(5000);
  } else skip("7. provide-evidence", `no link in status ${d2?.status}; actions=[${(d2?.links ?? []).map((l) => l.rel).join(",")}]`);

  // 8. adjudicate (sandbox-only) → RESOLVED_SELLER_FAVOR, the "we won" demo moment
  const d3 = (await call("GET", `/v1/customer/disputes/${target}`)).data;
  if (hasLink(d3, "adjudicate")) {
    const adj = await call("POST", `/v1/customer/disputes/${target}/adjudicate`, { json: { adjudication_outcome: "SELLER_FAVOR" } });
    step("8. adjudicate SELLER_FAVOR (sandbox)", adj.status < 300, adj.status < 300 ? "→ RESOLVED_SELLER_FAVOR" : errMsg(adj));
  } else skip("8. adjudicate (sandbox)", `no link in status ${d3?.status} (needs UNDER_REVIEW)`);
}

main()
  .catch((e) => step("unexpected error", false, e.stack))
  .finally(() => {
    writeFileSync(new URL("./probe-results.json", import.meta.url), JSON.stringify({ at: new Date().toISOString(), results, log }, null, 2));
    console.log("\nFull log: scripts/probe-results.json");
  });
