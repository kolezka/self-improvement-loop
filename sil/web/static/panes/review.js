import { renderMarkdown, renderDiff } from "./markdown.js";

const ARTIFACT_TYPES = ["skill", "hook", "rule", "agent", "none"];

export async function render(root, ctx) {
  const { state, call, h, toast } = ctx;
  root.appendChild(h("h2", {}, "Review"));

  const listPane = h("ul", { class: "list" });
  const detailPane = h("div", { class: "card" }, h("p", { class: "muted" }, "Select a staged proposal."));
  root.appendChild(h("div", { class: "actions" }, h("button", { onclick: () => loadQueue() }, "Refresh")));
  root.appendChild(h("div", { class: "split" }, listPane, detailPane));

  // The digest of the proposal actually shown in detailPane. Any reload
  // (queue refresh, opening another pattern) clears it, so Accept can never
  // fire against a state the operator has not seen.
  let reviewedState = null;
  let selectedPattern = null;
  // Guards against a slow response landing after the operator has already
  // moved on to a different pattern.
  let seq = 0;

  async function loadQueue() {
    reviewedState = null;
    let items;
    try {
      items = await call("review.queue", { world: state.world });
    } catch (e) {
      toast(`could not load review queue: ${e.message}`);
      return;
    }
    listPane.innerHTML = "";
    if (!items.length) {
      listPane.appendChild(h("li", { class: "muted" }, "nothing staged"));
    }
    for (const item of items) {
      const btn = h(
        "button",
        {
          class: "row" + (item.pattern === selectedPattern ? " selected" : ""),
          onclick: () => openPattern(item.pattern),
        },
        h("strong", {}, item.pattern),
        " ",
        h("span", { class: "badge" }, item.artifact_type),
        " ",
        h("span", { class: "muted" }, item.staged_at || ""),
      );
      listPane.appendChild(h("li", {}, btn));
    }
  }

  async function openPattern(pattern) {
    selectedPattern = pattern;
    reviewedState = null;
    const mySeq = ++seq;

    let detail, diff;
    try {
      [detail, diff] = await Promise.all([
        call("review.detail", { world: state.world, pattern }),
        call("review.diff", { world: state.world, pattern }),
      ]);
    } catch (e) {
      toast(`could not load proposal: ${e.message}`);
      return;
    }
    if (mySeq !== seq) return;

    const statesMatch = detail.reviewed_state === diff.reviewed_state;
    if (statesMatch) reviewedState = detail.reviewed_state;

    detailPane.innerHTML = "";
    detailPane.appendChild(h("h3", {}, `${detail.pattern}`, " ", h("span", { class: "badge" }, detail.artifact_type)));
    if (detail.accept_blocked) {
      detailPane.appendChild(h("p", { class: "error-text" }, `accept blocked: ${detail.accept_blocked}`));
    }
    if (!statesMatch) {
      detailPane.appendChild(h("p", { class: "error-text" }, "detail and diff disagree on reviewed_state; reload before acting"));
    }
    if (detail.sources && detail.sources.length) {
      detailPane.appendChild(h("p", { class: "muted" }, `sources: ${detail.sources.join(", ")}`));
    }
    detailPane.appendChild(renderMarkdown(h, detail.body));
    detailPane.appendChild(h("h4", {}, "Diff"));
    detailPane.appendChild(renderDiff(h, diff.diff));

    const canAccept = statesMatch && !detail.accept_blocked;
    const actions = h("div", { class: "actions" });

    actions.appendChild(
      h(
        "button",
        {
          class: "primary",
          disabled: !canAccept,
          onclick: () => act((digest) => call("skill.accept", { world: state.world, pattern, reviewed_state: digest }), "accepted"),
        },
        "Accept",
      ),
    );
    actions.appendChild(
      h(
        "button",
        {
          class: "danger",
          onclick: () => act(() => call("skill.reject", { world: state.world, pattern }), "rejected"),
        },
        "Reject",
      ),
    );

    const rehomeSelect = h("select", {}, ...ARTIFACT_TYPES.map((t) => h("option", { value: t }, t)));
    rehomeSelect.value = detail.artifact_type;
    actions.appendChild(rehomeSelect);
    actions.appendChild(
      h(
        "button",
        {
          onclick: () =>
            act(() => call("router.rehome", { world: state.world, pattern, artifact_type: rehomeSelect.value }), "rehomed"),
        },
        "Rehome",
      ),
    );

    detailPane.appendChild(actions);
  }

  // Captures the reviewed_state digest before clearing it, so the accept
  // call always carries the value that matched what was shown, never a
  // value read after the state has already been nulled out.
  async function act(fn, verb) {
    const digest = reviewedState;
    reviewedState = null;
    try {
      await fn(digest);
      toast(`${selectedPattern} ${verb}`, "ok");
    } catch (e) {
      toast(`could not act on ${selectedPattern}: ${e.message}`);
    }
    selectedPattern = null;
    await loadQueue();
    detailPane.innerHTML = "";
    detailPane.appendChild(h("p", { class: "muted" }, "Select a staged proposal."));
  }

  await loadQueue();
}
