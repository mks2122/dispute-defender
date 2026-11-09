import { useEffect, useState } from "react";
import { api, money, dueLabel } from "./api.js";

const RECORD_ICONS = { listing: "🏷️", order: "🧾", shipment: "📦", message: "💬", message_log: "💬", prior_order: "🕘", agent_mandate: "🤖", supplier_cert: "📜", policy: "📄" };

export default function CaseDrawer({ id, onClose }) {
  const [c, setC] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    const load = () => api.dispute(id)
      .then((d) => { if (alive) { setC(d); setError(null); } })
      .catch((e) => { if (alive) setError(e.message); });
    load();
    const t = setInterval(load, 10_000);
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => { alive = false; clearInterval(t); window.removeEventListener("keydown", onKey); };
  }, [id, onClose]);

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()} aria-label="Dispute details">
        <button className="drawer-close" onClick={onClose} aria-label="Close">×</button>
        {error && <div className="notice error">{error}</div>}
        {!c && !error && <div className="muted pad">Loading…</div>}
        {c && <CaseBody c={c} />}
      </aside>
    </div>
  );
}

function CaseBody({ c }) {
  const due = dueLabel(c.paypalDue);
  return (
    <>
      <div className="case-head">
        <div className="case-eyebrow">{c.reasonLabel} · {c.stage?.toLowerCase()}</div>
        <h2>{c.item}</h2>
        <div className="case-meta">
          <span className="case-amount">{money(c.amount, c.currency)}</span>
          <span className={`pill phase-${c.phase}`}>{c.phaseLabel}</span>
          {due && <span className="muted">PayPal deadline {due.text}</span>}
        </div>
        <div className="mono muted small">{c.id} · capture {c.transaction?.seller_transaction_id ?? "—"}</div>
      </div>

      <Section title="What the buyer says" note="From PayPal · treated as an unverified claim">
        {c.buyerClaims.length ? c.buyerClaims.map((b, i) => (
          <blockquote key={i} className="claim">“{b.text}”<cite>{c.buyer} · {new Date(b.date).toLocaleDateString()}</cite></blockquote>
        )) : <p className="muted">PayPal hasn't shared the buyer's statement yet.</p>}
      </Section>

      <Section title="AI analysis" note="GPT-5.6 Luna">
        <div className="ai-placeholder">AI review (fight or refund, win chance, drafted response) arrives in milestone 2.</div>
      </Section>

      <Section title="Your records" note={`${c.records.length} records from ${c.store.name}`}>
        <ul className="records">
          {c.records.map((r) => (
            <li key={r.id} className="record">
              <div className="record-head">
                <span aria-hidden="true">{RECORD_ICONS[r.type] ?? "•"}</span>
                <span className="record-title">{r.title}</span>
                <span className="record-id mono">{r.id}</span>
              </div>
              <RecordData data={r.data} />
            </li>
          ))}
        </ul>
      </Section>

      <Section title="PayPal" note="Live from the Disputes API">
        <dl className="kv">
          <dt>Status</dt><dd>{c.paypal.status}</dd>
          <dt>Stage</dt><dd>{c.paypal.stage}</dd>
          <dt>Allowed actions</dt><dd>{c.paypal.links.filter((l) => l !== "self").join(", ") || "none yet"}</dd>
          <dt>PayPal asks for</dt><dd>{c.requestedFromSeller.join(", ") || "—"}</dd>
          {c.paypal.outcome && (<><dt>Outcome</dt><dd>{c.paypal.outcome.outcome_code}</dd></>)}
        </dl>
      </Section>

      {c.audit.length > 0 && (
        <Section title="Activity">
          <ul className="audit">{c.audit.map((a, i) => <li key={i}><span className="mono muted">{new Date(a.at).toLocaleString()}</span> {a.event.replace(/_/g, " ")}</li>)}</ul>
        </Section>
      )}
    </>
  );
}

function Section({ title, note, children }) {
  return (
    <section className="case-section">
      <div className="case-section-head"><h3>{title}</h3>{note && <span className="muted small">{note}</span>}</div>
      {children}
    </section>
  );
}

function RecordData({ data }) {
  const entries = Object.entries(data).filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0));
  return (
    <dl className="kv small">
      {entries.map(([k, v]) => (
        <div key={k} className="kv-row">
          <dt>{k.replace(/_/g, " ")}</dt>
          <dd>{formatValue(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

const isImage = (v) => typeof v === "string" && /^\/store\/.+\.(jpe?g|png|webp)$/i.test(v);
function Thumb({ src }) {
  const [broken, setBroken] = useState(false);
  if (broken) return <span className="muted">{src.split("/").pop()}</span>;
  return (
    <a href={src} target="_blank" rel="noreferrer" className="thumb-link">
      <img className="thumb" src={src} alt="" loading="lazy" onError={() => setBroken(true)} />
    </a>
  );
}

function formatValue(v) {
  if (isImage(v)) return <Thumb src={v} />;
  if (Array.isArray(v) && v.length && v.every(isImage)) return <span className="thumbs">{v.map((s) => <Thumb key={s} src={s} />)}</span>;
  if (Array.isArray(v)) {
    if (v.every((x) => typeof x === "string")) return v.join(", ");
    return v.map((x) => (typeof x === "object" ? Object.values(x).join(" · ") : String(x))).join(" | ");
  }
  if (typeof v === "object") return JSON.stringify(v);
  if (typeof v === "boolean") return v ? "yes" : "no";
  return String(v);
}
