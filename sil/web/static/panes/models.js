export async function render(root, ctx) {
  const { state, call, h, toast } = ctx;
  root.appendChild(h("h2", {}, "Models"));
  root.appendChild(h("p", { class: "muted" }, "llm.yaml never carries a secret value here, only the env var name it reads from."));

  const editor = h("textarea", { rows: "16", style: "width:100%;font:12px monospace" });
  root.appendChild(h("div", { class: "field" }, h("label", {}, "llm.yaml"), editor));
  root.appendChild(
    h(
      "div",
      { class: "actions" },
      h("button", { onclick: () => load() }, "Reload"),
      h(
        "button",
        {
          class: "primary",
          onclick: async () => {
            let parsed;
            try {
              parsed = JSON.parse(editor.value);
            } catch (e) {
              toast(`not valid JSON: ${e.message}`);
              return;
            }
            try {
              await call("llm.set", { llm: parsed });
              toast("llm.yaml saved", "ok");
              await load();
            } catch (e) {
              toast(`could not save: ${e.message}`);
            }
          },
        },
        "Save",
      ),
    ),
  );

  root.appendChild(h("h3", {}, "Provider status by world"));
  const statusPane = h("div");
  root.appendChild(statusPane);
  root.appendChild(
    h(
      "div",
      { class: "actions" },
      h(
        "button",
        {
          onclick: async () => {
            statusPane.innerHTML = "";
            for (const world of state.worldNames) {
              let s;
              try {
                s = await call("llm.status", { world });
              } catch (e) {
                s = { error: e.message };
              }
              statusPane.appendChild(h("div", { class: "card" }, h("strong", {}, world), h("pre", {}, JSON.stringify(s, null, 2))));
            }
          },
        },
        "Check all worlds",
      ),
    ),
  );

  async function load() {
    try {
      const llm = await call("llm.get", {});
      editor.value = JSON.stringify(llm, null, 2);
    } catch (e) {
      toast(`could not load llm.yaml: ${e.message}`);
    }
  }

  await load();
}
