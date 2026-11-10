import { useRef, useState } from "react";
import { api } from "./api.js";
import { Icon } from "./ui.jsx";

const MAX_FILE = 64_000;

/** A starting point the seller edits: the records the analysis uses most, shaped for this dispute. */
function example(c) {
  const day = (offset) => new Date(Date.parse(c.createdAt) - offset * 864e5).toISOString().slice(0, 10);
  return JSON.stringify([
    { id: "ORD-2001", type: "order", title: "Order", data: { placed: day(20), items: [{ name: "Item name", qty: 1, price: c.amount }], ship_to: "Buyer's address" } },
    { id: "SHP-2001", type: "shipment", title: "Shipment", data: { carrier: "USPS", tracking: "Tracking number", shipped: day(19), delivered: day(15), delivered_to: "Buyer's address" } },
    { id: "LST-2001", type: "listing", title: "Product listing", data: { name: "Item name", description: "What the listing said" } },
    { id: "MSG-2001", type: "message", title: "Buyer message", data: { from: "buyer", date: day(14), text: "What the buyer wrote" } },
  ], null, 2);
}

/**
 * Import seller records for a dispute that isn't a store order (JSON or CSV, pasted or from a file).
 * The server validates them, stores them and runs the analysis.
 */
export default function ImportPanel({ c, runWrite, onImported, onCancel }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [warnings, setWarnings] = useState([]);
  const fileRef = useRef(null);

  const readFile = (file) => {
    if (!file) return;
    if (file.size > MAX_FILE) { setError(`That file is ${Math.round(file.size / 1000)} KB; the limit is 64 KB.`); return; }
    const reader = new FileReader();
    reader.onload = () => { setText(String(reader.result ?? "")); setError(null); };
    reader.onerror = () => setError("Couldn't read that file.");
    reader.readAsText(file);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await runWrite(() => api.importRecords(c.id, text));
      if (r) { setWarnings(r.warnings ?? []); onImported(r.warnings ?? []); }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card card-body section" aria-label="Import seller records">
      <h4>{c.records.length ? "Replace your records" : "Add your records"}</h4>
      <p className="small muted" style={{ marginTop: 0 }}>
        This dispute isn't from a connected store, so there's nothing to check the buyer's claim against yet.
        Paste or upload the order, shipment, listing and messages as JSON or CSV. The AI analyses the dispute as soon as they're saved,
        and every fact in your response is checked against them.
      </p>
      <textarea
        className="editor mono"
        value={text}
        onChange={(e) => { setText(e.target.value); setError(null); }}
        placeholder={'[\n  { "id": "SHP-2001", "type": "shipment", "data": { "carrier": "USPS", "tracking": "...", "delivered": "2026-10-28" } }\n]'}
        aria-label="Seller records (JSON or CSV)"
        spellCheck={false}
        rows={10}
      />
      <div className="editor-meta">
        <span className="editor-actions">
          <button className="link-btn" onClick={() => fileRef.current?.click()}>Upload a file</button>
          <input ref={fileRef} type="file" accept=".json,.csv,application/json,text/csv" hidden onChange={(e) => { readFile(e.target.files?.[0]); e.target.value = ""; }} />
          <button className="link-btn" onClick={() => { setText(example(c)); setError(null); }}>Insert an example</button>
        </span>
        <span className="num">{text.length.toLocaleString()} / 64,000</span>
      </div>
      <details className="small muted" style={{ marginTop: 8 }}>
        <summary>Format</summary>
        <p style={{ margin: "6px 0" }}>
          JSON: a list of records, each with an <span className="mono">id</span> (like ORD-1001), a <span className="mono">type</span>,
          an optional <span className="mono">title</span> and a <span className="mono">data</span> object.
          CSV: the columns <span className="mono">id,type,title,field,value</span>, one row per field.
        </p>
        <p style={{ margin: "6px 0" }}>Types: order, shipment, listing, message (with from: buyer or seller), message_log, policy, supplier_cert, prior_order, agent_mandate, note. Write dates as YYYY-MM-DD.</p>
      </details>
      {error && <p className="error-text small" role="alert">{error}</p>}
      {warnings.length > 0 && <ul className="small warn-text">{warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
      <div className="row-actions">
        {onCancel && <button className="btn" onClick={onCancel} disabled={busy}>Cancel</button>}
        <button className="btn btn-primary" onClick={submit} disabled={busy || !text.trim()}>
          <Icon name="doc" size={14} />{busy ? "Saving and analysing…" : "Save records and analyse"}
        </button>
      </div>
    </section>
  );
}
