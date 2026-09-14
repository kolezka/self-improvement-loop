// Minimal markdown-lite renderer: headings, bullet lists, fenced code,
// paragraphs. Reflection and skill bodies are LLM-authored and untrusted, so
// this builds DOM nodes with h() (text nodes only) and never touches
// innerHTML. No bold/italic/links: plain text is safer than a partial inline
// parser that misses an edge case.

export function renderMarkdown(h, text) {
  const root = h("div", { class: "body-doc" });
  const lines = (text || "").split("\n");
  let i = 0;
  let list = null;

  function flushList() {
    if (list) {
      root.appendChild(list);
      list = null;
    }
  }

  while (i < lines.length) {
    const line = lines[i];

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushList();
      const level = Math.min(heading[1].length, 3);
      root.appendChild(h(`h${level}`, {}, heading[2]));
      i++;
      continue;
    }

    if (line.startsWith("```")) {
      flushList();
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip the closing fence, if any
      root.appendChild(h("pre", {}, h("code", {}, codeLines.join("\n"))));
      continue;
    }

    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (bullet) {
      if (!list) list = h("ul", {});
      list.appendChild(h("li", {}, bullet[1]));
      i++;
      continue;
    }

    flushList();
    if (line.trim() === "") {
      i++;
      continue;
    }
    root.appendChild(h("p", {}, line));
    i++;
  }
  flushList();
  return root;
}

export function renderDiff(h, diffText) {
  const pre = h("pre", { class: "diff" });
  for (const line of (diffText || "").split("\n")) {
    const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : line.startsWith("@@") ? "hunk" : "";
    pre.appendChild(h("span", cls ? { class: cls } : {}, line + "\n"));
  }
  return pre;
}
