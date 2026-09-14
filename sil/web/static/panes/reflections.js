import { renderMarkdown } from "./markdown.js";

function chips(h, r) {
  const wrap = h("span");
  for (const ref of r.artifacts_used || []) wrap.appendChild(h("span", { class: "chip" }, `used: ${ref}`));
  for (const ref of r.artifacts_helpful || []) wrap.appendChild(h("span", { class: "chip ok-text" }, `helpful: ${ref}`));
  for (const ref of r.artifacts_misfired || []) wrap.appendChild(h("span", { class: "chip error-text" }, `misfired: ${ref}`));
  return wrap;
}

export async function render(root, ctx) {
  const { state, call, h, toast } = ctx;
  root.appendChild(h("h2", {}, "Reflections"));

  const patternInput = h("input", { placeholder: "pattern filter" });
  const limitInput = h("input", { type: "number", value: "100", style: "width:6rem" });
  root.appendChild(
    h(
      "div",
      { class: "actions" },
      patternInput,
      limitInput,
      h("button", { onclick: () => load() }, "Refresh"),
    ),
  );

  const listPane = h("ul", { class: "list" });
  const detailPane = h("div", { class: "card" }, h("p", { class: "muted" }, "Select a reflection."));
  root.appendChild(h("div", { class: "split" }, listPane, detailPane));

  async function load() {
    const payload = { world: state.world };
    if (patternInput.value.trim()) payload.pattern = patternInput.value.trim();
    const n = parseInt(limitInput.value, 10);
    if (n > 0) payload.limit = n;

    let items;
    try {
      items = await call("reflections.list", payload);
    } catch (e) {
      toast(`could not load reflections: ${e.message}`);
      return;
    }
    listPane.innerHTML = "";
    if (!items.length) {
      listPane.appendChild(h("li", { class: "muted" }, "no reflections"));
    }
    for (const r of items) {
      const btn = h(
        "button",
        { class: "row", onclick: () => openReflection(r.id) },
        h("strong", {}, r.pattern),
        " ",
        h("span", { class: "muted" }, r.created),
        h("div", {}, chips(h, r)),
      );
      listPane.appendChild(h("li", {}, btn));
    }
  }

  async function openReflection(id) {
    let r;
    try {
      r = await call("reflections.get", { world: state.world, id });
    } catch (e) {
      toast(`could not load reflection: ${e.message}`);
      return;
    }
    detailPane.innerHTML = "";
    detailPane.appendChild(h("h3", {}, r.pattern));
    detailPane.appendChild(h("p", { class: "muted" }, `${r.id}, ${r.created}, ${r.session_id || ""}`));
    detailPane.appendChild(chips(h, r));
    detailPane.appendChild(renderMarkdown(h, r.body));
  }

  await load();
}
