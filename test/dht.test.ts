import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { Dht } from "../src/dht";
import { systemTransport } from "../src/transport";

describe("DHT", () => {
  test("a small network finds an announced peer and saves its nodes", async () => {
    const transport = systemTransport();
    const root = new Dht({ transport, bootstrap: [] });
    await root.start();
    const bootstrap = [`127.0.0.1:${root.port}`];
    const nodes = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const node = new Dht({ transport, bootstrap });
        await node.start();
        return node;
      }),
    );
    await Bun.sleep(300); // bootstrap lookups
    const infoHash = new Uint8Array(randomBytes(20));

    // One node announces port 7777; another looks the hash up
    await nodes[3]!.lookup(infoHash, () => undefined, 7777);
    await Bun.sleep(200);
    const found: string[] = [];
    await nodes[17]!.lookup(infoHash, (peers) => found.push(...peers));
    expect(found).toContain("127.0.0.1:7777");
    expect(nodes[17]!.size).toBeGreaterThan(5);

    // Saved nodes bring a new node up without bootstrap routers
    const saved = nodes[17]!.nodes();
    expect(saved.length % 26).toBe(0);
    const revived = new Dht({ transport, bootstrap: [], nodes: saved });
    await revived.start();
    const again: string[] = [];
    await revived.lookup(infoHash, (peers) => again.push(...peers));
    expect(again).toContain("127.0.0.1:7777");

    for (const n of [root, ...nodes, revived]) n.stop();
  });

  test("ignores garbage datagrams", async () => {
    const dht = new Dht({ transport: systemTransport(), bootstrap: [] });
    await dht.start();
    const { createSocket } = await import("node:dgram");
    const socket = createSocket("udp4");
    for (let i = 0; i < 200; i++) socket.send(randomBytes(Math.floor(Math.random() * 200)), dht.port, "127.0.0.1");
    socket.send(Buffer.from("d1:t2:aa1:y1:q1:q9:find_node1:ad2:id3:badee"), dht.port, "127.0.0.1");
    await Bun.sleep(200);
    expect(dht.counters.received).toBe(0);
    socket.close();
    dht.stop();
  });
});
