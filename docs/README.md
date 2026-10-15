# Tiny Torrent in depth

> **You probably don't need most of this folder.** To use Tiny Torrent, read the [README](../README.md); its recipes cover every feature. The [API reference](API.md) lists every option, method and event. The other pages are for working on the engine itself, or for when you need the exact detail behind something: a field in `stats()`, why a design choice was made, or how a benchmark was measured.

## Where to look

| You want to… | Read |
|---|---|
| Look up an exact option, method, event, type or default | [API reference](API.md) |
| Understand how a part of the engine works, or why it was built that way | [How it works](HOW-IT-WORKS.md) |
| Find out what a `stats()` field means, or fix a specific problem | [Troubleshooting](TROUBLESHOOTING.md) |
| See performance results, the targets, or rerun a benchmark | [Benchmarks](BENCHMARKS.md) |
| Change the code: layout, tests, conformance, line budget, rules | [Development](DEVELOPMENT.md) |

## The pages

**[API reference](API.md)** covers every export:
- `Engine` and its options;
- `engine.add` options;
- `Torrent` with its properties, states, methods and events;
- the `stats()` types;
- torrent creation and parsing;
- transports.

**[How it works](HOW-IT-WORKS.md)** covers:
- the architecture and the modules;
- how a download flows, from finding peers to verified data on disk;
- the seeding design: the choker, the upload path, seed mode and limits;
- networking: optional address binding (e.g. to a VPN), port mapping, IPv6 and encryption;
- the standards supported and those left out on purpose;
- design choices that would otherwise be surprising.

**[Troubleshooting](TROUBLESHOOTING.md)** is organised by symptom (no peers, slow, nobody downloads from my seed, re-hashing, CPU, files). It also has a field-by-field guide to `torrent.stats()` and `engine.stats()`.

**[Benchmarks](BENCHMARKS.md)** has the performance targets, the results on ARM and Apple hardware, how each one is measured, and the commands to run them yourself.

**[Development](DEVELOPMENT.md)** covers:
- the repository layout;
- what each test file covers;
- the Docker conformance suite against libtorrent and Transmission;
- the line budget;
- running benchmarks on a remote server;
- the rules a change should follow.
