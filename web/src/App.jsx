import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, money } from "./api.js";
import Inbox from "./Inbox.jsx";
import CaseDrawer from "./CaseDrawer.jsx";
import PasscodeDialog from "./PasscodeDialog.jsx";

const POLL_MS = 10_000;

export default function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [askPasscode, setAskPasscode] = useState(null); // pending action to retry after login
  const [notice, setNotice] = useState(null);
  // Stable identity: CaseDrawer's effect depends on it, so a new function per render would restart its polling.
  const closeCase = useCallback(() => setSelected(null), []);

  const alive = useRef(true);
  const load = useCallback(async () => {
    try {
      const d = await api.disputes();
      if (alive.current) { setData(d); setError(null); }
    } catch (e) {
      if (alive.current) setError(e.message);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    load();
    const t = setInterval(load, POLL_MS);
    return () => { alive.current = false; clearInterval(t); };
  }, [load]);

  // Runs a write action; if the server wants the passcode, ask once and retry.
  const withAuth = useCallback(async (fn) => {
    try { return await fn(); }
    catch (e) {
      if (e.needsPasscode) { setAskPasscode(() => fn); return null; }
      setNotice({ kind: "error", text: e.message });
      return null;
    }
  }, []);

  const reset = async () => {
    const r = await withAuth(api.reset);
    if (r) {
      setSelected(null);
      const kept = r.carried?.length ? ` Kept ${r.carried.length} you hadn't touched yet.` : "";
      setNotice({
        kind: r.changed ? "ok" : "info",
        text: r.changed
          ? `Loaded ${r.picked.length} fresh sandbox dispute(s).${kept}`
          : r.refilling
            ? "No fresh disputes in reserve yet. New ones are being created in PayPal (about 5 minutes)."
            : "No fresh disputes in reserve right now. The inbox is unchanged.",
      });
      load();
    }
  };

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const kpi = useMemo(() => ({
    atRisk: rows.reduce((s, r) => s + r.atRisk, 0),
    needsResponse: rows.filter((r) => r.phase === "ACTION_NEEDED").length,
    submitted: rows.filter((r) => r.phase === "SUBMITTED" || r.phase === "RESOLVED").length,
    poolReady: (data?.pool ?? []).reduce((s, p) => s + p.ready, 0),
  }), [rows, data]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true"><path d="M16 2 4 7v8c0 7.5 5.1 13.4 12 15 6.9-1.6 12-7.5 12-15V7z" fill="currentColor" /><path d="m11 16 3.5 3.5L21.5 12" stroke="var(--brand-ink)" strokeWidth="3" fill="none" strokeLinecap="round" /></svg>
          <div>
            <div className="brand-name">Dispute Defender</div>
            <div className="brand-sub">Juniper &amp; Oak Goods · PayPal Sandbox</div>
          </div>
        </div>
        <div className="topbar-right">
          <span className="sync" title={data?.sync?.lastError ?? ""}>
            {data?.sync?.lastError ? "⚠ PayPal sync error" : data?.sync?.lastSyncAt ? `Synced ${new Date(data.sync.lastSyncAt).toLocaleTimeString()}` : "Connecting…"}
          </span>
          <button className="btn ghost" onClick={reset} title="Swap in a fresh set of sandbox disputes">Reset demo</button>
        </div>
      </header>

      <section className="kpis">
        <Kpi label="Money at risk" value={money(kpi.atRisk)} accent />
        <Kpi label="Need your response" value={kpi.needsResponse} />
        <Kpi label="Responded" value={kpi.submitted} />
        <Kpi label="Fresh disputes in reserve" value={kpi.poolReady} hint={data?.refilling ? "refilling…" : null} />
      </section>

      {notice && (
        <div className={`notice ${notice.kind}`} role="status">
          {notice.text}
          <button className="link" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}
      {error && <div className="notice error">Can't reach the server: {error}</div>}

      <main className="main">
        <Inbox rows={rows} loading={!data} onOpen={setSelected} selectedId={selected} />
      </main>

      {selected && <CaseDrawer id={selected} onClose={closeCase} />}
      {askPasscode && (
        <PasscodeDialog
          onCancel={() => setAskPasscode(null)}
          onSuccess={async () => { const fn = askPasscode; setAskPasscode(null); const r = await withAuth(fn); if (r) { load(); setNotice({ kind: "ok", text: "Done." }); } }}
        />
      )}
    </div>
  );
}

function Kpi({ label, value, accent, hint }) {
  return (
    <div className={`kpi ${accent ? "accent" : ""}`}>
      <div className="kpi-value">{value}</div>
      <div className="kpi-label">{label}{hint && <span className="kpi-hint"> · {hint}</span>}</div>
    </div>
  );
}
