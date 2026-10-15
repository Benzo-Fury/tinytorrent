# Troubleshooting

> In-depth reference. The [README](../README.md#troubleshooting) has the short table. This page goes symptom by symptom, then explains every field of `stats()`.

**Symptoms:** [No peers](#no-peers-or-a-magnet-never-starts) · [Slow downloads](#slow-downloads) · [Stuck near the end](#stuck-near-the-end) · [Nobody downloads from my seed](#nobody-downloads-from-my-seed) · [Seed stopped](#the-seed-stopped-by-itself) · [Re-hashing](#everything-is-re-hashed) · [High CPU](#high-cpu) · [Memory](#memory) · [Uploading too much](#uploading-too-much-or-at-all) · [Hash failures](#hash-failures-in-the-logs) · [Files](#files-look-wrong) · [Binding to a VPN](#binding-to-a-vpn-or-interface)

**Reference:** [Reading `torrent.stats()`](#reading-torrentstats) · [Reading `engine.stats()`](#reading-enginestats) · [Close reasons](#close-reasons)

---

## Start here

Log the stats every few seconds while reproducing the problem:

```ts
torrent.on("warning", console.warn);
engine.on("warning", console.warn);
setInterval(() => console.log(JSON.stringify(torrent.stats(), null, 1)), 5000);
```

Almost every "why" question can be answered from those numbers.

## No peers, or a magnet never starts

| Check | Meaning |
|---|---|
| `stats().trackers[].error` | Trackers unreachable or refusing. With a bound transport, make sure the address is up. |
| `stats().candidates` near 0 | Discovery found nobody. |
| `engine.stats().dhtNodes` near 0 | The DHT hasn't bootstrapped. UDP may be blocked, or the bootstrap routers may be unreachable. |
| `state` stays `metadata` | Peers were found, but none has sent the metadata yet. A few old clients don't support metadata exchange; it usually resolves as more peers connect. |

**Fixes:**
- Save `engine.dhtNodes()` (and `dhtNodes6()`) on shutdown and pass them back as `dht: { nodes, nodes6 }`, so a restart doesn't depend on bootstrap routers.
- Add trackers with `engine.add(…, { trackers })`.
- If you know a peer, pass `peers: ["host:port"]`.
- Private torrents use only their own trackers: no DHT, no PEX.

## Slow downloads

| Look at | If | Then |
|---|---|---|
| `candidates` | Near 0 | Discovery is the limit; see [No peers](#no-peers-or-a-magnet-never-starts). |
| `connecting` | Stuck at the half-open limit (30) | Dials are timing out: a firewall, or a VPN if you use one. |
| `peers[].peerChoking` | Most peers choke us | Normal in large swarms. The engine keeps dialling and prunes peers that stay useless for a minute. |
| `peers[].requests` vs `depth` | `requests` pinned at `depth` with a high `rtt` | That peer is the limit, not us. |
| `closeReasons` | `timeout` and `error` dominate | Connectivity problems. |
| `downloadRate` | Flat at a round number | Check `download.limitBytesPerSecond` and the torrent's `limits`. |

A swarm's speed varies run to run. Compare against another client on the same link at the same time before blaming the engine (`bun bench/cli.ts real <torrent> --engines tinytorrent,aria2`).

## Stuck near the end

`endgame: true` means the last pieces are requested from two peers at once. Over the last few percent, `wasted` growing a little is normal: the slower copies are thrown away.

If `progress` stops moving for minutes while peers are connected:
- `activePieces` shows how many pieces are in flight.
- Peers that have the missing pieces may all be choking us. Check `peers[].peerChoking` against `peers[].seed`.
- The engine rebuilds its request counts every 10 s in endgame and drops peers stalled mid-block after 20 s. A stall that outlasts those is a bug: capture `stats()` and the warnings.

## Nobody downloads from my seed

Peers have to reach you, or you have to dial them. Without a reachable port, only peers you dial (found through trackers, the DHT and PEX) get served.

| Your setup | Do this |
|---|---|
| Home router | `portMapping: true` (UPnP or NAT-PMP), or forward `port` by hand |
| Public IP, no NAT (a typical server) | Nothing: open `port` in the firewall |
| A VPN that forwards ports on request (e.g. ProtonVPN) | `portMapping: true` with the transport bound to the VPN; NAT-PMP goes to the VPN gateway |
| A VPN with a fixed forwarded port (e.g. AirVPN) | `port: <forwarded port>` |

**Check that it worked:**
- `engine.stats().mappings` lists the mappings.
- `engine.announcePort()` is the port being announced.
- The `portMapping` event fires when mappings change.

**Then check demand.**
- **No interested peers.** If `stats().peers` shows no interested peers, nobody needs your data. Popular public torrents usually have many more seeds than downloaders, so a new seed gets few requests.
- **Seeds dropped.** `closeReasons["not needed"]` counts seeds that were dropped, as intended.

## The seed stopped by itself

A seed limit was reached. The torrent emitted `seeded` and is now `done`.
- `torrent.seedLimits()` shows the policy in force: the engine's `seed` with this torrent's override.
- `torrent.ratio` and `torrent.seedSeconds` show progress. Both are all-time when `resumeDir` is set, so a restart doesn't reset them.
- To keep seeding: `engine.add(…, { seed: { ratio: 0, minutes: 0 } })` (no limits) or raise the limits.

## Everything is re-hashed

| Cause | Fix |
|---|---|
| No `resumeDir` | Set it. Without resume state the engine can only trust a hash. |
| Files were modified, copied or touched (their mtime changed) | Expected: resume state is only trusted when every selected file's size and modification time match. Move with a rename, which keeps mtimes. |
| You're adding complete data for the first time | Use `seedMode: true` to serve at once and hash pieces as they're uploaded. |
| The resume file is missing or unreadable | Check permissions on `resumeDir`; a `warning` names save failures. |

To force a re-check deliberately, call `await torrent.recheck()`.

## High CPU

- **Profile first:** `bun bench/cli.ts real <torrent> --profile ./prof` writes a Markdown CPU profile, or run your app with `bun --cpu-prof-md`.
- **Through a VPN, most of the CPU is the kernel** handling small packets through the tunnel. aria2 pays the same cost.
- **`encryption: "prefer-plaintext"`** skips RC4 for peers that allow plaintext, saving about 20% per GB. It's a good fit when traffic already goes through a VPN.
- **Many slow peers** (each sending a few KB/s) cost more per byte than a few fast ones. Lowering `maxPeersPerTorrent` can help on a congested link.
- **Hashing:** `checking` hashes the whole selection on worker threads. Use `resumeDir` and `seedMode` to avoid it.

## Memory

| Bound | Default | Option |
|---|---|---|
| Pieces in progress, per torrent | 512 MiB | `maxBufferBytes` |
| Verified pieces waiting for their disk write, per torrent | 64 MiB (an eighth of `maxBufferBytes`) | `maxBufferBytes` |
| Upload read cache, per torrent | 32 MiB | `uploadCacheBytes` |

Typical peaks for the whole process:
- **Seeding** at gigabit speeds and above: about 135–165 MB RSS on Linux, up to 260 MB on macOS.
- **Downloading** at over 4 Gbit/s on ARM: about 200–285 MB.

Upload batches use a shared pool of at most 16 MiB. The cache is cleared on pause and when seeding ends. When the disk falls behind the network, the engine stops reading from peers until the writes catch up, so a fast connection can't fill memory with pieces waiting to be saved.

## Uploading too much, or at all

- **Limit uploads:** `upload.limitBytesPerSecond` for the engine, `limits.uploadBytesPerSecond` per torrent. Change either at runtime with `setLimits`.
- **Never upload:** `upload.slots: 0` unchokes nobody.
- **Stop when finished:** leave `seed` off. A finished torrent then disconnects and refuses peers.

## Hash failures in the logs

`warning: Piece N failed its hash check (from 1.2.3.4:5678 qBittorrent 4.6, …)` means a peer sent corrupt data.
- **Smart ban** removes exactly the peer that sent the bad blocks, even when several peers contributed to the piece. `closeReasons["hash failures"]` counts the bans.
- **The piece** is downloaded again from someone else.
- **`hashFailures` keeps growing** while the senders differ every time: suspect your own disk or memory.

In seed mode, a failed piece means the files on disk weren't the complete, correct data. The torrent leaves seed mode, re-checks everything, and downloads what's missing.

## Files look wrong

- **Unselected files appear:** they shouldn't. Only selected files are created, and boundary-piece bytes for unselected files are dropped.
- **Files are full size before they're downloaded:** they're sparse. Disk space is used as data arrives; `du` shows the real usage.
- **After moving files:** `close()`, move the directory with a rename, then `add()` with the new `dir` and the same `resumeDir`. If you copied them instead, the mtimes changed and they'll be re-checked, which is safe but takes time.
- **Padding files** (`.pad/…` in hybrid torrents) are never written to disk.

## Binding to a VPN or interface

This is optional: by default the engine uses the system's normal routes.


- **Bind everything:** `transport: boundTransport({ address: () => vpnAddressOrNull })`. Trackers (UDP and HTTP), the DHT and port mapping go through it too.
- **Killswitch:** call `engine.disconnect()` when the link drops and `engine.reconnect()` when it returns. Downloads continue from their data. `reconnect()` resumes every torrent, including ones you paused yourself.
- **Errors while it's down:** while the function returns `null`, sockets fail with `TransportUnavailableError` and the engine backs off. That is expected, not a problem.

---

## Reading `torrent.stats()`

| Field | What it tells you |
|---|---|
| `state`, `progress` | Where the torrent is ([states](API.md#states)); 0–1 of the selected bytes verified. |
| `downloadRate`, `uploadRate` | Bytes/s over about the last second. |
| `downloaded`, `uploaded` | This session. `totalDownloaded`, `totalUploaded`: all time. |
| `wasted` | Bytes received and discarded: endgame duplicates, data for pieces already done, failed pieces. A few percent near the end is normal. |
| `hashFailures` | Pieces that failed verification. Each one produces a `warning` naming its senders. |
| `peers` | One entry per connection ([fields](#peers)). |
| `connecting` | Dials in progress for this torrent. |
| `candidates` | Known addresses not yet tried or waiting to retry. Near 0 means discovery is the limit. |
| `activePieces` | Pieces partly downloaded. |
| `endgame` | `true` in the last pieces, when blocks are requested twice. |
| `closeReasons` | Count of disconnects by [reason](#close-reasons). |
| `trackers` | One entry per tracker ([fields](#trackers)). |
| `ratio` | All-time uploaded ÷ selected bytes. Seed limits use it. |
| `seedSeconds` | All-time seconds in `seeding`. Seed limits use it. |
| `slots` | `unchoked` peers and the `target` the choker is aiming for. While seeding, `unchoked` well below the number of interested peers with a low `uploadRate` means the uplink or a limit is full, and slots go round every 20 s. |
| `cache` | Upload `reads` from disk and `hits` served from memory. A seed serving many peers should show many hits per read. |
| `unverified` | Seed mode: pieces not yet hashed (each is hashed on first upload). |

### Peers

| Field | What it tells you |
|---|---|
| `address`, `client`, `source` | Who, what software, and where we heard of them (`tracker`, `dht`, `pex`, `manual`, `incoming`). |
| `downloadRate`, `uploadRate`, `downloaded` | Their speed to us, our speed to them, and bytes received from them. |
| `rtt` | Round-trip time estimate in ms. |
| `requests`, `depth` | Requests in flight and how many we allow (rate × (1 s + rtt), 16–500). Pinned at `depth` means the peer is the bottleneck. |
| `peerChoking` | They aren't letting us download right now. |
| `amInterested` | They have pieces we want. |
| `encrypted`, `seed` | MSE/PE in use; they have everything. |

### Trackers

| Field | What it tells you |
|---|---|
| `url` | |
| `error`, `failures` | The last error and consecutive failures. Failures back off. |
| `interval` | Seconds between announces, as the tracker asked (clamped to 2–30 minutes). `0` until the first answer. |
| `lastAt`, `nextAt` | When we last announced and when we will next (ms timestamps). |
| `peers` | Peers in the last answer. |
| `seeders`, `leechers` | The swarm's size, according to the tracker. |

## Reading `engine.stats()`

| Field | What it tells you |
|---|---|
| `torrents`, `peers` | Totals across the engine. |
| `downloadRate`, `uploadRate`, `downloaded`, `uploaded` | Summed over torrents (this session). |
| `port` | The local listening port. |
| `announcePort` | The port peers are told: the external port when mapping worked. |
| `dhtNodes` | Nodes in the IPv4 and IPv6 routing tables. A few hundred is healthy; near 0 means the DHT isn't working. |
| `mappings` | Port mappings in place: `{ protocol, internal, external, method }`. Empty with `portMapping` on means it failed (look for a `warning`). |

## Close reasons

| Reason | Meaning | A lot of it suggests |
|---|---|---|
| `closed by peer` | They hung up | Normal in any swarm |
| `error` | Socket error: refused, reset, unreachable | Many stale addresses, or connectivity |
| `timeout` | Dial, handshake or keep-alive timed out, or a peer stalled mid-block for 20 s | Firewall or VPN dropping traffic |
| `protocol` | They sent something invalid | Usually one broken client |
| `hash failures` | Banned for sending bad data | A poisoner in the swarm |
| `slow`, `useless` | Pruned to make room for better peers | The engine at work |
| `not needed` | A seed dropped another seed or an upload-only peer | Expected while seeding |
| `duplicate` | A second connection to the same peer | Normal |
| `self` | We dialled ourselves (our address came back from a tracker or PEX) | Normal |
| `wrong torrent` | The peer asked for a torrent we don't have | Normal |
| `torrent closed`, `done` | We closed it: pause or close, or the torrent finished and doesn't seed | Expected |
