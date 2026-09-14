export async function render(root, ctx) {
  const { state, call, h, toast } = ctx;
  root.appendChild(h("h2", {}, "Overview"));
  root.appendChild(h("div", { class: "actions" }, h("button", { onclick: () => render(root, ctx) }, "Refresh")));

  const body = h("div");
  root.appendChild(body);

  let health;
  let queueData;
  try {
    [health, queueData] = await Promise.all([call("health.report", {}), call("queue.list", {})]);
  } catch (e) {
    toast(`could not load overview: ${e.message}`);
    return;
  }

  let reviewQueue = [];
  try {
    reviewQueue = await call("review.queue", { world: state.world });
  } catch {
    // world may have nothing staged yet; leave at 0 rather than failing the page
  }

  let scorecards = [];
  try {
    scorecards = await call("artifacts.scorecards", { world: state.world });
  } catch {
    // same as above
  }

  body.appendChild(
    h(
      "div",
      { class: "card" },
      h("div", {}, `Config: ${health.config_file}`),
      h("div", {}, `State dir: ${health.state_dir}`),
      h("div", {}, `Plugin root: ${health.plugin_root}`),
      h("div", {}, `Worlds: ${health.worlds.join(", ")}`),
    ),
  );

  body.appendChild(
    h(
      "div",
      { class: "card" },
      h("div", {}, `Pending queue: ${queueData.pending.length}`),
      h("div", {}, `Staged reviews (${state.world}): ${reviewQueue.length}`),
      h("div", {}, `Artifacts tracked (${state.world}): ${scorecards.length}`),
    ),
  );

  const providersCard = h("div", { class: "card" }, h("h3", {}, "Provider status"));
  for (const [world, status] of Object.entries(health.providers || {})) {
    providersCard.appendChild(h("div", {}, `${world}: ${JSON.stringify(status)}`));
  }
  body.appendChild(providersCard);

  body.appendChild(h("div", { class: "card" }, h("h3", {}, "Worker"), h("pre", {}, JSON.stringify(health.worker, null, 2))));

  const actions = h("div", { class: "actions" });
  actions.appendChild(
    h(
      "button",
      {
        class: "primary",
        onclick: async () => {
          try {
            const res = await call("loop.run", { world: state.world });
            toast(`worker started (pid ${res.pid})`, "ok");
          } catch (e) {
            toast(`could not start worker: ${e.message}`);
          }
        },
      },
      "Run worker now",
    ),
  );
  actions.appendChild(
    h(
      "button",
      {
        onclick: async () => {
          try {
            const res = await call("curriculum.run", { world: state.world });
            toast(`curriculum started (pid ${res.pid})`, "ok");
          } catch (e) {
            toast(`could not start curriculum: ${e.message}`);
          }
        },
      },
      "Run curriculum",
    ),
  );
  actions.appendChild(h("button", { onclick: () => (window.location.hash = "#/logs") }, "Open logs"));
  body.appendChild(actions);
}
