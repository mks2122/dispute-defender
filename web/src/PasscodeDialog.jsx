import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { Icon } from "./ui.jsx";

export default function PasscodeDialog({ onCancel, onSuccess, reason }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    // Capture phase + stopImmediatePropagation: Esc closes only this dialog, never the case sheet underneath.
    const onKey = (e) => { if (e.key === "Escape") { e.stopImmediatePropagation(); onCancel(); } };
    window.addEventListener("keydown", onKey, true);
    const opener = document.activeElement;
    // Everything behind the dialog is inert: the sheet if one is open, otherwise the page.
    const behind = document.querySelector(".sheet") ? [document.querySelector(".sheet")] : [...document.querySelectorAll(".shell > .sidebar, .shell > .main")];
    behind.forEach((el) => { el.inert = true; });
    return () => {
      mounted.current = false;
      window.removeEventListener("keydown", onKey, true);
      behind.forEach((el) => { el.inert = false; });
      if (opener instanceof HTMLElement && document.contains(opener)) opener.focus();
    };
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
        <h3 id="pc-title">Enter your passcode</h3>
        <p>{reason === "view" ? "This workspace is private. Enter the passcode to see your disputes." : "Actions that change a PayPal dispute need the passcode from the project's Devpost page."}</p>
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
