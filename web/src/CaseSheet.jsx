import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { Icon, Status, Thumb, Badge, money, signedMoney, dueLabel, bandWord } from "./ui.jsx";

const MAX_NOTES = 2000;
const REFUND_NOTE = "We accept this claim and are refunding the buyer in full.";

export default function CaseSheet({ id, onClose, runWrite, onChanged, notify }) {
  const [c, setC] = useState(null);
  const [error, setError] = useState(null);
  const alive = useRef(true);
  const closeRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const d = await api.dispute(id);
      if (alive.current && d.id === id) { setC(d); setError(null); } // ignore a late reply for a previous dispute
    } catch (e) {
      if (alive.current) setError(e.message);
    }
  }, [id]);

  useEffect(() => {
    alive.current = true;
    load();
    const t = setInterval(load, 8000);
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => { alive.current = false; clearInterval(t); window.removeEventListener("keydown", onKey); };
  }, [load, onClose]);

  // Modal behaviour: background inert, focus moves in, and returns to the opener on close.
  useEffect(() => {
    const opener = document.activeElement;
    const background = document.querySelectorAll(".shell > .sidebar, .shell > .main");
    background.forEach((el) => { el.inert = true; });
    closeRef.current?.focus();
    return () => {
      background.forEach((el) => { el.inert = false; });
      if (opener instanceof HTMLElement && document.contains(opener)) opener.focus();
    };
  }, []);

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="sheet" role="dialog" aria-modal="true" aria-label="Dispute details">
        <header className="sheet-head">
          <Thumb src={c?.image} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="sheet-title">{c?.item ?? "Loading…"}</div>
            <div className="small muted">{c ? <>{c.buyer} · {c.reasonLabel}<span className="hide-sm"> · {c.id}</span></> : " "}</div>
          </div>
          <button ref={closeRef} className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        </header>
        {error && <div className="sheet-body"><div className="card card-body error-text" role="alert">{error}</div></div>}
        {!c && !error && <div className="sheet-body"><div className="skeleton" style={{ height: 180 }} /><div className="skeleton" style={{ height: 120 }} /></div>}
        {c && <CaseBody key={c.analysis?.id ?? "none"} c={c} reload={load} runWrite={runWrite} onChanged={onChanged} notify={notify} />}
      </aside>
    </>
  );
}

function CaseBody({ c, reload, runWrite, onChanged, notify }) {
  const a = c.analysis;
  const [decision, setDecision] = useState(a?.recommendation ?? "FIGHT");
  // One draft per decision, so toggling Fight/Refund never throws away the seller's edits.
  const original = { FIGHT: a?.recommendation === "FIGHT" ? a.draft_notes : "", REFUND: a?.recommendation === "REFUND" ? a.draft_notes : REFUND_NOTE };
  const [drafts, setDrafts] = useState(original);
  const notes = drafts[decision];
  const setNotes = (text) => setDrafts((d) => ({ ...d, [decision]: text }));
  const edited = drafts.FIGHT !== original.FIGHT || drafts.REFUND !== original.REFUND;
  const [confirmRerun, setConfirmRerun] = useState(false);
  const flashTimer = useRef(null);
  useEffect(() => () => clearTimeout(flashTimer.current), []);
  const [check, setCheck] = useState(a ? a.guard : null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(null);
  const [serverErrors, setServerErrors] = useState(null);
  const bodyRef = useRef(null);

  const acted = !!c.submission || c.phase === "RESOLVED";
  const canAct = c.paypal.links.includes(decision === "FIGHT" ? "provide_evidence" : "accept_claim");

  const choose = (d) => {
    setDecision(d);
    setConfirming(false);
    setServerErrors(null);
  };

  // Live fact-check of the response as the seller edits it (debounced, cancelled on change/unmount).
  useEffect(() => {
    if (acted || !a) return undefined;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      api.validate(c.id, notes, ctrl.signal).then(setCheck).catch((e) => { if (e.name !== "AbortError") setCheck(null); });
    }, 350);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [notes, c.id, acted, a]);

  const flash = (rid) => {
    const el = bodyRef.current?.querySelector(`[data-record="${rid}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("flash");
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => el.classList.remove("flash"), 1600);
  };

  const submit = async () => {
    if (!confirming) { setConfirming(true); return; }
    setBusy("submit");
    setServerErrors(null);
    try {
      const r = await runWrite(() => api.submit(c.id, { decision, notes, analysisId: a.id }));
      if (r) {
        notify(r.status === "unknown" ? "Sent. PayPal hasn't confirmed yet; we'll check automatically." : decision === "FIGHT" ? "Evidence submitted to PayPal." : "Refund sent through PayPal.");
        await reload();
        onChanged();
      }
    } catch (e) {
      setServerErrors(e.errors?.length ? e.errors : [e.message]);
    } finally {
      setBusy(null);
      setConfirming(false);
    }
  };

  const rerun = async () => {
    if (edited && !confirmRerun) { setConfirmRerun(true); return; }
    setConfirmRerun(false);
    setBusy("analyze");
    try { if (await runWrite(() => api.analyze(c.id))) { await reload(); onChanged(); } }
    catch (e) { notify(e.message); }
    finally { setBusy(null); }
  };

  const due = dueLabel(c.paypalDue);
  const guardErrors = serverErrors ?? (check && !check.ok ? check.errors : null);
  const overLimit = notes.length > MAX_NOTES;
  const hasWatchouts = a && (a.injection_detected || a.unverified_buyer_claims.length > 0 || a.warnings.length > 0);

  return (
    <>
      <div className="sheet-body" ref={bodyRef}>
        <div className="summary-row">
          <span className="big-amount">{money(c.amount, c.currency)}</span>
          <Status phase={c.phase} label={c.phaseLabel} />
          {due && <span className="small muted">PayPal deadline {due.date} · {due.text}</span>}
        </div>

        {c.buyerClaims.length > 0 && (
          <section className="card card-body section">
            <h4>Buyer's claim <Badge>Unverified</Badge></h4>
            {c.buyerClaims.map((b, i) => <p key={i} className="quote">“{b.text}”</p>)}
            <div className="quote-meta">{c.buyer} via PayPal · {new Date(c.buyerClaims[0].date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</div>
          </section>
        )}

        {a ? <Verdict a={a} c={c} onRerun={rerun} busy={busy === "analyze"} confirmDiscard={confirmRerun} /> : <div className="card card-body"><div className="skeleton" style={{ height: 100 }} /><p className="small muted">Analyzing this dispute…</p></div>}

        {hasWatchouts && (
          <section className="card card-body section">
            <h4>Watch-outs</h4>
            <ul className="notes">
              {a.injection_detected && <li><span className="warn-text"><Icon name="alert" size={14} /></span><span>The buyer's message or photo tried to give the AI instructions. They were ignored.</span></li>}
              {a.unverified_buyer_claims.map((u) => <li key={u}><span className="warn-text"><Icon name="alert" size={14} /></span><span>{/[.!?]["”]?$/.test(u) ? u : `${u}.`}</span></li>)}
              {a.warnings.map((w) => <li key={w}><span className="faint"><Icon name="alert" size={14} /></span><span className="muted">{w}</span></li>)}
            </ul>
          </section>
        )}

        {a?.reasoning.length > 0 && (
          <section className="card card-body section">
            <h4>Reasoning</h4>
            <ol className="reasons">
              {a.reasoning.map((r, i) => <li key={i}><span className="n">{i + 1}</span><span>{r.point}<Cites ids={r.source_ids} onCite={flash} /></span></li>)}
            </ol>
          </section>
        )}

        {a?.contradictions.length > 0 && (
          <section className="card card-body section">
            <h4>Claim vs records</h4>
            <table className="compare">
              <thead><tr><th>Buyer says</th><th>Your records</th></tr></thead>
              <tbody>
                {groupClaims(a.contradictions).map((g) => (
                  <tr key={g.claim}><td>{g.claim}</td><td>{g.facts.map((f, i) => <div key={i} className="compare-fact">{f.seller_fact}<Cites ids={f.source_ids} onCite={flash} /></div>)}</td></tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {a?.mandate && (
          <section className="card card-body section">
            <h4>AI-agent purchase mandate <Badge tone={a.mandate.within ? undefined : "warn"}>{a.mandate.within ? "Within mandate" : "Mandate exceeded"}</Badge></h4>
            <ul className="checks">
              {a.mandate.checks.map((m) => (
                <li key={m.label}>
                  <span className={m.ok ? "muted" : "warn-text"}><Icon name={m.ok ? "check" : "x"} size={14} /></span>
                  <span>{m.label}<div className="detail">{m.detail}</div></span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {a?.evidence.length > 0 && (
          <section className="card card-body section">
            <h4>Evidence</h4>
            <ul className="checks">
              {a.evidence.map((e) => (
                <li key={e.requirement}>
                  <span className={e.status === "have" ? "muted" : "warn-text"}><Icon name={e.status === "have" ? "check" : e.status === "weak" ? "alert" : "x"} size={14} /></span>
                  <span>{e.requirement} <span className="faint small">· {e.status === "have" ? "on file" : e.status}</span><Cites ids={e.source_ids} onCite={flash} /></span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {a && (
          <section className="card card-body section">
            <h4>
              {acted ? "Response" : decision === "FIGHT" ? "Response to PayPal" : "Note to PayPal"}
              {!acted && (
                <span className="tabs" role="group" aria-label="Decision">
                  <button aria-pressed={decision === "FIGHT"} onClick={() => choose("FIGHT")}>Fight</button>
                  <button aria-pressed={decision === "REFUND"} onClick={() => choose("REFUND")}>Refund</button>
                </span>
              )}
            </h4>
            {acted ? <Done c={c} /> : (
              <>
                <textarea className="editor" placeholder={decision === "FIGHT" ? "Write your case for PayPal. Cite your records, e.g. (SHP-1001)." : "A short note accepting the claim."} value={notes} onChange={(e) => { setNotes(e.target.value); setConfirming(false); setServerErrors(null); }} aria-label="Response to PayPal" spellCheck />
                <div className="editor-meta">
                  {guardErrors ? <span className="error-text">Fix the issues below before sending</span>
                    : check?.ok ? <span className="guard-ok"><Icon name="check" size={13} /> {check.verified ? `${check.verified} fact${check.verified === 1 ? "" : "s"} verified against your records` : "No unverifiable facts"}</span>
                      : <span>Checking facts…</span>}
                  <span className="editor-actions">
                    {original[decision] && notes !== original[decision] && (
                      <button className="link-btn" onClick={() => { setNotes(original[decision]); setConfirming(false); setServerErrors(null); }}>{decision === "REFUND" && a?.recommendation !== "REFUND" ? "Restore default note" : "Restore AI draft"}</button>
                    )}
                    <span className={`num ${overLimit ? "error-text" : ""}`}>{notes.length.toLocaleString()} / {MAX_NOTES.toLocaleString()}</span>
                  </span>
                </div>
                {guardErrors && <ul className="guard-errors" role="alert">{guardErrors.map((e) => <li key={e}>{e}</li>)}</ul>}
              </>
            )}
          </section>
        )}

        <Records records={c.records} />

        <section className="card card-body">
          <details className="disclosure">
            <summary>PayPal details and history</summary>
            <dl className="kv">
              <dt>Dispute</dt><dd className="mono">{c.id}</dd>
              <dt>Status</dt><dd>{c.paypal.status}</dd>
              <dt>Stage</dt><dd>{c.paypal.stage}</dd>
              <dt>Allowed actions</dt><dd>{c.paypal.links.filter((l) => l !== "self").join(", ") || "none"}</dd>
              <dt>Evidence requested</dt><dd>{c.requestedFromSeller.join(", ") || "—"}</dd>
              {c.paypal.outcome && (<><dt>Outcome</dt><dd>{c.paypal.outcome.outcome_code}</dd></>)}
              {a && (<><dt>AI</dt><dd>{a.provider === "openai" ? a.model : "Built-in rules engine"}{a.fallback ? ` (fallback: ${a.fallback})` : ""} · {a.latencyMs} ms</dd></>)}
            </dl>
            {c.audit.length > 0 && <ul className="feed" style={{ marginTop: 12 }}>{c.audit.map((x, i) => <li key={i} style={{ paddingLeft: 0, paddingRight: 0 }}><span className="tick" /><span>{x.event.replace(/_/g, " ")}</span><time>{new Date(x.at).toLocaleString()}</time></li>)}</ul>}
          </details>
        </section>
      </div>

      {a && !acted && (
        <footer className="sheet-foot">
          <span className="grow">
            {!canAct ? "PayPal isn't accepting this action on this dispute right now."
              : confirming ? (decision === "FIGHT" ? "This sends your response and an evidence packet to PayPal." : `This refunds ${money(c.amount, c.currency)} to the buyer through PayPal.`)
                : "Nothing is sent until you confirm."}
          </span>
          {confirming && <button className="btn btn-lg" onClick={() => setConfirming(false)}>Cancel</button>}
          <button className="btn btn-primary btn-lg" onClick={submit} disabled={!canAct || busy !== null || overLimit || !notes.trim() || !!guardErrors}>
            {busy === "submit" ? "Sending…" : confirming ? "Confirm and send" : decision === "FIGHT" ? "Submit evidence" : `Refund ${money(c.amount, c.currency)}`}
          </button>
        </footer>
      )}
    </>
  );
}

function Verdict({ a, c, onRerun, busy, confirmDiscard }) {
  const fight = a.recommendation === "FIGHT";
  const pct = Math.round(a.win_probability * 100);
  return (
    <section className="card" aria-label="AI recommendation">
      <div className="verdict-head">
        <div>
          <div className="verdict-kicker"><Icon name="bot" size={14} /> Recommendation · {a.provider === "openai" ? a.model : "Built-in rules engine"}{a.fallback && <Badge tone="warn" title={`The configured model failed (${a.fallback}); the built-in rules engine answered.`}>Fallback</Badge>}</div>
          <div className="verdict-word">{fight ? "Fight this dispute" : "Refund the buyer"}</div>
          <p className="verdict-summary">{a.summary}</p>
        </div>
        <button className="btn btn-ghost" onClick={onRerun} disabled={busy}><Icon name="refresh" size={14} />{busy ? "Running…" : confirmDiscard ? "Discard edits and re-run?" : "Re-run"}</button>
      </div>
      <div className="verdict-grid">
        <div>
          <div className="stat-k">Chance to win</div>
          <div className="stat-v">{bandWord(a.confidence_band)} · {pct}%</div>
          <div className="meter"><span style={{ width: `${pct}%` }} /></div>
        </div>
        <div>
          <div className="stat-k">Expected value of fighting</div>
          <div className="stat-v">{signedMoney(a.ev.fight)}</div>
        </div>
        <div>
          <div className="stat-k">{a.partial_refund_suggestion != null ? "Suggested partial refund" : "Disputed amount"}</div>
          <div className="stat-v">{a.partial_refund_suggestion != null ? money(a.partial_refund_suggestion) : money(c.amount, c.currency)}</div>
        </div>
      </div>
      <div className="verdict-foot">
        <Badge tone={a.guard.ok ? undefined : "error"}><Icon name={a.guard.ok ? "check" : "x"} size={12} />{a.guard.ok ? (a.guard.verified ? `${a.guard.verified} facts verified` : "Draft verified") : "Draft needs fixes"}</Badge>
        {a.injection_detected && <Badge tone="warn"><Icon name="alert" size={12} />Injection ignored</Badge>}
        {a.mandate && <Badge><Icon name="bot" size={12} />AI-agent purchase</Badge>}
      </div>
    </section>
  );
}

function Cites({ ids, onCite }) {
  if (!ids?.length) return null;
  return <span className="cites">{[...new Set(ids)].map((rid) => <button key={rid} className="cite" onClick={() => onCite(rid)} title="Show this record">{rid}</button>)}</span>;
}

function Done({ c }) {
  const refund = c.submission?.action === "accept_claim";
  const pending = c.submission && c.submission.status !== "done";
  return (
    <div className="done">
      <span className="ring"><Icon name={pending ? "refresh" : "check"} size={16} /></span>
      <div>
        <div style={{ fontWeight: 500 }}>{pending ? "Waiting for PayPal to confirm" : refund ? "Refund sent" : c.phase === "RESOLVED" ? "Dispute resolved" : "Evidence submitted"}</div>
        <div className="small muted">{c.phase === "RESOLVED" ? `PayPal outcome: ${c.paypal.outcome?.outcome_code ?? "resolved"}` : `PayPal status: ${c.paypal.status.replace(/_/g, " ").toLowerCase()}`}</div>
      </div>
    </div>
  );
}

const IMG = /^\/store\/[\w.-]+\.(png|jpe?g|webp|svg)$/i;

function Records({ records }) {
  if (!records.length) return null;
  return (
    <section className="section">
      <h4>Your records <span className="faint">{records.length}</span></h4>
      <div className="records">
        {records.map((r) => (
          <article key={r.id} className="record" data-record={r.id}>
            <div className="record-head">
              <span className="record-title">{r.title}</span>
              {r.data.from === "buyer" && <Badge>Written by buyer</Badge>}
              <span className="record-id cite">{r.id}</span>
            </div>
            <Fields data={r.data} untrusted={r.data.from === "buyer"} />
          </article>
        ))}
      </div>
    </section>
  );
}

function Fields({ data, untrusted }) {
  const isImg = (v) => typeof v === "string" && IMG.test(v);
  const entries = Object.entries(data).filter(([k, v]) => v !== null && v !== undefined && !(Array.isArray(v) && !v.length) && !["from", "seller_replied"].includes(k));
  const photos = entries.flatMap(([, v]) => [].concat(v)).filter(isImg);
  return (
    <>
      <dl className="kv">
        {entries.filter(([, v]) => ![].concat(v).some(isImg)).map(([k, v]) => (
          <div key={k} style={{ display: "contents" }}><dt>{k.replace(/_/g, " ")}</dt><dd>{fmt(v)}</dd></div>
        ))}
      </dl>
      {photos.length > 0 && (
        <div className="photos">
          {photos.map((p, i) => <a key={p} href={p} target="_blank" rel="noreferrer" className="photo-wrap" aria-label={`Open ${untrusted ? "buyer" : "seller"} photo ${i + 1} in a new tab`}><Photo src={p} />{untrusted && <span className="photo-tag">Buyer photo</span>}</a>)}
        </div>
      )}
    </>
  );
}

function Photo({ src }) {
  const [broken, setBroken] = useState(false);
  if (broken) return null;
  return <img className="photo" src={src} alt="" loading="lazy" onError={() => setBroken(true)} />;
}

function fmt(v) {
  if (Array.isArray(v)) return v.map((x) => (typeof x === "object" ? Object.entries(x).map(([k, y]) => `${k.replace(/_/g, " ")}: ${y}`).join(", ") : String(x))).join(" · ");
  if (typeof v === "object") return Object.entries(v).map(([k, y]) => `${k}: ${y}`).join(", ");
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return String(v);
}

/** One row per distinct buyer claim, even if the model listed it once per contradicting record. */
function groupClaims(list) {
  const key = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const groups = new Map();
  for (const x of list) {
    const k = key(x.buyer_claim);
    if (!groups.has(k)) groups.set(k, { claim: x.buyer_claim, facts: [] });
    groups.get(k).facts.push(x);
  }
  return [...groups.values()];
}
