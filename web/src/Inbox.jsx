import { useMemo } from "react";
import { AgGridReact } from "ag-grid-react";
import { themeQuartz } from "ag-grid-community";
import { Icon, Pill, Thumb, money, signedMoney, dueLabel, PHASE_TONE, verdictTone, verdictWord, bandWord } from "./ui.jsx";

// Minimal theme driven by the app's CSS variables, so light and dark mode follow the system.
const theme = themeQuartz.withParams({
  fontFamily: "inherit",
  fontSize: 14,
  backgroundColor: "var(--surface)",
  foregroundColor: "var(--text)",
  accentColor: "var(--accent)",
  borderColor: "var(--line)",
  headerBackgroundColor: "var(--surface)",
  headerTextColor: "var(--text-3)",
  headerFontSize: 12,
  headerFontWeight: 600,
  rowHoverColor: "var(--surface-2)",
  selectedRowBackgroundColor: "var(--accent-soft)",
  oddRowBackgroundColor: "var(--surface)",
  wrapperBorder: false,
  wrapperBorderRadius: 0,
  columnBorder: false,
  headerColumnBorder: false,
  headerColumnResizeHandleColor: "transparent",
  rowBorder: { color: "var(--line)" },
  cellHorizontalPadding: 18,
  rowHeight: 72,
  headerHeight: 44,
});

const PHASE_ORDER = { ACTION_NEEDED: 0, SUBMITTING: 1, PROCESSING: 2, SUBMITTED: 3, RESOLVED: 4 };

function OrderCell({ data }) {
  return (
    <div className="cell-order">
      <Thumb src={data.image} />
      <div className="cell-stack">
        <div className="cell-title">{data.item}</div>
        <div className="cell-sub">
          {data.buyer}
          {data.tags.includes("agent purchase") && <Pill tone="purple">AI agent</Pill>}
        </div>
      </div>
    </div>
  );
}

function VerdictCell({ data }) {
  if (!data.ai) return <div className="cell-center faint">Analyzing…</div>;
  return (
    <div className="cell-center">
      <Pill tone={verdictTone(data.ai.recommendation)}>{verdictWord(data.ai.recommendation)} · {bandWord(data.ai.band)}</Pill>
      {data.ai.injection && <span className="warn-ico" title="Prompt-injection attempt in the buyer's text was ignored"><Icon name="alert" size={15} /></span>}
    </div>
  );
}

const EvCell = ({ data }) => {
  if (!data.ai || data.phase === "RESOLVED") return <div className="cell-center faint">—</div>;
  // Green only when the AI says fight: a positive long-shot value next to "Refund" would read as advice to fight.
  return <div className="cell-center"><span className={data.ai.recommendation === "FIGHT" && data.ai.ev > 0 ? "ev-pos" : "ev-neg"}>{signedMoney(data.ai.ev)}</span></div>;
};

const StatusCell = ({ data }) => <div className="cell-center"><Pill tone={PHASE_TONE[data.phase]}>{data.phaseLabel}</Pill></div>;

function DueCell({ value }) {
  const d = dueLabel(value);
  if (!d) return <div className="cell-center faint">—</div>;
  return <div className="cell-center"><span>{d.date}</span><span className="faint small">· {d.text}</span></div>;
}

export default function Inbox({ rows, loading, onOpen, selectedId, filtered }) {
  const columnDefs = useMemo(() => [
    { headerName: "Order", field: "item", flex: 2.4, minWidth: 250, cellRenderer: OrderCell },
    { headerName: "Reason", field: "reasonLabel", flex: 1.2, minWidth: 150, cellClass: "cell-center-text" },
    { headerName: "Amount", field: "amount", flex: 0.8, minWidth: 100, valueFormatter: (p) => money(p.value, p.data.currency), cellClass: "amount" },
    { headerName: "AI verdict", field: "ai", flex: 1.3, minWidth: 160, cellRenderer: VerdictCell, comparator: (a, b) => (a?.ev ?? 0) - (b?.ev ?? 0) },
    { headerName: "Expected value", field: "ai", colId: "ev", flex: 1.1, minWidth: 150, cellRenderer: EvCell, comparator: (a, b) => (a?.ev ?? -1e9) - (b?.ev ?? -1e9), sort: "desc" },
    { headerName: "Status", field: "phase", flex: 1.3, minWidth: 170, cellRenderer: StatusCell, comparator: (a, b) => PHASE_ORDER[a] - PHASE_ORDER[b] },
    { headerName: "PayPal deadline", field: "paypalDue", flex: 1.2, minWidth: 160, cellRenderer: DueCell },
  ], []);

  if (!loading && rows.length === 0) {
    return (
      <div className="card empty">
        <h2>{filtered ? "Nothing here" : "No disputes yet"}</h2>
        <p>{filtered ? "No disputes match this filter." : "New sandbox disputes take about 5 minutes before PayPal lets a seller respond. They'll appear here automatically."}</p>
      </div>
    );
  }

  return (
    <div className="card grid-card">
      <AgGridReact
        theme={theme}
        rowData={rows}
        columnDefs={columnDefs}
        defaultColDef={{ sortable: true, resizable: false, suppressMovable: true, cellDataType: false }}
        getRowId={(p) => p.data.id}
        loading={loading}
        onRowClicked={(e) => onOpen(e.data.id)}
        rowClass="clickable"
        getRowStyle={(p) => (p.data.id === selectedId ? { background: "var(--accent-soft)" } : undefined)}
        domLayout="autoHeight"
        suppressCellFocus
        animateRows
      />
    </div>
  );
}
