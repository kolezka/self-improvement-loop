import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CurationError,
  decodeLessonKey,
  encodeLessonKey,
  utf8Bytes,
  type LessonKey,
} from "../src/lesson-curation.ts";
import { parseCurationMutation } from "../src/lesson-curation-schema.ts";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");
const CAPTURE_ID = "0b7c6f1e-4d1a-4c3b-9a55-2f1e8d7c6b5a";
const REQUEST_ID = "lc_6a1e2f3d-8c4b-4e5a-b7f6-0d9c8b7a6e5f";
const DIGEST = "a".repeat(64);
const PROJECT_ID = `p1_${"b".repeat(64)}`;

function b64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

function curationError(fn: () => unknown): CurationError {
  try {
    fn();
  } catch (error) {
    if (error instanceof CurationError) return error;
    throw new Error(`expected CurationError, got ${String(error)}`);
  }
  throw new Error("expected CurationError, nothing was thrown");
}

function capture(overrides: Record<string, unknown> = {}, source: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: REQUEST_ID,
    binding: { kind: "installation", id: "5e4d3c2b-1a09-4f8e-8d7c-6b5a49382716" },
    scope: { world: "Koleżka", project: { kind: "project", id: PROJECT_ID } },
    key: { world: "Koleżka", kind: "capture", id: CAPTURE_ID },
    expectedRevision: 0,
    change: {
      kind: "capture",
      text: "Grep every call site before renaming a shared symbol.",
      source: {
        kind: "explicit_quote",
        quote: "we renamed it and one caller broke",
        reference: null,
        quoteRedacted: false,
        captureSessionId: "sess-1",
        sourceConversationId: null,
        sourceRowId: null,
        sourceAgentId: null,
        ...source,
      },
    },
    ...overrides,
  };
}

describe("lesson key encoding", () => {
  test("round-trips a Unicode world and a legacy inbox id unchanged", () => {
    const keys: LessonKey[] = [
      { world: "Koleżka", kind: "capture", id: CAPTURE_ID },
      { world: "Koleżka", kind: "inbox", id: "zażółć gęślą jaźń 2026-10-22" },
      { world: "default", kind: "inbox", id: "../../etc/passwd" },
    ];
    for (const key of keys) {
      const encoded = encodeLessonKey(key);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(decodeLessonKey(encoded)).toEqual(key);
    }
  });

  test("the encoding is base64url of the JSON triple", () => {
    const key: LessonKey = { world: "Koleżka", kind: "inbox", id: "abc" };
    expect(encodeLessonKey(key)).toBe(b64url(JSON.stringify(["Koleżka", "inbox", "abc"])));
  });

  test("malformed and noncanonical encodings are refused", () => {
    const bad = [
      "",
      "not base64!",
      `${b64url(JSON.stringify(["default", "inbox", "x"]))}=`,
      b64url("not json"),
      b64url(JSON.stringify({ world: "default", kind: "inbox", id: "x" })),
      b64url(JSON.stringify(["default", "inbox", "x", "extra"])),
      b64url(JSON.stringify(["default", "reflection", "x"])),
      b64url(JSON.stringify(["../evil", "inbox", "x"])),
      b64url(JSON.stringify(["default", "capture", "not-a-uuid"])),
      b64url(JSON.stringify(["default", "capture", CAPTURE_ID.toUpperCase()])),
      b64url(`[ "default", "inbox", "x" ]`),
      b64url(JSON.stringify(["default", "inbox", "x"]).replace("x", "\\u0078")),
    ];
    // A noncanonical tail: same bytes, nonzero padding bits.
    const canonical = b64url(JSON.stringify(["default", "inbox", "xy"]));
    if (canonical.length % 4 !== 0) {
      const last = canonical.at(-1)!;
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
      bad.push(canonical.slice(0, -1) + alphabet[alphabet.indexOf(last) + 1]);
    }
    for (const value of bad) {
      const error = curationError(() => decodeLessonKey(value));
      expect(error.code).toBe("INVALID_INPUT");
    }
  });

  test("legacy ids the Lesson schema accepts stay encodable, without a new byte cap", () => {
    for (const id of ["é".repeat(100), "é".repeat(3000)]) {
      const key: LessonKey = { world: "default", kind: "inbox", id };
      expect(decodeLessonKey(encodeLessonKey(key))).toEqual(key);
    }
  });

  test("any legacy id string is opaque identity and round-trips", () => {
    const ids = ["", " ", "\t\n", "a\u0000b", "\u007f", "a\uD800b", "\uDC00", "end\uD83D", "../x/../../y"];
    for (const id of ids) {
      const key: LessonKey = { world: "default", kind: "inbox", id };
      const encoded = encodeLessonKey(key);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(decodeLessonKey(encoded)).toEqual(key);
      expect(parseCurationMutation(capture({ scope: { world: "default", project: { kind: "world" } }, key, change: { kind: "important", value: true } })).key).toEqual(key);
    }
  });

  test("a non-string legacy id is refused", () => {
    for (const id of [1, null, ["a"]]) {
      expect(curationError(() => decodeLessonKey(b64url(JSON.stringify(["default", "inbox", id]))))).toBeInstanceOf(CurationError);
      expect(curationError(() => parseCurationMutation(capture({ key: { world: "Koleżka", kind: "inbox", id }, change: { kind: "important", value: true } }))).code).toBe("INVALID_INPUT");
    }
  });

  test("the key bound is the 16 KiB JSON triple, not the base64url length", () => {
    // ["default","inbox",""] is 22 bytes of JSON.
    const fits: LessonKey = { world: "default", kind: "inbox", id: "a".repeat(16384 - 22) };
    const encoded = encodeLessonKey(fits);
    expect(encoded.length).toBeGreaterThan(16384);
    expect(decodeLessonKey(encoded)).toEqual(fits);

    const over: LessonKey = { world: "default", kind: "inbox", id: "a".repeat(16384 - 21) };
    expect(curationError(() => encodeLessonKey(over)).code).toBe("INVALID_INPUT");
    expect(curationError(() => decodeLessonKey(b64url(JSON.stringify(["default", "inbox", over.id])))).code).toBe(
      "INVALID_INPUT",
    );
    // Past the derived character ceiling, refused before decoding.
    expect(curationError(() => decodeLessonKey("A".repeat(Math.ceil(16384 / 3) * 4 + 4))).code).toBe("INVALID_INPUT");
  });

  test("worlds are bounded in code points like WORLD_NAME_RE, not UTF-16 units", () => {
    for (const world of ["𐐀".repeat(33), "𐐀".repeat(64)]) {
      const key: LessonKey = { world, kind: "capture", id: CAPTURE_ID };
      expect(decodeLessonKey(encodeLessonKey(key))).toEqual(key);
    }
    const tooLong: LessonKey = { world: "𐐀".repeat(65), kind: "capture", id: CAPTURE_ID };
    expect(curationError(() => encodeLessonKey(tooLong)).code).toBe("INVALID_INPUT");
  });

  test("a raw legacy id is never accepted as an encoded key", () => {
    for (const raw of ["lesson-123", "abc", "../inbox/x.json"]) {
      expect(curationError(() => decodeLessonKey(raw)).code).toBe("INVALID_INPUT");
    }
  });

  test("errors do not echo the input", () => {
    const secretWorld = b64url(JSON.stringify(["zzz secret world", "inbox", "x"]));
    const error = curationError(() => decodeLessonKey(secretWorld));
    expect(error.message).not.toContain("zzz");
  });
});

describe("utf8Bytes", () => {
  test("counts UTF-8 bytes, not UTF-16 units", () => {
    expect(utf8Bytes("ą".repeat(2000))).toBe(4000);
    expect(utf8Bytes("")).toBe(0);
    expect(utf8Bytes("a")).toBe(1);
    expect(utf8Bytes("😀")).toBe(4);
    expect(utf8Bytes("€")).toBe(3);
  });
});

describe("parseCurationMutation", () => {
  test("accepts a valid capture and keeps quoted bytes exactly", () => {
    const quote = "  leading\ttabs\r\n and é kept  ";
    const text = "Keep  double spaces and trailing space ";
    const input = capture({}, { quote });
    (input["change"] as Record<string, unknown>)["text"] = text;
    const parsed = parseCurationMutation(input);
    expect(parsed.change.kind).toBe("capture");
    if (parsed.change.kind !== "capture") throw new Error("unreachable");
    expect(parsed.change.text).toBe(text);
    expect(parsed.change.source.quote).toBe(quote);
    expect(parsed.key).toEqual({ world: "Koleżka", kind: "capture", id: CAPTURE_ID });
  });

  test("4000 bytes of text are accepted and 4001 are refused", () => {
    const ok = capture();
    (ok["change"] as Record<string, unknown>)["text"] = "ą".repeat(2000);
    expect(parseCurationMutation(ok).change).toMatchObject({ text: "ą".repeat(2000) });

    const tooBig = capture();
    (tooBig["change"] as Record<string, unknown>)["text"] = "ą".repeat(2001);
    const error = curationError(() => parseCurationMutation(tooBig));
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.fields).toEqual(["change.text"]);
    expect(error.message).not.toContain("ą");
  });

  test("quote and reference byte limits", () => {
    expect(curationError(() => parseCurationMutation(capture({}, { quote: "x".repeat(4001) }))).fields).toEqual([
      "change.source.quote",
    ]);
    expect(parseCurationMutation(capture({}, { quote: null, reference: "r".repeat(1000) }))).toBeTruthy();
    expect(curationError(() => parseCurationMutation(capture({}, { reference: "r".repeat(1001) }))).fields).toEqual([
      "change.source.reference",
    ]);
  });

  test("whitespace-only text and quote are refused", () => {
    const blank = capture();
    (blank["change"] as Record<string, unknown>)["text"] = " \t\n ";
    expect(curationError(() => parseCurationMutation(blank)).fields).toEqual(["change.text"]);
    expect(curationError(() => parseCurationMutation(capture({}, { quote: "   " }))).fields).toEqual([
      "change.source.quote",
    ]);
    const edit = capture({ change: { kind: "edit", text: "\n" } });
    expect(curationError(() => parseCurationMutation(edit)).code).toBe("INVALID_INPUT");
  });

  test("lone surrogates are refused in every reviewed text field", () => {
    for (const bad of ["a\uD800b", "a\uDC00b", "end\uD83D", "\uDE00start"]) {
      const captureText = capture();
      (captureText["change"] as Record<string, unknown>)["text"] = bad;
      expect(curationError(() => parseCurationMutation(captureText)).fields).toEqual(["change.text"]);

      const edit = capture({ change: { kind: "edit", text: bad } });
      expect(curationError(() => parseCurationMutation(edit)).fields).toEqual(["change.text"]);

      expect(curationError(() => parseCurationMutation(capture({}, { quote: bad }))).fields).toEqual([
        "change.source.quote",
      ]);
      expect(curationError(() => parseCurationMutation(capture({}, { reference: bad }))).fields).toEqual([
        "change.source.reference",
      ]);
    }
  });

  test("valid emoji and combining characters are kept exactly", () => {
    const text = "Ship it 😀👍🏽 then café and 👨‍👩‍👧";
    const input = capture({}, { quote: text, reference: text });
    (input["change"] as Record<string, unknown>)["text"] = text;
    const parsed = parseCurationMutation(input);
    if (parsed.change.kind !== "capture") throw new Error("unreachable");
    expect(parsed.change.text).toBe(text);
    expect(parsed.change.source.quote).toBe(text);
    expect(parsed.change.source.reference).toBe(text);
  });

  test("a non-BMP world over 32 code points and a long legacy id parse in a mutation", () => {
    const world = "𐐀".repeat(33);
    const parsed = parseCurationMutation(
      capture({ scope: { world, project: { kind: "world" } }, key: { world, kind: "capture", id: CAPTURE_ID } }),
    );
    expect(parsed.scope.world).toBe(world);
    expect(parsed.key.world).toBe(world);

    const inbox: LessonKey = { world: "Koleżka", kind: "inbox", id: "é".repeat(100) };
    expect(parseCurationMutation(capture({ key: inbox, change: { kind: "important", value: true } })).key).toEqual(inbox);

    const over = "𐐀".repeat(65);
    const error = curationError(() =>
      parseCurationMutation(capture({ scope: { world: over, project: { kind: "world" } }, key: { world: over, kind: "capture", id: CAPTURE_ID } })),
    );
    expect(error.code).toBe("INVALID_INPUT");
  });

  test("a capture needs a quote or a reference", () => {
    expect(curationError(() => parseCurationMutation(capture({}, { quote: null, reference: null }))).code).toBe(
      "INVALID_INPUT",
    );
  });

  test("existing_lesson is not a capture source", () => {
    const error = curationError(() => parseCurationMutation(capture({}, { kind: "existing_lesson" })));
    expect(error.code).toBe("INVALID_INPUT");
  });

  test("a capture must target a capture key", () => {
    const input = capture({ key: { world: "Koleżka", kind: "inbox", id: "legacy-1" } });
    expect(curationError(() => parseCurationMutation(input)).fields).toEqual(["key.kind"]);
  });

  test("a cross-world key is a scope conflict", () => {
    const input = capture({ key: { world: "other", kind: "capture", id: CAPTURE_ID } });
    const error = curationError(() => parseCurationMutation(input));
    expect(error.code).toBe("SCOPE_CONFLICT");
  });

  test("malformed keys inside a mutation are refused", () => {
    for (const key of [
      { world: "Koleżka", kind: "capture", id: "nope" },
      { world: "../x", kind: "inbox", id: "a" },
      { world: "Koleżka", kind: "inbox", id: "a", extra: 1 },
    ]) {
      expect(curationError(() => parseCurationMutation(capture({ key, change: { kind: "important", value: true } }))).code).toBe(
        "INVALID_INPUT",
      );
    }
  });

  test("request ids must use the reserved lc_<uuid> namespace", () => {
    expect(parseCurationMutation(capture()).requestId).toBe(REQUEST_ID);
    for (const requestId of [REQUEST_ID.slice(3), `lc_${REQUEST_ID.slice(3).toUpperCase()}`, "lc_x", "op_" + REQUEST_ID.slice(3)]) {
      expect(curationError(() => parseCurationMutation(capture({ requestId }))).fields).toEqual(["requestId"]);
    }
  });

  test("purge requires confirmed true", () => {
    const inbox = { world: "Koleżka", kind: "inbox", id: "legacy-1" };
    expect(parseCurationMutation(capture({ key: inbox, change: { kind: "purge", confirmed: true } })).change).toEqual({
      kind: "purge",
      confirmed: true,
    });
    expect(curationError(() => parseCurationMutation(capture({ key: inbox, change: { kind: "purge", confirmed: false } }))).code).toBe(
      "INVALID_INPUT",
    );
    expect(curationError(() => parseCurationMutation(capture({ key: inbox, change: { kind: "purge" } }))).code).toBe(
      "INVALID_INPUT",
    );
  });

  test("acknowledge-source needs a sha256 hex digest", () => {
    const inbox = { world: "Koleżka", kind: "inbox", id: "legacy-1" };
    expect(parseCurationMutation(capture({ key: inbox, change: { kind: "acknowledge-source", digest: DIGEST } })).change).toEqual({
      kind: "acknowledge-source",
      digest: DIGEST,
    });
    expect(curationError(() => parseCurationMutation(capture({ key: inbox, change: { kind: "acknowledge-source", digest: "abc" } }))).code).toBe(
      "INVALID_INPUT",
    );
  });

  test("expected revision is a nonnegative integer", () => {
    for (const expectedRevision of [-1, 1.5, "1", null]) {
      expect(curationError(() => parseCurationMutation(capture({ expectedRevision }))).fields).toEqual(["expectedRevision"]);
    }
  });

  test("an envelope over 16 KiB is refused before shape checks", () => {
    const error = curationError(() => parseCurationMutation(capture({ padding: "p".repeat(16 * 1024) })));
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.fields).toEqual(["$"]);
  });

  test("unknown fields are refused without naming them", () => {
    const error = curationError(() => parseCurationMutation(capture({ zzzSecretField: 1 })));
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).not.toContain("zzzSecretField");
    expect(error.fields.join(",")).not.toContain("zzzSecretField");
  });

  test("credentials in reviewed fields are refused by field name only", () => {
    const text = capture();
    (text["change"] as Record<string, unknown>)["text"] = "set password=hunter2hunter2hunter2 in the env";
    const error = curationError(() => parseCurationMutation(text));
    expect(error.code).toBe("SENSITIVE_CONTENT");
    expect(error.fields).toEqual(["change.text"]);
    expect(error.message).not.toContain("hunter2");

    const quote = curationError(() =>
      parseCurationMutation(capture({}, { quote: "curl -H 'Authorization: Bearer zzzabcdefghijklmnop'" })),
    );
    expect(quote.code).toBe("SENSITIVE_CONTENT");
    expect(quote.fields).toEqual(["change.source.quote"]);
    expect(quote.message).not.toContain("zzzabc");
  });

  test("non-object input is invalid", () => {
    for (const value of [null, "x", 1, [], undefined]) {
      expect(curationError(() => parseCurationMutation(value)).code).toBe("INVALID_INPUT");
    }
  });
});

describe("native-safe subpaths", () => {
  const BANNED = ['from "node:', "from 'node:", "process.env", "Bun.", "require(", 'from "zod"', "lesson-curation-schema"];

  test("lesson-curation and sensitive-text import closures stay pure", () => {
    const schema = readFileSync(join(REPO_ROOT, "packages/core/src/lesson-curation-schema.ts"), "utf8");
    expect(schema).toContain('from "zod"'); // positive control for the banned list

    const seen = new Set<string>();
    const queue = ["lesson-curation.ts", "sensitive-text.ts"];
    const offenders: string[] = [];
    while (queue.length > 0) {
      const file = queue.shift()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const text = readFileSync(join(REPO_ROOT, "packages/core/src", file), "utf8");
      for (const banned of BANNED) if (text.includes(banned)) offenders.push(`${file}: ${banned}`);
      for (const match of text.matchAll(/from\s+["']([^"']+)["']/g)) {
        const spec = match[1]!;
        if (spec.startsWith("./")) queue.push(spec.slice(2));
        else offenders.push(`${file}: non-relative import ${spec}`);
      }
    }
    expect(seen.has("samples.ts")).toBe(true);
    expect(offenders).toEqual([]);
  });

  test("core exports the four subpaths", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "packages/core/package.json"), "utf8")) as {
      exports: Record<string, string>;
    };
    expect(pkg.exports["./lesson-curation"]).toBe("./src/lesson-curation.ts");
    expect(pkg.exports["./lesson-curation-schema"]).toBe("./src/lesson-curation-schema.ts");
    expect(pkg.exports["./repo-root"]).toBe("./src/repo-root.ts");
    expect(pkg.exports["./sensitive-text"]).toBe("./src/sensitive-text.ts");
  });
});
