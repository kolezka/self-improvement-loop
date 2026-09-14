// Tiny hash-based pane router, no build step, no framework.

import { captureToken, call } from "./api.js";
import * as overview from "./panes/overview.js";
import * as queue from "./panes/queue.js";
import * as reflections from "./panes/reflections.js";
import * as review from "./panes/review.js";
import * as artifacts from "./panes/artifacts.js";
import * as loop from "./panes/loop.js";
import * as models from "./panes/models.js";
import * as worlds from "./panes/worlds.js";
import * as logs from "./panes/logs.js";

const PANES = {
  overview,
  queue,
  reflections,
  review,
  artifacts,
  loop,
  models,
  worlds,
  logs,
};

// Shared, mutable app state. Panes read it; only app.js and the world
// selector write to it.
export const state = {
  world: "default",
  worldNames: [],
};

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    el.appendChild(typeof child === "string" || typeof child === "number" ? document.createTextNode(child) : child);
  }
  return el;
}

let toastTimer = null;

export function toast(message, kind = "error") {
  const box = document.getElementById("toast");
  box.textContent = message;
  box.className = `toast ${kind} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    box.className = "toast";
  }, 6000);
}

function currentPane() {
  const hash = window.location.hash.replace(/^#\/?/, "");
  const name = hash.split("/")[0] || "overview";
  return PANES[name] ? name : "overview";
}

async function renderNav() {
  const nav = document.getElementById("nav");
  nav.innerHTML = "";
  const active = currentPane();
  for (const name of Object.keys(PANES)) {
    nav.appendChild(
      h(
        "a",
        { href: `#/${name}`, class: name === active ? "active" : "" },
        name[0].toUpperCase() + name.slice(1),
      ),
    );
  }
}

async function renderStatusLine() {
  const line = document.getElementById("status-line");
  line.innerHTML = "";

  const select = h(
    "select",
    {
      id: "world-select",
      onchange: (e) => {
        state.world = e.target.value;
        route();
      },
    },
    ...state.worldNames.map((name) => h("option", { value: name, selected: name === state.world || undefined }, name)),
  );
  line.appendChild(h("span", { class: "status-label" }, "world:"));
  line.appendChild(select);

  const workerBadge = h("span", { id: "worker-badge", class: "badge" }, "worker: ...");
  line.appendChild(workerBadge);
  try {
    const status = await call("worker.status", {});
    workerBadge.textContent = `worker: ${status.running ? "running" : "idle"}`;
  } catch (e) {
    workerBadge.textContent = "worker: unknown";
  }
}

async function loadWorlds() {
  try {
    const list = await call("worlds.list", {});
    state.worldNames = list.map((w) => w.name);
    if (!state.worldNames.includes(state.world)) {
      state.world = state.worldNames[0] || "default";
    }
  } catch (e) {
    toast(`could not load worlds: ${e.message}`);
  }
}

async function route() {
  await renderNav();
  await renderStatusLine();
  const name = currentPane();
  const root = document.getElementById("main");
  root.innerHTML = "";
  try {
    await PANES[name].render(root, { state, call, h, toast });
  } catch (e) {
    toast(`${name} pane failed: ${e.message}`);
  }
}

window.addEventListener("hashchange", route);

async function boot() {
  captureToken();
  await loadWorlds();
  await route();
}

boot();
