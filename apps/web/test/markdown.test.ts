// Unit tests for the front matter split used by the Review "Proposal" tab,
// so a skill's YAML front matter renders as a key/value list instead of
// paragraphs of "---" and "name: ...".

import { describe, expect, test } from "bun:test";
import { splitFrontMatter } from "../src/lib/markdown.ts";

describe("splitFrontMatter", () => {
  test("returns the text unchanged when there is no front matter", () => {
    const text = "# Title\n\nSome body text.";
    expect(splitFrontMatter(text)).toEqual({ meta: [], body: text });
  });

  test("splits a name and description block from the body", () => {
    const text = ["---", "name: my-skill", "description: Does a thing.", "---", "", "# Body heading", "", "Body text."].join("\n");
    const result = splitFrontMatter(text);
    expect(result.meta).toEqual([
      ["name", "my-skill"],
      ["description", "Does a thing."],
    ]);
    expect(result.body).toBe("# Body heading\n\nBody text.");
  });

  test("does not treat a later '---' in the body as front matter", () => {
    const text = "Some heading\n\n---\nnot frontmatter, just a rule or a later block";
    expect(splitFrontMatter(text)).toEqual({ meta: [], body: text });
  });

  test("treats an unclosed leading '---' as no front matter", () => {
    const text = "---\nname: my-skill\nno closing fence here";
    expect(splitFrontMatter(text)).toEqual({ meta: [], body: text });
  });
});
