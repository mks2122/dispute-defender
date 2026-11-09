import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";

export default function PasscodeDialog({ onCancel, onSuccess }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(value);
      await onSuccess(); // unmounts this dialog
    } catch (err) {
      if (mounted.current) setError(err.message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <div className="drawer-backdrop center" onClick={onCancel}>
      <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>Demo passcode</h3>
        <p className="muted">Actions that change PayPal disputes need the passcode from the project's Devpost page.</p>
        <input autoFocus type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Passcode" aria-label="Passcode" />
        {error && <div className="form-error">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy || !value}>{busy ? "Checking…" : "Continue"}</button>
        </div>
      </form>
    </div>
  );
}
