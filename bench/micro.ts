/**
 * Hot-path microbenchmarks, in-process: the wire parser, the picker on a
 * 50,000-piece torrent, piece hashing, and allocation per received block.
 */

import { heapStats } from "bun:jsc";
import { createHash, randomBytes } from "node:crypto";
import { Bitfield } from "../src/bitfield";
import { Picker, type PickerPeer } from "../src/picker";
import { MSG, type WireHandler, WireParser, writeU32 } from "../src/wire";

/** Builds `count` piece messages for 16 KiB blocks, as one byte stream. */
function pieceStream(count: number): Uint8Array {
  const block = new Uint8Array(randomBytes(16384));
  const out = new Uint8Array(count * (13 + 16384));
  for (let i = 0; i < count; i++) {
    const o = i * (13 + 16384);
    writeU32(out, o, 9 + 16384);
    out[o + 4] = MSG.piece;
    writeU32(out, o + 5, i >> 4);
    writeU32(out, o + 9, (i & 15) * 16384);
    out.set(block, o + 13);
  }
  return out;
}

function parser(): { mbps: number; bytesPerBlock: number } {
  const dest = new Uint8Array(256 * 1024);
  let blocks = 0;
  const handler: WireHandler = {
    onHandshake: () => undefined,
    onMessage: () => undefined,
    onPieceStart: () => dest,
    onPieceEnd: () => void blocks++,
  };
  const stream = pieceStream(4096); // 64 MiB
  const p = new WireParser(handler, false);
  const chunk = 65536;
  const t0 = performance.now();
  for (let round = 0; round < 8; round++) for (let o = 0; o < stream.length; o += chunk) p.push(stream.subarray(o, o + chunk));
  const seconds = (performance.now() - t0) / 1000;

  // Allocation per block: heap growth over a burst too small to trigger a collection
  const q = new WireParser(handler, false);
  Bun.gc(true);
  const before = heapStats().heapSize;
  for (let o = 0; o < 256 * (13 + 16384); o += 1460) q.push(stream.subarray(o, Math.min(o + 1460, 256 * (13 + 16384))));
  const after = heapStats().heapSize;
  return { mbps: (stream.length * 8) / 1e6 / seconds, bytesPerBlock: Math.max(0, after - before) / 256 };
}

function picker(): { picksPerSecond: number; touchedPerPick: number } {
  const pieces = 50_000;
  const p = new Picker(pieces, 256 * 1024, pieces * 256 * 1024);
  const wanted = new Bitfield(pieces);
  wanted.fill();
  p.setWanted(wanted);
  // 150 partial peers with random halves, 50 seeds
  const peers: PickerPeer[] = [];
  for (let i = 0; i < 200; i++) {
    const bitfield = new Bitfield(pieces);
    const seed = i < 50;
    if (!seed) for (let j = 0; j < pieces; j++) if (Math.random() < 0.5) bitfield.set(j);
    if (seed) p.seeds++;
    else p.peerBitfield(bitfield, true);
    peers.push({ bitfield, seed, requests: new Map(), current: null });
  }
  const out: number[] = [];
  let picks = 0;
  p.touched = 0;
  const t0 = performance.now();
  // Each round: every peer asks for 16 blocks; blocks then "arrive" and complete pieces
  for (let round = 0; round < 50; round++) {
    for (const peer of peers) {
      out.length = 0;
      p.pick(peer, 16, out);
      picks++;
      for (const key of out) {
        const index = Math.floor(key / 4096);
        const piece = p.blockArrived(index, (key % 4096) * 16384, peer);
        if (piece) {
          p.pieceVerified(piece);
          p.release(piece.buf);
        }
      }
    }
  }
  const seconds = (performance.now() - t0) / 1000;
  return { picksPerSecond: picks / seconds, touchedPerPick: p.touched / picks };
}

function hashing(): number {
  const piece = randomBytes(256 * 1024);
  const t0 = performance.now();
  for (let i = 0; i < 2000; i++) createHash("sha1").update(piece).digest();
  return (2000 * 256 * 1024 * 8) / 1e6 / ((performance.now() - t0) / 1000);
}

export async function micro(): Promise<void> {
  const parse = parser();
  const pick = picker();
  const hash = hashing();
  console.log(`wire parser      ${(parse.mbps / 1000).toFixed(1)} Gbit/s, ~${parse.bytesPerBlock.toFixed(0)} B heap growth per 16 KiB block`);
  console.log(`picker (50k pc)  ${pick.picksPerSecond.toFixed(0)} picks/s, ${pick.touchedPerPick.toFixed(1)} entries touched per pick`);
  console.log(`SHA-1            ${(hash / 1000).toFixed(1)} Gbit/s`);
}
