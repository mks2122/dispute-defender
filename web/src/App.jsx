import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api.js";
import { Icon, LogoMark, NEEDS, RESPONDED } from "./ui.jsx";
import { useTheme } from "./theme.js";
import Overview from "./Overview.jsx";
// AG Grid is large and only the disputes table needs it, so that page loads on first visit.
const DisputesPage = lazy(() => import("./DisputesPage.jsx"));
import ActivityPage from "./ActivityPage.jsx";
import SettingsPage from "./SettingsPage.jsx";
import CaseSheet from "./CaseSheet.jsx";
import PasscodeDialog from "./PasscodeDialog.jsx";

const POLL_MS = 10_000;
const PAGES = {
  overview: { title: "Overview", icon: "overview" },
  disputes: { title: "All disputes", icon: "list", filter: () => true },
  needs: { title: "Needs response", icon: "inbox", filter: NEEDS },
  responded: { title: "Responded", icon: "done", filter: RESPONDED },
  activity: { title: "Activity", icon: "activity" },
  settings: { title: "Settings", icon: "settings" },
};
const pageFromHash = () => {
  const p = window.location.hash.replace(/^#\/?/, "");
  return PAGES[p] ? p : "overview";
};

export default function App() {
  const [page, setPage] = useState(pageFromHash);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [askPasscode, setAskPasscode] = useState(null);
  const askingRef = useRef(false);
  const [toast, setToast] = useState(null);
  const alive = useRef(true);
  const { theme, toggle: toggleTheme } = useTheme();

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
    const onHash = () => { setPage(pageFromHash()); setMenuOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setMenuOpen(false); };
    window.addEventListener("hashchange", onHash);
    window.addEventListener("keydown", onKey);
    return () => { alive.current = false; clearInterval(t); window.removeEventListener("hashchange", onHash); window.removeEventListener("keydown", onKey); };
  }, [load]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  /** Run a write; if the server wants the passcode, ask once and retry. Resolves null if cancelled. */
  const runWrite = useCallback((fn) => new Promise((resolve, reject) => {
    if (askingRef.current) { reject(new Error("Enter the passcode for the action already waiting first.")); return; }
    const attempt = () => fn().then(resolve, (e) => {
      if (e.needsPasscode) {
        askingRef.current = true;
        setAskPasscode({
          retry: () => { askingRef.current = false; attempt(); },
          cancel: () => { askingRef.current = false; resolve(null); },
        });
      } else reject(e);
    });
    attempt();
  }), []);

  const reset = useCallback(async () => {
    try {
      const r = await runWrite(api.reset);
      if (!r) return;
      setSelected(null);
      setToast(r.changed ? `Loaded ${r.picked.length} new dispute${r.picked.length === 1 ? "" : "s"} from PayPal.` : r.refilling ? "New disputes are on their way from PayPal (about 5 minutes)." : "No new disputes are ready yet.");
      load();
    } catch (e) { setToast(e.message); }
  }, [runWrite, load]);

  const closeCase = useCallback(() => setSelected(null), []);
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const counts = useMemo(() => ({ disputes: rows.length, needs: rows.filter(NEEDS).length, responded: rows.filter(RESPONDED).length }), [rows]);
  const current = PAGES[page];

  return (
    <div className="shell">
      {menuOpen && <div className="scrim" style={{ zIndex: 55 }} onClick={() => setMenuOpen(false)} />}
      <aside className={`sidebar ${menuOpen ? "open" : ""}`} aria-label="Navigation">
        <div className="logo"><span className="logo-mark"><LogoMark size={17} /></span><span className="logo-word">Dispute Defender</span></div>
        <NavLink id="overview" page={page} />
        <div className="nav-group">Disputes</div>
        <NavLink id="disputes" page={page} count={counts.disputes} />
        <NavLink id="needs" page={page} count={counts.needs} />
        <NavLink id="responded" page={page} count={counts.responded} />
        <div className="nav-group">Workspace</div>
        <NavLink id="activity" page={page} />
        <NavLink id="settings" page={page} />
      </aside>

      <div className="main">
        <header className="topbar">
          <button className="icon-btn menu-btn" onClick={() => setMenuOpen(true)} aria-label="Open menu"><Icon name="menu" /></button>
          <h1><span className="crumb hide-sm">Juniper &amp; Oak Goods / </span>{current.title}</h1>
          <span className="spacer" />
          <button className="icon-btn" onClick={toggleTheme} aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"} title={theme === "dark" ? "Light theme" : "Dark theme"}>
            <Icon name={theme === "dark" ? "sun" : "moon"} />
          </button>
        </header>

        <main className="content">
          {error && <div className="card card-body error-text" role="alert">Can't reach the server: {error}</div>}
          {page === "overview" && <Overview rows={rows} loading={!data} onOpen={setSelected} />}
          {current.filter && (
            <Suspense fallback={<div className="card card-body"><div className="skeleton" style={{ height: 240 }} /></div>}>
              <DisputesPage key={page} title={current.title} rows={rows} preset={current.filter} loading={!data} onOpen={setSelected} selectedId={selected} />
            </Suspense>
          )}
          {page === "activity" && <ActivityPage onOpen={setSelected} />}
          {page === "settings" && <SettingsPage onReset={reset} />}
        </main>
      </div>

      {selected && <CaseSheet id={selected} onClose={closeCase} runWrite={runWrite} onChanged={load} notify={setToast} />}
      {askPasscode && (
        <PasscodeDialog
          onCancel={() => { askPasscode.cancel(); setAskPasscode(null); }}
          onSuccess={() => { const { retry } = askPasscode; setAskPasscode(null); retry(); }}
        />
      )}
      {toast && <div className="toast" role="status">{toast}<button onClick={() => setToast(null)} aria-label="Dismiss"><Icon name="x" size={14} /></button></div>}
    </div>
  );
}

function NavLink({ id, page, count }) {
  const p = PAGES[id];
  return (
    <a className="nav-item" href={`#/${id}`} aria-current={page === id ? "page" : undefined} title={p.title}>
      <Icon name={p.icon} size={16} /><span className="label">{p.title}</span>{count != null && <span className="count">{count}</span>}
    </a>
  );
}
