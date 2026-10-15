/**
 * Piece hashing. A downloaded piece is hashed once, in one pass over its
 * buffer, with native SHA-1 (over 1 GB/s on an RK3588 core). Re-checking data
 * already on disk uses `crypto.subtle.digest`, which hashes on a worker
 * thread, with a few pieces in flight so disk reads and hashing overlap.
 */

import { createHash } from "node:crypto";
import { BLOCK, type PieceState } from "./picker";
import type { Storage } from "./storage";

/** Whether `data` matches piece `index`'s hash in the concatenated `hashes`. */
export function verifyPiece(hashes: Uint8Array, index: number, data: Uint8Array): boolean {
  const digest = createHash("sha1").update(data).digest();
  return digest.equals(hashes.subarray(index * 20, index * 20 + 20));
}

/** What a re-check needs to know about the torrent. */
export interface RecheckTarget {
  hashes: Uint8Array;
  storage: Storage;
  pieceSize(index: number): number;
}

/**
 * Hashes the given pieces from disk and calls `onValid` for each that
 * matches. Pieces with bytes outside the selected files are skipped: they
 * can't be read back whole. Stops early when `signal` aborts.
 */
export async function recheck(
  target: RecheckTarget,
  pieces: number[],
  onValid: (index: number) => void,
  signal?: AbortSignal,
  concurrency = 4,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < pieces.length && !signal?.aborted) {
      const index = pieces[next++] as number;
      const size = target.pieceSize(index);
      if (!target.storage.covers(index, size)) continue;
      const data = await target.storage.read(index, size, 0, size);
      if (!data) continue;
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", data as Uint8Array<ArrayBuffer>));
      if (Buffer.from(digest).equals(target.hashes.subarray(index * 20, index * 20 + 20))) onValid(index);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
}

/**
 * Finds the peer that corrupted a piece several peers contributed to
 * ("smart ban"). When such a piece fails, each block's sender and hash are
 * remembered; when the piece later verifies, the blocks that differ name the
 * liars. Honest peers that shared a bad piece are never blamed.
 */
export class SmartBan<Sender> {
  private readonly suspects = new Map<number, Array<{ sender: Sender | undefined; hash: Buffer }>>();

  /** A piece failed. Returns its sender when one peer sent all of it; otherwise remembers the blocks. */
  public failed(piece: PieceState): Sender | null {
    const senders = new Set(piece.senders);
    if (senders.size === 1) return (piece.senders[0] as Sender | undefined) ?? null;
    this.suspects.set(
      piece.index,
      piece.senders.map((sender, b) => ({ sender: sender as Sender | undefined, hash: blockHash(piece, b) })),
    );
    return null;
  }

  /** A piece verified. Returns the senders whose blocks differ from its failed attempt. */
  public verified(piece: PieceState): Sender[] {
    const blocks = this.suspects.get(piece.index);
    if (!blocks) return [];
    this.suspects.delete(piece.index);
    const liars = new Set<Sender>();
    blocks.forEach(({ sender, hash }, b) => {
      if (sender && !hash.equals(blockHash(piece, b))) liars.add(sender);
    });
    return [...liars];
  }
}

function blockHash(piece: PieceState, b: number): Buffer {
  return createHash("sha1").update(piece.buf.subarray(b * BLOCK, b * BLOCK + piece.blockLength(b))).digest();
}
