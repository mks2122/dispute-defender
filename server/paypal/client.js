// Thin PayPal REST client: token cache, safe retries, and the calls Dispute Defender needs.
// The only module that talks to PayPal (ARCHITECTURE §4).
import { randomUUID } from "node:crypto";
import { config, isSandbox } from "../config.js";
import { log } from "../log.js";

const MAX_RETRY_WAIT_MS = 10_000;

export class PayPalError extends Error {
  constructor(status, data, method, path) {
    const endpoint = `${method} ${path.split("?")[0]}`;
    const issue = data?.details?.[0]?.issue ?? data?.error ?? null;
    // The message is for server logs only; it never contains the response body (may hold personal data).
    super(`PayPal ${status}${issue ? ` ${issue}` : ""} on ${endpoint}`);
    this.name = "PayPalError";
    this.status = status;
    this.issue = issue;
    this.debugId = data?.debug_id ?? null;
    this.endpoint = endpoint;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let tokenCache = null;
let tokenInFlight = null;

async function fetchToken() {
  const res = await fetch(`${config.paypalBase}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new PayPalError(res.status, data, "POST", "/v1/oauth2/token");
  const ttl = Number(data.expires_in) || 3600;
  tokenCache = { token: data.access_token, exp: Date.now() + Math.max(60, ttl - 300) * 1000 };
  return tokenCache.token;
}

/** Cached token; concurrent callers share one in-flight refresh. */
async function getToken(force = false) {
  if (!force && tokenCache && Date.now() < tokenCache.exp) return tokenCache.token;
  tokenInFlight ??= fetchToken().finally(() => { tokenInFlight = null; });
  return tokenInFlight;
}

/**
 * Make a PayPal API call.
 * - Retries 429/5xx/network errors only for GETs or calls marked `idempotent` (never re-sends a dispute action).
 * - Retries once on 401 with a fresh token (the request was rejected before processing).
 * - `form` may be a function returning a fresh FormData, so a retry can rebuild the body.
 */
export async function ppRequest(method, path, { json, form, headers = {}, idempotent = false } = {}) {
  const canRetry = method === "GET" || idempotent;
  let refreshed = false;
  for (let attempt = 0; ; attempt++) {
    const h = { Authorization: `Bearer ${await getToken()}`, Accept: "application/json", ...headers };
    let body;
    if (json !== undefined) {
      h["Content-Type"] = "application/json";
      body = JSON.stringify(json);
    } else if (form) {
      body = typeof form === "function" ? form() : form;
    }
    let res;
    try {
      res = await fetch(config.paypalBase + path, { method, headers: h, body, signal: AbortSignal.timeout(25_000) });
    } catch (err) {
      if (canRetry && attempt < 3) { await sleep(500 * 2 ** attempt); continue; }
      throw err;
    }
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = {}; } // non-JSON body (e.g. HTML error page): treat as empty

    if (res.status === 401 && !refreshed) { refreshed = true; await getToken(true); continue; }
    if ((res.status === 429 || res.status >= 500) && canRetry && attempt < 3) {
      const ra = Number(res.headers.get("retry-after"));
      await sleep(Math.min(ra > 0 ? ra * 1000 : 500 * 2 ** attempt, MAX_RETRY_WAIT_MS));
      continue;
    }
    if (res.status >= 400) throw new PayPalError(res.status, data, method, path);
    return data;
  }
}

// ---------- Disputes ----------
export const getDispute = (id) => ppRequest("GET", `/v1/customer/disputes/${encodeURIComponent(id)}`);

/** All disputes visible to the merchant, following `next` links (page_size max is 50). */
export async function listAllDisputes({ maxPages = 20 } = {}) {
  let path = "/v1/customer/disputes?page_size=50";
  const items = [];
  for (let i = 0; i < maxPages && path; i++) {
    const page = await ppRequest("GET", path);
    items.push(...(page.items ?? []));
    const next = page.links?.find((l) => l.rel === "next")?.href;
    path = next ? new URL(next).pathname + new URL(next).search : null;
  }
  if (path) log.warn("paypal", `dispute list truncated at ${maxPages} pages (${items.length} disputes)`);
  return items;
}

export const linkRels = (dispute) => (dispute?.links ?? []).map((l) => l.rel);

/**
 * Submit seller evidence (multipart: `input` JSON + one `evidence-file`). NEVER retried automatically:
 * a timeout here means "unknown", and the caller reconciles by re-reading the dispute.
 */
export function provideEvidence(id, { evidences, file }) {
  const form = () => {
    const fd = new FormData();
    fd.append("input", new Blob([JSON.stringify({ evidences })], { type: "application/json" }));
    if (file) fd.append("evidence-file", new Blob([file.data], { type: file.type }), file.name);
    return fd;
  };
  return ppRequest("POST", `/v1/customer/disputes/${encodeURIComponent(id)}/provide-evidence`, { form });
}

/** Accept the claim and refund in full (the only accept type PayPal allows on chargebacks). Never retried. */
export const acceptClaim = (id, note) =>
  ppRequest("POST", `/v1/customer/disputes/${encodeURIComponent(id)}/accept-claim`, { json: { note, accept_claim_type: "REFUND" } });

// ---------- Payments ----------
export const getCapture = (id) => ppRequest("GET", `/v2/payments/captures/${encodeURIComponent(id)}`);

function assertSandbox() {
  if (!isSandbox()) throw new Error("Refusing to create sales or chargebacks outside the PayPal sandbox.");
}

/**
 * Create and capture a card-funded order (sandbox seeding only). custom_id carries our scenario key so a
 * dispute can always be traced back to store data, even after the local DB is wiped.
 */
export async function createCardSale({ amount, description, customId, cardName = "Demo Buyer" }) {
  assertSandbox();
  const requestId = randomUUID();
  const order = await ppRequest("POST", "/v2/checkout/orders", {
    idempotent: true,
    headers: { "PayPal-Request-Id": requestId },
    json: {
      intent: "CAPTURE",
      purchase_units: [{ description: description.slice(0, 127), custom_id: customId, amount: { currency_code: "USD", value: amount.toFixed(2) } }],
      payment_source: { card: { number: config.testCard, expiry: "2030-12", name: cardName, security_code: "123" } },
    },
  });
  let unit = order.purchase_units?.[0];
  let capture = unit?.payments?.captures?.[0];
  if (!capture) {
    const cap = await ppRequest("POST", `/v2/checkout/orders/${order.id}/capture`, {
      idempotent: true,
      headers: { "PayPal-Request-Id": `${requestId}-cap` },
      json: {},
    });
    unit = cap.purchase_units?.[0];
    capture = unit?.payments?.captures?.[0];
  }
  if (!capture?.id) throw new Error(`Order ${order.id} produced no capture (status ${order.status})`);
  let merchantId = unit?.payee?.merchant_id;
  if (!merchantId) merchantId = (await ppRequest("GET", `/v2/checkout/orders/${order.id}`)).purchase_units?.[0]?.payee?.merchant_id;
  return { orderId: order.id, captureId: capture.id, merchantId };
}

/** Sandbox-only: simulate the card network filing a chargeback against a capture. */
export async function createChargeback({ merchantId, captureId, amount, reasonCode, cardBrand, notes }) {
  assertSandbox();
  const now = new Date().toISOString();
  const res = await ppRequest("POST", "/v2/customer-support/process-chargeback", {
    json: {
      adjacency: "PAYPAL",
      file_layout: "ATCK_CB",
      merchant_id: merchantId,
      financial_institution: { processor: "FDMS" },
      transaction: { id_enc: captureId, amount: { currency_code: "USD", value: amount.toFixed(2) } },
      instrument: { instrument_type: "CARD", card_brand: cardBrand, credit_card_transaction_id: String(Date.now()), external: false },
      dispute: {
        id: null,
        stage: "CHARGEBACK",
        status: "2",
        response_date: new Date(Date.now() + 10 * 864e5).toISOString(),
        receive_date: now,
        money_movement_date: now,
        amount: { currency_code: "USD", value: amount.toFixed(2) },
        event_code: "CHARGEBACK_INITIATED",
        event_type: "DEBIT",
        chargeback_type: "REPORTED_TO_PROCESSOR",
        processor_info: { reference_number: `${Date.now()}${Math.floor(Math.random() * 1e9)}`.padEnd(23, "0").slice(0, 23), reason_code: reasonCode, notes },
      },
    },
  });
  if (!res.dispute_id) throw new Error("process-chargeback returned no dispute_id");
  return res.dispute_id;
}
