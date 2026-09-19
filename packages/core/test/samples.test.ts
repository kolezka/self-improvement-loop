// The payload sample record shape. Two writers produce the file (the hook per
// live tool call, `sil import payloads` from old transcripts), so the allowlist,
// the truncation and the redaction are tested here rather than in either one.

import { describe, expect, test } from "bun:test";
import { SAMPLE_VALUE_MAX_CHARS, redactCredentials, sampleRecord } from "../src/samples.ts";

describe("sampleRecord", () => {
  test("returns null when tool_name is missing or empty", () => {
    expect(sampleRecord({ tool_input: { command: "ls" } }, "2026-09-20T00:00:00.000Z")).toBeNull();
    expect(sampleRecord({ tool_name: "", tool_input: { command: "ls" } }, "2026-09-20T00:00:00.000Z")).toBeNull();
    expect(sampleRecord({ tool_name: 7 }, "2026-09-20T00:00:00.000Z")).toBeNull();
  });

  test("keeps the given ts and defaults session_id and hook_event_name", () => {
    const record = sampleRecord({ tool_name: "Bash" }, "2026-09-20T12:00:00.000Z");
    expect(record).toEqual({
      ts: "2026-09-20T12:00:00.000Z",
      session_id: "unknown",
      hook_event_name: "",
      tool_name: "Bash",
      tool_input: {},
    });
  });

  test("samples only command and file_path", () => {
    const record = sampleRecord(
      {
        session_id: "sess-1",
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_input: {
          file_path: "/repo/src/a.ts",
          command: "git status",
          old_string: "AWS_SECRET_ACCESS_KEY=old",
          new_string: "AWS_SECRET_ACCESS_KEY=new",
          description: "free text the model wrote",
        },
      },
      "2026-09-20T12:00:00.000Z",
    );
    expect(record?.tool_input).toEqual({ command: "git status", file_path: "/repo/src/a.ts" });
    const line = JSON.stringify(record);
    expect(line).not.toContain("old_string");
    expect(line).not.toContain("description");
    expect(line).not.toContain("AWS_SECRET_ACCESS_KEY");
  });

  test("a non-string value for an allowlisted key is dropped, not stringified", () => {
    const record = sampleRecord({ tool_name: "Bash", tool_input: { command: ["git", "status"] } }, "t");
    expect(record?.tool_input).toEqual({});
  });

  test("truncates a long command at 500 characters", () => {
    const command = "x".repeat(SAMPLE_VALUE_MAX_CHARS + 250);
    const record = sampleRecord({ tool_name: "Bash", tool_input: { command } }, "t");
    expect(record?.tool_input["command"]?.length).toBe(SAMPLE_VALUE_MAX_CHARS);
  });

  test("blanks credential values inside a command", () => {
    const command = 'curl -H "Authorization: Bearer sk-live-abc123" https://api.example.com && export GH_TOKEN=ghp_zzz9 && git push --no-verify';
    const stored = sampleRecord({ tool_name: "Bash", tool_input: { command } }, "t")?.tool_input["command"] ?? "";
    expect(stored).not.toContain("sk-live-abc123");
    expect(stored).not.toContain("ghp_zzz9");
    expect(stored).toContain("Authorization: Bearer <redacted>");
    expect(stored).toContain("GH_TOKEN=<redacted>");
    // the flag a gate would match survives redaction
    expect(stored).toContain("git push --no-verify");
  });
});

describe("redactCredentials", () => {
  test("a long run of spaces after the header name is linear, not polynomial", () => {
    // The first shape, `\s*(?:bearer)?\s*`, let the two whitespace runs trade
    // characters on every backtrack. 20k spaces is far past the 500-char cap the
    // hook applies, so a slow answer here would be a bug and not a load.
    const input = `Authorization:${" ".repeat(20_000)}`;
    const started = performance.now();
    expect(redactCredentials(input)).toBe(input);
    expect(performance.now() - started).toBeLessThan(200);
    // The scheme word is still optional, with or without a space after the colon.
    expect(redactCredentials("Authorization:Bearer abc")).toBe("Authorization:Bearer <redacted>");
    expect(redactCredentials("Authorization: abc")).toBe("Authorization: <redacted>");
  });

  test("is stable across calls despite the global regex flag", () => {
    const text = "export API_KEY=secret1 && export TOKEN=secret2";
    expect(redactCredentials(text)).toBe(redactCredentials(text));
    expect(redactCredentials(text)).not.toContain("secret1");
    expect(redactCredentials(text)).not.toContain("secret2");
  });
});
