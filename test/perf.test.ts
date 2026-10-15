/**
 * Performance gates. They drive the real Peer → Torrent → Picker → Storage
 * path with a fake socket, so they measure the engine's own cost per byte
 * with no network or kernel time, and fail the build on a regression.
 *
 * Budgets are set for a laptop-class core; slower CI machines can scale
 * them with TT_PERF_SCALE (e.g. 3 for an ARM board).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { heapStats } from "bun:jsc";
import { randomBytes } from "node:crypto";
import { createTorrent } from "../src/create";
import { parseTorrent } from "../src/metainfo";
import { SLOTS, BLOCK } from "../src/picker";
import { Torrent } from "../src/torrent";
import { handshake, MSG, OutBuffer } from "../src/wire";
import { cleanup, FakeSocket, fakeContext as context, tempDir } from "./helpers";

const SCALE = Number(process.env.TT_PERF_SCALE ?? 1);
const dirs: string[] = [];
afterAll(() => cleanup(...dirs));

/** A torrent with one fake seeding peer whose blocks are fed straight into the parser. */
async function harness(sizeMb: number) {
  const dir = await tempDir();
  dirs.push(dir);
  const data = new Uint8Array(randomBytes(sizeMb * 1024 * 1024));
  const torrentFile = createTorrent({ name: "perf.bin", files: [{ path: "", data }], pieceLength: 256 * 1024 });
  const meta = parseTorrent(torrentFile);
  const torrent = new Torrent(context(), meta, { dir });
  await new Promise((r) => torrent.once("ready", r));

  const socket = new FakeSocket();
  const reserved = handshake(meta.infoHash, new Uint8Array(20).fill(9));
  const opening = new OutBuffer();
  opening.raw(reserved);
  opening.simple(MSG.haveAll);
  opening.simple(MSG.unchoke);
  torrent.attach({ socket: socket as never, encrypt: null, decrypt: null, rest: new Uint8Array(0), handshakeSent: true, encrypted: false }, "10.0.0.1:1", true);
  socket.emit("data", opening.take());
  const peer = [...torrent.peers][0]!;

  /** The peer's answer to every outstanding request, cut into 1460-byte TCP-sized chunks. */
  const answer = (): { chunks: Uint8Array[]; blocks: number } => {
    const keys = [...peer.requests.keys()];
    const out = new OutBuffer();
    for (const key of keys) {
      const index = Math.floor(key / SLOTS);
      const begin = (key % SLOTS) * BLOCK;
      const length = Math.min(BLOCK, meta.length - index * meta.pieceLength - begin);
      out.pieceHeader(index, begin, length);
      out.raw(data.subarray(index * meta.pieceLength + begin, index * meta.pieceLength + begin + length));
    }
    const stream = out.take();
    const chunks: Uint8Array[] = [];
    for (let o = 0; o < stream.length; o += 1460) chunks.push(stream.subarray(o, o + 1460));
    return { chunks, blocks: keys.length };
  };
  const feed = (chunks: Uint8Array[]): void => {
    for (const chunk of chunks) socket.emit("data", chunk);
  };
  const pump = (): number => {
    const { chunks, blocks } = answer();
    feed(chunks);
    return blocks;
  };
  return { torrent, pump, answer, feed, meta, data };
}

describe("performance gates", () => {
  test("engine path: at least 300 MB/s per core with TCP-sized chunks, data intact", async () => {
    const { torrent, pump, meta } = await harness(128);
    const done = new Promise((r) => torrent.once("done", r));
    const cpu0 = process.cpuUsage();
    const t0 = performance.now();
    while (torrent.state !== "done") {
      if (pump() === 0) await Bun.sleep(1);
      await Promise.resolve();
    }
    await done;
    const seconds = (performance.now() - t0) / 1000;
    const cpu = process.cpuUsage(cpu0);
    const mbps = meta.length / 1e6 / seconds;
    const cpuPerGb = (cpu.user + cpu.system) / 1e6 / (meta.length / 1e9);
    console.log(`  engine path: ${mbps.toFixed(0)} MB/s, ${cpuPerGb.toFixed(2)} CPU s/GB (incl. hashing and disk writes)`);
    expect(torrent.progress).toBe(1);
    expect(mbps).toBeGreaterThan(300 / SCALE);
    await torrent.close();
  }, 60_000);

  test("under 1 KB of heap growth per received block", async () => {
    const { torrent, pump, answer, feed } = await harness(32);
    // Warm up: JIT, pools, file handles
    for (let i = 0; i < 20; i++) {
      pump();
      await Promise.resolve();
    }
    // Only the engine's work is measured; the peer's bytes are built before each round
    Bun.gc(true);
    let blocks = 0;
    let growth = 0;
    let objects = 0;
    for (let round = 0; round < 8; round++) {
      const answered = answer();
      const before = heapStats();
      feed(answered.chunks);
      await Promise.resolve();
      const after = heapStats();
      blocks += answered.blocks;
      growth += after.heapSize - before.heapSize;
      objects += after.objectCount - before.objectCount;
    }
    const perBlock = growth / blocks;
    console.log(`  heap growth: ${perBlock.toFixed(0)} B per block over ${blocks} blocks, ${(objects / blocks).toFixed(1)} objects per block`);
    expect(blocks).toBeGreaterThan(50);
    expect(perBlock).toBeLessThan(1024);
    await torrent.close();
  }, 30_000);
});
