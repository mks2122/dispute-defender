// Imported first by every unit test: isolated temp DB, fake credentials, no network.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "dd-test-")), "test.db");
process.env.PAYPAL_CLIENT_ID = "test-client";
process.env.PAYPAL_CLIENT_SECRET = "test-secret";
process.env.DEMO_PASSCODE = "correct horse";
process.env.SESSION_SECRET = "unit-test-session-secret";
process.env.NODE_ENV = "test";

// Any accidental external network call fails the test instead of hitting PayPal/OpenAI.
// Loopback is allowed so route tests can call an in-process server; tests may replace fetch with a mock.
const realFetch = globalThis.fetch;
export const blockedFetch = async (url, init) => {
  const host = new URL(String(url)).hostname;
  if (host === "127.0.0.1" || host === "localhost") return realFetch(url, init);
  throw new Error(`Unexpected network call in unit test: ${url}`);
};
globalThis.fetch = blockedFetch;
