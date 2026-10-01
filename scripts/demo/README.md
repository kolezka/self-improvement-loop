# Demo recording

Rebuilds `docs/media/demo.mp4` and `docs/media/demo.gif`. Everything shown is fake data in a throwaway SIL home; no model is called and your real `~/.local/share/self-improvement-loop` is never read.

```sh
scripts/demo/record.sh                       # seed /tmp/sil-demo-home, serve the console on :8799
cd scripts/demo && bun install && bun capture.mjs   # in a second shell
```

Needs Google Chrome (or `CHROME_PATH`) and `ffmpeg`. Scene copy and timing live in `scenes.html`; the console part comes from `seed.ts`.
