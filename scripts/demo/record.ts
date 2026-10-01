#!/usr/bin/env bun
// Records the README demo: docs/media/demo.mp4 and docs/media/demo.gif.
//
// Title, loop diagram and outro come from scenes.html, captured frame by frame.
// The middle part is the real web console, served by `sil web` over a demo home
// that seed.ts builds in a temp dir. No real install is read and no model is
// called.
//
// Run: bun run build && bun run demo:record [--keep]
// Needs ffmpeg and a Chromium binary (CHROMIUM_PATH, default /usr/bin/chromium).
// --keep leaves the temp dir (demo home, frames, segments) in place.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, type Browser, type Locator, type Page } from "playwright-core";

import { demoEnv, STAGED_PATTERN } from "./seed.ts";

const REPO = join(import.meta.dir, "..", "..");
const OUT_DIR = join(REPO, "docs", "media");
const CHROMIUM = process.env.CHROMIUM_PATH ?? "/usr/bin/chromium";
const WIDTH = 1280;
const HEIGHT = 720;
// Pages render at 2x and get scaled down, which keeps small UI text sharp.
const SCALE = 2;
const FPS = 30;
const FADE = 0.4;

const SCENES = { title: 4.4, loop: 8.6, outro: 5.4 } as const;

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

async function renderScene(browser: Browser, name: keyof typeof SCENES, dir: string): Promise<string> {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: SCALE });
  await page.goto(`file://${join(import.meta.dir, "scenes.html")}?scene=${name}&render=1`);
  await page.evaluate(() => document.fonts.ready);
  const frames = Math.round(SCENES[name] * FPS);
  const frameDir = join(dir, `scene-${name}`);
  mkdirSync(frameDir);
  for (let i = 0; i < frames; i++) {
    await page.evaluate((t) => (window as unknown as { seek: (s: number) => void }).seek(t), i / FPS);
    await page.screenshot({ path: join(frameDir, `${String(i).padStart(5, "0")}.png`) });
  }
  await page.close();
  const out = join(dir, `seg-${name}.mp4`);
  encodeSequence(join(frameDir, "%05d.png"), out);
  return out;
}

// Playwright video has no cursor and no captions, so both are drawn in the page.
// Captions sit in the empty middle of the top bar, clear of the action buttons.
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
      #demo-caption { position: fixed; left: 50%; top: 5px; z-index: 99998; pointer-events: none;
        transform: translateX(-50%); max-width: 720px; padding: 7px 18px; border-radius: 10px;
        background: rgb(6 33 31 / 0.95); border: 1px solid #4cc2bd; color: #e6e9ef;
        font: 600 17px Inter, Roboto, system-ui, sans-serif; text-align: center; white-space: nowrap;
        box-shadow: 0 8px 30px rgb(0 0 0 / 0.5); opacity: 0; transition: opacity 0.25s; }
      #demo-caption.on { opacity: 1; }
    \`;
    document.head.append(style);
    const cursor = document.createElement("div");
    cursor.id = "demo-cursor";
    cursor.innerHTML = '<div id="demo-ring"></div><svg width="26" height="30" viewBox="0 0 26 30"><path d="M2 2 L2 24 L8 18.5 L12.5 28 L16.5 26.2 L12 17 L20 17 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    const caption = document.createElement("div");
    caption.id = "demo-caption";
    document.body.append(cursor, caption);
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
    caption(text) {
      const el = document.getElementById("demo-caption");
      el.classList.remove("on");
      setTimeout(() => { el.textContent = text; el.classList.add("on"); }, text ? 120 : 0);
    },
  };
`;

type Demo = { move(x: number, y: number, ms: number): void; click(): void; caption(text: string): void };

async function caption(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => (window as unknown as { __demo: Demo }).__demo.caption(t), text);
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

/** The scripted walk through the console. Keep it near 12 seconds. */
async function walkConsole(page: Page): Promise<void> {
  await caption(page, "Every session leaves a lesson. Four alike make a pattern.");
  await pointAt(page, page.getByText(STAGED_PATTERN).first(), 800);
  await page.waitForTimeout(1500);

  await caption(page, "The loop drafted a skill on a git branch. You read it first.");
  await clickOn(page, page.locator('a.rail__link[href="#/review"]'));
  await page.waitForURL("**#/review");
  const row = page.getByRole("option", { name: new RegExp(STAGED_PATTERN) });
  await row.waitFor();
  await clickOn(page, row);
  const acceptButton = page.getByRole("button", { name: "Accept proposal" });
  await acceptButton.waitFor();
  await page.waitForTimeout(1800);

  await caption(page, "Accept merges it. The next matching session gets the lesson.");
  await clickOn(page, acceptButton);
  await page.waitForTimeout(900);

  await caption(page, "Scorecards show whether each lesson is used and helpful.");
  await clickOn(page, page.locator('a.rail__link[href="#/artifacts"]'));
  await page.waitForURL("**#/artifacts");
  const artifactRow = page.locator("tr", { hasText: "read-before-edit" });
  await artifactRow.waitFor();
  await pointAt(page, artifactRow, 700);
  await page.waitForTimeout(1700);
}

/**
 * Captures the console with the DevTools screencast. Frames only arrive when the
 * page repaints, so each keeps its own timestamp and ffmpeg's concat demuxer
 * turns them back into real-time video.
 */
async function recordConsole(browser: Browser, url: string, dir: string): Promise<string> {
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
  const frames: { file: string; ts: number }[] = [];
  const cdp = await context.newCDPSession(page);
  cdp.on("Page.screencastFrame", (frame) => {
    const file = join(frameDir, `${String(frames.length).padStart(5, "0")}.jpg`);
    writeFileSync(file, Buffer.from(frame.data, "base64"));
    frames.push({ file, ts: frame.metadata.timestamp ?? Date.now() / 1000 });
    void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId });
  });
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 95,
    maxWidth: WIDTH * SCALE,
    maxHeight: HEIGHT * SCALE,
  });
  await page.waitForTimeout(300);
  await walkConsole(page);
  await cdp.send("Page.stopScreencast");
  const end = Date.now() / 1000;
  await context.close();
  if (frames.length < 10) throw new Error(`screencast produced only ${frames.length} frames`);

  const lines: string[] = [];
  frames.forEach((f, i) => {
    const next = frames[i + 1]?.ts ?? end;
    lines.push(`file '${f.file}'`, `duration ${Math.max(next - f.ts, 0.001).toFixed(4)}`);
  });
  // The concat demuxer ignores the last duration unless the file repeats.
  lines.push(`file '${frames.at(-1)!.file}'`);
  const list = join(dir, "console.txt");
  writeFileSync(list, lines.join("\n") + "\n");
  const out = join(dir, "seg-console.mp4");
  run([
    "ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list,
    "-vf", `fps=${FPS},scale=${WIDTH}:${HEIGHT}:flags=lanczos,format=yuv420p`,
    "-c:v", "libx264", "-crf", "16", "-preset", "slow", out,
  ]);
  return out;
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
    "-vf", "fps=15,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff:max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
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
  const port = freePort();
  let server: ReturnType<typeof Bun.spawn> | undefined;
  let browser: Browser | undefined;
  try {
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
    const consoleSeg = await recordConsole(browser, url, work);
    const outro = await renderScene(browser, "outro", work);

    mkdirSync(OUT_DIR, { recursive: true });
    const mp4 = join(OUT_DIR, "demo.mp4");
    const gif = join(OUT_DIR, "demo.gif");
    assemble([title, loop, consoleSeg, outro], mp4, gif);
    console.log(`wrote ${mp4} (${probeSeconds(mp4).toFixed(1)} s, ${(Bun.file(mp4).size / 1e6).toFixed(2)} MB)`);
    console.log(`wrote ${gif} (${(Bun.file(gif).size / 1e6).toFixed(2)} MB)`);
  } finally {
    await browser?.close();
    if (server) {
      server.kill();
      await server.exited;
    }
    if (keep) console.log(`kept ${work}`);
    else rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
