import express from "express";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { config } from "./config.js";
import { api } from "./routes.js";
import { startSyncLoop } from "./sync.js";
import { stopRefill } from "./paypal/seed.js";
import { closeDb } from "./db.js";
import { startMirror, stopMirror } from "./mirror.js";
import { log } from "./log.js";

const app = express();
app.set("trust proxy", config.trustProxy);
app.disable("x-powered-by");
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});
app.use("/api", api);

// Serve the built web app (npm run build) and its store images.
const dist = fileURLToPath(new URL("../web/dist", import.meta.url));
const indexHtml = join(dist, "index.html");
app.use(express.static(dist, { maxAge: "1h", index: false }));
app.use((req, res, next) => {
  if (req.method !== "GET" || req.path.startsWith("/api")) return next();
  // A missing asset (e.g. /store/x.jpg) must 404, not return the SPA shell.
  if (/\.[a-z0-9]{2,5}$/i.test(req.path)) return res.status(404).type("text").send("Not found");
  // Checked per request, so a build produced after boot is picked up without a restart.
  if (!existsSync(indexHtml)) return res.status(503).type("text").send("Web app not built. Run `npm run build`.");
  res.sendFile(indexHtml);
});

// Restore saved history before serving or syncing, so the first sync builds on it instead of racing it.
await startMirror();
const server = app.listen(config.port, () => log.info("server", `Dispute Defender on http://localhost:${config.port} (PayPal: ${config.paypalBase})`));
const syncTimer = config.clientId ? startSyncLoop(config.syncIntervalMs) : null;

// Graceful shutdown (Render sends SIGTERM on deploy): stop timers and refills, drain HTTP, close the DB.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("server", `${signal} received, shutting down`);
  if (syncTimer) clearInterval(syncTimer);
  stopRefill();
  server.close(async () => {
    await stopMirror();
    closeDb();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
