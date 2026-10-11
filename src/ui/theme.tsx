import { useEffect, useState } from "react";

const KEY = "hemi-btc-theme";
export type ThemeName = "dark" | "light";

export function applyTheme(theme: ThemeName) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "light" ? "#f3eee7" : "#09090b");
}

function initialTheme(): ThemeName {
  const current = document.documentElement.dataset.theme;
  if (current === "light" || current === "dark") return current;
  return "dark";
}

export function useTheme() {
  const [theme, setTheme] = useState<ThemeName>(initialTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  function choose(next: ThemeName) {
    if (next === theme) return;
    localStorage.setItem(KEY, next);
    setTheme(next);
  }

  return { theme, choose };
}
