import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { Bitfield } from "../src/bitfield";
import { createTorrent } from "../src/create";
import { parseTorrent } from "../src/metainfo";
import { loadResume, resumeMatches, resumePath, saveResume } from "../src/resume";
import { Storage } from "../src/storage";
import { recheck, verifyPiece } from "../src/verifier";
import { cleanup, tempDir } from "./helpers";

const dirs: string[] = [];
afterEach(async () => cleanup(...dirs.splice(0)));

/** Three files of 10, 30 and 25 bytes in 16-byte pieces: pieces straddle files. */
function layout() {
  const files = [10, 30, 25].map((n, i) => ({ path: `f${i}`, data: new Uint8Array(randomBytes(n)) }));
  const meta = parseTorrent(createTorrent({ name: "t", files, pieceLength: 16 }));
  const whole = Buffer.concat(files.map((f) => f.data));
  const piece = (i: number) => new Uint8Array(whole.subarray(i * 16, Math.min(whole.length, (i + 1) * 16)));
  return { files, meta, whole, piece };
}

describe("storage", () => {
  test("maps pieces onto file segments", async () => {
    const { meta } = layout();
    const s = new Storage("/tmp/x", meta.files, 16);
    expect(s.segments(0, 16)).toEqual([
      { file: 0, fileOffset: 0, pieceOffset: 0, length: 10 },
      { file: 1, fileOffset: 0, pieceOffset: 10, length: 6 },
    ]);
    expect(s.segments(4, 1)).toEqual([{ file: 2, fileOffset: 24, pieceOffset: 0, length: 1 }]);
  });

  test("writes verified pieces into sparse full-size files and reads them back", async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const { meta, files, piece } = layout();
    const s = new Storage(dir, meta.files, 16);
    s.select([0, 1, 2]);
    for (let i = meta.pieceCount - 1; i >= 0; i--) {
      expect(verifyPiece(meta.pieces, i, piece(i))).toBe(true);
      await s.write(i, piece(i));
    }
    for (const [i, f] of files.entries()) expect(new Uint8Array(await readFile(join(dir, "t", f.path)))).toEqual(f.data);
    expect(await s.read(1, 16, 4, 8)).toEqual(piece(1).subarray(4, 12));
    await s.close();
  });

  test("only selected files are created; boundary bytes of others are not written", async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const { meta, files, piece } = layout();
    const s = new Storage(dir, meta.files, 16);
    s.select([1]);
    for (let i = 0; i < meta.pieceCount; i++) await s.write(i, piece(i));
    expect(existsSync(join(dir, "t", "f0"))).toBe(false);
    expect(existsSync(join(dir, "t", "f2"))).toBe(false);
    expect(new Uint8Array(await readFile(join(dir, "t", "f1")))).toEqual(files[1]!.data);
    // Piece 0 spills into unselected f0: it can't be served or re-checked
    expect(s.covers(0, 16)).toBe(false);
    expect(s.covers(1, 16)).toBe(true);
    expect(await s.read(0, 16, 0, 16)).toBeNull();
    await s.close();
  });

  test("files are created at full length up front", async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const { meta, piece } = layout();
    const s = new Storage(dir, meta.files, 16);
    s.select([2]);
    await s.write(4, piece(4));
    expect((await stat(join(dir, "t", "f2"))).size).toBe(25);
    await s.close();
  });
});

describe("padding", () => {
  test("gaps between files read as zeros, even into a reused buffer", async () => {
    const dir = await tempDir();
    dirs.push(dir);
    // a: bytes 0–9, padding 10–15, b: 16–25, padding 26–31 (BEP 47 padding files are gaps)
    const files = [
      { path: "t/a", length: 10, offset: 0 },
      { path: "t/b", length: 10, offset: 16 },
    ];
    const s = new Storage(dir, files, 32);
    s.select([0, 1]);
    await s.createEmpty();
    const piece = new Uint8Array(32);
    piece.set(new Uint8Array(randomBytes(10)), 0);
    piece.set(new Uint8Array(randomBytes(10)), 16);
    await s.write(0, piece);
    const dirty = new Uint8Array(32).fill(0xff);
    expect(await s.read(0, 32, 0, 32, dirty)).toEqual(piece);
    expect(await s.read(0, 32, 0, 32)).toEqual(piece);
    expect(await s.read(0, 32, 8, 12, new Uint8Array(12).fill(0xff))).toEqual(piece.subarray(8, 20));
    expect(await s.read(0, 32, 24, 8, new Uint8Array(8).fill(0xff))).toEqual(piece.subarray(24, 32));
    await s.close();
  });
});

describe("re-check and resume", () => {
  test("re-check finds exactly the intact pieces", async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const { meta, piece } = layout();
    const s = new Storage(dir, meta.files, 16);
    s.select([0, 1, 2]);
    for (const i of [0, 2, 4]) await s.write(i, piece(i));
    const valid: number[] = [];
    const size = (i: number) => (i === meta.pieceCount - 1 ? meta.length - i * 16 : 16);
    await recheck({ hashes: meta.pieces, storage: s, pieceSize: size }, [0, 1, 2, 3, 4], (i) => valid.push(i));
    expect(valid.sort()).toEqual([0, 2, 4]);
    await s.close();
  });

  test("resume state round-trips and detects changed files", async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const { meta, piece } = layout();
    const s = new Storage(dir, meta.files, 16);
    s.select([1, 2]);
    await s.write(2, piece(2));
    const files = await s.stat();
    expect(files[0]).toBeNull();
    const have = new Bitfield(meta.pieceCount);
    have.set(2);
    const path = resumePath(join(dir, "resume"), meta.infoHashHex);
    await saveResume(path, { infoHash: meta.infoHashHex, bitfield: Buffer.from(have.bytes).toString("base64"), files });
    const loaded = await loadResume(path);
    expect(loaded && resumeMatches(loaded, await s.stat())).toBe(true);
    // Touching a file invalidates it
    await utimes(join(dir, "t", "f2"), new Date(), new Date(Date.now() + 5000));
    expect(resumeMatches(loaded!, await s.stat())).toBe(false);
    // Selecting a file that wasn't selected then invalidates it too
    s.select([0, 1, 2]);
    expect(resumeMatches(loaded!, [{ size: 10, mtimeMs: 1 }, files[1]!, files[2]!])).toBe(false);
    expect(await loadResume(join(dir, "missing.json"))).toBeNull();
    await s.close();
  });
});

describe("smart ban", () => {
  test("blames only the peer whose blocks changed between the failed and the good attempt", async () => {
    const { PieceState, BLOCK } = await import("../src/picker");
    const { SmartBan } = await import("../src/verifier");
    const honest = { name: "honest" };
    const liar = { name: "liar" };
    const good = new Uint8Array(randomBytes(4 * BLOCK));
    const bad = good.slice();
    bad[2 * BLOCK + 7]! ^= 0xff; // the liar's block

    const ban = new SmartBan<{ name: string }>();
    const failed = new PieceState(3, 4 * BLOCK, bad);
    failed.senders.splice(0, 4, honest, honest, liar, honest);
    expect(ban.failed(failed)).toBeNull(); // several senders: nobody blamed yet

    const passed = new PieceState(3, 4 * BLOCK, good);
    passed.senders.splice(0, 4, honest, honest, honest, honest);
    expect(ban.verified(passed)).toEqual([liar]);
    expect(ban.verified(passed)).toEqual([]); // only once

    const sole = new PieceState(4, 4 * BLOCK, bad);
    sole.senders.splice(0, 4, liar, liar, liar, liar);
    expect(ban.failed(sole)).toBe(liar);
  });
});
