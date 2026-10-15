/**
 * Tracker announces: UDP (BEP 15) and HTTP, both through the engine's
 * transport so a bound transport keeps them on the VPN. Every tracker is
 * announced to in parallel rather than tier by tier: more peers sooner.
 */

import { randomBytes } from "node:crypto";
import type dgram from "node:dgram";
import { bytes, decode, dict, text } from "./bencode";
import { compactPeers, compactPeers6 } from "./extensions";
import type { Transport } from "./transport";

/** What an announce reports about the download. */
export interface AnnounceStats {
  downloaded: number;
  uploaded: number;
  left: number;
}

/** One tracker's answer. */
export interface AnnounceResult {
  peers: string[];
  interval: number;
  /** The least time between regular announces the tracker accepts. */
  minInterval?: number;
  seeders?: number;
  leechers?: number;
}

export type AnnounceEvent = "started" | "completed" | "stopped" | undefined;

/** Parameters of one announce. */
export interface AnnounceRequest {
  infoHash: Uint8Array;
  peerId: Uint8Array;
  port: number;
  stats: AnnounceStats;
  event: AnnounceEvent;
  numWant: number;
}

const EVENT_ID = { started: 2, completed: 1, stopped: 3 } as const;
const UDP_TIMEOUT_MS = 4000;
const HTTP_TIMEOUT_MS = 10_000;

// ---------- UDP ---------- //

/** One UDP socket shared by every torrent's UDP trackers. */
export class UdpTrackerClient {
  private socket: Promise<dgram.Socket> | null = null;
  private readonly pending = new Map<number, (msg: Buffer) => void>();
  private readonly connections = new Map<string, { id: Buffer; at: number }>();

  constructor(private readonly transport: Transport) {}

  public async announce(url: URL, request: AnnounceRequest): Promise<AnnounceResult> {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const port = Number(url.port);
    if (!port) throw new Error(`No port in ${url.href}`);
    const connectionId = await this.connect(host, port);

    const msg = Buffer.alloc(98);
    connectionId.copy(msg, 0);
    msg.writeUInt32BE(1, 8); // announce
    Buffer.from(request.infoHash).copy(msg, 16);
    Buffer.from(request.peerId).copy(msg, 36);
    msg.writeBigUInt64BE(BigInt(request.stats.downloaded), 56);
    msg.writeBigUInt64BE(BigInt(Math.max(0, request.stats.left)), 64);
    msg.writeBigUInt64BE(BigInt(request.stats.uploaded), 72);
    msg.writeUInt32BE(request.event ? EVENT_ID[request.event] : 0, 80);
    randomBytes(4).copy(msg, 88); // key
    msg.writeInt32BE(request.numWant, 92);
    msg.writeUInt16BE(request.port, 96);

    const reply = await this.transact(host, port, msg, 1);
    if (reply.length < 20) throw new Error("Short UDP announce reply");
    return {
      interval: reply.readUInt32BE(8),
      leechers: reply.readUInt32BE(12),
      seeders: reply.readUInt32BE(16),
      peers: compactPeers(reply.subarray(20)),
    };
  }

  /** Closes the socket. */
  public async close(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    if (socket) (await socket.catch(() => null))?.close();
  }

  private async connect(host: string, port: number): Promise<Buffer> {
    const key = `${host}:${port}`;
    const cached = this.connections.get(key);
    if (cached && Date.now() - cached.at < 60_000) return cached.id;
    const msg = Buffer.alloc(16);
    msg.writeBigUInt64BE(0x41727101980n, 0);
    msg.writeUInt32BE(0, 8); // connect
    const reply = await this.transact(host, port, msg, 0);
    if (reply.length < 16) throw new Error("Short UDP connect reply");
    const id = Buffer.from(reply.subarray(8, 16));
    this.connections.set(key, { id, at: Date.now() });
    return id;
  }

  /** Sends with a fresh transaction id, retrying once, and resolves with the matching reply. */
  private async transact(host: string, port: number, msg: Buffer, action: number): Promise<Buffer> {
    const socket = await this.open();
    for (let attempt = 0; attempt < 2; attempt++) {
      const tid = randomBytes(4).readUInt32BE(0);
      msg.writeUInt32BE(tid, 12);
      const reply = await new Promise<Buffer | null>((resolve) => {
        const timer = setTimeout(() => {
          this.pending.delete(tid);
          resolve(null);
        }, UDP_TIMEOUT_MS * (attempt + 1));
        this.pending.set(tid, (data) => {
          clearTimeout(timer);
          resolve(data);
        });
        socket.send(msg, port, host, (error) => {
          if (!error) return;
          clearTimeout(timer);
          this.pending.delete(tid);
          resolve(null);
        });
      });
      if (!reply) continue;
      const replyAction = reply.readUInt32BE(0);
      if (replyAction === 3) throw new Error(`Tracker error: ${reply.subarray(8).toString()}`);
      if (replyAction !== action) throw new Error("Unexpected UDP tracker reply");
      return reply;
    }
    throw new Error(`UDP tracker ${host}:${port} did not answer`);
  }

  private open(): Promise<dgram.Socket> {
    this.socket ??= this.transport.udp(0).then((socket) => {
      socket.on("message", (data: Buffer) => {
        if (data.length < 8) return;
        const resolve = this.pending.get(data.readUInt32BE(4));
        if (!resolve) return;
        this.pending.delete(data.readUInt32BE(4));
        resolve(data);
      });
      socket.on("error", () => undefined);
      socket.unref();
      return socket;
    });
    return this.socket;
  }
}

// ---------- HTTP ---------- //

export async function httpAnnounce(transport: Transport, url: string, request: AnnounceRequest): Promise<AnnounceResult> {
  const query = [
    `info_hash=${escapeBytes(request.infoHash)}`,
    `peer_id=${escapeBytes(request.peerId)}`,
    `port=${request.port}`,
    `uploaded=${request.stats.uploaded}`,
    `downloaded=${request.stats.downloaded}`,
    `left=${Math.max(0, request.stats.left)}`,
    "compact=1",
    `numwant=${request.numWant}`,
    request.event ? `event=${request.event}` : "",
  ]
    .filter(Boolean)
    .join("&");
  const body = await transport.httpGet(`${url}${url.includes("?") ? "&" : "?"}${query}`, HTTP_TIMEOUT_MS);
  const root = dict(decode(body));
  if (!root) throw new Error("Tracker reply is not a dictionary");
  if (root["failure reason"]) throw new Error(`Tracker error: ${text(root["failure reason"])}`);

  const peers = [...compactPeers(bytes(root.peers)), ...compactPeers6(bytes(root.peers6))];
  if (Array.isArray(root.peers)) {
    for (const entry of root.peers) {
      const peer = dict(entry);
      const ip = text(peer?.ip);
      if (ip && typeof peer?.port === "number") peers.push(ip.includes(":") ? `[${ip}]:${peer.port}` : `${ip}:${peer.port}`);
    }
  }
  return {
    peers,
    interval: typeof root.interval === "number" ? root.interval : 1800,
    minInterval: typeof root["min interval"] === "number" ? root["min interval"] : undefined,
    seeders: typeof root.complete === "number" ? root.complete : undefined,
    leechers: typeof root.incomplete === "number" ? root.incomplete : undefined,
  };
}

function escapeBytes(b: Uint8Array): string {
  let out = "";
  for (const byte of b) {
    const ch = String.fromCharCode(byte);
    out += /[A-Za-z0-9.\-_~]/.test(ch) ? ch : `%${byte.toString(16).padStart(2, "0")}`;
  }
  return out;
}

// ---------- Announcer ---------- //

/** One tracker's state, for diagnostics. */
export interface TrackerState {
  url: string;
  nextAt: number;
  lastAt: number;
  /** Seconds between announces; 0 until `started` is acknowledged. */
  interval: number;
  failures: number;
  peers: number;
  seeders?: number;
  leechers?: number;
  error?: string;
}

/**
 * Announces a torrent to all its trackers: `started` first, then on the
 * tracker's interval, `completed` once when a download finishes, and
 * `stopped` when the torrent pauses or closes (after which the next
 * announce is a fresh `started`). Events to one tracker go out in order.
 */
export class Announcer {
  public readonly trackers: TrackerState[];
  /** Per tracker, the announce in flight, so events stay in order. */
  private readonly chains = new Map<TrackerState, Promise<void>>();

  constructor(
    urls: string[],
    private readonly transport: Transport,
    private readonly udp: UdpTrackerClient,
    private readonly request: () => Omit<AnnounceRequest, "event">,
    private readonly onPeers: (peers: string[]) => void,
  ) {
    this.trackers = urls
      .filter((u) => /^(udp|https?):\/\//.test(u))
      .map((url) => ({ url, nextAt: 0, lastAt: 0, interval: 0, failures: 0, peers: 0 }));
  }

  /**
   * Announces to every tracker that is due. With `needPeers`, trackers that
   * answered over two minutes ago are asked again early.
   */
  public tick(now: number, needPeers = false): void {
    for (const tracker of this.trackers) {
      const early = needPeers && tracker.failures === 0 && tracker.lastAt > 0 && now - tracker.lastAt > 120_000;
      if (tracker.nextAt > now && !early) continue;
      tracker.nextAt = now + 60_000; // until it answers
      tracker.lastAt = now;
      this.queue(tracker, tracker.interval === 0 ? "started" : undefined);
    }
  }

  /** Announces to every tracker that knows us at the next tick, ahead of its interval. */
  public reannounce(): void {
    for (const tracker of this.trackers) if (tracker.lastAt > 0) tracker.nextAt = 0;
  }

  /** The download finished: tell every tracker that knows us. */
  public completed(): void {
    for (const tracker of this.trackers) if (tracker.lastAt > 0) this.queue(tracker, "completed");
  }

  /** Tells every tracker we are leaving. Best effort, waited on for at most 2 s. */
  public async stop(): Promise<void> {
    const sends = this.trackers.filter((t) => t.lastAt > 0).map((t) => this.queue(t, "stopped"));
    await Promise.race([Promise.allSettled(sends), new Promise((resolve) => setTimeout(resolve, 2000))]);
  }

  private queue(tracker: TrackerState, event: AnnounceEvent): Promise<void> {
    const next = (this.chains.get(tracker) ?? Promise.resolve()).then(() => this.announce(tracker, event));
    this.chains.set(tracker, next);
    return next;
  }

  private async announce(tracker: TrackerState, event: AnnounceEvent): Promise<void> {
    if (event === "stopped") {
      // Whatever the answer, the next announce starts afresh
      await this.send(tracker.url, event).catch(() => undefined);
      Object.assign(tracker, { interval: 0, nextAt: 0, lastAt: 0 });
      return;
    }
    try {
      const result = await this.send(tracker.url, event);
      tracker.failures = 0;
      tracker.error = undefined;
      // Honour the interval and min interval, but no less than 2 minutes and no more than 30
      tracker.interval = Math.min(Math.max(result.interval, result.minInterval ?? 0, 120), 1800);
      tracker.nextAt = Date.now() + tracker.interval * 1000;
      tracker.peers = result.peers.length;
      tracker.seeders = result.seeders;
      tracker.leechers = result.leechers;
      if (result.peers.length) this.onPeers(result.peers);
    } catch (error) {
      tracker.failures++;
      tracker.error = (error as Error).message;
      tracker.nextAt = Date.now() + Math.min(30_000 * 2 ** tracker.failures, 30 * 60_000);
    }
  }

  private send(url: string, event: AnnounceEvent): Promise<AnnounceResult> {
    const request = { ...this.request(), event };
    return url.startsWith("udp:") ? this.udp.announce(new URL(url), request) : httpAnnounce(this.transport, url, request);
  }
}
