// Demo passcode → signed session cookie. Guards every write route (reset, submit, refund).
import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

const COOKIE = "dd_session";
const TTL_MS = 12 * 60 * 60 * 1000;
const sign = (v) => createHmac("sha256", config.sessionSecret).update(v).digest("hex");
const sha = (v) => createHash("sha256").update(String(v)).digest();

function readCookie(req) {
  const raw = req.headers.cookie ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k !== COOKIE) continue;
    try { return decodeURIComponent(v.join("=")); } catch { return null; } // malformed escape → unauthenticated, not a 500
  }
  return null;
}

export function isAuthed(req) {
  const c = readCookie(req);
  if (!c) return false;
  const parts = c.split(".");
  if (parts.length !== 2) return false;
  const [exp, sig] = parts;
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  const expected = sign(exp);
  return sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

// Brute-force guard on the passcode: 10 attempts per IP per 15 minutes, and 100 in total across all clients
// (so rotating IPs can't make unlimited guesses). req.ip honours X-Forwarded-For only behind a known proxy.
const WINDOW_MS = 15 * 60_000;
const PER_IP = 10;
const GLOBAL = 100;
const MAX_KEYS = 5000;
const attempts = new Map();
let all = [];
export function loginLimiter(req, res, next) {
  const key = req.ip ?? "unknown";
  const now = Date.now();
  all = all.filter((t) => now - t < WINDOW_MS);
  const recent = (attempts.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= PER_IP || all.length >= GLOBAL) return res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." });
  recent.push(now);
  all.push(now);
  attempts.delete(key);
  attempts.set(key, recent); // re-inserted: Map order is oldest-first
  // Bound memory by dropping expired entries, then the oldest ones; never reset everyone's counters.
  if (attempts.size > MAX_KEYS) {
    for (const [k, ts] of attempts) if (!ts.some((t) => now - t < WINDOW_MS)) attempts.delete(k);
    for (const k of attempts.keys()) { if (attempts.size <= MAX_KEYS) break; attempts.delete(k); }
  }
  next();
}
export const __resetLimiter = () => { attempts.clear(); all = []; };

export function login(req, res) {
  const pass = req.body?.passcode;
  if (!config.demoPasscode) return res.status(503).json({ error: "Write actions are disabled on this deployment." });
  if (typeof pass !== "string" || !timingSafeEqual(sha(pass), sha(config.demoPasscode))) {
    return res.status(401).json({ error: "Wrong passcode." });
  }
  const exp = String(Date.now() + TTL_MS);
  res.setHeader("Set-Cookie", `${COOKIE}=${exp}.${sign(exp)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL_MS / 1000}${config.isProd ? "; Secure" : ""}`);
  res.json({ ok: true });
}

export function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: "Passcode required.", needsPasscode: true });
}

/** Reads: open on the public demo, passcode-only when REQUIRE_LOGIN_TO_VIEW is set. */
export function viewAuth(req, res, next) {
  if (!config.privateView) return next();
  return requireAuth(req, res, next);
}
