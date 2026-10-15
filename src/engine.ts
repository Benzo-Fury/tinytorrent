/**
 * The engine: one per process. Owns the peer id, the listening socket, the
 * DHT node, the shared UDP tracker socket, port mapping, the rate limits and
 * the single 250 ms tick that drives every torrent. Incoming connections are matched to
 * torrents by info hash, plain or encrypted.
 */

import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Server, Socket } from "node:net";
import { accept, type EncryptionPolicy, splitHostPort } from "./connections";
import { Dht } from "./dht";
import { RateLimit } from "./limits";
import { type Magnet, type Metainfo, parseMagnet, parseTorrent } from "./metainfo";
import { type Mapping, PortMapper, type PortMappingOptions } from "./portmap";
import type { SeedLimits } from "./seeding";
import { type AddOptions, Torrent } from "./torrent";
import { UdpTrackerClient } from "./tracker";
import { systemTransport, type Transport } from "./transport";

/** Engine configuration. Every field is optional. */
export interface EngineOptions {
  /** Port to accept peers on; 0 (default) picks a free one. */
  port?: number;
  /** Whether to accept incoming peers at all. Default true. */
  listen?: boolean;
  /** How every socket is opened; `boundTransport()` pins them to a VPN address. */
  transport?: Transport;
  /**
   * `prefer` (default): encrypt outgoing connections, accept both.
   * `prefer-plaintext`: plain first, encrypt only for peers that insist — the
   * cheapest choice when traffic is already inside a VPN.
   * `require`: encrypted only. `off`: plaintext only.
   */
  encryption?: EncryptionPolicy;
  /** Connected peers per torrent. Default 200. */
  maxPeersPerTorrent?: number;
  /** Connection attempts in flight across all torrents. Default 30. */
  maxHalfOpen?: number;
  upload?: {
    /**
     * Peers unchoked at once per torrent; 0 never uploads. Default 4. While
     * seeding this is the minimum: more are unchoked as long as they keep
     * up (see docs/HOW-IT-WORKS.md).
     */
    slots?: number;
    /** Upload cap in bytes per second across the engine; 0 is unlimited. Default 0. */
    limitBytesPerSecond?: number;
  };
  download?: {
    /** Download cap in bytes per second across the engine; 0 is unlimited. Default 0. */
    limitBytesPerSecond?: number;
  };
  /**
   * Seeding once a download completes (or a complete torrent is added).
   * Default off. `ratio` (uploaded ÷ size) and `minutes` end it, whichever
   * comes first; 0 or absent means no limit. Torrents can override it.
   */
  seed?: { enabled?: boolean; ratio?: number; minutes?: number };
  /** Peer filter: return false to never connect to or accept `host` (an IP address). */
  allowPeer?: (host: string) => boolean;
  /** Upload read cache per torrent, in bytes. Default 32 MiB. */
  uploadCacheBytes?: number;
  /**
   * Map the listening port on the router or VPN gateway with NAT-PMP, then
   * UPnP, so peers can connect in; the external port is what gets announced.
   * Default off. Requests go through the transport (bound to a VPN address,
   * they only reach the VPN's gateway).
   */
  portMapping?: boolean | PortMappingOptions;
  /**
   * The DHT: false to disable, or nodes saved from `dhtNodes()` (and
   * `dhtNodes6()`) and bootstrap routers. Default on. An IPv6 node (BEP 32)
   * runs beside the IPv4 one when the transport isn't bound to IPv4.
   */
  dht?: boolean | { nodes?: Uint8Array; nodes6?: Uint8Array; bootstrap?: string[] };
  /** Peer exchange. Default true. */
  pex?: boolean;
  /** Directory for resume state; without it, resuming re-checks files by hash. */
  resumeDir?: string;
  /** Piece buffer memory per torrent before only started pieces are requested. Default 512 MiB. */
  maxBufferBytes?: number;
  /** Our 20-byte peer id; random by default. */
  peerId?: Uint8Array;
}

/** Options with defaults applied, as torrents see them. */
export interface ResolvedOptions {
  encryption: EncryptionPolicy;
  maxPeersPerTorrent: number;
  maxHalfOpen: number;
  upload: { slots: number };
  seed: SeedLimits;
  pex: boolean;
  resumeDir?: string;
  maxBufferBytes: number;
  uploadCacheBytes: number;
}

/** What a torrent needs from its engine. */
export interface EngineContext {
  readonly options: ResolvedOptions;
  readonly transport: Transport;
  readonly udpTrackers: UdpTrackerClient;
  readonly peerId: Uint8Array;
  /** Engine-wide rate limits, refilled by the tick. */
  readonly uploadLimit: RateLimit;
  readonly downloadLimit: RateLimit;
  port(): number;
  /** The port peers should dial: the mapped external port when port mapping found one. */
  announcePort(): number;
  /** Whether the peer filter lets `host` in. */
  allowed(host: string): boolean;
  dhtPort(): number;
  dhtLookup(infoHash: Uint8Array, onPeers: (peers: string[]) => void): void;
  dhtAddNode(address: string, port: number): void;
  halfOpenRoom(): number;
  halfOpen(delta: number): void;
  removed(torrent: Torrent): void;
}

/** Totals across every torrent, from `engine.stats()`. */
export interface EngineStats {
  torrents: number;
  peers: number;
  downloadRate: number;
  uploadRate: number;
  downloaded: number;
  uploaded: number;
  port: number;
  /** The port announced to trackers and the DHT. */
  announcePort: number;
  dhtNodes: number;
  /** Port mappings in place. */
  mappings: Mapping[];
}

const TICK_MS = 250;
/** Incoming connections still handshaking, at most; more are refused. */
const MAX_INCOMING = 64;

export class Engine extends EventEmitter implements EngineContext {
  public readonly options: ResolvedOptions;
  public readonly transport: Transport;
  public readonly udpTrackers: UdpTrackerClient;
  public readonly peerId: Uint8Array;
  public readonly uploadLimit: RateLimit;
  public readonly downloadLimit: RateLimit;
  private readonly torrents = new Map<string, Torrent>();
  private server: Server | null = null;
  private listening: Promise<void> | null = null;
  private dht: Dht | null = null;
  private dht6: Dht | null = null;
  private dhtNodesSaved6: Uint8Array | undefined;
  private mapper: PortMapper | null = null;
  private dhtNodesSaved: Uint8Array | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;
  private halfOpenCount = 0;
  private lastTick = Date.now();
  private connected = true;
  private readonly incoming = new Set<Socket>();

  constructor(private readonly config: EngineOptions = {}) {
    super();
    this.transport = config.transport ?? systemTransport();
    this.udpTrackers = new UdpTrackerClient(this.transport);
    this.peerId = config.peerId ?? new Uint8Array(Buffer.concat([Buffer.from("-TT0100-"), randomBytes(12)]));
    this.options = {
      encryption: config.encryption ?? "prefer",
      maxPeersPerTorrent: config.maxPeersPerTorrent ?? 200,
      maxHalfOpen: config.maxHalfOpen ?? 30,
      upload: { slots: config.upload?.slots ?? 4 },
      seed: { enabled: config.seed?.enabled ?? false, ratio: config.seed?.ratio ?? 0, minutes: config.seed?.minutes ?? 0 },
      pex: config.pex ?? true,
      resumeDir: config.resumeDir,
      maxBufferBytes: config.maxBufferBytes ?? 512 * 1024 * 1024,
      uploadCacheBytes: config.uploadCacheBytes ?? 32 * 1024 * 1024,
    };
    this.uploadLimit = new RateLimit(config.upload?.limitBytesPerSecond);
    this.downloadLimit = new RateLimit(config.download?.limitBytesPerSecond);
    this.dhtNodesSaved = typeof config.dht === "object" ? config.dht.nodes : undefined;
    this.dhtNodesSaved6 = typeof config.dht === "object" ? config.dht.nodes6 : undefined;
  }

  /**
   * Adds a torrent from a `.torrent` file's bytes, a magnet link, or parsed
   * metadata. Adding one that is already present returns the existing torrent.
   */
  public add(input: Uint8Array | string | Metainfo | Magnet, options: AddOptions): Torrent {
    const parsed = typeof input === "string" ? parseMagnet(input) : input instanceof Uint8Array ? parseTorrent(input) : input;
    const existing = this.torrents.get(parsed.infoHashHex);
    if (existing) return existing;
    const torrent = new Torrent(this, parsed, options);
    this.torrents.set(parsed.infoHashHex, torrent);
    void this.start();
    return torrent;
  }

  /** A torrent by info hash (hex). */
  public get(infoHashHex: string): Torrent | undefined {
    return this.torrents.get(infoHashHex.toLowerCase());
  }

  /** Every torrent. */
  public list(): Torrent[] {
    return [...this.torrents.values()];
  }

  /** Resolves once the listener and DHT are up (they start on the first `add`). */
  public ready(): Promise<void> {
    return this.start();
  }

  /**
   * Closes every socket at once — the killswitch. Torrents pause, keeping
   * their files and resume state; `reconnect()` carries on.
   */
  public async disconnect(): Promise<void> {
    this.connected = false;
    await Promise.all(this.list().map((t) => t.pause()));
    await this.stopNetwork();
  }

  /** Reopens the network after `disconnect()` and resumes every torrent. */
  public async reconnect(): Promise<void> {
    this.connected = true;
    this.listening = null;
    await this.start();
    for (const torrent of this.torrents.values()) torrent.resume();
  }

  /** Closes every torrent (keeping files) and the network. */
  public async destroy(): Promise<void> {
    await Promise.all(this.list().map((t) => t.close()));
    this.connected = false;
    await this.stopNetwork();
  }

  /** Totals across every torrent. */
  public stats(): EngineStats {
    const torrents = this.list();
    const sum = (f: (t: Torrent) => number): number => torrents.reduce((n, t) => n + f(t), 0);
    return {
      torrents: torrents.length,
      peers: sum((t) => t.peers.size),
      downloadRate: sum((t) => t.downloadRate),
      uploadRate: sum((t) => t.uploadRate),
      downloaded: sum((t) => t.downloaded),
      uploaded: sum((t) => t.uploaded),
      port: this.port(),
      announcePort: this.announcePort(),
      dhtNodes: (this.dht?.size ?? 0) + (this.dht6?.size ?? 0),
      mappings: [...(this.mapper?.mappings ?? [])],
    };
  }

  /** Changes the engine-wide rate limits (bytes per second, 0 for none). */
  public setLimits(limits: { uploadBytesPerSecond?: number; downloadBytesPerSecond?: number }): void {
    if (limits.uploadBytesPerSecond !== undefined) this.uploadLimit.bytesPerSecond = limits.uploadBytesPerSecond;
    if (limits.downloadBytesPerSecond !== undefined) this.downloadLimit.bytesPerSecond = limits.downloadBytesPerSecond;
  }

  /** The DHT's known nodes, to pass back as `dht.nodes` next time. */
  public dhtNodes(): Uint8Array | undefined {
    return this.dht?.nodes() ?? this.dhtNodesSaved;
  }

  /** The IPv6 DHT's known nodes, to pass back as `dht.nodes6`. */
  public dhtNodes6(): Uint8Array | undefined {
    return this.dht6?.nodes() ?? this.dhtNodesSaved6;
  }

  // ---------- Context for torrents ---------- //

  public port(): number {
    const address = this.server?.address();
    return typeof address === "object" && address ? address.port : 0;
  }

  public announcePort(): number {
    return this.mapper?.external("tcp") ?? this.port();
  }

  public allowed(host: string): boolean {
    return this.config.allowPeer?.(host) ?? true;
  }

  /** The DHT port peers should send to: mapped externally when port mapping worked. */
  public dhtPort(): number {
    return this.mapper?.external("udp") ?? this.dht?.port ?? 0;
  }

  public dhtLookup(infoHash: Uint8Array, onPeers: (peers: string[]) => void): void {
    void this.start().then(() => {
      for (const dht of [this.dht, this.dht6]) dht?.lookup(infoHash, onPeers, this.announcePort() || undefined).catch(() => 0);
    });
  }

  public dhtAddNode(address: string, port: number): void {
    const host = splitHostPort(address)?.[0];
    if (host) (host.includes(":") ? this.dht6 : this.dht)?.addNode(host, port);
  }

  public halfOpenRoom(): number {
    return this.connected ? this.options.maxHalfOpen - this.halfOpenCount : 0;
  }

  public halfOpen(delta: number): void {
    this.halfOpenCount += delta;
  }

  public removed(torrent: Torrent): void {
    this.torrents.delete(torrent.infoHashHex);
  }

  // ---------- Network ---------- //

  private start(): Promise<void> {
    this.listening ??= this.startNetwork();
    return this.listening;
  }

  private async startNetwork(): Promise<void> {
    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), TICK_MS);
      this.timer.unref();
    }
    if (this.config.listen !== false && !this.server) {
      try {
        this.server = await this.transport.listen(this.config.port ?? 0, (socket) => this.onIncoming(socket));
        this.server.on("error", (error) => this.emit("warning", `Listener: ${error.message}`));
      } catch (error) {
        this.emit("warning", `Could not listen: ${(error as Error).message}`);
      }
    }
    if (this.config.dht !== false && !this.dht) {
      const dht = new Dht({
        transport: this.transport,
        port: this.port() || 0,
        nodes: this.dhtNodesSaved,
        bootstrap: typeof this.config.dht === "object" ? this.config.dht.bootstrap : undefined,
      });
      try {
        await dht.start();
        this.dht = dht;
      } catch (error) {
        // The listener's port may be taken for UDP; fall back to any port
        try {
          const fallback = new Dht({ transport: this.transport, nodes: this.dhtNodesSaved, bootstrap: typeof this.config.dht === "object" ? this.config.dht.bootstrap : undefined });
          await fallback.start();
          this.dht = fallback;
        } catch {
          this.emit("warning", `DHT unavailable: ${(error as Error).message}`);
        }
      }
    }
    // IPv6 beside it, unless the transport is pinned to an IPv4 address
    const bound = this.transport.localAddress();
    if (this.config.dht !== false && !this.dht6 && (!bound || bound.includes(":"))) {
      const dht6 = new Dht({
        transport: this.transport,
        family: 6,
        port: this.port() || 0,
        nodes: this.dhtNodesSaved6,
        bootstrap: typeof this.config.dht === "object" ? this.config.dht.bootstrap : undefined,
      });
      await dht6.start().then(
        () => (this.dht6 = dht6),
        () => undefined, // no IPv6 here
      );
    }
    this.startPortMapping();
  }

  /** Maps the listener and DHT ports, and tells trackers the external port once known. */
  private startPortMapping(): void {
    const config = this.config.portMapping;
    if (!config || this.mapper || !this.server) return;
    const mapper = new PortMapper(this.transport, { tcp: this.port(), udp: this.dht?.port ?? 0 }, config === true ? {} : config);
    this.mapper = mapper;
    const announce = (): void => {
      this.emit("portMapping", [...mapper.mappings]);
      for (const torrent of this.torrents.values()) torrent.reannounce();
    };
    mapper.on("mapped", announce);
    mapper.on("changed", announce);
    mapper.on("warning", (message: string) => this.emit("warning", message));
    void mapper.start();
  }

  private async stopNetwork(): Promise<void> {
    const mapper = this.mapper;
    this.mapper = null;
    await mapper?.stop();
    if (this.dht) {
      this.dhtNodesSaved = this.dht.nodes();
      this.dht.stop();
      this.dht = null;
    }
    if (this.dht6) {
      this.dhtNodesSaved6 = this.dht6.nodes();
      this.dht6.stop();
      this.dht6 = null;
    }
    await this.udpTrackers.close();
    for (const socket of this.incoming) socket.destroy();
    this.incoming.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (this.timer && this.torrents.size === 0) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private onIncoming(socket: Socket): void {
    const host = socket.remoteAddress?.replace(/^::ffff:/, "") ?? "";
    if (!this.connected || this.incoming.size >= MAX_INCOMING || !this.allowed(host)) return void socket.destroy();
    this.incoming.add(socket);
    const address = host.includes(":") ? `[${host}]:${socket.remotePort}` : `${host}:${socket.remotePort}`;
    accept(socket, () => this.list().map((t) => t.infoHash), this.options.encryption)
      .then((established) => {
        this.incoming.delete(socket);
        const torrent = established.infoHash && this.get(Buffer.from(established.infoHash).toString("hex"));
        if (!torrent || !this.connected) return socket.destroy();
        torrent.attach(established, address, false);
      })
      .catch(() => {
        this.incoming.delete(socket);
        socket.destroy();
      });
  }

  private tick(): void {
    const now = Date.now();
    this.uploadLimit.refill(now - this.lastTick);
    this.downloadLimit.refill(now - this.lastTick);
    this.lastTick = now;
    for (const torrent of this.torrents.values()) {
      try {
        torrent.tick(now);
      } catch (error) {
        torrent.emit("warning", `Tick failed: ${(error as Error).message}`);
      }
    }
  }
}
