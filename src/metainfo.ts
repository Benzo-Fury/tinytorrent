/**
 * Torrent metadata: parsing `.torrent` files and the `info` dictionary, and
 * magnet links. Creating torrents is in `create.ts`.
 */

import { createHash } from "node:crypto";
import { type BDict, bytes, decode, decodeWithSpan, dict, text } from "./bencode";

/** One file in a torrent, positioned in the torrent's byte stream. */
export interface TorrentFile {
  /** Path inside the torrent, `/`-separated, with the torrent name as the first segment for multi-file torrents. */
  path: string;
  length: number;
  /** Offset of the file's first byte in the concatenated payload. */
  offset: number;
}

/** Everything the engine needs from a torrent's `info` dictionary. */
export interface Info {
  infoHash: Uint8Array;
  infoHashHex: string;
  name: string;
  pieceLength: number;
  /** Concatenated 20-byte SHA-1 hashes, one per piece. */
  pieces: Uint8Array;
  pieceCount: number;
  length: number;
  files: TorrentFile[];
  private: boolean;
  /** The raw bencoded `info` dictionary, served to peers fetching metadata. */
  raw: Uint8Array;
}

/** A parsed `.torrent` file: the info plus where to find peers. */
export interface Metainfo extends Info {
  /** Tracker URLs, tiers flattened in order. */
  announce: string[];
}

/** A parsed magnet link. */
export interface Magnet {
  infoHash: Uint8Array;
  infoHashHex: string;
  name?: string;
  announce: string[];
  /** `x.pe` peer addresses as `host:port`. */
  peers: string[];
  /** `so` (BEP 53): the file indexes to download, when the link names them. */
  select?: number[];
}

/** Thrown when a torrent or magnet link is malformed. */
export class MetainfoError extends Error {}

/** Parses a `.torrent` file. */
export function parseTorrent(buf: Uint8Array): Metainfo {
  let decoded: ReturnType<typeof decodeWithSpan>;
  try {
    decoded = decodeWithSpan(buf, "info");
  } catch (error) {
    throw new MetainfoError(`Not a torrent file: ${(error as Error).message}`);
  }
  const root = dict(decoded.value);
  if (!root || !decoded.span) throw new MetainfoError("Torrent has no info dictionary");
  const info = parseInfo(buf.subarray(decoded.span[0], decoded.span[1]));

  // Trackers: announce-list tiers in order, then the single announce
  const announce: string[] = [];
  const tiers = root["announce-list"];
  if (Array.isArray(tiers)) {
    for (const tier of tiers) if (Array.isArray(tier)) for (const url of tier) pushUnique(announce, text(url));
  }
  pushUnique(announce, text(root.announce));
  return { ...info, announce };
}

/** Parses a raw bencoded `info` dictionary, as fetched from peers for a magnet link. */
export function parseInfo(raw: Uint8Array): Info {
  let info: BDict | undefined;
  try {
    info = dict(decode(raw));
  } catch (error) {
    throw new MetainfoError(`Bad info dictionary: ${(error as Error).message}`);
  }
  if (!info) throw new MetainfoError("Info is not a dictionary");

  const name = text(info["name.utf-8"]) || text(info.name);
  const pieceLength = info["piece length"];
  const pieces = bytes(info.pieces);
  if (!name || typeof pieceLength !== "number" || pieceLength <= 0 || !pieces || pieces.length % 20 !== 0) {
    throw new MetainfoError("Info is missing name, piece length or pieces");
  }
  if (pieceLength > 64 * 1024 * 1024) throw new MetainfoError("Piece length over 64 MiB");

  // Single-file or multi-file layout
  const files: TorrentFile[] = [];
  let length = 0;
  if (Array.isArray(info.files)) {
    for (const entry of info.files) {
      const file = dict(entry);
      const size = file?.length;
      const segments = file && (Array.isArray(file["path.utf-8"]) ? file["path.utf-8"] : file.path);
      if (typeof size !== "number" || size < 0 || !Array.isArray(segments)) throw new MetainfoError("Bad file entry");
      const parts = segments.map((s) => safeSegment(text(s)));
      // Padding files (BEP 47) take up space but are never written
      if (file?.attr instanceof Uint8Array && new TextDecoder().decode(file.attr).includes("p")) {
        length += size;
        continue;
      }
      files.push({ path: [safeSegment(name), ...parts].join("/"), length: size, offset: length });
      length += size;
    }
  } else if (typeof info.length === "number" && info.length >= 0) {
    files.push({ path: safeSegment(name), length: info.length, offset: 0 });
    length = info.length;
  } else {
    throw new MetainfoError("Info has neither length nor files");
  }

  const pieceCount = pieces.length / 20;
  if (pieceCount !== Math.ceil(length / pieceLength)) throw new MetainfoError("Piece count does not match length");
  const infoHash = new Uint8Array(createHash("sha1").update(raw).digest());
  return {
    infoHash,
    infoHashHex: toHex(infoHash),
    name,
    pieceLength,
    pieces,
    pieceCount,
    length,
    files,
    private: info.private === 1,
    raw,
  };
}

/** Parses a `magnet:` link with a BitTorrent v1 info hash (hex or base32). */
export function parseMagnet(uri: string): Magnet {
  if (!uri.startsWith("magnet:?")) throw new MetainfoError("Not a magnet link");
  const params = new URLSearchParams(uri.slice(8));
  let infoHash: Uint8Array | undefined;
  for (const xt of params.getAll("xt")) {
    const match = /^urn:btih:([0-9a-fA-F]{40}|[A-Za-z2-7]{32})$/.exec(xt);
    if (match?.[1]) infoHash = match[1].length === 40 ? fromHex(match[1]) : fromBase32(match[1]);
  }
  if (!infoHash) throw new MetainfoError("Magnet link has no BitTorrent info hash");
  return {
    infoHash,
    infoHashHex: toHex(infoHash),
    name: params.get("dn") ?? undefined,
    announce: [...new Set(params.getAll("tr"))],
    peers: params.getAll("x.pe"),
    select: parseSelectOnly(params.get("so")),
  };
}

/** Parses BEP 53's `so=0,2,4-6` into file indexes. */
function parseSelectOnly(value: string | null): number[] | undefined {
  if (!value) return undefined;
  const out = new Set<number>();
  for (const part of value.split(",")) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!match) continue;
    const from = Number(match[1]);
    const to = Math.min(Number(match[2] ?? from), from + 100_000);
    for (let i = from; i <= to; i++) out.add(i);
  }
  return out.size ? [...out].sort((a, b) => a - b) : undefined;
}

// ---------- Helpers ---------- //

/** Rejects path segments that would escape the download directory. */
function safeSegment(segment: string): string {
  if (!segment || segment === "." || segment === ".." || /[/\\\0]/.test(segment)) {
    throw new MetainfoError(`Unsafe path segment "${segment}"`);
  }
  return segment;
}

function pushUnique(list: string[], value: string): void {
  if (value && !list.includes(value)) list.push(value);
}

/** Lower-case hex of a byte array. */
export function toHex(b: Uint8Array): string {
  return Buffer.from(b.buffer, b.byteOffset, b.length).toString("hex");
}

/** Bytes from a hex string. */
export function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, "hex"));
}

function fromBase32(s: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const out = new Uint8Array(20);
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const ch of s.toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out[index++] = (value >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  return out;
}
