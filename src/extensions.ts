/**
 * Extension protocol messages (BEP 10): the extended handshake, metadata
 * exchange for magnet links (BEP 9), and peer exchange (BEP 11).
 */

import { createHash } from "node:crypto";
import { type BDict, bytes, decodePrefix, dict, encode, text } from "./bencode";

/** Our extension ids. Peers address messages to us with these. */
export const EXT = { ut_metadata: 1, ut_pex: 2 } as const;
const METADATA_PIECE = 16 * 1024;
/** Largest metadata accepted from peers. */
const MAX_METADATA = 32 * 1024 * 1024;

/** Our extended handshake payload. `uploadOnly` tells peers we want nothing from them (BEP 21). */
export function extHandshake(options: { metadataSize?: number; port?: number; reqq: number; client: string; uploadOnly?: boolean }): Uint8Array {
  return encode({
    m: { ut_metadata: EXT.ut_metadata, ut_pex: EXT.ut_pex },
    v: options.client,
    reqq: options.reqq,
    metadata_size: options.metadataSize,
    p: options.port || undefined,
    upload_only: options.uploadOnly ? 1 : undefined,
  });
}

/** What a peer's extended handshake told us. */
export interface PeerExtensions {
  ids: Record<string, number>;
  metadataSize: number;
  reqq?: number;
  port?: number;
  client: string;
  uploadOnly: boolean;
}

/** Parses a peer's extended handshake. */
export function parseExtHandshake(payload: Uint8Array): PeerExtensions | null {
  const root = dict(decodePrefix(payload).value);
  if (!root) return null;
  const ids: Record<string, number> = {};
  const m = dict(root.m);
  if (m) for (const [name, id] of Object.entries(m)) if (typeof id === "number" && id > 0 && id < 256) ids[name] = id;
  const size = root.metadata_size;
  return {
    ids,
    metadataSize: typeof size === "number" && size > 0 && size <= MAX_METADATA ? size : 0,
    reqq: typeof root.reqq === "number" && root.reqq > 0 ? Math.min(root.reqq, 2000) : undefined,
    port: typeof root.p === "number" && root.p > 0 && root.p < 65536 ? root.p : undefined,
    client: text(root.v),
    uploadOnly: root.upload_only === 1,
  };
}

// ---------- Metadata (BEP 9) ---------- //

/** A parsed `ut_metadata` message. */
export interface MetadataMessage {
  type: number;
  piece: number;
  totalSize?: number;
  data?: Uint8Array;
}

export function parseMetadataMessage(payload: Uint8Array): MetadataMessage | null {
  const { value, end } = decodePrefix(payload);
  const root = dict(value);
  if (!root || typeof root.msg_type !== "number" || typeof root.piece !== "number") return null;
  return {
    type: root.msg_type,
    piece: root.piece,
    totalSize: typeof root.total_size === "number" ? root.total_size : undefined,
    data: root.msg_type === 1 ? payload.subarray(end) : undefined,
  };
}

export function metadataRequest(piece: number): Uint8Array {
  return encode({ msg_type: 0, piece });
}

/** The answer to a metadata request: the piece if we have the metadata, a reject otherwise. */
export function metadataReply(raw: Uint8Array | undefined, piece: number): Uint8Array {
  if (!raw || piece * METADATA_PIECE >= raw.length) return encode({ msg_type: 2, piece });
  const chunk = raw.subarray(piece * METADATA_PIECE, (piece + 1) * METADATA_PIECE);
  const head = encode({ msg_type: 1, piece, total_size: raw.length });
  const out = new Uint8Array(head.length + chunk.length);
  out.set(head);
  out.set(chunk, head.length);
  return out;
}

/** Assembles metadata from pieces sent by any peer, and checks it against the info hash. */
export class MetadataFetcher {
  private size = 0;
  private buf: Uint8Array | null = null;
  private got: Uint8Array | null = null;
  /** Piece index → when it was last requested. */
  private readonly asked = new Map<number, number>();

  constructor(private readonly infoHash: Uint8Array) {}

  /** The next piece to ask a peer for, or -1. Pieces asked over 5 s ago are asked again. */
  public next(peerSize: number, now: number): number {
    if (!peerSize) return -1;
    if (!this.buf) {
      this.size = peerSize;
      this.buf = new Uint8Array(peerSize);
      this.got = new Uint8Array(Math.ceil(peerSize / METADATA_PIECE));
    }
    if (peerSize !== this.size) return -1;
    const got = this.got as Uint8Array;
    for (let i = 0; i < got.length; i++) {
      if (got[i]) continue;
      const at = this.asked.get(i);
      if (at === undefined || now - at > 5000) {
        this.asked.set(i, now);
        return i;
      }
    }
    return -1;
  }

  /**
   * Stores a piece. Returns the full metadata once every piece is in and it
   * hashes to the info hash; resets if it doesn't (a peer lied).
   */
  public receive(piece: number, data: Uint8Array): Uint8Array | null {
    if (!this.buf || !this.got || piece >= this.got.length || this.got[piece]) return null;
    const expected = Math.min(METADATA_PIECE, this.size - piece * METADATA_PIECE);
    if (data.length !== expected) return null;
    this.buf.set(data, piece * METADATA_PIECE);
    this.got[piece] = 1;
    if (this.got.some((g) => !g)) return null;
    const digest = createHash("sha1").update(this.buf).digest();
    if (digest.equals(this.infoHash)) return this.buf;
    this.got.fill(0);
    this.asked.clear();
    return null;
  }
}

// ---------- Peer exchange (BEP 11) ---------- //

/** Peers in a `ut_pex` message, as `host:port`; with `noSeeds`, those flagged as seeds (0x02) are left out. */
export function parsePex(payload: Uint8Array, noSeeds = false): string[] {
  const root: BDict | undefined = dict(decodePrefix(payload).value);
  if (!root) return [];
  const pick = (peers: string[], flags: Uint8Array | undefined): string[] => (noSeeds && flags ? peers.filter((_, i) => !((flags[i] ?? 0) & 0x02)) : peers);
  return [...pick(compactPeers(bytes(root.added)), bytes(root["added.f"])), ...pick(compactPeers6(bytes(root.added6)), bytes(root["added6.f"]))];
}

/** A `ut_pex` message announcing `added` and `dropped` peers, IPv4 and IPv6, with `seeds` flagged (0x02). */
export function pexMessage(added: string[], dropped: string[], seeds = new Set<string>()): Uint8Array {
  // At most 50 of each family; flags follow the same order as the compact entries
  const v4 = added.filter((a) => IPV4_PEER.test(a)).slice(0, 50);
  const v6 = added.filter((a) => expand6(IPV6_PEER.exec(a)?.[1] ?? "")).slice(0, 50);
  const flags = (peers: string[]): Uint8Array => Uint8Array.from(peers, (a) => (seeds.has(a) ? 0x02 : 0));
  return encode({
    added: toCompact(v4),
    "added.f": flags(v4),
    added6: v6.length ? toCompact6(v6) : undefined,
    "added6.f": v6.length ? flags(v6) : undefined,
    dropped: toCompact(dropped),
    dropped6: toCompact6(dropped).length ? toCompact6(dropped) : undefined,
  });
}

/** Decodes 6-byte compact IPv4 peers. */
export function compactPeers(buf: Uint8Array | undefined): string[] {
  const out: string[] = [];
  if (!buf) return out;
  for (let o = 0; o + 6 <= buf.length; o += 6) {
    const port = ((buf[o + 4] as number) << 8) | (buf[o + 5] as number);
    if (port) out.push(`${buf[o]}.${buf[o + 1]}.${buf[o + 2]}.${buf[o + 3]}:${port}`);
  }
  return out;
}

/** Decodes 18-byte compact IPv6 peers. */
export function compactPeers6(buf: Uint8Array | undefined): string[] {
  const out: string[] = [];
  if (!buf) return out;
  for (let o = 0; o + 18 <= buf.length; o += 18) {
    const port = ((buf[o + 16] as number) << 8) | (buf[o + 17] as number);
    if (port) out.push(`[${format6(buf, o)}]:${port}`);
  }
  return out;
}

/** The 16-byte IPv6 address at `o`, in its usual compressed form (as sockets report it). */
export function format6(buf: Uint8Array, o: number): string {
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((buf[o + i] as number) << 8) | (buf[o + i + 1] as number));
  // The longest run of two or more zero groups becomes "::"
  let best = -1;
  let bestLength = 1;
  for (let i = 0; i < 8; ) {
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLength) [best, bestLength] = [i, j - i];
    i = j > i ? j : i + 1;
  }
  const hex = groups.map((g) => g.toString(16));
  if (best < 0) return hex.join(":");
  return `${hex.slice(0, best).join(":")}::${hex.slice(best + bestLength).join(":")}`;
}

const IPV4_PEER = /^(\d+)\.(\d+)\.(\d+)\.(\d+):(\d+)$/;
const IPV6_PEER = /^\[([0-9a-fA-F:]+)\]:(\d+)$/;

/** Encodes IPv4 `host:port` strings as compact peers; others are skipped. Capped at 50, per BEP 11. */
export function toCompact(peers: string[]): Uint8Array {
  const out: number[] = [];
  for (const peer of peers.slice(0, 50)) {
    const match = IPV4_PEER.exec(peer);
    if (!match) continue;
    const port = Number(match[5]);
    out.push(Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4]), port >> 8, port & 0xff);
  }
  return Uint8Array.from(out);
}

/** Encodes `[v6]:port` strings as 18-byte compact peers; others are skipped. Capped at 50. */
export function toCompact6(peers: string[]): Uint8Array {
  const out: number[] = [];
  for (const peer of peers.slice(0, 50)) {
    const match = IPV6_PEER.exec(peer);
    const groups = match && expand6(match[1] as string);
    if (!groups) continue;
    for (const g of groups) out.push(g >> 8, g & 0xff);
    const port = Number(match[2]);
    out.push(port >> 8, port & 0xff);
  }
  return Uint8Array.from(out);
}

/** The eight 16-bit groups of an IPv6 address, or null if it isn't one. */
export function expand6(address: string): number[] | null {
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? (halves[0] as string).split(":") : [];
  const tail = halves.length === 2 && halves[1] ? (halves[1] as string).split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const parts = [...head, ...Array<string>(Math.max(fill, 0)).fill("0"), ...tail];
  if (parts.length !== 8 || fill < 0 || !parts.every((p) => /^[0-9a-fA-F]{1,4}$/.test(p))) return null;
  return parts.map((p) => Number.parseInt(p, 16));
}
