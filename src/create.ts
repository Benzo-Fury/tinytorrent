/**
 * Creating torrents. `createTorrentFromPath` hashes a file or a directory in
 * one streaming pass, reading ahead into one buffer while it hashes the
 * other, so memory stays at two read buffers whatever the size.
 * `createTorrent` builds one from bytes in memory, for tests and benchmarks.
 */

import { createHash, type Hash } from "node:crypto";
import { promises as fsp } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { type BInput, encode } from "./bencode";

/** What goes in a torrent besides its files. */
export interface TorrentOptions {
  /** The torrent's name; by default the file or directory name. */
  name?: string;
  /** Bytes per piece, a power of two from 16 KiB; by default chosen from the size (`pieceLengthFor`). */
  pieceLength?: number;
  /** Tracker URLs, each its own tier, or explicit tiers. */
  announce?: Array<string | string[]>;
  /** Private torrent (BEP 27): peers come from its trackers only. */
  private?: boolean;
  comment?: string;
  /** Default `tinytorrent`. */
  createdBy?: string;
  /** Seconds since the epoch; default now, `false` to leave it out (reproducible output). */
  creationDate?: number | false;
  /** Web seed URLs (BEP 19 `url-list`). */
  webSeeds?: string[];
}

/** Read-ahead size while hashing from disk. */
const READ_CHUNK = 1024 * 1024;

/**
 * A piece length for `total` bytes: the smallest power of two from 16 KiB
 * that keeps the torrent at 2,048 pieces or fewer, at most 16 MiB.
 */
export function pieceLengthFor(total: number): number {
  let length = 16 * 1024;
  while (length < 16 * 1024 * 1024 && total / length > 2048) length *= 2;
  return length;
}

/**
 * Creates a torrent from a file or a directory on disk. Directories are
 * walked in sorted order; only regular files are included (symbolic links
 * are skipped). `onProgress` hears bytes hashed so far.
 */
export async function createTorrentFromPath(
  path: string,
  options: TorrentOptions & { onProgress?: (hashed: number, total: number) => void; signal?: AbortSignal } = {},
): Promise<Uint8Array> {
  const root = (await fsp.stat(path)).isDirectory();
  const files = root ? await walk(path) : [{ path: "", absolute: path, length: (await fsp.stat(path)).size }];
  if (files.length === 0) throw new Error(`${path} has no files`);
  const total = files.reduce((n, f) => n + f.length, 0);
  const pieceLength = checkedPieceLength(options.pieceLength ?? pieceLengthFor(total));
  const hasher = new PieceHasher(pieceLength, total);

  let hashed = 0;
  for (const file of files) {
    const handle = await fsp.open(file.absolute, "r");
    try {
      // Two buffers: the next read runs while the current chunk is hashed
      const buffers = [new Uint8Array(READ_CHUNK), new Uint8Array(READ_CHUNK)];
      let position = 0;
      let turn = 0;
      let reading = handle.read(buffers[0] as Uint8Array, 0, READ_CHUNK, 0);
      while (position < file.length) {
        if (options.signal?.aborted) throw new Error("Torrent creation aborted");
        const { bytesRead } = await reading;
        if (bytesRead === 0) throw new Error(`${file.absolute} shrank while it was hashed`);
        const current = buffers[turn] as Uint8Array;
        position += bytesRead;
        turn ^= 1;
        if (position < file.length) reading = handle.read(buffers[turn] as Uint8Array, 0, Math.min(READ_CHUNK, file.length - position), position);
        hasher.update(current.subarray(0, Math.min(bytesRead, file.length - (position - bytesRead))));
        hashed += bytesRead;
        options.onProgress?.(hashed, total);
      }
    } finally {
      await handle.close();
    }
  }
  return build(
    options.name ?? basename(path),
    pieceLength,
    hasher.finish(),
    root ? files.map((f) => ({ path: f.path, length: f.length })) : null,
    total,
    options,
  );
}

/** Options for `createTorrent`. */
export interface CreateOptions extends TorrentOptions {
  name: string;
  /** Files in order, with paths relative to the torrent's root. One file with path `""` makes a single-file torrent. */
  files: Array<{ path: string; data: Uint8Array }>;
}

/** Builds a `.torrent` file from bytes in memory. Meant for tests and benchmark swarms, not large payloads. */
export function createTorrent(options: CreateOptions): Uint8Array {
  const total = options.files.reduce((sum, f) => sum + f.data.length, 0);
  const pieceLength = options.pieceLength ?? 256 * 1024;
  const hasher = new PieceHasher(pieceLength, total);
  for (const file of options.files) hasher.update(file.data);
  const single = options.files.length === 1 && options.files[0]?.path === "";
  const files = single ? null : options.files.map((f) => ({ path: f.path, length: f.data.length }));
  return build(options.name, pieceLength, hasher.finish(), files, total, { creationDate: false, ...options });
}

/** SHA-1 of each piece of a stream fed in arbitrary chunks. */
class PieceHasher {
  private readonly hashes: Uint8Array;
  private hash: Hash = createHash("sha1");
  private filled = 0;
  private piece = 0;

  constructor(
    private readonly pieceLength: number,
    total: number,
  ) {
    this.hashes = new Uint8Array(Math.ceil(total / pieceLength) * 20);
  }

  public update(data: Uint8Array): void {
    let offset = 0;
    while (offset < data.length) {
      const take = Math.min(this.pieceLength - this.filled, data.length - offset);
      this.hash.update(data.subarray(offset, offset + take));
      offset += take;
      this.filled += take;
      if (this.filled === this.pieceLength) this.next();
    }
  }

  public finish(): Uint8Array {
    if (this.filled > 0) this.next();
    return this.hashes;
  }

  private next(): void {
    this.hashes.set(this.hash.digest(), this.piece++ * 20);
    this.hash = createHash("sha1");
    this.filled = 0;
  }
}

function build(
  name: string,
  pieceLength: number,
  pieces: Uint8Array,
  files: Array<{ path: string; length: number }> | null,
  total: number,
  options: TorrentOptions,
): Uint8Array {
  const info: Record<string, BInput> = { name, "piece length": pieceLength, pieces };
  if (files) info.files = files.map((f) => ({ length: f.length, path: f.path.split("/") }));
  else info.length = total;
  if (options.private) info.private = 1;

  const tiers = (options.announce ?? []).map((t) => (Array.isArray(t) ? t : [t])).filter((t) => t.length > 0);
  const torrent: Record<string, BInput> = { info };
  if (tiers[0]?.[0]) torrent.announce = tiers[0][0];
  if (tiers.flat().length > 1) torrent["announce-list"] = tiers;
  if (options.comment) torrent.comment = options.comment;
  if (options.createdBy !== undefined || options.creationDate !== false) torrent["created by"] = options.createdBy ?? "tinytorrent";
  if (options.creationDate !== false) torrent["creation date"] = options.creationDate ?? Math.floor(Date.now() / 1000);
  if (options.webSeeds?.length) torrent["url-list"] = options.webSeeds;
  return encode(torrent);
}

function checkedPieceLength(length: number): number {
  if (length < 16 * 1024 || length > 64 * 1024 * 1024 || (length & (length - 1)) !== 0) {
    throw new Error(`Piece length ${length} is not a power of two from 16 KiB to 64 MiB`);
  }
  return length;
}

/** Regular files under `dir`, sorted by their torrent path. */
async function walk(dir: string): Promise<Array<{ path: string; absolute: string; length: number }>> {
  const out: Array<{ path: string; absolute: string; length: number }> = [];
  const visit = async (current: string): Promise<void> => {
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) out.push({ path: relative(dir, absolute).split(sep).join("/"), absolute, length: (await fsp.stat(absolute)).size });
    }
  };
  await visit(dir);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
