import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { Icon, Pill, Thumb, money, signedMoney, dueLabel, PHASE_TONE, bandWord } from "./ui.jsx";

const MAX_NOTES = 2000;

export default function CaseSheet({ id, onClose, runWrite, onChanged, notify }) {
  const [c, setC] = useState(null);
  const [error, setError] = useState(null);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const d = await api.dispute(id);
      if (alive.current) { setC(d); setError(null); }
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

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="sheet" role="dialog" aria-modal="true" aria-label="Dispute details">
        <header className="sheet-head">
          <Thumb src={c?.image} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="sheet-title">{c?.item ?? "Loading…"}</div>
            <div className="small muted">{c ? `${c.buyer} · ${c.reasonLabel}` : " "}</div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        </header>
        {error && <div className="sheet-body"><div className="block" role="alert">{error}</div></div>}
        {!c && !error && <div className="sheet-body"><div className="skeleton" style={{ height: 220 }} /><div className="skeleton" style={{ height: 120 }} /></div>}
        {c && <CaseBody key={c.analysis?.id ?? "none"} c={c} reload={load} runWrite={runWrite} onChanged={onChanged} notify={notify} />}
      </aside>
    </>
  );
}

function CaseBody({ c, reload, runWrite, onChanged, notify }) {
  const a = c.analysis;
  const [decision, setDecision] = useState(a?.recommendation ?? "FIGHT");
  const [notes, setNotes] = useState(a?.draft_notes ?? "");
  const [check, setCheck] = useState(a ? a.guard : null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(null);
  const [serverErrors, setServerErrors] = useState(null);
  const bodyRef = useRef(null);

  const acted = !!c.submission || c.phase === "RESOLVED";
  const canAct = c.paypal.links.includes(decision === "FIGHT" ? "provide_evidence" : "accept_claim");

  // Switching decision swaps in a matching default note (the AI's draft for its own recommendation).
  const choose = (d) => {
    setDecision(d);
    setConfirming(false);
    setServerErrors(null);
    setNotes(d === a?.recommendation ? a.draft_notes : d === "REFUND" ? "We accept this claim and are refunding the buyer in full." : a?.draft_notes ?? "");
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
    setTimeout(() => el.classList.remove("flash"), 1600);
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
    setBusy("analyze");
    try { if (await runWrite(() => api.analyze(c.id))) { await reload(); onChanged(); } }
    catch (e) { notify(e.message); }
    finally { setBusy(null); }
  };

  const due = dueLabel(c.paypalDue);
  const guardErrors = serverErrors ?? (check && !check.ok ? check.errors : null);
  const overLimit = notes.length > MAX_NOTES;

  return (
    <>
      <div className="sheet-body" ref={bodyRef}>
        <div className="meta-row">
          <span className="big-amount">{money(c.amount, c.currency)}</span>
          <Pill tone={PHASE_TONE[c.phase]}>{c.phaseLabel}</Pill>
          {due && <span className="small muted">PayPal deadline {due.date} · {due.text}</span>}
        </div>

        {c.buyerClaims.length > 0 && (
          <section className="block">
            <h3>What the buyer told PayPal <Pill tone="gray">Unverified claim</Pill></h3>
            {c.buyerClaims.map((b, i) => <p key={i} className="quote">“{b.text}”</p>)}
            <div className="quote-meta">{c.buyer} · {new Date(c.buyerClaims[0].date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</div>
          </section>
        )}

        {a ? <Verdict a={a} c={c} onRerun={rerun} busy={busy === "analyze"} /> : <div className="block"><div className="skeleton" style={{ height: 120 }} /><p className="small muted">Analyzing this dispute…</p></div>}

        {a && (a.injection_detected || a.unverified_buyer_claims.length > 0 || a.warnings.length > 0) && (
          <section className="block">
            <h3>Watch-outs</h3>
            <ul className="notes-list">
              {a.injection_detected && <li><span className="warn-ico"><Icon name="alert" /></span><span>The buyer's text tried to give the AI instructions. They were ignored.</span></li>}
              {a.unverified_buyer_claims.map((u) => <li key={u}><span className="bad-ico"><Icon name="x" /></span><span>{u}.</span></li>)}
              {a.warnings.map((w) => <li key={w}><span className="warn-ico"><Icon name="alert" /></span><span>{w}</span></li>)}
            </ul>
          </section>
        )}

        {a?.reasoning.length > 0 && (
          <section className="block">
            <h3>Why</h3>
            <ol className="reasons">
              {a.reasoning.map((r, i) => (
                <li key={i}><span className="num">{i + 1}</span><span>{r.point}<Cites ids={r.source_ids} onCite={flash} /></span></li>
              ))}
            </ol>
          </section>
        )}

        {a?.contradictions.length > 0 && (
          <section className="block">
            <h3>Buyer's claim vs your records</h3>
            {a.contradictions.map((x, i) => (
              <div className="versus" key={i}>
                <div><div className="label">Buyer says</div>{x.buyer_claim}</div>
                <div><div className="label">Your records</div>{x.seller_fact}<Cites ids={x.source_ids} onCite={flash} /></div>
              </div>
            ))}
          </section>
        )}

        {a?.mandate && (
          <section className="block">
            <h3>AI-agent purchase mandate <Pill tone={a.mandate.within ? "green" : "red"}>{a.mandate.within ? "Within mandate" : "Mandate exceeded"}</Pill></h3>
            <ul className="checks">
              {a.mandate.checks.map((m) => (
                <li key={m.label}>
                  <span className={m.ok ? "ok-ico" : "bad-ico"}><Icon name={m.ok ? "check" : "x"} /></span>
                  <span>{m.label}<div className="detail">{m.detail}</div></span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {a?.evidence.length > 0 && (
          <section className="block">
            <h3>Evidence</h3>
            <ul className="checks">
              {a.evidence.map((e) => (
                <li key={e.requirement}>
                  <span className={e.status === "have" ? "ok-ico" : e.status === "weak" ? "warn-ico" : "bad-ico"}><Icon name={e.status === "have" ? "check" : e.status === "weak" ? "alert" : "x"} /></span>
                  <span>{e.requirement}<Cites ids={e.source_ids} onCite={flash} /></span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {a && (
          <section className="block">
            <h3>
              {acted ? "Your response" : decision === "FIGHT" ? "Your response to PayPal" : "Note to PayPal"}
              {!acted && (
                <div className="segmented" role="group" aria-label="Decision">
                  <button aria-pressed={decision === "FIGHT"} onClick={() => choose("FIGHT")}>Fight</button>
                  <button aria-pressed={decision === "REFUND"} onClick={() => choose("REFUND")}>Refund</button>
                </div>
              )}
            </h3>
            {acted ? (
              <Done c={c} />
            ) : (
              <>
                <textarea className="editor" value={notes} onChange={(e) => { setNotes(e.target.value); setConfirming(false); setServerErrors(null); }} aria-label="Response to PayPal" spellCheck />
                <div className="editor-meta">
                  {guardErrors ? <span className="bad-ico">Fix the issues below before sending</span>
                    : check?.ok ? <span className="guard-ok"><Icon name="check" size={14} /> {check.verified} fact{check.verified === 1 ? "" : "s"} verified against your records</span>
                      : <span>Checking facts…</span>}
                  <span className={overLimit ? "bad-ico" : ""}>{notes.length.toLocaleString()} / {MAX_NOTES.toLocaleString()}</span>
                </div>
                {guardErrors && <ul className="guard-errors" role="alert">{guardErrors.map((e) => <li key={e}>{e}</li>)}</ul>}
              </>
            )}
          </section>
        )}

        <Records records={c.records} />

        <section className="block">
          <details className="disclosure">
            <summary>PayPal details and activity</summary>
            <dl className="kv">
              <dt>Dispute</dt><dd className="mono">{c.id}</dd>
              <dt>Status</dt><dd>{c.paypal.status}</dd>
              <dt>Stage</dt><dd>{c.paypal.stage}</dd>
              <dt>Allowed actions</dt><dd>{c.paypal.links.filter((l) => l !== "self").join(", ") || "none"}</dd>
              <dt>Evidence requested</dt><dd>{c.requestedFromSeller.join(", ") || "—"}</dd>
              {c.paypal.outcome && (<><dt>Outcome</dt><dd>{c.paypal.outcome.outcome_code}</dd></>)}
              {a && (<><dt>AI</dt><dd>{a.provider === "openai" ? a.model : "Deterministic demo model"}{a.fallback ? ` (fallback: ${a.fallback})` : ""} · {a.latencyMs} ms</dd></>)}
            </dl>
            {c.audit.length > 0 && <ul className="audit" style={{ marginTop: 12 }}>{c.audit.map((x, i) => <li key={i}><span className="faint">{new Date(x.at).toLocaleString()}</span> · {x.event.replace(/_/g, " ")}</li>)}</ul>}
          </details>
        </section>
      </div>

      {a && !acted && (
        <footer className="sheet-foot">
          <span className="grow">
            {!canAct ? "PayPal isn't accepting this action on this dispute right now."
              : confirming ? (decision === "FIGHT" ? "This sends your response and evidence packet to PayPal." : `This refunds ${money(c.amount, c.currency)} to the buyer through PayPal.`)
                : "Review the response, then send it."}
          </span>
          {confirming && <button className="btn btn-secondary btn-lg" onClick={() => setConfirming(false)}>Cancel</button>}
          <button
            className={`btn btn-lg ${decision === "FIGHT" ? "btn-primary" : "btn-orange"}`}
            onClick={submit}
            disabled={!canAct || busy !== null || overLimit || !notes.trim() || (decision === "FIGHT" && !!guardErrors)}
          >
            {busy === "submit" ? "Sending…" : confirming ? "Confirm and send" : decision === "FIGHT" ? "Submit evidence" : `Refund ${money(c.amount, c.currency)}`}
          </button>
        </footer>
      )}
    </>
  );
}

function Verdict({ a, c, onRerun, busy }) {
  const fight = a.recommendation === "FIGHT";
  const pct = Math.round(a.win_probability * 100);
  return (
    <section className={`verdict ${fight ? "fight" : "refund"}`} aria-label="AI recommendation">
      <div className="verdict-label">
        <Icon name="sparkle" size={14} /> AI recommendation
        <Pill tone="gray">{a.provider === "openai" ? "GPT-5.6 Luna" : "Demo AI"}</Pill>
        {a.fallback && <Pill tone="orange" title={`The configured model failed (${a.fallback}); the demo model answered.`}>Fallback</Pill>}
        <span style={{ flex: 1 }} />
        <button className="btn btn-plain small" onClick={onRerun} disabled={busy}>{busy ? "Re-running…" : "Re-run"}</button>
      </div>
      <div className="verdict-word">{fight ? "Fight it." : "Refund it."}</div>
      <p className="verdict-summary">{a.summary}</p>
      <div className="verdict-stats">
        <div className="vstat">
          <div className="vstat-value">{bandWord(a.confidence_band)}</div>
          <div className="vstat-label">Chance to win · {pct}%</div>
          <div className="meter"><span style={{ width: `${pct}%` }} /></div>
        </div>
        <div className="vstat">
          <div className="vstat-value" style={{ color: fight && a.ev.fight > 0 ? "var(--green)" : "var(--text-2)" }}>{signedMoney(a.ev.fight)}</div>
          <div className="vstat-label">Expected value of fighting</div>
        </div>
        <div className="vstat">
          <div className="vstat-value">{a.partial_refund_suggestion != null ? money(a.partial_refund_suggestion) : money(c.amount, c.currency)}</div>
          <div className="vstat-label">{a.partial_refund_suggestion != null ? "Suggested partial refund" : "Disputed amount"}</div>
        </div>
      </div>
      <div className="safety" style={{ marginTop: 14 }}>
        <Pill tone={a.guard.ok ? "green" : "red"}><Icon name={a.guard.ok ? "check" : "x"} size={12} /> {a.guard.ok ? (a.guard.verified ? `Draft fact-checked · ${a.guard.verified} facts` : "Draft fact-checked") : "Draft needs fixes"}</Pill>
        {a.injection_detected && <Pill tone="orange"><Icon name="alert" size={12} /> Injection ignored</Pill>}
        {a.mandate && <Pill tone="purple"><Icon name="bot" size={12} /> AI-agent purchase</Pill>}
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
    <div className="done-panel">
      <div className="big-check"><Icon name={pending ? "refresh" : "check"} size={26} stroke={2.4} /></div>
      <h4>{pending ? "Waiting for PayPal to confirm" : refund ? "Refund sent" : c.phase === "RESOLVED" ? "Dispute resolved" : "Evidence submitted"}</h4>
      <p className="small muted" style={{ margin: 0 }}>
        {c.phase === "RESOLVED" ? `PayPal outcome: ${c.paypal.outcome?.outcome_code ?? "resolved"}.` : `PayPal status: ${c.paypal.status.replace(/_/g, " ").toLowerCase()}.`}
      </p>
    </div>
  );
}

const IMG = /^\/store\/[\w.-]+\.(png|jpe?g|webp|svg)$/i;

function Records({ records }) {
  if (!records.length) return null;
  return (
    <section className="block">
      <h3>Your records <span className="faint small">{records.length} items</span></h3>
      <div className="records">
        {records.map((r) => (
          <article key={r.id} className="record" data-record={r.id}>
            <div className="record-head">
              <span className="record-title">{r.title}</span>
              {r.data.from === "buyer" && <Pill tone="gray">Written by buyer</Pill>}
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
  const entries = Object.entries(data).filter(([k, v]) => v !== null && v !== undefined && !(Array.isArray(v) && !v.length) && !["from", "untrusted_attachment", "seller_replied"].includes(k));
  const photos = entries.flatMap(([, v]) => [].concat(v)).filter((v) => typeof v === "string" && IMG.test(v));
  return (
    <>
      <dl className="kv">
        {entries.filter(([, v]) => ![].concat(v).some((x) => typeof x === "string" && IMG.test(x))).map(([k, v]) => (
          <div key={k} style={{ display: "contents" }}>
            <dt>{k.replace(/_/g, " ")}</dt>
            <dd>{fmt(v)}</dd>
          </div>
        ))}
      </dl>
      {photos.length > 0 && (
        <div className="photos" style={{ marginTop: 10 }}>
          {photos.map((p) => <a key={p} href={p} target="_blank" rel="noreferrer" className={untrusted ? "untrusted" : ""}><Photo src={p} /></a>)}
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
