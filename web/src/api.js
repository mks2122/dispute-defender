export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error ?? `Request failed (${status})`);
    this.status = status;
    this.needsPasscode = !!body?.needsPasscode;
  }
}

async function request(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const api = {
  disputes: () => request("GET", "/disputes"),
  dispute: (id) => request("GET", `/disputes/${encodeURIComponent(id)}`),
  session: () => request("GET", "/session"),
  login: (passcode) => request("POST", "/session", { passcode }),
  reset: () => request("POST", "/admin/reset"),
};

export const money = (n, cur = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: cur, maximumFractionDigits: n % 1 ? 2 : 0 }).format(n);

export function dueLabel(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  const days = Math.ceil((d - Date.now()) / 864e5);
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return { date, days, text: days < 0 ? `${date} · overdue` : `${date} · ${days}d left` };
}
