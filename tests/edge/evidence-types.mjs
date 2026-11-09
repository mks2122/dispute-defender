// Sandbox probe: which evidence_type values does provide-evidence accept on an UNAUTHORISED chargeback,
// and is our generated PDF accepted as evidence-file? Uses a RESERVE POOL dispute (never the inbox).
// Usage: node --env-file=.env tests/edge/evidence-types.mjs <POOL_DISPUTE_ID>
import { writeFileSync } from "node:fs";
import { ppRequest, getDispute } from "../../server/paypal/client.js";
import { renderPdf } from "../../server/evidence/pdf.js";

const id = process.argv[2];
if (!id) { console.error("usage: evidence-types.mjs <POOL_DISPUTE_ID>"); process.exit(1); }

const before = await getDispute(id);
console.log(`dispute ${id} ${before.reason} ${before.status} links=[${before.links.map((l) => l.rel)}]`);
const pdf = renderPdf({ title: "Evidence packet (probe)", sections: [{ heading: "Prior orders", body: "Same device dev_7f3a9c21 and address on 3 prior undisputed orders (HIST-1004-1..3)." }] });
writeFileSync(new URL("./evidence-probe.pdf", import.meta.url), pdf);

const form = () => {
  const fd = new FormData();
  fd.append("input", new Blob([JSON.stringify({ evidences: [
    { evidence_type: "DETAILS_OF_PURCHASE", notes: "Same device and shipping address as three prior undisputed orders. (probe)" },
  ] })], { type: "application/json" }));
  fd.append("evidence-file", new Blob([pdf], { type: "application/pdf" }), "evidence-packet.pdf");
  return fd;
};
try {
  await ppRequest("POST", `/v1/customer/disputes/${id}/provide-evidence`, { form });
  console.log("RESULT: DETAILS_OF_PURCHASE + generated PDF → accepted (2xx)");
} catch (e) {
  console.log(`RESULT: rejected → ${e.status} ${e.issue} debug_id=${e.debugId}`);
}
const after = await getDispute(id);
console.log(`after: ${after.status}; seller evidences: ${(after.evidences ?? []).filter((x) => x.source === "SUBMITTED_BY_SELLER").map((x) => x.evidence_type).join(", ") || "none"}`);
