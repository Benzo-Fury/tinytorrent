# How it works

> In-depth reference. Not needed to use Tiny Torrent; the [README](../README.md) has the short version. Read this before changing the engine, or when you need to know exactly why it behaves the way it does.

**On this page:** [Purpose](#purpose) · [Architecture](#architecture) · [The life of a download](#the-life-of-a-download) · [Seeding](#seeding) · [Resume state](#resume-state) · [Networking](#networking) · [Performance techniques](#performance-techniques) · [Standards](#standards) · [Design choices](#design-choices)

---

## Purpose

Tiny Torrent is a general-purpose BitTorrent engine: a library to build torrent clients, download services, seedboxes and similar applications on. It runs anywhere Bun does, from a laptop to a small ARM board. It is built around three ideas:

1. **Low cost per byte.** Most engines either target browsers (WebTorrent) or are native code (libtorrent, aria2). Tiny Torrent is JavaScript, but its hot paths copy each byte once, avoid streams and allocations, and do as little work per decision as possible. That lets one core keep up with any home or server connection, even on small ARM hardware.
2. **Small and readable.** The whole engine is under 5,000 lines of code (comments and blank lines aren't counted), with a ceiling per module. Behaviour comes from a few well-chosen mechanisms rather than many options.
3. **The application stays in control.** It can inspect a torrent before any data flows, choose files, set limits, pause and resume without losing work, and, optionally, pin every socket to one address (such as a VPN's) with a killswitch.

**Non-goals:**
- browsers and WebRTC;
- streaming or sequential download;
- uTP;
- pure BitTorrent v2;
- web seeds;
- local peer discovery;
- queueing and RPC, which belong to the application.

[Standards](#standards) explains each.

## Architecture

```
Engine (one per process)
 │  one 250 ms tick · listener · DHT (IPv4 + IPv6) · shared UDP tracker socket
 │  rate limits · port mapping
 │
 └─ Torrent (one per info hash)
     │  metadata · file selection · request loop · verify and save · lifecycle · seed limits
     │
     ├─ Swarm ─────────── who to connect to, who to upload to (choker), PEX
     │   └─ Peer ──────── one connection: parser, batched writes, rate meters
     │       └─ WireParser, MseHandshake
     ├─ Picker ────────── which block to ask for next; piece buffers
     ├─ PieceServer ───── answers uploads through the ReadCache; seed-mode checks
     ├─ Storage ───────── positional reads and writes into sparse files
     ├─ Verifier ──────── SHA-1, disk re-checks, smart ban
     ├─ Announcer ─────── UDP and HTTP trackers
     └─ resume state ──── verified pieces, file sizes and mtimes, totals

PortMapper ── NAT-PMP, then UPnP IGD
Transport ─── opens every socket; boundTransport() pins them to one address
```

| Module | Responsible for |
|---|---|
| `engine.ts` | The public `Engine`: options, the tick, listener, incoming connections routed by info hash, DHT, port mapping, engine-wide limits |
| `torrent.ts` | The public `Torrent`: states, selection, request loop, verification and saving, lifecycle, seeding policy, stats |
| `swarm.ts` | Candidate addresses, dialling, duplicates, pruning, PEX, choking and the upload loop |
| `peer.ts` | One connection's state, meters, request queue and write batching |
| `connections.ts` | Dialling, accepting, the encryption fallback, the candidate list |
| `wire.ts` | The push parser that streams blocks straight into piece buffers, and `OutBuffer` |
| `mse.ts` | The MSE/PE handshake: BigInt Diffie–Hellman and RC4 applied in place |
| `extensions.ts` | Extension handshake (BEP 10), metadata (BEP 9), PEX (BEP 11), `upload_only` (BEP 21) |
| `picker.ts` | Rarest-first availability buckets, partial-first, endgame, piece buffers |
| `storage.ts` | Mapping pieces to files, sparse full-length files, an LRU of open file handles, padding files |
| `verifier.ts` | Piece hashing, parallel disk re-checks, smart ban |
| `cache.ts`, `seeding.ts`, `limits.ts` | Upload read cache; the piece server, seed mode and seed limits; token-bucket rate limits |
| `resume.ts` | Saving and loading resume state atomically |
| `tracker.ts` | UDP (BEP 15) and HTTP trackers, and the announce lifecycle |
| `dht.ts` | A DHT node (BEP 5), IPv4 or IPv6 (BEP 32) |
| `portmap.ts` | NAT-PMP and UPnP IGD |
| `transport.ts` | Sockets, bound or not |
| `metainfo.ts`, `bencode.ts`, `create.ts`, `bitfield.ts` | Parsing torrents and magnets, bencode, creating torrents, bitfields |

There is **one timer**. The engine's 250 ms tick drives:
- rate meters and limits;
- snub detection and keep-alives;
- choking and pruning;
- PEX;
- tracker and DHT announces;
- seed limits;
- resume saves.

Nothing else sets intervals, so an idle engine costs almost nothing: about 1% of a small ARM core, mostly Bun itself.

## The life of a download

### 1. Metadata

A `.torrent` file already contains the `info` dictionary. A magnet link has only the info hash, so the torrent connects to peers and fetches the `info` dictionary from them in 16 KiB pieces (BEP 9), checking it against the hash. The torrent then emits `metadata`.

### 2. The request gate

With `start: "metadata-only"`, the torrent stops in `waiting`. Peers stay connected and the file list is known, but **no block is requested** until `select()` is called. That gate is what lets an application reject a torrent (wrong files, executables, archives) before downloading any of its data.

`select()` records which files are wanted, creates only those files (full length and sparse), and marks the pieces that overlap them as wanted.

### 3. Checking existing data

If files already exist, they are reused:
- **Resume state matches** (every selected file has the size and modification time that were recorded): the saved bitfield is trusted, with no hashing.
- **Seed mode** (every selected file at full length): trusted for now, with each piece checked when it's first uploaded ([below](#seed-mode)).
- **Otherwise**: every wanted piece is hashed from disk on worker threads, four at a time.

### 4. Finding and keeping peers

Addresses come from trackers, the DHT, PEX, the magnet's `x.pe` and `addPeer()`, and land in a candidate list. Up to 30 dials can be in progress across the engine, each with a 5 s timeout. New addresses are dialled at once rather than on the next round.

When a torrent is at `maxPeersPerTorrent` and better candidates are waiting, peers that have stayed useless for a minute are pruned: they never unchoke us, are slow, or have nothing we need. When two peers dial each other at the same time, both sides keep the connection opened by the lower peer id.

### 5. Choosing blocks

The picker decides what to ask each peer for:
1. **Pieces already started come first.** This keeps the number of piece buffers in memory low and finishes pieces sooner.
2. **Then rarest first.** Pieces wait in one array grouped by how many peers have them. A peer announcing a piece moves it one slot, and a seed is a counter rather than an increment on every piece. A peer with only a few pieces is matched by walking its bitfield instead. On a 50,000-piece torrent, a pick touches about two entries.
3. **Endgame.** In the last pieces, a block can be requested from a second peer (at most two copies). The slower copy is cancelled when the first arrives.

Each peer gets requests in flight equal to its rate × (1 s + its round-trip time), between 16 and 500, capped by the `reqq` it advertises. The queue is refilled when a quarter of it has been used. A peer that stops sending blocks for 20 s is treated as snubbed.

### 6. Receiving, verifying and saving

When a `piece` message header arrives, the parser asks for the piece buffer and copies the payload straight into it as TCP chunks arrive: one copy per byte, with no message objects. When a piece is complete, it is hashed with SHA-1 in one pass, written to disk with positional writes, and announced to peers with `have`. Bytes that fall in an unselected file are never written.

**The disk sets the pace.** Writes complete asynchronously, each holding its piece buffer until done. When more than an eighth of `maxBufferBytes` (64 MiB by default) is waiting to be written, reads from every peer pause, exactly as when a download limit is reached, and resume as the writes finish. Without this, a network faster than Bun's writes kept the event loop busy receiving and piled up gigabytes of pieces waiting to be saved.

**Smart ban.** If a piece fails its hash:
- **One sender:** it counts against that peer, and two strikes get it banned.
- **Several senders:** the hash of each block and its sender are recorded. When the piece later verifies, exactly the peers whose blocks differed are banned.

The `warning` event names the senders of every failed piece.

### 7. Finishing

Once every selected piece is verified, the torrent tells trackers `completed`, saves resume state and emits `done`. It then either keeps going as a seed or goes to `done`: it disconnects every peer, refuses new ones and tells trackers `stopped`.

## Seeding

Downloading is about taking; seeding is about giving well. A seed should serve every interested peer quickly and fairly, at line rate, and at low CPU.

### Choking

At most a few peers are "unchoked" (allowed to request data) at any time.

**While downloading**, uploads are **tit for tat**: the peers sending us the most get the `upload.slots` slots, plus one optimistic slot rotated every 30 s so that new peers get a chance to prove themselves. The choker re-evaluates every 10 s.

**While seeding** there's nothing to trade, so the choker aims for throughput and fairness:
- **How many slots.** `upload.slots` is the minimum. Above it, the choker uses libtorrent's rate-based rule:
  - Sort unchoked peers by what we send them. The n-th must take at least n KiB/s for its slot to count.
  - The target is that count plus half again, to leave room to grow.
  - A peer unchoked within the last second has no rate yet, so it counts provisionally. The target can then grow by four each tick.

  As a result, newcomers are served within a second while bandwidth is spare, and growth stops when the uplink is full.
- **When.** Free slots are filled every tick (250 ms), and as soon as a peer becomes interested. A peer that loses interest gives its slot back immediately.
- **Who.** Slots take turns. Every 10 s, peers that have held a slot for 20 s give it up, longest-held first, as far as needed to serve the peers waiting. Free slots go to whoever has waited longest.

Rotating keeps a seed's pieces spreading through the whole swarm instead of to a fixed few, and means no leecher waits long for its first byte.

`upload.slots: 0` disables uploading entirely.

### The upload path

Blocks are served from a shared read cache:
1. **Reading.** A request for a block reads the window around it from disk with one `pread`: 512 KiB, or the whole piece when pieces are smaller. The window is kept in a 32 MiB per-torrent LRU (`uploadCacheBytes`), so several peers fetching the same piece cost one read. Read buffers are not zero-filled first, because the read overwrites them; only padding gaps are zeroed.
2. **Batching.** Cached blocks are served synchronously. A peer's queued blocks go out together, up to 128 KiB per socket write. Smaller writes cost noticeably more kernel time per byte; larger ones were no faster and buffered more memory.
3. **Continuing.** Serving resumes when the socket drains, when a disk read completes, or straight away after a full batch, so throughput never waits for the next tick.
4. **One copy, into reused memory.** Each block is copied once into the peer's `OutBuffer`, and the batch's buffer is handed to the socket without another copy.

Memory is reused rather than allocated per batch, which was the single largest saving:
- **Batch buffers.** Batches are built in 512 KiB buffers from one pool shared by every connection, capped at 16 MiB. Bun keeps a reference to a written buffer until it has gone out, so a buffer only returns to the pool from the write's completion callback; reusing it sooner corrupts the stream.
- **Cache windows.** An evicted window is kept for the next read once the callbacks still copying from it have run.

Allocating fresh buffers instead cost about 20% more CPU per byte on ARM, much of it in the kernel, and hundreds of MB of memory.

Two zero-copy designs were measured and rejected:
- **Writing cached bytes straight to the socket** saved 13% CPU but doubled peak memory, because the socket then keeps whole cache windows alive.
- **Memory-mapping the files,** as libtorrent does, would remove the `pread` copy. But in Bun, reading a mapped file that another process has truncated kills the whole process with a bus error, so one shortened file could take down the application. Reads stay as `pread`.

### Seed mode

`seedMode: true` trusts complete files (every selected file at its full length) without hashing them first. Each piece is hashed the first time it's uploaded, and the verified piece goes straight into the cache. If a piece fails, seed mode ends: the torrent re-checks everything and downloads whatever is missing. Pieces not yet verified are remembered in resume state, so a restart continues where it left off.

### Seed limits

Seeding ends at a **ratio** or a **time**, whichever comes first:
- **ratio:** all-time uploaded ÷ the size of the selected files;
- **time:** minutes spent in `seeding`, all time.

The engine sets the policy (`seed`), and each torrent may override it. When a limit is reached, the torrent emits `seeded`, goes to `done`, disconnects and tells trackers `stopped`. Totals and seed time live in resume state, so limits are honoured across restarts.

### Rate limits

Rate limits are token buckets, one engine-wide and one per torrent. A byte must pass both, and each bucket holds one second's worth.
- **Uploads** take tokens before a block is sent.
- **Downloads** spend tokens as each block arrives. While a bucket is empty, the torrent's sockets are paused, so the kernel's buffers push back on the sender.

### Etiquette

- **Trackers** get `started`, the exact bytes `left` of the selected files, and `completed` only when a download actually completed (never from a torrent that started complete). They get `stopped` on pause, close and the end of seeding, and a fresh `started` after resuming. `min interval` is honoured, and intervals are clamped to 2–30 minutes.
- **The DHT** gets a re-announce every 15 minutes, because DHT nodes forget announces after about 30.
- **Other peers.** A seed says it only uploads (BEP 21 `upload_only`), and disconnects from peers that are seeds or upload-only too (`not needed`). It doesn't redial them for an hour. PEX marks seeds, and a seeding torrent skips them. While seeding, peers that disconnect are retried after an hour rather than a minute: most are seeds dropping a redundant connection, and leechers that want data dial in.

## Resume state

With `resumeDir`, each torrent has `<infohash>.resume.json`, holding:
- the verified pieces;
- each selected file's size and modification time at the time of saving;
- all-time uploaded and downloaded bytes, and seconds seeded;
- in seed mode, the pieces not yet verified.

It is written atomically (a temporary file, then a rename) on pause, close and completion, and every 5 minutes while downloading.

On the next `select()`, the bitfield is trusted only if **every** selected file still has the recorded size and modification time. Otherwise, the files are re-checked by hash. Moving a torrent's directory with a rename keeps modification times, so it doesn't trigger a re-check.

## Networking

### Transports and binding (optional)

By default the engine uses the system's normal routes (`systemTransport()`). Every socket goes through the `Transport`:
- peer TCP connections and the listener;
- UDP for trackers, the DHT, NAT-PMP and SSDP;
- HTTP for trackers and UPnP.

If you want, `boundTransport({ address })` binds all of them to one local address, read again for each socket, typically a VPN's. When the function returns `null`, every attempt throws `TransportUnavailableError` and nothing goes out. Nothing can leak around the VPN, because nothing in the engine opens a socket any other way.

`engine.disconnect()` is the matching killswitch. It pauses every torrent, keeping files and resume state, and closes the listener, DHT and tracker sockets. `reconnect()` reopens everything, and torrents continue from their data.

### Port mapping

`portMapping` asks the gateway to forward the listening TCP port and the DHT's UDP port:
1. **NAT-PMP first.** Many home routers support it, as do some VPNs that forward ports on request, such as ProtonVPN.
2. **Then UPnP IGD:** SSDP discovery, the device description, then a SOAP `AddPortMapping`. If the gateway accepts only permanent leases (error 725), a permanent lease is used.

Leases last an hour and are renewed at half of that. The mapped external port is what trackers, the DHT and peers are told (`announcePort()`). Mappings are removed when the engine is destroyed. Requests go through the transport, so an engine bound to a VPN only ever asks the VPN's gateway, never the LAN router.

If your router or VPN forwards a fixed port (AirVPN, for example), no mapping is needed: set `port` to that port.

### IPv6

- The listener is dual-stack.
- Addresses are written `[v6]:port` everywhere.
- PEX carries `added6`.
- An IPv6 DHT node (BEP 32) runs beside the IPv4 one, unless the transport is bound to an IPv4 address.

UDP trackers are used over IPv4.

### Encryption

MSE/PE obfuscates the stream. It doesn't authenticate peers.
- The Diffie–Hellman exchange uses the fixed 768-bit group in `BigInt`. Key pairs are reused across 32 connections, because generating one is the expensive part.
- RC4 runs in JavaScript, in place. On ARM that is 1.4× faster than Bun's native cipher, and it allocates nothing.

With `prefer`, a peer that hangs up during the handshake is retried once in the other mode. `prefer-plaintext` saves about 20% CPU per GB, a good trade when traffic already goes through a VPN.

### Connection limits

| Limit | Value |
|---|---|
| Peers per torrent (`maxPeersPerTorrent`) | 200 |
| Dials in progress, engine-wide (`maxHalfOpen`) | 30 |
| Dial timeout | 5 s |
| Incoming connections still handshaking | 64; more are refused, which protects the CPU from handshake floods |

## Performance techniques

**Per byte:**
1. **No streams.** Socket `data` events feed `WireParser.push` directly.
2. **One copy per received block,** straight into the piece buffer. Only a control message split across chunks is buffered, and only the bytes it still needs.
3. **Pooled piece buffers,** released after the disk write. Only one peer at a time streams into a block, so a recycled buffer is never written by a straggler.
4. **Batched writes.** Messages from one event-loop turn leave as one socket write, built in pooled buffers that return once the socket has written them ([the upload path](#the-upload-path)).
5. **Positional I/O** into full-length sparse files, with no read-before-write. Open file handles are kept in an LRU of 64.
6. **One-pass SHA-1** (native, over 1 GB/s on an ARM core). Disk re-checks run on worker threads through `crypto.subtle`.

**Per decision:**

7. **Bucketed rarest-first.** About two entries are touched per pick ([above](#5-choosing-blocks)).
8. **Rate meters as decaying counters,** updated once per tick.
9. **One timer** for everything.

The single JavaScript thread is the ceiling by design. One core handles about 1.5 GB/s on the engine path, far above most connections. If that ever changes, the way to scale is one engine per worker.

## Standards

| Standard | Support |
|---|---|
| BEP 3: the protocol | Full |
| BEP 5: DHT | Full, as a client node |
| BEP 6: fast extension | Yes |
| BEP 9, 10: metadata, extension protocol | Yes |
| BEP 11: PEX | IPv4 and IPv6, with seed flags |
| BEP 12: tracker tiers | Read; every tracker is announced to in parallel (like qBittorrent's "announce to all tiers"), which finds peers sooner |
| BEP 15: UDP trackers | Yes |
| BEP 19: web seeds | Written into created torrents, not used for downloading |
| BEP 21: `upload_only` | Sent and honoured |
| BEP 23: compact peer lists | Yes |
| BEP 27: private torrents | Yes (no DHT or PEX) |
| BEP 32: IPv6 DHT | Yes |
| BEP 47: padding files | Yes: never written, read as zeros, verified across |
| BEP 52: v2 | Hybrid v1+v2 torrents work through their v1 half; pure v2 doesn't |
| BEP 53: magnet `so=` | Yes |
| MSE/PE | Yes |
| NAT-PMP, UPnP IGD | Yes (not PCP; PCP gateways generally also answer NAT-PMP) |

**Left out, and why:**

| Feature | Reason |
|---|---|
| uTP | A pure-TypeScript uTP would be large and CPU-heavy, and TCP reaches nearly every peer. |
| Pure v2 torrents | Merkle trees, a new handshake and hash requests are a lot of code for a format that ships as hybrids in practice. |
| Web seeds (downloading) | An HTTP client inside the engine for a source most swarms don't use. A good candidate to add if applications need it. |
| Holepunch (BEP 55) | Needs uTP in practice; port mapping covers most of the gain. |
| Tracker scrape | Announces already return seeder and leecher counts. |
| `lt_donthave`, suggest, allowed-fast | A seed never loses pieces (except when seed mode fails), and immediate unchoking makes allowed-fast sets rarely matter. |
| BEP 40 peer priority, BEP 42 DHT security | Marginal for a client node; BEP 42 needs a reliable external address. |
| Per-peer rate limits | The rotating choker already shares bandwidth between peers. |
| File priorities, sequential download | Selecting files covers most needs; sequential download is for streaming, a non-goal. |
| Queue, RPC, IP blocklist formats | Application policy. The engine offers the mechanisms (`pause`, `stats`, `allowPeer`). |
| Local peer discovery | Only helps with peers on the same LAN, and leaks multicast outside a bound transport. A candidate to add, off when bound. |

## Design choices

These could otherwise surprise you:

- **Unselected files are never created.** A piece that spans a selected and an unselected file is downloaded, but only the selected file's bytes are written. Such pieces aren't served to others, and are fetched again if the other file is selected later.
- **A finished torrent that doesn't seed refuses peers.** In `done` it is disconnected and stays that way.
- **The end of a download can't get stuck.** The last few pieces are where engines stall, so three safeguards apply:
  - a duplicate block that is thrown away gives its request back;
  - a peer silent for 20 s in the middle of a block is disconnected;
  - in endgame, the picker's request counts are rebuilt from the live peers every 10 s, so any drift heals instead of leaving a block nobody is asked for.
- **A peer closed mid-chunk ignores the rest of that chunk,** so a peer banned for bad data can't keep writing into a piece buffer.
- **A re-check disconnects peers that are halfway through a block** before piece buffers are recycled.
- **Adding complete data never hashes twice.** With matching resume state, or in seed mode, serving starts in under half a second.
- **`reconnect()` resumes every torrent,** including ones paused by hand. The engine doesn't track why a torrent was paused.
