import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { ReadCache, WINDOW } from "../src/cache";
import { RateLimit, takeAll } from "../src/limits";
import { OutBuffer } from "../src/wire";

/** A torrent of `pieces` pieces held in memory, counting reads. */
function source(pieceLength: number, pieces: number) {
  const data = new Uint8Array(randomBytes(pieceLength * pieces));
  const reads: Array<[number, number, number]> = [];
  const into: Array<Uint8Array | undefined> = [];
  const read = async (index: number, offset: number, length: number, target?: Uint8Array) => {
    reads.push([index, offset, length]);
    into.push(target);
    const bytes = data.subarray(index * pieceLength + offset, index * pieceLength + offset + length);
    if (!target) return bytes.slice();
    target.set(bytes);
    return target;
  };
  const expected = (index: number, begin: number, length: number) => data.subarray(index * pieceLength + begin, index * pieceLength + begin + length);
  return { reads, read, expected, into };
}

async function block(cache: ReadCache, index: number, size: number, begin: number, length: number): Promise<Uint8Array | null> {
  return cache.block(index, size, begin, length);
}

describe("upload read cache", () => {
  test("one disk read per window serves every block in it", async () => {
    const piece = 2 * 1024 * 1024;
    const s = source(piece, 2);
    const cache = new ReadCache(8 * WINDOW, s.read);
    for (let begin = 0; begin < piece; begin += 16384) {
      expect(Buffer.from((await block(cache, 1, piece, begin, 16384))!).equals(s.expected(1, begin, 16384))).toBe(true);
    }
    expect(s.reads.length).toBe(piece / WINDOW);
    expect(cache.hits).toBe(piece / 16384 - piece / WINDOW + 0);
    // Cached blocks come back synchronously
    expect(cache.block(1, piece, 16384, 16384)).toBeInstanceOf(Uint8Array);
  });

  test("concurrent requests share one read", async () => {
    const s = source(WINDOW, 1);
    const cache = new ReadCache(4 * WINDOW, s.read);
    const all = await Promise.all([0, 16384, 32768].map((b) => block(cache, 0, WINDOW, b, 16384)));
    expect(all.every((x, i) => Buffer.from(x!).equals(s.expected(0, i * 16384, 16384)))).toBe(true);
    expect(s.reads.length).toBe(1);
  });

  test("stays within its memory, evicting the least recently used", async () => {
    const s = source(WINDOW, 10);
    const cache = new ReadCache(3 * WINDOW, s.read);
    for (let i = 0; i < 10; i++) await block(cache, i, WINDOW, 0, 16384);
    await block(cache, 9, WINDOW, 0, 16384);
    expect(s.reads.length).toBe(10); // piece 9 still cached
    await block(cache, 0, WINDOW, 0, 16384);
    expect(s.reads.length).toBe(11); // piece 0 was evicted
  });

  test("a block across two windows, a short last piece, put and drop", async () => {
    const piece = 3 * WINDOW;
    const s = source(piece, 2);
    const cache = new ReadCache(8 * WINDOW, s.read);
    const across = await block(cache, 0, piece, WINDOW - 8000, 16384);
    expect(Buffer.from(across!).equals(s.expected(0, WINDOW - 8000, 16384))).toBe(true);
    const short = 100_000;
    const tail = await block(cache, 1, short, short - 1000, 1000);
    expect(Buffer.from(tail!).equals(s.expected(1, short - 1000, 1000))).toBe(true);
    const reads = s.reads.length;
    const whole = new Uint8Array(randomBytes(piece));
    cache.put(0, whole);
    expect(Buffer.from(cache.block(0, piece, WINDOW, 16384) as Uint8Array).equals(whole.subarray(WINDOW, WINDOW + 16384))).toBe(true);
    cache.drop(0);
    await block(cache, 0, piece, WINDOW, 16384);
    expect(s.reads.length).toBe(reads + 1);
  });
});

describe("upload read cache: window reuse", () => {
  test("evicted windows are read into again, but only after pending callbacks ran", async () => {
    const s = source(WINDOW, 6);
    const cache = new ReadCache(2 * WINDOW, s.read);
    await block(cache, 0, WINDOW, 0, 16384);
    await block(cache, 1, WINDOW, 0, 16384);
    await block(cache, 2, WINDOW, 0, 16384); // evicts piece 0
    // Not yet: a callback in this turn could still be copying from it
    const first = s.into[0]!.buffer;
    await block(cache, 3, WINDOW, 0, 16384);
    expect(s.into[3]!.buffer).not.toBe(first);
    await new Promise((resolve) => setImmediate(resolve));
    const got = await block(cache, 4, WINDOW, 16384, 16384);
    expect(s.into[4]!.buffer === first || s.into[4]!.buffer === s.into[1]!.buffer).toBe(true);
    expect(Buffer.from(got!).equals(s.expected(4, 16384, 16384))).toBe(true);
    // Every block still reads correctly after reuse
    for (let i = 0; i < 6; i++) expect(Buffer.from((await block(cache, i, WINDOW, 32768, 16384))!).equals(s.expected(i, 32768, 16384))).toBe(true);
  });

  test("windows stored with put() are never reused for reads", async () => {
    const s = source(WINDOW, 4);
    const cache = new ReadCache(WINDOW, s.read);
    const piece = new Uint8Array(WINDOW).fill(9);
    cache.put(0, piece);
    await block(cache, 1, WINDOW, 0, 16384); // evicts the put window
    await new Promise((resolve) => setImmediate(resolve));
    await block(cache, 2, WINDOW, 0, 16384);
    await block(cache, 3, WINDOW, 0, 16384);
    for (const target of s.into) expect(target!.buffer).not.toBe(piece.buffer);
    expect(piece.every((b) => b === 9)).toBe(true);
  });
});

describe("rate limits", () => {
  test("a bucket refills by the second, holds one second, and an engine and torrent limit apply together", () => {
    const engine = new RateLimit(100_000);
    const torrent = new RateLimit(50_000);
    expect(takeAll([engine, torrent], 50_000)).toBe(true);
    expect(takeAll([engine, torrent], 10_000)).toBe(true); // the torrent's burst is at least 64 KiB
    expect(takeAll([engine, torrent], 30_000)).toBe(false); // the torrent is short: nothing taken from either
    expect(engine.allows(40_000)).toBe(true);
    torrent.refill(1000);
    expect(takeAll([engine, torrent], 20_000)).toBe(true);
    engine.refill(60_000);
    expect(engine.allows(100_001)).toBe(false); // capped at one second
    const unlimited = new RateLimit(0);
    unlimited.spend(1e12);
    expect(unlimited.exhausted).toBe(false);
  });
});

describe("OutBuffer", () => {
  test("large batches hand over their buffer instead of copying; small ones are copies", () => {
    const out = new OutBuffer();
    const block = new Uint8Array(randomBytes(16384));
    for (let i = 0; i < 8; i++) {
      out.pieceHeader(0, i * 16384, 16384);
      out.raw(block);
    }
    const big = out.take();
    expect(big.length).toBe(8 * (13 + 16384));
    expect(Buffer.from(big.subarray(13, 13 + 16384)).equals(block)).toBe(true);
    out.simple(1);
    const small = out.take();
    out.simple(2);
    out.take();
    expect(small).toEqual(Uint8Array.of(0, 0, 0, 1, 1)); // not overwritten by later messages
    expect(Buffer.from(big.subarray(13, 13 + 16384)).equals(block)).toBe(true);
    expect(small instanceof Buffer).toBe(false);
  });

  test("batches are built in pooled buffers, reused only once the socket gives them back", () => {
    const out = new OutBuffer();
    const block = new Uint8Array(randomBytes(16384));
    const fill = (n: number) => {
      for (let i = 0; i < n; i++) {
        out.pieceHeader(1, i * 16384, 16384);
        out.raw(block);
      }
    };
    fill(8);
    const first = out.take();
    expect(first.buffer.byteLength).toBe(512 * 1024);
    fill(8);
    const second = out.take(); // the first is still with the socket: a different buffer
    expect(second.buffer).not.toBe(first.buffer);
    out.recycle(first);
    fill(8);
    const third = out.take();
    expect(third.buffer).toBe(first.buffer);
    expect(Buffer.from(third.subarray(13, 13 + 16384)).equals(block)).toBe(true);
    expect(Buffer.from(second.subarray(13, 13 + 16384)).equals(block)).toBe(true);
    // A small batch that outgrew the small buffer is copied out; its large buffer goes back at once
    out.payload(20, new Uint8Array(4000).fill(3));
    const small = out.take();
    expect(small.buffer.byteLength).toBe(small.length);
    expect(small[4]).toBe(20);
    out.recycle(small); // not a pooled size: ignored
  });
});
