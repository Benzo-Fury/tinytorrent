/**
 * Seeding end to end over loopback: limits and overrides, totals across
 * restarts, starting to seed without hashing, seed mode, re-checks, adding
 * paused, rate limits, the peer filter, seed-to-seed etiquette and the
 * tracker lifecycle.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTorrent } from "../src/create";
import { type Engine, type EngineOptions, parseTorrent, type Torrent } from "../src/index";
import { cleanup, makePayload, seeder, tempDir, testEngine, waitFor } from "./helpers";

const engines: Engine[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((e) => e.destroy()));
  await cleanup(...dirs.splice(0));
});

async function dir(): Promise<string> {
  const d = await tempDir();
  dirs.push(d);
  return d;
}

function engine(options: EngineOptions = {}): Engine {
  const e = testEngine(options);
  engines.push(e);
  return e;
}

async function setup(sizes: number[], seedOptions: EngineOptions = {}, pieceLength = 16 * 1024, announce?: string) {
  const seedDir = await dir();
  const leechDir = await dir();
  const payload = await makePayload(seedDir, "payload", sizes, pieceLength);
  const torrent = announce ? createTorrent({ name: "payload", files: payload.files, pieceLength, announce: [announce] }) : payload.torrent;
  const seed = await seeder(seedDir, torrent, seedOptions);
  engines.push(seed.engine);
  return { ...payload, torrent, seed, seedDir, leechDir, meta: parseTorrent(torrent) };
}

async function sameFiles(dirPath: string, meta: ReturnType<typeof parseTorrent>, files: Array<{ data: Uint8Array }>, only?: number[]): Promise<boolean> {
  for (const [i, f] of meta.files.entries()) {
    if (only && !only.includes(i)) continue;
    if (!Buffer.from(await readFile(join(dirPath, ...f.path.split("/")))).equals(files[i]!.data)) return false;
  }
  return true;
}

function once(t: Torrent, event: string, ms = 15_000): Promise<unknown> {
  return waitFor(t, event, ms);
}

describe("seeding", () => {
  test("large uploads arrive intact over plaintext and RC4, through recycled send buffers and a churning cache", async () => {
    // A tiny cache forces evicted windows to be reused while three leechers fetch in different orders
    const s = await setup([12 * 1024 * 1024], { encryption: "prefer", uploadCacheBytes: 1024 * 1024 }, 256 * 1024);
    const leechers = (["off", "require", "prefer-plaintext"] as const).map(async (encryption) => {
      const e = engine({ encryption });
      const d = await dir();
      const t = e.add(s.torrent, { dir: d, peers: [s.seed.address] });
      await once(t, "done", 60_000);
      expect(t.hashFailures).toBe(0);
      expect(await sameFiles(d, s.meta, s.files)).toBe(true);
    });
    await Promise.all(leechers);
    const cache = s.seed.torrent.stats().cache;
    expect(cache.reads).toBeGreaterThan(12 * 4); // more reads than windows: windows were evicted and read again
    expect(s.seed.torrent.uploaded).toBeGreaterThanOrEqual(3 * 12 * 1024 * 1024);
  });

  test("stops at the ratio limit, says `seeded` and disconnects", async () => {
    const s = await setup([400_000], { seed: { enabled: true, ratio: 1 } });
    expect(s.seed.torrent.state).toBe("seeding");
    const seeded = once(s.seed.torrent, "seeded");
    const t = engine().add(s.torrent, { dir: s.leechDir, peers: [s.seed.address] });
    await once(t, "done");
    await seeded;
    expect(s.seed.torrent.state).toBe("done");
    expect(s.seed.torrent.ratio).toBeGreaterThanOrEqual(1);
    expect(s.seed.torrent.peers.size).toBe(0);
  });

  test("without seeding, a finished torrent refuses new peers", async () => {
    const s = await setup([200_000]);
    const leechEngine = engine();
    const t = leechEngine.add(s.torrent, { dir: s.leechDir, peers: [s.seed.address] });
    await once(t, "done");
    expect(t.state).toBe("done");
    await leechEngine.ready();
    const late = engine().add(s.torrent, { dir: await dir(), peers: [`127.0.0.1:${leechEngine.port()}`] });
    await Bun.sleep(1000);
    expect(t.peers.size).toBe(0);
    expect(late.downloaded).toBe(0);
  });

  test("stops after the seed time limit", async () => {
    const s = await setup([50_000], { seed: { enabled: true, minutes: 0.02 } });
    await once(s.seed.torrent, "seeded", 5000);
    expect(s.seed.torrent.seedSeconds).toBeGreaterThanOrEqual(1.2);
    expect(s.seed.torrent.state).toBe("done");
  });

  test("a torrent's own setting overrides the engine's", async () => {
    const s = await setup([100_000]);
    // Engine says no seeding; this torrent seeds anyway
    const keep = engine().add(s.torrent, { dir: s.leechDir, peers: [s.seed.address], seed: true });
    await once(keep, "done");
    expect(keep.state).toBe("seeding");
    // Engine seeds; this torrent doesn't
    const other = await dir();
    const stop = engine({ seed: { enabled: true } }).add(s.torrent, { dir: other, peers: [s.seed.address], seed: false });
    await once(stop, "done");
    expect(stop.state).toBe("done");
    expect(stop.seedLimits()).toEqual({ enabled: false, ratio: 0, minutes: 0 });
    // Limits of its own
    expect(engine().add(s.torrent, { dir: await dir(), seed: { ratio: 2 }, start: "metadata-only" }).seedLimits()).toEqual({ enabled: true, ratio: 2, minutes: 0 });
  });

  test("uploaded, downloaded and seed time survive a restart", async () => {
    const s = await setup([300_000]);
    const resumeDir = join(s.leechDir, ".resume");
    const first = engine({ resumeDir, seed: { enabled: true } });
    const t = first.add(s.torrent, { dir: s.leechDir, peers: [s.seed.address] });
    await once(t, "done");
    // A second leecher takes it all from this one
    await first.ready();
    const other = engine().add(s.torrent, { dir: await dir(), peers: [`127.0.0.1:${first.port()}`] });
    await once(other, "done");
    await Bun.sleep(1200);
    const { totalUploaded, totalDownloaded, seedSeconds } = t;
    expect(totalUploaded).toBeGreaterThanOrEqual(300_000);
    await first.destroy();

    const second = engine({ resumeDir, seed: { enabled: true } });
    const again = second.add(s.torrent, { dir: s.leechDir });
    await once(again, "done");
    expect(again.uploaded).toBe(0); // this session
    expect(again.totalUploaded).toBe(totalUploaded);
    expect(again.totalDownloaded).toBe(totalDownloaded);
    expect(again.seedSeconds).toBeGreaterThanOrEqual(Math.round(seedSeconds) - 1);
    expect(again.ratio).toBeCloseTo(totalUploaded / 300_000, 5);
  });

  test("complete data with resume state seeds at once, without hashing anything", async () => {
    const s = await setup([2_000_000]);
    const resumeDir = join(s.seedDir, ".resume");
    const first = engine({ resumeDir, seed: { enabled: true } });
    await once(first.add(s.torrent, { dir: s.seedDir }), "done");
    await first.destroy();

    // Damage a piece without changing size or mtime: only hashing could notice
    const file = join(s.seedDir, "payload");
    const { mtime } = await stat(file);
    const bytes = new Uint8Array(await readFile(file));
    bytes.fill(7, 100_000, 116_384);
    await writeFile(file, bytes);
    await utimes(file, mtime, mtime);

    const started = performance.now();
    const t = engine({ resumeDir, seed: { enabled: true } }).add(s.torrent, { dir: s.seedDir });
    await once(t, "done");
    expect(performance.now() - started).toBeLessThan(500);
    expect(t.state).toBe("seeding");
    expect(t.progress).toBe(1); // trusted, not re-hashed
  });

  test("seed mode serves at once and hashes each piece when it is first uploaded", async () => {
    const s = await setup([1_000_000]);
    const started = performance.now();
    const seedEngine = engine({ seed: { enabled: true } });
    const t = seedEngine.add(s.torrent, { dir: s.seedDir, seedMode: true });
    await once(t, "done");
    expect(performance.now() - started).toBeLessThan(500);
    expect(t.state).toBe("seeding");
    expect(t.stats().unverified).toBe(s.meta.pieceCount);

    await seedEngine.ready();
    const leech = engine().add(s.torrent, { dir: s.leechDir, peers: [`127.0.0.1:${seedEngine.port()}`] });
    await once(leech, "done");
    expect(await sameFiles(s.leechDir, s.meta, s.files)).toBe(true);
    expect(t.stats().unverified).toBe(0);
  });

  test("seed mode: a bad piece on disk leaves seed mode for a full re-check", async () => {
    const s = await setup([600_000]);
    const badDir = await dir();
    const bytes = new Uint8Array(s.files[0]!.data);
    bytes.fill(0, 0, 600_000); // every piece is wrong
    await writeFile(join(badDir, "payload"), bytes);
    const bad = engine({ seed: { enabled: true } });
    const t = bad.add(s.torrent, { dir: badDir, seedMode: true });
    t.on("warning", () => undefined);
    await once(t, "done");
    await bad.ready();
    const checked = once(t, "checked");
    const leech = engine().add(s.torrent, { dir: s.leechDir, peers: [`127.0.0.1:${bad.port()}`] });
    leech.on("warning", () => undefined);
    expect(await checked).toBe(0); // nothing on disk was right
    expect(t.state).toBe("downloading");
    expect(t.progress).toBe(0);
    leech.addPeer(s.seed.address);
    await once(leech, "done");
    expect(await sameFiles(s.leechDir, s.meta, s.files)).toBe(true);
  });

  test("recheck() finds damage and downloads it again", async () => {
    const s = await setup([500_000]);
    const t = engine({ seed: { enabled: true } }).add(s.torrent, { dir: s.leechDir, peers: [s.seed.address] });
    await once(t, "done");
    const file = join(s.leechDir, "payload");
    const bytes = new Uint8Array(await readFile(file));
    bytes.fill(1, 40_000, 60_000);
    await writeFile(file, bytes);
    const done = new Promise((resolve) => t.once("done", resolve));
    await t.recheck();
    expect(t.state).toBe("downloading");
    expect(t.progress).toBeLessThan(1);
    await done;
    expect(await sameFiles(s.leechDir, s.meta, s.files)).toBe(true);
  });

  test("added paused: nothing connects until resume()", async () => {
    const s = await setup([200_000]);
    // Half the data is already there, so the paused torrent has something to check
    const half = s.files[0]!.data.subarray(0, 100_000);
    await writeFile(join(s.leechDir, "payload"), half);
    const t = engine().add(s.torrent, { dir: s.leechDir, peers: [s.seed.address], paused: true });
    await Bun.sleep(1000);
    expect(t.state).toBe("paused");
    expect(t.peers.size).toBe(0);
    expect(t.stats().connecting).toBe(0);
    expect(t.downloaded).toBe(0);
    expect(t.progress).toBeGreaterThan(0.4); // checked while paused
    t.resume();
    await once(t, "done");
    expect(await sameFiles(s.leechDir, s.meta, s.files)).toBe(true);
  });

  test("a magnet's so= selects files (BEP 53)", async () => {
    const s = await setup([30_000, 40_000, 50_000, 60_000]);
    const magnet = `magnet:?xt=urn:btih:${s.meta.infoHashHex}&so=0,2-3&x.pe=${s.seed.address}`;
    const t = engine().add(magnet, { dir: s.leechDir });
    await once(t, "done");
    expect(t.files().map((f) => f.selected)).toEqual([true, false, true, true]);
    expect(await sameFiles(s.leechDir, s.meta, s.files, [0, 2, 3])).toBe(true);
    expect(existsSync(join(s.leechDir, ...s.meta.files[1]!.path.split("/")))).toBe(false);
  });

  test("download and upload limits hold, per torrent and engine-wide", async () => {
    const s = await setup([2_000_000]);
    const rate = 400_000;
    for (const [leechOptions, addLimits] of [
      [{}, { downloadBytesPerSecond: rate }],
      [{ download: { limitBytesPerSecond: rate } }, undefined],
    ] as const) {
      const started = performance.now();
      const t = engine(leechOptions).add(s.torrent, { dir: await dir(), peers: [s.seed.address], limits: addLimits });
      const done = once(t, "done", 20_000);
      // The rate between the first second's burst and the end: bytes already in
      // flight when the limit pauses the sockets (kernel buffers, which grow
      // after heavy traffic) arrive as one burst, so the end isn't measured
      await Bun.sleep(1500);
      const before = t.downloaded;
      await Bun.sleep(1500);
      expect((t.downloaded - before) / 1.5).toBeLessThan(rate * 1.5);
      await done;
      // One second of burst, then the limit: about 4 s for 2 MB at 400 KB/s
      expect((performance.now() - started) / 1000).toBeGreaterThan(3);
    }
    // Upload, per torrent, on the seeding side
    s.seed.torrent.setLimits({ uploadBytesPerSecond: rate });
    const started = performance.now();
    const t = engine().add(s.torrent, { dir: await dir(), peers: [s.seed.address] });
    await once(t, "done", 20_000);
    expect((performance.now() - started) / 1000).toBeGreaterThan(3);
  }, 60_000);

  test("allowPeer keeps a host out, in both directions", async () => {
    const s = await setup([100_000], { allowPeer: () => false });
    const t = engine().add(s.torrent, { dir: s.leechDir, peers: [s.seed.address] });
    const blocked = engine({ allowPeer: (host) => host !== "127.0.0.1" }).add(s.torrent, { dir: await dir(), peers: [s.seed.address] });
    await Bun.sleep(1500);
    expect(t.peers.size).toBe(0); // the seeder refused it
    expect(blocked.stats().candidates).toBe(0); // never even considered
    expect(s.seed.torrent.peers.size).toBe(0);
  });

  test("seeds drop each other, and tell leechers they only upload (BEP 21)", async () => {
    const s = await setup([100_000]);
    const other = await seeder(s.seedDir, s.torrent);
    engines.push(other.engine);
    other.torrent.addPeer(s.seed.address);
    await Bun.sleep(1000);
    expect(other.torrent.peers.size).toBe(0);
    expect(s.seed.torrent.peers.size).toBe(0);
    const reasons = { ...other.torrent.stats().closeReasons, ...s.seed.torrent.stats().closeReasons };
    expect(reasons["not needed"]).toBeGreaterThan(0);

    const t = engine().add(s.torrent, { dir: s.leechDir, peers: [s.seed.address], start: "metadata-only" });
    await once(t, "metadata");
    while (t.peers.size === 0) await Bun.sleep(20);
    await Bun.sleep(100);
    expect([...t.peers][0]!.uploadOnly).toBe(true);
  });

  test("trackers hear started, completed and stopped, with exact byte counts", async () => {
    const announces: Array<Record<string, string>> = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const query = new URL(request.url).search.slice(1);
        const fields: Record<string, string> = {};
        for (const part of query.split("&")) {
          const [k, v] = part.split("=");
          if (k && k !== "info_hash" && k !== "peer_id") fields[k] = v ?? "";
        }
        announces.push(fields);
        return new Response(new Uint8Array(Buffer.from("d8:intervali1800e5:peers0:e")));
      },
    });
    try {
      const url = `http://127.0.0.1:${server.port}/announce`;
      const s = await setup([250_000], {}, 16 * 1024, url);
      await Bun.sleep(300);
      // The seeder started complete: started with nothing left, never completed
      expect(announces.filter((a) => a.event === "started").map((a) => a.left)).toEqual(["0"]);
      announces.length = 0;

      // Announce first, then meet the seeder (over loopback the download beats the first tick)
      const t = engine().add(s.torrent, { dir: s.leechDir });
      while (announces.length === 0) await Bun.sleep(20);
      t.addPeer(s.seed.address);
      await once(t, "done");
      await Bun.sleep(500);
      const events = announces.map((a) => `${a.event}:${a.left}`);
      expect(events).toEqual(["started:250000", "completed:0", "stopped:0"]);
      expect(Number(announces[1]!.downloaded)).toBe(250_000);

      // Pause and resume: stopped, then a fresh started
      announces.length = 0;
      await s.seed.torrent.pause();
      s.seed.torrent.resume();
      await Bun.sleep(600);
      expect(announces.map((a) => a.event)).toEqual(["stopped", "started"]);
      expect(Number(announces[0]!.uploaded)).toBeGreaterThanOrEqual(250_000);
    } finally {
      server.stop(true);
    }
  });

  test("engine.stats() adds up its torrents", async () => {
    const s = await setup([300_000]);
    const e = engine();
    const t = e.add(s.torrent, { dir: s.leechDir, peers: [s.seed.address] });
    await once(t, "done");
    const stats = e.stats();
    expect(stats.torrents).toBe(1);
    expect(stats.downloaded).toBe(300_000);
    expect(stats.announcePort).toBe(e.port());
    expect(s.seed.engine.stats().uploaded).toBeGreaterThanOrEqual(300_000);
  });

  test("a peer closed partway through a chunk ignores the rest of it", async () => {
    // Regression: a block started after the close was never cleaned up, and
    // its piece could not be requested again
    const { Peer } = await import("../src/peer");
    const { EventEmitter } = await import("node:events");
    const socket = Object.assign(new EventEmitter(), { write: () => true, destroy: () => undefined, setTimeout: () => undefined, writableNeedDrain: false });
    const started: number[] = [];
    let peer: InstanceType<typeof Peer>;
    const owner = {
      infoHash: new Uint8Array(20),
      peerId: new Uint8Array(20).fill(1),
      peerReady: () => undefined,
      peerClosed: () => undefined,
      peerMessage: () => undefined,
      blockTarget: (_p: unknown, index: number) => {
        started.push(index);
        return new Uint8Array(32 * 1024);
      },
      blockArrived: () => peer.close("hash failures"),
    };
    peer = new Peer(owner as never, socket as never, "1.2.3.4:5", false, null, null, 4, new Uint8Array(0), true, false);
    const handshake = new Uint8Array(68);
    handshake[0] = 19;
    handshake.set(new TextEncoder().encode("BitTorrent protocol"), 1);
    const piece = (index: number): Uint8Array => {
      const m = Buffer.alloc(13 + 100);
      m.writeUInt32BE(9 + 100, 0);
      m[4] = 7;
      m.writeUInt32BE(index, 5);
      return m;
    };
    socket.emit("data", Buffer.concat([handshake, piece(0), piece(1)]));
    expect(started).toEqual([0]);
    expect(peer.closed).toBe(true);
  });
});
