/**
 * Interoperability with another implementation: WebTorrent 3 (with the
 * fixes in patches/), whose wire protocol and MSE come from bittorrent-protocol.
 * Conformance against libtorrent and Transmission runs in Docker; see
 * docs/DEVELOPMENT.md.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EncryptionPolicy } from "../src/index";
import { cleanup, makePayload, seeder, tempDir, testEngine, waitFor } from "./helpers";

await import("../bench/webtorrent-preload");
const { default: WebTorrent } = await import("webtorrent");

// biome-ignore lint: WebTorrent is untyped here
type Client = any;
const clients: Client[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await new Promise((r) => c.destroy(r));
  for (const f of cleanups.splice(0)) await f();
});

function webtorrent(secure: boolean): Client {
  const client = new WebTorrent({ dht: false, tracker: false, lsd: false, utp: false, webSeeds: false, secure } as never);
  clients.push(client);
  return client;
}

async function payload() {
  const dir = await tempDir();
  const out = await tempDir();
  cleanups.push(() => cleanup(dir, out));
  const p = await makePayload(dir, "interop", [900_000, 300_000], 32 * 1024);
  return { dir, out, ...p };
}

async function sameFiles(dir: string, files: Array<{ path: string; data: Uint8Array }>): Promise<void> {
  for (const f of files) expect(Buffer.from(await readFile(join(dir, "interop", ...f.path.split("/")))).equals(f.data)).toBe(true);
}

describe("interop with WebTorrent", () => {
  for (const [secure, policy] of [
    [false, "prefer"],
    [false, "off"],
    [true, "prefer"],
    [true, "require"],
  ] as Array<[boolean, EncryptionPolicy]>) {
    test(`WebTorrent seeds (secure=${secure}), tinytorrent leeches (${policy})`, async () => {
      const p = await payload();
      const client = webtorrent(secure);
      const seeding = client.add(Buffer.from(p.torrent), { path: p.dir });
      await new Promise((r) => seeding.once("done", r));
      await new Promise((r) => (client.torrentPort ? r(null) : client.once("listening", r)));
      const engine = testEngine({ encryption: policy });
      cleanups.push(() => engine.destroy());
      const t = engine.add(p.torrent, { dir: p.out, peers: [`127.0.0.1:${client.torrentPort}`] });
      await waitFor(t, "done", 20_000);
      await sameFiles(p.out, p.files);
    }, 25_000);
  }

  for (const [secure, policy] of [
    [false, "prefer"],
    [true, "prefer"],
    [true, "require"],
    [false, "prefer-plaintext"],
  ] as Array<[boolean, EncryptionPolicy]>) {
    test(`tinytorrent seeds (${policy}), WebTorrent leeches (secure=${secure})`, async () => {
      const p = await payload();
      const seed = await seeder(p.dir, p.torrent, { encryption: policy });
      cleanups.push(() => seed.engine.destroy());
      const client = webtorrent(secure);
      const t = client.add(Buffer.from(p.torrent), { path: p.out });
      t.once("infoHash", () => t.addPeer(seed.address));
      t.once("ready", () => t.addPeer(seed.address));
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`WebTorrent stuck at ${(t.progress * 100).toFixed(1)}%`)), 20_000);
        t.once("done", () => {
          clearTimeout(timer);
          resolve(null);
        });
      });
      await sameFiles(p.out, p.files);
      expect(seed.torrent.uploaded).toBeGreaterThanOrEqual(1_200_000);
    }, 25_000);
  }
});
