function scorecardCells(h, sc) {
  if (!sc) return [h("td", { class: "muted" }, "-"), h("td", { class: "muted" }, "-"), h("td", { class: "muted" }, "-")];
  return [
    h("td", {}, `${sc.uses_30d}`),
    h("td", {}, `${sc.helpful}/${sc.misfired}`),
    h("td", {}, `${sc.human_good}/${sc.human_bad}`),
  ];
}

export async function render(root, ctx) {
  const { state, call, h, toast } = ctx;
  root.appendChild(h("h2", {}, "Artifacts"));
  root.appendChild(
    h(
      "div",
      { class: "actions" },
      h("button", { onclick: () => loadInventory() }, "Refresh"),
      h(
        "button",
        {
          onclick: async () => {
            try {
              const res = await call("artifacts.rebuild", { world: state.world });
              toast(`scorecards rebuilt: ${res.path}`, "ok");
              await loadInventory();
            } catch (e) {
              toast(`could not rebuild: ${e.message}`);
            }
          },
        },
        "Rebuild scorecards",
      ),
    ),
  );

  const table = h(
    "table",
    {},
    h(
      "thead",
      {},
      h(
        "tr",
        {},
        h("th", {}, "pattern"),
        h("th", {}, "type"),
        h("th", {}, "served_by"),
        h("th", {}, "status"),
        h("th", {}, "reflections"),
        h("th", {}, "uses_30d"),
        h("th", {}, "helpful/misfired"),
        h("th", {}, "human good/bad"),
        h("th", {}, "actions"),
      ),
    ),
  );
  const tbody = h("tbody");
  table.appendChild(tbody);
  root.appendChild(table);

  root.appendChild(h("h3", {}, "Lessons in flight"));
  const lessonsList = h("ul", { class: "list" });
  root.appendChild(lessonsList);

  root.appendChild(h("h3", {}, "Record human feedback"));
  const refInput = h("input", { placeholder: "skill:my-pattern" });
  const noteInput = h("input", { placeholder: "note (optional)" });
  const voteSelect = h("select", {}, h("option", { value: "good" }, "good"), h("option", { value: "bad" }, "bad"));
  root.appendChild(
    h(
      "div",
      { class: "actions" },
      refInput,
      voteSelect,
      noteInput,
      h(
        "button",
        {
          onclick: async () => {
            try {
              await call("feedback.add", { world: state.world, ref: refInput.value.trim(), vote: voteSelect.value, note: noteInput.value });
              toast("feedback recorded", "ok");
              refInput.value = "";
              noteInput.value = "";
              await loadInventory();
            } catch (e) {
              toast(`could not record feedback: ${e.message}`);
            }
          },
        },
        "Record",
      ),
    ),
  );

  async function loadInventory() {
    let rows;
    try {
      rows = await call("router.inventory", { world: state.world });
    } catch (e) {
      toast(`could not load inventory: ${e.message}`);
      return;
    }
    tbody.innerHTML = "";
    for (const row of rows) {
      const tr = h(
        "tr",
        {},
        h("td", {}, row.pattern),
        h("td", {}, row.artifact_type),
        h("td", {}, row.served_by || "-"),
        h("td", {}, row.status),
        h("td", {}, `${row.reflections}`),
        ...scorecardCells(h, row.scorecard),
      );
      const retireBtn = h(
        "button",
        {
          class: "danger",
          onclick: async () => {
            if (!window.confirm(`Retire ${row.pattern}? This cannot be undone from the UI.`)) return;
            try {
              await call("router.retire", { world: state.world, pattern: row.pattern, confirm: true });
              toast(`${row.pattern} retired`, "ok");
              await loadInventory();
            } catch (e) {
              toast(`could not retire ${row.pattern}: ${e.message}`);
            }
          },
        },
        "Retire",
      );
      tr.appendChild(h("td", {}, retireBtn));
      tbody.appendChild(tr);
    }

    let lessons;
    try {
      lessons = await call("lessons.list", { world: state.world });
    } catch (e) {
      lessons = [];
    }
    lessonsList.innerHTML = "";
    if (!lessons.length) {
      lessonsList.appendChild(h("li", { class: "muted" }, "none pending"));
    }
    for (const l of lessons) {
      lessonsList.appendChild(h("li", {}, h("strong", {}, l.pattern), `: ${l.text}`));
    }
  }

  await loadInventory();
}
