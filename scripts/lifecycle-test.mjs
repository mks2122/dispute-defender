// Try each seller/sandbox action on one dispute, regardless of advertised HATEOAS links.
// Usage: node --env-file=.env scripts/lifecycle-test.mjs <DISPUTE_ID> [steps...]
// steps: detail | supporting | require | evidence | adjudicate   (default: all, in that order)
const BASE = "https://api-m.sandbox.paypal.com";
const id = process.argv[2];
const steps = process.argv.slice(3).length ? process.argv.slice(3) : ["detail", "supporting", "require", "evidence", "adjudicate", "detail"];
if (!id) { console.error("usage: lifecycle-test.mjs <DISPUTE_ID> [steps]"); process.exit(1); }

const tok = (await (await fetch(BASE + "/v1/oauth2/token", {
  method: "POST",
  headers: { Authorization: "Basic " + Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
  body: "grant_type=client_credentials",
})).json()).access_token;

async function call(method, path, { json, form } = {}) {
  const headers = { Authorization: `Bearer ${tok}` };
  let body;
  if (json) { headers["Content-Type"] = "application/json"; body = JSON.stringify(json); }
  if (form) body = form;
  const r = await fetch(BASE + path, { method, headers, body });
  const t = await r.text();
  let d; try { d = JSON.parse(t); } catch { d = t; }
  return { s: r.status, d };
}
const short = (r) => r.s < 300 ? `OK ${r.s}` : `ERR ${r.s} ${r.d?.name ?? ""} ${r.d?.message ?? ""} ${JSON.stringify(r.d?.details ?? "").slice(0, 250)}`;
const pdf = "%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF";
const fileForm = (input) => {
  const fd = new FormData();
  fd.append("input", new Blob([JSON.stringify(input)], { type: "application/json" }));
  fd.append("evidence-file", new Blob([pdf], { type: "application/pdf" }), "delivery-proof.pdf");
  return fd;
};

for (const s of steps) {
  let r;
  if (s === "detail") {
    r = await call("GET", `/v1/customer/disputes/${id}`);
    const d = r.d;
    console.log(`detail      ${d.status} stage=${d.dispute_life_cycle_stage} reason=${d.reason} amt=${d.dispute_amount?.value} due=${d.seller_response_due_date ?? "-"} links=[${(d.links ?? []).map((l) => l.rel)}]`);
    continue;
  }
  if (s === "supporting") r = await call("POST", `/v1/customer/disputes/${id}/provide-supporting-info`, { form: fileForm({ notes: "Item matched listing photos; buyer signed for delivery. (probe)" }) });
  if (s === "require") r = await call("POST", `/v1/customer/disputes/${id}/require-evidence`, { json: { action: "SELLER_EVIDENCE" } });
  if (s === "evidence") r = await call("POST", `/v1/customer/disputes/${id}/provide-evidence`, { form: fileForm({ evidences: [{ evidence_type: "PROOF_OF_FULFILLMENT", evidence_info: { tracking_info: [{ carrier_name: "UPS", tracking_number: "1Z999AA10123456784" }] }, notes: "Delivered and signed for. (probe)" }] }) });
  if (s === "adjudicate") r = await call("POST", `/v1/customer/disputes/${id}/adjudicate`, { json: { adjudication_outcome: "SELLER_FAVOR" } });
  console.log(`${s.padEnd(11)} ${short(r)}`);
  await new Promise((res) => setTimeout(res, 4000));
}
