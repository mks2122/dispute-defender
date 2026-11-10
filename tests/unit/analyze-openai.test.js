// The real-provider path, against a fake OpenAI (no key, no network). AI_PROVIDER is forced to openai.
import { blockedFetch } from "./_env.js";
import "./_env-openai.js";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { analyzeDispute, buildInput } from "../../server/ai/analyze.js";
import { mockAnalyze } from "../../server/ai/mock.js";
import { upsertDispute, getDisputeRow, latestAnalysis } from "../../server/db.js";
import { scenarioByKey } from "../../server/store/catalog.js";
import { dispute } from "./fixtures.js";

const sc = scenarioByKey("nad-wallet");
let n = 0;
const freshRow = () => {
  const d = dispute({ id: `PP-O-${++n}`, amount: "110.00", evidences: [{ source: "SUBMITTED_BY_BUYER", evidence_type: "CREATE", notes: sc.buyerNote }] });
  upsertDispute(d, { scenario: sc.key, batch: "B1" });
  return getDisputeRow(d.dispute_id);
};

function fakeOpenAI(reply, seen = []) {
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /^https:\/\/api\.openai\.com\/v1\/chat\/completions$/);
    seen.push(JSON.parse(init.body));
    const r = typeof reply === "function" ? reply(seen.length) : reply;
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  };
  return seen;
}
afterEach(() => { globalThis.fetch = blockedFetch; });

test("valid structured output is stored with provider=openai and usage", async () => {
  const row = freshRow();
  const good = mockAnalyze(buildInput(row));
  const seen = fakeOpenAI({ body: { model: "gpt-5.6-luna", choices: [{ message: { content: JSON.stringify(good) } }], usage: { prompt_tokens: 900, completion_tokens: 300 } } });
  await analyzeDispute(row.id);
  const a = latestAnalysis(row.id);
  assert.equal(a.provider, "openai");
  assert.equal(a.fallback, null);
  assert.deepEqual(JSON.parse(a.usage), { input: 900, output: 300 });
  // Request contract: strict schema, buyer text only in the user message's UNTRUSTED block, images attached when present
  const req = seen[0];
  assert.equal(req.response_format.json_schema.strict, true);
  assert.doesNotMatch(req.messages[0].content, /not real leather/);
  assert.match(req.messages[1].content[0].text, /UNTRUSTED[\s\S]*not real leather/);
});

for (const [name, reply, code] of [
  ["malformed JSON", { body: { choices: [{ message: { content: "{not json" } }] } }, "bad_json"],
  ["schema violation", { body: { choices: [{ message: { content: JSON.stringify({ recommendation: "MAYBE" }) } }] } }, "bad_schema"],
  ["refusal", { body: { choices: [{ message: { refusal: "no" } }] } }, "refusal"],
  ["model not found", { status: 404, body: { error: { code: "model_not_found" } } }, "model_unavailable"],
]) {
  test(`${name} → the mock stands in and the fallback reason is recorded`, async () => {
    const row = freshRow();
    fakeOpenAI(reply);
    await analyzeDispute(row.id);
    const a = latestAnalysis(row.id);
    assert.equal(a.provider, "mock");
    assert.equal(a.fallback, code);
    assert.equal(JSON.parse(a.payload).guard.ok, true);
  });
}

test("a transient 503 is retried once, then succeeds", async () => {
  const row = freshRow();
  const good = mockAnalyze(buildInput(row));
  const seen = fakeOpenAI((i) => (i === 1 ? { status: 503, body: {} } : { body: { choices: [{ message: { content: JSON.stringify(good) } }] } }));
  await analyzeDispute(row.id);
  assert.equal(seen.length, 2);
  assert.equal(latestAnalysis(row.id).provider, "openai");
});

test("a fabricated fact from the model is caught by the guard (never trusted blindly)", async () => {
  const row = freshRow();
  const lying = { ...mockAnalyze(buildInput(row)), draft_notes: "Delivered with tracking 1Z000FAKE0000000000 on 2026-01-01." };
  fakeOpenAI({ body: { choices: [{ message: { content: JSON.stringify(lying) } }] } });
  await analyzeDispute(row.id);
  const p = JSON.parse(latestAnalysis(row.id).payload);
  assert.equal(p.guard.ok, false);
  // Unknown tracking number, unknown date, and that date given as the delivery date.
  assert.equal(p.guard.errors.length, 3);
  assert.ok(p.guard.errors.some((e) => /not the delivery date/.test(e)));
});
