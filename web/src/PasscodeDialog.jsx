import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { Icon } from "./ui.jsx";

export default function PasscodeDialog({ onCancel, onSuccess }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const onKey = (e) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => { mounted.current = false; window.removeEventListener("keydown", onKey); };
  }, [onCancel]);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(value);
      onSuccess(); // unmounts this dialog
    } catch (err) {
      if (mounted.current) setError(err.message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <div className="scrim center" onClick={onCancel}>
      <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="pc-title">
        <div className="dialog-icon"><Icon name="lock" size={24} /></div>
        <h3 id="pc-title">Enter the demo passcode</h3>
        <p>Actions that change a PayPal dispute need the passcode from the project's Devpost page.</p>
        <input autoFocus type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Passcode" aria-label="Passcode" autoComplete="current-password" />
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary btn-lg" onClick={onCancel}>Cancel</button>
          <button type="submit" className="btn btn-primary btn-lg" disabled={busy || !value}>{busy ? "Checking…" : "Continue"}</button>
        </div>
      </form>
    </div>
  );
}
