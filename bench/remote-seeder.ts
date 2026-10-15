/**
 * One engine seeding a payload on a fixed port, for the seeding benchmark's
 * `--remote` mode: run it on a server (inside a VPN container's network
 * namespace, on a forwarded port) and point leechers elsewhere at it.
 *
 *   bun bench/remote-seeder.ts <tinytorrent|webtorrent|aria2> <size-mb> <port> [encryption]
 *
 * The payload and its torrent are made once under $TT_BENCH_DIR/remote
 * (`payload.torrent`). Prints `ready`; on SIGTERM prints the seeder's CPU
 * time since then as a JSON `result` line.
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createTorrentFromPath } from "../src/index";
import type { SeederOptions } from "./seeder";

const [engine = "tinytorrent", sizeArg = "512", portArg = "42869", encryption = "prefer"] = process.argv.slice(2);
const work = join(process.env.TT_BENCH_DIR ?? "/work", "remote");
const data = join(work, "data");
const torrentPath = join(work, "payload.torrent");

if (!existsSync(torrentPath)) {
  await mkdir(data, { recursive: true });
  const file = join(data, "payload.bin");
  const chunks: Buffer[] = [];
  for (let n = 0; n < Number(sizeArg); n++) chunks.push(randomBytes(1024 * 1024));
  await writeFile(file, Buffer.concat(chunks));
  await writeFile(torrentPath, await createTorrentFromPath(file, { pieceLength: 256 * 1024, creationDate: false }));
}

/** CPU seconds of a process from /proc. */
async function cpuOf(pid: number): Promise<number> {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return (Number(fields[11]) + Number(fields[12])) / 100;
}

const root = resolve(import.meta.dir, "..");
const proc =
  engine === "aria2"
    ? Bun.spawn(
        ["aria2c", `--dir=${data}`, "--bt-seed-unverified=true", "--check-integrity=false", "--seed-ratio=0.0", `--listen-port=${portArg}`, "--enable-dht=false", "--bt-enable-lpd=false", "--enable-peer-exchange=false", "--bt-max-peers=0", "--console-log-level=warn", "--summary-interval=0", torrentPath],
        { stdout: "ignore", stderr: "inherit" },
      )
    : Bun.spawn(
        ["bun", join(root, "bench/seeder.ts"), JSON.stringify({
          engine: engine as SeederOptions["engine"],
          torrentPath,
          dir: data,
          resumeDir: join(work, `resume-${engine}`),
          encryption: encryption as SeederOptions["encryption"],
          port: Number(portArg),
        } satisfies SeederOptions)],
        { stdin: "pipe", stdout: "pipe", stderr: "inherit" },
      );
// Wait until it serves (tinytorrent and WebTorrent check the data first), so CPU counts serving only
if (proc.stdout instanceof ReadableStream) {
  const reader = proc.stdout.getReader();
  let text = "";
  while (!/ready \d+/.test(text)) {
    const { value, done } = await reader.read();
    if (done) throw new Error("seeder exited before it was ready");
    text += new TextDecoder().decode(value);
  }
} else await Bun.sleep(3000);
const cpuAtReady = await cpuOf(proc.pid);
console.log("ready");

process.on("SIGTERM", async () => {
  const cpu = (await cpuOf(proc.pid)) - cpuAtReady;
  console.log(JSON.stringify({ type: "result", engine, cpuSecondsSinceReady: cpu }));
  proc.kill("SIGTERM");
  process.exit(0);
});
await proc.exited;
