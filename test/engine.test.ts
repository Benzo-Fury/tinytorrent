import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { boundTransport, type Engine, type EncryptionPolicy, parseTorrent } from "../src/index";
import { saveResume, resumePath } from "../src/resume";
import { cleanup, makePayload, seeder, tempDir, testEngine, waitFor } from "./helpers";

const engines: Engine[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((e) => e.destroy()));
  await cleanup(...dirs.splice(0));
});

async function setup(sizes: number[], pieceLength = 32 * 1024, seedOptions = {}) {
  const seedDir = await tempDir();
  const leechDir = await tempDir();
  dirs.push(seedDir, leechDir);
  const payload = await makePayload(seedDir, "payload", sizes, pieceLength);
  const seed = await seeder(seedDir, payload.torrent, seedOptions);
  engines.push(seed.engine);
  return { ...payload, seed, seedDir, leechDir, meta: parseTorrent(payload.torrent) };
}

function leecher(options = {}): Engine {
  const engine = testEngine(options);
  engines.push(engine);
  return engine;
}

async function expectFiles(dir: string, meta: ReturnType<typeof parseTorrent>, files: Array<{ data: Uint8Array }>, only?: number[]) {
  for (const [i, f] of meta.files.entries()) {
    const path = join(dir, ...f.path.split("/"));
    if (only && !only.includes(i)) continue;
    expect(Buffer.from(await readFile(path)).equals(files[i]!.data)).toBe(true);
  }
}

describe("engine", () => {
  test("downloads a multi-file torrent from a seeder", async () => {
    const s = await setup([300_000, 5, 1_000_000, 0, 77_777]);
    const t = leecher().add(s.torrent, { dir: s.leechDir, peers: [s.seed.address] });
    await waitFor(t, "done");
    await expectFiles(s.leechDir, s.meta, s.files);
    expect(t.progress).toBe(1);
    expect(t.files().every((f) => f.downloaded === f.length)).toBe(true);
  });

  const policies: EncryptionPolicy[] = ["require", "prefer", "prefer-plaintext", "off"];
  for (const seedPolicy of policies) {
    for (const leechPolicy of policies) {
      const compatible = !(seedPolicy === "require" && leechPolicy === "off") && !(seedPolicy === "off" && leechPolicy === "require");
      test(`encryption: seeder ${seedPolicy}, leecher ${leechPolicy} → ${compatible ? "connects" : "refuses"}`, async () => {
        const s = await setup([200_000], 16 * 1024, { encryption: seedPolicy });
        const t = leecher({ encryption: leechPolicy }).add(s.torrent, { dir: s.leechDir, peers: [s.seed.address] });
        if (compatible) {
          await waitFor(t, "done", 15_000);
          await expectFiles(s.leechDir, s.meta, s.files);
        } else {
          await Bun.sleep(2500);
          expect(t.progress).toBe(0);
          expect(t.peers.size).toBe(0);
        }
      });
    }
  }

  test("encrypted peers really are encrypted, and plaintext ones aren't", async () => {
    const s = await setup([100_000]);
    const a = leecher({ encryption: "require" }).add(s.torrent, { dir: s.leechDir, peers: [s.seed.address], start: "metadata-only" });
    await waitFor(a, "metadata");
    await Bun.sleep(300);
    expect(a.stats().peers[0]?.encrypted).toBe(true);
    const dir2 = await tempDir();
    dirs.push(dir2);
    const b = leecher({ encryption: "off" }).add(s.torrent, { dir: dir2, peers: [s.seed.address], start: "metadata-only" });
    await waitFor(b, "metadata");
    await Bun.sleep(300);
    expect(b.stats().peers[0]?.encrypted).toBe(false);
  });

  test("metadata-only: nothing is requested until files are selected, then only those download", async () => {
    const s = await setup([100_000, 400_000, 100_000]);
    const t = leecher().add(s.torrent, { dir: s.leechDir, peers: [s.seed.address], start: "metadata-only" });
    await waitFor(t, "metadata");
    await Bun.sleep(700); // connected and unchoked, but gated
    expect(t.peers.size).toBe(1);
    expect(t.downloaded).toBe(0);
    expect(t.state).toBe("waiting");
    await t.select([1]);
    await waitFor(t, "done");
    await expectFiles(s.leechDir, s.meta, s.files, [1]);
    expect(existsSync(join(s.leechDir, ...s.meta.files[0]!.path.split("/")))).toBe(false);
    expect(t.files()[1]!.downloaded).toBe(400_000);
    // Only the selected file's pieces, plus at most one piece either side
    expect(t.downloaded).toBeLessThanOrEqual(400_000 + 2 * 32 * 1024);
  });

  test("a magnet link fetches metadata from peers, then downloads", async () => {
    const s = await setup([700_000, 300_000]);
    const magnet = `magnet:?xt=urn:btih:${s.meta.infoHashHex}&x.pe=${s.seed.address}`;
    const t = leecher().add(magnet, { dir: s.leechDir });
    const info = (await waitFor(t, "metadata")) as { name: string };
    expect(info.name).toBe("payload");
    await waitFor(t, "done");
    await expectFiles(s.leechDir, s.meta, s.files);
  });

  test("a swarm of leechers trades pieces with each other", async () => {
    const s = await setup([2_000_000], 16 * 1024, { upload: { slots: 2, limitBytesPerSecond: 600_000 }, seed: { enabled: true } });
    const peers: Array<{ engine: Engine; dir: string }> = [];
    for (let i = 0; i < 3; i++) {
      const dir = await tempDir();
      dirs.push(dir);
      peers.push({ engine: leecher({ upload: { slots: 8 }, seed: { enabled: true } }), dir });
    }
    await Promise.all(peers.map((p) => p.engine.ready()));
    const addresses = peers.map((p) => `127.0.0.1:${p.engine.port()}`);
    const torrents = peers.map((p, i) => p.engine.add(s.torrent, { dir: p.dir, peers: [s.seed.address, ...addresses.filter((_, k) => k !== i)] }));
    await Promise.all(torrents.map((t) => waitFor(t, "done", 30_000)));
    for (const p of peers) await expectFiles(p.dir, s.meta, s.files);
    // The seeder was capped at ~0.6 MB/s: 3 × 2 MB in the time taken means leechers fed each other
    expect(torrents.reduce((n, t) => n + t.uploaded, 0)).toBeGreaterThan(0);
  }, 40_000);

  test("upload slots 0: never uploads", async () => {
    const s = await setup([200_000], 16 * 1024, { upload: { slots: 0 } });
    const t = leecher().add(s.torrent, { dir: s.leechDir, peers: [s.seed.address] });
    await Bun.sleep(2500);
    expect(t.peers.size).toBe(1);
    expect(t.downloaded).toBe(0);
    expect(s.seed.torrent.uploaded).toBe(0);
  });

  test("pause keeps data; resume carries on from it", async () => {
    const s = await setup([3_000_000], 16 * 1024, { upload: { slots: 4, limitBytesPerSecond: 1_000_000 }, seed: { enabled: true } });
    const resumeDir = join(s.leechDir, ".resume");
    const t = leecher({ resumeDir }).add(s.torrent, { dir: s.leechDir, peers: [s.seed.address] });
    while (t.progress < 0.3) await Bun.sleep(50);
    await t.pause();
    const progress = t.progress;
    expect(t.state).toBe("paused");
    expect(t.peers.size).toBe(0);
    expect(existsSync(resumePath(resumeDir, s.meta.infoHashHex))).toBe(true);
    await Bun.sleep(300);
    expect(t.progress).toBe(progress);
    const before = t.downloaded;
    t.resume();
    await waitFor(t, "done");
    await expectFiles(s.leechDir, s.meta, s.files);
    // It only fetched what was missing (plus pieces in flight at the pause)
    expect(t.downloaded - before).toBeLessThan(3_000_000 * (1 - progress) + 200_000);
  });

  test("killswitch: disconnect closes everything; reconnect resumes", async () => {
    const s = await setup([3_000_000], 16 * 1024, { upload: { slots: 4, limitBytesPerSecond: 1_000_000 }, seed: { enabled: true } });
    const engine = leecher();
    const t = engine.add(s.torrent, { dir: s.leechDir, peers: [s.seed.address] });
    while (t.progress < 0.3) await Bun.sleep(50);
    await engine.disconnect();
    expect(t.state).toBe("paused");
    expect(engine.port()).toBe(0);
    const progress = t.progress;
    await Bun.sleep(1500);
    expect(t.progress).toBe(progress);
    await engine.reconnect();
    await waitFor(t, "done");
    await expectFiles(s.leechDir, s.meta, s.files);
  });

  test("a new engine trusts resume state when files are unchanged, and re-checks when they changed", async () => {
    const s = await setup([1_000_000], 16 * 1024);
    const resumeDir = join(s.leechDir, ".resume");
    const first = leecher({ resumeDir });
    const t = first.add(s.torrent, { dir: s.leechDir, peers: [s.seed.address] });
    await waitFor(t, "done");
    await first.destroy();

    // Unchanged: done at once, nothing downloaded, no re-check needed
    const second = leecher({ resumeDir });
    const again = second.add(s.torrent, { dir: s.leechDir });
    await waitFor(again, "done", 5000);
    expect(again.downloaded).toBe(0);
    await second.destroy();

    // Damaged file (mtime changes): re-check finds the damage and fetches it
    const file = join(s.leechDir, "payload");
    const bytes = new Uint8Array(await readFile(file));
    bytes.fill(0, 500_000, 520_000);
    await writeFile(file, bytes);
    const third = leecher({ resumeDir });
    const fixed = third.add(s.torrent, { dir: s.leechDir, peers: [s.seed.address] });
    await waitFor(fixed, "done");
    expect(fixed.downloaded).toBeGreaterThan(0);
    expect(fixed.downloaded).toBeLessThanOrEqual(3 * 16 * 1024);
    await expectFiles(s.leechDir, s.meta, s.files);
  });

  test("a peer sending corrupt data is dropped; the download still completes correctly", async () => {
    const s = await setup([600_000], 16 * 1024);
    // A liar: claims every piece through forged resume state, serves zeros
    const badDir = await tempDir();
    dirs.push(badDir);
    await writeFile(join(badDir, "payload"), new Uint8Array(600_000));
    const badResume = join(badDir, ".resume");
    const { mtimeMs } = await stat(join(badDir, "payload"));
    await saveResume(resumePath(badResume, s.meta.infoHashHex), {
      infoHash: s.meta.infoHashHex,
      bitfield: Buffer.from(new Uint8Array(Math.ceil(s.meta.pieceCount / 8)).fill(0xff)).toString("base64"),
      files: [{ size: 600_000, mtimeMs: Math.floor(mtimeMs) }],
    });
    const liar = await seeder(badDir, s.torrent, { resumeDir: badResume });
    engines.push(liar.engine);

    const t = leecher().add(s.torrent, { dir: s.leechDir, peers: [liar.address] });
    t.on("warning", () => undefined);
    while (t.hashFailures < 2) await Bun.sleep(20);
    t.addPeer(s.seed.address);
    await waitFor(t, "done");
    await expectFiles(s.leechDir, s.meta, s.files);
    expect(t.stats().closeReasons["hash failures"]).toBe(1);
  }, 30_000);

  test("a slow disk makes peers wait: piece writes in flight stay bounded", async () => {
    const s = await setup([8 * 1024 * 1024], 16 * 1024);
    const t = leecher({ maxBufferBytes: 1 << 20 }).add(s.torrent, { dir: s.leechDir, peers: [s.seed.address] });
    let inFlight = 0;
    let most = 0;
    t.once("metadata", () => {
      const storage = t.storage as NonNullable<typeof t.storage>;
      const write = storage.write.bind(storage);
      storage.write = async (index, data) => {
        most = Math.max(most, ++inFlight);
        await Bun.sleep(5);
        try {
          return await write(index, data);
        } finally {
          inFlight--;
        }
      };
    });
    await waitFor(t, "done");
    await expectFiles(s.leechDir, s.meta, s.files);
    // The cap is an eighth of maxBufferBytes (8 pieces here), plus pieces already in the socket
    // chunk being parsed when reads pause; unbounded, this reached 90
    expect(most).toBeLessThanOrEqual(32);
  });

  test("a bound transport works, and fails closed without an address", async () => {
    const s = await setup([200_000], 16 * 1024);
    const ok = leecher({ transport: boundTransport({ address: "127.0.0.1" }) }).add(s.torrent, { dir: s.leechDir, peers: [s.seed.address] });
    await waitFor(ok, "done");

    const dir = await tempDir();
    dirs.push(dir);
    let address: string | null = null;
    const closed = leecher({ transport: boundTransport({ address: () => address }), listen: false });
    const t = closed.add(s.torrent, { dir, peers: [s.seed.address] });
    await Bun.sleep(1500);
    expect(t.peers.size).toBe(0);
    expect(t.downloaded).toBe(0);
    address = "127.0.0.1"; // the link comes back: no back-off was charged to the peer
    await waitFor(t, "done", 15_000);
  }, 30_000);

  test("stats explain the swarm", async () => {
    const s = await setup([1_500_000], 16 * 1024, { upload: { slots: 4, limitBytesPerSecond: 300_000 }, seed: { enabled: true } });
    const t = leecher().add(s.torrent, { dir: s.leechDir, peers: [s.seed.address] });
    await Bun.sleep(1200);
    const stats = t.stats();
    expect(stats.state).toBe("downloading");
    expect(stats.peers.length).toBe(1);
    const peer = stats.peers[0]!;
    expect(peer.client).toBe("tinytorrent 0.1.0");
    expect(peer.source).toBe("manual");
    expect(peer.requests).toBeGreaterThan(0);
    expect(peer.depth).toBeGreaterThanOrEqual(16);
    expect(stats.downloadRate).toBeGreaterThan(0);
    await waitFor(t, "done");
  }, 30_000);
});
