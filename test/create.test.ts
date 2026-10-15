import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { encode } from "../src/bencode";
import { createTorrent, createTorrentFromPath, pieceLengthFor } from "../src/create";
import { type Engine, parseTorrent } from "../src/index";
import { cleanup, tempDir, testEngine, waitFor } from "./helpers";

const dirs: string[] = [];
const engines: Engine[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((e) => e.destroy()));
  await cleanup(...dirs.splice(0));
});

async function dir(): Promise<string> {
  const d = await tempDir();
  dirs.push(d);
  return d;
}

describe("creating torrents", () => {
  test("from a directory: sorted regular files, the same info as from memory", async () => {
    const root = await dir();
    const tree = join(root, "album");
    const files = [
      { path: "b.bin", data: new Uint8Array(randomBytes(70_000)) },
      { path: "a/z.bin", data: new Uint8Array(randomBytes(3_000_001)) },
      { path: "a/empty", data: new Uint8Array(0) },
    ];
    for (const f of files) {
      await mkdir(join(tree, ...f.path.split("/").slice(0, -1)), { recursive: true });
      await writeFile(join(tree, ...f.path.split("/")), f.data);
    }
    await symlink(join(tree, "b.bin"), join(tree, "link.bin")); // skipped
    const progress: number[] = [];
    const fromDisk = parseTorrent(await createTorrentFromPath(tree, { pieceLength: 32 * 1024, onProgress: (n) => progress.push(n) }));
    const sorted = [...files].sort((x, y) => (x.path < y.path ? -1 : 1));
    const fromMemory = parseTorrent(createTorrent({ name: "album", files: sorted, pieceLength: 32 * 1024 }));
    expect(fromDisk.infoHashHex).toBe(fromMemory.infoHashHex);
    expect(fromDisk.files.map((f) => f.path)).toEqual(["album/a/empty", "album/a/z.bin", "album/b.bin"]);
    expect(progress[progress.length - 1]).toBe(3_070_001);
  });

  test("from a single file, with trackers in tiers, private flag, comment and web seeds", async () => {
    const root = await dir();
    const file = join(root, "movie.mkv");
    await writeFile(file, randomBytes(1_000_000));
    const buf = await createTorrentFromPath(file, {
      announce: [["udp://a:1", "udp://b:2"], "http://c/announce"],
      private: true,
      comment: "hello",
      webSeeds: ["https://example.org/movie.mkv"],
      creationDate: 1_700_000_000,
    });
    const t = parseTorrent(buf);
    expect(t.name).toBe("movie.mkv");
    expect(t.files).toEqual([{ path: "movie.mkv", length: 1_000_000, offset: 0 }]);
    expect(t.private).toBe(true);
    expect(t.announce).toEqual(["udp://a:1", "udp://b:2", "http://c/announce"]);
    const text = Buffer.from(buf).toString("latin1");
    expect(text).toContain("7:comment5:hello");
    expect(text).toContain("13:creation datei1700000000e");
    expect(text).toContain("8:url-listl29:https://example.org/movie.mkve");
    expect(text).toContain("10:created by11:tinytorrent");
  });

  test("picks piece sizes that keep torrents near 2,048 pieces", () => {
    expect(pieceLengthFor(1_000_000)).toBe(16 * 1024);
    expect(pieceLengthFor(700 * 1024 * 1024)).toBe(512 * 1024);
    expect(pieceLengthFor(4.7e9)).toBe(4 * 1024 * 1024);
    expect(pieceLengthFor(1e13)).toBe(16 * 1024 * 1024);
  });

  test("rejects odd piece lengths and empty directories", async () => {
    const root = await dir();
    await writeFile(join(root, "f"), "x");
    expect(createTorrentFromPath(root, { pieceLength: 20_000 })).rejects.toThrow("power of two");
    const empty = join(root, "empty");
    await mkdir(empty);
    expect(createTorrentFromPath(empty)).rejects.toThrow("no files");
  });

  test("a created torrent seeds and downloads end to end", async () => {
    const root = await dir();
    const tree = join(root, "pack");
    await mkdir(tree);
    const data = [new Uint8Array(randomBytes(400_000)), new Uint8Array(randomBytes(123_457))];
    await writeFile(join(tree, "one"), data[0]!);
    await writeFile(join(tree, "two"), data[1]!);
    const torrent = await createTorrentFromPath(tree);
    const seedEngine = testEngine({ seed: { enabled: true } });
    engines.push(seedEngine);
    // Seed mode: just created, so trusted without a second hash pass
    const seed = seedEngine.add(torrent, { dir: root, seedMode: true });
    await waitFor(seed, "done");
    await seedEngine.ready();
    const leechDir = await dir();
    const leechEngine = testEngine();
    engines.push(leechEngine);
    const t = leechEngine.add(torrent, { dir: leechDir, peers: [`127.0.0.1:${seedEngine.port()}`] });
    await waitFor(t, "done");
    expect(Buffer.from(await readFile(join(leechDir, "pack", "one"))).equals(data[0]!)).toBe(true);
    expect(Buffer.from(await readFile(join(leechDir, "pack", "two"))).equals(data[1]!)).toBe(true);
  });

  test("padding files (BEP 47) are never written, read as zeros, and pieces across them verify", async () => {
    // a (10,000) + padding to the 16 KiB boundary + b (20,000), as hybrid torrents lay files out
    const piece = 16 * 1024;
    const a = new Uint8Array(randomBytes(10_000));
    const b = new Uint8Array(randomBytes(20_000));
    const pad = piece - a.length;
    const stream = Buffer.concat([a, new Uint8Array(pad), b]);
    const hashes: Buffer[] = [];
    const { createHash } = await import("node:crypto");
    for (let o = 0; o < stream.length; o += piece) hashes.push(createHash("sha1").update(stream.subarray(o, o + piece)).digest());
    const torrent = encode({
      info: {
        name: "padded",
        "piece length": piece,
        pieces: Buffer.concat(hashes),
        files: [
          { length: a.length, path: ["a"] },
          { length: pad, path: [".pad", String(pad)], attr: "p" },
          { length: b.length, path: ["b"] },
        ],
      },
    });
    const seedDir = await dir();
    await mkdir(join(seedDir, "padded"));
    await writeFile(join(seedDir, "padded", "a"), a);
    await writeFile(join(seedDir, "padded", "b"), b);
    const seedEngine = testEngine({ seed: { enabled: true } });
    engines.push(seedEngine);
    const seed = seedEngine.add(torrent, { dir: seedDir }); // re-checks from disk, padding included
    await waitFor(seed, "done");
    expect(seed.progress).toBe(1);
    await seedEngine.ready();

    const leechDir = await dir();
    const leechEngine = testEngine();
    engines.push(leechEngine);
    const t = leechEngine.add(torrent, { dir: leechDir, peers: [`127.0.0.1:${seedEngine.port()}`] });
    await waitFor(t, "done");
    expect(Buffer.from(await readFile(join(leechDir, "padded", "a"))).equals(a)).toBe(true);
    expect(Buffer.from(await readFile(join(leechDir, "padded", "b"))).equals(b)).toBe(true);
    expect(existsSync(join(leechDir, "padded", ".pad"))).toBe(false);
  });
});
