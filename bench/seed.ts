/**
 * A Tiny Torrent seeder for the local swarm, in its own process.
 *
 *   bun bench/seed.ts <file.torrent> <dir> <resumeDir>
 *
 * Prints `ready <port>` once the data is verified and it is listening.
 */

import { readFile } from "node:fs/promises";
import { Engine } from "../src/index";

const [torrentPath, dir, resumeDir] = process.argv.slice(2) as [string, string, string];
const engine = new Engine({
  dht: false,
  pex: false,
  resumeDir,
  encryption: (process.env.TT_ENCRYPTION as "prefer") ?? "prefer",
  upload: { slots: 1000 },
  seed: { enabled: true },
});
const torrent = engine.add(await readFile(torrentPath), { dir });
await new Promise<void>((resolve) => (torrent.state === "seeding" ? resolve() : torrent.once("done", () => resolve())));
await engine.ready();
console.log(`ready ${engine.port()}`);
process.on("SIGTERM", () => process.exit(0));
