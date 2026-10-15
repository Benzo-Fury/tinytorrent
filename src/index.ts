/**
 * Tiny Torrent: a tiny, fast BitTorrent engine to build clients and services on.
 *
 * The package's single entry point. Everything else is internal and may
 * change between versions.
 */

export { Bitfield } from "./bitfield";
export { BencodeError, decode, encode } from "./bencode";
export type { EncryptionPolicy } from "./connections";
export { Dht, type DhtOptions } from "./dht";
export { Engine, type EngineOptions, type EngineStats } from "./engine";
export { type CreateOptions, createTorrent, createTorrentFromPath, pieceLengthFor, type TorrentOptions } from "./create";
export {
  type Info,
  type Magnet,
  type Metainfo,
  MetainfoError,
  parseInfo,
  parseMagnet,
  parseTorrent,
  type TorrentFile,
} from "./metainfo";
export type { CloseReason } from "./peer";
export type { SeedLimits, SeedOverride } from "./seeding";
export {
  type AddOptions,
  type FileStatus,
  type PeerStats,
  Torrent,
  type TorrentLimits,
  type TorrentState,
  type TorrentStats,
} from "./torrent";
export { type BoundOptions, boundTransport, systemTransport, type Transport, TransportUnavailableError } from "./transport";
