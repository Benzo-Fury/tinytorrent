/** IPv6: peers over ::1, PEX with `added6`, and a DHT network on IPv6 (BEP 32). */

import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Dht } from "../src/dht";
import { compactPeers6, format6, parsePex, pexMessage, toCompact6 } from "../src/extensions";
import { type Engine, systemTransport } from "../src/index";
import { cleanup, makePayload, seeder, tempDir, testEngine, waitFor } from "./helpers";

const engines: Engine[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((e) => e.destroy()));
  await cleanup(...dirs.splice(0));
});

describe("IPv6", () => {
  test("downloads from a seeder over ::1, and the seeder sees a bracketed address", async () => {
    const seedDir = await tempDir();
    const leechDir = await tempDir();
    dirs.push(seedDir, leechDir);
    const payload = await makePayload(seedDir, "payload", [300_000], 16 * 1024);
    const seed = await seeder(seedDir, payload.torrent);
    engines.push(seed.engine);
    const leech = testEngine();
    engines.push(leech);
    // Slowed down, so the connection lasts long enough to be seen
    const t = leech.add(payload.torrent, { dir: leechDir, peers: [`[::1]:${seed.engine.port()}`], limits: { downloadBytesPerSecond: 150_000 } });
    const sawPeer = new Promise<string>((resolve) => {
      const poll = setInterval(() => {
        const peer = [...seed.torrent.peers][0];
        if (peer) {
          clearInterval(poll);
          resolve(peer.address);
        }
      }, 5);
    });
    await waitFor(t, "done");
    expect(Buffer.from(await readFile(join(leechDir, "payload"))).equals(payload.files[0]!.data)).toBe(true);
    expect(await sawPeer).toMatch(/^\[::1\]:\d+$/);
  }, 30_000);

  test("PEX carries IPv6 peers in added6, compressed as sockets print them", () => {
    const added = ["10.1.2.3:6881", "[2001:db8::1]:51413", "[fe80::1:0:0:2]:1"];
    const parsed = parsePex(pexMessage(added, []));
    expect(parsed).toEqual(added);
    expect(compactPeers6(toCompact6(["[::]:9"]))).toEqual(["[::]:9"]);
    expect(format6(new Uint8Array(16).fill(0xff), 0)).toBe("ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff");

    // Seeds are flagged, and a seed reading PEX leaves them out
    const flagged = pexMessage(["1.2.3.4:5", "5.6.7.8:9", "[::1]:7"], [], new Set(["5.6.7.8:9", "[::1]:7"]));
    expect(parsePex(flagged)).toEqual(["1.2.3.4:5", "5.6.7.8:9", "[::1]:7"]);
    expect(parsePex(flagged, true)).toEqual(["1.2.3.4:5"]);
  });

  test("an IPv6 DHT network finds an announced peer and saves 38-byte nodes", async () => {
    const transport = systemTransport();
    const root = new Dht({ transport, family: 6, bootstrap: [] });
    await root.start();
    const bootstrap = [`[::1]:${root.port}`];
    const nodes = await Promise.all(
      Array.from({ length: 12 }, async () => {
        const node = new Dht({ transport, family: 6, bootstrap });
        await node.start();
        return node;
      }),
    );
    await Bun.sleep(300);
    const infoHash = new Uint8Array(randomBytes(20));
    await nodes[2]!.lookup(infoHash, () => undefined, 7777);
    await Bun.sleep(200);
    const found: string[] = [];
    await nodes[9]!.lookup(infoHash, (peers) => found.push(...peers));
    expect(found).toContain("[::1]:7777");
    const saved = nodes[9]!.nodes();
    expect(saved.length).toBeGreaterThan(0);
    expect(saved.length % 38).toBe(0);
    for (const n of [root, ...nodes]) n.stop();
  });
});
