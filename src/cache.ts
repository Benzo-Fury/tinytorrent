/**
 * The upload read cache. Peers ask for 16 KiB blocks, usually in order
 * through a piece, and reading each with its own system call was the
 * seeding path's largest cost. Blocks are served from 512 KiB windows, read
 * once and kept in a small LRU shared by every peer of the torrent. Buffers
 * are never reused, so a block handed to a socket stays valid after its
 * window is evicted.
 */

import { unzeroed } from "./wire";

/** Bytes read per disk read. */
export const WINDOW = 512 * 1024;
/** Windows per piece in a cache key; pieces are at most 64 MiB. */
const PER_PIECE = 128;

/** Reads `length` bytes of piece `index` from `offset` (into `into` when given), or null if they are not on disk. */
export type PieceReader = (index: number, offset: number, length: number, into?: Uint8Array) => Promise<Uint8Array | null>;

export class ReadCache {
  private readonly windows = new Map<number, Uint8Array | Promise<Uint8Array | null>>();
  private bytes = 0;
  /**
   * Evicted windows this cache read itself, reused for the next reads:
   * allocating a fresh 512 KiB buffer per read made the kernel fault in and
   * zero new pages each time. Blocks are copied out as they are sent, so an
   * evicted window has no other users once pending callbacks have run.
   */
  private readonly spare: Uint8Array[] = [];
  private readonly own = new WeakSet<Uint8Array>();
  /** Disk reads and blocks served, for diagnostics. */
  public reads = 0;
  public hits = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly read: PieceReader,
  ) {}

  /**
   * A block of piece `index`: the bytes themselves when cached (no await
   * needed), otherwise a promise of them, or of null when they can't be read.
   */
  public block(index: number, pieceSize: number, begin: number, length: number): Uint8Array | Promise<Uint8Array | null> {
    const w = Math.floor(begin / WINDOW);
    // A block across two windows (an unusual request) is read on its own
    if (Math.floor((begin + length - 1) / WINDOW) !== w) {
      this.reads++;
      return this.read(index, begin, length);
    }
    const key = index * PER_PIECE + w;
    const offset = begin - w * WINDOW;
    const cached = this.windows.get(key);
    if (cached instanceof Uint8Array) {
      this.hits++;
      this.windows.delete(key); // most recently used goes last
      this.windows.set(key, cached);
      return cached.subarray(offset, offset + length);
    }
    const loading = cached ?? this.load(key, index, w * WINDOW, Math.min(WINDOW, pieceSize - w * WINDOW));
    return loading.then((data) => data?.subarray(offset, offset + length) ?? null);
  }

  /** Stores a whole piece already in memory (just verified), so its blocks need no read. */
  public put(index: number, data: Uint8Array): void {
    for (let w = 0; w * WINDOW < data.length; w++) {
      this.store(index * PER_PIECE + w, data.subarray(w * WINDOW, Math.min((w + 1) * WINDOW, data.length)));
    }
  }

  /** Forgets a piece (its data on disk changed or turned out bad). */
  public drop(index: number): void {
    for (let w = 0; w < PER_PIECE; w++) {
      const cached = this.windows.get(index * PER_PIECE + w);
      if (cached === undefined) continue;
      if (cached instanceof Uint8Array) this.bytes -= cached.length;
      this.windows.delete(index * PER_PIECE + w);
    }
  }

  /** Empties the cache. */
  public clear(): void {
    this.windows.clear();
    this.bytes = 0;
    this.spare.length = 0;
  }

  private load(key: number, index: number, offset: number, length: number): Promise<Uint8Array | null> {
    this.reads++;
    // Windows are as long as their piece allows; a spare is used only if it fits
    const into = ((this.spare.at(-1)?.length ?? 0) >= length ? (this.spare.pop() as Uint8Array) : unzeroed(length)).subarray(0, length);
    this.own.add(into);
    const loading = this.read(index, offset, length, into).then(
      (data) => {
        if (this.windows.get(key) !== loading) return data;
        this.windows.delete(key);
        if (data) this.store(key, data);
        return data;
      },
      () => {
        if (this.windows.get(key) === loading) this.windows.delete(key);
        return null;
      },
    );
    this.windows.set(key, loading);
    return loading;
  }

  private store(key: number, data: Uint8Array): void {
    const old = this.windows.get(key);
    if (old instanceof Uint8Array) this.bytes -= old.length;
    this.windows.delete(key);
    this.windows.set(key, data);
    this.bytes += data.length;
    // Evict least recently used windows; reads in flight stay
    for (const [k, v] of this.windows) {
      if (this.bytes <= this.maxBytes) break;
      if (!(v instanceof Uint8Array) || k === key) continue;
      this.windows.delete(k);
      this.bytes -= v.length;
      // Reused once callbacks still copying from it have run
      if (this.own.has(v) && this.spare.length < 4) setImmediate(() => this.spare.push(new Uint8Array(v.buffer)));
    }
  }
}
