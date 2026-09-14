export async function render(root, ctx) {
  const { state, call, h, toast } = ctx;
  root.appendChild(h("h2", {}, "Worlds"));

  const editor = h("textarea", { rows: "18", style: "width:100%;font:12px monospace" });
  root.appendChild(h("div", { class: "field" }, h("label", {}, "config.yaml"), editor));
  root.appendChild(
    h(
      "div",
      { class: "actions" },
      h("button", { onclick: () => loadConfig() }, "Reload"),
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
              await call("config.set", { config: parsed });
              toast("config.yaml saved", "ok");
              await loadConfig();
            } catch (e) {
              toast(`could not save: ${e.message}`);
            }
          },
        },
        "Save",
      ),
    ),
  );

  root.appendChild(h("h3", {}, `Pattern aliases for ${state.world}`));
  const aliasTable = h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "alias"), h("th", {}, "canonical"), h("th", {}))));
  const aliasBody = h("tbody");
  aliasTable.appendChild(aliasBody);
  root.appendChild(aliasTable);

  const newAlias = h("input", { placeholder: "alias" });
  const newCanonical = h("input", { placeholder: "canonical" });
  root.appendChild(
    h(
      "div",
      { class: "actions" },
      newAlias,
      newCanonical,
      h("button", { onclick: () => addAlias() }, "Add"),
    ),
  );

  async function loadConfig() {
    try {
      const cfg = await call("config.get", {});
      editor.value = JSON.stringify(cfg, null, 2);
    } catch (e) {
      toast(`could not load config.yaml: ${e.message}`);
    }
  }

  async function loadAliases() {
    let aliases;
    try {
      aliases = await call("aliases.get", { world: state.world });
    } catch (e) {
      toast(`could not load aliases: ${e.message}`);
      return;
    }
    aliasBody.innerHTML = "";
    for (const [alias, canonical] of Object.entries(aliases)) {
      const row = h(
        "tr",
        {},
        h("td", {}, alias),
        h("td", {}, canonical),
        h(
          "td",
          {},
          h(
            "button",
            {
              class: "danger",
              onclick: async () => {
                const rest = { ...aliases };
                delete rest[alias];
                try {
                  await call("aliases.set", { world: state.world, aliases: rest });
                  await loadAliases();
                } catch (e) {
                  toast(`could not remove alias: ${e.message}`);
                }
              },
            },
            "Remove",
          ),
        ),
      );
      aliasBody.appendChild(row);
    }
  }

  async function addAlias() {
    const alias = newAlias.value.trim();
    const canonical = newCanonical.value.trim();
    if (!alias || !canonical) {
      toast("alias and canonical are both required");
      return;
    }
    let aliases;
    try {
      aliases = await call("aliases.get", { world: state.world });
    } catch (e) {
      toast(`could not load aliases: ${e.message}`);
      return;
    }
    aliases[alias] = canonical;
    try {
      await call("aliases.set", { world: state.world, aliases });
      newAlias.value = "";
      newCanonical.value = "";
      await loadAliases();
    } catch (e) {
      toast(`could not save alias: ${e.message}`);
    }
  }

  await Promise.all([loadConfig(), loadAliases()]);
}
