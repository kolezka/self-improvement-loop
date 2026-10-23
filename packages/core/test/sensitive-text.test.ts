import { describe, expect, test } from "bun:test";
import { containsSensitiveText, SECRET_RE } from "../src/sensitive-text.ts";
import { SECRET_RE as LINT_SECRET_RE, lint } from "../../curriculum/src/lint.ts";

// The literal curriculum/lint.ts carried before the extraction. Moving it must
// not change what the promotion lint refuses.
const OLD_SECRET_SOURCE =
  "(AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(api[_-]?key|secret|token|password)\\s*[:=]\\s*['\"]?[A-Za-z0-9/+_-]{16,})";

describe("containsSensitiveText", () => {
  test("flags synthetic credentials", () => {
    expect(containsSensitiveText("curl -H 'Authorization: Bearer abcdefghijklmnop'")).toBe(true);
    expect(containsSensitiveText("export password=correcthorsebatterystaple")).toBe(true);
    expect(containsSensitiveText("-----BEGIN RSA PRIVATE KEY-----")).toBe(true);
    expect(containsSensitiveText("-----BEGIN OPENSSH PRIVATE KEY-----")).toBe(true);
    expect(containsSensitiveText("key AKIAABCDEFGHIJKLMNOP here")).toBe(true);
    expect(containsSensitiveText("api_key: 'abcdefghijklmnopqrstuv'")).toBe(true);
  });

  test("leaves benign lesson text alone", () => {
    expect(containsSensitiveText("Grep every call site before renaming a shared symbol.")).toBe(false);
    expect(containsSensitiveText("The password policy requires rotation every quarter.")).toBe(false);
    expect(containsSensitiveText("Store the token in the keychain, never in a file.")).toBe(false);
    expect(containsSensitiveText("")).toBe(false);
  });

  test("is stateless across calls", () => {
    for (let i = 0; i < 3; i++) expect(containsSensitiveText("password=correcthorsebatterystaple")).toBe(true);
  });
});

describe("SECRET_RE extraction", () => {
  test("keeps the old source and flags", () => {
    expect(SECRET_RE.source).toBe(OLD_SECRET_SOURCE);
    expect(SECRET_RE.flags).toBe("i");
  });

  test("curriculum lint re-exports the same pattern and still refuses a secret", () => {
    expect(LINT_SECRET_RE).toBe(SECRET_RE);
    const bullet = "- Never commit api_key=abcdefghijklmnopqrstuvwxyz to a repo.";
    expect(lint("rule", bullet, "verify-callsites", "").some((p) => p.includes("secret"))).toBe(true);
  });
});
