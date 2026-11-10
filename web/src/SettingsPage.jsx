import { useEffect, useState } from "react";
import { api } from "./api.js";
import { Icon, timeAgo } from "./ui.jsx";

const SCENARIO_LABELS = {
  "nad-wallet": "Not as described", "inr-phonecase": "Not received", "nad-jacket": "Defect reported",
  "unauth-history": "Unauthorized", "agent-within": "AI agent, within mandate", "agent-over-cap": "AI agent, over mandate",
  "injection-note": "Prompt injection (text)", "image-injection": "Prompt injection (image)",
};

export default function SettingsPage({ onReset }) {
  const [s, setS] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.status().then((d) => { if (alive) { setS(d); setError(null); } }).catch((e) => alive && setError(e.message));
    load();
    const t = setInterval(load, 10_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Settings</h2>
          <p>Connections, AI model and incoming disputes. Secrets are never shown here.</p>
        </div>
        <button className="btn" onClick={onReset} title="Replace the queue with the newest disputes PayPal has ready"><Icon name="refresh" size={14} /> Load new disputes</button>
      </div>
      {error && <div className="card card-body error-text">{error}</div>}
      {!s && !error && <div className="card card-body"><div className="skeleton" style={{ height: 160 }} /></div>}
      {s && (
        <div className="grid-2b">
          <section className="card">
            <div className="card-head"><h3>Connections</h3></div>
            <table className="kv-table"><tbody>
              <tr><th>PayPal</th><td><span className="status"><span className={`dot ${s.sync.lastError ? "dot-off" : "dot-live"}`} style={{ border: 0 }} />{s.paypal.environment}</span></td></tr>
              <tr><th>Merchant</th><td className="mono">{s.paypal.merchantId ?? "—"}</td></tr>
              <tr><th>Last sync</th><td>{s.sync.lastSyncAt ? timeAgo(s.sync.lastSyncAt) : "never"} · every {s.sync.intervalSec}s</td></tr>
              {s.sync.lastError && <tr><th>Sync issue</th><td className="warn-text">{s.sync.lastError}</td></tr>}
              <tr><th>Write actions</th><td>{s.writesEnabled ? "Protected by passcode" : "Disabled (no passcode set)"}</td></tr>
            </tbody></table>
          </section>
          <section className="card">
            <div className="card-head"><h3>AI</h3></div>
            <table className="kv-table"><tbody>
              <tr><th>Provider</th><td>{s.ai.provider === "openai" ? "OpenAI" : "Built-in rules engine"}</td></tr>
              <tr><th>Model</th><td>{s.ai.model}</td></tr>
              <tr><th>Seller time cost</th><td>${s.ai.timeCostUsd} per response (used for expected value)</td></tr>
              <tr><th>Safety</th><td>Every draft is fact-checked against your records before it can be sent</td></tr>
            </tbody></table>
            {s.ai.provider !== "openai" && <p className="small muted" style={{ margin: 0, padding: "0 18px 16px" }}>Set an OpenAI API key on the server to use GPT-5.6 Luna. The rules engine follows the same contract and safety checks.</p>}
          </section>
          <section className="card" style={{ gridColumn: "1 / -1" }}>
            <div className="card-head"><h3>Incoming disputes</h3><span className="hint">{s.refilling ? "New disputes arriving from PayPal…" : "Ready to load into the queue"}</span></div>
            <table className="kv-table"><tbody>
              {s.pool.map((p) => (
                <tr key={p.scenario}><th>{SCENARIO_LABELS[p.scenario] ?? p.scenario}</th><td className="num">{p.ready} ready{p.processing ? ` · ${p.processing} processing` : ""}</td></tr>
              ))}
            </tbody></table>
          </section>
        </div>
      )}
    </>
  );
}
