/** Shared helpers for tests: temporary directories, payloads and local swarms. */

import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { EngineContext } from "../src/engine";
import { createTorrent, Engine, type EngineOptions, parseTorrent, type Torrent } from "../src/index";
import { RateLimit } from "../src/limits";
import { UdpTrackerClient } from "../src/tracker";
import { systemTransport } from "../src/transport";

/** A temporary directory removed by `cleanup()`. */
export async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tinytorrent-"));
}

/** Files of random bytes written under `dir/name`, with the torrent describing them. */
export async function makePayload(
  dir: string,
  name: string,
  sizes: number[],
  pieceLength = 64 * 1024,
): Promise<{ torrent: Uint8Array; files: Array<{ path: string; data: Uint8Array }> }> {
  const single = sizes.length === 1;
  const files = sizes.map((size, i) => ({ path: single ? "" : `dir${i % 2}/file${i}.bin`, data: new Uint8Array(randomBytes(size)) }));
  for (const f of files) {
    const path = single ? join(dir, name) : join(dir, name, ...f.path.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, f.data);
  }
  return { torrent: createTorrent({ name, files, pieceLength }), files };
}

/** An engine for tests: loopback only, no DHT, no trackers. */
export function testEngine(options: EngineOptions = {}): Engine {
  return new Engine({ dht: false, maxHalfOpen: 50, ...options });
}

/** A seeding engine for a payload already on disk. */
export async function seeder(dir: string, torrent: Uint8Array, options: EngineOptions = {}): Promise<{ engine: Engine; torrent: Torrent; address: string }> {
  const engine = testEngine({ upload: { slots: 100 }, seed: { enabled: true }, ...options });
  const t = engine.add(torrent, { dir });
  await waitFor(t, "done");
  await engine.ready();
  return { engine, torrent: t, address: `127.0.0.1:${engine.port()}` };
}

/** Resolves on the torrent's next `event`, or rejects after `ms`. */
export function waitFor(torrent: Torrent, event: string, ms = 30_000): Promise<unknown> {
  if (event === "done" && (torrent.state === "done" || torrent.state === "seeding")) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event} (${torrent.state}, ${(torrent.progress * 100).toFixed(1)}%)`)), ms);
    torrent.once(event, (value: unknown) => {
      clearTimeout(timer);
      resolve(value);
    });
    torrent.once("error", (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export async function cleanup(...paths: string[]): Promise<void> {
  await Promise.all(paths.map((p) => rm(p, { recursive: true, force: true })));
}

/** A socket that records writes and lets the test push bytes in. */
export class FakeSocket extends EventEmitter {
  public writableNeedDrain = false;
  public written = 0;
  write(data: Uint8Array): boolean {
    this.written += data.length;
    return true;
  }
  destroy(): void {
    this.emit("close");
  }
  setTimeout(): void {}
  pause(): void {}
  resume(): void {}
}

/** An engine context for a `Torrent` driven by hand: no network, no uploads. */
export function fakeContext(): EngineContext {
  const transport = systemTransport();
  return {
    options: {
      encryption: "off",
      maxPeersPerTorrent: 200,
      maxHalfOpen: 30,
      upload: { slots: 0 },
      seed: { enabled: false, ratio: 0, minutes: 0 },
      pex: false,
      maxBufferBytes: 512 * 1024 * 1024,
      uploadCacheBytes: 32 * 1024 * 1024,
    },
    uploadLimit: new RateLimit(),
    downloadLimit: new RateLimit(),
    transport,
    udpTrackers: new UdpTrackerClient(transport),
    peerId: new Uint8Array(20).fill(1),
    port: () => 0,
    announcePort: () => 0,
    allowed: () => true,
    dhtPort: () => 0,
    dhtLookup: () => undefined,
    dhtAddNode: () => undefined,
    halfOpenRoom: () => 0,
    halfOpen: () => undefined,
    removed: () => undefined,
  };
}

export { parseTorrent };
