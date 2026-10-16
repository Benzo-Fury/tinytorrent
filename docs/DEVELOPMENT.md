# Development

> In-depth reference for working on the engine itself, by people or by agents. Using Tiny Torrent doesn't need any of this; see the [README](../README.md).

**On this page:** [Quick commands](#quick-commands) · [Repository layout](#repository-layout) · [Rules for changes](#rules-for-changes) · [Tests](#tests) · [Conformance against real clients](#conformance-against-real-clients) · [Line budget](#line-budget) · [Benchmarks](#benchmarks) · [Documentation](#documentation) · [Checklist](#checklist-before-you-call-a-change-done)

---

## Quick commands

```sh
bun install               # dev dependencies only: TypeScript, Bun types, WebTorrent (for interop tests and benchmarks)
bun test                  # the full suite, about two minutes
bun test test/seeding     # one file
bunx tsc --noEmit         # type check
bun scripts/lines.ts      # line budget; fails when over
bun bench/cli.ts micro    # quick hot-path numbers
sh conformance/run.sh     # Docker: against libtorrent and Transmission
```

## Repository layout

| Path | Contents |
|---|---|
| `src/` | The engine. `index.ts` is the only public entry point. Modules are described in [How it works](HOW-IT-WORKS.md#architecture). |
| `test/` | `bun test` suites, plus `helpers.ts`: `tempDir`, `makePayload`, `testEngine`, `seeder`, `waitFor` (an event, with a timeout), `cleanup`, `FakeSocket` and `fakeContext` |
| `bench/` | The benchmark CLI (`cli.ts`) and its parts: leecher and seeder processes per engine, the lean sink load for seeding, the latency proxy, `real-seed`, microbenchmarks, the remote runner, and the Docker image |
| `conformance/` | The Docker suite against libtorrent and Transmission: a recording tracker, a Tiny Torrent peer, a libtorrent peer (Python) |
| `scripts/lines.ts` | The line budget |
| `patches/` | Fixes to WebTorrent and `bittorrent-protocol`, used only by interop tests and benchmarks |
| `docs/` | This reference |

The package has **no runtime dependencies**. `devDependencies` exist for tests and benchmarks only.

## Rules for changes

These rules keep the engine tiny, fast and safe. A change that breaks one needs a very good reason, written down in [How it works](HOW-IT-WORKS.md#design-choices).

1. **No runtime dependencies and no native code.** Everything is TypeScript over `node:` modules, so it runs anywhere Bun does.
2. **Every socket goes through the `Transport`.** Opening a socket any other way would bypass `boundTransport()` for users who bind the engine to a VPN or interface.
3. **One timer.** Periodic work hangs off the engine's 250 ms tick (`Torrent.tick`, `Swarm.tick`). Don't add `setInterval`.
4. **Hot paths stay allocation-light.** Per-byte and per-block code (`wire.ts`, `mse.ts`, `picker.ts`, the upload path) must not add copies, closures or streams. Check `perf.test.ts` and the seeding bench after touching them.
5. **Mechanism, not policy.** Queues, blocklist formats and UI belong to applications. The engine offers hooks such as `allowPeer`, `pause` and `stats`.
6. **Stay within the line budget.** Going over is a design problem, not a reason to raise the budget.
7. **Every bug fix comes with a test that fails without the fix.** Confirm it fails on the old code before you commit it.
8. **Public API changes** go through `src/index.ts`, with doc comments on every exported declaration, and update the [README](../README.md) and [API reference](API.md).

**Code style:**
- Doc comments in plain prose on every declaration.
- A short comment heading each block of logic.
- Strict TypeScript with no `any`.
- Constants in `UPPER_CASE` at the top of their module.

## Tests

`bun test` runs everything. The suites use real sockets on loopback and real files in temporary directories. Only the choker, endgame and perf tests use fake peers.

| File | Covers |
|---|---|
| `bencode.test.ts` | Types, zero-copy views, sorted keys, binary keys, the `info` span, malformed input, 5,000-case fuzz |
| `metainfo.test.ts` | Single- and multi-file torrents, padding files, path traversal, magnets (hex and base32), `so=` |
| `create.test.ts` | Torrents from a directory (sorted, symlinks skipped, identical to the in-memory builder) and from a file (tiers, private, comment, web seeds, dates); piece-size choice; bad input; create → seed mode → download; padding files never written and verified across |
| `wire.test.ts` | Identical events for every way of splitting the stream, discarded blocks, oversized messages, fuzz, write batching |
| `mse.test.ts` | BigInt DH against `node:crypto`, JS RC4 against native RC4, both selections, fragmented delivery, garbage input |
| `picker.test.ts` | Bucket invariants under random operations, rarest-first, partial-first, endgame, failed pieces, one writer per block, the memory limit, O(log n) on 50,000 pieces |
| `storage.test.ts` | Piece-to-file mapping, sparse full-length files, unselected files, padding gaps reading as zeros into reused buffers, re-check, resume state, smart ban |
| `cache.test.ts` | The upload read cache (one read per window, shared reads, the LRU bound, blocks across windows, evicted windows reused only after pending callbacks and never for `put` data), rate-limit buckets, `OutBuffer` hand-over and its pool (a buffer is reused only once the socket gives it back) |
| `choker.test.ts` | The choker tick by tick: seeding unchokes newcomers within a second while peers keep up, doesn't grow for peers that take nothing, rotates so everyone gets a turn, frees a slot when interest is lost; tit for tat while downloading; zero slots |
| `endgame.test.ts` | Endgame with fake peers: a discarded duplicate returns its request, a peer stalled mid-block is dropped, drifted request counts are rebuilt |
| `tracker.test.ts` | UDP and HTTP trackers against local fakes, back-off, `started` → `completed` → `stopped` → `started`, `min interval` |
| `dht.test.ts` | A 21-node local DHT finds an announced peer; saved nodes revive a node; garbage datagrams |
| `ipv6.test.ts` | A download over `::1`, PEX `added6` and seed flags, a 13-node IPv6 DHT with 38-byte saved nodes |
| `portmap.test.ts` | NAT-PMP and UPnP IGD (SSDP, description, SOAP, permanent-lease fallback, deletion) against fake gateways; fallback order; failing closed on a bound transport; the engine announcing the mapped port |
| `engine.test.ts` | End to end over loopback: multi-file, all 16 encryption-policy pairs, the metadata-only gate, magnets, a trading swarm, upload disabled, pause/resume, the killswitch, resume trust and re-check, corrupt peers, a slow disk pausing peers so piece writes in flight stay bounded, a bound transport failing closed, stats |
| `seeding.test.ts` | Ratio and time limits (`seeded`), per-torrent overrides, totals and seed time across restarts, seeding at once from resume state, seed mode and its fall-back to a re-check, `recheck()`, adding paused, `so=`, rate limits, `allowPeer`, seeds dropping seeds and `upload_only`, a finished non-seeding torrent refusing peers, the tracker lifecycle with exact `left`, `engine.stats()`, a peer closed mid-chunk, large uploads to three leechers over plaintext and RC4 through a churning cache arriving intact |
| `interop.test.ts` | Against WebTorrent in both directions, plaintext and MSE |
| `version.test.ts` | The peer id prefix and client name follow `package.json`'s version |
| `perf.test.ts` | Gates: at least 300 MB/s on the engine path and under 1 KB of heap growth per block. Set `TT_PERF_SCALE` to loosen them on slow CI machines |

**Writing tests:**
- **Choose the right level.** Use real engines on loopback for behaviour, and `FakeSocket` with the fake engine context (`test/helpers.ts`) for tick-by-tick logic like the choker and endgame.
- **Wait for events, not times.** Use `waitFor(torrent, "done")` and similar; fixed sleeps make tests slow and flaky.
- **Clean up.** Destroy engines and remove temporary directories in `afterEach`/`finally`; a leaked listener keeps `bun test` alive.

## Conformance against real clients

`sh conformance/run.sh` runs on any Docker host. It builds a libtorrent peer (Debian's `python3-libtorrent`, the engine inside qBittorrent and Deluge) and pulls Transmission. Then it runs every case on a private Docker network, with a fresh recording tracker per case:

| Cases | Directions |
|---|---|
| libtorrent and Transmission seed, Tiny Torrent downloads | Each encryption pairing, `.torrent` and magnet |
| Tiny Torrent seeds, libtorrent and Transmission download | Each encryption pairing, including seed mode (nothing hashed before serving) |
| A v1+v2 hybrid torrent with padding files, made by libtorrent | libtorrent seeds it to Tiny Torrent; Tiny Torrent seeds it from disk to libtorrent |

Each case prints `OK` or `FAIL` with a reason, and the script exits non-zero if any case fails. Run it after any change to the wire protocol, encryption, extensions, storage or seeding.

To run it on a remote server, copy the project there (or use the `tar … | ssh` approach in `bench/remote.sh`) and run the script on that host.

## Line budget

`bun scripts/lines.ts` counts code lines in `src/`, leaving out comments and blank lines. It checks two limits:
- **the total:** 5,000;
- **a ceiling per module,** so one file can't quietly absorb the savings made elsewhere.

It prints each module's lines, code lines and ceiling, and exits non-zero when anything is over.

If you need room:
- First look for code that can go: duplication, special cases a general mechanism already covers, or helpers used only by tests (move those into `test/`).
- A module's ceiling may move if its job grew and another module's shrank, as long as the total holds.

## Benchmarks

Everything about running benchmarks, including on a server with or without a VPN, is in [Benchmarks](BENCHMARKS.md#running-them). Which ones to rerun depends on the change:

| You changed | Rerun |
|---|---|
| `wire.ts`, `mse.ts`, `picker.ts`, `storage.ts`, `verifier.ts` | `bun test test/perf`, `bench micro`, `bench local --latency-ms 150` |
| Choking, the upload path, cache, limits | `bench seeding --engines tinytorrent,qbittorrent --runs 2 --seeder-cpus 7 --load-cpus 0-6` on the ARM server, with `--encryption off` and `prefer`. The lean sink is the default load, so the seeder is what's measured; pinning to one core makes runs comparable. Watch the kernel column as well as the total: most of the seeding cost is system calls and copies |
| Peer discovery, connections, trackers, DHT | `bench real <torrent>` against qBittorrent and aria2 on the ARM server, both with no VPN and through it |

Compare against the [targets](BENCHMARKS.md#targets), and update the results tables if numbers move.

## Documentation

| What changed | Update |
|---|---|
| Anything a user sees: options, methods, events, behaviour | The [README](../README.md), so it stays enough on its own, and the [API reference](API.md) |
| How or why something works | [How it works](HOW-IT-WORKS.md) |
| A new `stats()` field, warning or close reason | [Troubleshooting](TROUBLESHOOTING.md) |
| Performance | [Benchmarks](BENCHMARKS.md) |
| Tests, tooling or rules | This page |

Write docs for someone at release time who is looking for one specific thing. Describe what the engine does and why, not the history of how it got there.

## Checklist before you call a change done

- [ ] `bun test` passes, including perf gates.
- [ ] `bunx tsc --noEmit` is clean.
- [ ] `bun scripts/lines.ts` is within budget.
- [ ] A regression test exists for any bug fixed, and it fails without the fix.
- [ ] `sh conformance/run.sh` passes if protocol, storage or seeding code changed.
- [ ] Benchmarks rerun if a hot path changed, and the numbers still meet the targets.
- [ ] README and docs updated.
