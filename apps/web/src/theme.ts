// Theme (light/dark) and accent palette: applied as data attributes on <html>, remembered per browser.
import { useCallback, useEffect, useState } from "react";

export const PALETTES = [
  { id: "signal", label: "Signal", color: "#ec3013" },
  { id: "cobalt", label: "Cobalt", color: "#2450e6" },
  { id: "forest", label: "Forest", color: "#1f8a4c" },
  { id: "violet", label: "Violet", color: "#6d3ae0" },
  { id: "amber", label: "Amber", color: "#d97a00" },
] as const;
export type Palette = (typeof PALETTES)[number]["id"];
export type Theme = "light" | "dark";
/** "cards": separate rounded cards (default). "grid": the original flat Modernist grid with 2px rules. */
export type Look = "cards" | "grid";

function read<T extends string>(key: string, allowed: readonly string[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    if (v && allowed.includes(v)) return v as T;
  } catch {
    // storage unavailable (private mode, blocked): fall back
  }
  return fallback;
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

const systemTheme = (): Theme => (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light");

export function useAppearance() {
  const [theme, setThemeState] = useState<Theme>(() => read("qwa.theme", ["light", "dark"], systemTheme()));
  const [palette, setPaletteState] = useState<Palette>(() => read("qwa.palette", PALETTES.map((p) => p.id), "signal"));
  const [look, setLookState] = useState<Look>(() => read("qwa.look", ["cards", "grid"], "cards"));
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.palette = palette;
    document.documentElement.dataset.look = look;
  }, [theme, palette, look]);
  const setTheme = useCallback((t: Theme) => { write("qwa.theme", t); setThemeState(t); }, []);
  const setPalette = useCallback((p: Palette) => { write("qwa.palette", p); setPaletteState(p); }, []);
  const setLook = useCallback((l: Look) => { write("qwa.look", l); setLookState(l); }, []);
  return { theme, palette, look, setTheme, setPalette, setLook };
}
