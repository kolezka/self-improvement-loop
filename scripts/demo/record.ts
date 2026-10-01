#!/usr/bin/env bun
// Records the README demo: docs/media/demo.mp4 and docs/media/demo.gif.
//
// Every frame comes from scenes.html. Title, loop diagram and outro are pure
// animation. The console part replays a real `sil web` session, served over a
// demo home that seed.ts builds in a temp dir, inside a window frame with a
// camera that zooms onto the action. No real install is read and no model is
// called.
//
// Run: bun run build && bun run demo:record [--keep]
// Needs ffmpeg and a Chromium binary (CHROMIUM_PATH, default /usr/bin/chromium).
// --keep leaves the temp dir (demo home, frames, segments) in place.

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { chromium, type Browser, type Locator, type Page } from "playwright-core";

import { demoEnv, MISFIRE_PATTERN, PROMOTED_SKILL_PATTERN, STAGED_PATTERN } from "./seed.ts";

const REPO = join(import.meta.dir, "..", "..");
const OUT_DIR = join(REPO, "docs", "media");
const CHROMIUM = process.env.CHROMIUM_PATH ?? "/usr/bin/chromium";
const WIDTH = 1280;
const HEIGHT = 720;
// Pages render at 2x and get scaled down, which keeps small UI text sharp.
const SCALE = 2;
const FPS = 30;
const FADE = 0.4;

const SCENES = { title: 3.4, loop: 7.2, outro: 4.8 } as const;

function run(cmd: string[], env?: Record<string, string>): void {
  const res = Bun.spawnSync(cmd, { cwd: REPO, env: env ?? process.env, stdout: "pipe", stderr: "pipe" });
  if (res.exitCode !== 0) throw new Error(`${cmd.join(" ")} exited ${res.exitCode}:\n${res.stderr.toString()}`);
}

function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port;
  probe.stop(true);
  if (port === undefined) throw new Error("could not pick a free port");
  return port;
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Server not listening yet.
    }
    await Bun.sleep(200);
  }
  throw new Error(`${url} did not answer within ${timeoutMs} ms`);
}

/** Encodes a numbered PNG sequence into a constant-rate 1280x720 segment. */
function encodeSequence(pattern: string, out: string): void {
  run([
    "ffmpeg", "-y", "-loglevel", "error", "-framerate", String(FPS), "-i", pattern,
    "-vf", `scale=${WIDTH}:${HEIGHT}:flags=lanczos,format=yuv420p`,
    "-c:v", "libx264", "-crf", "16", "-preset", "slow", out,
  ]);
}

type SceneWindow = {
  seek(t: number): void;
  loadConsole(data: ConsoleCapture): void;
  seekConsole(t: number): Promise<void>;
};

/** Captures one scene of scenes.html at FPS, `seek` placing each frame exactly. */
async function captureScene(
  browser: Browser,
  name: string,
  seconds: number,
  dir: string,
  seek: (page: Page, t: number) => Promise<void>,
  setup?: (page: Page) => Promise<void>,
): Promise<string> {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: SCALE });
  await page.goto(`${pathToFileURL(join(import.meta.dir, "scenes.html")).href}?scene=${name}&render=1`);
  await page.evaluate(() => document.fonts.ready);
  await setup?.(page);
  const frameDir = join(dir, `scene-${name}`);
  mkdirSync(frameDir);
  const frames = Math.round(seconds * FPS);
  for (let i = 0; i < frames; i++) {
    await seek(page, i / FPS);
    await page.screenshot({ path: join(frameDir, `${String(i).padStart(5, "0")}.png`) });
  }
  await page.close();
  const out = join(dir, `seg-${name}.mp4`);
  encodeSequence(join(frameDir, "%05d.png"), out);
  return out;
}

function renderScene(browser: Browser, name: keyof typeof SCENES, dir: string): Promise<string> {
  return captureScene(browser, name, SCENES[name], dir, (page, t) =>
    page.evaluate((s) => (window as unknown as SceneWindow).seek(s), t),
  );
}

function renderConsole(browser: Browser, capture: ConsoleCapture, dir: string): Promise<string> {
  return captureScene(
    browser,
    "console",
    capture.duration,
    dir,
    (page, t) => page.evaluate((s) => (window as unknown as SceneWindow).seekConsole(s), t),
    (page) => page.evaluate((data) => (window as unknown as SceneWindow).loadConsole(data), capture),
  );
}

// The screencast has no cursor, so one is drawn in the page. Captions and the
// camera are added later by the console scene, from the marks the walk leaves.
const OVERLAY = `
  try { localStorage.setItem("sil.theme", "dark"); } catch {}
  window.addEventListener("DOMContentLoaded", () => {
    const style = document.createElement("style");
    style.textContent = \`
      #demo-cursor { position: fixed; left: 0; top: 0; z-index: 99999; pointer-events: none;
        transform: translate(1100px, 640px); will-change: transform; }
      #demo-cursor svg { display: block; filter: drop-shadow(0 2px 3px rgb(0 0 0 / 0.5)); }
      #demo-ring { position: absolute; left: -18px; top: -18px; width: 36px; height: 36px; border-radius: 50%;
        border: 3px solid #4cc2bd; opacity: 0; }
      #demo-ring.on { animation: demo-ring 0.5s ease-out; }
      @keyframes demo-ring { from { opacity: 1; transform: scale(0.3); } to { opacity: 0; transform: scale(1.4); } }
    \`;
    document.head.append(style);
    const cursor = document.createElement("div");
    cursor.id = "demo-cursor";
    cursor.innerHTML = '<div id="demo-ring"></div><svg width="26" height="30" viewBox="0 0 26 30"><path d="M2 2 L2 24 L8 18.5 L12.5 28 L16.5 26.2 L12 17 L20 17 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.body.append(cursor);
  });
  window.__demo = {
    move(x, y, ms) {
      const el = document.getElementById("demo-cursor");
      el.style.transition = "transform " + ms + "ms cubic-bezier(0.45, 0, 0.2, 1)";
      el.style.transform = "translate(" + x + "px, " + y + "px)";
    },
    click() {
      const ring = document.getElementById("demo-ring");
      ring.classList.remove("on");
      void ring.offsetWidth;
      ring.classList.add("on");
    },
  };
`;

type Demo = { move(x: number, y: number, ms: number): void; click(): void };
type Box = { x: number; y: number; w: number; h: number };
/** A moment in the walk: a new caption, a new camera focus (null zooms out), or both. */
type Mark = { t: number; label?: string; caption?: string; focus?: Box | null };
type ConsoleCapture = { frames: { src: string; t: number }[]; marks: Mark[]; duration: number };

/** The union of the targets' boxes, clipped to the viewport. */
async function boxOf(...targets: Locator[]): Promise<Box> {
  const boxes = await Promise.all(targets.map((t) => t.boundingBox()));
  if (boxes.some((b) => b === null)) throw new Error("cannot frame a target that is not visible");
  const x0 = Math.max(0, Math.min(...boxes.map((b) => b!.x)));
  const y0 = Math.max(0, Math.min(...boxes.map((b) => b!.y)));
  const x1 = Math.min(WIDTH, Math.max(...boxes.map((b) => b!.x + b!.width)));
  const y1 = Math.min(HEIGHT, Math.max(...boxes.map((b) => b!.y + b!.height)));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

async function pointAt(page: Page, target: Locator, ms = 650): Promise<void> {
  const box = await target.boundingBox();
  if (box === null) throw new Error(`cannot point at ${target}: not visible`);
  const x = Math.round(box.x + Math.min(box.width / 2, 60));
  const y = Math.round(box.y + box.height / 2);
  await page.evaluate(({ x, y, ms }) => (window as unknown as { __demo: Demo }).__demo.move(x, y, ms), { x, y, ms });
  await page.waitForTimeout(ms + 80);
}

async function clickOn(page: Page, target: Locator): Promise<void> {
  await pointAt(page, target);
  await page.evaluate(() => (window as unknown as { __demo: Demo }).__demo.click());
  await target.click();
}

async function scrollTo(page: Page, target: Locator, options: { left?: "end" } = {}): Promise<void> {
  await target.evaluate(
    (el, left) =>
      left === "end"
        ? el.scrollTo({ left: el.scrollWidth, behavior: "smooth" })
        : el.scrollIntoView({ behavior: "smooth", block: "center" }),
    options.left,
  );
  await page.waitForTimeout(650);
}

function votesGood(text: string | null): number {
  const match = /^(\d+) good/.exec(text ?? "");
  if (match === null) throw new Error(`unexpected votes cell: ${JSON.stringify(text)}`);
  return Number(match[1]);
}

/** The scripted walk through the console. Keep it near 17 seconds. */
async function walkConsole(page: Page, mark: (m: Omit<Mark, "t">) => void): Promise<void> {
  const sankey = page.locator(".panel").filter({ hasText: "Pattern to proposal outcome" }).first();
  mark({ label: "Reflect", caption: "Every session leaves a lesson. Three alike make a pattern.", focus: await boxOf(sankey) });
  await page.waitForTimeout(300);
  await pointAt(page, page.getByText(STAGED_PATTERN).first(), 800);
  await page.waitForTimeout(1100);

  mark({ label: "Review", caption: "The loop drafted a skill on a git branch. You read it first.", focus: null });
  await clickOn(page, page.locator('a.rail__link[href="#/review"]'));
  await page.waitForURL("**#/review");
  const row = page.getByRole("option", { name: new RegExp(STAGED_PATTERN) });
  await row.waitFor();
  await clickOn(page, row);
  const acceptButton = page.getByRole("button", { name: "Accept proposal" });
  await acceptButton.waitFor();
  mark({ focus: await boxOf(page.getByText("Ready to accept"), page.locator(".action-bar")) });
  await page.waitForTimeout(1500);

  mark({ label: "Accept", caption: "Accept merges it. The next matching session gets the lesson." });
  await clickOn(page, acceptButton);
  // A failed accept only shows a toast, and the video would still look fine.
  await page.getByText(`${STAGED_PATTERN} accepted`).waitFor({ timeout: 10_000 });
  await page.getByText("Nothing is staged").waitFor({ timeout: 10_000 });
  await page.waitForTimeout(500);

  mark({ label: "Track", caption: "Every use is counted, with helpful and misfire signals.", focus: null });
  await clickOn(page, page.locator('a.rail__link[href="#/artifacts"]'));
  await page.waitForURL("**#/artifacts");
  const table = page.locator(".table-wrap").first();
  const skillRow = table.locator("tr", { hasText: PROMOTED_SKILL_PATTERN });
  const misfireRow = table.locator("tr", { hasText: MISFIRE_PATTERN });
  await skillRow.waitFor();
  await misfireRow.waitFor();
  await table.locator("tr", { hasText: STAGED_PATTERN }).waitFor();
  const votesCell = skillRow.locator("td").nth(8);
  const votesBefore = votesGood(await votesCell.textContent());
  mark({ focus: await boxOf(table.locator("thead th").nth(0), table.locator("tbody tr").last().locator("td").nth(8)) });
  await pointAt(page, skillRow.locator("td").nth(5), 700);
  await page.waitForTimeout(1000);

  mark({ label: "Rate", caption: "Rate it yourself. Your vote lands on the same scorecard.", focus: null });
  const verdict = page.locator(".panel").filter({ hasText: "Record your own verdict" });
  await scrollTo(page, verdict);
  mark({ focus: await boxOf(verdict) });
  const refInput = page.locator("#feedback-ref");
  await clickOn(page, refInput);
  await refInput.pressSequentially(`skill:${PROMOTED_SKILL_PATTERN}`, { delay: 25 });
  await clickOn(page, page.getByRole("button", { name: "Record feedback" }));
  await page.getByText("Feedback recorded").waitFor({ timeout: 10_000 });
  mark({ focus: null });
  await scrollTo(page, table);
  await votesCell.getByText(`${votesBefore + 1} good`).waitFor({ timeout: 10_000 });
  mark({ focus: await boxOf(table.locator("thead th").nth(0), skillRow.locator("td").nth(8)) });
  await pointAt(page, votesCell, 600);
  await page.waitForTimeout(700);

  mark({ label: "Decide", caption: "Misfires and bad votes flag it for a rewrite. You decide.", focus: null });
  await scrollTo(page, table, { left: "end" });
  const proposal = misfireRow.getByText("refine", { exact: true });
  await proposal.waitFor();
  mark({ focus: await boxOf(table.locator("thead th").nth(11), misfireRow.locator("td").nth(14)) });
  await pointAt(page, proposal, 700);
  await page.waitForTimeout(1600);
}

/**
 * Captures the console with the DevTools screencast. Frames only arrive when the
 * page repaints, so each keeps its own timestamp; the console scene picks the
 * latest frame at or before each output frame.
 */
async function recordConsole(browser: Browser, url: string, dir: string): Promise<ConsoleCapture> {
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: SCALE,
    colorScheme: "dark",
  });
  await context.addInitScript(OVERLAY);
  const page = await context.newPage();
  await page.goto(`${url}#/reflections`);
  await page.getByText(STAGED_PATTERN).first().waitFor();
  await page.waitForTimeout(800);

  const frameDir = join(dir, "console");
  mkdirSync(frameDir);
  const frames: { src: string; t: number }[] = [];
  const marks: Mark[] = [];
  const cdp = await context.newCDPSession(page);
  const t0 = Date.now() / 1000;
  cdp.on("Page.screencastFrame", (frame) => {
    const file = join(frameDir, `${String(frames.length).padStart(5, "0")}.jpg`);
    writeFileSync(file, Buffer.from(frame.data, "base64"));
    frames.push({ src: pathToFileURL(file).href, t: (frame.metadata.timestamp ?? Date.now() / 1000) - t0 });
    void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId });
  });
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 95,
    maxWidth: WIDTH * SCALE,
    maxHeight: HEIGHT * SCALE,
  });
  await page.waitForTimeout(300);
  await walkConsole(page, (m) => marks.push({ t: Date.now() / 1000 - t0, ...m }));
  await cdp.send("Page.stopScreencast");
  const duration = Date.now() / 1000 - t0;
  await context.close();
  if (frames.length < 10) throw new Error(`screencast produced only ${frames.length} frames`);
  return { frames, marks, duration };
}

function probeSeconds(file: string): number {
  const res = Bun.spawnSync(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  const seconds = Number(res.stdout.toString().trim());
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`ffprobe could not read ${file}`);
  return seconds;
}

/** Joins the segments with short crossfades, then derives the GIF from the MP4. */
function assemble(segments: string[], mp4: string, gif: string): void {
  const inputs = segments.flatMap((s) => ["-i", s]);
  const filters: string[] = [];
  let offset = 0;
  let prev = "[0:v]";
  segments.slice(1).forEach((_, i) => {
    offset += probeSeconds(segments[i]!) - FADE;
    const label = `[x${i + 1}]`;
    filters.push(`${prev}[${i + 1}:v]xfade=transition=fade:duration=${FADE}:offset=${offset.toFixed(3)}${label}`);
    prev = label;
  });
  run([
    "ffmpeg", "-y", "-loglevel", "error", ...inputs,
    "-filter_complex", filters.join(";"), "-map", prev,
    "-c:v", "libx264", "-crf", "20", "-preset", "slow", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4,
  ]);
  run([
    "ffmpeg", "-y", "-loglevel", "error", "-i", mp4,
    // The camera moves change most of every frame, so frame diffs barely help.
    // 10 fps, 880 px and no dithering keep the GIF near 7 MB.
    "-vf", "fps=10,scale=880:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff:max_colors=128[p];[b][p]paletteuse=dither=none:diff_mode=rectangle",
    gif,
  ]);
}

async function main(): Promise<void> {
  const keep = process.argv.includes("--keep");
  if (!existsSync(join(REPO, "dist", "web", "index.html"))) throw new Error("dist/web is missing: run `bun run build` first");
  if (!existsSync(CHROMIUM)) throw new Error(`no Chromium at ${CHROMIUM}: set CHROMIUM_PATH`);
  run(["ffmpeg", "-version"]);

  const work = mkdtempSync(join(tmpdir(), "sil-demo-"));
  const home = join(work, "home");
  const env = demoEnv(home, REPO);
  let server: ReturnType<typeof Bun.spawn> | undefined;
  let browser: Browser | undefined;
  try {
    const port = freePort();
    run([process.execPath, join(import.meta.dir, "seed.ts"), home], env);
    server = Bun.spawn([process.execPath, "apps/cli/src/main.ts", "web", "--port", String(port), "--no-watch"], {
      cwd: REPO,
      env,
      stdout: "ignore",
      stderr: "inherit",
    });
    const url = `http://127.0.0.1:${port}/`;
    await waitForHttp(url, 20_000);

    browser = await chromium.launch({ executablePath: CHROMIUM });
    const title = await renderScene(browser, "title", work);
    const loop = await renderScene(browser, "loop", work);
    const consoleSeg = await renderConsole(browser, await recordConsole(browser, url, work), work);
    const outro = await renderScene(browser, "outro", work);

    // Both files are built in the temp dir first, so a failed GIF never leaves
    // a new MP4 next to an old GIF.
    const tmpMp4 = join(work, "demo.mp4");
    const tmpGif = join(work, "demo.gif");
    assemble([title, loop, consoleSeg, outro], tmpMp4, tmpGif);
    const seconds = probeSeconds(tmpMp4);
    probeSeconds(tmpGif);
    mkdirSync(OUT_DIR, { recursive: true });
    const mp4 = join(OUT_DIR, "demo.mp4");
    const gif = join(OUT_DIR, "demo.gif");
    copyFileSync(tmpMp4, mp4);
    copyFileSync(tmpGif, gif);
    console.log(`wrote ${mp4} (${seconds.toFixed(1)} s, ${(Bun.file(mp4).size / 1e6).toFixed(2)} MB)`);
    console.log(`wrote ${gif} (${(Bun.file(gif).size / 1e6).toFixed(2)} MB)`);
  } finally {
    // Each step runs even when an earlier one throws, so no server is orphaned.
    await browser?.close().catch((e: unknown) => console.error(`browser close failed: ${String(e)}`));
    if (server) {
      server.kill();
      await server.exited;
    }
    if (keep) console.log(`kept ${work}`);
    else rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
