import { randomBytes } from "node:crypto";
import { log } from "./log.js";

// Treat any Render deploy as production even if NODE_ENV is missing (no default passcode, Secure cookies).
const isProd = process.env.NODE_ENV === "production" || !!process.env.RENDER;
const num = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export const config = {
  isProd,
  port: num("PORT", 3000),
  paypalBase: process.env.PAYPAL_BASE || "https://api-m.sandbox.paypal.com",
  clientId: process.env.PAYPAL_CLIENT_ID || "",
  clientSecret: process.env.PAYPAL_CLIENT_SECRET || "",
  testCard: process.env.TEST_CARD_NUMBER || "4111111111111111",
  // Writes (reset, submit, refund) require this passcode. Dev falls back to "demo"; prod refuses writes without it.
  demoPasscode: process.env.DEMO_PASSCODE || (isProd ? "" : "demo"),
  sessionSecret: process.env.SESSION_SECRET || randomBytes(32).toString("hex"),
  dbPath: process.env.DB_PATH || "data/app.db",
  // Optional durable mirror of the cache (Turso). Without it, history is lost whenever the host wipes the disk.
  tursoUrl: (process.env.TURSO_DATABASE_URL || "").trim(),
  tursoToken: (process.env.TURSO_AUTH_TOKEN || "").trim(),
  syncIntervalMs: num("SYNC_INTERVAL_MS", 30_000),
  poolPerScenario: num("POOL_PER_SCENARIO", 1),
  resetCooldownMs: num("RESET_COOLDOWN_MS", 120_000),
  maxSeedsPerHour: num("MAX_SEEDS_PER_HOUR", 24),
  // AI: "auto" uses OpenAI when a key is set, otherwise the deterministic mock (free, offline, demo-safe).
  openaiKey: process.env.OPENAI_API_KEY || "",
  openaiBase: process.env.OPENAI_BASE || "https://api.openai.com",
  aiModel: process.env.AI_MODEL || "gpt-5.6-luna",
  aiProvider: ["mock", "openai"].includes(process.env.AI_PROVIDER) ? process.env.AI_PROVIDER : "auto",
  // Seller's time to assemble and submit a response, in dollars; used for expected value.
  aiTimeCostUsd: num("AI_TIME_COST_USD", 10),
  // Real sellers: reading disputes (buyer names, addresses) needs the passcode too. The public demo leaves it off.
  privateView: /^(1|true|yes)$/i.test(process.env.REQUIRE_LOGIN_TO_VIEW ?? ""),
  // Only trust X-Forwarded-For behind a known proxy (Render); otherwise any client could pick its own IP.
  trustProxy: process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) || 0 : process.env.RENDER ? 1 : 0,
  // Seconds between AI re-runs of the same dispute (each real-model run costs money).
  analyzeCooldownMs: num("ANALYZE_COOLDOWN_MS", 60_000),
};

/** Which model actually runs: an explicit choice, else OpenAI if a key is configured, else the mock. */
export const aiProviderName = () => (config.aiProvider === "auto" ? (config.openaiKey ? "openai" : "mock") : config.aiProvider);

/** Seeding creates real (sandbox) card sales and chargebacks; it must never run against live PayPal. */
export const isSandbox = () => new URL(config.paypalBase).hostname === "api-m.sandbox.paypal.com";

if (!config.clientId || !config.clientSecret) log.error("config", "PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set. Copy .env.example to .env.");
if (!process.env.DEMO_PASSCODE) log.warn("config", isProd ? "DEMO_PASSCODE not set: all write actions are disabled." : 'DEMO_PASSCODE not set: using "demo" (dev only).');
if (!process.env.SESSION_SECRET && isProd) log.warn("config", "SESSION_SECRET not set: sessions reset on every restart.");
