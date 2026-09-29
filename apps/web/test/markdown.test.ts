// Unit tests for the front matter split used by the Review "Proposal" tab.
// The reviewer accepts from this view, so every front matter line must stay
// visible: an agent's nested `tools:` list is a permission, not decoration.

import { describe, expect, test } from "bun:test";
import { splitFrontMatter } from "../src/lib/markdown.ts";

describe("splitFrontMatter", () => {
  test("returns the text unchanged when there is no front matter", () => {
    const text = "# Title\n\nSome body text.";
    expect(splitFrontMatter(text)).toEqual({ frontMatter: null, body: text });
  });

  test("splits a name and description block from the body", () => {
    const text = ["---", "name: my-skill", "description: Does a thing.", "---", "", "# Body heading", "", "Body text."].join("\n");
    const result = splitFrontMatter(text);
    expect(result.frontMatter).toBe("name: my-skill\ndescription: Does a thing.");
    expect(result.body).toBe("# Body heading\n\nBody text.");
  });

  test("keeps every front matter line, including nested lists", () => {
    const lines = ["name: agent-test", "description: Use when reviewing a change.", "tools:", "  - Bash", "  - Read", "model: inherit"];
    const text = ["---", ...lines, "---", "", "## Instructions", "Review."].join("\n");
    expect(splitFrontMatter(text).frontMatter).toBe(lines.join("\n"));
  });

  test("does not treat a later '---' in the body as front matter", () => {
    const text = "Some heading\n\n---\nnot frontmatter, just a rule or a later block";
    expect(splitFrontMatter(text)).toEqual({ frontMatter: null, body: text });
  });

  test("treats an unclosed leading '---' as no front matter", () => {
    const text = "---\nname: my-skill\nno closing fence here";
    expect(splitFrontMatter(text)).toEqual({ frontMatter: null, body: text });
  });
});
