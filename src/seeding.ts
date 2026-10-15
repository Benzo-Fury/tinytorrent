/**
 * Serving pieces, and when to stop. `PieceServer` answers block requests
 * from the read cache and, in seed mode, hashes each piece the first time
 * it is read, so data added as complete starts seeding at once instead of
 * after a full re-check. `SeedPolicy` decides when seeding is enough: a
 * ratio, a time, or never.
 */

import { Bitfield } from "./bitfield";
import { ReadCache } from "./cache";
import type { Info } from "./metainfo";
import type { Picker } from "./picker";
import type { Storage } from "./storage";
import { verifyPiece } from "./verifier";

/** When a torrent stops seeding. Limits of 0 mean none. */
export interface SeedLimits {
  /** Keep serving peers once complete. */
  enabled: boolean;
  /** Stop at this upload ratio (uploaded ÷ selected bytes). */
  ratio: number;
  /** Stop after seeding this many minutes (counted across restarts). */
  minutes: number;
}

/** A torrent's seeding override: on, off, or its own limits. */
export type SeedOverride = boolean | { ratio?: number; minutes?: number };

/** Engine defaults with a torrent's override applied. */
export function seedLimits(defaults: SeedLimits, override: SeedOverride | undefined): SeedLimits {
  if (override === undefined) return defaults;
  if (typeof override === "boolean") return { ...defaults, enabled: override };
  return { enabled: true, ratio: override.ratio ?? defaults.ratio, minutes: override.minutes ?? defaults.minutes };
}

/** Whether seeding has reached its limits. */
export function seedingDone(limits: SeedLimits, ratio: number, seedSeconds: number): boolean {
  return (limits.ratio > 0 && ratio >= limits.ratio) || (limits.minutes > 0 && seedSeconds >= limits.minutes * 60);
}

/** What the server reads from. */
export interface ServerTarget {
  info: Info;
  picker: Picker;
  storage: Storage;
}

export class PieceServer {
  public readonly cache: ReadCache;
  /** Seed mode: pieces trusted without a hash, checked the first time they are read. Null when none are left. */
  public unverified: Bitfield | null = null;
  private readonly verifying = new Map<number, Promise<boolean>>();

  constructor(
    private readonly target: ServerTarget,
    cacheBytes: number,
    /** A trusted piece failed its hash: the data on disk is not what the torrent says. */
    private readonly onBadPiece: (index: number) => void,
  ) {
    const { picker, storage } = target;
    this.cache = new ReadCache(cacheBytes, (index, offset, length, into) => storage.read(index, picker.pieceSize(index), offset, length, into));
  }

  /** Whether a request is for a piece we have, within its bounds. */
  public canServe(index: number, begin: number, length: number): boolean {
    const { picker } = this.target;
    return index < picker.pieceCount && picker.have.has(index) && length > 0 && length <= 128 * 1024 && begin + length <= picker.pieceSize(index);
  }

  /** A block: the bytes when cached, otherwise a promise of them (null when unreadable or bad). */
  public readBlock(index: number, begin: number, length: number): Uint8Array | Promise<Uint8Array | null> {
    const size = this.target.picker.pieceSize(index);
    if (!this.unverified?.has(index)) return this.cache.block(index, size, begin, length);
    return this.verify(index).then((ok) => (ok ? this.cache.block(index, size, begin, length) : null));
  }

  /** Hashes a seed-mode piece once; readers of the same piece share the result. */
  private verify(index: number): Promise<boolean> {
    let pending = this.verifying.get(index);
    if (pending) return pending;
    const { info, picker, storage } = this.target;
    pending = storage
      .read(index, picker.pieceSize(index), 0, picker.pieceSize(index))
      .catch(() => null)
      .then((data) => {
        this.verifying.delete(index);
        const unverified = this.unverified;
        if (!unverified?.has(index)) return !!data;
        if (data && verifyPiece(info.pieces, index, data)) {
          unverified.clear(index);
          if (unverified.count === 0) this.unverified = null;
          this.cache.put(index, data);
          return true;
        }
        this.onBadPiece(index);
        return false;
      });
    this.verifying.set(index, pending);
    return pending;
  }
}
