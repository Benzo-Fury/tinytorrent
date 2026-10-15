/**
 * Seeds one torrent with one engine, in its own process, for the seeding
 * benchmark. Prints `ready <port>` once it serves, then on stdin closing (or
 * SIGTERM) a JSON `result` line with the CPU time spent since ready.
 *
 *   bun bench/seeder.ts <json options>
 *
 * Engines: `tinytorrent`, `webtorrent`. aria2 and qBittorrent are driven
 * directly by the CLI.
 */

import { readFile } from "node:fs/promises";

/** What the CLI passes in. */
export interface SeederOptions {
  engine: "tinytorrent" | "webtorrent";
  torrentPath: string;
  dir: string;
  resumeDir: string;
  encryption: "require" | "prefer" | "prefer-plaintext" | "off";
  /** Upload slots; omitted for the engine's default. */
  slots?: number;
  /** Listening port; any by default. */
  port?: number;
}

/** The final line. */
export interface SeederResult {
  type: "result";
  engine: string;
  uploaded: number;
  cpuSeconds: number;
  systemSeconds: number;
  maxRssMb: number;
  extra?: Record<string, unknown>;
}

const options = JSON.parse(process.argv[2] ?? "{}") as SeederOptions;
const torrentBytes = new Uint8Array(await readFile(options.torrentPath));

/** A running seed, whichever engine. */
interface Seed {
  port: number;
  uploaded(): number;
  extra(): Record<string, unknown>;
}

async function tinytorrent(): Promise<Seed> {
  const { Engine } = await import("../src/index");
  const engine = new Engine({
    port: options.port,
    dht: false,
    pex: false,
    resumeDir: options.resumeDir,
    encryption: options.encryption,
    upload: options.slots === undefined ? {} : { slots: options.slots },
    seed: { enabled: true },
  });
  const torrent = engine.add(torrentBytes, { dir: options.dir });
  await new Promise<void>((resolve) => (torrent.state === "seeding" ? resolve() : torrent.once("done", () => resolve())));
  await engine.ready();
  return {
    port: engine.port(),
    uploaded: () => torrent.uploaded,
    extra: () => {
      const stats = torrent.stats() as unknown as Record<string, unknown> & { peers: Array<{ uploadRate: number }> };
      return { unchoked: stats.peers.filter((p) => p.uploadRate > 0).length, peers: stats.peers.length, closeReasons: stats.closeReasons };
    },
  };
}

async function webtorrent(): Promise<Seed> {
  await import("./webtorrent-preload");
  const { default: WebTorrent } = await import("webtorrent");
  const client = new WebTorrent({ utp: false, dht: false, lsd: false, tracker: false, torrentPort: options.port ?? 0 } as never);
  // biome-ignore lint: WebTorrent's types are loose
  const torrent: any = (client as any).add(Buffer.from(torrentBytes), { path: options.dir });
  await new Promise<void>((resolve) => (torrent.done ? resolve() : torrent.once("done", () => resolve())));
  // biome-ignore lint: as above
  const port = (client as any).torrentPort ?? (client as any).address()?.port;
  return { port, uploaded: () => torrent.uploaded ?? 0, extra: () => ({}) };
}

const seed = options.engine === "webtorrent" ? await webtorrent() : await tinytorrent();
const cpuStart = process.cpuUsage();
console.log(`ready ${seed.port}`);

let reported = false;
function report(): void {
  if (reported) return;
  reported = true;
  const cpu = process.cpuUsage(cpuStart);
  const result: SeederResult = {
    type: "result",
    engine: options.engine,
    uploaded: seed.uploaded(),
    cpuSeconds: (cpu.user + cpu.system) / 1e6,
    systemSeconds: cpu.system / 1e6,
    maxRssMb: process.resourceUsage().maxRSS / 1024,
    extra: { ...seed.extra(), mem: Object.fromEntries(Object.entries(process.memoryUsage()).map(([k, v]) => [k, Math.round(v / 1e6)])) },
  };
  console.log(JSON.stringify(result));
  process.exit(0);
}
process.on("SIGTERM", report);
process.stdin.on("end", report);
process.stdin.on("close", report);
process.stdin.resume();
