// Light/dark theme. Light is the default; the seller's choice from the toggle is remembered per browser.
// index.html applies the saved choice before first paint, so this hook only keeps React in step with it.
import { useCallback, useState } from "react";

const KEY = "dd-theme";
const savedChoice = () => {
  try {
    return localStorage.getItem(KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light"; // storage blocked (private mode, policies): light
  }
};

export function useTheme() {
  const [theme, setTheme] = useState(savedChoice);
  const toggle = useCallback(() => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // storage blocked: the choice lasts for this visit only
    }
    setTheme(next);
  }, [theme]);

  return { theme, toggle };
}
