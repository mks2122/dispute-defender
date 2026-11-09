export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error ?? `Request failed (${status})`);
    this.status = status;
    this.needsPasscode = !!body?.needsPasscode;
    this.errors = body?.errors ?? null;
    this.issue = body?.issue ?? null;
  }
}

async function request(method, path, body, { signal } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data);
  return { ...data, httpStatus: res.status };
}

const enc = encodeURIComponent;
export const api = {
  disputes: () => request("GET", "/disputes"),
  dispute: (id) => request("GET", `/disputes/${enc(id)}`),
  session: () => request("GET", "/session"),
  login: (passcode) => request("POST", "/session", { passcode }),
  reset: () => request("POST", "/admin/reset"),
  analyze: (id) => request("POST", `/disputes/${enc(id)}/analyze`),
  validate: (id, notes, signal) => request("POST", `/disputes/${enc(id)}/validate`, { notes }, { signal }),
  submit: (id, body) => request("POST", `/disputes/${enc(id)}/submit`, body),
};
