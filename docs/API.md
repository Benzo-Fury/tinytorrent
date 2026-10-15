# API reference

> The full reference. The [README](../README.md)'s recipes cover normal use; this page lists every export, option, default, method, event and type exactly.

```ts
import {
  Engine, Torrent,
  boundTransport, systemTransport, TransportUnavailableError,
  createTorrentFromPath, createTorrent, pieceLengthFor,
  parseTorrent, parseInfo, parseMagnet, MetainfoError,
  encode, decode, BencodeError, Bitfield, Dht,
} from "tinytorrent";
```

`src/index.ts` is the only entry point; anything not exported there is internal.

**On this page:** [Engine](#engine) · [Engine options](#engine-options) · [Add options](#add-options) · [Torrent](#torrent) · [States](#states) · [Events](#events) · [Stats types](#stats-types) · [Creating torrents](#creating-torrents) · [Parsing](#parsing) · [Transports](#transports) · [Low-level exports](#low-level-exports) · [Units and conventions](#units-and-conventions)

---

## Engine

```ts
const engine = new Engine(options?: EngineOptions);
```

Use one engine per process. It starts its listener and DHT lazily, on the first `add`.

| Method | Returns | Description |
|---|---|---|
| `add(input, options)` | `Torrent` | `input` is `.torrent` bytes (`Uint8Array`), a magnet URI, or a parsed `Metainfo`/`Magnet`. Adding an info hash that is already present returns the existing torrent and ignores the new options. Throws `MetainfoError` on malformed input. |
| `get(infoHashHex)` | `Torrent \| undefined` | Hex info hash, any case. |
| `list()` | `Torrent[]` | Every torrent that isn't closed. |
| `ready()` | `Promise<void>` | Starts the network if needed and resolves once the listener and DHT are up. Port mapping carries on in the background (`portMapping` event). |
| `port()` | `number` | Local listening port (`0` before `ready`). |
| `announcePort()` | `number` | Port given to trackers, the DHT and peers: the external port when port mapping succeeded, otherwise `port()`. |
| `stats()` | [`EngineStats`](#enginestats) | Totals across every torrent. |
| `setLimits({ uploadBytesPerSecond?, downloadBytesPerSecond? })` | `void` | Changes the engine-wide limits; `0` means unlimited, and a field left out is unchanged. |
| `disconnect()` | `Promise<void>` | The killswitch: pauses every torrent (each tells its trackers `stopped` while the network still allows), closes the listener, DHT and every socket. Files and resume state are kept. |
| `reconnect()` | `Promise<void>` | Reopens the network and resumes every torrent, including any you paused yourself. Pause those again afterwards if they should stay paused. |
| `destroy()` | `Promise<void>` | Closes every torrent (files kept), removes port mappings and closes the network. The engine can't be used afterwards. |
| `dhtNodes()` | `Uint8Array \| undefined` | IPv4 DHT nodes in compact form (26 bytes each), to save and pass back as `dht.nodes`. |
| `dhtNodes6()` | `Uint8Array \| undefined` | IPv6 DHT nodes (38 bytes each), for `dht.nodes6`. |

| Event | Payload | |
|---|---|---|
| `warning` | `string` | Listener, DHT or port-mapping problems. Not fatal. |
| `portMapping` | `Mapping[]` | Mappings were made or changed: `{ protocol: "tcp" \| "udp", internal, external, method: "natpmp" \| "upnp" }`. |

## Engine options

`EngineOptions`: every field is optional.

### Network

| Option | Type | Default | Description |
|---|---|---|---|
| `port` | `number` | `0` | TCP port for incoming peers; the DHT tries the same UDP port. `0` lets the system choose. |
| `listen` | `boolean` | `true` | Accept incoming peers. The listener is dual-stack (IPv4 and IPv6) unless the transport is bound to one address. |
| `transport` | `Transport` | `systemTransport()` | Opens every TCP, UDP and HTTP socket. See [Transports](#transports). |
| `encryption` | `"prefer" \| "prefer-plaintext" \| "require" \| "off"` | `"prefer"` | MSE/PE policy (table below). |
| `portMapping` | `boolean \| PortMappingOptions` | off | Maps the listening and DHT ports with NAT-PMP, then UPnP IGD. |
| `dht` | `boolean \| { nodes?, nodes6?, bootstrap? }` | `true` | `nodes`/`nodes6` come from `dhtNodes()`/`dhtNodes6()`. `bootstrap` takes `host:port` routers and replaces the defaults. An IPv6 node runs beside the IPv4 one unless the transport is bound to an IPv4 address. |
| `pex` | `boolean` | `true` | Peer exchange. Never used on private torrents. |
| `allowPeer` | `(host: string) => boolean` | allow all | Called with the IP address of every peer before it is dialled and when it connects in. Return `false` to refuse it. |
| `maxPeersPerTorrent` | `number` | `200` | Connected peers per torrent. |
| `maxHalfOpen` | `number` | `30` | Outgoing connection attempts in progress, across the engine. |
| `peerId` | `Uint8Array` (20 bytes) | random `-TT0100-…` | |

| `encryption` | Outgoing | Incoming |
|---|---|---|
| `prefer` | Encrypted; retried as plaintext if the peer hangs up during the handshake | Both |
| `prefer-plaintext` | Plaintext; retried encrypted if the peer hangs up | Both |
| `require` | Encrypted | Encrypted only |
| `off` | Plaintext | Plaintext only |

`PortMappingOptions` (all optional):

| Option | Default | Description |
|---|---|---|
| `methods` | `["natpmp", "upnp"]` | Which methods to try, in order. |
| `gateway` | default route's gateway; with a bound transport, the bound address's `.1` | NAT-PMP gateway. |
| `natPmpPort` | `5351` | |
| `upnpLocation` | discovered by SSDP | The IGD description URL; skips discovery. |
| `ssdpAddress` | `239.255.255.250:1900` | |

Mappings ask for a one-hour lease and are renewed at half of it. If the gateway accepts only permanent leases (UPnP error 725), a permanent lease is used instead. Mappings are removed on `destroy()`.

### Transfer

| Option | Type | Default | Description |
|---|---|---|---|
| `upload.slots` | `number` | `4` | Peers unchoked at once per torrent. While seeding this is the minimum, and more slots open while peers keep up ([how](HOW-IT-WORKS.md#choking)). `0` never uploads to anyone. |
| `upload.limitBytesPerSecond` | `number` | `0` | Engine-wide upload cap; `0` is unlimited. |
| `download.limitBytesPerSecond` | `number` | `0` | Engine-wide download cap; `0` is unlimited. |
| `seed` | `{ enabled?, ratio?, minutes? }` | off | Keep serving once a torrent is complete, until `ratio` (uploaded ÷ selected bytes, all time) or `minutes` of seeding (all time) is reached, whichever comes first. A limit left out or set to `0` means none. |
| `resumeDir` | `string` | none | Directory for resume state, one file per torrent. See [Resume state](HOW-IT-WORKS.md#resume-state). |

### Memory

| Option | Type | Default | Description |
|---|---|---|---|
| `maxBufferBytes` | `number` | 512 MiB | Memory for pieces being downloaded, per torrent. Once it is reached, only pieces already started are requested. |
| `uploadCacheBytes` | `number` | 32 MiB | Upload read cache per torrent: 512 KiB windows, least recently used evicted first. |

## Add options

`AddOptions` for `engine.add(input, options)`:

| Option | Type | Default | Description |
|---|---|---|---|
| `dir` | `string` | **required** | Save directory. Single-file torrents are saved as `dir/<name>`, multi-file torrents as `dir/<name>/<path>`. |
| `start` | `"all" \| "metadata-only"` | `"all"` | `metadata-only` stops in `waiting` once the file list is known, and requests no block until `select()`. |
| `files` | `number[]` | every file | File indexes to download. Setting it means downloading starts right away. Without it, a magnet's `so=` list (BEP 53) is used if there is one. |
| `trackers` | `string[]` | none | Added to the torrent's or magnet's own trackers. |
| `peers` | `string[]` | none | `host:port` or `[v6]:port` addresses to dial. A magnet's `x.pe` peers are dialled too. |
| `paused` | `boolean` | `false` | Starts in `paused`: nothing connects, not even to fetch metadata, until `resume()`. |
| `seed` | `boolean \| { ratio?, minutes? }` | engine's `seed` | `true`/`false` switches seeding on or off for this torrent. An object switches it on with these limits, falling back to the engine's limits for any field left out. |
| `seedMode` | `boolean` | `false` | The files are complete: start serving straight away and hash each piece the first time it's uploaded. Needs every selected file at its full length; otherwise it falls back to a normal check. Resume state that matches is used instead. A piece that fails its hash ends seed mode with a full re-check. |
| `limits` | `{ uploadBytesPerSecond?, downloadBytesPerSecond? }` | none | Applied on top of the engine's limits; a byte must pass both. |

## Torrent

`Torrent` is an `EventEmitter`, created by `engine.add`.

### Properties

| Property | Type | Description |
|---|---|---|
| `infoHash`, `infoHashHex` | `Uint8Array`, `string` | |
| `name` | `string` | From the metadata, or the magnet's `dn` until then. |
| `info` | `Info \| null` | Parsed metadata; `null` until `metadata`. |
| `state` | `TorrentState` | See [States](#states). |
| `progress` | `number` | 0–1, verified bytes of the selected files. |
| `downloadRate`, `uploadRate` | `number` | Bytes per second, averaged over about a second. |
| `downloaded`, `uploaded` | `number` | Payload bytes this session. |
| `totalDownloaded`, `totalUploaded` | `number` | All time; earlier sessions come from resume state. |
| `ratio` | `number` | `totalUploaded` ÷ selected bytes. |
| `seedSeconds` | `number` | Time spent seeding, all time. |
| `wasted` | `number` | Bytes received and thrown away (duplicates in endgame, data for pieces already done, failed pieces). |
| `hashFailures` | `number` | Pieces that failed verification. |
| `peers` | `Set<Peer>` | Live connections. Use `stats().peers` for a stable view. |

### Methods

| Method | Returns | Description |
|---|---|---|
| `files()` | `FileStatus[]` | `{ index, path, length, selected, downloaded }`. Paths are absolute, under `dir`. Empty before metadata. |
| `select(indexes)` | `Promise<void>` | Throws before metadata. Sets the selection and starts requesting. Data already on disk is reused: it is trusted when resume state matches (or in seed mode), and hashed otherwise. Files never selected are never created. Can be called again to change the selection. |
| `recheck()` | `Promise<void>` | Hashes every selected piece on disk again, then downloads whatever is missing. Peers mid-block are disconnected first; nothing is served while it runs. Emits `checked`. |
| `pause()` | `Promise<void>` | Disconnects every peer, tells trackers `stopped`, and saves resume state. Pieces partly received are dropped. |
| `resume()` | `void` | Reconnects after `pause()` or `paused: true`; trackers get a new `started`. A complete torrent goes back to `seeding` (if its limits allow) or `done`. |
| `setLimits(limits)` | `void` | This torrent's `{ uploadBytesPerSecond?, downloadBytesPerSecond? }`; `0` is unlimited. |
| `seedLimits()` | `SeedLimits` | `{ enabled, ratio, minutes }`: the engine's policy with this torrent's override applied. |
| `addPeer(address)` | `void` | Dials `host:port` (or `[v6]:port`). |
| `close({ deleteFiles? })` | `Promise<void>` | Pauses, then removes the torrent from the engine. `deleteFiles: true` also deletes its files and resume state. |
| `stats()` | [`TorrentStats`](#torrentstats) | Snapshot for diagnostics. |

## States

`TorrentState`:

| State | Meaning | Peers connected |
|---|---|---|
| `metadata` | Magnet: fetching the `info` dictionary from peers | yes |
| `waiting` | Metadata known; `start: "metadata-only"` and `select()` not called yet | yes, but no requests |
| `checking` | Verifying data already on disk | yes, but no requests |
| `downloading` | Fetching pieces | yes |
| `seeding` | Complete and serving, until a seed limit | yes |
| `done` | Complete and not seeding (or the limits were reached). Incoming peers are refused | no |
| `paused` | `pause()`, `disconnect()`, `paused: true`, or after an `error` | no |
| `closed` | `close()` | no |

Usual order: `metadata` → `waiting` → `checking` → `downloading` → `seeding` → `done`. A torrent added from a `.torrent` file skips `metadata`; without `metadata-only` it skips `waiting`; with seeding off it goes straight from `downloading` to `done`. Data that is already complete goes from `checking` (or seed mode) straight to `seeding`/`done`.

## Events

| Event | Payload | When |
|---|---|---|
| `metadata` | `Info` | The file list is known (straight away for `.torrent` input). |
| `ready` | — | The selection has been checked against the disk and requests may start. |
| `piece` | `number` | A piece was verified and written. |
| `done` | — | Every selected byte is verified on disk. Emitted once per completion, including for data that was already complete. |
| `seeded` | — | A seed limit was reached; the torrent is now `done`, disconnected, and has told trackers `stopped`. |
| `checked` | `number` | `recheck()` finished; the payload is the number of verified pieces. |
| `warning` | `string` | Not fatal: a piece failed its hash (naming the senders' addresses and clients), resume state couldn't be saved, seed mode found a bad piece. |
| `error` | `Error` | Something the torrent can't continue past, such as a disk write failing. The torrent pauses; `resume()` tries again. |
| `close` | — | After `close()`. |

## Stats types

### `EngineStats`

| Field | Description |
|---|---|
| `torrents`, `peers` | Counts across the engine. |
| `downloadRate`, `uploadRate` | Bytes/s, summed. |
| `downloaded`, `uploaded` | This session, summed. |
| `port`, `announcePort` | Local port and the port announced. |
| `dhtNodes` | Nodes in the routing tables. |
| `mappings` | `Mapping[]` currently in place. |

### `TorrentStats`

| Field | Description |
|---|---|
| `state`, `progress`, `downloadRate`, `uploadRate`, `downloaded`, `uploaded`, `wasted`, `hashFailures` | As on `Torrent`. |
| `totalDownloaded`, `totalUploaded`, `ratio`, `seedSeconds` | All-time figures. |
| `peers` | `PeerStats[]` (below). |
| `connecting` | Dials in progress. |
| `candidates` | Known addresses not yet connected. |
| `activePieces` | Pieces in flight. |
| `endgame` | `true` in the last pieces, when blocks are requested from two peers. |
| `closeReasons` | `Record<CloseReason, number>`: why connections ended (table below). |
| `trackers` | `TrackerState[]` (below). |
| `slots` | `{ unchoked, target }`: upload slots in use, and how many the choker wants. |
| `cache` | `{ reads, hits }`: upload disk reads, and blocks served from memory. |
| `unverified` | Seed mode: pieces not yet hashed. |

`PeerStats`:

| Field | Description |
|---|---|
| `address` | `host:port`, with brackets for IPv6. |
| `client` | From the extended handshake, or decoded from the peer id. |
| `source` | `"tracker" \| "dht" \| "pex" \| "manual" \| "incoming"`. |
| `downloadRate`, `uploadRate`, `downloaded` | From us to them, and from them to us, in bytes. |
| `rtt` | Request round-trip time estimate, ms. |
| `requests`, `depth` | Requests outstanding and the queue depth allowed (rate × (1 s + RTT), 16–500). |
| `peerChoking`, `amInterested` | Whether they choke us, and whether we want their data. |
| `encrypted`, `seed` | |

`TrackerState`:

| Field | Description |
|---|---|
| `url` | |
| `interval` | Seconds between announces (`0` until the first answer). |
| `lastAt`, `nextAt` | Timestamps in ms. |
| `failures`, `error` | Consecutive failures and the last error. |
| `peers` | Peers returned by the last announce. |
| `seeders`, `leechers` | As reported by the tracker. |

`CloseReason`:

| Reason | Meaning |
|---|---|
| `closed by peer` | The other side hung up. |
| `error` | Socket error (refused, reset, unreachable). |
| `timeout` | Dial, handshake or keep-alive timeout, or a peer stalled for 20 s in the middle of a block. |
| `protocol` | The peer sent something invalid. |
| `hash failures` | Banned by smart ban for sending bad data. |
| `slow`, `useless` | Pruned to make room for better candidates. |
| `not needed` | A seed dropped another seed or an upload-only peer. |
| `duplicate` | A second connection to the same peer. |
| `self` | We dialled ourselves. |
| `wrong torrent` | The peer asked for a torrent we don't have. |
| `torrent closed`, `done` | We closed it on pause or close, or because the torrent finished and doesn't seed. |

## Creating torrents

### `createTorrentFromPath(path, options?)`

Returns `Promise<Uint8Array>`, the `.torrent` file's bytes.

- `path` may be a file or a directory. For a directory, every regular file under it is included, sorted by path; symbolic links are skipped.
- Hashing streams the data in one pass, with two 1 MiB read buffers.

| Option | Default | Description |
|---|---|---|
| `name` | the base name of `path` | |
| `pieceLength` | `pieceLengthFor(size)` | Power of two, 16 KiB or more. |
| `announce` | none | Tracker URLs, each its own tier, or explicit tiers (`string[][]`). |
| `private` | `false` | BEP 27: peers come only from its trackers. |
| `comment` | none | |
| `createdBy` | `"tinytorrent"` | |
| `creationDate` | now | Seconds since the epoch, or `false` to leave it out (output is then reproducible). |
| `webSeeds` | none | BEP 19 `url-list` (written only; the engine doesn't use web seeds). |
| `onProgress` | none | `(hashed, total) => void`. |
| `signal` | none | `AbortSignal`. |

### `createTorrent({ name, files, …options })`

Builds a torrent synchronously from data in memory: `files` is `[{ path, data }]`, with paths relative to the torrent's root. A single file with path `""` makes a single-file torrent. This is mainly for tests and benchmarks.

### `pieceLengthFor(totalBytes)`

Returns the smallest power of two, starting at 16 KiB, that keeps the torrent at 2,048 pieces or fewer, capped at 16 MiB.

To seed a torrent you just created without hashing it twice, use `engine.add(bytes, { dir: <parent of path>, seedMode: true, seed: true })`.

## Parsing

| Function | Returns |
|---|---|
| `parseTorrent(bytes)` | `Metainfo`: `Info` plus `announce: string[]` (tiers flattened in order). |
| `parseInfo(rawInfoDict)` | `Info`. |
| `parseMagnet(uri)` | `Magnet`: `{ infoHash, infoHashHex, name?, announce, peers, select? }`. Hex and base32 hashes are accepted; `select` comes from `so=`. |

`Info`:
- `infoHash`, `infoHashHex`, `name`;
- `pieceLength`, `pieces` (concatenated SHA-1 hashes), `pieceCount`;
- `length`, `files: TorrentFile[]`, where each `TorrentFile` is `{ path, length, offset }`;
- `private`;
- `raw`, the bencoded `info` dictionary.

All of these throw `MetainfoError` on malformed input, including paths that would escape the save directory. Padding files (BEP 47) are left out of `files`: they are gaps between real files, never written to disk and read as zeros.

## Transports

A `Transport` opens every socket the engine uses: peer TCP connections, the listener, UDP (trackers, DHT, NAT-PMP, SSDP) and HTTP (trackers, UPnP).

| Factory | Description |
|---|---|
| `systemTransport()` | The default: the system's routes. |
| `boundTransport({ address })` | Binds every socket to a local address. `address` is a string, or a function called for each new socket that returns the address, or `null` when the link is down. With `null`, every attempt throws `TransportUnavailableError` and nothing connects. |

With a bound transport, the listener binds only to that address, IPv6 runs only if the address is IPv6, and port mapping asks only the gateway reached through that address.

The `Transport` interface is `connect`, `listen`, `udp`, `httpGet`, `http` and `localAddress`; see `src/transport.ts` to write your own.

## Low-level exports

These are exported for tools and tests. Applications rarely need them.

| Export | Description |
|---|---|
| `encode(value)`, `decode(bytes)`, `BencodeError` | Bencode. `decode` returns zero-copy views into the input; `encode` sorts dictionary keys. |
| `Bitfield` | A bitfield with `has`, `set`, `clear`, `fill` and `count`. |
| `Dht`, `DhtOptions` | A standalone DHT node (BEP 5, or BEP 32 with `family: 6`): `start()`, `stop()`, `lookup(infoHash, onPeers, announcePort?)`, `nodes()`, `addNode()`. |

## Units and conventions

- Sizes and rates are in **bytes** and **bytes per second**; durations are in seconds unless the name says ms; timestamps are `Date.now()` milliseconds.
- `0` means "unlimited" for every limit and "none" for seed limits.
- Addresses are `host:port`, with IPv6 in brackets: `[2001:db8::1]:6881`.
- Info hashes are lowercase hex in strings.
