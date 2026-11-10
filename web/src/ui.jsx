// Shared UI primitives: a small line-icon set (inline SVG), status, thumbnails, formatters.
import { useState } from "react";

const paths = {
  shield: "M12 3 4.5 6v6c0 4.6 3.2 8.6 7.5 9.7 4.3-1.1 7.5-5.1 7.5-9.7V6z",
  check: "m5 12.5 4.5 4.5L19 7.5",
  x: "M6 6l12 12M18 6 6 18",
  alert: "M12 9v4m0 3.5v.01M10.3 3.9 2.6 17.2A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.8L13.7 3.9a2 2 0 0 0-3.4 0z",
  box: "M21 8 12 3 3 8m18 0v8l-9 5m9-13-9 5m0 8-9-5V8m9 5L3 8",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
  lock: "M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z",
  bot: "M12 4v3m-6 3h12a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2zm3 4h.01M15 14h.01",
  overview: "M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z",
  list: "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01",
  inbox: "M4 13h4l2 3h4l2-3h4M4 13l2-8h12l2 8v6H4z",
  done: "M20 6 9 17l-5-5",
  activity: "M3 12h4l3-8 4 16 3-8h4",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7.4-3a7.4 7.4 0 0 0-.1-1.3l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2.2-1.3L14.4 3h-4l-.4 2.4a7.6 7.6 0 0 0-2.2 1.3l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.6l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 2.2 1.3l.4 2.4h4l.4-2.4a7.6 7.6 0 0 0 2.2-1.3l2.4 1 2-3.4-2-1.6c.1-.4.1-.9.1-1.3z",
  menu: "M4 6h16M4 12h16M4 18h16",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zm9 2-4.3-4.3",
  arrow: "M9 6l6 6-6 6",
  doc: "M7 3h7l5 5v13H7zM14 3v5h5",
  sun: "M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  moon: "M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm0-10v5m0-8.5v.01",
};

/** Brand mark: a "D" whose bowl tapers to a shield's point (Dispute Defender). Also in public/favicon.svg. */
export const LOGO_PATH = "M5 3h7.2C16.5 3 19 5.6 19 9.6v1.6c0 4.9-3.3 8.6-7.8 9.8L5 22zM8.4 6.4v11.2l2.6-1C13.9 15.5 15.6 13.6 15.6 11V9.8c0-2.2-1.3-3.4-3.6-3.4z";
export function LogoMark({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d={LOGO_PATH} fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}

export function Icon({ name, size = 16, stroke = 1.8, className = "", title }) {
  return (
    <svg className={`ico ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : true} role={title ? "img" : undefined}>
      {title && <title>{title}</title>}
      <path d={paths[name]} />
    </svg>
  );
}

/** Dispute state: a dot shape plus a text label (never colour alone). */
export const Status = ({ phase, label }) => <span className={`status s-${phase}`}><span className="dot" />{label}</span>;

export const Badge = ({ tone, children, title }) => <span className={`badge ${tone ? `badge-${tone}` : ""}`} title={title}>{children}</span>;

export function Thumb({ src, alt = "" }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) return <div className="thumb-fallback"><Icon name="box" size={16} /></div>;
  return <img className="thumb" src={src} alt={alt} loading="lazy" onError={() => setBroken(true)} />;
}

export const money = (n, cur = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: cur, maximumFractionDigits: Number.isInteger(n) ? 0 : 2 }).format(n);
export const signedMoney = (n) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${money(Math.abs(n))}`;

export function dueLabel(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  const days = Math.ceil((d - Date.now()) / 864e5);
  return { date: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }), days, text: days < 0 ? "overdue" : days === 0 ? "due today" : `${days}d left` };
}

export function timeAgo(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const verdictWord = (rec) => (rec === "FIGHT" ? "Fight" : "Refund");
export const bandWord = (b) => ({ high: "High", medium: "Medium", low: "Low" })[b] ?? b;
export const NEEDS = (r) => r.phase === "ACTION_NEEDED";
export const RESPONDED = (r) => ["SUBMITTING", "SUBMITTED", "RESOLVED"].includes(r.phase);

/**
 * Queue order: fights by expected value, then refunds by amount (quick to clear), then disputes still
 * waiting for records or analysis. A refund is never ranked by the value of a fight it advises against.
 */
export const priority = (r) => {
  if (r.ai?.recommendation === "FIGHT") return 2e6 + r.ai.ev;
  if (r.ai?.recommendation === "REFUND") return 1e6 + r.amount;
  return r.amount;
};
export const byPriority = (a, b) => priority(b) - priority(a);

/** A fight whose expected value is positive but small: worth flagging as a judgement call. */
export const isCloseCall = (ai, amount) => ai?.recommendation === "FIGHT" && ai.ev > 0 && ai.ev < Math.max(5, 0.15 * amount);
