import { useMemo, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import { themeQuartz } from "ag-grid-community";
import { Icon, Status, Thumb, money, signedMoney, dueLabel, verdictWord, bandWord } from "./ui.jsx";

// Neutral grid theme driven by the app's CSS variables (light and dark follow the system).
const theme = themeQuartz.withParams({
  fontFamily: "inherit",
  fontSize: 13,
  backgroundColor: "var(--panel)",
  foregroundColor: "var(--text)",
  accentColor: "var(--text-3)",
  borderColor: "var(--line-soft)",
  headerBackgroundColor: "var(--panel)",
  headerTextColor: "var(--text-2)",
  headerFontSize: 12,
  headerFontWeight: 500,
  rowHoverColor: "var(--subtle)",
  selectedRowBackgroundColor: "var(--subtle)",
  wrapperBorder: false,
  wrapperBorderRadius: 0,
  columnBorder: false,
  headerColumnBorder: false,
  headerColumnResizeHandleColor: "transparent",
  rowBorder: { color: "var(--line-soft)" },
  cellHorizontalPadding: 16,
  rowHeight: 56,
  headerHeight: 40,
});

const PHASE_ORDER = { ACTION_NEEDED: 0, SUBMITTING: 1, PROCESSING: 2, SUBMITTED: 3, RESOLVED: 4 };

// The order name is a real button so rows can be opened from the keyboard (Tab + Enter).
const OrderCell = ({ data, context }) => (
  <div className="cell-order">
    <Thumb src={data.image} />
    <div className="cell-stack">
      <button className="cell-title link-btn" onClick={(e) => { e.stopPropagation(); context.onOpen(data.id); }}>{data.item}</button>
      <div className="cell-sub">{data.buyer}{data.tags.includes("agent purchase") && <span className="badge">AI agent</span>}</div>
    </div>
  </div>
);
const VerdictCell = ({ data }) => (
  <div className="cell-center">
    {data.ai ? <><span className={`verdict-text ${data.ai.recommendation === "REFUND" ? "refund" : ""}`}>{verdictWord(data.ai.recommendation)}</span><span className="faint">· {bandWord(data.ai.band)}</span></> : <span className="faint">Analyzing…</span>}
    {data.ai?.injection && <span className="warn-text" title="The buyer's text tried to instruct the AI; ignored"><Icon name="alert" size={14} /></span>}
  </div>
);
const EvCell = ({ data }) => (data.ai && data.phase !== "RESOLVED"
  ? <div className="cell-center"><span className={data.ai.recommendation === "FIGHT" && data.ai.ev > 0 ? "ev-pos" : "ev-neg"}>{signedMoney(data.ai.ev)}</span></div>
  : <div className="cell-center faint">—</div>);
const StatusCell = ({ data }) => <div className="cell-center"><Status phase={data.phase} label={data.phaseLabel} /></div>;
const DueCell = ({ value }) => {
  const d = dueLabel(value);
  return d ? <div className="cell-center"><span>{d.date}</span><span className="faint">· {d.text}</span></div> : <div className="cell-center faint">—</div>;
};

export default function DisputesPage({ title, rows, preset, loading, onOpen, selectedId }) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter(preset).filter((r) => !needle || `${r.item} ${r.buyer} ${r.reasonLabel} ${r.id}`.toLowerCase().includes(needle));
  }, [rows, preset, q]);

  const columnDefs = useMemo(() => [
    { headerName: "Order", field: "item", flex: 2.4, minWidth: 240, cellRenderer: OrderCell },
    { headerName: "Reason", field: "reasonLabel", flex: 1.2, minWidth: 140 },
    { headerName: "Amount", field: "amount", flex: 0.8, minWidth: 96, valueFormatter: (p) => money(p.value, p.data.currency), cellClass: "num" },
    { headerName: "AI verdict", field: "ai", flex: 1.2, minWidth: 150, cellRenderer: VerdictCell, comparator: (a, b) => (a?.ev ?? 0) - (b?.ev ?? 0) },
    { headerName: "Value", headerTooltip: "Expected value of fighting: win chance × amount − your time", field: "ai", colId: "ev", flex: 0.9, minWidth: 110, cellRenderer: EvCell, comparator: (a, b) => (a?.ev ?? -1e9) - (b?.ev ?? -1e9), sort: "desc" },
    { headerName: "Status", field: "phase", flex: 1.3, minWidth: 170, cellRenderer: StatusCell, comparator: (a, b) => PHASE_ORDER[a] - PHASE_ORDER[b] },
    { headerName: "PayPal deadline", field: "paypalDue", flex: 1.1, minWidth: 140, cellRenderer: DueCell },
  ], []);

  return (
    <>
      <div className="page-head">
        <div>
          <h2>{title}</h2>
          <p>{shown.length} dispute{shown.length === 1 ? "" : "s"}, sorted by the value of responding.</p>
        </div>
        <label className="search-wrap toolbar-row">
          <span className="sr-only">Search disputes</span>
          <Icon name="search" size={14} />
          <input className="search" type="search" placeholder="Search order, buyer, reason" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
      </div>

      <section className="card table-card">
        {!loading && shown.length === 0 ? (
          <div className="empty"><h3>No disputes</h3>{q ? "Nothing matches your search." : "Nothing in this view right now."}</div>
        ) : (
          <>
            <div className="table-grid">
              <AgGridReact
                theme={theme}
                rowData={shown}
                columnDefs={columnDefs}
                defaultColDef={{ sortable: true, resizable: false, suppressMovable: true, cellDataType: false }}
                getRowId={(p) => p.data.id}
                context={{ onOpen }}
                loading={loading}
                onRowClicked={(e) => onOpen(e.data.id)}
                rowClass="clickable"
                getRowStyle={(p) => (p.data.id === selectedId ? { background: "var(--subtle)" } : undefined)}
                domLayout="autoHeight"
                suppressCellFocus
              />
            </div>
            <div className="cards-list" role="list">
              {[...shown].sort((a, b) => (b.ai?.ev ?? -1e9) - (a.ai?.ev ?? -1e9)).map((r) => (
                <button key={r.id} className="dcard" role="listitem" onClick={() => onOpen(r.id)}>
                  <Thumb src={r.image} />
                  <span style={{ minWidth: 0 }}>
                    <div className="row-title">{r.item}</div>
                    <div className="meta"><span>{r.reasonLabel}</span><Status phase={r.phase} label={r.phaseLabel} /></div>
                  </span>
                  <span className="row-right">
                    <div className="num">{money(r.amount, r.currency)}</div>
                    <div className="small muted">{r.ai ? verdictWord(r.ai.recommendation) : "…"}</div>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </section>
    </>
  );
}
