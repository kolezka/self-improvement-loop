import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

// Relative base so the bundle works on any port; output goes to the committed dist/web.
export default defineConfig({
  plugins: [svelte()],
  base: "./",
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:8766" },
  },
});
