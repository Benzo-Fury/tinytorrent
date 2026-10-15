/**
 * Port mapping against fake gateways on loopback: a NAT-PMP server, and a
 * UPnP IGD found over SSDP. Also: it fails closed on a bound transport with
 * no address, and the engine announces the external port it got.
 */

import { afterEach, describe, expect, test } from "bun:test";
import dgram from "node:dgram";
import { boundTransport, type Engine, systemTransport } from "../src/index";
import { PortMapper } from "../src/portmap";
import { cleanup, makePayload, tempDir, testEngine } from "./helpers";
import { createTorrent } from "../src/create";

const closers: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** The external port the fake gateway hands out for an internal one, like a VPN choosing a port. */
const external = (internal: number): number => 1024 + ((internal + 10_000) % 60_000);

/** A NAT-PMP gateway that maps every request to `external(internal)`. */
async function natPmpServer(lifetime = 3600) {
  const socket = dgram.createSocket("udp4");
  const requests: Array<{ op: number; internal: number; external: number; lifetime: number }> = [];
  socket.on("message", (msg, rinfo) => {
    if (msg.length < 12) return;
    const op = msg[1] as number;
    const internal = msg.readUInt16BE(4);
    requests.push({ op, internal, external: msg.readUInt16BE(6), lifetime: msg.readUInt32BE(8) });
    const reply = Buffer.alloc(16);
    reply[1] = 128 + op;
    reply.writeUInt32BE(1234, 4);
    reply.writeUInt16BE(internal, 8);
    reply.writeUInt16BE(msg.readUInt32BE(8) ? external(internal) : 0, 10);
    reply.writeUInt32BE(msg.readUInt32BE(8) ? lifetime : 0, 12);
    socket.send(reply, rinfo.port, rinfo.address);
  });
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  closers.push(() => socket.close());
  return { port: socket.address().port, requests };
}

/** A UPnP gateway: an SSDP responder and an HTTP device with a WANIPConnection service. */
async function upnpGateway(onlyPermanent: boolean) {
  const calls: Array<{ action: string; body: string }> = [];
  const http = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/desc.xml") {
        return new Response(
          `<?xml version="1.0"?><root><device><deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType><deviceList><device><serviceList><service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/ctl</controlURL></service></serviceList></device></deviceList></device></root>`,
        );
      }
      const action = (request.headers.get("soapaction") ?? "").replace(/.*#|"/g, "");
      const body = await request.text();
      calls.push({ action, body });
      if (action === "AddPortMapping" && onlyPermanent && !body.includes("<NewLeaseDuration>0<")) {
        return new Response("<s:Envelope><s:Body><s:Fault><detail><UPnPError><errorCode>725</errorCode></UPnPError></detail></s:Fault></s:Body></s:Envelope>", { status: 500 });
      }
      return new Response("<ok/>");
    },
  });
  const ssdp = dgram.createSocket("udp4");
  let searches = 0;
  ssdp.on("message", (msg, rinfo) => {
    if (!msg.toString().startsWith("M-SEARCH")) return;
    searches++;
    ssdp.send(`HTTP/1.1 200 OK\r\nST: upnp:rootdevice\r\nLOCATION: http://127.0.0.1:${http.port}/desc.xml\r\n\r\n`, rinfo.port, rinfo.address);
  });
  await new Promise<void>((resolve) => ssdp.bind(0, "127.0.0.1", resolve));
  closers.push(() => http.stop(true), () => ssdp.close());
  return { ssdpAddress: `127.0.0.1:${ssdp.address().port}`, calls, searches: () => searches };
}

describe("port mapping", () => {
  test("NAT-PMP maps TCP and UDP, reports the external ports, and unmaps on stop", async () => {
    const gateway = await natPmpServer();
    const mapper = new PortMapper(systemTransport(), { tcp: 6881, udp: 6882 }, { gateway: "127.0.0.1", natPmpPort: gateway.port, methods: ["natpmp"] });
    const mapped = new Promise((resolve) => mapper.once("mapped", resolve));
    await mapper.start();
    await mapped;
    expect(mapper.external("tcp")).toBe(external(6881));
    expect(mapper.external("udp")).toBe(external(6882));
    expect(gateway.requests.map((r) => [r.op, r.internal, r.lifetime])).toEqual([
      [2, 6881, 3600],
      [1, 6882, 3600],
    ]);
    await mapper.stop();
    expect(gateway.requests.slice(2).map((r) => [r.op, r.lifetime])).toEqual([
      [2, 0],
      [1, 0],
    ]);
  });

  test("UPnP: discovered over SSDP, retries with a permanent lease when told to, deletes on stop", async () => {
    const gateway = await upnpGateway(true);
    const mapper = new PortMapper(systemTransport(), { tcp: 7001, udp: 7002 }, { ssdpAddress: gateway.ssdpAddress, methods: ["upnp"] });
    await mapper.start();
    expect(gateway.searches()).toBeGreaterThan(0);
    expect(mapper.mappings.map((m) => [m.protocol, m.external, m.method])).toEqual([
      ["tcp", 7001, "upnp"],
      ["udp", 7002, "upnp"],
    ]);
    const adds = gateway.calls.filter((c) => c.action === "AddPortMapping");
    expect(adds.length).toBe(4); // refused with a lease, accepted without, for each protocol
    expect(adds[1]!.body).toContain("<NewInternalClient>127.0.0.1</NewInternalClient>");
    expect(adds[1]!.body).toContain("<NewProtocol>TCP</NewProtocol>");
    await mapper.stop();
    expect(gateway.calls.filter((c) => c.action === "DeletePortMapping").length).toBe(2);
  });

  test("falls back from NAT-PMP to UPnP, and warns when nothing works", async () => {
    const gateway = await upnpGateway(false);
    const silent = dgram.createSocket("udp4"); // a gateway that never answers NAT-PMP
    await new Promise<void>((resolve) => silent.bind(0, "127.0.0.1", resolve));
    closers.push(() => silent.close());
    const mapper = new PortMapper(systemTransport(), { tcp: 7101, udp: 0 }, { gateway: "127.0.0.1", natPmpPort: silent.address().port, ssdpAddress: gateway.ssdpAddress });
    await mapper.start();
    expect(mapper.mappings).toEqual([{ protocol: "tcp", internal: 7101, external: 7101, method: "upnp" }]);
    await mapper.stop();

    const nothing = new PortMapper(systemTransport(), { tcp: 7102, udp: 0 }, { gateway: "127.0.0.1", natPmpPort: silent.address().port, ssdpAddress: `127.0.0.1:${silent.address().port}` });
    const warning = new Promise<string>((resolve) => nothing.once("warning", resolve));
    await nothing.start();
    expect(await warning).toContain("Port mapping failed");
  }, 20_000);

  test("fails closed: a bound transport without an address sends nothing", async () => {
    const gateway = await natPmpServer();
    const mapper = new PortMapper(boundTransport({ address: () => null }), { tcp: 6881, udp: 6881 }, { gateway: "127.0.0.1", natPmpPort: gateway.port });
    const warning = new Promise<string>((resolve) => mapper.once("warning", resolve));
    await mapper.start();
    await warning;
    expect(gateway.requests.length).toBe(0);
    expect(mapper.mappings.length).toBe(0);
  });

  test("the engine announces the mapped port to trackers", async () => {
    const gateway = await natPmpServer();
    const ports: number[] = [];
    const tracker = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        ports.push(Number(new URL(request.url).searchParams.get("port")));
        return new Response(new Uint8Array(Buffer.from("d8:intervali1800e5:peers0:e")));
      },
    });
    const dir = await tempDir();
    closers.push(() => tracker.stop(true), () => cleanup(dir));
    const engine: Engine = testEngine({ portMapping: { gateway: "127.0.0.1", natPmpPort: gateway.port, methods: ["natpmp"] } });
    closers.push(() => engine.destroy());
    const payload = await makePayload(dir, "p", [10_000]);
    const torrent = createTorrent({ name: "p", files: payload.files, announce: [`http://127.0.0.1:${tracker.port}/announce`] });
    const mapped = new Promise((resolve) => engine.once("portMapping", resolve));
    engine.add(torrent, { dir: await tempDir(), start: "metadata-only" });
    await mapped;
    expect(engine.announcePort()).toBe(external(engine.port()));
    expect(engine.stats().mappings.length).toBe(1); // TCP only: the DHT is off in tests
    // The first announce may have gone out before the mapping; the next carries the external port
    for (let i = 0; i < 40 && !ports.includes(external(engine.port())); i++) await Bun.sleep(50);
    expect(ports).toContain(external(engine.port()));
  });
});
