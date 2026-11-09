// Small shared UI primitives and SF-style line icons (inline SVG, no icon font).
import { useState } from "react";

const paths = {
  shield: "M12 3 4.5 6v6c0 4.6 3.2 8.6 7.5 9.7 4.3-1.1 7.5-5.1 7.5-9.7V6z",
  check: "m5 12.5 4.5 4.5L19 7.5",
  x: "M6 6l12 12M18 6 6 18",
  alert: "M12 8v5m0 3.5v.01M10.3 3.9 2.6 17.2A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.8L13.7 3.9a2 2 0 0 0-3.4 0z",
  sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z",
  box: "M21 8 12 3 3 8m18 0v8l-9 5m9-13-9 5m0 8-9-5V8m9 5L3 8",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
  lock: "M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z",
  bot: "M12 4v3m-6 3h12a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2zm3 4h.01M15 14h.01",
  quote: "M7 7h4v4c0 3-2 5-4 6m6-10h4v4c0 3-2 5-4 6",
};

export function Icon({ name, size = 16, stroke = 2, className = "", title }) {
  return (
    <svg className={`ico ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : true} role={title ? "img" : undefined}>
      {title && <title>{title}</title>}
      <path d={paths[name]} />
    </svg>
  );
}

export const Pill = ({ tone = "gray", children, title }) => <span className={`pill pill-${tone}`} title={title}>{children}</span>;

export function Thumb({ src, size, alt = "" }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) return <div className="thumb-fallback" style={size ? { width: size, height: size } : undefined}><Icon name="box" size={18} /></div>;
  return <img className="thumb" src={src} alt={alt} loading="lazy" onError={() => setBroken(true)} style={size ? { width: size, height: size } : undefined} />;
}

export const money = (n, cur = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: cur, maximumFractionDigits: Number.isInteger(n) ? 0 : 2 }).format(n);

export const signedMoney = (n) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${money(Math.abs(n))}`;

export function dueLabel(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  const days = Math.ceil((d - Date.now()) / 864e5);
  return { date: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }), days, text: days < 0 ? "Overdue" : days === 0 ? "Due today" : `${days} days left` };
}

export const PHASE_TONE = { ACTION_NEEDED: "orange", PROCESSING: "gray", SUBMITTING: "blue", SUBMITTED: "blue", RESOLVED: "green" };
export const verdictTone = (rec) => (rec === "FIGHT" ? "green" : "orange");
export const verdictWord = (rec) => (rec === "FIGHT" ? "Fight" : "Refund");
export const bandWord = (b) => ({ high: "High", medium: "Medium", low: "Low" })[b] ?? b;
