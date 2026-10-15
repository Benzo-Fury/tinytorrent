/**
 * Seeds a real torrent to its public swarm: downloads it first (or reuses
 * the data), then seeds for a while and reports, every 10 s, how much went
 * to whom. Prints JSON lines: `sample`s, then a `result`.
 *
 *   bun bench/real-seed.ts <json options>
 */

import { readFile } from "node:fs/promises";
import { Engine, type EncryptionPolicy } from "../src/index";

/** What the CLI passes in. */
export interface RealSeedOptions {
  source: string;
  dir: string;
  resumeDir: string;
  seconds: number;
  encryption: EncryptionPolicy;
  maxPeers: number;
  port?: number;
}

const options = JSON.parse(process.argv[2] ?? "{}") as RealSeedOptions;
const input = options.source.startsWith("magnet:") ? options.source : new Uint8Array(await readFile(options.source));
const engine = new Engine({
  port: options.port,
  encryption: options.encryption,
  maxPeersPerTorrent: options.maxPeers,
  resumeDir: options.resumeDir,
  seed: { enabled: true },
});
const torrent = engine.add(input, { dir: options.dir });
torrent.on("warning", (w: string) => console.error(`[tinytorrent] ${w}`));
const started = performance.now();
// Progress while downloading; give up (with the reasons) after 30 minutes
const progress = setInterval(() => {
  const st = torrent.stats();
  console.error(
    `  ${((performance.now() - started) / 1000).toFixed(0)} s: ${(st.progress * 100).toFixed(1)}% at ${((st.downloadRate * 8) / 1e6).toFixed(1)} Mbit/s, ${st.peers.length} peers, ${st.hashFailures} hash failures, endgame ${st.endgame}, ${st.activePieces} pieces in flight`,
  );
}, 30_000);
const completed = await Promise.race([
  new Promise<boolean>((resolve) => (torrent.state === "seeding" ? resolve(true) : torrent.once("done", () => resolve(true)))),
  Bun.sleep(30 * 60_000).then(() => false),
]);
clearInterval(progress);
if (!completed) {
  const st = torrent.stats();
  console.log(JSON.stringify({ type: "result", error: "download did not finish", progress: st.progress, closeReasons: st.closeReasons, hashFailures: st.hashFailures, endgame: st.endgame }));
  process.exit(1);
}
const stats0 = torrent.stats();
console.error(
  `complete after ${((performance.now() - started) / 1000).toFixed(0)} s (${stats0.hashFailures} hash failures, peers closed: ${JSON.stringify(stats0.closeReasons)}); seeding for ${options.seconds} s`,
);

const cpuStart = process.cpuUsage();
const seedStart = performance.now();
const base = torrent.uploaded;
/** Bytes uploaded per client name, from peers seen at each sample. */
const byClient = new Map<string, number>();
const lastUp = new Map<string, number>();
while (performance.now() - seedStart < options.seconds * 1000) {
  await Bun.sleep(10_000);
  const stats = torrent.stats();
  for (const p of torrent.peers) {
    const key = `${p.address}`;
    const delta = p.uploaded - (lastUp.get(key) ?? 0);
    lastUp.set(key, p.uploaded);
    if (delta > 0) byClient.set(p.client || "?", (byClient.get(p.client || "?") ?? 0) + delta);
  }
  console.log(
    JSON.stringify({
      type: "sample",
      t: (performance.now() - seedStart) / 1000,
      uploaded: torrent.uploaded - base,
      uploadRate: torrent.uploadRate,
      peers: stats.peers.length,
      interested: [...torrent.peers].filter((p) => p.peerInterested).length,
      slots: stats.slots,
      cache: stats.cache,
    }),
  );
}
const cpu = process.cpuUsage(cpuStart);
const stats = torrent.stats();
console.log(
  JSON.stringify({
    type: "result",
    seconds: (performance.now() - seedStart) / 1000,
    uploaded: torrent.uploaded - base,
    cpuSeconds: (cpu.user + cpu.system) / 1e6,
    closeReasons: stats.closeReasons,
    clients: Object.fromEntries([...byClient].sort((a, b) => b[1] - a[1]).slice(0, 12)),
    trackers: stats.trackers.map((t) => ({ url: t.url, seeders: t.seeders, leechers: t.leechers, error: t.error })),
    cache: stats.cache,
    announcePort: engine.announcePort(),
  }),
);
await Promise.race([engine.destroy(), Bun.sleep(3000)]);
process.exit(0);
