// HTTP layer: validate, call one application function, shape the response. No business logic here.
import express, { Router } from "express";
import { config } from "./config.js";
import { getDisputeRow, disputesInBatch, getMeta } from "./db.js";
import { toRow, toCase } from "./view.js";
import { activeBatch, poolSummary, resetDemo } from "./pool.js";
import { isRefilling } from "./paypal/seed.js";
import { syncOnce, syncStatus, hasSyncedOnce } from "./sync.js";
import { isAuthed, login, loginLimiter, requireAuth } from "./auth.js";
import { PayPalError } from "./paypal/client.js";
import { log } from "./log.js";

export const api = Router();
// Body parsing lives inside the router so malformed JSON reaches OUR error handler (no stack traces to clients).
api.use(express.json({ limit: "1mb" }));
const wrap =(fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// One corrupt cached row must not take down the whole inbox.
const safeRows = (rows) => rows.flatMap((r) => {
  try { return [toRow(r)]; }
  catch (e) { log.error("view", `unreadable row ${r.id}`, e); return []; }
});

api.get("/health", (_req, res) => res.json({ ok: true }));

api.get("/session", (req, res) => res.json({ authed: isAuthed(req), writesEnabled: !!config.demoPasscode }));
api.post("/session", loginLimiter, login);

api.get("/disputes", (_req, res) => {
  const batch = activeBatch();
  res.json({
    batch,
    batchAt: getMeta("active_batch_at"),
    rows: batch ? safeRows(disputesInBatch(batch)) : [],
    pool: poolSummary(),
    refilling: isRefilling(),
    sync: syncStatus(),
  });
});

api.get("/disputes/:id", (req, res) => {
  const row = getDisputeRow(req.params.id);
  if (!row || row.batch === "retired") return res.status(404).json({ error: "Dispute not found in this demo." });
  try { res.json(toCase(row)); }
  catch (e) { log.error("view", `unreadable case ${row.id}`, e); res.status(500).json({ error: "This dispute's data is unreadable right now; it refreshes on the next sync." }); }
});

api.post("/admin/reset", requireAuth, (_req, res) => {
  if (!hasSyncedOnce()) return res.status(503).json({ error: "Still loading disputes from PayPal. Try again in a few seconds." });
  res.json(resetDemo()); // ResetError (429) is mapped by the error handler below
});

api.post("/admin/sync", requireAuth, wrap(async (_req, res) => {
  const r = await syncOnce();
  res.json({ ok: !r.error, skipped: !!r.skipped, problem: r.problem ?? null });
}));

api.use((_req, res) => res.status(404).json({ error: "Not found." }));

// Last-resort handler: full detail goes to the server log; clients get a safe message only.
api.use((err, _req, res, _next) => {
  if (err instanceof URIError || /Failed to decode param/.test(err.message ?? "")) return res.status(404).json({ error: "Not found." });
  if (err.expose && err.status >= 400 && err.status < 500) return res.status(err.status).json({ error: err.message });
  log.error("api", "request failed", err);
  if (err instanceof PayPalError) return res.status(502).json({ error: "PayPal rejected or could not complete the request.", debugId: err.debugId });
  res.status(500).json({ error: "Something went wrong. Please try again." });
});
