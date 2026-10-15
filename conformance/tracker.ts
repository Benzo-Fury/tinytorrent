/**
 * A recording HTTP tracker for the conformance network: every announcing
 * peer is remembered by info hash and handed to the others.
 *
 *   bun conformance/tracker.ts <port>
 */

import { encode } from "../src/bencode";

const swarms = new Map<string, Map<string, Uint8Array>>();

const server = Bun.serve({
  port: Number(process.argv[2] ?? 8000),
  hostname: "0.0.0.0",
  fetch(req, srv) {
    const url = new URL(req.url);
    // info_hash is raw bytes percent-encoded; decode to hex without UTF-8 mangling
    const raw = /info_hash=([^&]+)/.exec(url.search)?.[1] ?? "";
    const infoHash = Buffer.from(unescape(raw), "latin1").toString("hex");
    const port = Number(url.searchParams.get("port"));
    const ip = (srv.requestIP(req)?.address ?? "").replace(/^::ffff:/, "");
    const swarm = swarms.get(infoHash) ?? new Map<string, Uint8Array>();
    swarms.set(infoHash, swarm);
    const self = `${ip}:${port}`;
    if (url.searchParams.get("event") === "stopped") swarm.delete(self);
    else if (port && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) swarm.set(self, Uint8Array.of(...ip.split(".").map(Number), port >> 8, port & 255));
    const peers = [...swarm.entries()].filter(([key]) => key !== self).map(([, compact]) => compact);
    console.log(`announce ${infoHash.slice(0, 8)} from ${self} (${url.searchParams.get("event") ?? "-"}) → ${peers.length} peers`);
    return new Response(encode({ interval: 5, "min interval": 5, peers: Buffer.concat(peers) }));
  },
});
console.log(`tracker on ${server.port}`);
