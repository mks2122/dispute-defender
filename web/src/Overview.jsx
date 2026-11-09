import { useEffect, useMemo, useState } from "react";
import { api } from "./api.js";
import { Thumb, money, signedMoney, timeAgo, verdictWord, NEEDS } from "./ui.jsx";

export default function Overview({ rows, loading, onOpen }) {
  const m = useMemo(() => {
    const open = rows.filter((r) => r.phase !== "RESOLVED");
    const fight = rows.filter((r) => r.ai?.recommendation === "FIGHT");
    const refund = rows.filter((r) => r.ai?.recommendation === "REFUND");
    const byReason = {};
    for (const r of open) byReason[r.reasonLabel] = (byReason[r.reasonLabel] ?? 0) + r.atRisk;
    return {
      atRisk: open.reduce((s, r) => s + r.atRisk, 0),
      recover: open.filter((r) => NEEDS(r) && r.ai?.recommendation === "FIGHT" && r.ai.ev > 0).reduce((s, r) => s + r.ai.ev, 0),
      needs: rows.filter(NEEDS),
      verified: rows.filter((r) => r.ai?.guardOk).length,
      analysed: rows.filter((r) => r.ai).length,
      fight: { n: fight.length, amount: fight.reduce((s, r) => s + r.amount, 0) },
      refund: { n: refund.length, amount: refund.reduce((s, r) => s + r.amount, 0) },
      reasons: Object.entries(byReason).sort((a, b) => b[1] - a[1]),
    };
  }, [rows]);

  if (loading) return <div className="kpis">{[0, 1, 2, 3].map((i) => <div key={i} className="card kpi"><div className="skeleton" style={{ height: 52 }} /></div>)}</div>;

  const queue = [...m.needs].sort((a, b) => (b.ai?.ev ?? -1e9) - (a.ai?.ev ?? -1e9));
  const maxReason = Math.max(1, ...m.reasons.map(([, v]) => v));
  const totalRec = m.fight.n + m.refund.n;

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Overview</h2>
          <p>Every dispute is checked against your records and answered with a draft you approve.</p>
        </div>
      </div>

      <section className="kpis" aria-label="Key figures">
        <Kpi label="At risk" value={money(m.atRisk)} sub={`${rows.length} open dispute${rows.length === 1 ? "" : "s"}`} />
        <Kpi label="Expected recovery" value={money(Math.round(m.recover * 100) / 100)} sub="if you fight the recommended ones" />
        <Kpi label="Needs response" value={m.needs.length} sub="before PayPal's deadline" />
        <Kpi label="Drafts fact-checked" value={`${m.verified}/${m.analysed}`} sub="every fact traced to a record" />
      </section>

      <div className="grid-2">
        <section className="card">
          <div className="card-head"><h3>Needs your response</h3><a className="hint" href="#/needs">View all</a></div>
          {queue.length === 0 ? <div className="empty"><h3>All caught up</h3>No disputes are waiting for you.</div> : (
            <ul className="rows">
              {queue.slice(0, 6).map((r) => (
                <li key={r.id}>
                  <button className="row-btn" onClick={() => onOpen(r.id)}>
                    <Thumb src={r.image} />
                    <span style={{ minWidth: 0 }}>
                      <div className="row-title">{r.item}</div>
                      <div className="row-sub">{r.reasonLabel} · {money(r.amount, r.currency)}</div>
                    </span>
                    <span className="row-right">
                      <div className="verdict-text">{r.ai ? verdictWord(r.ai.recommendation) : "Analyzing…"}</div>
                      <div className="small faint">{r.ai ? `${signedMoney(r.ai.ev)} EV` : ""}</div>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          <div className="card-head"><h3>AI recommendations</h3><span className="hint">{totalRec} analysed</span></div>
          <div className="card-body">
            <div className="split" role="img" aria-label={`Fight ${m.fight.n}, refund ${m.refund.n}`}>
              {m.fight.n > 0 && <span style={{ flex: m.fight.n }} title={`Fight: ${m.fight.n} disputes, ${money(m.fight.amount)}`} />}
              {m.refund.n > 0 && <span style={{ flex: m.refund.n }} title={`Refund: ${m.refund.n} disputes, ${money(m.refund.amount)}`} />}
            </div>
            <div className="legend">
              <div className="legend-item"><span className="swatch" />Fight <span className="muted num">{m.fight.n} · {money(m.fight.amount)}</span></div>
              <div className="legend-item"><span className="swatch light" />Refund <span className="muted num">{m.refund.n} · {money(m.refund.amount)}</span></div>
            </div>
            <p className="small muted" style={{ margin: "14px 0 0" }}>
              Refunds are recommended when your own records show the buyer is right, or when fighting costs more than it recovers.
            </p>
          </div>
        </section>
      </div>

      <div className="grid-2b">
        <section className="card">
          <div className="card-head"><h3>At risk by reason</h3><span className="hint">{money(m.atRisk)} total</span></div>
          <div className="card-body">
            {m.reasons.length === 0 ? <span className="muted">Nothing at risk.</span> : (
              <div className="barlist">
                {m.reasons.map(([reason, v]) => (
                  <div className="bar-row" key={reason} title={`${reason}: ${money(v)}`}>
                    <span>{reason}</span>
                    <span className="bar-track"><span className="bar-fill" style={{ display: "block", width: `${(v / maxReason) * 100}%` }} /></span>
                    <span className="bar-value">{money(v)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
        <RecentActivity onOpen={onOpen} />
      </div>
    </>
  );
}

function Kpi({ label, value, sub }) {
  return (
    <div className="card kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-sub">{sub}</div>
    </div>
  );
}

function RecentActivity({ onOpen }) {
  const [items, setItems] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.activity().then((d) => alive && setItems(d.items)).catch(() => alive && setItems([]));
    load();
    const t = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return (
    <section className="card">
      <div className="card-head"><h3>Recent activity</h3><a className="hint" href="#/activity">View all</a></div>
      {!items ? <div className="card-body"><div className="skeleton" style={{ height: 80 }} /></div>
        : items.length === 0 ? <div className="empty">No activity yet.</div> : (
          <ul className="feed">
            {items.slice(0, 6).map((a, i) => (
              <li key={i}>
                <span className="tick" />
                <span style={{ minWidth: 0 }}>{a.label} · <button className="btn-ghost" style={{ border: 0, background: "none", padding: 0, color: "var(--text)", fontWeight: 500 }} onClick={() => onOpen(a.disputeId)}>{a.item}</button></span>
                <time dateTime={a.at}>{timeAgo(a.at)}</time>
              </li>
            ))}
          </ul>
        )}
    </section>
  );
}

