import { readFileSync } from "node:fs";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

// The tool version comes from the root package.json, the one source every
// workspace package version is kept in step with.
const rootPackage = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };

// Relative base so the bundle works on any port; output goes to dist/web.
export default defineConfig({
  plugins: [svelte()],
  base: "./",
  define: {
    __SIL_VERSION__: JSON.stringify(rootPackage.version),
  },
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:8766" },
  },
});
