import { describe, expect, test } from "bun:test";
import { Bitfield } from "../src/bitfield";
import { BLOCK, Picker, type PickerPeer, SLOTS } from "../src/picker";

function peer(pieces: number, has: (i: number) => boolean, seed = false): PickerPeer {
  const bitfield = new Bitfield(pieces);
  for (let i = 0; i < pieces; i++) if (has(i)) bitfield.set(i);
  return { bitfield, seed, requests: new Map(), current: null };
}

function picker(pieces: number, pieceLength = 4 * BLOCK): Picker {
  const p = new Picker(pieces, pieceLength, pieces * pieceLength);
  const all = new Bitfield(pieces);
  all.fill();
  p.setWanted(all);
  return p;
}

/** Delivers every picked block and returns the pieces that completed. */
function deliver(p: Picker, keys: number[], from: object): number[] {
  const done: number[] = [];
  for (const key of keys) {
    const index = Math.floor(key / SLOTS);
    if (!p.blockTarget(index, (key % SLOTS) * BLOCK, BLOCK)) continue;
    const piece = p.blockArrived(index, (key % SLOTS) * BLOCK, from);
    if (piece) {
      p.pieceVerified(piece);
      p.release(piece.buf);
      done.push(index);
    }
  }
  return done;
}

describe("picker", () => {
  test("bucket invariants hold under random availability changes", () => {
    const p = picker(500);
    const peers = Array.from({ length: 20 }, () => peer(500, () => Math.random() < 0.3));
    for (const x of peers) p.peerBitfield(x.bitfield, true);
    checkInvariants(p);
    for (let round = 0; round < 5000; round++) {
      const i = Math.floor(Math.random() * 500);
      const r = Math.random();
      if (r < 0.4) p.peerHave(i);
      else if (r < 0.7) p.peerLost(i);
      else if (r < 0.8) p.markHave(i);
      else if (r < 0.9) p.forget(i);
      else {
        const wanted = new Bitfield(500);
        for (let k = 0; k < 500; k++) if (Math.random() < 0.9) wanted.set(k);
        p.setWanted(wanted);
      }
    }
    checkInvariants(p);
  });

  test("picks the rarest piece the peer has", () => {
    const p = picker(10);
    // Piece 3 is held by one peer, everything else by three
    for (let k = 0; k < 3; k++) p.peerBitfield(peer(10, (i) => i !== 3 || k === 0).bitfield, true);
    const x = peer(10, () => true);
    const out: number[] = [];
    p.pick(x, 4, out);
    expect(out.map((k) => Math.floor(k / SLOTS))).toEqual([3, 3, 3, 3]);
  });

  test("finishes started pieces first, then starts new ones", () => {
    const p = picker(10);
    p.seeds = 2;
    const a = peer(10, () => true, true);
    const b = peer(10, () => true, true);
    const outA: number[] = [];
    p.pick(a, 2, outA); // half of one piece
    const outB: number[] = [];
    p.pick(b, 4, outB);
    const pieceA = Math.floor((outA[0] as number) / SLOTS);
    // b takes the two remaining blocks of a's piece before starting another
    expect(outB.slice(0, 2).map((k) => Math.floor(k / SLOTS))).toEqual([pieceA, pieceA]);
    expect(Math.floor((outB[2] as number) / SLOTS)).not.toBe(pieceA);
  });

  test("downloads everything, with endgame duplicates, and returned blocks are re-picked", () => {
    const p = picker(20);
    p.seeds = 2;
    const a = peer(20, () => true, true);
    const b = peer(20, () => true, true);
    const out: number[] = [];
    p.pick(a, 1000, out);
    expect(out.length).toBe(80);
    // Return one block (a choke), then let b pick: it gets that block first
    p.returnBlock(out[5] as number);
    const again: number[] = [];
    p.pick(b, 1, again);
    expect(again).toEqual([out[5] as number]);
    // Now everything is requested: b is in endgame and duplicates a's blocks
    expect(p.endgameActive).toBe(true);
    const dupes: number[] = [];
    b.requests.set(again[0] as number, 0);
    p.pick(b, 10, dupes);
    expect(dupes.length).toBe(10);
    expect(dupes).not.toContain(again[0]);
    deliver(p, out, a);
    expect(p.done).toBe(true);
    expect(p.have.full).toBe(true);
  });

  test("a failed piece is downloaded again", () => {
    const p = picker(2);
    p.seeds = 1;
    const a = peer(2, () => true, true);
    const out: number[] = [];
    p.pick(a, 4, out);
    let failed = null;
    for (const key of out) {
      const index = Math.floor(key / SLOTS);
      p.blockTarget(index, (key % SLOTS) * BLOCK, BLOCK);
      failed = p.blockArrived(index, (key % SLOTS) * BLOCK, a) ?? failed;
    }
    expect(failed).not.toBeNull();
    p.pieceFailed(failed!);
    expect(p.missing).toBe(2);
    const retry: number[] = [];
    p.pick(a, 100, retry);
    expect(retry.filter((k) => Math.floor(k / SLOTS) === failed!.index).length).toBe(4);
  });

  test("one writer per block: a second peer streaming the same block is refused", () => {
    const p = picker(1);
    p.seeds = 1;
    const out: number[] = [];
    p.pick(peer(1, () => true, true), 1, out);
    expect(p.blockTarget(0, 0, BLOCK)).not.toBeNull();
    expect(p.blockTarget(0, 0, BLOCK)).toBeNull();
    p.abortStream(0);
    expect(p.blockTarget(0, 0, BLOCK)).not.toBeNull();
    expect(p.blockTarget(0, 1, BLOCK)).toBeNull(); // misaligned
    expect(p.blockTarget(0, BLOCK, 100)).toBeNull(); // wrong length
  });

  test("respects the buffer memory limit", () => {
    const p = new Picker(100, 4 * BLOCK, 100 * 4 * BLOCK, 3 * 4 * BLOCK);
    const all = new Bitfield(100);
    all.fill();
    p.setWanted(all);
    p.seeds = 1;
    const out: number[] = [];
    p.pick(peer(100, () => true, true), 1000, out);
    expect(p.active.size).toBe(3);
    expect(out.length).toBe(12);
  });

  test("50,000 pieces: picking touches a handful of entries, not the whole torrent", () => {
    const pieces = 50_000;
    const p = picker(pieces, 16 * BLOCK);
    const peers: ReturnType<typeof peer>[] = [];
    for (let k = 0; k < 100; k++) {
      const x = peer(pieces, () => Math.random() < 0.6, k < 20);
      if (x.seed) p.seeds++;
      else p.peerBitfield(x.bitfield, true);
      peers.push(x);
    }
    p.touched = 0;
    let picks = 0;
    for (let round = 0; round < 30; round++) {
      for (const x of peers) {
        const out: number[] = [];
        p.pick(x, 16, out);
        picks++;
        deliver(p, out, x);
      }
    }
    const perPick = p.touched / picks;
    // A full scan would be ~50,000; log2(50,000) is ~16
    expect(perPick).toBeLessThan(16);
  });
});

/** The bucket layout's invariants: every fresh piece sits in its availability's bucket, and nothing else is listed. */
function checkInvariants(picker: Picker): void {
  const p = picker as unknown as { start: number[]; order: Int32Array | number[]; pos: Int32Array | number[]; availability: Uint16Array | number[]; freshCount: number; pieceCount: number };
  for (let k = 0; k + 1 < p.start.length; k++) {
    for (let at = p.start[k] as number; at < (p.start[k + 1] as number); at++) {
      const i = p.order[at] as number;
      if (p.pos[i] !== at) throw new Error(`pos mismatch at ${at}`);
      if (p.availability[i] !== k) throw new Error(`piece ${i} with availability ${p.availability[i]} in bucket ${k}`);
    }
  }
  let listed = 0;
  for (let i = 0; i < p.pieceCount; i++) if ((p.pos[i] as number) >= 0) listed++;
  if (listed !== p.freshCount) throw new Error(`count mismatch ${listed} vs ${p.freshCount}`);
}
