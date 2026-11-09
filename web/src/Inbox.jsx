import { useMemo } from "react";
import { AgGridReact } from "ag-grid-react";
import { themeQuartz } from "ag-grid-community";
import { money, dueLabel } from "./api.js";

const theme = themeQuartz.withParams({
  fontFamily: "Inter, system-ui, sans-serif",
  fontSize: 14,
  accentColor: "#0070e0",
  foregroundColor: "#0b1b33",
  headerBackgroundColor: "#f5f7fa",
  headerTextColor: "#4a5a70",
  headerFontWeight: 600,
  borderColor: "#e3e8ef",
  rowBorder: { color: "#eef1f5" },
  rowHoverColor: "#f2f7fd",
  selectedRowBackgroundColor: "#e6f0fc",
  wrapperBorderRadius: 12,
  spacing: 7,
});

const PHASE_ORDER = { ACTION_NEEDED: 0, PROCESSING: 1, SUBMITTED: 2, RESOLVED: 3 };

function ItemCell({ data }) {
  return (
    <div className="cell-item">
      <div className="cell-item-title">{data.item}</div>
      <div className="cell-item-sub">
        {data.buyer}
        {data.tags.map((t) => <span key={t} className={`tag tag-${t.replace(/\s/g, "-")}`}>{t}</span>)}
      </div>
    </div>
  );
}

const PhaseCell = ({ data }) => <span className={`pill phase-${data.phase}`}>{data.phaseLabel}</span>;

function DueCell({ value }) {
  const d = dueLabel(value);
  if (!d) return <span className="muted">Not set yet</span>;
  return <span className={d.days <= 2 ? "due-urgent" : ""} title="Deadline set by PayPal">{d.text}</span>;
}

const ActionsCell = ({ value }) =>
  value?.length ? (
    <div className="chips">
      {value.includes("provide_evidence") && <span className="chip">Submit evidence</span>}
      {value.includes("accept_claim") && <span className="chip">Refund</span>}
      {value.includes("adjudicate") && <span className="chip chip-sandbox">Sandbox: settle</span>}
    </div>
  ) : <span className="muted">—</span>;

const AiCell = ({ data }) =>
  data.ai ? <span className={`pill verdict-${data.ai.recommendation}`}>{data.ai.recommendation}</span> : <span className="muted">Not analyzed</span>;

export default function Inbox({ rows, loading, onOpen, selectedId }) {
  const columnDefs = useMemo(() => [
    { headerName: "Order", field: "item", flex: 2, minWidth: 210, cellRenderer: ItemCell, autoHeight: true },
    { headerName: "Reason", field: "reasonLabel", flex: 1.2, minWidth: 150 },
    {
      headerName: "At risk", field: "atRisk", flex: 0.8, minWidth: 110, sort: "desc", type: "rightAligned",
      valueFormatter: (p) => money(p.value, p.data.currency), cellClass: "num strong",
    },
    {
      headerName: "Status", field: "phase", flex: 1.3, minWidth: 180, cellRenderer: PhaseCell,
      comparator: (a, b) => PHASE_ORDER[a] - PHASE_ORDER[b],
    },
    { headerName: "PayPal deadline", field: "paypalDue", flex: 1, minWidth: 140, cellRenderer: DueCell },
    { headerName: "AI verdict", field: "ai", flex: 0.9, minWidth: 120, cellRenderer: AiCell, sortable: false },
    { headerName: "You can", field: "actions", flex: 1.5, minWidth: 200, cellRenderer: ActionsCell, sortable: false },
    { headerName: "Dispute ID", field: "id", flex: 1, minWidth: 160, cellClass: "mono muted" },
  ], []);

  if (!loading && rows.length === 0) {
    return (
      <div className="empty">
        <h2>No disputes in the inbox yet</h2>
        <p>New sandbox disputes take about 5 minutes before PayPal lets a seller respond. They'll appear here automatically.</p>
      </div>
    );
  }

  return (
    <div className="grid-wrap">
      <AgGridReact
        theme={theme}
        rowData={rows}
        columnDefs={columnDefs}
        defaultColDef={{ sortable: true, resizable: true, suppressMovable: true, cellDataType: false }}
        getRowId={(p) => p.data.id}
        loading={loading}
        onRowClicked={(e) => onOpen(e.data.id)}
        rowClass="clickable"
        getRowStyle={(p) => (p.data.id === selectedId ? { background: "var(--row-selected)" } : undefined)}
        domLayout="autoHeight"
        animateRows
      />
    </div>
  );
}
