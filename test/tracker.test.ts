import { describe, expect, test } from "bun:test";
import dgram from "node:dgram";
import { encode } from "../src/bencode";
import { Announcer, httpAnnounce, UdpTrackerClient } from "../src/tracker";
import { systemTransport } from "../src/transport";

const request = {
  infoHash: new Uint8Array(20).fill(0xab),
  peerId: new Uint8Array(20).fill(0x2d),
  port: 6881,
  stats: { downloaded: 1, uploaded: 2, left: 3 },
  event: "started" as const,
  numWant: 50,
};

/** A UDP tracker speaking BEP 15, handing out two peers. */
async function udpTracker(): Promise<{ port: number; announces: Buffer[]; close: () => void }> {
  const socket = dgram.createSocket("udp4");
  const announces: Buffer[] = [];
  socket.on("message", (msg, rinfo) => {
    const action = msg.readUInt32BE(8);
    const tid = msg.readUInt32BE(12);
    if (action === 0) {
      const reply = Buffer.alloc(16);
      reply.writeUInt32BE(0, 0);
      reply.writeUInt32BE(tid, 4);
      reply.writeBigUInt64BE(0x1234n, 8);
      socket.send(reply, rinfo.port, rinfo.address);
    } else if (action === 1) {
      announces.push(msg);
      const reply = Buffer.alloc(32);
      reply.writeUInt32BE(1, 0);
      reply.writeUInt32BE(tid, 4);
      reply.writeUInt32BE(900, 8);
      reply.writeUInt32BE(5, 12);
      reply.writeUInt32BE(9, 16);
      Buffer.from([10, 0, 0, 1, 0x1a, 0xe1, 10, 0, 0, 2, 0x1a, 0xe2]).copy(reply, 20);
      socket.send(reply, rinfo.port, rinfo.address);
    }
  });
  await new Promise<void>((r) => socket.bind(0, "127.0.0.1", r));
  return { port: socket.address().port, announces, close: () => socket.close() };
}

describe("trackers", () => {
  test("UDP: connect, announce, peers", async () => {
    const tracker = await udpTracker();
    const client = new UdpTrackerClient(systemTransport());
    const result = await client.announce(new URL(`udp://127.0.0.1:${tracker.port}/announce`), request);
    expect(result).toEqual({ interval: 900, leechers: 5, seeders: 9, peers: ["10.0.0.1:6881", "10.0.0.2:6882"] });
    const msg = tracker.announces[0]!;
    expect(msg.readBigUInt64BE(0)).toBe(0x1234n); // used the connection id
    expect(msg.subarray(16, 36).equals(Buffer.from(request.infoHash))).toBe(true);
    expect(msg.readUInt32BE(80)).toBe(2); // started
    expect(msg.readUInt16BE(96)).toBe(6881);
    await client.close();
    tracker.close();
  });

  test("HTTP: query string, compact and dictionary peers, failures", async () => {
    let query = "";
    let reply: Uint8Array = encode({ interval: 1200, peers: Uint8Array.of(1, 2, 3, 4, 0, 80), peers6: new Uint8Array(0) });
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        query = new URL(req.url).search;
        return new Response(reply);
      },
    });
    const url = `http://127.0.0.1:${server.port}/announce?key=k`;
    expect((await httpAnnounce(systemTransport(), url, request)).peers).toEqual(["1.2.3.4:80"]);
    expect(query).toContain("info_hash=%ab%ab");
    expect(query).toContain("key=k&info_hash");
    expect(query).toContain("event=started");
    expect(query).toContain("compact=1");

    reply = encode({ interval: 60, peers: [{ ip: "5.6.7.8", port: 99 }, { ip: "::1", port: 7 }] });
    expect((await httpAnnounce(systemTransport(), url, request)).peers).toEqual(["5.6.7.8:99", "[::1]:7"]);

    reply = encode({ "failure reason": "unregistered torrent" });
    await expect(httpAnnounce(systemTransport(), url, request)).rejects.toThrow("unregistered torrent");
    server.stop(true);
  });

  test("the announcer asks every tracker and backs off from failing ones", async () => {
    const tracker = await udpTracker();
    const udp = new UdpTrackerClient(systemTransport());
    const found: string[] = [];
    const announcer = new Announcer(
      [`udp://127.0.0.1:${tracker.port}`, "http://127.0.0.1:1/announce", "wss://ignored"],
      systemTransport(),
      udp,
      () => request,
      (peers) => found.push(...peers),
    );
    expect(announcer.trackers.length).toBe(2);
    announcer.tick(Date.now());
    await Bun.sleep(300);
    expect(found).toEqual(["10.0.0.1:6881", "10.0.0.2:6882"]);
    const [ok, bad] = announcer.trackers;
    expect(ok!.interval).toBe(900);
    expect(bad!.failures).toBe(1);
    expect(bad!.nextAt).toBeGreaterThan(Date.now() + 30_000);

    // completed, then stopped; after stopping, the next announce is a fresh started
    announcer.completed();
    await announcer.stop();
    await Bun.sleep(100);
    expect(tracker.announces.map((m) => m.readUInt32BE(80))).toEqual([2, 1, 3]);
    expect(ok!.interval).toBe(0);
    announcer.tick(Date.now());
    await Bun.sleep(200);
    expect(tracker.announces[3]!.readUInt32BE(80)).toBe(2);
    await udp.close();
    tracker.close();
  });

  test("HTTP: honours min interval", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(encode({ interval: 60, "min interval": 900, peers: new Uint8Array(0) })) });
    const result = await httpAnnounce(systemTransport(), `http://127.0.0.1:${server.port}/a`, request);
    expect(result.minInterval).toBe(900);
    const announcer = new Announcer([`http://127.0.0.1:${server.port}/a`], systemTransport(), new UdpTrackerClient(systemTransport()), () => request, () => undefined);
    announcer.tick(Date.now());
    await Bun.sleep(200);
    expect(announcer.trackers[0]!.interval).toBe(900);
    server.stop(true);
  });
});

