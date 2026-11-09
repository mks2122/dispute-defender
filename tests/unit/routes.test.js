import "./_env.js";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { api } from "../../server/routes.js";
import { upsertDispute } from "../../server/db.js";
import { dispute } from "./fixtures.js";

let server, base;
before(async () => {
  const app = express(); // same mounting as server/index.js: body parsing is inside the api router
  app.use("/api", api);
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}/api`;
  upsertDispute(dispute({ id: "PP-T-RETIRED" }), { scenario: "nad-wallet", batch: "retired" });
});
after(() => server.close());

const get = (p) => fetch(base + p);

test("unknown, retired and malformed dispute ids are 404 with a JSON body", async () => {
  for (const p of ["/disputes/PP-NOPE", "/disputes/PP-T-RETIRED", "/disputes/%E0%A4%A", "/disputes/..%2F..%2Fetc", "/nope"]) {
    const r = await get(p);
    assert.equal(r.status, 404, p);
    assert.ok((await r.json()).error, p);
  }
});

test("write routes require a session", async () => {
  for (const p of ["/admin/reset", "/admin/sync"]) {
    const r = await fetch(base + p, { method: "POST" });
    assert.equal(r.status, 401, p);
    assert.equal((await r.json()).needsPasscode, true);
  }
});

test("malformed JSON is a 400 with a safe message, never a stack trace", async () => {
  const r = await fetch(base + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{bad" });
  assert.equal(r.status, 400);
  const body = await r.text();
  assert.doesNotMatch(body, /at .*\.js:\d+/);
});

test("inbox endpoint has a stable shape even with no active batch", async () => {
  const d = await (await get("/disputes")).json();
  assert.deepEqual(Object.keys(d).sort(), ["batch", "batchAt", "pool", "refilling", "rows", "sync"]);
  assert.deepEqual(d.rows, []);
});
