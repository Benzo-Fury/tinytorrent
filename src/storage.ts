/**
 * Writes verified pieces straight into the torrent's files with positional
 * I/O, and reads them back for uploads and re-checks. There is no chunk store:
 * a piece is one `write` per file it touches, at the right offset, into a
 * sparse file. Only selected files are created; the bytes of a boundary piece
 * that fall in an unselected file are not written.
 */

import { constants, promises as fsp, type Stats } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import type { TorrentFile } from "./metainfo";
import { unzeroed } from "./wire";

/** One file-sized slice of a piece. */
interface Segment {
  file: number;
  /** Offset within the file. */
  fileOffset: number;
  /** Offset within the piece. */
  pieceOffset: number;
  length: number;
}

/** How many files may be open at once. */
const MAX_OPEN = 64;

export class Storage {
  /** Indexes of files being downloaded. */
  private readonly selected = new Set<number>();
  private readonly handles = new Map<number, Promise<fsp.FileHandle>>();
  private readonly paths: string[];

  constructor(
    public readonly dir: string,
    public readonly files: TorrentFile[],
    public readonly pieceLength: number,
  ) {
    const root = resolve(dir);
    this.paths = files.map((f) => {
      const path = resolve(root, ...f.path.split("/"));
      if (!path.startsWith(root + sep)) throw new Error(`File ${f.path} escapes ${dir}`);
      return path;
    });
  }

  /** Absolute path of file `i`. */
  public path(i: number): string {
    return this.paths[i] as string;
  }

  /** Sets which files are written. */
  public select(indexes: Iterable<number>): void {
    this.selected.clear();
    for (const i of indexes) this.selected.add(i);
  }

  public isSelected(i: number): boolean {
    return this.selected.has(i);
  }

  /** The file slices piece `index` covers. */
  public segments(index: number, pieceSize: number): Segment[] {
    const start = index * this.pieceLength;
    const end = start + pieceSize;
    const out: Segment[] = [];
    // Binary search for the first file that ends after `start`
    let lo = 0;
    let hi = this.files.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const f = this.files[mid] as TorrentFile;
      if (f.offset + f.length <= start) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < this.files.length; i++) {
      const f = this.files[i] as TorrentFile;
      if (f.offset >= end) break;
      const from = Math.max(start, f.offset);
      const to = Math.min(end, f.offset + f.length);
      if (to > from) out.push({ file: i, fileOffset: from - f.offset, pieceOffset: from - start, length: to - from });
    }
    return out;
  }

  /**
   * Whether the piece can be read back whole: every file it touches is
   * selected. Bytes in no file are padding (BEP 47), which reads as zeros.
   */
  public covers(index: number, pieceSize: number): boolean {
    return this.segments(index, pieceSize).every((s) => this.selected.has(s.file));
  }

  /** Writes a verified piece to the selected files it touches. */
  public async write(index: number, data: Uint8Array): Promise<void> {
    const writes: Promise<unknown>[] = [];
    for (const s of this.segments(index, data.length)) {
      if (!this.selected.has(s.file)) continue;
      const handle = await this.open(s.file);
      writes.push(writeFully(handle, data.subarray(s.pieceOffset, s.pieceOffset + s.length), s.fileOffset));
    }
    await Promise.all(writes);
  }

  /** Reads `length` bytes of piece `index` from `offset`, or null if part of it is not on disk. Padding reads as zeros. */
  public async read(index: number, pieceSize: number, offset: number, length: number, into?: Uint8Array): Promise<Uint8Array | null> {
    // Not zero-filled: every byte is read, and only the gaps (padding) are zeroed
    const out = into ?? unzeroed(length);
    let filled = 0;
    for (const s of this.segments(index, pieceSize)) {
      const from = Math.max(offset, s.pieceOffset);
      const to = Math.min(offset + length, s.pieceOffset + s.length);
      if (to <= from) continue;
      if (!this.selected.has(s.file)) return null;
      const handle = await this.open(s.file).catch(() => null);
      if (!handle) return null;
      out.fill(0, filled, from - offset);
      const { bytesRead } = await handle.read(out, from - offset, to - from, s.fileOffset + (from - s.pieceOffset));
      if (bytesRead !== to - from) return null;
      filled = to - offset;
    }
    out.fill(0, filled, length);
    return out;
  }

  /** Creates the selected empty files, which no piece ever writes. */
  public async createEmpty(): Promise<void> {
    for (const i of this.selected) {
      if ((this.files[i] as TorrentFile).length > 0) continue;
      await fsp.mkdir(dirname(this.path(i)), { recursive: true });
      await (await fsp.open(this.path(i), "a")).close();
    }
  }

  /** Size and modification time of each selected file, or null for missing ones. */
  public async stat(): Promise<Array<{ size: number; mtimeMs: number } | null>> {
    return Promise.all(
      this.files.map(async (_, i) => {
        if (!this.selected.has(i)) return null;
        const s: Stats | null = await fsp.stat(this.path(i)).catch(() => null);
        return s ? { size: s.size, mtimeMs: Math.floor(s.mtimeMs) } : null;
      }),
    );
  }

  /** Closes every open file. */
  public async close(): Promise<void> {
    const handles = [...this.handles.values()];
    this.handles.clear();
    await Promise.all(handles.map((h) => h.then((fh) => fh.close()).catch(() => undefined)));
  }

  /** Opens file `i` for reading and writing, creating it, through the LRU cache. */
  private open(i: number): Promise<fsp.FileHandle> {
    const cached = this.handles.get(i);
    if (cached) {
      // Refresh its place in the LRU order
      this.handles.delete(i);
      this.handles.set(i, cached);
      return cached;
    }
    const opening = this.openFile(i);
    this.handles.set(i, opening);
    opening.catch(() => this.handles.delete(i));
    if (this.handles.size > MAX_OPEN) {
      const [oldest, handle] = this.handles.entries().next().value as [number, Promise<fsp.FileHandle>];
      this.handles.delete(oldest);
      // Close after in-flight operations on it settle
      setTimeout(() => handle.then((fh) => fh.close()).catch(() => undefined), 5000);
    }
    return opening;
  }

  private async openFile(i: number): Promise<fsp.FileHandle> {
    const path = this.path(i);
    await fsp.mkdir(dirname(path), { recursive: true });
    const handle = await fsp.open(path, constants.O_RDWR | constants.O_CREAT, 0o644);
    // Full length up front, sparse: resume checks compare sizes
    const length = (this.files[i] as TorrentFile).length;
    if ((await handle.stat()).size < length) await handle.truncate(length);
    return handle;
  }
}

async function writeFully(handle: fsp.FileHandle, data: Uint8Array, position: number): Promise<void> {
  let written = 0;
  while (written < data.length) {
    const { bytesWritten } = await handle.write(data, written, data.length - written, position + written);
    if (bytesWritten <= 0) throw new Error("Short write");
    written += bytesWritten;
  }
}
