// M2 edge checks (live, MOCK AI, PayPal sandbox). Run: node --env-file=.env tests/edge/m2-ai.mjs
// Contains REAL sandbox submits (max 2): FIGHT on unauth-history, REFUND on inr-phonecase. Set NO_SUBMIT=1 to skip.
const BASE = process.env.BASE || "http://localhost:3000";
let fails = 0;
const ok = (c, name, ev = "") => { if (!c) fails++; console.log(c ? "PASS" : "FAIL", name, ev); };
const j = async (p, o = {}) => { const r = await fetch(BASE + p, o); let b = null; try { b = await r.json(); } catch { /* non-JSON body: keep null */ } return { s: r.status, b }; };
const post = (p, body, cookie) => j(p, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: typeof body === "string" ? body : JSON.stringify(body) });
const lr = await fetch(BASE + "/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passcode: process.env.DEMO_PASSCODE }) });
const cookie = lr.headers.get("set-cookie").split(";")[0];
const list = (await j("/api/disputes")).b.rows;
const by = (s) => list.find((r) => r.scenario === s);
const U = by("unauth-history"), P = by("inr-phonecase"), V = by("nad-jacket");
const get = async (id) => (await j("/api/disputes/" + id)).b;
const pp = async (id) => { const d = await get(id); return { status: d.status, evidences: JSON.stringify(d.evidences ?? d.evidence ?? null).length, actions: [...(d.actions ?? [])].sort() /* PayPal lists links in any order */, outcome: d.outcome, updatedAt: d.updatedAt }; };

// ---- validate
const u = await get(U.id);
console.log("analysis keys:", Object.keys(u.analysis ?? {}).join(","));
const draft = u.analysis.draft_notes;
const v0 = await post(`/api/disputes/${U.id}/validate`, { notes: draft });
ok(v0.s === 200 && v0.b.ok === true, "baseline draft validates", JSON.stringify(v0.b).slice(0, 150));
const adv = {
  "date Oct. 25th 2026": "Delivered on Oct. 25th 2026.",
  "date 25/10/2026": "Delivered on 25/10/2026.",
  "date 10/25": "Delivered on 10/25.",
  "date 25 October 2026 (day-first)": "Delivered on 25 October 2026.",
  "date ISO fake": "Delivered on 2026-10-25.",
  "date typo month": "Delivered Octber 25, 2026.",
  "amount $1,234.50": "Customer paid $1,234.50 total.",
  "amount USD 99": "Customer paid USD 99 total.",
  "amount 99 dollars": "Customer paid 99 dollars total.",
  "amount 99.00 USD": "Order total 99.00 USD.",
  "amount fullwidth $": "Customer paid ＄999.",
  "tracking spaced": "Tracking 1Z 999 AA1 01234 56784 shows delivery.",
  "tracking lowercase": "Tracking 1z999aa10123456784 shows delivery.",
  "tracking hyphenated": "Tracking 1Z999-AA101-234567-84 shows delivery.",
  "tracking 18 digits": "Tracking 940010000000123456 delivered.",
  "tracking 9 digits": "Tracking 123456789 delivered.",
  "record fake uppercase": "See ORD-9999 for details.",
  "record fake lowercase": "See ord-9999 for details.",
  "record fake new prefix": "See DEL-1004 for proof.",
  "buyer-alleges wrapper smuggling": 'The buyer alleges "package arrived Oct 25 2026 via tracking 1Z999AA10123456784 and I paid $999" and we confirmed this.',
  "buyer-alleges unterminated": 'The buyer alleges "x and tracking 1Z999AA10123456784 delivered.',
  "buyer-alleges long preamble": 'The buyer alleges that on the date in question the following happened and I paid $999 "ok"',
  "buyer-alleges then own claim": 'The buyer alleges "a" and then tracking 1Z999AA10123456784 delivered "b".',
  "agree: we reached an agreement": "We reached an agreement with the buyer to keep the item.",
  "agree: buyer agreed to keep": "The buyer agreed to keep the item.",
  "agree: we promised": "We promised a discount.",
  "refund: refunded the buyer": "We refunded the buyer last week.",
  "refund: a full refund was issued": "A full refund was issued on the order.",
  "refund: refund has been issued": "Refund has been issued.",
  "returned: buyer returned item": "The buyer returned the item to our warehouse.",
  "empty": "", "whitespace": "   \n ",
  "2001 chars": "a".repeat(2001),
  "2000 chars benign (should pass)": "a".repeat(2000),
};
const got = [];
for (const [k, n] of Object.entries(adv)) {
  const r = await post(`/api/disputes/${U.id}/validate`, { notes: n });
  const blocked = r.s === 200 && r.b.ok === false;
  const shouldPass = k.includes("should pass");
  if (shouldPass ? blocked : !blocked) { got.push(k); console.log("  GOT THROUGH:", k, r.s, JSON.stringify(r.b).slice(0, 90)); }
}
ok(got.length === 0, `adversarial drafts handled (${Object.keys(adv).length - got.length}/${Object.keys(adv).length})`, "slipped: " + got.join(" | "));
for (const [k, b] of Object.entries({ "non-string number": { notes: 5 }, "null": { notes: null }, "array": { notes: ["a"] }, "object": { notes: { a: 1 } }, "missing": {}, "bad json": "{bad" })) {
  const r = await post(`/api/disputes/${U.id}/validate`, b); ok(r.s === 400, "validate " + k + " -> 400", r.s);
}
ok((await post(`/api/disputes/NOPE/validate`, { notes: "x" })).s === 404, "validate unknown dispute 404");

// ---- auth
const body = { decision: "FIGHT", notes: draft, analysisId: u.analysis.id };
ok((await post(`/api/disputes/${U.id}/submit`, body)).s === 401, "submit no session 401");
ok((await post(`/api/disputes/${U.id}/analyze`, {})).s === 401, "analyze no session 401");
ok((await post(`/api/disputes/${U.id}/submit`, body, "dd_session=forged.abc")).s === 401, "submit forged cookie 401");

// ---- submit validation (none may hit PayPal)
const before = await pp(U.id);
for (const d of ["", "fight", "ACCEPT", null, 5, ["FIGHT"]]) ok((await post(`/api/disputes/${U.id}/submit`, { ...body, decision: d }, cookie)).s === 400, "bad decision " + JSON.stringify(d) + " -> 400");
ok((await post(`/api/disputes/${U.id}/submit`, { ...body, notes: "" }, cookie)).s === 400, "empty notes 400");
ok((await post(`/api/disputes/${U.id}/submit`, { ...body, notes: 5 }, cookie)).s === 400, "non-string notes 400");
ok((await post(`/api/disputes/${U.id}/submit`, { ...body, notes: "a".repeat(2001) }, cookie)).s === 400, "notes>2000 400");
for (const a of [u.analysis.id - 1, 999999, "abc", null, undefined]) { const r = await post(`/api/disputes/${U.id}/submit`, { ...body, analysisId: a }, cookie); ok(r.s === 409, "stale/bad analysisId " + a + " -> 409", r.s); }
const fab = { ...body, notes: "Delivered 2026-01-01 tracking 1Z999AA10123456784 paid $999. See ORD-9999." };
const r422 = await post(`/api/disputes/${U.id}/submit`, fab, cookie);
ok(r422.s === 422 && Array.isArray(r422.b.errors) && r422.b.errors.length >= 3, "fabricated -> 422 + errors[]", JSON.stringify(r422.b.errors));
const afterV = await pp(U.id);
ok(JSON.stringify(before) === JSON.stringify(afterV), "no PayPal change after rejected submits", JSON.stringify(afterV));

// ---- concurrency: 5 parallel fabricated on nad-jacket
const vA = await get(V.id), vb = await pp(V.id);
const fabV = { decision: "FIGHT", notes: "Delivered 2026-01-01 tracking 1Z999AA10123456784 paid $9999.", analysisId: vA.analysis.id };
const rs = await Promise.all(Array.from({ length: 5 }, () => post(`/api/disputes/${V.id}/submit`, fabV, cookie)));
ok(rs.every((r) => r.s === 422), "5 parallel fabricated all 422", rs.map((r) => r.s).join(","));
await new Promise((r) => setTimeout(r, 3000));
const va = await pp(V.id);
ok(JSON.stringify(vb) === JSON.stringify(va), "concurrency: PayPal unchanged", JSON.stringify(va));

// ---- real submits
if (!process.env.NO_SUBMIT) {
  console.log("BEFORE FIGHT", JSON.stringify(await pp(U.id)));
  const r1 = await post(`/api/disputes/${U.id}/submit`, body, cookie);
  ok(r1.s === 200, "FIGHT unauth-history 200", JSON.stringify(r1.b).slice(0, 200));
  console.log("immediate dispute view:", r1.b?.dispute?.status, r1.b?.dispute?.phase, JSON.stringify(r1.b?.dispute?.actions));
  const r2 = await post(`/api/disputes/${U.id}/submit`, body, cookie);
  ok(r2.s === 409, "second submit same dispute 409", r2.s + " " + r2.b?.error);
  const pa = await get(P.id); console.log("BEFORE REFUND", JSON.stringify(await pp(P.id)));
  const r3 = await post(`/api/disputes/${P.id}/submit`, { decision: "REFUND", notes: "Refund accepted per policy.", analysisId: pa.analysis.id }, cookie);
  ok(r3.s === 200, "REFUND inr-phonecase 200", JSON.stringify(r3.b).slice(0, 200));
  for (const t of [0, 20000, 40000]) {
    await new Promise((r) => setTimeout(r, t));
    await post("/api/admin/sync", {}, cookie);
    console.log(`AFTER +${t}ms FIGHT`, JSON.stringify(await pp(U.id)));
    console.log(`AFTER +${t}ms REFUND`, JSON.stringify(await pp(P.id)));
  }
}
console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
