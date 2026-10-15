/**
 * Chooses which blocks to request from which peer.
 *
 * - **Partial first.** A peer keeps working on its current piece, then joins
 *   pieces others started that still have unrequested blocks, so few pieces
 *   are in flight and piece buffers stay few.
 * - **Rarest first.** Fresh pieces sit in one array grouped into buckets by
 *   availability (libtorrent's layout). A `have` moves a piece to the
 *   neighbouring bucket with one swap, so availability changes are O(1) and
 *   picking for a seed touches one entry. Pieces that are complete, in
 *   flight or not wanted are not in the array at all: nothing is ever
 *   re-scanned.
 * - **Endgame.** When every remaining block is requested, a peer may request
 *   blocks already requested from someone else; the first copy wins and the
 *   torrent cancels the rest.
 */

import { Bitfield } from "./bitfield";

/** Block size used for every request. */
export const BLOCK = 16 * 1024;
/** Block slots per piece in a block key; allows pieces up to 64 MiB. */
export const SLOTS = 4096;
/** Most copies of one block requested at once in endgame. */
const ENDGAME_DUPLICATES = 2;

/** What the picker needs to know about a peer. */
export interface PickerPeer {
  /** Pieces the peer has; ignored when `seed` is true. */
  bitfield: Bitfield;
  seed: boolean;
  /** Outstanding requests to this peer, by block key. */
  requests: Map<number, number>;
  /** The piece this peer is filling, for affinity. */
  current: PieceState | null;
}

/** A piece being downloaded: its buffer and per-block state. */
export class PieceState {
  public readonly blockCount: number;
  /** Outstanding requests per block. */
  public readonly requested: Uint8Array;
  /** Whether each block has arrived. */
  public readonly received: Uint8Array;
  /** Whether a peer is copying bytes into each block right now; one writer per block. */
  public readonly streaming: Uint8Array;
  public receivedCount = 0;
  /** Blocks neither received nor requested. */
  public unrequested: number;
  /** First block that might still be unrequested. */
  public cursor = 0;
  /** Which peer sent each block, to find the liar if the hash fails. */
  public readonly senders: Array<object | undefined>;

  constructor(
    public readonly index: number,
    public readonly length: number,
    public readonly buf: Uint8Array,
  ) {
    this.blockCount = Math.ceil(length / BLOCK);
    this.requested = new Uint8Array(this.blockCount);
    this.received = new Uint8Array(this.blockCount);
    this.streaming = new Uint8Array(this.blockCount);
    this.senders = new Array(this.blockCount);
    this.unrequested = this.blockCount;
  }

  /** Length of block `b`. */
  public blockLength(b: number): number {
    return b === this.blockCount - 1 ? this.length - b * BLOCK : BLOCK;
  }
}

export class Picker {
  /** Pieces verified and saved. */
  public readonly have: Bitfield;
  /** Pieces of the selected files. */
  public wanted: Bitfield;
  /** Pieces in flight. */
  public readonly active = new Map<number, PieceState>();
  /** Peers that have every piece, counted once instead of on every piece. */
  public seeds = 0;
  /** Entries examined while picking, for the complexity test. */
  public touched = 0;
  /** Wanted pieces not yet verified. */
  public missing = 0;

  private readonly availability: Uint16Array;
  // Fresh pieces in availability buckets: bucket a is order[start[a] .. start[a+1])
  private readonly order: Int32Array;
  private readonly pos: Int32Array;
  private readonly start: number[] = [0, 0];
  /** Active pieces that still have unrequested blocks. */
  private readonly open = new Set<PieceState>();
  private readonly pool: Uint8Array[] = [];

  constructor(
    public readonly pieceCount: number,
    public readonly pieceLength: number,
    public readonly length: number,
    /** Upper bound on piece buffer memory before only started pieces are picked. */
    private readonly maxBufferBytes = 512 * 1024 * 1024,
  ) {
    this.have = new Bitfield(pieceCount);
    this.wanted = new Bitfield(pieceCount);
    this.availability = new Uint16Array(pieceCount);
    this.order = new Int32Array(pieceCount);
    this.pos = new Int32Array(pieceCount).fill(-1);
  }

  /** Length of piece `i`. */
  public pieceSize(i: number): number {
    return i === this.pieceCount - 1 ? this.length - i * this.pieceLength : this.pieceLength;
  }

  /** Number of fresh pieces waiting to be started. */
  public get freshCount(): number {
    return this.start[this.start.length - 1] as number;
  }

  /** Whether every wanted piece is verified. */
  public get done(): boolean {
    return this.missing === 0;
  }

  /** Replaces the set of wanted pieces. Fresh pieces join in random order so swarms spread out. */
  public setWanted(wanted: Bitfield): void {
    this.wanted = wanted;
    this.missing = 0;
    const added: number[] = [];
    for (let i = 0; i < this.pieceCount; i++) {
      if (wanted.has(i) && !this.have.has(i)) this.missing++;
      const fresh = wanted.has(i) && !this.have.has(i) && !this.active.has(i);
      if (fresh && this.pos[i] === -1) added.push(i);
      else if (!fresh && (this.pos[i] as number) >= 0) this.remove(i);
    }
    for (let i = added.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [added[i], added[j]] = [added[j] as number, added[i] as number];
    }
    for (const i of added) this.insert(i);
  }

  // ---------- Availability ---------- //

  /** A peer announced one piece. */
  public peerHave(i: number): void {
    const a = this.availability[i] as number;
    if (a === 0xffff) return;
    this.availability[i] = a + 1;
    const p = this.pos[i] as number;
    if (p < 0) return;
    while (this.start.length - 1 <= a + 1) this.start.push(this.start[this.start.length - 1] as number);
    // Swap to the end of bucket a, then shrink bucket a by one
    const last = (this.start[a + 1] as number) - 1;
    this.swap(p, last);
    this.start[a + 1] = last;
  }

  /** A peer that had a piece left. */
  public peerLost(i: number): void {
    const a = this.availability[i] as number;
    if (a === 0) return;
    this.availability[i] = a - 1;
    const p = this.pos[i] as number;
    if (p < 0) return;
    const first = this.start[a] as number;
    this.swap(p, first);
    this.start[a] = first + 1;
  }

  /** Adds or removes a whole bitfield's worth of availability. */
  public peerBitfield(bitfield: Bitfield, add: boolean): void {
    for (let byte = 0; byte < bitfield.bytes.length; byte++) {
      const v = bitfield.bytes[byte] as number;
      if (!v) continue;
      for (let bit = 0; bit < 8; bit++) {
        if (v & (0x80 >> bit)) {
          if (add) this.peerHave(byte * 8 + bit);
          else this.peerLost(byte * 8 + bit);
        }
      }
    }
  }

  // ---------- Picking ---------- //

  /** Appends up to `max` block keys to request from `peer`, marking them requested. */
  public pick(peer: PickerPeer, max: number, out: number[]): void {
    let need = max;
    const first = out.length;
    // 1. Keep filling this peer's own piece
    const current = peer.current;
    if (current && current.unrequested > 0 && this.active.get(current.index) === current) {
      need -= this.take(current, need, out);
    }
    // 2. Join started pieces that still have unrequested blocks
    if (need > 0 && this.open.size > 0) {
      for (const piece of this.open) {
        this.touched++;
        if (!this.peerHas(peer, piece.index)) continue;
        peer.current = piece;
        need -= this.take(piece, need, out);
        if (need === 0) return;
      }
    }
    // 3. Start the rarest fresh pieces the peer has
    while (need > 0 && this.bufferBytes() < this.maxBufferBytes) {
      const i = this.rarestFor(peer);
      if (i < 0) break;
      const piece = this.activate(i);
      peer.current = piece;
      need -= this.take(piece, need, out);
    }
    // 4. Endgame: duplicate blocks already requested elsewhere
    if (need > 0 && this.freshCount === 0 && this.open.size === 0) this.endgame(peer, need, out, new Set(out.slice(first)));
  }

  /** Finds the rarest fresh piece the peer has, or -1. Starts at bucket 1: bucket 0 is pieces no peer has. */
  private rarestFor(peer: PickerPeer): number {
    const n = this.freshCount;
    // Seeds have everything, unless only seeds have it — then bucket 0 holds it all
    let from = this.seeds > 0 ? 0 : Math.min(this.start[1] ?? n, n);
    if (!peer.seed && peer.bitfield.count * 8 < n - from) return this.rarestSparse(peer);
    for (let p = from; p < n; p++) {
      this.touched++;
      const i = this.order[p] as number;
      if (this.peerHas(peer, i)) return i;
    }
    return -1;
  }

  /** For a peer with few pieces: walk its bitfield instead of the fresh list. */
  private rarestSparse(peer: PickerPeer): number {
    let best = -1;
    let bestAvailability = Infinity;
    const bytes = peer.bitfield.bytes;
    for (let byte = 0; byte < bytes.length; byte++) {
      const v = bytes[byte] as number;
      if (!v) continue;
      for (let bit = 0; bit < 8; bit++) {
        if (!(v & (0x80 >> bit))) continue;
        const i = byte * 8 + bit;
        this.touched++;
        if ((this.pos[i] as number) >= 0 && (this.availability[i] as number) < bestAvailability) {
          best = i;
          bestAvailability = this.availability[i] as number;
        }
      }
    }
    return best;
  }

  /** Takes unrequested blocks from a piece; returns how many. */
  private take(piece: PieceState, max: number, out: number[]): number {
    let taken = 0;
    for (let b = piece.cursor; b < piece.blockCount && taken < max; b++) {
      if (piece.requested[b] || piece.received[b]) continue;
      piece.requested[b] = 1;
      piece.unrequested--;
      out.push(piece.index * SLOTS + b);
      taken++;
      piece.cursor = b + 1;
    }
    if (piece.unrequested === 0) this.open.delete(piece);
    else this.open.add(piece);
    return taken;
  }

  /** `mine` holds blocks this peer was given earlier in the same pick, not yet in its requests. */
  private endgame(peer: PickerPeer, need: number, out: number[], mine: Set<number>): void {
    for (const piece of this.active.values()) {
      if (!this.peerHas(peer, piece.index)) continue;
      for (let b = 0; b < piece.blockCount && need > 0; b++) {
        this.touched++;
        const key = piece.index * SLOTS + b;
        if (piece.received[b] || (piece.requested[b] as number) >= ENDGAME_DUPLICATES || peer.requests.has(key) || mine.has(key)) continue;
        piece.requested[b]!++;
        out.push(key);
        need--;
      }
      if (need === 0) return;
    }
  }

  /** Whether the torrent is in endgame. */
  public get endgameActive(): boolean {
    return this.freshCount === 0 && this.open.size === 0 && this.active.size > 0;
  }

  // ---------- Block and piece events ---------- //

  /** The piece buffer an arriving block goes into (at `begin`), or null if it is not wanted (unknown, misaligned or a duplicate). */
  public blockTarget(index: number, begin: number, length: number): Uint8Array | null {
    const piece = this.active.get(index);
    if (!piece || begin % BLOCK !== 0) return null;
    const b = begin / BLOCK;
    if (b >= piece.blockCount || piece.received[b] || piece.streaming[b] || length !== piece.blockLength(b)) return null;
    piece.streaming[b] = 1;
    return piece.buf;
  }

  /**
   * Records an arrived block. Returns the piece when this block completed
   * it, so the caller can hash and save it; null otherwise.
   */
  public blockArrived(index: number, begin: number, from: object): PieceState | null {
    const piece = this.active.get(index);
    if (!piece) return null;
    const b = begin / BLOCK;
    piece.streaming[b] = 0;
    if (piece.received[b]) return null;
    piece.received[b] = 1;
    piece.receivedCount++;
    if (!piece.requested[b]) {
      // An unrequested (or returned) block arrived anyway
      piece.unrequested--;
      if (piece.unrequested === 0) this.open.delete(piece);
    }
    piece.senders[b] = from;
    return piece.receivedCount === piece.blockCount ? piece : null;
  }

  /** A peer left halfway through sending a block; another peer may now send it. */
  public abortStream(key: number): void {
    const piece = this.active.get(Math.floor(key / SLOTS));
    if (piece) piece.streaming[key % SLOTS] = 0;
  }

  /** A request ended without data (cancelled, rejected, timed out, peer gone); the block can be requested again. */
  public returnBlock(key: number): void {
    const piece = this.active.get(Math.floor(key / SLOTS));
    if (!piece) return;
    const b = key % SLOTS;
    if (piece.received[b] || !piece.requested[b]) return;
    piece.requested[b]!--;
    if (piece.requested[b] === 0) {
      piece.unrequested++;
      if (b < piece.cursor) piece.cursor = b;
      this.open.add(piece);
    }
  }

  /** A completed piece passed its hash check. Its buffer goes back to the pool once saved (`release`). */
  public pieceVerified(piece: PieceState): void {
    this.active.delete(piece.index);
    this.open.delete(piece);
    if (this.have.set(piece.index) && this.wanted.has(piece.index)) this.missing--;
  }

  /** A completed piece failed its hash check; it starts over. */
  public pieceFailed(piece: PieceState): void {
    this.active.delete(piece.index);
    this.open.delete(piece);
    this.release(piece.buf);
    if (this.wanted.has(piece.index)) this.insert(piece.index);
  }

  /** Marks a piece verified from disk (resume or re-check). */
  public markHave(i: number): void {
    if (!this.have.set(i)) return;
    if (this.wanted.has(i)) this.missing--;
    if ((this.pos[i] as number) >= 0) this.remove(i);
  }

  /** Forgets a verified piece so it is downloaded again (its bytes for a newly selected file were never written). */
  public forget(i: number): void {
    if (!this.have.clear(i) || !this.wanted.has(i)) return;
    this.missing++;
    if (!this.active.has(i) && this.pos[i] === -1) this.insert(i);
  }

  /** Sets every in-flight block's request count and streaming flag from the truth (keys to request counts, keys being streamed). */
  public reconcile(requested: Map<number, number>, streaming: Set<number>): void {
    for (const piece of this.active.values()) {
      piece.unrequested = 0;
      piece.cursor = 0;
      for (let b = 0; b < piece.blockCount; b++) {
        if (piece.received[b]) continue;
        const key = piece.index * SLOTS + b;
        piece.requested[b] = Math.min(requested.get(key) ?? 0, 255);
        piece.streaming[b] = streaming.has(key) ? 1 : 0;
        if (!piece.requested[b]) piece.unrequested++;
      }
      if (piece.unrequested > 0) this.open.add(piece);
      else this.open.delete(piece);
    }
  }

  /** Returns a piece buffer to the pool. */
  public release(buf: Uint8Array): void {
    if (buf.length === this.pieceLength && this.pool.length < 16) this.pool.push(buf);
  }

  /** Drops every in-flight piece, as when the torrent pauses. Data not yet verified is lost. */
  public reset(): void {
    for (const piece of this.active.values()) {
      this.release(piece.buf);
      if (this.wanted.has(piece.index)) this.insert(piece.index);
    }
    this.active.clear();
    this.open.clear();
  }

  private activate(i: number): PieceState {
    this.remove(i);
    const size = this.pieceSize(i);
    const buf = size === this.pieceLength ? (this.pool.pop() ?? new Uint8Array(size)) : new Uint8Array(size);
    const piece = new PieceState(i, size, buf);
    this.active.set(i, piece);
    return piece;
  }

  private bufferBytes(): number {
    return this.active.size * this.pieceLength;
  }

  private peerHas(peer: PickerPeer, i: number): boolean {
    return peer.seed || peer.bitfield.has(i);
  }

  // ---------- Bucketed array ---------- //

  /** Adds a fresh piece at the end of its availability bucket, shifting higher buckets right by one. */
  private insert(i: number): void {
    const a = this.availability[i] as number;
    while (this.start.length - 1 <= a) this.start.push(this.start[this.start.length - 1] as number);
    const top = this.start.length - 1;
    let hole = this.start[top] as number;
    this.start[top] = hole + 1;
    for (let k = top - 1; k > a; k--) {
      const s = this.start[k] as number;
      if (s !== hole) this.place(this.order[s] as number, hole);
      hole = s;
      this.start[k] = s + 1;
    }
    this.place(i, hole);
  }

  /** Removes a piece from the array, shifting higher buckets left by one. */
  private remove(i: number): void {
    const a = this.availability[i] as number;
    const top = this.start.length - 1;
    let hole = (this.start[a + 1] as number) - 1;
    this.swap(this.pos[i] as number, hole);
    for (let k = a + 1; k < top; k++) {
      const s = this.start[k] as number;
      const e = (this.start[k + 1] as number) - 1;
      if (e >= s) this.place(this.order[e] as number, hole);
      this.start[k] = s - 1;
      hole = e;
    }
    this.start[top]!--;
    this.pos[i] = -1;
  }

  private place(i: number, at: number): void {
    this.order[at] = i;
    this.pos[i] = at;
  }

  private swap(x: number, y: number): void {
    if (x === y) return;
    const a = this.order[x] as number;
    const b = this.order[y] as number;
    this.place(a, y);
    this.place(b, x);
  }
}
