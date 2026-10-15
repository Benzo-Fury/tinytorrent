# Benchmarks

> In-depth reference. The [README](../README.md#how-fast-is-it) has the headline numbers. This page has the targets the engine is held to, every result with how it was measured, and how to run the benchmarks yourself.

**On this page:** [Targets](#targets) · [Hardware](#hardware) · [Downloading](#downloading) · [Seeding](#seeding) · [Engine path and microbenchmarks](#engine-path-and-microbenchmarks) · [Running them](#running-them) · [How they measure](#how-they-measure)

---

## Targets

Changes to the engine should keep these. Re-measure the affected ones before merging anything on a hot path.

**Downloading**

| Target | Result |
|---|---|
| At least 90% of aria2's speed on a real swarm through a VPN, and level with qBittorrent | 1.3× aria2 (113 vs 88 Mbit/s); qBittorrent 107 |
| Under 15 CPU-seconds per GB on the ARM board in a local swarm | 7.1 |
| Engine path at least 300 MB/s (`perf.test.ts` gate) | About 1.5 GB/s |
| Under 1 KB of heap growth per block (`perf.test.ts` gate) | About 7 bytes |
| Memory bounded at full speed: under 300 MB while downloading 2 GiB at over 4 Gbit/s on ARM | 198–284 MB (piece writes waiting for the disk are capped; `engine.test.ts`) |

**Seeding** (`bun bench/cli.ts seeding`: one seeder, 8 lean sink connections, ARM figures pinned to one A76 core)

| Target | Result |
|---|---|
| Per core, at least 80% of qBittorrent's plaintext upload, and level with it using RC4 | 82% (6.9 vs 8.5 Gbit/s); RC4 1.08× (1.90 vs 1.75) |
| On a whole machine, within 10% of qBittorrent | ARM 0.93× (10.3 vs 11.0 Gbit/s); Mac 1.14× (51.9 vs 45.4) |
| At least 1.5× WebTorrent on every setup | ARM core 3.6× plaintext, 1.6× RC4; Mac 3.7× and 1.4× (just short with RC4) |
| CPU per GB uploaded on an ARM core: at most 1.2 s plaintext, 4.5 s RC4 | 1.15 s and 4.22 s |
| The slowest leecher's first byte within a second | 0.6 s (aria2: some never served in 20 s) |
| Fairness (Jain's index halfway through) at least 0.95 | 1.00 (aria2: 0.53) |
| Complete data to serving in under 0.5 s with resume state or seed mode | Asserted in `seeding.test.ts` |
| Memory bounded: at most 32 MiB read cache per torrent, a 16 MiB batch pool, and 200 MB per process on ARM | 134–165 MB peak RSS on ARM (qBittorrent: 1.1 GB); up to 260 MB on macOS |

**Correctness** (not speed, but held just as firmly): every conformance case passes against libtorrent and Transmission ([Development](DEVELOPMENT.md#conformance-against-real-clients)).

## Hardware

| Name | Machine |
|---|---|
| **ARM** | Orange Pi 5 Plus: RK3588, 8 cores (4× A76 + 4× A55), NVMe, Bun in Docker |
| **Mac** | Apple M-series laptop |
| **VPN** | AirVPN over OpenVPN UDP, from Brisbane |
| **Versions** | aria2 1.37, WebTorrent 3.0.21 (with the fixes in `patches/`), qBittorrent 5.1.0 (Debian's `qbittorrent-nox`, libtorrent 2.0) on ARM, and qBittorrent 5 (libtorrent 2) on the Mac |

Results are from October 2026.

## Downloading

### A real swarm through a VPN

ARM, Tokyo exit. Debian 13.7 DVD torrent (15,232 pieces of 256 KiB), 90 s per engine, run back to back through the same tunnel. There were two rounds in different orders; each cell gives round 1 / round 2:

| Engine | Average Mbit/s | Steady (after 20 s) | Peak 5 s | CPU s/GB | Peak RSS MB | Peers |
|---|---|---|---|---|---|---|
| **Tiny Torrent** | **109.0 / 116.8** | **123.0 / 133.4** | 159 / 160 | 19.4 / 19.6 | 262 / 289 | 189 / 192 |
| qBittorrent 5.1.0 | 114.2 / 100.4 | 129.8 / 114.8 | 179 / 157 | 27.0 / 32.1 | 1,287 / 1,118 | 172 / 192 |
| aria2 1.37 | 87.7 / 87.5 | 98.4 / 95.6 | 136 / 141 | 12.4 / 15.4 | 35 / 34 | 90 / 87 |
| WebTorrent 3.0.21 | 35.6 / 35.6 | 37.1 / 34.2 | 73 / 66 | 221 / 232 | 299 / 306 | 162 / 159 |

Averaged over both rounds:
- **Tiny Torrent and qBittorrent are level** (113 vs 107 Mbit/s, inside the swarm's run-to-run swing). Tiny Torrent uses a third less CPU per GB and under a quarter of the memory.
- **aria2** is the cheapest per GB, and about 30% slower.
- **WebTorrent** is held back by its CPU: it kept a whole core busy (98–103%) for a third of the speed.

Notes:
- **qBittorrent** also used the torrent's HTTP web seed (Debian's mirror), which contributed about 9 Mbit/s. Tiny Torrent doesn't use web seeds.
- **The spread** between runs comes from the swarm and the tunnel, not the engines. An earlier session on the same exit measured Tiny Torrent at 97.5 Mbit/s, aria2 at 50 and WebTorrent at 8, so compare engines only within one session.
- **Most of the CPU** on this link is the kernel delivering ~1.2 KB packets through the tunnel. Every engine pays that cost; it is most of aria2's.

Through a congested Singapore exit (peer round-trips of 0.8–3 s), Tiny Torrent reached 45.5 Mbit/s against aria2's 39.7. CPU per GB was higher there for both: many peers each sending ~35 KB/s make per-chunk costs dominate.

A large real download: Ubuntu 26.04.1 live server, 2.93 GB, took 413 s (57 Mbit/s average) with 210 peers. One peer sent 12 corrupt pieces, and smart ban dropped exactly that one.

**Trackerless magnet** (info hash only, cold DHT, no saved nodes):
- first peer after 2.9 s;
- metadata after 9 s;
- then 55 Mbit/s steady from DHT and PEX peers alone.

### A local swarm

ARM, 1 GiB payload, 4 Tiny Torrent seeders, on the same machine:

| Latency | Engine | Mbit/s | CPU s/GB |
|---|---|---|---|
| 0 ms | **Tiny Torrent** | **1,307** | 7.5 |
| 0 ms | WebTorrent | 956 | 12.7 |
| 150 ms | **Tiny Torrent** | **1,096** | 7.1 |
| 150 ms | WebTorrent | 728 | 13.5 |
| 150 ms | aria2 | 441 | 6.7 |

The Tiny Torrent 150 ms row comes from a later session than the others. Its seeders are Tiny Torrent too, so their faster uploads account for part of the difference.

## Seeding

One engine seeds a 1 GiB payload (256 KiB pieces) to 8 connections from `bench/sink.ts`, spread over 4 processes, on the same machine:
- **The sink is lean.** Each connection keeps 250 requests open and throws the blocks away: no hashing, no disk, no picker. It costs far less per byte than a real downloader, so the seeder is what's measured, not the load.
- **CPU is the seeder's alone,** counted from when it was ready to serve, so hashing isn't included.
- **No added latency.** Latency changes window sizes, not the work done per byte; `--load leechers --latency-ms 100` runs real Tiny Torrent leechers through a delaying proxy instead.
- **Encryption.** Plaintext runs use a plain handshake (`--encryption off`); RC4 runs offer only RC4 inside MSE (`--encryption prefer`), so every seeder makes the same choice.

Each engine ran twice, back to back; the cells give the average.

### ARM, one core

The seeder is pinned to one A76 core and the load to the other seven (`--seeder-cpus 7 --load-cpus 0-6`), so this compares engines core for core.

| Engine | Encryption | Mbit/s | CPU s/GB | of it kernel | Peak RSS MB | Slowest 1st byte | Fairness |
|---|---|---|---|---|---|---|---|
| **Tiny Torrent** | plaintext | **6,935** | 1.15 | 0.75 | **152** | 0.6 s | 1.00 |
| qBittorrent 5.1.0 | plaintext | 8,450 | 0.95 | 0.50 | 1,095 | 0.6 s | 1.00 |
| aria2 1.37 | plaintext | 5,641 | 1.36 | — | 65 | never, for some | 0.53 |
| WebTorrent 3.0.21 | plaintext | 1,933 | 4.16 | 2.21 | 196 | 1.1 s | 1.00 |
| **Tiny Torrent** | RC4 | **1,896** | 4.22 | 0.84 | **134** | 0.6 s | 1.00 |
| qBittorrent 5.1.0 | RC4 | 1,752 | 4.56 | 0.59 | 1,090 | 0.6 s | 1.00 |
| aria2 1.37 | RC4 | 2,053 | 3.72 | — | 65 | never, for some | 0.63 |
| WebTorrent 3.0.21 | RC4 | 1,182 | 6.78 | 2.28 | 202 | 1.1 s | 1.00 |

- **Plaintext:** qBittorrent is about 20% faster per core. Tiny Torrent spends 0.40 s/GB in user space against libtorrent's 0.45, but more in the kernel: the extra copy of `pread`, which libtorrent avoids by memory-mapping files. [How it works](HOW-IT-WORKS.md#the-upload-path) explains why Tiny Torrent doesn't.
- **RC4:** Tiny Torrent is about 8% faster than qBittorrent, at 7% less CPU. aria2 is fastest here, using OpenSSL's cipher, but it serves only some of the peers at a time.
- **Memory:** qBittorrent's 1.1 GB is mostly the payload's file pages, which count as resident because libtorrent maps the files into memory.
- **aria2** unchokes a few peers at a time and rotates slowly, so within a 20 s run some connections never received a byte.

### ARM, whole board

Nothing pinned. A single-threaded engine may land on an A55 core, which is about a third as fast, so runs vary more; one Tiny Torrent RC4 run that did reached 0.96 Gbit/s against 2.16 in the other.

| Engine | Plaintext Mbit/s | CPU s/GB | Cores busy | RC4 Mbit/s | Peak RSS MB |
|---|---|---|---|---|---|
| **Tiny Torrent** | **10,256** | 1.45 | 1.9 | 0.96–2.16 | 165 |
| qBittorrent 5.1.0 | 10,992 | 1.62 | 2.2 | 2,009 | 1,096 |
| aria2 1.37 | 5,617 | 1.36 | 1.0 | 1,952 | 68 |
| WebTorrent 3.0.21 | 2,390 | 5.46 | 1.6 | 1,447 | 223 |

Tiny Torrent and qBittorrent are within 7% of each other in plaintext, and Tiny Torrent uses 10% less CPU per GB.

### Mac

Nothing pinned. The bench can't read qBittorrent's memory on macOS.

| Engine | Plaintext Mbit/s | CPU s/GB | RC4 Mbit/s | CPU s/GB | Peak RSS MB |
|---|---|---|---|---|---|
| **Tiny Torrent** | **51,855** | **0.34** | **8,551** | **1.08** | 160–260 |
| qBittorrent 5 (libtorrent 2) | 45,372 | 0.39 | 8,504 | 1.22 | — |
| WebTorrent 3.0.21 | 14,201 | 1.06 | 6,014 | 1.83 | 246–325 |

On the Mac, Tiny Torrent is 14% faster than qBittorrent in plaintext and level with RC4, at less CPU per GB in both.

### Over the internet

- **Through a VPN, ARM to the Mac.** A seeder ran on the ARM board inside the VPN's network namespace (Singapore exit, forwarded port), with four leechers on a Mac at home dialling the exit address. Results: Tiny Torrent 4.9 Mbit/s, aria2 5.5, WebTorrent 4.3. Every engine was held to the same few Mbit/s by the home uplink carrying the tunnel. This run shows that seeding works end to end through a VPN to the internet; it doesn't show any engine's limit.
- **Public swarms.** `real-seed` downloaded Debian and Ubuntu images, then seeded them through the VPN with a reachable forwarded port, for 10–15 minutes. Those swarms had far more seeds than downloaders (the Ubuntu tracker counted 337 seeders and 11 leechers), so a new seed got almost no requests. What the runs do show is etiquette: hundreds of other seeds were met and dropped as `not needed`. Use the local benchmark for capacity.

### Idle cost

A seeding engine with no peers uses:
- about 2.3 ms of CPU per second on the Mac (a bare Bun process with a listener uses 0.8);
- about 1% of an ARM core.

The engine's own tick takes 0.6 µs.

## Engine path and microbenchmarks

Measured on the Mac.

- **Engine path** (`test/perf.test.ts`): a fake peer sends 1,460-byte chunks through the parser, picker, hashing and disk writes. Result: ~1.5 GB/s at 1.2 CPU-seconds per GB, with ~7 bytes of heap growth per 16 KiB block.
- **`bun bench/cli.ts micro`:**
  - wire parser: ~56 Gbit/s;
  - picker: ~1.6 M picks/s, touching ~2 entries per pick on 50,000 pieces;
  - SHA-1: ~27 Gbit/s.

## Running them

```sh
# Downloading
bun bench/cli.ts local --size-mb 1024 --seeders 4 --latency-ms 150 --engines tinytorrent,aria2,webtorrent
bun bench/cli.ts real <file.torrent | url | magnet> --seconds 90 --engines tinytorrent,qbittorrent,aria2,webtorrent

# Seeding
bun bench/cli.ts seeding --size-mb 1024 --seconds 20 --runs 2 --encryption off --engines tinytorrent,qbittorrent,aria2,webtorrent
bun bench/cli.ts seeding … --seeder-cpus 7 --load-cpus 0-6        # Linux: one core for the seeder
bun bench/cli.ts real-seed <file.torrent | url | magnet> --seconds 600 [--port <forwarded port>]

# Hot paths
bun bench/cli.ts micro
```

| Mode | What it does |
|---|---|
| `local` | Creates a payload, runs `--seeders` Tiny Torrent (or `--seeder qbittorrent`) seeders behind latency proxies, and has each engine in `--engines` download it. |
| `real` | Each engine downloads a real torrent for `--seconds`. |
| `seeding` | Each engine in `--engines` seeds to `--leechers` connections from the lean sink (`bench/sink.ts`), or to real Tiny Torrent leechers with `--load leechers`. |
| `real-seed` | Tiny Torrent downloads a real torrent, then seeds it to the swarm for `--seconds`, printing peers, interest and slots every 10 s. |
| `micro` | Parser, picker and SHA-1 throughput. |

| Option | Default | Description |
|---|---|---|
| `--engines` | `tinytorrent` | Comma-separated: `tinytorrent`, `webtorrent`, `aria2`, `qbittorrent` |
| `--seconds` | `120` | Run length for `real`, `real-seed` and `seeding` |
| `--size-mb`, `--piece-kb` | `1024`, `256` | Payload for `local` and `seeding` |
| `--seeders` | `4` | Seeders in `local` |
| `--leechers` | `8` | Connections downloading from the seeder in `seeding` |
| `--load` | `sink` | `seeding` load: `sink` (lean, measures the seeder) or `leechers` (real Tiny Torrent leechers) |
| `--sink-procs` | `4` | Processes the sink connections are spread over |
| `--seeder-cpus`, `--load-cpus` | | Pin the seeder and the load to CPUs, as `taskset -c` lists (Linux) |
| `--latency-ms` | `0` | Added latency per connection (a delaying TCP proxy, no `tc` needed) |
| `--encryption` | `prefer` | Policy for Tiny Torrent. In `seeding`, also what the sink offers: `off` a plain handshake, `prefer-plaintext` MSE with plaintext, `prefer`/`require` MSE with RC4 |
| `--slots` | engine default | Upload slots for the seeder under test |
| `--max-peers` | `200` | |
| `--port` | random | Listening port for `real-seed` (a forwarded port lets peers in) |
| `--no-dht` | | Disable the DHT |
| `--runs` | `1` | Repeat each engine; every run is reported |
| `--json <file>` | | Write results as JSON |
| `--profile <dir>` | | Write Bun CPU profiles in Markdown (in `seeding` mode, of the seeder) |
| `--keep` | | Keep the work directory |
| `--remote <host:port>`, `--torrent <file>` | | `seeding` against a seeder running elsewhere |

**Requirements:**
- aria2 needs `aria2c` on PATH. The Docker image (`bench/Dockerfile`) includes it.
- qBittorrent runs from a throwaway profile. On macOS it uses the app (set `QBT_APP` if it isn't in `/Applications`); elsewhere it uses `qbittorrent-nox` on PATH or `QBT_BIN`. The Docker image includes `qbittorrent-nox`, so `remote.sh` can benchmark it on a server.
- Work files go in `.bench/`, or in `TT_BENCH_DIR` if set.

### On a server, through a VPN

`bench/remote.sh` copies the project to a Docker host over SSH, builds the bench image there, and runs it inside a VPN container's network namespace. Pass `-` instead of a container name for the default network.

```sh
bench/remote.sh <ssh-host> <vpn-container | -> real <url> --seconds 90 --engines aria2,tinytorrent --profile /out
```

The work directory is a tmpfs, and profiles land in `~/ttbench/out` on the host.

To measure seeding over a real network path:
1. Run `bench/remote-seeder.ts <engine> <size-mb> <port>` inside the VPN container's namespace, on a forwarded port. It prints `ready`, then reports its CPU on SIGTERM.
2. From elsewhere, run `bun bench/cli.ts seeding --remote <exit-ip>:<port> --torrent <its payload.torrent>`.

## How they measure

- **Separate processes.** Every engine runs in its own process, and CPU time is read from that process (`/proc` on Linux, `ps` on macOS), so it covers the engine only.
- **Throughput** is payload bytes over wall time.
  - "Steady" excludes the first 20 s of ramp-up.
  - "Peak" is the best 5-second window.
- **Slowest first byte** is the time until the last connection received any data, sampled every half second (every second with `--load leechers`), so 0.5 s is the floor.
- **Fairness** is Jain's index over the leechers' bytes halfway through the run: 1.0 means every leecher got the same.
- **Of it kernel** is the part of the seeder's CPU spent in the kernel (system calls and copies), where it can be read: Linux for qBittorrent, any platform for Tiny Torrent.
- **Peak RSS** is the seeder's maximum resident memory.
- **WebTorrent** runs with two fixes from `patches/`:
  - one stops a crash when an incoming peer reaches a paused torrent;
  - one replaces a per-connection Diffie–Hellman setup that cost about 200 ms of CPU per peer on ARM.

  Without them it can't complete the runs.
