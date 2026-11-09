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
  syncIntervalMs: num("SYNC_INTERVAL_MS", 30_000),
  poolPerScenario: num("POOL_PER_SCENARIO", 1),
  resetCooldownMs: num("RESET_COOLDOWN_MS", 120_000),
  maxSeedsPerHour: num("MAX_SEEDS_PER_HOUR", 24),
};

/** Seeding creates real (sandbox) card sales and chargebacks; it must never run against live PayPal. */
export const isSandbox = () => new URL(config.paypalBase).hostname === "api-m.sandbox.paypal.com";

if (!config.clientId || !config.clientSecret) log.error("config", "PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set. Copy .env.example to .env.");
if (!process.env.DEMO_PASSCODE) log.warn("config", isProd ? "DEMO_PASSCODE not set: all write actions are disabled." : 'DEMO_PASSCODE not set: using "demo" (dev only).');
if (!process.env.SESSION_SECRET && isProd) log.warn("config", "SESSION_SECRET not set: sessions reset on every restart.");
