import { test } from "node:test";
import assert from "node:assert/strict";
import { mapLimit } from "../../server/util.js";

test("mapLimit reports every failure explicitly and never throws", async () => {
  const r = await mapLimit([1, 2, 3, 4], 2, async (n) => { if (n % 2 === 0) throw new Error(`bad ${n}`); return n * 10; });
  assert.deepEqual(r.map((x) => x.ok), [true, false, true, false]);
  assert.equal(r[0].value, 10);
  assert.equal(r[1].error.message, "bad 2");
  assert.equal(r[1].item, 2);
});

test("mapLimit respects the concurrency limit", async () => {
  let active = 0, peak = 0;
  await mapLimit(Array.from({ length: 10 }, (_, i) => i), 3, async () => {
    active++; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
  });
  assert.equal(peak, 3);
});

test("mapLimit handles an empty list", async () => {
  assert.deepEqual(await mapLimit([], 4, async () => 1), []);
});
