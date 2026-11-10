import "./_env.js";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { parseRecords, ImportError } from "../../server/store/import.js";
import { api } from "../../server/routes.js";
import { upsertDispute, getImportedRecords, latestAnalysis } from "../../server/db.js";
import { recordsFor } from "../../server/records.js";
import { checkDraft } from "../../server/ai/analyze.js";
import { dispute } from "./fixtures.js";

const SAMPLE = [
  { id: "ORD-5001", type: "order", title: "Order", data: { placed: "2026-10-02", items: [{ name: "Canvas tote", qty: 1, price: 14 }] } },
  { id: "SHP-5001", type: "shipment", data: { carrier: "USPS", tracking: "9400111899223857300099", shipped: "2026-10-03", delivered: "2026-10-06" } },
  { id: "MSG-5001", type: "message", data: { from: "buyer", date: "2026-10-06", text: "Arrived, thanks!" } },
];

test("parseRecords accepts a JSON list or { records }, normalises ids and fills default titles", () => {
  const { records } = parseRecords(JSON.stringify(SAMPLE.map((r) => ({ ...r, id: r.id.toLowerCase() }))));
  assert.deepEqual(records.map((r) => r.id), ["ORD-5001", "SHP-5001", "MSG-5001"]);
  assert.equal(records[1].title, "Shipment");
  assert.equal(parseRecords(JSON.stringify({ records: SAMPLE })).records.length, 3);
});

test("parseRecords accepts CSV (one row per field), with quotes, numbers and JSON cells", () => {
  const csv = [
    "id,type,title,field,value",
    'ORD-5001,order,Order,placed,2026-10-02',
    'ORD-5001,order,Order,items,"[{""name"":""Canvas tote"",""qty"":1,""price"":14}]"',
    'SHP-5001,shipment,Shipment,tracking,9400111899223857300099',
    'SHP-5001,shipment,Shipment,delivered,2026-10-06',
    'MSG-5001,message,Buyer message,text,"Arrived, thanks!"',
  ].join("\r\n");
  const { records } = parseRecords(csv);
  assert.equal(records.length, 3);
  assert.equal(records[0].data.items[0].price, 14);
  assert.equal(records[1].data.tracking, "9400111899223857300099", "long digit strings stay exact text");
  assert.equal(records[2].data.text, "Arrived, thanks!");
});

test("parseRecords rejects bad input with a message the seller can act on", () => {
  const bad = [
    ["", /Paste or upload/],
    ["{oops", /valid JSON/],
    [JSON.stringify([{ id: "x", type: "order" }]), /valid id/],
    [JSON.stringify([{ id: "ORD-1", type: "invoice" }]), /isn't supported/],
    [JSON.stringify([{ id: "ORD-1", type: "order" }, { id: "ord-1", type: "order" }]), /used twice/],
    [JSON.stringify([{ id: "MSG-1", type: "message", data: { from: "admin" } }]), /"buyer" or "seller"/],
    [JSON.stringify([{ id: "ORD-1", type: "order", data: { a: { b: { c: { d: 1 } } } } }]), /nested too deeply/],
    [JSON.stringify([{ id: "ORD-1", type: "order", data: { "__proto__x": 1 } }]), /isn't allowed/],
    ["a".repeat(70_000), /limit/],
    ["name,value\nx,1", /header row/],
  ];
  for (const [text, re] of bad) assert.throws(() => parseRecords(text), (e) => e instanceof ImportError && re.test(e.message), String(text).slice(0, 40));
});

test("photos can't be imported from outside the store folder", () => {
  const { records, warnings } = parseRecords(JSON.stringify([{ id: "LST-1", type: "listing", data: { images: ["https://evil.example/x.png", "/store/vase-listing.png"], attachment: "../../etc/passwd" } }]));
  assert.deepEqual(records[0].data.images, ["/store/vase-listing.png"]);
  assert.equal(records[0].data.attachment, undefined);
  assert.equal(warnings.length, 2);
});

let server, base;
before(async () => {
  const app = express();
  app.use("/api", api);
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => server.close());

const login = async () => {
  const r = await fetch(`${base}/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ passcode: "correct horse" }) });
  return r.headers.get("set-cookie").split(";")[0];
};
const importFor = (id, text, cookie) => fetch(`${base}/disputes/${id}/records`, { method: "POST", headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify({ text }) });

test("import route: needs the passcode, refuses store orders, then stores records and analyses the dispute", async () => {
  const ext = dispute({ id: "PP-EXT-1", amount: "14.00", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED" });
  upsertDispute(ext, { scenario: null, batch: "external" });
  const store = dispute({ id: "PP-STORE-1" });
  upsertDispute(store, { scenario: "nad-wallet", batch: "B1" });

  assert.equal((await importFor("PP-EXT-1", JSON.stringify(SAMPLE))).status, 401);
  const cookie = await login();
  assert.equal((await importFor("PP-STORE-1", JSON.stringify(SAMPLE), cookie)).status, 409);
  const bad = await importFor("PP-EXT-1", "{oops", cookie);
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /valid JSON/);

  const ok = await importFor("PP-EXT-1", JSON.stringify(SAMPLE), cookie);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.dispute.records.length, 3);
  assert.equal(body.dispute.item, "Canvas tote");
  assert.ok(body.dispute.analysis, "analysed right after import");
  assert.equal(getImportedRecords("PP-EXT-1").length, 3);
  assert.equal(recordsFor({ id: "PP-EXT-1", scenario: null }).source, "imported");
  assert.ok(latestAnalysis("PP-EXT-1"));

  // The guard now checks drafts against the imported records.
  const row = { id: "PP-EXT-1", scenario: null, raw: JSON.stringify(ext) };
  assert.equal(checkDraft(row, "Delivered on 2026-10-06 (SHP-5001).", null).ok, true);
  assert.equal(checkDraft(row, "Delivered on 2026-10-09 (SHP-5001).", null).ok, false);
});
