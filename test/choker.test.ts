/**
 * The choker on its own: a `Swarm` driven tick by tick with fake peers and a
 * controlled clock, checking who gets upload slots while seeding and while
 * downloading.
 */

import { describe, expect, test } from "bun:test";
import type { EngineContext } from "../src/engine";
import { RateLimit } from "../src/limits";
import type { Peer } from "../src/peer";
import { Swarm, type SwarmOwner } from "../src/swarm";
import { UdpTrackerClient } from "../src/tracker";
import { systemTransport } from "../src/transport";

/** The parts of a `Peer` the choker reads and writes. */
class FakePeer {
  public amChoking = true;
  public peerInterested = true;
  public rateUp = 0;
  public rateDown = 0;
  public unchokedAt = 0;
  public chokedAt = 0;
  public readonly uploads: number[][] = [];
  public readonly requests = new Map<number, number>();
  public readonly allowedFast = new Set<number>();
  public closed = false;
  public outgoing = true;
  public readyAt = 0;
  public lastUsefulAt = 0;
  public amInterested = false;
  /** Total time unchoked, for fairness checks. */
  public served = 0;

  constructor(
    public readonly address: string,
    joined: number,
  ) {
    this.chokedAt = joined;
  }

  public choke(choke: boolean, now = Date.now()): void {
    if (this.amChoking === choke) return;
    this.amChoking = choke;
    if (choke) this.chokedAt = now;
    else this.unchokedAt = now;
  }
}

function context(slots: number): EngineContext {
  const transport = systemTransport();
  return {
    options: {
      encryption: "off",
      maxPeersPerTorrent: 200,
      maxHalfOpen: 30,
      upload: { slots },
      seed: { enabled: true, ratio: 0, minutes: 0 },
      pex: false,
      maxBufferBytes: 1 << 20,
      uploadCacheBytes: 1 << 20,
    },
    transport,
    udpTrackers: new UdpTrackerClient(transport),
    peerId: new Uint8Array(20),
    uploadLimit: new RateLimit(),
    downloadLimit: new RateLimit(),
    port: () => 0,
    announcePort: () => 0,
    allowed: () => true,
    dhtPort: () => 0,
    dhtLookup: () => undefined,
    dhtAddNode: () => undefined,
    halfOpenRoom: () => 0,
    halfOpen: () => undefined,
    removed: () => undefined,
  };
}

/** A swarm of `n` interested fake peers, seeding or downloading. */
function swarm(n: number, slots: number, seeding: boolean, start: number) {
  const peers = Array.from({ length: n }, (_, i) => new FakePeer(`10.0.0.${i + 1}:6881`, start + i));
  const owner: SwarmOwner = {
    infoHash: new Uint8Array(20),
    peers: new Set(peers as unknown as Peer[]),
    wantsPeers: () => false,
    seeding: () => seeding,
    isPrivate: () => true,
    attach: () => undefined,
    canServe: () => true,
    readBlock: () => null as unknown as Uint8Array,
    takeUpload: () => true,
    uploadedBytes: () => undefined,
  };
  return { peers, swarm: new Swarm(context(slots), owner) };
}

const unchoked = (peers: FakePeer[]): FakePeer[] => peers.filter((p) => !p.amChoking);

describe("choker", () => {
  test("seeding: newcomers are unchoked within a second when peers keep up", () => {
    let now = 1_000_000;
    const { peers, swarm: s } = swarm(12, 2, true, now);
    for (let tick = 0; tick < 6; tick++) {
      s.tick(now);
      // Everyone unchoked absorbs plenty
      for (const p of unchoked(peers)) p.rateUp = now - p.unchokedAt >= 1000 ? 5_000_000 : 0;
      now += 250;
    }
    expect(unchoked(peers).length).toBe(12);
  });

  test("seeding: peers that take nothing do not earn more slots", () => {
    let now = 1_000_000;
    const { peers, swarm: s } = swarm(40, 2, true, now);
    for (let tick = 0; tick < 36; tick++) {
      s.tick(now);
      now += 250;
    }
    // Growth stops once the provisional second passes without data: a few ticks of +4, not all 40
    expect(unchoked(peers).length).toBeGreaterThanOrEqual(2);
    expect(unchoked(peers).length).toBeLessThanOrEqual(20);
  });

  test("seeding: slots go round, so every waiting peer gets a turn", () => {
    let now = 1_000_000;
    const { peers, swarm: s } = swarm(10, 2, true, now);
    const turns = new Set<FakePeer>();
    for (let tick = 0; tick < 4 * 120; tick++) {
      s.tick(now);
      for (const p of unchoked(peers)) turns.add(p);
      now += 250;
    }
    // Two minutes, slow peers, 20 s turns: all ten were unchoked at some point
    expect(turns.size).toBe(10);
    expect(unchoked(peers).length).toBeLessThanOrEqual(10);
  });

  test("seeding: a peer that loses interest frees its slot at once", () => {
    const now = 1_000_000;
    const { peers, swarm: s } = swarm(3, 1, true, now);
    s.tick(now);
    const first = unchoked(peers);
    expect(first.length).toBeGreaterThan(0);
    for (const p of peers) p.rateUp = 1_000_000;
    const leaving = first[0] as FakePeer;
    leaving.peerInterested = false;
    s.notInterested(leaving as unknown as Peer);
    expect(leaving.amChoking).toBe(true);
  });

  test("downloading: fixed slots, best uploaders to us first, plus an optimistic one", () => {
    const now = 1_000_000;
    const { peers, swarm: s } = swarm(10, 4, false, now);
    peers.forEach((p, i) => (p.rateDown = i * 1000));
    for (let tick = 1; tick <= 40; tick++) s.tick(now + tick * 250);
    const open = unchoked(peers);
    expect(open.length).toBe(4);
    // The three fastest to us are in; the fourth slot is optimistic
    for (const p of peers.slice(7)) expect(p.amChoking).toBe(false);
  });

  test("zero slots never unchokes anyone", () => {
    const now = 1_000_000;
    for (const seeding of [true, false]) {
      const { peers, swarm: s } = swarm(5, 0, seeding, now);
      for (let tick = 1; tick <= 80; tick++) s.tick(now + tick * 250);
      s.interested(peers[0] as unknown as Peer);
      expect(unchoked(peers).length).toBe(0);
    }
  });
});
