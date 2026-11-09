import { blockedFetch } from "./_env.js";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ppRequest, PayPalError } from "../../server/paypal/client.js";

// Scripted fake PayPal: the token endpoint always issues a NEW unique token (the client caches tokens across
// tests); API calls return the queued responses in order.
let tokenSeq = 0;
function fakePayPal(responses) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (path === "/v1/oauth2/token") {
      calls.push("token");
      return new Response(JSON.stringify({ access_token: `tok${++tokenSeq}`, expires_in: 32400 }), { status: 200 });
    }
    calls.push(`${init.method} ${path} auth=${init.headers.Authorization}`);
    const next = responses.shift();
    if (!next) throw new Error("no scripted response left");
    if (next.throw) throw next.throw;
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status, headers: next.headers ?? {} });
  };
  return calls;
}
afterEach(() => { globalThis.fetch = blockedFetch; });

test("GET retries on 503 and succeeds", async () => {
  const calls = fakePayPal([{ status: 503 }, { status: 200, body: { ok: 1 } }]);
  assert.deepEqual(await ppRequest("GET", "/v1/x"), { ok: 1 });
  assert.equal(calls.filter((c) => c.startsWith("GET")).length, 2);
});

test("non-idempotent POST is NEVER retried on 5xx (no double dispute actions)", async () => {
  const calls = fakePayPal([{ status: 503, body: { name: "INTERNAL", debug_id: "dbg1" } }, { status: 200 }]);
  await assert.rejects(ppRequest("POST", "/v1/customer/disputes/D1/provide-evidence", { json: {} }), (e) => e instanceof PayPalError && e.status === 503);
  assert.equal(calls.filter((c) => c.startsWith("POST")).length, 1);
});

test("non-idempotent POST is not retried on network error either", async () => {
  const calls = fakePayPal([{ throw: new TypeError("fetch failed") }, { status: 200 }]);
  await assert.rejects(ppRequest("POST", "/v1/customer/disputes/D1/accept-claim", { json: {} }), TypeError);
  assert.equal(calls.filter((c) => c.startsWith("POST")).length, 1);
});

test("idempotent POST (PayPal-Request-Id) may retry", async () => {
  const calls = fakePayPal([{ status: 500 }, { status: 201, body: { id: "O1" } }]);
  assert.deepEqual(await ppRequest("POST", "/v2/checkout/orders", { json: {}, idempotent: true }), { id: "O1" });
  assert.equal(calls.filter((c) => c.startsWith("POST")).length, 2);
});

test("401 refreshes the token once, then succeeds", async () => {
  const calls = fakePayPal([{ status: 401 }, { status: 200, body: { ok: 1 } }]);
  await ppRequest("GET", "/v1/y");
  const api = calls.filter((c) => c.startsWith("GET"));
  assert.notEqual(api[0].split("auth=")[1], api[1].split("auth=")[1], "second attempt must use a new token");
});

test("PayPalError carries status, issue and debug_id but never the response body", async () => {
  fakePayPal([{ status: 422, body: { name: "UNPROCESSABLE_ENTITY", debug_id: "abc123", message: "secret-ish details", details: [{ issue: "ACTION_NOT_ALLOWED", description: "buyer email jane@example.com" }] } }]);
  const err = await ppRequest("POST", "/v1/customer/disputes/D1/accept-claim", { json: {} }).catch((e) => e);
  assert.equal(err.status, 422);
  assert.equal(err.issue, "ACTION_NOT_ALLOWED");
  assert.equal(err.debugId, "abc123");
  assert.doesNotMatch(err.message, /jane@example\.com|secret-ish/);
  assert.equal("data" in err, false);
});
