// Light/dark theme. Follows the system until the seller picks one; the choice is remembered per browser.
// index.html applies the saved choice before first paint, so this hook only keeps React in step with it.
import { useCallback, useEffect, useState } from "react";

const KEY = "dd-theme";
const query = () => window.matchMedia?.("(prefers-color-scheme: dark)") ?? null;
const savedChoice = () => {
  try {
    const t = localStorage.getItem(KEY);
    return t === "light" || t === "dark" ? t : null;
  } catch {
    return null; // storage blocked (private mode, policies): follow the system
  }
};

export function useTheme() {
  const [choice, setChoice] = useState(savedChoice);
  const [systemDark, setSystemDark] = useState(() => query()?.matches ?? false);

  useEffect(() => {
    const mq = query();
    if (!mq) return undefined;
    const onChange = (e) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const theme = choice ?? (systemDark ? "dark" : "light");
  const toggle = useCallback(() => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // storage blocked: the choice lasts for this visit only
    }
    setChoice(next);
  }, [theme]);

  return { theme, toggle };
}
