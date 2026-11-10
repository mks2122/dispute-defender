// Smoke test against a running server: node scripts/smoke.mjs [baseUrl]
const base = process.argv[2] ?? "http://localhost:3000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait for a RECENT sync (the stored timestamp may be left over from a previous server process).
let data;
for (let i = 0; i < 40; i++) {
  data = await fetch(`${base}/api/disputes`).then((r) => r.json()).catch(() => null);
  if (data?.sync?.lastSyncAt && Date.now() - Date.parse(data.sync.lastSyncAt) < 60_000) break;
  await sleep(1500);
}
if (!data) { console.error("server not reachable"); process.exit(1); }
console.log(`rows=${data.rows.length} refilling=${data.refilling} syncError=${data.sync.lastError}`);
for (const r of data.rows) console.log(`  ${(r.scenario ?? `(${r.recordsSource})`).padEnd(16)} ${r.reasonLabel.padEnd(17)} $${String(r.atRisk).padEnd(4)} ${r.phaseLabel}`);

const checks = [
  ["bad percent-escape id → 404", `${base}/api/disputes/${"%E0%A4%A"}`, 404],
  ["unknown api route → 404", `${base}/api/nope`, 404],
  ["missing asset → 404", `${base}/store/nope.jpg`, 404],
  ["reset without session → 401", [`${base}/api/admin/reset`, { method: "POST" }], 401],
];
let failed = 0;
for (const [name, target, want] of checks) {
  const [url, init] = Array.isArray(target) ? target : [target];
  const got = (await fetch(url, init)).status;
  if (got !== want) failed++;
  console.log(`${got === want ? "PASS" : "FAIL"} ${name} (got ${got})`);
}
const home = await fetch(base);
const homeOk = home.status === 200 && (home.headers.get("content-type") ?? "").includes("text/html") && (await home.text()).includes('id="root"');
if (!homeOk) failed++;
console.log(`${homeOk ? "PASS" : "FAIL"} / serves the web app (got ${home.status})`);
const h = home.headers;
for (const [k, v] of [["x-frame-options", "DENY"], ["x-content-type-options", "nosniff"], ["referrer-policy", "same-origin"]]) {
  const ok = h.get(k) === v;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} header ${k}: ${h.get(k)}`);
}
process.exit(failed ? 1 : 0);
