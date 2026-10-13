// packages/core/test/ledger-origin.test.ts
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, PromotionEntry, RouterRow } from "@sil/core";
import { loadLedger, parseLedger, saveLedger } from "@sil/store";

const NEW_KEYS = ["origin", "external_path", "note"];
const dirs: string[] = [];

function tmpLedgerPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "sil-origin-"));
  dirs.push(dir);
  return join(dir, "promotions.json");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("an old row parses with no origin and saves without one", () => {
  const path = tmpLedgerPath();
  const ledger = Ledger.parse({ version: 1, entries: { "old-rule": { pattern: "old-rule", status: "promoted", artifact_type: "rule" } } });
  expect(ledger.entries["old-rule"]!.origin).toBeUndefined();
  saveLedger(path, ledger);
  const text = readFileSync(path, "utf8");
  for (const key of NEW_KEYS) expect(text).not.toContain(key);
  expect(loadLedger(path).entries["old-rule"]!.origin).toBeUndefined();
});

test("a V1 ledger (bare list of rows) saves without the new keys", () => {
  const path = tmpLedgerPath();
  const ledger = parseLedger(JSON.stringify([{ pattern: "a", status: "promoted", last_updated: "2026-01-01T00:00:00Z" }]));
  saveLedger(path, ledger);
  const text = readFileSync(path, "utf8");
  for (const key of NEW_KEYS) expect(text).not.toContain(key);
  expect(loadLedger(path).entries["a"]!.origin).toBeUndefined();
});

test("an inline row keeps origin, external_path and note", () => {
  const row = PromotionEntry.parse({
    pattern: "deny-without-grep",
    status: "promoted",
    artifact_type: "skill",
    origin: "inline",
    external_path: "/home/u/.claude/skills/deny-without-grep/SKILL.md",
    note: "grep every caller before answering no",
  });
  expect(row.origin).toBe("inline");
  expect(row.external_path).toBe("/home/u/.claude/skills/deny-without-grep/SKILL.md");
  expect(row.note).toBe("grep every caller before answering no");
});

test("an unknown origin is refused", () => {
  expect(() => PromotionEntry.parse({ pattern: "x", origin: "manual" })).toThrow();
});

test("a router row keeps origin and refuses an unknown one", () => {
  const row = RouterRow.parse({ pattern: "deny-without-grep", artifact_type: "skill", status: "promoted", origin: "inline" });
  expect(row.origin).toBe("inline");
  expect(() => RouterRow.parse({ pattern: "x", artifact_type: "skill", status: "promoted", origin: "manual" })).toThrow();
});
