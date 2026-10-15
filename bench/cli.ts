#!/usr/bin/env bun
/**
 * tinytorrent-bench: measures download speed and CPU cost, and compares
 * Tiny Torrent with WebTorrent and aria2 on the same swarm.
 *
 *   bun bench/cli.ts local [options]     a local swarm of seeders, optional added latency
 *   bun bench/cli.ts real <torrent> ...  a real torrent (.torrent path, URL or magnet)
 *   bun bench/cli.ts seeding [options]   one engine seeds to a group of leechers: upload speed, CPU, fairness
 *   bun bench/cli.ts real-seed <torrent> tinytorrent downloads a real torrent, then seeds it to the swarm
 *   bun bench/cli.ts micro               hot-path microbenchmarks (parser, picker, hashing)
 *
 * Every engine runs in its own process, so CPU time is the engine's alone.
 * See docs/BENCHMARKS.md.
 */

import { createHash, pbkdf2Sync, randomBytes } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { encode } from "../src/bencode";
import { connect } from "node:net";
import type { LeechOptions, Result, Sample } from "./leech";
import type { RealSeedOptions } from "./real-seed";
import type { SeederOptions, SeederResult } from "./seeder";
import type { SinkOptions, SinkSample } from "./sink";

const ROOT = resolve(import.meta.dir, "..");
const WORK = process.env.TT_BENCH_DIR ?? join(ROOT, ".bench");

// ---------- Arguments ---------- //

interface Args {
  mode: string;
  source?: string;
  sizeMb: number;
  pieceKb: number;
  seeders: number;
  /** Which engine seeds a local swarm. */
  seeder: "tinytorrent" | "qbittorrent";
  latencyMs: number;
  engines: string[];
  encryption: LeechOptions["encryption"];
  seconds: number;
  maxPeers: number;
  runs: number;
  dht: boolean;
  json?: string;
  keep: boolean;
  /** Directory for CPU profiles of tinytorrent and WebTorrent runs. */
  profile?: string;
  /** Leechers downloading from the engine under test, in `seeding` mode. */
  leechers: number;
  /** What downloads from the seeder in `seeding` mode: lean sink connections (default), or real Tiny Torrent leechers. */
  load: "sink" | "leechers";
  /** Processes the sink connections are spread over. */
  sinkProcs: number;
  /** CPUs to pin the seeder under test and the load to, as `taskset -c` lists (Linux only). */
  seederCpus?: string;
  loadCpus?: string;
  /** Upload slots for the seeder under test; omitted for its default. */
  slots?: number;
  /** Listening port for `real-seed` (a forwarded port lets peers connect in). */
  port?: number;
  /** `seeding` against a seeder running elsewhere (`bench/remote-seeder.ts`): its address, and its torrent file. */
  remote?: string;
  torrent?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    mode: argv[0] ?? "help",
    sizeMb: 1024,
    pieceKb: 256,
    seeders: 4,
    seeder: "tinytorrent",
    latencyMs: 0,
    engines: ["tinytorrent"],
    encryption: "prefer",
    seconds: 120,
    maxPeers: 200,
    runs: 1,
    dht: true,
    keep: false,
    leechers: 8,
    load: "sink",
    sinkProcs: 4,
  };
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i] as string;
    const value = (): string => argv[++i] ?? "";
    if (!flag.startsWith("--")) args.source = flag;
    else if (flag === "--size-mb") args.sizeMb = Number(value());
    else if (flag === "--piece-kb") args.pieceKb = Number(value());
    else if (flag === "--seeders") args.seeders = Number(value());
    else if (flag === "--seeder") args.seeder = value() as Args["seeder"];
    else if (flag === "--latency-ms") args.latencyMs = Number(value());
    else if (flag === "--engines") args.engines = value().split(",");
    else if (flag === "--encryption") args.encryption = value() as Args["encryption"];
    else if (flag === "--seconds") args.seconds = Number(value());
    else if (flag === "--max-peers") args.maxPeers = Number(value());
    else if (flag === "--runs") args.runs = Number(value());
    else if (flag === "--no-dht") args.dht = false;
    else if (flag === "--json") args.json = value();
    else if (flag === "--keep") args.keep = true;
    else if (flag === "--profile") args.profile = value();
    else if (flag === "--leechers") args.leechers = Number(value());
    else if (flag === "--slots") args.slots = Number(value());
    else if (flag === "--load") args.load = value() as Args["load"];
    else if (flag === "--sink-procs") args.sinkProcs = Number(value());
    else if (flag === "--seeder-cpus") args.seederCpus = value();
    else if (flag === "--load-cpus") args.loadCpus = value();
    else if (flag === "--port") args.port = Number(value());
    else if (flag === "--remote") args.remote = value();
    else if (flag === "--torrent") args.torrent = value();
    else throw new Error(`Unknown option ${flag}`);
  }
  return args;
}

const HELP = `tinytorrent-bench

  local   Local swarm: --size-mb 1024 --piece-kb 256 --seeders 4 --seeder tinytorrent|qbittorrent --latency-ms 0
  real    Real torrent: real <file.torrent|https://…torrent|magnet:…> --seconds 120
  seeding One engine seeds to --leechers 8 connections from lean sink leechers (--load leechers: real tinytorrent ones):
          --size-mb --latency-ms --slots --sink-procs 4 --seeder-cpus 7 --load-cpus 0-6
          or, with --remote host:port --torrent file, leech from a bench/remote-seeder.ts running elsewhere
  real-seed  Download a real torrent with tinytorrent, then seed it to its swarm for --seconds
  micro   Hot-path microbenchmarks

Common: --engines tinytorrent,webtorrent,aria2,qbittorrent  --encryption prefer|prefer-plaintext|require|off
        --max-peers 200  --runs 1  --no-dht  --json results.json  --keep  --profile <dir>`;

// ---------- Engines ---------- //

/** One engine's run, summarised. */
interface RunSummary {
  engine: string;
  run: number;
  done: boolean;
  bytes: number;
  seconds: number;
  /** Average over the whole run. */
  mbps: number;
  /** Average after the first 20 s (warm-up excluded), for timed runs. */
  steadyMbps: number;
  /** Best 5-second window. */
  peakMbps: number;
  cpuSeconds: number;
  /** Kernel share of the CPU time. */
  systemSeconds: number;
  /** CPU seconds per GB downloaded: the per-byte cost. */
  cpuPerGb: number;
  /** Average share of one core. */
  corePercent: number;
  maxRssMb: number;
  peers: number;
  extra?: Record<string, unknown>;
}

async function runEngine(engine: string, args: Args, source: string, dir: string, run: number): Promise<RunSummary> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const { samples, result } =
    engine === "aria2" ? await runAria2(args, source, dir) : engine === "qbittorrent" ? await runQbittorrent(args, source, dir) : await runLeech(engine, args, source, dir);
  return summarise(engine, run, samples, result);
}

async function runLeech(engine: string, args: Args, source: string, dir: string): Promise<{ samples: Sample[]; result: Result }> {
  const options: LeechOptions = {
    engine: engine as LeechOptions["engine"],
    source,
    dir,
    seconds: args.seconds,
    maxPeers: args.maxPeers,
    encryption: args.encryption,
    dht: args.dht && args.mode === "real",
  };
  const flags = args.profile ? ["--cpu-prof", "--cpu-prof-md", `--cpu-prof-dir=${args.profile}`, `--cpu-prof-name=${engine}-${Date.now()}.md`] : [];
  const proc = Bun.spawn(["bun", ...flags, join(ROOT, "bench/leech.ts"), JSON.stringify(options)], { stdout: "pipe", stderr: "inherit", cwd: ROOT });
  const samples: Sample[] = [];
  let result: Result | null = null;
  for await (const line of lines(proc.stdout)) {
    const msg = JSON.parse(line) as Sample | Result;
    if (msg.type === "sample") {
      samples.push(msg);
      progress(engine, msg);
    } else result = msg;
  }
  await proc.exited;
  process.stderr.write("\n");
  if (!result) throw new Error(`${engine} exited without a result`);
  return { samples, result };
}

/** aria2c through its JSON-RPC interface; CPU time comes from the OS once it exits. */
async function runAria2(args: Args, source: string, dir: string): Promise<{ samples: Sample[]; result: Result }> {
  const rpcPort = 16800 + Math.floor(Math.random() * 1000);
  const local = args.mode === "local";
  const crypto =
    args.encryption === "require" ? ["--bt-require-crypto=true", "--bt-min-crypto-level=arc4"] : args.encryption === "off" ? [] : ["--bt-min-crypto-level=plain"];
  const proc = Bun.spawn(
    [
      "aria2c",
      `--dir=${dir}`,
      "--seed-time=0",
      "--file-allocation=none",
      `--bt-max-peers=${args.maxPeers}`,
      `--enable-dht=${!local && args.dht}`,
      "--bt-enable-lpd=false",
      `--enable-peer-exchange=${!local}`,
      "--enable-rpc=true",
      `--rpc-listen-port=${rpcPort}`,
      "--console-log-level=warn",
      "--summary-interval=0",
      "--max-overall-upload-limit=1K",
      ...crypto,
      source,
    ],
    { stdout: "ignore", stderr: "inherit" },
  );
  const started = performance.now();
  const samples: Sample[] = [];
  let bytes = 0;
  let peers = 0;
  let done = false;
  let finishedAt = 0;
  // With RPC on, aria2 keeps running after the download completes; the RPC status says when
  while (!done && performance.now() - started < args.seconds * 1000) {
    await Bun.sleep(250);
    const status = await aria2Status(rpcPort);
    if (status) {
      bytes = status.bytes;
      peers = status.peers;
      done = status.complete;
    }
    if (done) finishedAt = performance.now();
    const t = (performance.now() - started) / 1000;
    if (done || t - (samples[samples.length - 1]?.t ?? 0) >= 1) {
      const sample: Sample = { type: "sample", t, bytes, peers };
      samples.push(sample);
      progress("aria2", sample);
    }
  }
  proc.kill("SIGTERM");
  await proc.exited;
  process.stderr.write("\n");
  const usage = proc.resourceUsage();
  const seconds = ((finishedAt || performance.now()) - started) / 1000;
  return {
    samples,
    result: {
      type: "result",
      engine: "aria2",
      done,
      bytes,
      seconds,
      cpuSeconds: usage ? Number(usage.cpuTime.user + usage.cpuTime.system) / 1e6 : 0,
      systemSeconds: usage ? Number(usage.cpuTime.system) / 1e6 : 0,
      maxRssMb: usage ? usage.maxRSS / (1024 * 1024) : 0, // bytes here, unlike process.resourceUsage()
      peers,
    },
  };
}

/** Progress over every download aria2 knows of, active or finished. */
async function aria2Status(port: number): Promise<{ bytes: number; peers: number; complete: boolean } | null> {
  const call = async (method: string, params: unknown[]): Promise<Array<{ completedLength: string; connections: string; status: string; totalLength: string }>> => {
    const response = await fetch(`http://127.0.0.1:${port}/jsonrpc`, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(800),
    });
    return ((await response.json()) as { result?: [] }).result ?? [];
  };
  try {
    const keys = ["completedLength", "totalLength", "connections", "status"];
    const items = [...(await call("aria2.tellActive", [keys])), ...(await call("aria2.tellStopped", [0, 100, keys]))];
    // A magnet first fetches metadata as its own download; only count real payloads
    const payloads = items.filter((i) => Number(i.totalLength) > 1_000_000 || i.status === "active");
    return {
      bytes: payloads.reduce((n, i) => n + Number(i.completedLength), 0),
      peers: items.reduce((n, i) => n + Number(i.connections ?? 0), 0),
      complete: payloads.length > 0 && payloads.every((i) => i.status === "complete"),
    };
  } catch {
    return null;
  }
}

/** qBittorrent transport: 0 = TCP and μTP (its default), 1 = TCP only (default here, as TinyTorrent is TCP-only), 2 = μTP only. */
const QBT_PROTOCOL = Number(process.env.QBT_PROTOCOL ?? 1);

// ---------- Seeding ---------- //

/** One seeding engine's run, summarised. */
interface SeedSummary {
  engine: string;
  run: number;
  /** Leechers that completed. */
  done: number;
  bytes: number;
  seconds: number;
  /** Total upload rate. */
  mbps: number;
  /** Best 5-second window. */
  peakMbps: number;
  cpuSeconds: number;
  cpuPerGb: number;
  /** The kernel's part of `cpuPerGb`, where it can be measured. */
  sysPerGb?: number;
  corePercent: number;
  maxRssMb: number;
  /** Seconds until each leecher's first byte: slowest of them. */
  firstByteMax: number;
  /** Jain's fairness index of the leechers' bytes halfway through (1 = perfectly even). */
  fairness: number;
  extra?: Record<string, unknown>;
}

/** CPU seconds a process has used so far (Linux /proc, otherwise `ps`). */
async function processCpu(pid: number): Promise<number> {
  if (process.platform === "linux") {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return (Number(fields[11]) + Number(fields[12])) / 100;
  }
  const out = (await new Response(Bun.spawn(["ps", "-o", "time=", "-p", String(pid)]).stdout).text()).trim();
  return out.split(":").reduce((n, part) => n * 60 + Number(part), 0);
}

/** Kernel CPU seconds of a process so far (Linux only). */
async function processSystemCpu(pid: number): Promise<number | undefined> {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
  if (!stat) return undefined;
  return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[12]) / 100;
}

/** Peak resident memory of a process that isn't our child, in MB (Linux only; 0 elsewhere). */
async function peakRssMb(pid: number): Promise<number> {
  const status = await readFile(`/proc/${pid}/status`, "utf8").catch(() => "");
  const kb = /VmHWM:\s+(\d+)/.exec(status)?.[1];
  return kb ? Number(kb) / 1024 : 0;
}

/** CPUs the seeder under test is pinned to, set from `--seeder-cpus`. */
let seederCpus: string | undefined;

/** Prefixes a command with `taskset` when CPUs are given (Linux). */
function pinned(cpus: string | undefined, cmd: string[]): string[] {
  return cpus ? ["taskset", "-c", cpus, ...cmd] : cmd;
}

/** A seeder under test: its address for leechers, and how to stop it and read its cost. */
interface SeederHandle {
  port: number;
  stop(): Promise<SeederCost>;
}

/** What a seeder cost: CPU (and the kernel's share of it, where known) and peak memory. */
interface SeederCost {
  cpuSeconds: number;
  systemSeconds?: number;
  maxRssMb: number;
  extra?: Record<string, unknown>;
}

async function startSeeder(engine: string, args: Args, torrentPath: string, dir: string, run: number): Promise<SeederHandle> {
  if (engine === "tinytorrent" || engine === "webtorrent") {
    const options: SeederOptions = { engine, torrentPath, dir, resumeDir: join(WORK, "resume-seeding"), encryption: args.encryption, slots: args.slots };
    const flags = args.profile ? ["--cpu-prof", "--cpu-prof-md", `--cpu-prof-dir=${args.profile}`, `--cpu-prof-name=seed-${engine}-${Date.now()}.md`] : [];
    const proc = Bun.spawn(pinned(seederCpus, ["bun", ...flags, join(ROOT, "bench/seeder.ts"), JSON.stringify(options)]), { stdin: "pipe", stdout: "pipe", stderr: "inherit", cwd: ROOT });
    const output = lines(proc.stdout);
    // Read by hand: breaking out of a for-await would close the stream
    let port = 0;
    while (!port) {
      const next = await output.next();
      if (next.done) break;
      const match = /^ready (\d+)/.exec(next.value);
      if (match) port = Number(match[1]);
    }
    if (!port) throw new Error(`${engine} seeder exited before it was ready`);
    return {
      port,
      stop: async () => {
        proc.stdin.end();
        let result: SeederResult | null = null;
        for (let next = await output.next(); !next.done; next = await output.next()) {
          if (next.value.startsWith("{")) result = JSON.parse(next.value) as SeederResult;
        }
        await proc.exited;
        if (!result) throw new Error(`${engine} seeder gave no result`);
        return { cpuSeconds: result.cpuSeconds, systemSeconds: result.systemSeconds, maxRssMb: result.maxRssMb, extra: result.extra };
      },
    };
  }
  if (engine === "aria2") {
    const port = 21000 + Math.floor(Math.random() * 20000);
    const proc = Bun.spawn(
      pinned(seederCpus, [
        "aria2c",
        `--dir=${dir}`,
        "--bt-seed-unverified=true",
        "--check-integrity=false",
        "--seed-ratio=0.0",
        `--listen-port=${port}`,
        "--enable-dht=false",
        "--bt-enable-lpd=false",
        "--enable-peer-exchange=false",
        "--bt-max-peers=0",
        "--file-allocation=none",
        "--console-log-level=warn",
        "--summary-interval=0",
        torrentPath,
      ]),
      { stdout: "ignore", stderr: "inherit" },
    );
    await waitForPort(port);
    const cpuAtReady = await processCpu(proc.pid);
    return {
      port,
      stop: async () => {
        const cpu = await processCpu(proc.pid);
        proc.kill("SIGTERM");
        await proc.exited;
        return { cpuSeconds: cpu - cpuAtReady, maxRssMb: (proc.resourceUsage()?.maxRSS ?? 0) / (1024 * 1024) };
      },
    };
  }
  if (engine === "qbittorrent") {
    const children: Array<{ kill: () => void }> = [];
    const { port, pid } = await qbtSeeder(torrentPath, dir, children, args.slots);
    await waitForPort(port);
    await Bun.sleep(2000); // listening is not quite serving yet
    const cpuAtReady = await processCpu(pid);
    const sysAtReady = await processSystemCpu(pid);
    return {
      port,
      stop: async () => {
        const cpu = await processCpu(pid);
        const sys = await processSystemCpu(pid);
        const maxRssMb = await peakRssMb(pid);
        for (const child of children) child.kill();
        return { cpuSeconds: cpu - cpuAtReady, systemSeconds: sys === undefined || sysAtReady === undefined ? undefined : sys - sysAtReady, maxRssMb };
      },
    };
  }
  throw new Error(`Unknown seeding engine ${engine} (run ${run})`);
}

async function waitForPort(port: number): Promise<void> {
  for (let i = 0; i < 150; i++) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: "127.0.0.1", port }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (open) return;
    await Bun.sleep(100);
  }
  throw new Error(`Nothing listening on ${port}`);
}

async function seeding(args: Args): Promise<SeedSummary[]> {
  const track = tracker();
  const local = args.remote ? null : await payload(args.sizeMb, args.pieceKb, track.url);
  const torrentPath = local?.torrentPath ?? (args.torrent as string);
  const results: SeedSummary[] = [];
  seederCpus = args.seederCpus;
  try {
    for (let run = 1; run <= args.runs; run++) {
      for (const engine of args.engines) {
        process.stderr.write(`${engine} seeding to ${args.leechers} leechers, run ${run}\n`);
        // A remote seeder is already running; only its leechers are measured here
        const seeder: SeederHandle = local
          ? await startSeeder(engine, args, torrentPath, local.dir, run)
          : { port: 0, stop: async () => ({ cpuSeconds: 0, maxRssMb: 0 }) };
        const children: Array<{ kill: () => void }> = [];
        let port = seeder.port;
        if (args.latencyMs && local) {
          const proxy = Bun.spawn(["bun", join(ROOT, "bench/proxy.ts"), "0", `127.0.0.1:${port}`, String(args.latencyMs / 2)], { stdout: "pipe" });
          children.push(proxy);
          port = await readyPort(proxy.stdout);
        }
        track.peers.length = 0;
        track.peers.push(port);

        // Leechers that only download, so every byte they get is the seeder's upload
        const started = performance.now();
        const perLeecher: Sample[][] = [];
        const finished: boolean[] = [];
        const host = args.remote ? (args.remote.split(":")[0] as string) : "127.0.0.1";
        const sinkPort = args.remote ? Number(args.remote.split(":")[1]) : port;
        const procs = Math.min(args.sinkProcs, args.leechers);
        const sinks = Array.from({ length: args.load === "sink" ? procs : 0 }, async (_, p) => {
          const first = Math.floor((p * args.leechers) / procs);
          const conns = Math.floor(((p + 1) * args.leechers) / procs) - first;
          // One method offered, so every seeder makes the same choice
          const crypto = args.encryption === "off" ? "plain" : args.encryption === "prefer-plaintext" ? "mse-plain" : "rc4";
          const options: SinkOptions = { torrentPath, host, port: sinkPort, conns, first, total: args.leechers, seconds: args.seconds, crypto, queue: 250 };
          const proc = Bun.spawn(pinned(args.loadCpus, ["bun", join(ROOT, "bench/sink.ts"), JSON.stringify(options)]), { stdout: "pipe", stderr: "inherit", cwd: ROOT });
          children.push(proc);
          for (let c = first; c < first + conns; c++) perLeecher[c] = [];
          for await (const line of lines(proc.stdout)) {
            const msg = JSON.parse(line) as SinkSample;
            (perLeecher[msg.conn] as Sample[]).push({ type: "sample", t: (performance.now() - started) / 1000, bytes: msg.bytes, peers: 1 });
          }
          await proc.exited;
          for (let c = first; c < first + conns; c++) finished[c] = true;
        });
        const leechers = Array.from({ length: args.load === "leechers" ? args.leechers : 0 }, async (_, i) => {
          const target = join(WORK, `seeding-leech-${i}`);
          await rm(target, { recursive: true, force: true });
          const options: LeechOptions = { engine: "tinytorrent", source: torrentPath, dir: target, seconds: args.seconds, maxPeers: 10, encryption: args.encryption, dht: false, peers: args.remote ? [args.remote] : undefined };
          const proc = Bun.spawn(["bun", join(ROOT, "bench/leech.ts"), JSON.stringify(options)], { stdout: "pipe", stderr: "inherit", cwd: ROOT });
          children.push(proc);
          const samples: Sample[] = [];
          perLeecher[i] = samples;
          for await (const line of lines(proc.stdout)) {
            const msg = JSON.parse(line) as Sample | Result;
            if (msg.type === "sample") samples.push({ ...msg, t: (performance.now() - started) / 1000 });
            else finished[i] = msg.done;
          }
          await proc.exited;
          await rm(target, { recursive: true, force: true });
        });
        const ticker = setInterval(() => {
          const bytes = perLeecher.reduce((n, s) => n + (s?.[s.length - 1]?.bytes ?? 0), 0);
          process.stderr.write(`\r  ${engine}: ${((performance.now() - started) / 1000).toFixed(0)}s ${(bytes / 1e6).toFixed(0)} MB uploaded   `);
        }, 1000);
        await Promise.all([...leechers, ...sinks]);
        clearInterval(ticker);
        process.stderr.write("\n");
        const cost = await seeder.stop();
        for (const child of children) child.kill();
        results.push(summariseSeeding(engine, run, perLeecher, finished, cost));
      }
    }
    return results;
  } finally {
    track.stop();
  }
}

function summariseSeeding(
  engine: string,
  run: number,
  perLeecher: Sample[][],
  finished: boolean[],
  cost: SeederCost,
): SeedSummary {
  const end = Math.max(...perLeecher.map((s) => s[s.length - 1]?.t ?? 0));
  const bytesAt = (s: Sample[], t: number): number => {
    let bytes = 0;
    for (const x of s) if (x.t <= t) bytes = x.bytes;
    return bytes;
  };
  const bytes = perLeecher.reduce((n, s) => n + (s[s.length - 1]?.bytes ?? 0), 0);
  // Aggregate rate over a sliding 5 s window, one-second steps
  let peak = 0;
  for (let t = 5; t <= end; t++) peak = Math.max(peak, perLeecher.reduce((n, s) => n + bytesAt(s, t) - bytesAt(s, t - 5), 0) / 5);
  const firstByte = perLeecher.map((s) => s.find((x) => x.bytes > 0)?.t ?? Number.POSITIVE_INFINITY);
  const half = perLeecher.map((s) => bytesAt(s, end / 2));
  const sum = half.reduce((a, b) => a + b, 0);
  const squares = half.reduce((a, b) => a + b * b, 0);
  return {
    engine,
    run,
    done: finished.filter(Boolean).length,
    bytes,
    seconds: end,
    mbps: (bytes * 8) / 1e6 / end,
    peakMbps: (peak * 8) / 1e6,
    cpuSeconds: cost.cpuSeconds,
    cpuPerGb: bytes > 0 ? cost.cpuSeconds / (bytes / 1e9) : 0,
    sysPerGb: bytes > 0 && cost.systemSeconds !== undefined ? cost.systemSeconds / (bytes / 1e9) : undefined,
    corePercent: (cost.cpuSeconds / end) * 100,
    maxRssMb: cost.maxRssMb,
    firstByteMax: Math.max(...firstByte),
    fairness: squares > 0 ? (sum * sum) / (half.length * squares) : 0,
    extra: cost.extra,
  };
}

function seedTable(results: SeedSummary[]): string {
  const head = ["engine", "run", "done", "MB", "secs", "Mbit/s", "peak", "CPU s", "core %", "CPU s/GB", "of it kernel", "RSS MB", "1st byte", "fairness"];
  const rows = results.map((r) => [
    r.engine,
    String(r.run),
    String(r.done),
    (r.bytes / 1e6).toFixed(0),
    r.seconds.toFixed(1),
    r.mbps.toFixed(1),
    r.peakMbps.toFixed(1),
    r.cpuSeconds.toFixed(1),
    r.corePercent.toFixed(0),
    r.cpuPerGb.toFixed(2),
    r.sysPerGb === undefined ? "-" : r.sysPerGb.toFixed(2),
    r.maxRssMb.toFixed(0),
    r.firstByteMax.toFixed(1),
    r.fairness.toFixed(3),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] as string).length)));
  const line = (cells: string[]): string => cells.map((c, i) => c.padStart(widths[i] as number)).join("  ");
  return [line(head), ...rows.map(line)].join("\n");
}

/** A running qBittorrent with its own throwaway profile, driven through the WebUI API. */
interface Qbt {
  proc: ReturnType<typeof Bun.spawn>;
  api: string;
  post: (path: string, body: FormData | URLSearchParams) => Promise<Response>;
}

/**
 * Starts qBittorrent (libtorrent) in a throwaway profile so the user's own settings are
 * untouched. On macOS it needs the app at QBT_APP (default /Applications/qbittorrent.app);
 * elsewhere `qbittorrent-nox` on PATH, or QBT_BIN (the bench Docker image has it).
 */
async function launchQbt(name: string): Promise<Qbt> {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const profile = join(WORK, `qbt-profile-${name}`);
  await rm(profile, { recursive: true, force: true });
  await mkdir(join(profile, "qBittorrent", "config"), { recursive: true });
  // qBittorrent 5 will not start its WebUI without credentials (even with localhost auth bypassed)
  const salt = randomBytes(16);
  const hash = pbkdf2Sync("bench", salt, 100000, 64, "sha512");
  await writeFile(
    // The settings file is qBittorrent.ini on macOS and qBittorrent.conf elsewhere
    join(profile, "qBittorrent", "config", process.platform === "darwin" ? "qBittorrent.ini" : "qBittorrent.conf"),
    `[LegalNotice]\nAccepted=true\n\n[Preferences]\nWebUI\\Enabled=true\nWebUI\\Address=127.0.0.1\nWebUI\\LocalHostAuth=false\nWebUI\\CSRFProtection=false\nWebUI\\HostHeaderValidation=false\nWebUI\\Username=bench\nWebUI\\Password_PBKDF2="@ByteArray(${salt.toString("base64")}:${hash.toString("base64")})"\n`,
  );
  const bin =
    process.platform === "darwin"
      ? join(process.env.QBT_APP ?? "/Applications/qbittorrent.app", "Contents/MacOS/qbittorrent")
      : (process.env.QBT_BIN ?? "qbittorrent-nox");
  const proc = Bun.spawn(pinned(name === "seed" ? seederCpus : undefined, [bin, `--profile=${profile}`, `--webui-port=${port}`, "--confirm-legal-notice"]), { stdout: "ignore", stderr: "ignore" });
  const api = `http://127.0.0.1:${port}/api/v2`;
  const post = (path: string, body: FormData | URLSearchParams): Promise<Response> => fetch(`${api}${path}`, { method: "POST", body, signal: AbortSignal.timeout(3000) });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${api}/app/version`, { signal: AbortSignal.timeout(500) })).ok) return { proc, api, post };
    } catch {}
    await Bun.sleep(200);
  }
  proc.kill("SIGKILL");
  throw new Error("qBittorrent's WebUI did not come up");
}

/** A qBittorrent that seeds `dir` (already complete) on a fixed port; returns that port. */
async function qbtSeeder(torrentPath: string, dir: string, children: Array<{ kill: () => void }>, slots = -1): Promise<{ port: number; pid: number }> {
  const qbt = await launchQbt("seed");
  children.push({ kill: () => qbt.proc.kill("SIGKILL") });
  const port = 20000 + Math.floor(Math.random() * 20000);
  const prefs = { listen_port: port, random_port: false, queueing_enabled: false, dht: false, pex: false, lsd: false, max_connec: 1000, max_uploads: slots, max_uploads_per_torrent: slots, bittorrent_protocol: QBT_PROTOCOL, up_limit: 0, dl_limit: 0, limit_lan_peers: false, enable_multi_connections_from_same_ip: true, encryption: 0 };
  await qbt.post("/app/setPreferences", new URLSearchParams({ json: JSON.stringify(prefs) }));
  const form = new FormData();
  form.set("torrents", new Blob([await readFile(torrentPath)]), "payload.torrent");
  form.set("savepath", dir);
  form.set("skip_checking", "true");
  await qbt.post("/torrents/add", form);
  for (let i = 0; i < 100; i++) {
    const list = (await (await fetch(`${qbt.api}/torrents/info`)).json()) as Array<{ progress: number }>;
    if (list[0] && list[0].progress >= 1) return { port, pid: qbt.proc.pid };
    await Bun.sleep(200);
  }
  throw new Error("qBittorrent seeder never reached 100%");
}

/** qBittorrent as the downloading engine. */
async function runQbittorrent(args: Args, source: string, dir: string): Promise<{ samples: Sample[]; result: Result }> {
  const local = args.mode === "local";
  const { proc, api, post } = await launchQbt("leech");
  try {
  // Settings matching the other engines: no queueing, no seeding, same peer cap, DHT/PEX/LSD off on a local swarm
  const prefs = {
    save_path: dir,
    queueing_enabled: false,
    max_connec: args.maxPeers,
    max_connec_per_torrent: args.maxPeers,
    max_uploads: 1,
    bittorrent_protocol: QBT_PROTOCOL,
    up_limit: 0,
    limit_lan_peers: false,
    dht: !local && args.dht,
    pex: !local,
    lsd: false,
    encryption: args.encryption === "require" ? 1 : args.encryption === "off" ? 2 : 0,
    enable_multi_connections_from_same_ip: true,
    preallocate_all: false,
    max_ratio_enabled: true,
    max_ratio: 0,
    max_ratio_act: 0,
    dl_limit: 0,
    announce_to_all_trackers: true,
    announce_to_all_tiers: true,
  };
  await post("/app/setPreferences", new URLSearchParams({ json: JSON.stringify(prefs) }));
  const form = new FormData();
  if (source.startsWith("magnet:")) form.set("urls", source);
  else form.set("torrents", new Blob([await readFile(source)]), "payload.torrent");
  form.set("savepath", dir);
  form.set("sequentialDownload", "false");
  await post("/torrents/add", form);

  const started = performance.now();
  const samples: Sample[] = [];
  let bytes = 0;
  let peers = 0;
  let done = false;
  let finishedAt = 0;
  while (!done && performance.now() - started < args.seconds * 1000) {
    await Bun.sleep(250);
    try {
      const list = (await (await fetch(`${api}/torrents/info`, { signal: AbortSignal.timeout(800) })).json()) as Array<{ downloaded: number; completed: number; size: number; progress: number; num_seeds: number; num_leechs: number }>;
      const t = list[0];
      if (t) {
        bytes = t.completed;
        peers = t.num_seeds + t.num_leechs;
        done = t.progress >= 1;
      }
    } catch {}
    if (done) finishedAt = performance.now();
    const t = (performance.now() - started) / 1000;
    if (done || t - (samples[samples.length - 1]?.t ?? 0) >= 1) {
      const sample: Sample = { type: "sample", t, bytes, peers };
      samples.push(sample);
      progress("qbittorrent", sample);
    }
  }
  // Final engine state, for diagnosing a slow run
  let extra: Record<string, unknown> | undefined;
  try {
    const info = (await (await fetch(`${api}/torrents/info`)).json()) as Array<Record<string, unknown>>;
    const props = (await (await fetch(`${api}/torrents/properties?hash=${info[0]?.hash}`)).json()) as Record<string, unknown>;
    const sync = (await (await fetch(`${api}/sync/torrentPeers?hash=${info[0]?.hash}`)).json()) as { peers?: Record<string, Record<string, unknown>> };
    const peerView = Object.values(sync.peers ?? {}).map((x) => `${x.flags}|${x.client}|${x.dl_speed}|${x.connection}`);
    extra = { peerView, state: info[0]?.state, dlspeed: info[0]?.dlspeed, seeds: props.seeds, peers: props.peers, connections: props.nb_connections };
  } catch {}
  proc.kill("SIGTERM");
  await proc.exited;
  process.stderr.write("\n");
  const usage = proc.resourceUsage();
  return {
    samples,
    result: {
      type: "result",
      extra,
      engine: "qbittorrent",
      done,
      bytes,
      seconds: ((finishedAt || performance.now()) - started) / 1000,
      cpuSeconds: usage ? Number(usage.cpuTime.user + usage.cpuTime.system) / 1e6 : 0,
      systemSeconds: usage ? Number(usage.cpuTime.system) / 1e6 : 0,
      maxRssMb: usage ? usage.maxRSS / (1024 * 1024) : 0,
      peers,
    },
  };
  } finally {
    proc.kill("SIGKILL");
  }
}

function summarise(engine: string, run: number, samples: Sample[], result: Result): RunSummary {
  const mb = result.bytes / 1e6;
  const after20 = samples.filter((s) => s.t >= 20);
  const steady =
    after20.length > 1
      ? ((after20[after20.length - 1] as Sample).bytes - (after20[0] as Sample).bytes) / 1e6 / ((after20[after20.length - 1] as Sample).t - (after20[0] as Sample).t)
      : mb / result.seconds;
  let peak = 0;
  for (let i = 5; i < samples.length; i++) {
    const a = samples[i - 5] as Sample;
    const b = samples[i] as Sample;
    peak = Math.max(peak, (b.bytes - a.bytes) / 1e6 / (b.t - a.t));
  }
  return {
    engine,
    run,
    done: result.done,
    bytes: result.bytes,
    seconds: result.seconds,
    mbps: (mb * 8) / result.seconds,
    steadyMbps: steady * 8,
    peakMbps: (peak || mb / result.seconds) * 8,
    cpuSeconds: result.cpuSeconds,
    systemSeconds: result.systemSeconds ?? 0,
    cpuPerGb: result.bytes > 0 ? result.cpuSeconds / (result.bytes / 1e9) : 0,
    corePercent: (result.cpuSeconds / result.seconds) * 100,
    maxRssMb: result.maxRssMb,
    peers: result.peers,
    extra: result.extra,
  };
}

// ---------- Local swarm ---------- //

/** A payload file of random bytes and its torrent, cached between runs. */
async function payload(sizeMb: number, pieceKb: number, announce: string): Promise<{ dir: string; torrentPath: string }> {
  const dir = join(WORK, `payload-${sizeMb}m-${pieceKb}k`);
  const file = join(dir, "data", "payload.bin");
  const infoPath = join(dir, "info.bin");
  if (!existsSync(infoPath)) {
    process.stderr.write(`Creating a ${sizeMb} MB payload…\n`);
    await mkdir(dirname(file), { recursive: true });
    const pieceLength = pieceKb * 1024;
    const total = sizeMb * 1024 * 1024;
    const hashes: Buffer[] = [];
    const out = createWriteStream(file);
    for (let offset = 0; offset < total; offset += pieceLength) {
      const piece = randomBytes(Math.min(pieceLength, total - offset));
      hashes.push(createHash("sha1").update(piece).digest());
      if (!out.write(piece)) await new Promise((r) => out.once("drain", r));
    }
    await new Promise((r) => out.end(r));
    await writeFile(infoPath, encode({ name: "payload.bin", "piece length": pieceLength, length: total, pieces: Buffer.concat(hashes) }));
  }
  // The announce URL changes per run (tracker port), so the torrent is rebuilt around the cached info
  const info = await readFile(infoPath);
  const torrent = Buffer.concat([Buffer.from(`d8:announce${announce.length}:${announce}4:info`), info, Buffer.from("e")]);
  const torrentPath = join(dir, "payload.torrent");
  await writeFile(torrentPath, torrent);
  return { dir: join(dir, "data"), torrentPath };
}

/** A minimal HTTP tracker that hands out the swarm's addresses. */
function tracker(): { url: string; peers: number[]; stop: () => void } {
  const peers: number[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      const compact = Buffer.alloc(peers.length * 6);
      peers.forEach((port, i) => {
        compact.set([127, 0, 0, 1], i * 6);
        compact.writeUInt16BE(port, i * 6 + 4);
      });
      return new Response(encode({ interval: 60, peers: compact }));
    },
  });
  return { url: `http://127.0.0.1:${server.port}/announce`, peers, stop: () => server.stop(true) };
}

async function local(args: Args): Promise<RunSummary[]> {
  const track = tracker();
  const { dir, torrentPath } = await payload(args.sizeMb, args.pieceKb, track.url);
  const children: Array<{ kill: () => void }> = [];
  try {
    // Seeders (each verifies once, then reuses its resume state), behind latency proxies if asked
    process.stderr.write(`Starting ${args.seeders} seeders${args.latencyMs ? ` behind ${args.latencyMs} ms proxies` : ""}…\n`);
    const ports =
      args.seeder === "qbittorrent"
        ? [(await qbtSeeder(torrentPath, dir, children)).port]
        : await Promise.all(
          Array.from({ length: args.seeders }, async (_, i) => {
            const seed = Bun.spawn(["bun", join(ROOT, "bench/seed.ts"), torrentPath, dir, join(WORK, `resume-${i}`)], { stdout: "pipe", stderr: "inherit" });
            children.push(seed);
            const port = await readyPort(seed.stdout);
            if (!args.latencyMs) return port;
            const proxy = Bun.spawn(["bun", join(ROOT, "bench/proxy.ts"), "0", `127.0.0.1:${port}`, String(args.latencyMs / 2)], { stdout: "pipe" });
            children.push(proxy);
            return readyPort(proxy.stdout);
          }),
        );
    track.peers.push(...ports);

    const results: RunSummary[] = [];
    for (let run = 1; run <= args.runs; run++) {
      for (const engine of args.engines) {
        process.stderr.write(`${engine}, run ${run}\n`);
        const target = join(WORK, `leech-${engine}`);
        results.push(await runEngine(engine, args, torrentPath, target, run));
        if (!args.keep) await rm(target, { recursive: true, force: true });
      }
    }
    return results;
  } finally {
    for (const child of children) child.kill();
    track.stop();
  }
}

// ---------- Real torrent ---------- //

async function real(args: Args): Promise<RunSummary[]> {
  if (!args.source) throw new Error("real needs a .torrent path, URL or magnet link");
  const source = await fetchSource(args.source);
  const results: RunSummary[] = [];
  for (let run = 1; run <= args.runs; run++) {
    for (const engine of args.engines) {
      process.stderr.write(`${engine}, run ${run}\n`);
      const target = join(WORK, `real-${engine}`);
      results.push(await runEngine(engine, args, source, target, run));
      if (!args.keep) await rm(target, { recursive: true, force: true });
    }
  }
  return results;
}

/** Tiny Torrent seeds a real torrent to its public swarm; prints what it uploaded to whom. */
async function realSeed(args: Args): Promise<void> {
  if (!args.source) throw new Error("real-seed needs a .torrent path, URL or magnet link");
  const source = await fetchSource(args.source);
  const options: RealSeedOptions = {
    source,
    dir: join(WORK, "real-seed"),
    resumeDir: join(WORK, "real-seed-resume"),
    seconds: args.seconds,
    encryption: args.encryption,
    maxPeers: args.maxPeers,
    port: args.port,
  };
  const proc = Bun.spawn(["bun", join(ROOT, "bench/real-seed.ts"), JSON.stringify(options)], { stdout: "pipe", stderr: "inherit", cwd: ROOT });
  for await (const line of lines(proc.stdout)) {
    const msg = JSON.parse(line) as { type: string; t?: number; uploaded: number; uploadRate?: number; peers?: number; interested?: number; slots?: unknown };
    if (msg.type === "sample") {
      console.log(
        `${(msg.t ?? 0).toFixed(0).padStart(5)} s  ${(msg.uploaded / 1e6).toFixed(1).padStart(8)} MB up  ${(((msg.uploadRate ?? 0) * 8) / 1e6).toFixed(1).padStart(6)} Mbit/s  ${msg.peers} peers, ${msg.interested} interested, slots ${JSON.stringify(msg.slots)}`,
      );
    } else console.log(JSON.stringify(msg, null, 1));
  }
  await proc.exited;
}

/** A local path for a torrent given as a path, URL or magnet. */
async function fetchSource(source: string): Promise<string> {
  if (!/^https?:\/\//.test(source)) return source;
  const response = await fetch(source);
  if (!response.ok) throw new Error(`Could not fetch ${source}: HTTP ${response.status}`);
  const path = join(WORK, "real.torrent");
  await mkdir(WORK, { recursive: true });
  await writeFile(path, new Uint8Array(await response.arrayBuffer()));
  return path;
}

// ---------- Output ---------- //

function table(results: RunSummary[]): string {
  const head = ["engine", "run", "done", "MB", "secs", "Mbit/s", "steady", "peak", "CPU s", "sys s", "core %", "CPU s/GB", "RSS MB", "peers"];
  const rows = results.map((r) => [
    r.engine,
    String(r.run),
    r.done ? "yes" : "no",
    (r.bytes / 1e6).toFixed(0),
    r.seconds.toFixed(1),
    r.mbps.toFixed(1),
    r.steadyMbps.toFixed(1),
    r.peakMbps.toFixed(1),
    r.cpuSeconds.toFixed(1),
    r.systemSeconds.toFixed(1),
    r.corePercent.toFixed(0),
    r.cpuPerGb.toFixed(2),
    r.maxRssMb.toFixed(0),
    String(r.peers),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] as string).length)));
  const line = (cells: string[]): string => cells.map((c, i) => c.padStart(widths[i] as number)).join("  ");
  return [line(head), ...rows.map(line)].join("\n");
}

function progress(engine: string, s: Sample): void {
  process.stderr.write(`\r  ${engine}: ${s.t.toFixed(0)}s ${(s.bytes / 1e6).toFixed(0)} MB, ${s.peers} peers   `);
}

async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true });
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line) yield line;
      newline = buffered.indexOf("\n");
    }
  }
}

async function readyPort(stream: ReadableStream<Uint8Array>): Promise<number> {
  for await (const line of lines(stream)) {
    const match = /^ready (\d+)/.exec(line);
    if (match) return Number(match[1]);
  }
  throw new Error("Child exited before it was ready");
}

// ---------- Main ---------- //

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(WORK, { recursive: true });
  let results: RunSummary[];
  if (args.mode === "seeding") {
    const seeded = await seeding(args);
    console.log(seedTable(seeded));
    for (const r of seeded) if (r.extra && Object.keys(r.extra).length) console.log(`${r.engine} #${r.run}:`, JSON.stringify(r.extra));
    if (args.json) await writeFile(args.json, JSON.stringify({ args, at: new Date().toISOString(), host: hostInfo(), results: seeded }, null, 2));
    return;
  }
  if (args.mode === "real-seed") return realSeed(args);
  if (args.mode === "local") results = await local(args);
  else if (args.mode === "real") results = await real(args);
  else if (args.mode === "micro") {
    const { micro } = await import("./micro");
    await micro();
    return;
  } else {
    console.log(HELP);
    return;
  }
  console.log(table(results));
  for (const r of results) if (r.extra && Object.keys(r.extra).length) console.log(`${r.engine} #${r.run}:`, JSON.stringify(r.extra));
  if (args.json) await writeFile(args.json, JSON.stringify({ args, at: new Date().toISOString(), host: hostInfo(), results }, null, 2));
}

function hostInfo(): Record<string, string> {
  return { platform: process.platform, arch: process.arch, bun: Bun.version, cpus: String(navigator.hardwareConcurrency) };
}

await main();
