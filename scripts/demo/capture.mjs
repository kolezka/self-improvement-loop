// Screenshots the demo console, renders scenes.html frame by frame, and
// encodes docs/media/demo.mp4 and demo.gif. Needs record.sh running and ffmpeg.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const FPS = 30;
const DURATION = 30;
const CONSOLE = process.env.SIL_DEMO_URL ?? "http://127.0.0.1:8799";
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const here = import.meta.dir;
const media = join(here, "../../docs/media");
const work = mkdtempSync(join(tmpdir(), "sil-demo-capture-"));
const frames = join(work, "frames");
mkdirSync(frames);
mkdirSync(media, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--allow-file-access-from-files"] });
const page = await browser.newPage();

// 1. Console panes, dark theme, 2x for crisp zooms.
await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 2 });
await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
for (const pane of ["reflections", "review", "artifacts"]) {
  await page.goto(`${CONSOLE}/#/${pane}`, { waitUntil: "networkidle0" });
  if (pane === "review") {
    // Hash-only navigation keeps the old page, so wait for the pane to mount
    // and for the detail tabs to prove the click opened a proposal.
    await page.waitForFunction(() => document.querySelectorAll("button.row").length >= 2);
    await page.$$eval("button.row", (rows) => rows[rows.length - 1].click());
    await page.waitForSelector('[role="tab"]', { timeout: 10_000 });
  }
  await page.mouse.move(1279, 719);
  await sleep(1500);
  await page.screenshot({ path: join(work, `${pane}.png`) });
}

// 2. Scenes, one screenshot per frame at a fixed clock.
await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
await page.goto(`file://${here}/scenes.html`);
await page.evaluate(async (shots) => {
  for (const [id, src] of Object.entries(shots)) document.getElementById(id).src = src;
  await Promise.all(Array.from(document.images, (i) => i.decode()));
}, { img4: `file://${work}/reflections.png`, img5: `file://${work}/review.png`, img6: `file://${work}/artifacts.png` });
for (let i = 0; i < FPS * DURATION; i++) {
  await page.evaluate((t) => window.render(t), i / FPS);
  await page.screenshot({ path: join(frames, `${String(i).padStart(4, "0")}.png`) });
}
await browser.close();

// 3. Encode. The GIF is 800 px at 12 fps to stay under GitHub's 10 MB image limit.
const ffmpeg = (args) => {
  const r = Bun.spawnSync(["ffmpeg", "-y", "-loglevel", "error", ...args]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
};
const mp4 = join(media, "demo.mp4");
ffmpeg(["-framerate", `${FPS}`, "-i", join(frames, "%04d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-movflags", "+faststart", mp4]);
const vf = "fps=12,scale=800:-1:flags=lanczos";
const palette = join(work, "palette.png");
ffmpeg(["-i", mp4, "-vf", `${vf},palettegen=max_colors=96:stats_mode=diff`, palette]);
ffmpeg(["-i", mp4, "-i", palette, "-lavfi", `${vf}[x];[x][1:v]paletteuse=dither=none:diff_mode=rectangle`, join(media, "demo.gif")]);
rmSync(work, { recursive: true, force: true });
console.log(`wrote ${mp4} and demo.gif`);
