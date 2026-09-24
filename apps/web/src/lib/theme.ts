// Theme choice: light, dark or system. index.html paints the stored choice
// before the bundle loads; these helpers keep it in step afterwards.

export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_KEY = "sil.theme";
export const THEME_MODES: readonly ThemeMode[] = ["light", "dark", "system"];

export function parseThemeMode(value: string | null): ThemeMode {
  return THEME_MODES.find((mode) => mode === value) ?? "system";
}

export function resolveTheme(mode: ThemeMode, systemDark: boolean): ResolvedTheme {
  if (mode === "system") return systemDark ? "dark" : "light";
  return mode;
}

const SYSTEM_DARK = "(prefers-color-scheme: dark)";

// Storage can throw when the browser blocks it. The theme then still works,
// it is only not remembered, so these two fall back instead of failing mount.
export function loadThemeMode(): ThemeMode {
  try {
    return parseThemeMode(localStorage.getItem(THEME_KEY));
  } catch {
    return "system";
  }
}

/** Puts the resolved theme on <html data-theme>, which app.css keys off. */
export function applyTheme(mode: ThemeMode): void {
  document.documentElement.dataset.theme = resolveTheme(mode, matchMedia(SYSTEM_DARK).matches);
}

export function saveThemeMode(mode: ThemeMode): void {
  applyTheme(mode);
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {
    // Not remembered across reloads; the page already shows the choice.
  }
}

/** Repaints when the OS setting flips. Returns the cleanup. */
export function watchSystemTheme(onChange: () => void): () => void {
  const query = matchMedia(SYSTEM_DARK);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
