// Fail when a tracked text file contains an em dash or an en dash.
// Detection literals are built from code points so this file passes itself.

const EM = String.fromCodePoint(0x2014);
const EN = String.fromCodePoint(0x2013);

const proc = Bun.spawnSync(["git", "ls-files"], { cwd: import.meta.dir + "/.." });
const files = proc.stdout.toString().split("\n").filter((f) => f && /\.(ts|js|svelte|md|json|html|css|sh|toml|yaml|yml)$/.test(f));
const skip = /(^|\/)(bun\.lock|dist\/|node_modules\/)/;
let bad = 0;
for (const f of files) {
  if (skip.test(f) || f === "scripts/lint-dashes.ts") continue;
  const text = await Bun.file(import.meta.dir + "/../" + f).text();
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (line.includes(EM) || line.includes(EN)) {
      console.log(`${f}:${i + 1}: long dash`);
      bad++;
    }
  });
}
if (bad > 0) {
  console.error(`${bad} line(s) with a long dash`);
  process.exit(1);
}
console.log("no long dashes");
