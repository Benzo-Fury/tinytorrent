/**
 * One torrent's peers as a group: who to dial and when, duplicate and
 * half-open bookkeeping, pruning peers that give nothing, peer exchange,
 * and the uploading side (choking and serving requests). The torrent owns
 * what is downloaded; the swarm owns who it is downloaded from and given to.
 */

import { type Candidate, Candidates, DialError, dial, type Established, mseOffer, type PeerSource } from "./connections";
import type { EngineContext } from "./engine";
import { pexMessage } from "./extensions";
import type { CloseReason, Peer } from "./peer";
import { TransportUnavailableError } from "./transport";
import { MSG } from "./wire";

/** How long a seed's upload slot is held before it may go to a peer that waits. */
const SEED_HOLD_MS = 20_000;
/** Bytes of blocks sent to one peer per socket write: 128 KiB measured cheapest on ARM (64 KiB cost more system calls; 256 KiB, more memory). */
const BATCH_BYTES = 128 * 1024;

/** What the swarm needs from its torrent. */
export interface SwarmOwner {
  readonly infoHash: Uint8Array;
  readonly peers: Set<Peer>;
  /** Whether new connections are wanted at all (not paused, closed or finished). */
  wantsPeers(): boolean;
  /** Seeding: upload slots go round, sized by what peers can take, rather than tit for tat. */
  seeding(): boolean;
  /** Private torrents (BEP 27) never exchange peers. */
  isPrivate(): boolean;
  attach(established: Established, address: string, outgoing: boolean): void;
  /** Whether we can serve this block. */
  canServe(index: number, begin: number, length: number): boolean;
  /** A block for upload: the bytes when cached, otherwise a promise of them (null if not on disk). */
  readBlock(index: number, begin: number, length: number): Uint8Array | Promise<Uint8Array | null>;
  /** Spends upload budget (torrent and engine limits); false when it is used up for now. */
  takeUpload(bytes: number): boolean;
  uploadedBytes(length: number): void;
}

/** Diagnostics from the swarm. */
export interface SwarmStats {
  connecting: number;
  candidates: number;
  closeReasons: Record<string, number>;
}

export class Swarm {
  private readonly candidates: Candidates;
  private readonly connecting = new Set<string>();
  /** Peers connected but not yet past the BitTorrent handshake. */
  public readonly handshaking = new Set<Peer>();
  /** Addresses of every connected or handshaking peer. */
  private readonly addresses = new Set<string>();
  private readonly sources = new Map<string, PeerSource>();
  private readonly closeReasons: Record<string, number> = {};
  private optimistic: Peer | null = null;
  private pexSent = new Set<string>();
  private dialQueued = false;
  private ticks = 0;

  constructor(
    private readonly engine: EngineContext,
    private readonly owner: SwarmOwner,
  ) {
    this.candidates = new Candidates(engine.options.encryption);
  }

  /** Where a peer's address came from. */
  public source(address: string): PeerSource {
    return this.sources.get(address) ?? "incoming";
  }

  /** Adds an address to dial. New addresses are dialled straight away, not at the next tick. */
  public add(address: string, source: PeerSource): void {
    if (!this.engine.allowed(hostOf(address)) || !this.candidates.add(address, source)) return;
    this.sources.set(address, source);
    if (this.dialQueued) return;
    this.dialQueued = true;
    queueMicrotask(() => {
      this.dialQueued = false;
      this.connectMore(Date.now());
    });
  }

  /** Makes every known address dialable now, as after a pause. */
  public retryAll(): void {
    this.candidates.retryAll();
  }

  // ---------- Peer lifecycle ---------- //

  /** A connection became a `Peer`, still handshaking. */
  public attached(peer: Peer): void {
    this.addresses.add(peer.address);
    if (!peer.peerId) this.handshaking.add(peer);
  }

  /**
   * The peer finished its handshake. Returns false if it duplicates a
   * connection we keep (it has been closed).
   */
  public ready(peer: Peer): boolean {
    this.handshaking.delete(peer);
    for (const other of this.owner.peers) {
      if (!other.peerId || !peer.peerId || !Buffer.from(other.peerId).equals(peer.peerId)) continue;
      // Both sides dialled at once. Keep the connection opened by the lower
      // peer id, which both ends agree on, so exactly one survives
      const keepOutgoing = Buffer.compare(Buffer.from(this.engine.peerId), Buffer.from(peer.peerId)) < 0;
      if (other.outgoing !== peer.outgoing && peer.outgoing === keepOutgoing) {
        other.close("duplicate");
        break;
      }
      peer.close("duplicate");
      return false;
    }
    const candidate = this.candidates.get(peer.address);
    if (candidate) this.candidates.worked(candidate);
    else if (!peer.outgoing) this.sources.set(peer.address, "incoming");
    return true;
  }

  /** The peer is gone: remember why, and when to try its address again. */
  public closed(peer: Peer, reason: CloseReason, wasReady: boolean): void {
    this.handshaking.delete(peer);
    this.addresses.delete(peer.address);
    this.closeReasons[reason] = (this.closeReasons[reason] ?? 0) + 1;
    if (this.optimistic === peer) this.optimistic = null;
    const now = Date.now();
    if (reason === "self" || reason === "wrong torrent" || reason === "hash failures") this.candidates.later(peer.address, now, 24 * 3600_000);
    // A seed has no use for the seeds it meets, and most peers that hang up on a seed are seeds
    // dropping a redundant connection; leechers that want it can dial in
    else if (reason === "not needed" || this.owner.seeding()) this.candidates.later(peer.address, now, 3600_000);
    else this.candidates.later(peer.address, now, wasReady ? 60_000 : 5 * 60_000);
  }

  /** An incoming peer told us its listening address; we're connected already, so dial it only much later. */
  public learnedListenAddress(address: string): void {
    this.add(address, "incoming");
    this.candidates.later(address, Date.now(), 10 * 60_000);
  }

  /** Bans an address for a day (it sent corrupt data). */
  public ban(address: string): void {
    this.candidates.later(address, Date.now(), 24 * 3600_000);
  }

  /** Closes every peer, including half-finished handshakes. */
  public closeAll(reason: CloseReason): void {
    for (const peer of [...this.owner.peers, ...this.handshaking]) peer.close(reason);
  }

  // ---------- Tick ---------- //

  /** Called on every torrent tick (250 ms). */
  public tick(now: number): void {
    this.ticks++;
    for (const peer of this.handshaking) if (now - peer.connectedAt > 15_000) peer.close("timeout");
    for (const peer of this.owner.peers) if (peer.uploads.length) this.serve(peer);
    // Seeding fills free slots every tick, so newcomers are served within a few hundred ms
    if (this.owner.seeding() || this.ticks % 4 === 0) this.fillSlots(now);
    if (this.ticks % 4 === 0) this.connectMore(now);
    if (this.ticks % 40 === 0) {
      this.choke(now);
      this.prune(now);
    }
    if (this.ticks % 240 === 0) this.sendPex();
  }

  /** Dials candidates while there is room, within the engine's half-open limit. */
  private connectMore(now: number): void {
    if (!this.owner.wantsPeers()) return;
    const room = this.engine.options.maxPeersPerTorrent - this.owner.peers.size - this.connecting.size;
    const n = Math.min(room, this.engine.halfOpenRoom());
    if (n <= 0) return;
    for (const candidate of this.candidates.next(n, now, this.busy)) this.connect(candidate);
  }

  private readonly busy = (address: string): boolean => this.connecting.has(address) || this.addresses.has(address);

  private connect(candidate: Candidate): void {
    const policy = this.engine.options.encryption;
    const mse = candidate.useMse && policy !== "off" ? { allow: mseOffer(policy) } : false;
    this.connecting.add(candidate.address);
    this.engine.halfOpen(+1);
    dial(this.engine.transport, candidate.host, candidate.port, this.owner.infoHash, this.engine.peerId, mse)
      .then((established) => this.owner.attach(established, candidate.address, true))
      .catch((error: unknown) => {
        // Our link being down (a bound transport without an address) is not the peer's fault
        if (error instanceof TransportUnavailableError) this.candidates.later(candidate.address, Date.now(), 5000);
        else this.candidates.failed(candidate, Date.now(), error instanceof DialError && error.connected);
      })
      .finally(() => {
        this.connecting.delete(candidate.address);
        this.engine.halfOpen(-1);
      });
  }

  /**
   * Makes room for better peers when the swarm is full: drops peers that
   * gave nothing useful for a minute (choking us, or with nothing we want),
   * a few at a time.
   */
  private prune(now: number): void {
    const max = this.engine.options.maxPeersPerTorrent;
    if (this.owner.peers.size < max * 0.9 || !this.candidates.waiting(now, this.busy)) return;
    const idle = [...this.owner.peers]
      .filter((p) => now - p.readyAt > 60_000 && now - p.lastUsefulAt > 60_000 && p.requests.size === 0)
      .sort((a, b) => a.lastUsefulAt - b.lastUsefulAt)
      .slice(0, 10);
    for (const peer of idle) peer.close(peer.amInterested ? "slow" : "useless");
  }

  /** Tells PEX-capable peers about the peers we're connected to, flagging seeds. */
  private sendPex(): void {
    if (this.owner.isPrivate() || !this.engine.options.pex) return;
    const listening = new Map<string, boolean>();
    for (const p of this.owner.peers) {
      if (p.outgoing) listening.set(p.address, p.seed);
      else if (p.listenPort) listening.set(withPort(hostOf(p.address), p.listenPort), p.seed);
    }
    const added = [...listening.keys()].filter((a) => !this.pexSent.has(a));
    const dropped = [...this.pexSent].filter((a) => !listening.has(a));
    this.pexSent = new Set(listening.keys());
    if (added.length === 0 && dropped.length === 0) return;
    const seeds = new Set(added.filter((a) => listening.get(a)));
    for (const peer of this.owner.peers) {
      if (peer.ext.ut_pex) peer.message(MSG.extended, pexMessage(added.filter((a) => a !== peer.address), dropped, seeds), peer.ext.ut_pex);
    }
  }

  // ---------- Uploading ---------- //

  /**
   * The choke round, every 10 s. Downloading: slots go to the interested
   * peers that give us the most (tit for tat), plus one optimistic slot
   * rotated every 30 s so newcomers get a chance. Seeding: slots go round —
   * a peer that has held one for 20 s gives it to the peer that has waited
   * longest — and there are as many as peers can usefully take. With zero
   * slots nobody is unchoked: no uploading at all.
   */
  private choke(now: number): void {
    const slots = this.engine.options.upload.slots;
    const peers = this.owner.peers;
    if (slots <= 0) {
      for (const peer of peers) peer.choke(true);
      return;
    }
    for (const peer of peers) if (!peer.peerInterested) peer.choke(true);
    const interested = [...peers].filter((p) => p.peerInterested);
    if (this.owner.seeding()) return this.rotate(now, interested);

    interested.sort((a, b) => b.rateDown - a.rateDown);
    const unchoke = new Set(interested.slice(0, Math.max(0, slots - 1)));
    if (!this.optimistic || this.ticks % 120 === 0 || !peers.has(this.optimistic)) {
      const choked = interested.filter((p) => !unchoke.has(p));
      this.optimistic = choked[Math.floor(Math.random() * choked.length)] ?? null;
    }
    if (this.optimistic) unchoke.add(this.optimistic);
    for (const peer of interested) peer.choke(!unchoke.has(peer));
  }

  /**
   * Seeding: peers that have held a slot for 20 s give it up, longest held
   * first, as far as needed to bring the unchoked count to the target with
   * every waiting peer served; then free slots go to the longest waiting.
   */
  private rotate(now: number, interested: Peer[]): void {
    const target = this.slotTarget(now);
    const unchoked = interested.filter((p) => !p.amChoking);
    const waiting = interested.length - unchoked.length;
    const held = unchoked.filter((p) => now - p.unchokedAt >= SEED_HOLD_MS).sort((a, b) => a.unchokedAt - b.unchokedAt);
    const out = Math.min(held.length, Math.max(0, unchoked.length - target + Math.min(waiting, target)));
    for (const peer of held.slice(0, out)) peer.choke(true, now);
    this.fillSlots(now);
  }

  /**
   * How many peers to unchoke. Downloading: the configured slots. Seeding:
   * at least that, and more while peers absorb what they get — libtorrent's
   * rate-based rule, fastest first, each needing 1 KiB/s more than the one
   * before, plus half again to grow into. Peers unchoked in the last second
   * have no rate yet; they count provisionally and let the target grow by
   * four per tick, so newcomers are served within a second without a slow
   * uplink being spread over everyone before rates show it is full.
   */
  private slotTarget(now: number): number {
    const slots = this.engine.options.upload.slots;
    if (slots <= 0 || !this.owner.seeding()) return slots;
    const rates: number[] = [];
    let fresh = 0;
    for (const p of this.owner.peers) {
      if (p.amChoking) continue;
      if (now - p.unchokedAt < 1000) fresh++;
      else rates.push(p.rateUp);
    }
    rates.sort((a, b) => b - a);
    let proven = 0;
    while (proven < rates.length && (rates[proven] as number) >= (proven + 1) * 1024) proven++;
    return Math.max(slots, proven + Math.max(1, proven >> 1), proven + fresh + 4);
  }

  /** Unchokes interested peers, longest waiting first, while there are free slots. */
  private fillSlots(now: number): void {
    const target = this.slotTarget(now);
    if (target <= 0) return;
    let unchoked = 0;
    const waiting: Peer[] = [];
    for (const p of this.owner.peers) {
      if (!p.amChoking) unchoked++;
      else if (p.peerInterested) waiting.push(p);
    }
    if (unchoked >= target || waiting.length === 0) return;
    waiting.sort((a, b) => a.chokedAt - b.chokedAt);
    for (const peer of waiting.slice(0, target - unchoked)) peer.choke(false, now);
  }

  /** A peer became interested: unchoke it straight away when a slot is free, instead of at the next round. */
  public interested(peer: Peer): void {
    if (peer.amChoking) this.fillSlots(Date.now());
  }

  /** A peer lost interest: its slot is free for someone else. */
  public notInterested(peer: Peer): void {
    if (peer.amChoking) return;
    peer.choke(true);
    this.fillSlots(Date.now());
  }

  /** A peer asked for a block. */
  public request(peer: Peer, index: number, begin: number, length: number): void {
    const allowed = (!peer.amChoking || peer.allowedFast.has(index)) && peer.uploads.length < 500 && this.owner.canServe(index, begin, length);
    if (!allowed) return peer.reject(index, begin, length);
    peer.uploads.push([index, begin, length]);
    if (peer.uploads.length === 1) this.serve(peer);
  }

  /** A peer withdrew a request. */
  public cancel(peer: Peer, index: number, begin: number): void {
    const at = peer.uploads.findIndex((u) => u[0] === index && u[1] === begin);
    if (at >= 0) peer.uploads.splice(at, 1);
  }

  /**
   * Sends a peer's queued blocks within the upload budget. Cached blocks go
   * out together, up to 128 KiB per socket write; a block that needs a disk
   * read pauses the queue until it arrives. A backed-up socket resumes on
   * drain; an exhausted budget, on the next tick.
   */
  private serve(peer: Peer): void {
    if (peer.uploading || peer.closed || peer.waitingDrain) return;
    let batch = 0;
    let open = true;
    while (open && peer.uploads.length > 0 && batch < BATCH_BYTES) {
      const [index, begin, length] = peer.uploads[0] as [number, number, number];
      if (!this.owner.takeUpload(length)) break;
      peer.uploads.shift();
      const data = this.owner.readBlock(index, begin, length);
      if (data instanceof Promise) {
        peer.uploading = true;
        data
          .then((block) => {
            peer.uploading = false;
            if (!peer.closed) this.send(peer, index, begin, length, block);
            this.serve(peer);
          })
          .catch(() => {
            peer.uploading = false;
            peer.reject(index, begin, length);
          });
        break;
      }
      open = this.send(peer, index, begin, length, data);
      batch += length;
    }
    // Flush blocks from this batch, or one that arrived from disk
    if ((peer.queued > 0 && !peer.flush()) || !open || peer.socket.writableNeedDrain) {
      peer.waitingDrain = true;
      peer.socket.once("drain", () => {
        peer.waitingDrain = false;
        this.serve(peer);
      });
    } else if (batch >= BATCH_BYTES && !peer.uploading) {
      // A full batch went out and the socket wants more: carry on after pending I/O
      setImmediate(() => this.serve(peer));
    }
  }

  /** Sends a block, or rejects it; false when the socket is backed up. */
  private send(peer: Peer, index: number, begin: number, length: number, data: Uint8Array | null): boolean {
    // Choked while the block was read: it was dropped from the queue, so say so
    if (!data || (peer.amChoking && !peer.allowedFast.has(index))) {
      peer.reject(index, begin, length);
      return true;
    }
    this.owner.uploadedBytes(length);
    return peer.block(index, begin, data);
  }

  /** How many peers are unchoked, and the current target. */
  public slots(): { unchoked: number; target: number } {
    let unchoked = 0;
    for (const p of this.owner.peers) if (!p.amChoking) unchoked++;
    return { unchoked, target: this.slotTarget(Date.now()) };
  }

  public stats(): SwarmStats {
    return { connecting: this.connecting.size, candidates: this.candidates.size, closeReasons: { ...this.closeReasons } };
  }
}

/** `host:port`, bracketing IPv6 hosts. */
export function withPort(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

/** The host part of `host:port` or `[v6]:port`. */
export function hostOf(address: string): string {
  return address.slice(0, address.lastIndexOf(":")).replace(/^\[|\]$/g, "");
}
