/**
 * Every socket the engine opens goes through a `Transport`: peer connections,
 * the listening server, UDP (trackers, DHT, NAT-PMP, SSDP) and HTTP
 * (trackers, UPnP).
 * `boundTransport` pins all of them to one local address, re-resolved for
 * every socket, which is how a VPN killswitch keeps traffic on the tunnel.
 * HTTP trackers use `node:http` with `localAddress`, so unlike `fetch` they
 * can be bound too.
 */

import dgram from "node:dgram";
import http from "node:http";
import https from "node:https";
import net from "node:net";

/** The engine's view of the network. */
export interface Transport {
  /** Opens a TCP connection to a peer. */
  connect(host: string, port: number): net.Socket;
  /** Accepts peer connections on `port` (0 for any). */
  listen(port: number, onConnection: (socket: net.Socket) => void): Promise<net.Server>;
  /** A UDP socket, bound to `port` (0 for any); IPv4 unless `family` is 6 or the bound address is IPv6. */
  udp(port: number, family?: 4 | 6): Promise<dgram.Socket>;
  /** GETs a URL (trackers), following redirects. */
  httpGet(url: string, timeoutMs: number): Promise<Uint8Array>;
  /** One HTTP request without redirects (UPnP); resolves with any status, and the local address used. */
  http(url: string, init: HttpInit): Promise<HttpReply>;
  /** The address sockets are bound to, if any. */
  localAddress(): string | undefined;
}

/** An HTTP request for `Transport.http`. */
export interface HttpInit {
  method: string;
  body?: string;
  headers?: Record<string, string>;
  timeoutMs: number;
}

/** What `Transport.http` resolves with. */
export interface HttpReply {
  status: number;
  body: string;
  localAddress?: string;
}

/** Thrown when a bound transport has no address to bind to; nothing is sent. */
export class TransportUnavailableError extends Error {}

/** Options for `boundTransport`. */
export interface BoundOptions {
  /** The local address to use, or a function returning it (null when the link is down). */
  address: string | (() => string | null);
}

/** The system's default routes. */
export function systemTransport(): Transport {
  return createTransport(() => undefined);
}

/** Pins every socket to a local address. Fails closed: with no address, nothing connects. */
export function boundTransport(options: BoundOptions): Transport {
  const resolve = typeof options.address === "string" ? () => options.address as string : options.address;
  return createTransport(() => {
    const address = resolve();
    if (!address) throw new TransportUnavailableError("No address to bind to");
    return address;
  });
}

function createTransport(local: () => string | undefined): Transport {
  return {
    connect(host, port) {
      const localAddress = local();
      return net.connect({ host, port, localAddress, noDelay: true });
    },

    listen(port, onConnection) {
      const host = local();
      return new Promise((resolve, reject) => {
        const server = net.createServer({ noDelay: true }, onConnection);
        server.once("error", reject);
        server.listen({ port, host }, () => {
          server.off("error", reject);
          resolve(server);
        });
      });
    },

    udp(port, family) {
      const address = local();
      const v6 = address ? net.isIPv6(address) : family === 6;
      if (address && family && v6 !== (family === 6)) return Promise.reject(new TransportUnavailableError(`Bound to ${address}, not IPv${family}`));
      // An IPv6 socket for IPv6 only, so it can share a port number with the IPv4 one
      const socket = dgram.createSocket({ type: v6 ? "udp6" : "udp4", ipv6Only: v6 });
      return new Promise((resolve, reject) => {
        socket.once("error", reject);
        socket.bind({ port, address }, () => {
          socket.off("error", reject);
          resolve(socket);
        });
      });
    },

    httpGet(url, timeoutMs) {
      return get(url, local(), timeoutMs, 3);
    },

    http(url, init) {
      return request(url, local(), init);
    },

    localAddress() {
      try {
        return local();
      } catch {
        return undefined;
      }
    },
  };
}

/** One request with `node:http`, bound to `localAddress`, body capped at 1 MiB. */
function request(url: string, localAddress: string | undefined, init: HttpInit): Promise<HttpReply> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:") return reject(new Error(`Unsupported URL ${url}`));
    const body = init.body === undefined ? undefined : Buffer.from(init.body);
    const headers = { ...init.headers, ...(body ? { "content-length": String(body.length) } : {}) };
    const req = http.request(parsed, { method: init.method, localAddress, timeout: init.timeoutMs, headers }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1024 * 1024) req.destroy(new Error("Response too large"));
        else chunks.push(chunk);
      });
      response.on("end", () =>
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString(), localAddress: req.socket?.localAddress?.replace(/^::ffff:/, "") }),
      );
      response.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`Timed out after ${init.timeoutMs} ms`)));
    req.on("error", reject);
    req.end(body);
  });
}

/** A GET with `node:http(s)`, bound to `localAddress`, capped at 4 MiB. */
function get(url: string, localAddress: string | undefined, timeoutMs: number, redirects: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? https : parsed.protocol === "http:" ? http : null;
    if (!client) return reject(new Error(`Unsupported URL ${url}`));
    const request = client.get(parsed, { localAddress, timeout: timeoutMs, headers: { "user-agent": "tinytorrent" } }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location && redirects > 0) {
        response.resume();
        get(new URL(response.headers.location, url).href, localAddress, timeoutMs, redirects - 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        response.resume();
        return reject(new Error(`HTTP ${status} from ${parsed.host}`));
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) request.destroy(new Error("Response too large"));
        else chunks.push(chunk);
      });
      response.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error(`Timed out after ${timeoutMs} ms`)));
    request.on("error", reject);
  });
}
