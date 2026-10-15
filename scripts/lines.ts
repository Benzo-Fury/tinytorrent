/**
 * Line budgets: Tiny Torrent's core must stay tiny. Prints every module's
 * size (all lines, and code lines without comments or blanks) against its
 * budget, and exits non-zero when the core's code goes over.
 *
 *   bun scripts/lines.ts
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Ceilings in code lines (comments and blank lines don't count); see
 * docs/DEVELOPMENT.md#line-budget. The total is the real gate; a module's
 * ceiling stops one file quietly absorbing the others' savings.
 */
const BUDGETS: Record<string, number> = {
  "bencode.ts": 170,
  "bitfield.ts": 60,
  "cache.ts": 85,
  "connections.ts": 230,
  "create.ts": 155,
  "dht.ts": 365,
  "engine.ts": 345,
  "extensions.ts": 195,
  "index.ts": 35,
  "limits.ts": 30,
  "metainfo.ts": 170,
  "mse.ts": 290,
  "peer.ts": 230,
  "picker.ts": 350,
  "portmap.ts": 220,
  "resume.ts": 45,
  "seeding.ts": 80,
  "storage.ts": 145,
  "swarm.ts": 295,
  "torrent.ts": 915,
  "tracker.ts": 250,
  "transport.ts": 145,
  "verifier.ts": 65,
  "wire.ts": 240,
};
const CORE_BUDGET = 5000;

const dir = join(import.meta.dir, "..", "src");
let total = 0;
let code = 0;
let over = false;
console.log(`${"module".padEnd(18)}${"lines".padStart(7)}${"code".padStart(7)}${"budget".padStart(8)}`);
for (const file of (await readdir(dir)).filter((f) => f.endsWith(".ts")).sort()) {
  const text = await readFile(join(dir, file), "utf8");
  const lines = text.split("\n");
  let inBlock = false;
  let codeLines = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (inBlock) {
      if (line.includes("*/")) inBlock = false;
      continue;
    }
    if (line.startsWith("/*")) {
      inBlock = !line.includes("*/");
      continue;
    }
    if (line === "" || line.startsWith("//")) continue;
    codeLines++;
  }
  const budget = BUDGETS[file];
  const flag = budget !== undefined && codeLines > budget ? "  over" : "";
  if (flag) over = true;
  total += lines.length;
  code += codeLines;
  console.log(`${file.padEnd(18)}${String(lines.length).padStart(7)}${String(codeLines).padStart(7)}${String(budget ?? "-").padStart(8)}${flag}`);
}
console.log(`${"total".padEnd(18)}${String(total).padStart(7)}${String(code).padStart(7)}${String(CORE_BUDGET).padStart(8)}`);
if (code > CORE_BUDGET || over) {
  console.error("Over budget: that's a design problem, not a reason to raise the budget.");
  process.exit(1);
}
