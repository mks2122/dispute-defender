import "./_env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { isAuthed, login, loginLimiter, requireAuth } from "../../server/auth.js";

const sign = (v) => createHmac("sha256", process.env.SESSION_SECRET).update(v).digest("hex");
const req = (cookie, extra = {}) => ({ headers: cookie ? { cookie } : {}, ip: "1.2.3.4", ...extra });
function res() {
  const r = { statusCode: 200, headers: {}, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  return r;
}

test("valid signed cookie is accepted", () => {
  const exp = String(Date.now() + 60_000);
  assert.equal(isAuthed(req(`dd_session=${exp}.${sign(exp)}`)), true);
});

test("tampered, expired, malformed or extra-segment cookies are rejected", () => {
  const exp = String(Date.now() + 60_000);
  const past = String(Date.now() - 1);
  const good = sign(exp);
  for (const c of [
    `dd_session=${exp}.${good.slice(0, -1)}${good.endsWith("0") ? "1" : "0"}`, // flipped signature (always a different last character)
    `dd_session=${Number(exp) + 1}.${good}`, // bumped expiry
    `dd_session=${past}.${sign(past)}`, // expired but validly signed
    `dd_session=${exp}.${good}.extra`, // extra segment
    "dd_session=%E0%A4%A", // malformed escape must not throw
    "dd_session=", "other=1", "",
  ]) assert.equal(isAuthed(req(c)), false, c);
});

test("login: wrong or non-string passcodes are 401; correct one sets a hardened cookie", () => {
  for (const passcode of ["nope", 123, null, ["correct horse"], { a: 1 }]) {
    const r = res();
    login({ body: { passcode } }, r);
    assert.equal(r.statusCode, 401, String(passcode));
    assert.equal(r.headers["set-cookie"], undefined);
  }
  const r = res();
  login({ body: { passcode: "correct horse" } }, r);
  assert.equal(r.statusCode, 200);
  assert.match(r.headers["set-cookie"], /^dd_session=\d+\.[a-f0-9]{64}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=43200/);
});

test("requireAuth blocks without a session", () => {
  const r = res();
  let nextCalled = false;
  requireAuth(req(""), r, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(r.statusCode, 401);
  assert.equal(r.body.needsPasscode, true);
});

test("loginLimiter allows 10 attempts per IP per window, then 429", () => {
  const ip = "9.9.9.9";
  let passed = 0;
  for (let i = 0; i < 12; i++) {
    const r = res();
    loginLimiter(req("", { ip }), r, () => passed++);
    if (i >= 10) assert.equal(r.statusCode, 429);
  }
  assert.equal(passed, 10);
});
