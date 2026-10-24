// Test-only child: the real HTTP server, started with the explicit fixture
// env as its own startup environment. Before serving, it checks from this same
// process that `claude` resolves to the fixture's fake and records one
// positive-control call; it never runs a `claude` that is not the fake.
// argv: <fixture root> <token>. Prints one JSON line, serves until stdin closes.

import { realpathSync } from "node:fs";
import { join } from "node:path";
import { paths } from "@sil/core";
import { createServer } from "../apps/server/src/main.ts";

const [root, token] = process.argv.slice(2);
if (!root || !token) {
  console.error("usage: http-server-child <root> <token>");
  process.exit(2);
}
const realRoot = realpathSync(root);
for (const dir of [paths.dataDir(), paths.stateDir(), paths.configDir(), process.env["HOME"] ?? ""]) {
  if (!dir.startsWith(`${realRoot}/`)) {
    console.error("child env escapes the fixture root");
    process.exit(3);
  }
}

const fake = join(realRoot, "bin", "claude");
// No env option: exactly what a spawn from this server process would inherit.
const which = Bun.spawnSync(["/bin/sh", "-c", "command -v claude"], { stdout: "pipe", stderr: "pipe" });
const resolvedClaude = which.stdout.toString().trim();
let controlExit: number | null = null;
if (resolvedClaude === fake) {
  controlExit = Bun.spawnSync(["/bin/sh", "-c", "claude --server-positive-control"], { stdout: "ignore", stderr: "ignore" }).exitCode;
}

const server = createServer({ port: 0, host: "127.0.0.1", token });
process.stdout.write(`${JSON.stringify({ port: server.port, pid: process.pid, resolvedClaude, fake, controlExit })}\n`);

// Drain until the parent closes stdin.
const reader = Bun.stdin.stream().getReader();
while (!(await reader.read()).done) {
  // Nothing to read; stdin only signals teardown.
}
server.stop(true);
process.exit(0);
