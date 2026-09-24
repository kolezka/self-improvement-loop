// Unit tests for the theme choice helpers.

import { beforeEach, describe, expect, test } from "bun:test";
import { applyTheme, loadThemeMode, parseThemeMode, resolveTheme, saveThemeMode, THEME_KEY } from "../src/lib/theme.ts";

describe("parseThemeMode", () => {
  test("keeps a known mode", () => {
    expect(parseThemeMode("dark")).toBe("dark");
    expect(parseThemeMode("light")).toBe("light");
  });

  test("falls back to system for a missing or unknown value", () => {
    expect(parseThemeMode(null)).toBe("system");
    expect(parseThemeMode("toString")).toBe("system");
  });
});

describe("resolveTheme", () => {
  test("an explicit mode ignores the OS setting", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  test("system follows the OS setting", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});

// The DOM glue, run against small stand-ins for localStorage, matchMedia and
// <html>, so the test does not need a browser.
describe("saveThemeMode and applyTheme", () => {
  const store = new Map<string, string>();
  const root = { dataset: {} as Record<string, string> };
  let systemDark = true;

  beforeEach(() => {
    store.clear();
    root.dataset = {};
    Object.assign(globalThis, {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
      },
      matchMedia: () => ({ matches: systemDark }),
      document: { documentElement: root },
    });
  });

  test("saving a mode stores it and paints the resolved theme", () => {
    saveThemeMode("light");
    expect(store.get(THEME_KEY)).toBe("light");
    expect(root.dataset.theme).toBe("light");
    expect(loadThemeMode()).toBe("light");
  });

  test("system mode repaints from the OS setting", () => {
    systemDark = false;
    applyTheme("system");
    expect(root.dataset.theme).toBe("light");
    systemDark = true;
    applyTheme("system");
    expect(root.dataset.theme).toBe("dark");
  });

  const blocked = () => {
    throw new Error("SecurityError");
  };

  test("loadThemeMode falls back to system when storage throws", () => {
    Object.assign(globalThis, { localStorage: { getItem: blocked, setItem: blocked } });
    expect(loadThemeMode()).toBe("system");
  });

  test("saveThemeMode still paints the theme when storage throws", () => {
    Object.assign(globalThis, { localStorage: { getItem: blocked, setItem: blocked } });
    saveThemeMode("dark");
    expect(root.dataset.theme).toBe("dark");
  });
});
