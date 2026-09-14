export async function render(root, ctx) {
  const { state, call, h, toast } = ctx;
  root.appendChild(h("h2", {}, "Loop"));

  const status = h("pre", {}, "loading...");
  root.appendChild(h("div", { class: "card" }, h("h3", {}, "Worker status"), status));

  const planPane = h("pre", {}, "");
  root.appendChild(h("div", { class: "card" }, h("h3", {}, "Curriculum plan (dry run)"), planPane));

  root.appendChild(
    h(
      "div",
      { class: "actions" },
      h("button", { onclick: () => refresh() }, "Refresh"),
      h(
        "button",
        {
          class: "primary",
          onclick: async () => {
            try {
              const res = await call("loop.run", { world: state.world });
              toast(`worker started (pid ${res.pid}), log at ${res.log}`, "ok");
            } catch (e) {
              toast(`could not start worker: ${e.message}`);
            }
          },
        },
        "Run worker now",
      ),
      h(
        "button",
        {
          onclick: async () => {
            try {
              const res = await call("curriculum.run", { world: state.world });
              toast(`curriculum started (pid ${res.pid}), log at ${res.log}`, "ok");
            } catch (e) {
              toast(`could not start curriculum: ${e.message}`);
            }
          },
        },
        "Run curriculum",
      ),
      h(
        "button",
        {
          onclick: async () => {
            try {
              planPane.textContent = JSON.stringify(await call("curriculum.plan", { world: state.world }), null, 2);
            } catch (e) {
              toast(`could not load plan: ${e.message}`);
            }
          },
        },
        "Show plan",
      ),
    ),
  );

  async function refresh() {
    try {
      status.textContent = JSON.stringify(await call("worker.status", {}), null, 2);
    } catch (e) {
      status.textContent = "unknown";
      toast(`could not load worker status: ${e.message}`);
    }
  }

  await refresh();
}
