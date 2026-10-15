/**
 * Endgame bookkeeping, driven by hand with fake peers: the last blocks of a
 * download must never become impossible to request. Regressions from a real
 * Ubuntu swarm, where a download stopped with three pieces to go.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { createTorrent } from "../src/create";
import { parseTorrent } from "../src/metainfo";
import type { Peer } from "../src/peer";
import { BLOCK, SLOTS } from "../src/picker";
import { Torrent } from "../src/torrent";
import { handshake, MSG, OutBuffer } from "../src/wire";
import { cleanup, FakeSocket, fakeContext, tempDir } from "./helpers";

const dirs: string[] = [];
afterAll(() => cleanup(...dirs));

/** A one-piece torrent of two blocks, and a way to attach seeding fake peers to it. */
async function setup() {
  const dir = await tempDir();
  dirs.push(dir);
  const data = new Uint8Array(randomBytes(2 * BLOCK));
  const meta = parseTorrent(createTorrent({ name: "e.bin", files: [{ path: "", data }], pieceLength: 2 * BLOCK }));
  const torrent = new Torrent(fakeContext(), meta, { dir });
  await new Promise((r) => torrent.once("ready", r));
  let n = 0;
  const attach = (): { peer: Peer; socket: FakeSocket } => {
    const socket = new FakeSocket();
    const opening = new OutBuffer();
    opening.raw(handshake(meta.infoHash, new Uint8Array(20).fill(10 + n)));
    opening.simple(MSG.haveAll);
    opening.simple(MSG.unchoke);
    torrent.attach({ socket: socket as never, encrypt: null, decrypt: null, rest: new Uint8Array(0), handshakeSent: true, encrypted: false }, `10.0.0.${++n}:1`, true);
    socket.emit("data", opening.take());
    const peer = [...torrent.peers].find((p) => p.address === `10.0.0.${n}:1`) as Peer;
    return { peer, socket };
  };
  /** A `piece` message for block `b`, whole. */
  const block = (b: number): Uint8Array => {
    const out = new OutBuffer();
    out.pieceHeader(0, b * BLOCK, BLOCK);
    out.raw(data.subarray(b * BLOCK, (b + 1) * BLOCK));
    return out.take();
  };
  return { torrent, attach, block };
}

describe("endgame", () => {
  test("a duplicate discarded while another peer streams the block gives its request back", async () => {
    const { torrent, attach, block } = await setup();
    const a = attach();
    expect(a.peer.requests.size).toBe(2);
    const b = attach();
    expect(torrent.picker!.endgameActive).toBe(true);
    expect(b.peer.requests.size).toBe(2); // the same two blocks, duplicated

    // A is halfway through block 0 when B's whole copy arrives: B's is discarded
    const fromA = block(0);
    a.socket.emit("data", fromA.subarray(0, 13 + 5000));
    b.socket.emit("data", block(0));
    const piece = torrent.picker!.active.get(0)!;
    expect(b.peer.requests.has(0)).toBe(false);
    expect(piece.requested[0]).toBe(1); // only A's request is still out (it was 2 before the fix)

    // A goes away mid-block: block 0 is free to ask for again, and B gets it
    a.socket.destroy();
    expect(piece.streaming[0]).toBe(0);
    torrent.tick(Date.now()); // freed blocks go out at the next tick
    expect(b.peer.requests.has(0 * SLOTS + 0)).toBe(true);
    b.socket.emit("data", block(0));
    b.socket.emit("data", block(1));
    await new Promise((r) => torrent.once("done", r));
    await torrent.close();
  });

  test("a peer that stalls halfway through a block is dropped, freeing the block", async () => {
    const { torrent, attach, block } = await setup();
    const a = attach();
    a.socket.emit("data", block(0).subarray(0, 13 + 100));
    expect(torrent.picker!.active.get(0)!.streaming[0]).toBe(1);
    a.peer.lastReceivedAt -= 25_000;
    torrent.tick(Date.now());
    expect(a.peer.closed).toBe(true);
    expect(a.peer.closeReason).toBe("timeout");
    expect(torrent.picker!.active.get(0)!.streaming[0]).toBe(0);
    await torrent.close();
  });

  test("drifted request counts are rebuilt from the peers in endgame", async () => {
    const { torrent, attach, block } = await setup();
    const a = attach();
    attach();
    const piece = torrent.picker!.active.get(0)!;
    // Lose both peers' requests for block 1 without telling the picker
    for (const p of torrent.peers) p.requests.delete(1);
    expect(piece.requested[1]).toBe(2);
    for (let i = 0; i < 40; i++) torrent.tick(Date.now());
    expect([...torrent.peers].some((p) => p.requests.has(1))).toBe(true);
    a.socket.emit("data", block(0));
    for (const p of torrent.peers) if (p.requests.has(1)) (p.socket as unknown as FakeSocket).emit("data", block(1));
    await new Promise((r) => torrent.once("done", r));
    await torrent.close();
  });
});
