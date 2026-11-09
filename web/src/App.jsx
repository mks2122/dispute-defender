import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api.js";
import { Icon, money } from "./ui.jsx";
import Inbox from "./Inbox.jsx";
import CaseSheet from "./CaseSheet.jsx";
import PasscodeDialog from "./PasscodeDialog.jsx";

const POLL_MS = 10_000;
const FILTERS = [
  { key: "all", label: "All", match: () => true },
  { key: "todo", label: "Needs response", match: (r) => r.phase === "ACTION_NEEDED" },
  { key: "done", label: "Responded", match: (r) => ["SUBMITTING", "SUBMITTED", "RESOLVED"].includes(r.phase) },
];

export default function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [session, setSession] = useState(null);
  const [selected, setSelected] = useState(null);
  const [filter, setFilter] = useState("all");
  const [askPasscode, setAskPasscode] = useState(null);
  const [toast, setToast] = useState(null);
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
    api.session().then((s) => alive.current && setSession(s)).catch(() => {});
    const t = setInterval(load, POLL_MS);
    return () => { alive.current = false; clearInterval(t); };
  }, [load]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  /** Run a write; if the server wants the passcode, ask once and retry. Resolves null if cancelled. */
  const runWrite = useCallback((fn) => new Promise((resolve, reject) => {
    const attempt = () => fn().then(resolve, (e) => {
      if (e.needsPasscode) setAskPasscode({ retry: attempt, cancel: () => resolve(null) });
      else reject(e);
    });
    attempt();
  }), []);

  const reset = async () => {
    try {
      const r = await runWrite(api.reset);
      if (!r) return;
      setSelected(null);
      setToast(r.changed ? `Loaded ${r.picked.length} fresh dispute${r.picked.length === 1 ? "" : "s"} from the PayPal sandbox.` : r.refilling ? "Fresh disputes are being created in PayPal. About 5 minutes." : "No fresh disputes in reserve right now.");
      load();
    } catch (e) { setToast(e.message); }
  };

  const closeCase = useCallback(() => setSelected(null), []);
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const shown = useMemo(() => rows.filter(FILTERS.find((f) => f.key === filter).match), [rows, filter]);
  const stats = useMemo(() => {
    const open = rows.filter((r) => r.phase !== "RESOLVED");
    return {
      atRisk: open.reduce((s, r) => s + r.atRisk, 0),
      recover: open.filter((r) => r.ai?.recommendation === "FIGHT" && r.ai.ev > 0).reduce((s, r) => s + r.ai.ev, 0),
      todo: rows.filter((r) => r.phase === "ACTION_NEEDED").length,
      verified: rows.filter((r) => r.ai?.guardOk).length,
    };
  }, [rows]);
  const aiLabel = session?.ai?.provider === "openai" ? `GPT-5.6 Luna` : "Demo AI";

  return (
    <>
      <nav className="nav" aria-label="Main">
        <div className="nav-inner">
          <div className="brand">
            <span className="brand-mark"><Icon name="shield" size={15} stroke={2.2} /></span>
            Dispute Defender
          </div>
          <div className="nav-spacer" />
          <span className="nav-meta" title={data?.sync?.lastError ?? ""}>
            <span className={`dot ${data?.sync?.lastError ? "warn" : ""}`} />
            <span className="label">{data?.sync?.lastError ? "PayPal sync issue" : "Live from PayPal Sandbox"}</span>
          </span>
          <button className="btn btn-secondary" onClick={reset} title="Swap in a fresh set of sandbox disputes">
            <Icon name="refresh" size={14} /> Reset demo
          </button>
        </div>
      </nav>

      <main className="page">
        <header className="hero">
          <div className="eyebrow"><Icon name="sparkle" size={15} /> AI dispute agent for PayPal sellers</div>
          <h1>Fight the chargebacks worth fighting. <span className="soft">Refund the rest.</span></h1>
          <p>Every dispute is read, checked against your own records, and answered with a draft you approve. Nothing reaches PayPal without your click.</p>
        </header>

        <section className="stats" aria-label="Summary">
          <Stat value={money(stats.atRisk)} label="At risk" />
          <Stat value={money(stats.recover)} label="Expected recovery" green />
          <Stat value={stats.todo} label="Need your response" />
          <Stat value={`${stats.verified}/${rows.length}`} label={`Drafts fact-checked · ${aiLabel}`} />
        </section>

        <div className="toolbar">
          <h2 className="section-title">Disputes</h2>
          <div className="segmented" role="group" aria-label="Filter disputes">
            {FILTERS.map((f) => (
              <button key={f.key} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
                {f.label}<span className="count">{rows.filter(f.match).length}</span>
              </button>
            ))}
          </div>
        </div>

        {error && <div className="block" role="alert" style={{ marginBottom: 14, color: "var(--red)" }}>Can't reach the server: {error}</div>}
        <Inbox rows={shown} loading={!data} onOpen={setSelected} selectedId={selected} filtered={filter !== "all"} />
        <p className="footer-note">PayPal Sandbox · {aiLabel}{session?.ai?.provider !== "openai" ? " (deterministic mock: add an OpenAI key on the server for GPT-5.6 Luna)" : ""}</p>
      </main>

      {selected && <CaseSheet id={selected} onClose={closeCase} runWrite={runWrite} onChanged={load} notify={setToast} />}
      {askPasscode && (
        <PasscodeDialog
          onCancel={() => { askPasscode.cancel(); setAskPasscode(null); }}
          onSuccess={() => { const { retry } = askPasscode; setAskPasscode(null); retry(); }}
        />
      )}
      {toast && <div className="toast" role="status">{toast}<button onClick={() => setToast(null)} aria-label="Dismiss"><Icon name="x" size={14} /></button></div>}
    </>
  );
}

function Stat({ value, label, green }) {
  return (
    <div className="stat">
      <div className={`stat-value ${green ? "green" : ""}`}>{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
