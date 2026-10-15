/**
 * Downloads one torrent with one engine, in its own process, and reports
 * progress as JSON lines on stdout: a `sample` every second and a final
 * `result` with the process's own CPU time and peak memory.
 *
 *   bun bench/leech.ts <json options>
 *
 * Engines: `tinytorrent`, `webtorrent` (patched, as Findr ships it). aria2 is
 * driven directly by the CLI, since it is a separate binary anyway.
 */

import { readFile } from "node:fs/promises";

/** What the CLI passes in. */
export interface LeechOptions {
  engine: "tinytorrent" | "webtorrent";
  /** Path to a .torrent file, or a magnet link. */
  source: string;
  dir: string;
  seconds: number;
  maxPeers: number;
  encryption: "require" | "prefer" | "prefer-plaintext" | "off";
  dht: boolean;
  /** Write a CPU profile here when set (tinytorrent only). */
  profile?: string;
  /** Peers to dial directly (tinytorrent only), besides the torrent's trackers. */
  peers?: string[];
}

/** A progress line. */
export interface Sample {
  type: "sample";
  t: number;
  bytes: number;
  peers: number;
}

/** The final line. */
export interface Result {
  type: "result";
  engine: string;
  done: boolean;
  bytes: number;
  seconds: number;
  cpuSeconds: number;
  /** Of which in the kernel: socket reads, disk writes. */
  systemSeconds?: number;
  maxRssMb: number;
  peers: number;
  extra?: Record<string, unknown>;
}

const options = JSON.parse(process.argv[2] ?? "{}") as LeechOptions;
const input = options.source.startsWith("magnet:") ? options.source : new Uint8Array(await readFile(options.source));
const cpuStart = process.cpuUsage();
const started = performance.now();

/** A running download, whichever engine. */
interface Download {
  bytes(): number;
  peers(): number;
  done: Promise<void>;
  extra(): Record<string, unknown>;
  stop(): Promise<void>;
}

async function tinytorrent(): Promise<Download> {
  const { Engine } = await import("../src/index");
  const engine = new Engine({
    dht: options.dht,
    encryption: options.encryption,
    maxPeersPerTorrent: options.maxPeers,
    upload: { slots: 0 },
  });
  const torrent = engine.add(input, { dir: options.dir, peers: options.peers });
  torrent.on("warning", (w: string) => console.error(`[tinytorrent] ${w}`));
  // Time to metadata and to the first connected peer: how fast a magnet starts
  let metadataSeconds: number | null = "pieces" in torrent && torrent.info ? 0 : null;
  let firstPeerSeconds: number | null = null;
  torrent.once("metadata", () => (metadataSeconds ??= (performance.now() - started) / 1000));
  const watch = setInterval(() => {
    if (firstPeerSeconds === null && torrent.peers.size > 0) firstPeerSeconds = (performance.now() - started) / 1000;
  }, 50);
  return {
    bytes: () => torrent.downloaded,
    peers: () => torrent.peers.size,
    done: new Promise((resolve) => torrent.once("done", () => resolve())),
    extra: () => {
      const stats = torrent.stats();
      return {
        metadataSeconds,
        firstPeerSeconds,
        wasted: stats.wasted,
        hashFailures: stats.hashFailures,
        candidates: stats.candidates,
        closeReasons: stats.closeReasons,
        encryptedPeers: stats.peers.filter((p) => p.encrypted).length,
        topPeers: stats.peers
          .sort((a, b) => b.downloadRate - a.downloadRate)
          .slice(0, 5)
          .map((p) => `${p.client || "?"} ${(p.downloadRate / 1e6).toFixed(2)}MB/s rtt=${p.rtt.toFixed(0)} q=${p.requests}/${p.depth}`),
      };
    },
    stop: () => {
      clearInterval(watch);
      return engine.destroy();
    },
  };
}

async function webtorrent(): Promise<Download> {
  await import("./webtorrent-preload");
  const { default: WebTorrent } = await import("webtorrent");
  // As Findr configures it: no uTP, no LSD
  const client = new WebTorrent({ utp: false, dht: options.dht, lsd: false, maxConns: options.maxPeers } as never);
  // biome-ignore lint: WebTorrent's types are loose
  const torrent: any = (client as any).add(input instanceof Uint8Array ? Buffer.from(input) : input, {
    path: options.dir,
  });
  return {
    bytes: () => torrent.downloaded ?? 0,
    peers: () => torrent.numPeers ?? 0,
    done: new Promise((resolve) => torrent.once("done", () => resolve())),
    extra: () => ({}),
    stop: () => new Promise<void>((resolve) => client.destroy(() => resolve())),
  };
}

const download = options.engine === "webtorrent" ? await webtorrent() : await tinytorrent();
let finished = false;
download.done.then(() => (finished = true));

// Sample once a second until done or out of time
const deadline = started + options.seconds * 1000;
while (!finished && performance.now() < deadline) {
  await Promise.race([download.done, Bun.sleep(1000)]);
  const sample: Sample = { type: "sample", t: (performance.now() - started) / 1000, bytes: download.bytes(), peers: download.peers() };
  console.log(JSON.stringify(sample));
}

/** CPU seconds per thread name on Linux, to see where time goes beyond the JS thread. */
async function threadCpu(): Promise<Record<string, number>> {
  if (process.platform !== "linux") return {};
  const { readdir } = await import("node:fs/promises");
  const out: Record<string, number> = {};
  for (const task of await readdir("/proc/self/task").catch(() => [])) {
    const stat = await readFile(`/proc/self/task/${task}/stat`, "utf8").catch(() => "");
    const match = /\((.*)\) \S+ (?:\S+ ){10}(\d+) (\d+)/.exec(stat);
    if (!match) continue;
    const name = (match[1] as string).replace(/\d+$/, "#");
    out[name] = (out[name] ?? 0) + (Number(match[2]) + Number(match[3])) / 100;
  }
  return out;
}

const threads = await threadCpu();
const cpu = process.cpuUsage(cpuStart);
const result: Result = {
  type: "result",
  engine: options.engine,
  done: finished,
  bytes: download.bytes(),
  seconds: (performance.now() - started) / 1000,
  cpuSeconds: (cpu.user + cpu.system) / 1e6,
  systemSeconds: cpu.system / 1e6,
  maxRssMb: process.resourceUsage().maxRSS / 1024, // kilobytes
  peers: download.peers(),
  extra: { ...download.extra(), threads },
};
console.log(JSON.stringify(result));
await Promise.race([download.stop(), Bun.sleep(3000)]);
process.exit(0);
