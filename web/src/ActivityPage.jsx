import { useEffect, useState } from "react";
import { api } from "./api.js";
import { timeAgo } from "./ui.jsx";

export default function ActivityPage({ onOpen }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.activity().then((d) => { if (alive) { setItems(d.items); setError(null); } }).catch((e) => alive && setError(e.message));
    load();
    const t = setInterval(load, 10_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Activity</h2>
          <p>Everything the agent and you did, newest first. Prompts and PayPal payloads are never logged.</p>
        </div>
      </div>
      <section className="card">
        {error && <div className="card-body error-text">{error}</div>}
        {!items && !error && <div className="card-body"><div className="skeleton" style={{ height: 160 }} /></div>}
        {items && items.length === 0 && <div className="empty">No activity yet.</div>}
        {items && items.length > 0 && (
          <ul className="feed">
            {items.map((a, i) => (
              <li key={i}>
                <span className="tick" />
                <span style={{ minWidth: 0 }}>
                  {a.label} ·{" "}
                  <button onClick={() => onOpen(a.disputeId)} style={{ border: 0, background: "none", padding: 0, fontWeight: 500, color: "var(--text)" }}>{a.item}</button>
                  <span className="mono faint" style={{ marginLeft: 8 }}>{a.disputeId}</span>
                </span>
                <time dateTime={a.at} title={new Date(a.at).toLocaleString()}>{timeAgo(a.at)}</time>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
