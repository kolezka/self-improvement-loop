// Minimal markdown-lite parser: headings, bullet lists, fenced code,
// paragraphs. Reflection and skill bodies are LLM-authored and untrusted, so
// this returns plain data. Callers render it through Svelte text
// interpolation (auto-escaped), never through {@html}.

export type MdBlock =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "code"; text: string }
  | { type: "list"; items: string[] }
  | { type: "paragraph"; text: string };

export function parseMarkdown(text: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  const lines = (text || "").split("\n");
  let i = 0;
  let listItems: string[] | null = null;

  function flushList() {
    if (listItems) {
      blocks.push({ type: "list", items: listItems });
      listItems = null;
    }
  }

  while (i < lines.length) {
    const line = lines[i]!;

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushList();
      const level = Math.min(heading[1]!.length, 3) as 1 | 2 | 3;
      blocks.push({ type: "heading", level, text: heading[2]! });
      i++;
      continue;
    }

    if (line.startsWith("```")) {
      flushList();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) {
        codeLines.push(lines[i]!);
        i++;
      }
      i++; // skip the closing fence, if any
      blocks.push({ type: "code", text: codeLines.join("\n") });
      continue;
    }

    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (bullet) {
      if (!listItems) listItems = [];
      listItems.push(bullet[1]!);
      i++;
      continue;
    }

    flushList();
    if (line.trim() === "") {
      i++;
      continue;
    }
    blocks.push({ type: "paragraph", text: line });
    i++;
  }
  flushList();
  return blocks;
}

export interface DiffLine {
  text: string;
  cls: "add" | "del" | "hunk" | "";
}

export function parseDiff(diffText: string): DiffLine[] {
  return (diffText || "").split("\n").map((line) => ({
    text: line,
    cls: line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : line.startsWith("@@") ? "hunk" : "",
  }));
}
