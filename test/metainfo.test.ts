import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { encode } from "../src/bencode";
import { createTorrent } from "../src/create";
import { MetainfoError, parseInfo, parseMagnet, parseTorrent } from "../src/metainfo";

describe("metainfo", () => {
  test("parses a single-file torrent", () => {
    const data = new Uint8Array(randomBytes(100_000));
    const t = parseTorrent(createTorrent({ name: "a.bin", files: [{ path: "", data }], pieceLength: 32768, announce: ["udp://t:1", "http://t/a"] }));
    expect(t.name).toBe("a.bin");
    expect(t.length).toBe(100_000);
    expect(t.pieceCount).toBe(4);
    expect(t.files).toEqual([{ path: "a.bin", length: 100_000, offset: 0 }]);
    expect(t.announce).toEqual(["udp://t:1", "http://t/a"]);
    expect(t.infoHashHex).toMatch(/^[0-9a-f]{40}$/);
  });

  test("parses a multi-file torrent with offsets, and info hashes match", () => {
    const files = [10, 0, 70000].map((n, i) => ({ path: `d/f${i}`, data: new Uint8Array(randomBytes(n)) }));
    const buf = createTorrent({ name: "pack", files, pieceLength: 16384 });
    const t = parseTorrent(buf);
    expect(t.files.map((f) => [f.path, f.offset, f.length])).toEqual([
      ["pack/d/f0", 0, 10],
      ["pack/d/f1", 10, 0],
      ["pack/d/f2", 10, 70000],
    ]);
    expect(parseInfo(t.raw).infoHashHex).toBe(t.infoHashHex);
  });

  test("skips BEP 47 padding files but keeps their space", () => {
    const info = {
      name: "p",
      "piece length": 16,
      pieces: new Uint8Array(40),
      files: [
        { length: 10, path: ["a"] },
        { length: 6, path: [".pad", "6"], attr: "p" },
        { length: 16, path: ["b"] },
      ],
    };
    const t = parseInfo(encode(info));
    expect(t.files.map((f) => [f.path, f.offset])).toEqual([
      ["p/a", 0],
      ["p/b", 16],
    ]);
    expect(t.length).toBe(32);
  });

  test("rejects paths that would escape the download directory", () => {
    for (const path of [[".."], ["a", ".."], ["a/b"], [""]]) {
      const info = { name: "x", "piece length": 16, pieces: new Uint8Array(20), files: [{ length: 1, path }] };
      expect(() => parseInfo(encode(info))).toThrow(MetainfoError);
    }
    expect(() => parseInfo(encode({ name: "..", "piece length": 16, pieces: new Uint8Array(20), length: 1 }))).toThrow(MetainfoError);
  });

  test("rejects inconsistent piece counts and garbage", () => {
    expect(() => parseInfo(encode({ name: "x", "piece length": 16, pieces: new Uint8Array(20), length: 100 }))).toThrow(MetainfoError);
    expect(() => parseTorrent(new Uint8Array(randomBytes(50)))).toThrow(MetainfoError);
    expect(() => parseTorrent(encode({ announce: "x" }))).toThrow(MetainfoError);
  });

  test("parses magnet links with hex and base32 hashes", () => {
    const hex = "c12fe1c06bba254a9dc9f519b335aa7c1367a88a";
    const m = parseMagnet(`magnet:?xt=urn:btih:${hex}&dn=Name&tr=udp%3A%2F%2Ft%3A1&tr=udp%3A%2F%2Ft%3A1&x.pe=1.2.3.4:5`);
    expect(m.infoHashHex).toBe(hex);
    expect(m.name).toBe("Name");
    expect(m.announce).toEqual(["udp://t:1"]);
    expect(m.peers).toEqual(["1.2.3.4:5"]);
    expect(parseMagnet("magnet:?xt=urn:btih:YEX6DQDLXISUVHOJ6UM3GNNKPQJWPKEK").infoHashHex).toBe(hex);
    expect(() => parseMagnet("magnet:?dn=x")).toThrow(MetainfoError);
  });

  test("reads BEP 53 `so` file selections from magnets", () => {
    const hex = "c12fe1c06bba254a9dc9f519b335aa7c1367a88a";
    expect(parseMagnet(`magnet:?xt=urn:btih:${hex}&so=0,2,4-6,3`).select).toEqual([0, 2, 3, 4, 5, 6]);
    expect(parseMagnet(`magnet:?xt=urn:btih:${hex}&so=x,-1`).select).toBeUndefined();
    expect(parseMagnet(`magnet:?xt=urn:btih:${hex}`).select).toBeUndefined();
  });
});
