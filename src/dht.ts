/**
 * A small Mainline DHT node (BEP 5): finds peers for info hashes, announces
 * our own, and answers other nodes' queries so it stays in their routing
 * tables. One node speaks one address family; the engine runs an IPv6 node
 * (BEP 32) beside the IPv4 one when it can. Known nodes can be saved and passed back in on the next
 * start, so restarts don't depend on the bootstrap servers.
 *
 * Lookups are aggressive (eight queries in flight) and report peers as they
 * arrive, so a download can start before the lookup finishes.
 */

import { createHash, randomBytes } from "node:crypto";
import type dgram from "node:dgram";
import { type BDict, type BInput, bytes, decode, dict, encode, text } from "./bencode";
import { compactPeers, compactPeers6, expand6, format6 } from "./extensions";
import type { Transport } from "./transport";

/** A node in the routing table. */
interface Node {
  id: Uint8Array;
  host: string;
  port: number;
  lastSeen: number;
  fails: number;
}

/** Options for a DHT node. */
export interface DhtOptions {
  transport: Transport;
  /** UDP port; 0 picks one. Use the same port as the peer listener to share a forwarded port. */
  port?: number;
  /** 4 (default) or 6. */
  family?: 4 | 6;
  /** Nodes from a previous run, as compact entries (26 bytes each, 38 for IPv6). */
  nodes?: Uint8Array;
  /** `host:port` bootstrap routers. */
  bootstrap?: string[];
  nodeId?: Uint8Array;
}

const K = 8;
const ALPHA = 8;
const QUERY_TIMEOUT_MS = 3000;
const LOOKUP_TIMEOUT_MS = 30_000;
const DEFAULT_BOOTSTRAP = [
  "router.bittorrent.com:6881",
  "dht.transmissionbt.com:6881",
  "router.utorrent.com:6881",
  "dht.libtorrent.org:25401",
];
/** Routers with IPv6 addresses. */
const DEFAULT_BOOTSTRAP6 = ["dht.libtorrent.org:25401", "dht.transmissionbt.com:6881", "router.bittorrent.com:6881"];

/** Thrown for a query that got an error reply or no reply. */
class QueryError extends Error {}

export class Dht {
  public readonly id: Uint8Array;
  private socket: dgram.Socket | null = null;
  private readonly buckets: Node[][] = Array.from({ length: 160 }, () => []);
  private readonly pending = new Map<number, { resolve: (r: BDict) => void; reject: (e: Error) => void; timer: Timer }>();
  private nextTid = Math.floor(Math.random() * 0xffff);
  private secret = randomBytes(8);
  private previousSecret = this.secret;
  private readonly store = new Map<string, Map<string, number>>();
  private rotateTimer: Timer | null = null;
  /** Queries sent and answered, for diagnostics. */
  public readonly counters = { sent: 0, answered: 0, received: 0 };
  public readonly family: 4 | 6;
  /** Compact node entry size, and the reply key nodes go under. */
  private readonly entry: number;
  private readonly nodesKey: "nodes" | "nodes6";

  constructor(private readonly options: DhtOptions) {
    this.id = options.nodeId ?? randomBytes(20);
    this.family = options.family ?? 4;
    this.entry = this.family === 6 ? 38 : 26;
    this.nodesKey = this.family === 6 ? "nodes6" : "nodes";
    if (options.nodes) this.addCompact(options.nodes);
  }

  /** Number of nodes in the routing table. */
  public get size(): number {
    return this.buckets.reduce((n, b) => n + b.length, 0);
  }

  /** The bound UDP port. */
  public get port(): number {
    return this.socket?.address().port ?? 0;
  }

  /** Opens the socket and bootstraps when the table is thin. */
  public async start(): Promise<void> {
    this.socket = await this.options.transport.udp(this.options.port ?? 0, this.family);
    this.socket.on("message", (msg: Buffer, rinfo: dgram.RemoteInfo) => this.receive(msg, rinfo.address, rinfo.port));
    this.socket.on("error", () => undefined);
    this.socket.unref();
    this.rotateTimer = setInterval(() => {
      this.previousSecret = this.secret;
      this.secret = randomBytes(8);
    }, 5 * 60_000);
    this.rotateTimer.unref();
    void this.bootstrap();
  }

  /** Closes the socket; outstanding queries fail. */
  public stop(): void {
    if (this.rotateTimer) clearInterval(this.rotateTimer);
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new QueryError("DHT stopped"));
    }
    this.pending.clear();
    this.socket?.close();
    this.socket = null;
  }

  /** Good nodes as compact entries, for saving between runs. */
  public nodes(): Uint8Array {
    return this.compactNodes(this.buckets.flat().filter((n) => n.fails === 0));
  }

  /** Adds a node we heard of out of band (a peer's `port` message). Pings it first. */
  public addNode(host: string, port: number): void {
    this.query(host, port, "ping", {}).then(
      (r) => {
        const id = bytes(r.id);
        if (id?.length === 20) this.seen(id, host, port);
      },
      () => undefined,
    );
  }

  /**
   * Looks up peers for an info hash, calling `onPeers` as they arrive, and
   * announces our port to the closest nodes if `announcePort` is given.
   * Resolves when the lookup converges or times out.
   */
  public async lookup(infoHash: Uint8Array, onPeers: (peers: string[]) => void, announcePort?: number): Promise<number> {
    if (!this.socket) return 0;
    // A thin table: ask the bootstrap routers for peers directly, filling the table meanwhile
    const seeds = this.size < K ? this.bootstrapNodes() : undefined;
    if (seeds) void this.bootstrap();
    const tokens = new Map<string, { node: Node; token: Uint8Array }>();
    let found = 0;
    await this.iterate(infoHash, "get_peers", { info_hash: infoHash }, (node, reply) => {
      const token = bytes(reply.token);
      if (token) tokens.set(`${node.host}:${node.port}`, { node, token });
      if (Array.isArray(reply.values)) {
        const peers = reply.values.flatMap((v) => (this.family === 6 ? compactPeers6(bytes(v)) : compactPeers(bytes(v))));
        found += peers.length;
        if (peers.length) onPeers(peers);
      }
    }, seeds);

    // Announce to the K closest nodes that gave us a token
    if (announcePort) {
      const closest = [...tokens.values()].sort((a, b) => compare(distance(a.node.id, infoHash), distance(b.node.id, infoHash))).slice(0, K);
      for (const { node, token } of closest) {
        this.query(node.host, node.port, "announce_peer", { info_hash: infoHash, port: announcePort, token, implied_port: 0 }).catch(
          () => undefined,
        );
      }
    }
    return found;
  }

  // ---------- Lookups ---------- //

  private async bootstrap(): Promise<void> {
    if (!this.socket) return;
    await this.iterate(this.id, "find_node", { target: this.id }, () => undefined, this.bootstrapNodes());
  }

  /** The bootstrap routers plus whatever is in the table, as lookup seeds. */
  private bootstrapNodes(): Node[] {
    const routers = (this.options.bootstrap ?? (this.family === 6 ? DEFAULT_BOOTSTRAP6 : DEFAULT_BOOTSTRAP)).map((h) => {
      const [host, port] = splitAddress(h);
      return { id: new Uint8Array(20), host, port, lastSeen: 0, fails: 0 };
    });
    return [...routers, ...this.buckets.flat()];
  }

  /** Iterative Kademlia lookup towards `target`. */
  private async iterate(
    target: Uint8Array,
    method: string,
    args: Record<string, BInput>,
    onReply: (node: Node, reply: BDict) => void,
    seeds?: Node[],
  ): Promise<void> {
    const queried = new Set<string>();
    const candidates = new Map<string, Node>();
    for (const node of seeds ?? this.closest(target, K * 2)) candidates.set(`${node.host}:${node.port}`, node);
    if (!seeds && candidates.size === 0) return;
    const deadline = Date.now() + LOOKUP_TIMEOUT_MS;
    let inflight = 0;

    await new Promise<void>((resolve) => {
      const pump = (): void => {
        // The K closest known nodes; the lookup ends when all have been asked
        const ranked = [...candidates.entries()].sort((a, b) => compare(distance(a[1].id, target), distance(b[1].id, target)));
        const frontier = ranked.slice(0, K * 2);
        const next = frontier.filter(([key]) => !queried.has(key));
        if ((next.length === 0 && inflight === 0) || Date.now() > deadline || !this.socket) return resolve();
        for (const [key, node] of next) {
          if (inflight >= ALPHA) break;
          queried.add(key);
          inflight++;
          this.query(node.host, node.port, method, args)
            .then((reply) => {
              const id = bytes(reply.id);
              if (id?.length === 20) this.seen(id, node.host, node.port);
              onReply(node, reply);
              for (const found of this.parseNodes(bytes(reply[this.nodesKey]))) {
                const foundKey = `${found.host}:${found.port}`;
                if (!candidates.has(foundKey)) candidates.set(foundKey, found);
              }
            })
            .catch(() => this.failed(node))
            .finally(() => {
              inflight--;
              pump();
            });
        }
      };
      pump();
    });
  }

  /** The `n` known nodes closest to `target`. */
  private closest(target: Uint8Array, n: number): Node[] {
    return this.buckets
      .flat()
      .sort((a, b) => compare(distance(a.id, target), distance(b.id, target)))
      .slice(0, n);
  }

  // ---------- Routing table ---------- //

  /** Records a node that answered us or queried us. */
  private seen(id: Uint8Array, host: string, port: number): void {
    if (Buffer.from(id).equals(this.id) || port <= 0) return;
    const bucket = this.buckets[bucketIndex(this.id, id)] as Node[];
    const existing = bucket.find((n) => Buffer.from(n.id).equals(id));
    if (existing) {
      existing.lastSeen = Date.now();
      existing.fails = 0;
      existing.host = host;
      existing.port = port;
      return;
    }
    const node: Node = { id, host, port, lastSeen: Date.now(), fails: 0 };
    if (bucket.length < K) return void bucket.push(node);
    // Replace a node that stopped answering or went quiet for 15 minutes
    const stale = bucket.findIndex((n) => n.fails >= 2 || Date.now() - n.lastSeen > 15 * 60_000);
    if (stale >= 0) bucket[stale] = node;
  }

  private failed(node: Node): void {
    const bucket = this.buckets[bucketIndex(this.id, node.id)] as Node[];
    const existing = bucket.find((n) => Buffer.from(n.id).equals(node.id));
    if (existing && ++existing.fails >= 4) bucket.splice(bucket.indexOf(existing), 1);
  }

  private addCompact(buf: Uint8Array): void {
    for (const node of this.parseNodes(buf)) {
      const bucket = this.buckets[bucketIndex(this.id, node.id)] as Node[];
      if (bucket.length < K) bucket.push({ ...node, lastSeen: 0 });
    }
  }

  // ---------- KRPC ---------- //

  private query(host: string, port: number, method: string, args: Record<string, BInput>): Promise<BDict> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new QueryError("DHT stopped"));
    const tid = this.nextTid = (this.nextTid + 1) & 0xffff;
    const t = Uint8Array.of(tid >> 8, tid & 0xff);
    const want = this.family === 6 ? { want: ["n6"] } : {};
    const msg = encode({ t, y: "q", q: method, a: { ...args, ...want, id: this.id } });
    this.counters.sent++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(tid);
        reject(new QueryError("timeout"));
      }, QUERY_TIMEOUT_MS);
      this.pending.set(tid, { resolve, reject, timer });
      socket.send(msg, port, host, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(tid);
        reject(new QueryError(error.message));
      });
    });
  }

  private receive(msg: Buffer, host: string, port: number): void {
    let root: BDict | undefined;
    try {
      root = dict(decode(msg));
    } catch {
      return;
    }
    const t = bytes(root?.t);
    if (!root || !t) return;
    const y = text(root.y);

    if (y === "r" || y === "e") {
      if (t.length !== 2) return;
      const tid = ((t[0] as number) << 8) | (t[1] as number);
      const pending = this.pending.get(tid);
      if (!pending) return;
      this.pending.delete(tid);
      clearTimeout(pending.timer);
      const r = dict(root.r);
      if (y === "r" && r) {
        this.counters.answered++;
        pending.resolve(r);
      } else pending.reject(new QueryError("error reply"));
      return;
    }
    if (y === "q") this.answer(root, t, host, port);
  }

  /** Answers another node's query. */
  private answer(root: BDict, t: Uint8Array, host: string, port: number): void {
    const a = dict(root.a);
    const id = bytes(a?.id);
    if (!a || id?.length !== 20) return;
    this.counters.received++;
    this.seen(id, host, port);
    const method = text(root.q);
    const reply: Record<string, BInput> = { id: this.id };

    if (method === "find_node" || method === "get_peers") {
      const target = bytes(method === "find_node" ? a.target : a.info_hash);
      if (target?.length !== 20) return this.error(t, host, port, 203, "Bad target");
      reply[this.nodesKey] = this.compactNodes(this.closest(target, K));
      if (method === "get_peers") {
        reply.token = this.token(host, this.secret);
        const stored = this.store.get(Buffer.from(target).toString("hex"));
        if (stored?.size) reply.values = [...stored.keys()].slice(0, 50).map((p) => compactAddress(...splitAddress(p)));
      }
    } else if (method === "announce_peer") {
      const infoHash = bytes(a.info_hash);
      const token = bytes(a.token);
      const valid = token && (equal(token, this.token(host, this.secret)) || equal(token, this.token(host, this.previousSecret)));
      if (infoHash?.length !== 20 || !valid) return this.error(t, host, port, 203, "Bad token");
      const peerPort = a.implied_port === 1 ? port : typeof a.port === "number" ? a.port : 0;
      if (peerPort > 0 && peerPort < 65536) this.storePeer(Buffer.from(infoHash).toString("hex"), this.family === 6 ? `[${host}]:${peerPort}` : `${host}:${peerPort}`);
    } else if (method !== "ping") {
      return this.error(t, host, port, 204, "Method unknown");
    }
    this.socket?.send(encode({ t, y: "r", r: reply }), port, host);
  }

  private error(t: Uint8Array, host: string, port: number, code: number, message: string): void {
    this.socket?.send(encode({ t, y: "e", e: [code, message] }), port, host);
  }

  private token(host: string, secret: Uint8Array): Uint8Array {
    return new Uint8Array(createHash("sha1").update(secret).update(host).digest().subarray(0, 8));
  }

  /** Compact node entries of this node's family. */
  private parseNodes(buf: Uint8Array | undefined): Node[] {
    const out: Node[] = [];
    if (!buf) return out;
    const size = this.entry;
    for (let o = 0; o + size <= buf.length; o += size) {
      const port = ((buf[o + size - 2] as number) << 8) | (buf[o + size - 1] as number);
      if (port) out.push({ id: buf.slice(o, o + 20), host: hostAt(buf, o + 20, size - 22), port, lastSeen: 0, fails: 0 });
    }
    return out;
  }

  private compactNodes(nodes: Node[]): Uint8Array {
    const out = new Uint8Array(nodes.length * this.entry);
    nodes.forEach((n, i) => {
      out.set(n.id, i * this.entry);
      out.set(compactAddress(n.host, n.port), i * this.entry + 20);
    });
    return out;
  }

  private storePeer(infoHash: string, peer: string): void {
    let peers = this.store.get(infoHash);
    if (!peers) {
      if (this.store.size >= 1000) return;
      peers = new Map();
      this.store.set(infoHash, peers);
    }
    peers.set(peer, Date.now());
    if (peers.size > 200) peers.delete(peers.keys().next().value as string);
  }
}

// ---------- Helpers ---------- //

/** The IPv4 (4 bytes) or IPv6 (16 bytes) address at `o`. */
function hostAt(buf: Uint8Array, o: number, length: number): string {
  return length === 4 ? `${buf[o]}.${buf[o + 1]}.${buf[o + 2]}.${buf[o + 3]}` : format6(buf, o);
}

/** A compact address: 4 or 16 address bytes, then the port. */
function compactAddress(host: string, port: number): Uint8Array {
  const groups = host.includes(":") ? expand6(host) : null;
  const parts = groups ? groups.flatMap((g) => [g >> 8, g & 0xff]) : host.split(".").map(Number);
  return Uint8Array.of(...parts, port >> 8, port & 0xff);
}

function splitAddress(address: string): [string, number] {
  const i = address.lastIndexOf(":");
  return [address.slice(0, i).replace(/^\[|\]$/g, ""), Number(address.slice(i + 1))];
}

function distance(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(20);
  for (let i = 0; i < 20; i++) out[i] = (a[i] as number) ^ (b[i] as number);
  return out;
}

function compare(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  return 0;
}

/** Index of the bucket for `id`: the length of the prefix it shares with ours. */
function bucketIndex(own: Uint8Array, id: Uint8Array): number {
  for (let i = 0; i < 20; i++) {
    const x = (own[i] as number) ^ (id[i] as number);
    if (x) return i * 8 + Math.clz32(x) - 24;
  }
  return 159;
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && Buffer.from(a).equals(b);
}
