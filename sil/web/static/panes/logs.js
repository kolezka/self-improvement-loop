const LOG_NAMES = ["hook", "worker", "web", "curriculum"];

export async function render(root, ctx) {
  const { call, h, toast } = ctx;
  root.appendChild(h("h2", {}, "Logs"));

  const nameSelect = h("select", {}, ...LOG_NAMES.map((n) => h("option", { value: n }, n)));
  const linesInput = h("input", { type: "number", value: "200", style: "width:6rem" });
  root.appendChild(
    h(
      "div",
      { class: "actions" },
      nameSelect,
      linesInput,
      h("button", { onclick: () => load() }, "Tail"),
    ),
  );

  const pathLine = h("p", { class: "muted" }, "");
  root.appendChild(pathLine);
  const output = h("pre", {}, "");
  root.appendChild(output);

  async function load() {
    const n = parseInt(linesInput.value, 10) || 200;
    let result;
    try {
      result = await call("logs.tail", { name: nameSelect.value, lines: n });
    } catch (e) {
      toast(`could not load log: ${e.message}`);
      return;
    }
    pathLine.textContent = result.path;
    output.textContent = result.lines.join("\n");
  }

  await load();
}
