/**
 * Tiny Torrent's side of a conformance case.
 *
 *   bun conformance/peer.ts make <dir> <tracker-url>        payload + torrent into <dir>
 *   bun conformance/peer.ts seed <dir> <policy> [flags]     seed <dir>/data until killed
 *   bun conformance/peer.ts leech <dir> <policy> [flags]    download into <dir>/out, verify, exit 0
 *
 * Flags: `--magnet` (leech from a magnet link), `--seed-mode` (seed without
 * hashing first), `--torrent <name>` (a torrent file in <dir> other than
 * payload.torrent).
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTorrent, Engine, type EncryptionPolicy, parseTorrent } from "../src/index";

const [mode, dir = "/shared", arg, ...flags] = process.argv.slice(2);
const magnetFlag = flags.includes("--magnet");
const seedMode = flags.includes("--seed-mode");
const torrentName = flags.includes("--torrent") ? (flags[flags.indexOf("--torrent") + 1] as string) : "payload.torrent";
const PORT = 6881;

if (mode === "make") {
  const data = new Uint8Array(randomBytes(48 * 1024 * 1024 + 12345));
  const extra = new Uint8Array(randomBytes(3 * 1024 * 1024));
  await mkdir(join(dir, "data", "conformance"), { recursive: true });
  await writeFile(join(dir, "data", "conformance", "movie.mkv"), data);
  await writeFile(join(dir, "data", "conformance", "extra.bin"), extra);
  const torrent = createTorrent({
    name: "conformance",
    files: [
      { path: "movie.mkv", data },
      { path: "extra.bin", data: extra },
    ],
    pieceLength: 256 * 1024,
    announce: [arg as string],
  });
  await writeFile(join(dir, "payload.torrent"), torrent);
  console.log(`made ${parseTorrent(torrent).infoHashHex}`);
  process.exit(0);
}

const policy = (arg ?? "prefer") as EncryptionPolicy;
const engine = new Engine({ port: PORT, dht: false, encryption: policy, upload: { slots: 50 }, seed: { enabled: mode === "seed" } });
const torrentFile = new Uint8Array(await readFile(join(dir, torrentName)));
const meta = parseTorrent(torrentFile);

if (mode === "seed") {
  const t = engine.add(torrentFile, { dir: join(dir, "data"), seedMode });
  t.on("done", () => console.log(`seeding (${t.stats().unverified} pieces not yet hashed)`));
  setInterval(() => console.log(`uploaded ${(t.uploaded / 1e6).toFixed(1)} MB to ${t.peers.size} peers`), 5000);
} else {
  const input = magnetFlag ? `magnet:?xt=urn:btih:${meta.infoHashHex}&tr=${encodeURIComponent(meta.announce[0] as string)}` : torrentFile;
  const out = join(dir, `out-${Date.now()}`);
  const started = performance.now();
  const t = engine.add(input, { dir: out });
  t.on("metadata", () => console.log("metadata received"));
  const timer = setTimeout(() => {
    console.log(`FAIL: timed out at ${(t.progress * 100).toFixed(1)}%`, JSON.stringify(t.stats().closeReasons));
    process.exit(1);
  }, 120_000);
  await new Promise((resolve) => t.once("done", resolve));
  clearTimeout(timer);
  const stats = t.stats();
  for (const f of meta.files) {
    const a = await readFile(join(out, ...f.path.split("/")));
    const b = await readFile(join(dir, "data", ...f.path.split("/")));
    if (!a.equals(b)) {
      console.log(`FAIL: ${f.path} differs`);
      process.exit(1);
    }
  }
  const peers = stats.peers.map((p) => `${p.client}${p.encrypted ? " (rc4)" : " (plain)"}`).join(", ");
  console.log(`OK: ${(meta.length / 1e6).toFixed(0)} MB in ${((performance.now() - started) / 1000).toFixed(1)} s from ${peers || "peers that already left"}`);
  process.exit(0);
}
