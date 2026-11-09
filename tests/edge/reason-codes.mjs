// Discover which process-chargeback reason_code values map to which PayPal dispute reasons.
// Usage: node --env-file=.env tests/edge/reason-codes.mjs
// Creates one card order+capture per code, files a chargeback, waits ~60s, then reads each dispute.
// Writes tests/edge/reason-codes-results.json (no secrets).

import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const BASE = "https://api-m.sandbox.paypal.com";
const { PAYPAL_CLIENT_ID: ID, PAYPAL_CLIENT_SECRET: SECRET, PAYPAL_MERCHANT_ID, TEST_CARD_NUMBER = "4111111111111111" } = process.env;
if (!ID || !SECRET) { console.error("Missing PayPal creds in .env"); process.exit(1); }

// [reason_code, card_brand, intended meaning]
const CODES = [
  ["1330", "VISA", "control (known NOT_AS_DESCRIBED)"],
  ["4837", "MASTERCARD", "MC no cardholder authorization"],
  ["4855", "MASTERCARD", "MC goods/services not provided"],
  ["4853", "MASTERCARD", "MC cardholder dispute / not as described"],
  ["10.4", "VISA", "Visa fraud card-absent"],
  ["13.1", "VISA", "Visa merchandise not received"],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let token;
async function call(method, path, json) {
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "PayPal-Request-Id": randomUUID() },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const err = (r) => `HTTP ${r.status} ${r.data?.name ?? ""} ${r.data?.message ?? ""} ${JSON.stringify(r.data?.details ?? "").slice(0, 200)}`.trim();

async function main() {
  const tr = await fetch(BASE + "/v1/oauth2/token", {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(`${ID}:${SECRET}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  token = (await tr.json()).access_token;
  if (!token) throw new Error("OAuth failed");

  let merchantId = PAYPAL_MERCHANT_ID;
  const rows = [];
  for (const [i, [code, brand, meaning]] of CODES.entries()) {
    const value = (11 + i) + ".00";
    const order = await call("POST", "/v2/checkout/orders", {
      intent: "CAPTURE",
      purchase_units: [{ reference_id: `rc-${code}`, description: `reason code probe ${code}`, amount: { currency_code: "USD", value } }],
      payment_source: { card: { number: TEST_CARD_NUMBER, expiry: "2030-12", name: "RC Probe", security_code: "123" } },
    });
    let captureId = order.data?.purchase_units?.[0]?.payments?.captures?.[0]?.id;
    merchantId ||= order.data?.purchase_units?.[0]?.payee?.merchant_id;
    if (!captureId && order.data?.id) {
      const cap = await call("POST", `/v2/checkout/orders/${order.data.id}/capture`, {});
      captureId = cap.data?.purchase_units?.[0]?.payments?.captures?.[0]?.id;
    }
    if (!captureId) { rows.push({ code, brand, meaning, error: "capture: " + err(order) }); continue; }

    const now = new Date();
    const cb = await call("POST", "/v2/customer-support/process-chargeback", {
      adjacency: "PAYPAL", file_layout: "ATCK_CB", merchant_id: merchantId,
      financial_institution: { processor: "FDMS" },
      transaction: { id_enc: captureId, amount: { currency_code: "USD", value } },
      instrument: { instrument_type: "CARD", card_brand: brand, credit_card_transaction_id: String(Date.now()), external: false },
      dispute: {
        id: null, stage: "CHARGEBACK", status: "2",
        response_date: new Date(now.getTime() + 10 * 864e5).toISOString(), receive_date: now.toISOString(), money_movement_date: now.toISOString(),
        amount: { currency_code: "USD", value },
        event_code: "CHARGEBACK_INITIATED", event_type: "DEBIT", chargeback_type: "REPORTED_TO_PROCESSOR",
        processor_info: { reference_number: String(Date.now()) + "0000000000", reason_code: code, notes: `RC-PROBE ${code}` },
      },
    });
    const disputeId = cb.data?.dispute_id;
    rows.push({ code, brand, meaning, captureId, value, disputeId, error: disputeId ? undefined : "chargeback: " + err(cb) });
    console.log(`${code}: ${disputeId ? "dispute " + disputeId : rows.at(-1).error}`);
  }

  console.log("Waiting 70s for disputes to materialise...");
  await sleep(70000);
  for (const r of rows.filter((r) => r.disputeId)) {
    let d;
    for (let i = 0; i < 4; i++) {
      d = await call("GET", `/v1/customer/disputes/${r.disputeId}`);
      if (d.status === 200) break;
      await sleep(15000);
    }
    if (d.status !== 200) { r.error = "get: " + err(d); continue; }
    Object.assign(r, {
      reason: d.data.reason, status: d.data.status, stage: d.data.dispute_life_cycle_stage,
      channel: d.data.dispute_channel, amount: d.data.dispute_amount?.value, due: d.data.seller_response_due_date,
      actions: (d.data.links ?? []).map((l) => l.rel).join(","),
    });
  }
  console.table(rows.map(({ code, brand, reason, status, stage, error }) => ({ code, brand, reason, status, stage, error })));
  writeFileSync(new URL("./reason-codes-results.json", import.meta.url), JSON.stringify({ at: new Date().toISOString(), rows }, null, 2));
}

main().catch((e) => { console.error(e.message); process.exit(1); });
