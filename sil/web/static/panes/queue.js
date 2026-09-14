function renderBucket(ctx, name, entries, onSkip) {
  const { h } = ctx;
  const card = h("div", { class: "card" }, h("h3", {}, `${name} (${entries.length})`));
  const list = h("ul", { class: "list" });
  if (!entries.length) {
    list.appendChild(h("li", { class: "muted" }, "empty"));
  }
  for (const e of entries) {
    const row = h(
      "li",
      {},
      h("div", {}, `${e.session_id}, ${e.world}, ${e.cwd}`),
      h(
        "div",
        { class: "muted" },
        `stops: ${e.stops}  tool_uses: ${e.tool_uses}  last_stop: ${e.last_stop}` +
          (e.result ? `  result: ${e.result}` : ""),
      ),
    );
    if (name === "pending") {
      row.appendChild(
        h(
          "button",
          {
            onclick: async () => {
              try {
                await ctx.call("queue.skip", { session_id: e.session_id });
                ctx.toast(`skipped ${e.session_id}`, "ok");
                onSkip();
              } catch (err) {
                ctx.toast(`could not skip: ${err.message}`);
              }
            },
          },
          "Skip",
        ),
      );
    }
    list.appendChild(row);
  }
  card.appendChild(list);
  return card;
}

export async function render(root, ctx) {
  const { h, call, toast } = ctx;
  root.appendChild(h("h2", {}, "Queue"));

  const workerLine = h("div", { class: "card" }, "worker: loading...");
  const lists = h("div");

  root.appendChild(h("div", { class: "actions" }, h("button", { onclick: () => refreshAll() }, "Refresh")));
  root.appendChild(workerLine);
  root.appendChild(lists);

  async function refreshWorker() {
    try {
      const s = await call("worker.status", {});
      workerLine.textContent = `worker: ${JSON.stringify(s)}`;
    } catch (e) {
      workerLine.textContent = "worker: unknown";
    }
  }

  async function refreshLists() {
    let data;
    try {
      data = await call("queue.list", {});
    } catch (e) {
      toast(`could not load queue: ${e.message}`);
      return;
    }
    lists.innerHTML = "";
    for (const bucket of ["pending", "done", "failed"]) {
      lists.appendChild(renderBucket(ctx, bucket, data[bucket], refreshLists));
    }
  }

  async function refreshAll() {
    await Promise.all([refreshWorker(), refreshLists()]);
  }

  await refreshAll();

  // Poll worker status every 5s while this pane stays open; stop as soon as
  // the operator navigates elsewhere.
  const interval = setInterval(() => {
    if (!window.location.hash.startsWith("#/queue")) {
      clearInterval(interval);
      return;
    }
    refreshWorker();
  }, 5000);
}
