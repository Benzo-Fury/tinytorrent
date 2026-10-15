/**
 * One torrent: metadata, file selection, the request loop, verification and
 * saving, uploads, and the swarm of peers. Driven by the engine's single
 * tick; nothing here owns a timer.
 *
 * Lifecycle: `metadata` (fetching it, for a magnet) → `waiting` (known, no
 * files selected) → `checking` (resume state or re-check) → `downloading` →
 * `seeding` (complete and serving, until the seed limits) → `done`.
 * `pause()` keeps files and resume state; `close()` ends it.
 */

import { EventEmitter } from "node:events";
import { rm } from "node:fs/promises";
import { Bitfield } from "./bitfield";
import type { Established, PeerSource } from "./connections";
import {
  EXT,
  extHandshake,
  MetadataFetcher,
  metadataReply,
  metadataRequest,
  parseExtHandshake,
  parseMetadataMessage,
  parsePex,
} from "./extensions";
import { type Info, type Magnet, type Metainfo, parseInfo } from "./metainfo";
import { RateLimit, takeAll } from "./limits";
import { blockFields, type CloseReason, Peer, type PeerOwner } from "./peer";
import { BLOCK, type PieceState, Picker, SLOTS } from "./picker";
import { deleteResume, loadResume, type ResumeData, resumeMatches, resumePath, saveResume } from "./resume";
import { PieceServer, type SeedLimits, type SeedOverride, seedingDone, seedLimits } from "./seeding";
import { Storage } from "./storage";
import { hostOf, Swarm, type SwarmOwner, withPort } from "./swarm";
import { Announcer } from "./tracker";
import { recheck, SmartBan, verifyPiece } from "./verifier";
import { MSG } from "./wire";
import type { EngineContext } from "./engine";

export type TorrentState = "metadata" | "waiting" | "checking" | "downloading" | "seeding" | "done" | "paused" | "closed";

/** Options for `Engine.add`. */
export interface AddOptions {
  /** Directory the torrent's files are saved under. */
  dir: string;
  /**
   * `all` (default) downloads every file once metadata is known.
   * `metadata-only` stops after metadata until `select()` is called: no block
   * is requested before then.
   */
  start?: "all" | "metadata-only";
  /** File indexes to download; implies starting right away. */
  files?: number[];
  /** Extra tracker URLs. */
  trackers?: string[];
  /** Peers to dial directly, as `host:port`. */
  peers?: string[];
  /** Start paused: nothing connects until `resume()`. */
  paused?: boolean;
  /** Seeding for this torrent: on, off, or its own limits, overriding the engine's `seed`. */
  seed?: SeedOverride;
  /**
   * Trust that the files on disk are complete (when every selected file has
   * its full size) and start seeding at once; each piece is hashed the first
   * time it is uploaded instead of all of them up front. A bad piece leaves
   * seed mode for a full re-check. Resume state, when it matches, wins.
   */
  seedMode?: boolean;
  /** This torrent's own rate limits in bytes per second (0 or absent: none), on top of the engine's. */
  limits?: TorrentLimits;
}

/** A torrent's rate limits, bytes per second; 0 is unlimited. */
export interface TorrentLimits {
  uploadBytesPerSecond?: number;
  downloadBytesPerSecond?: number;
}

/** Per-peer diagnostics from `stats()`. */
export interface PeerStats {
  address: string;
  client: string;
  source: PeerSource;
  downloadRate: number;
  uploadRate: number;
  downloaded: number;
  rtt: number;
  requests: number;
  depth: number;
  peerChoking: boolean;
  amInterested: boolean;
  encrypted: boolean;
  seed: boolean;
}

/** Everything `stats()` reports. */
export interface TorrentStats {
  state: TorrentState;
  progress: number;
  downloadRate: number;
  uploadRate: number;
  downloaded: number;
  uploaded: number;
  wasted: number;
  hashFailures: number;
  peers: PeerStats[];
  connecting: number;
  candidates: number;
  activePieces: number;
  endgame: boolean;
  closeReasons: Record<string, number>;
  trackers: Announcer["trackers"];
  /** All-time totals, across restarts (with resume state). */
  totalUploaded: number;
  totalDownloaded: number;
  /** Uploaded ÷ selected bytes, all time. */
  ratio: number;
  /** Seconds spent seeding, all time. */
  seedSeconds: number;
  /** Upload slots in use and wanted (seeding sizes them by demand). */
  slots: { unchoked: number; target: number };
  /** Upload read cache: disk reads and blocks served from memory. */
  cache: { reads: number; hits: number };
  /** Seed mode: pieces not yet hashed. */
  unverified: number;
}

/** A file with its download progress. */
export interface FileStatus {
  index: number;
  path: string;
  length: number;
  selected: boolean;
  /** Verified bytes of this file. */
  downloaded: number;
}

/** Our name in extended handshakes. */
const CLIENT = "tinytorrent 0.1.0";
/** Queue depth bounds per peer. */
const MIN_DEPTH = 16;
const MAX_DEPTH = 500;
/** A peer with requests out and no block for this long is snubbed. */
const SNUB_MS = 20_000;
/** Resume state is saved this often while downloading. */
const RESUME_EVERY_MS = 5 * 60_000;

export class Torrent extends EventEmitter implements PeerOwner, SwarmOwner {
  public readonly infoHash: Uint8Array;
  public readonly infoHashHex: string;
  public name: string;
  public info: Info | null = null;
  public state: TorrentState;
  public storage: Storage | null = null;
  public picker: Picker | null = null;
  public readonly peers = new Set<Peer>();

  // Totals this session and rates (bytes, bytes per second)
  public downloaded = 0;
  public uploaded = 0;
  public wasted = 0;
  public downloadRate = 0;
  public uploadRate = 0;
  public hashFailures = 0;
  /** Seconds spent seeding, all time. */
  public seedSeconds = 0;
  /** Totals from earlier sessions, from resume state. */
  private before = { uploaded: 0, downloaded: 0 };
  public readonly uploadLimit: RateLimit;
  public readonly downloadLimit: RateLimit;

  private readonly swarm: Swarm;
  private readonly announcer: Announcer;
  private metadata: MetadataFetcher | null = null;
  private gateOpen = false;
  private selection: number[] = [];
  private readonly writes = new Set<Promise<void>>();
  /** Bytes of verified pieces waiting for their disk write; reads pause above an eighth of `maxBufferBytes`. */
  private writeBytes = 0;
  private readonly scratch: number[] = [];
  private tickCount = 0;
  private lastResumeSave = Date.now();
  private lastDhtLookup = 0;
  private lastTick = Date.now();
  private readonly smartBan = new SmartBan<Peer>();
  private server: PieceServer | null = null;
  /** Bytes of the selected files. */
  private selectedBytes = 0;
  /** Whether everything selected was already on disk when the torrent started: no `completed` announce. */
  private startedComplete = false;
  /** Whether peer sockets are paused for the download limit. */
  private readPaused = false;
  private rechecking: Promise<void> | null = null;

  constructor(
    private readonly engine: EngineContext,
    input: Metainfo | Magnet,
    private options: AddOptions,
  ) {
    super();
    this.infoHash = input.infoHash;
    this.infoHashHex = input.infoHashHex;
    this.name = "name" in input && input.name ? input.name : input.infoHashHex;
    this.state = options.paused ? "paused" : "metadata";
    this.uploadLimit = new RateLimit(options.limits?.uploadBytesPerSecond);
    this.downloadLimit = new RateLimit(options.limits?.downloadBytesPerSecond);
    if (!options.files && "select" in input && input.select) this.options = { ...options, files: input.select };
    this.swarm = new Swarm(engine, this);
    const urls = [...("announce" in input ? input.announce : []), ...(options.trackers ?? [])];
    this.announcer = new Announcer(
      "private" in input && input.private ? urls : [...new Set(urls)],
      engine.transport,
      engine.udpTrackers,
      () => ({
        infoHash: this.infoHash,
        peerId: engine.peerId,
        port: engine.announcePort(),
        stats: { downloaded: this.downloaded, uploaded: this.uploaded, left: this.bytesLeft() },
        numWant: this.state === "seeding" ? 50 : 200,
      }),
      (peers) => this.addPeers(peers, "tracker"),
    );
    for (const peer of [...(options.peers ?? []), ...("peers" in input ? input.peers : [])]) this.addPeer(peer, "manual");

    // A full .torrent has metadata already; report it once listeners are attached
    if ("pieces" in input) queueMicrotask(() => this.setInfo(input));
    else this.metadata = new MetadataFetcher(this.infoHash);
  }

  /** The engine's peer id, for handshakes. */
  public get peerId(): Uint8Array {
    return this.engine.peerId;
  }

  /** Fraction of the selected bytes verified, 0–1. */
  public get progress(): number {
    if (!this.picker || !this.storage) return 0;
    const files = this.files().filter((f) => f.selected);
    const total = files.reduce((n, f) => n + f.length, 0);
    return total === 0 ? (this.picker.done && this.selection.length ? 1 : 0) : files.reduce((n, f) => n + f.downloaded, 0) / total;
  }

  /** Adds a peer address to dial. */
  public addPeer(address: string, source: PeerSource = "manual"): void {
    this.swarm.add(address, source);
  }

  private addPeers(addresses: string[], source: PeerSource): void {
    for (const address of addresses) this.addPeer(address, source);
  }

  // ---------- Metadata and selection ---------- //

  private setInfo(info: Info): void {
    if (this.info || this.state === "closed") return;
    this.info = info;
    this.name = info.name;
    this.metadata = null;
    this.storage = new Storage(this.options.dir, info.files, info.pieceLength);
    this.picker = new Picker(info.pieceCount, info.pieceLength, info.length, this.engine.options.maxBufferBytes);
    this.server = new PieceServer({ info, picker: this.picker, storage: this.storage }, this.engine.options.uploadCacheBytes, (index) => {
      this.emit("warning", `Piece ${index} failed its hash check in seed mode; re-checking everything`);
      void this.recheck();
    });
    if (this.state !== "paused") this.state = "waiting";

    // Availability that arrived before we knew the piece count
    for (const peer of this.peers) {
      peer.resize(info.pieceCount);
      this.applyEarly(peer);
    }
    this.emit("metadata", info);
    if (this.options.files) void this.select(this.options.files);
    else if (this.options.start !== "metadata-only") void this.select(info.files.map((_, i) => i));
  }

  /** The torrent's files with their progress. Empty until metadata is known. */
  public files(): FileStatus[] {
    if (!this.info || !this.picker || !this.storage) return [];
    const { pieceLength } = this.info;
    const picker = this.picker;
    const storage = this.storage;
    return this.info.files.map((f, index) => {
      let downloaded = 0;
      if (f.length > 0) {
        const first = Math.floor(f.offset / pieceLength);
        const last = Math.floor((f.offset + f.length - 1) / pieceLength);
        for (let p = first; p <= last; p++) {
          if (!picker.have.has(p)) continue;
          const from = Math.max(f.offset, p * pieceLength);
          const to = Math.min(f.offset + f.length, p * pieceLength + picker.pieceSize(p));
          downloaded += to - from;
        }
      }
      return { index, path: storage.path(index), length: f.length, selected: storage.isSelected(index), downloaded };
    });
  }

  /**
   * Chooses the files to download and opens the request gate. Existing data
   * is reused: trusted from resume state when the files are unchanged (or,
   * in seed mode, when they have their full sizes), otherwise re-checked by
   * hash. A torrent added paused stays paused until `resume()`.
   */
  public async select(fileIndexes: number[]): Promise<void> {
    const { info, picker, storage } = this;
    if (!info || !picker || !storage) throw new Error("Metadata is not known yet");
    if (this.state === "closed") return;
    // A paused torrent checks its data but stays paused (and unconnected) until resume()
    const paused = this.state === "paused";
    const previous = new Set(this.selection);
    this.selection = [...new Set(fileIndexes)].filter((i) => i >= 0 && i < info.files.length);
    this.selectedBytes = this.selection.reduce((n, i) => n + (info.files[i]?.length ?? 0), 0);
    storage.select(this.selection);
    if (!paused) this.state = "checking";
    await storage.createEmpty();

    // Wanted pieces: those overlapping a selected file
    const wanted = this.wantedPieces();
    for (const i of this.selection) {
      const f = info.files[i];
      // A boundary piece verified earlier never had this file's bytes written
      if (!f || f.length === 0 || !previous.size || previous.has(i)) continue;
      picker.forget(Math.floor(f.offset / info.pieceLength));
      picker.forget(Math.floor((f.offset + f.length - 1) / info.pieceLength));
    }
    picker.setWanted(wanted);
    if (!previous.size) {
      await this.restore(wanted);
      this.startedComplete = picker.done;
    }
    if (this.state !== "checking") return; // still paused, or paused or closed meanwhile
    this.open();
  }

  /** Pieces overlapping a selected file. */
  private wantedPieces(): Bitfield {
    const info = this.info as Info;
    const wanted = new Bitfield(info.pieceCount);
    for (const i of this.selection) {
      const f = info.files[i];
      if (!f || f.length === 0) continue;
      const last = Math.floor((f.offset + f.length - 1) / info.pieceLength);
      for (let p = Math.floor(f.offset / info.pieceLength); p <= last; p++) wanted.set(p);
    }
    return wanted;
  }

  /** Opens the request gate after checking: downloading, or seeding if nothing is missing. */
  private open(): void {
    const picker = this.picker as Picker;
    // Seeds dropped while we were one are worth asking again
    if (!picker.done) this.swarm.retryAll();
    this.gateOpen = true;
    this.state = "downloading";
    this.emit("ready");
    for (const peer of this.peers) {
      this.updateInterest(peer);
      this.fill(peer);
    }
    if (picker.done) this.finish();
  }

  /**
   * Hashes every selected piece on disk again, for files that were moved,
   * replaced or damaged, then carries on downloading whatever is missing.
   * Peers stay connected; nothing is served while it runs.
   */
  public recheck(): Promise<void> {
    this.rechecking ??= this.runRecheck().finally(() => (this.rechecking = null));
    return this.rechecking;
  }

  private async runRecheck(): Promise<void> {
    const { info, picker, storage, server } = this;
    if (!info || !picker || !storage || !server || !this.selection.length) throw new Error("Nothing selected to check");
    if (this.state === "closed") return;
    if (this.state !== "paused") this.state = "checking";
    this.gateOpen = false;
    // Piece buffers go back to the pool: a peer halfway through a block would write into a reused one
    for (const peer of [...this.peers]) {
      if (peer.streamingKey >= 0) peer.close("torrent closed");
      else this.returnAll(peer);
    }
    picker.reset();
    await Promise.allSettled([...this.writes]);
    for (let i = 0; i < info.pieceCount; i++) picker.forget(i);
    server.unverified = null;
    server.cache.clear();
    const wanted = this.wantedPieces();
    const pieces: number[] = [];
    for (let i = 0; i < info.pieceCount; i++) if (wanted.has(i)) pieces.push(i);
    await recheck({ hashes: info.pieces, storage, pieceSize: (i) => picker.pieceSize(i) }, pieces, (i) => picker.markHave(i));
    const state = this.state as TorrentState; // it may have changed while hashing
    if (state === "closed") return;
    this.emit("checked", picker.have.count);
    if (state === "checking") this.open();
  }

  /**
   * Marks pieces already on disk as verified: from resume state when it
   * matches the files, as trusted in seed mode when every selected file has
   * its full size, otherwise by re-checking the pieces whose files have data.
   */
  private async restore(wanted: Bitfield): Promise<void> {
    const { info, picker, storage } = this as { info: Info; picker: Picker; storage: Storage };
    const server = this.server as PieceServer;
    const current = await storage.stat();
    const resumeFile = this.engine.options.resumeDir ? resumePath(this.engine.options.resumeDir, this.infoHashHex) : null;
    const saved = resumeFile ? await loadResume(resumeFile) : null;
    if (saved) this.loadTotals(saved);
    if (saved && resumeMatches(saved, current)) {
      const bits = new Bitfield(info.pieceCount, Buffer.from(saved.bitfield, "base64"));
      for (let i = 0; i < info.pieceCount; i++) if (bits.has(i)) picker.markHave(i);
      if (saved.unverified) server.unverified = new Bitfield(info.pieceCount, Buffer.from(saved.unverified, "base64"));
      if (server.unverified?.count === 0) server.unverified = null;
      return;
    }
    if (this.options.seedMode && this.selection.every((i) => current[i]?.size === info.files[i]?.length)) {
      for (let i = 0; i < info.pieceCount; i++) if (wanted.has(i)) picker.markHave(i);
      server.unverified = new Bitfield(info.pieceCount, wanted.bytes);
      return;
    }
    // Re-check wanted pieces whose files already have data
    const pieces: number[] = [];
    for (let i = 0; i < info.pieceCount; i++) {
      if (!wanted.has(i)) continue;
      const touched = storage.segments(i, picker.pieceSize(i));
      if (touched.some((s) => (current[s.file]?.size ?? 0) > 0)) pieces.push(i);
    }
    if (pieces.length === 0) return;
    await recheck({ hashes: info.pieces, storage, pieceSize: (i) => picker.pieceSize(i) }, pieces, (i) => picker.markHave(i));
  }

  private loadTotals(saved: ResumeData): void {
    this.before = { uploaded: saved.uploaded ?? 0, downloaded: saved.downloaded ?? 0 };
    this.seedSeconds += saved.seedSeconds ?? 0;
  }

  /** Bytes uploaded, all time (this session's `uploaded` plus earlier ones). */
  public get totalUploaded(): number {
    return this.before.uploaded + this.uploaded;
  }

  /** Bytes downloaded, all time. */
  public get totalDownloaded(): number {
    return this.before.downloaded + this.downloaded;
  }

  // ---------- Peers ---------- //

  /** Wraps an established connection in a `Peer`. */
  public attach(established: Established, address: string, outgoing: boolean): void {
    if (!this.wantsPeers() || this.peers.size >= this.engine.options.maxPeersPerTorrent + 10) {
      established.socket.destroy();
      return;
    }
    const peer = new Peer(
      this,
      established.socket,
      address,
      outgoing,
      established.encrypt,
      established.decrypt,
      this.info?.pieceCount ?? 0,
      established.rest,
      established.handshakeSent,
      established.encrypted,
    );
    if (!peer.closed) this.swarm.attached(peer);
  }

  public peerReady(peer: Peer): void {
    if (!this.swarm.ready(peer)) return;
    this.peers.add(peer);
    peer.readyAt = Date.now();
    if (this.readPaused) peer.socket.pause();
    if (this.picker) {
      // Registered with no pieces; its bitfield or haves add them
      peer.resize(this.picker.pieceCount);
      peer.counted = true;
    }

    // Introductions: extensions, what we have, and our DHT port
    if (peer.extended) {
      peer.message(MSG.extended, this.extHandshake(), 0);
    }
    const have = this.picker?.have;
    if (have && have.count > 0) peer.message(MSG.bitfield, have.bytes);
    else if (peer.fast) peer.simple(MSG.haveNone);
    const dhtPort = this.engine.dhtPort();
    if (dhtPort) peer.message(MSG.port, Uint8Array.of(dhtPort >> 8, dhtPort & 0xff));
  }

  public peerClosed(peer: Peer, reason: CloseReason): void {
    this.swarm.closed(peer, reason, this.peers.delete(peer));
    const picker = this.picker;
    if (picker) {
      this.returnAll(peer);
      if (peer.streamingKey >= 0) picker.abortStream(peer.streamingKey);
      this.uncount(peer);
    }
  }

  public peerMessage(peer: Peer, id: number, payload: Uint8Array): void {
    switch (id) {
      case MSG.choke:
        peer.peerChoking = true;
        if (!peer.fast) this.returnAll(peer);
        return;
      case MSG.unchoke:
        peer.peerChoking = false;
        peer.lastUsefulAt = Date.now();
        return this.fill(peer);
      case MSG.interested:
        peer.peerInterested = true;
        return this.swarm.interested(peer);
      case MSG.notInterested:
        peer.peerInterested = false;
        return this.swarm.notInterested(peer);
      case MSG.have:
        if (payload.length === 4) this.onHave(peer, ((payload[0] as number) << 24 | (payload[1] as number) << 16 | (payload[2] as number) << 8 | (payload[3] as number)) >>> 0);
        return;
      case MSG.bitfield:
        if (!this.picker) peer.early.bitfield = payload.slice();
        else this.onBitfield(peer, payload);
        return;
      case MSG.haveAll:
        if (!this.picker) peer.early.all = true;
        else this.onHaveAll(peer);
        return;
      case MSG.haveNone:
        return;
      case MSG.request:
        return this.swarm.request(peer, ...blockFields(payload));
      case MSG.cancel: {
        const [index, begin] = blockFields(payload);
        return this.swarm.cancel(peer, index, begin);
      }
      case MSG.reject: {
        const [index, begin] = blockFields(payload);
        const key = index * SLOTS + begin / BLOCK;
        if (peer.requests.delete(key)) this.picker?.returnBlock(key);
        return;
      }
      case MSG.allowedFast:
        if (payload.length === 4) peer.allowedFast.add(blockFields(payload)[0]);
        return;
      case MSG.port:
        if (payload.length === 2) this.engine.dhtAddNode(peer.address, ((payload[0] as number) << 8) | (payload[1] as number));
        return;
      case MSG.extended:
        return this.onExtended(peer, payload);
      default:
        return; // suggest and unknown messages are ignored
    }
  }

  private onHave(peer: Peer, index: number): void {
    if (!this.picker) return void peer.early.haves.push(index);
    if (index >= this.picker.pieceCount || peer.seed || !peer.bitfield.set(index)) return;
    if (peer.counted) this.picker.peerHave(index);
    if (peer.bitfield.full) this.becomeSeed(peer);
    if (!peer.amInterested && this.gateOpen && this.picker.wanted.has(index) && !this.picker.have.has(index)) {
      peer.interested(true);
    }
    this.fill(peer);
  }

  private onBitfield(peer: Peer, payload: Uint8Array): void {
    const picker = this.picker as Picker;
    this.uncount(peer);
    peer.bitfield = new Bitfield(picker.pieceCount, payload);
    peer.counted = true;
    if (peer.bitfield.full) {
      peer.seed = true;
      picker.seeds++;
    } else {
      picker.peerBitfield(peer.bitfield, true);
    }
    this.updateInterest(peer);
    this.dropIfUseless(peer);
  }

  private onHaveAll(peer: Peer): void {
    this.uncount(peer);
    peer.bitfield.fill();
    peer.seed = true;
    peer.counted = true;
    (this.picker as Picker).seeds++;
    this.updateInterest(peer);
    this.dropIfUseless(peer);
  }

  /** Removes a peer's pieces from the availability counts. */
  private uncount(peer: Peer): void {
    const picker = this.picker as Picker;
    if (!peer.counted) return;
    if (peer.seed) picker.seeds--;
    else picker.peerBitfield(peer.bitfield, false);
    peer.counted = false;
    peer.seed = false;
  }

  /** A peer completed its last piece: count it as a seed instead of per piece. */
  private becomeSeed(peer: Peer): void {
    const picker = this.picker as Picker;
    if (peer.counted) picker.peerBitfield(peer.bitfield, false);
    peer.seed = true;
    peer.counted = true;
    picker.seeds++;
    this.dropIfUseless(peer);
  }

  /** While seeding, a peer that only uploads (a seed, or upload-only) has nothing to trade: let it go. */
  private dropIfUseless(peer: Peer): void {
    if (this.state === "seeding" && (peer.seed || peer.uploadOnly)) peer.close("not needed");
  }

  /** Replays a peer's availability that arrived before metadata. */
  private applyEarly(peer: Peer): void {
    const { early } = peer;
    if (early.all) this.onHaveAll(peer);
    else if (early.bitfield) this.onBitfield(peer, early.bitfield);
    else {
      peer.counted = true;
    }
    for (const index of early.haves) this.onHave(peer, index);
    peer.early = { haves: [], all: false };
    this.updateInterest(peer);
  }

  /** Sets interest from scratch: does the peer have any piece we still want? */
  private updateInterest(peer: Peer): void {
    const picker = this.picker;
    if (!picker || !this.gateOpen) return;
    if (picker.missing === 0) return peer.interested(false);
    if (peer.seed) return peer.interested(true);
    const theirs = peer.bitfield.bytes;
    const wanted = picker.wanted.bytes;
    const have = picker.have.bytes;
    for (let i = 0; i < theirs.length; i++) {
      if ((theirs[i] as number) & (wanted[i] as number) & ~(have[i] as number)) return peer.interested(true);
    }
    peer.interested(false);
  }

  // ---------- Requests and blocks ---------- //

  /** How many requests to keep outstanding with a peer: enough to cover its rate over one second plus a round trip. */
  private depth(peer: Peer): number {
    if (peer.snubbed) return 1;
    const wanted = Math.ceil((peer.rateDown * (1 + peer.rtt / 1000)) / BLOCK);
    return Math.min(Math.max(wanted, MIN_DEPTH), peer.reqq, MAX_DEPTH);
  }

  /** Tops up a peer's request queue. */
  private fill(peer: Peer): void {
    const picker = this.picker;
    if (!picker || !this.gateOpen || peer.peerChoking || peer.closed || !peer.amInterested || this.state !== "downloading") return;
    const depth = this.depth(peer);
    const room = depth - peer.requests.size;
    // Top up in batches of a quarter of the queue: fewer, fuller packets
    if (room <= 0 || (room < depth >> 2 && peer.requests.size > 0)) return;
    const keys = this.scratch;
    keys.length = 0;
    picker.pick(peer, room, keys);
    const now = Date.now();
    // The snub timer counts from the oldest unanswered request
    if (peer.requests.size === 0) peer.lastBlockAt = now;
    for (const key of keys) {
      const index = Math.floor(key / SLOTS);
      const b = key % SLOTS;
      const piece = picker.active.get(index) as PieceState;
      peer.requests.set(key, now);
      peer.request(index, b * BLOCK, piece.blockLength(b));
    }
    // Nothing left to ask this peer for
    if (keys.length === 0 && peer.requests.size === 0 && !picker.endgameActive) this.updateInterest(peer);
  }

  /**
   * Endgame safety net: rebuilds the picker's per-block request and stream
   * counts from what peers actually have outstanding, so a count that
   * drifted (a lost cancel, a peer gone mid-block) can't wedge the last
   * pieces. Cheap, and only in endgame.
   */
  private reconcile(): void {
    const requested = new Map<number, number>();
    const streaming = new Set<number>();
    for (const peer of this.peers) {
      for (const key of peer.requests.keys()) requested.set(key, (requested.get(key) ?? 0) + 1);
      if (peer.streamingKey >= 0) streaming.add(peer.streamingKey);
    }
    (this.picker as Picker).reconcile(requested, streaming);
    for (const peer of this.peers) this.fill(peer);
  }

  /** Returns every outstanding request of a peer to the picker. */
  private returnAll(peer: Peer): void {
    for (const key of peer.requests.keys()) this.picker?.returnBlock(key);
    peer.requests.clear();
  }

  public blockTarget(peer: Peer, index: number, begin: number, length: number): Uint8Array | null {
    const dest = this.picker?.blockTarget(index, begin, length) ?? null;
    const key = index * SLOTS + begin / BLOCK;
    if (!dest) {
      // Discarded (a duplicate, or another peer is mid-way through it): the request is over, so return it
      if (peer.requests.delete(key)) this.picker?.returnBlock(key);
      this.wasted += length;
      return null;
    }
    peer.streamingKey = key;
    return dest;
  }

  public blockArrived(peer: Peer, index: number, begin: number, length: number): void {
    const picker = this.picker as Picker;
    const key = index * SLOTS + begin / BLOCK;
    const now = Date.now();
    peer.streamingKey = -1;
    const sentAt = peer.requests.get(key);
    if (sentAt !== undefined) {
      peer.requests.delete(key);
      // Best recent round trip; the tick lets it drift up again slowly
      peer.rtt = Math.min(peer.rtt, now - sentAt + 1);
    }
    peer.lastBlockAt = now;
    peer.lastUsefulAt = now;
    peer.snubbed = false;
    this.downloaded += length;
    this.limitDownload(length);

    const endgame = picker.endgameActive;
    const piece = picker.blockArrived(index, begin, peer);
    if (endgame) {
      // First copy wins; cancel the duplicates
      for (const other of this.peers) {
        if (other !== peer && other.requests.delete(key)) other.cancel(index, begin, length);
      }
    }
    if (piece) this.completePiece(piece);
    this.fill(peer);
  }

  /** Hashes a complete piece, then saves it and tells peers. */
  private completePiece(piece: PieceState): void {
    const info = this.info as Info;
    const picker = this.picker as Picker;
    const storage = this.storage as Storage;
    if (!verifyPiece(info.pieces, piece.index, piece.buf)) {
      this.hashFailures++;
      // One sender: it lied (twice and it's out). Several: smart ban decides later
      const culprit = this.smartBan.failed(piece);
      if (culprit && ++culprit.hashFailures >= 2) culprit.close("hash failures");
      const from = [...new Set(piece.senders)].map((p) => (p instanceof Peer ? `${p.client || "?"} ${p.address}` : "?"));
      picker.pieceFailed(piece);
      this.emit("warning", `Piece ${piece.index} failed its hash check (from ${from.join(", ")})`);
      return;
    }
    for (const liar of this.smartBan.verified(piece)) {
      liar.close("hash failures");
      this.swarm.ban(liar.address);
    }

    picker.pieceVerified(piece);
    this.writeBytes += piece.length;
    this.limitDownload(0);
    const write = storage
      .write(piece.index, piece.buf)
      .then(() => {
        picker.release(piece.buf);
        for (const peer of this.peers) if (!peer.seed && !peer.bitfield.has(piece.index)) peer.have(piece.index);
        this.emit("piece", piece.index);
      })
      .catch((error: Error) => this.fail(error))
      .finally(() => {
        this.writes.delete(write);
        this.writeBytes -= piece.length;
        this.limitDownload(0);
        if (picker.done && this.writes.size === 0 && this.state === "downloading") this.finish();
      });
    this.writes.add(write);
  }

  // ---------- For the swarm ---------- //

  public wantsPeers(): boolean {
    return this.state !== "paused" && this.state !== "closed" && this.state !== "done";
  }

  public seeding(): boolean {
    return this.state === "seeding";
  }

  public isPrivate(): boolean {
    return this.info?.private ?? false;
  }

  public canServe(index: number, begin: number, length: number): boolean {
    return !!this.server && this.gateOpen && this.server.canServe(index, begin, length);
  }

  public readBlock(index: number, begin: number, length: number): Uint8Array | Promise<Uint8Array | null> {
    return (this.server as PieceServer).readBlock(index, begin, length);
  }

  public takeUpload(bytes: number): boolean {
    return takeAll([this.uploadLimit, this.engine.uploadLimit], bytes);
  }

  public uploadedBytes(length: number): void {
    this.uploaded += length;
  }

  /** Announces to every tracker again now (the external port changed). */
  public reannounce(): void {
    if (this.wantsPeers()) this.announcer.reannounce();
  }

  /** Changes this torrent's rate limits (bytes per second, 0 for none). */
  public setLimits(limits: TorrentLimits): void {
    if (limits.uploadBytesPerSecond !== undefined) this.uploadLimit.bytesPerSecond = limits.uploadBytesPerSecond;
    if (limits.downloadBytesPerSecond !== undefined) this.downloadLimit.bytesPerSecond = limits.downloadBytesPerSecond;
  }

  // ---------- Extensions ---------- //

  private onExtended(peer: Peer, payload: Uint8Array): void {
    const id = payload[0];
    const body = payload.subarray(1);
    try {
      if (id === 0) {
        const ext = parseExtHandshake(body);
        if (!ext) return;
        Object.assign(peer.ext, ext.ids);
        peer.metadataSize = ext.metadataSize;
        if (ext.reqq) peer.reqq = ext.reqq;
        if (ext.port) peer.listenPort = ext.port;
        if (ext.client) peer.client = ext.client;
        peer.uploadOnly = ext.uploadOnly;
        this.dropIfUseless(peer);
        // An incoming peer's listening address is worth remembering
        if (!peer.outgoing && ext.port) this.swarm.learnedListenAddress(withPort(hostOf(peer.address), ext.port));
        this.requestMetadata(peer);
      } else if (id === EXT.ut_metadata) {
        this.onMetadataMessage(peer, body);
      } else if (id === EXT.ut_pex && !this.info?.private) {
        this.addPeers(parsePex(body, this.state === "seeding"), "pex"); // a seed has no use for other seeds
      }
    } catch {
      // A malformed extension message is the peer's problem, not ours
    }
  }

  /** Our extended handshake; sent again when we become a seed, to say we only upload now. */
  private extHandshake(): Uint8Array {
    return extHandshake({
      metadataSize: this.info?.raw.length,
      port: this.engine.announcePort(),
      reqq: MAX_DEPTH,
      client: CLIENT,
      uploadOnly: this.state === "seeding",
    });
  }

  /** Asks a peer for up to four pieces of metadata nobody else is fetching. */
  private requestMetadata(peer: Peer): void {
    if (!this.metadata || !peer.ext.ut_metadata || !peer.metadataSize) return;
    for (let i = 0; i < 4; i++) {
      const piece = this.metadata.next(peer.metadataSize, Date.now());
      if (piece < 0) return;
      peer.message(MSG.extended, metadataRequest(piece), peer.ext.ut_metadata);
    }
  }

  private onMetadataMessage(peer: Peer, body: Uint8Array): void {
    const msg = parseMetadataMessage(body);
    if (!msg || !peer.ext.ut_metadata) return;
    if (msg.type === 0) {
      return peer.message(MSG.extended, metadataReply(this.info?.raw, msg.piece), peer.ext.ut_metadata);
    }
    if (msg.type === 1 && msg.data && this.metadata) {
      const raw = this.metadata.receive(msg.piece, msg.data);
      if (raw) {
        this.setInfo(parseInfo(raw));
        return;
      }
      this.requestMetadata(peer);
    }
  }

  // ---------- Tick ---------- //

  /** Called by the engine every 250 ms. */
  public tick(now: number): void {
    const elapsed = now - this.lastTick;
    this.lastTick = now;
    if (this.state === "closed" || this.state === "paused") return;
    this.tickCount++;
    this.uploadLimit.refill(elapsed);
    this.downloadLimit.refill(elapsed);

    // Rates: per-tick counters into ~1 s moving averages
    let down = 0;
    let up = 0;
    for (const peer of this.peers) {
      peer.rateDown += (peer.tickDown * 4 - peer.rateDown) / 4;
      peer.rateUp += (peer.tickUp * 4 - peer.rateUp) / 4;
      down += peer.tickDown;
      up += peer.tickUp;
      peer.tickDown = 0;
      peer.tickUp = 0;
      peer.rtt = Math.min(peer.rtt * 1.01, 5000);

      // Stalled halfway through a block: that block is stuck with it, so it goes
      if (peer.streamingKey >= 0 && now - peer.lastReceivedAt > SNUB_MS) {
        peer.close("timeout");
        continue;
      }
      // Snubbed: requests out, nothing back for a while. Hand its blocks to others
      if (peer.requests.size > 0 && now - peer.lastBlockAt > SNUB_MS && !peer.snubbed) {
        peer.snubbed = true;
        for (const key of peer.requests.keys()) {
          const index = Math.floor(key / SLOTS);
          const piece = this.picker?.active.get(index);
          if (piece) peer.cancel(index, (key % SLOTS) * BLOCK, piece.blockLength(key % SLOTS));
        }
        this.returnAll(peer);
      }
      if (now - peer.lastSentAt > 90_000) peer.keepAlive();
      this.fill(peer);
    }
    this.downloadRate += (down * 4 - this.downloadRate) / 4;
    this.uploadRate += (up * 4 - this.uploadRate) / 4;
    this.limitDownload(0);

    if (this.metadata) for (const peer of this.peers) this.requestMetadata(peer);
    this.swarm.tick(now);
    if (this.tickCount % 40 === 0) {
      for (const peer of this.peers) if (peer.requests.size === 0) this.updateInterest(peer);
      if (this.picker?.endgameActive) this.reconcile();
    }
    if (this.state === "done") return;

    // Discovery: trackers on their intervals; the DHT every 15 minutes (it
    // forgets announces after 30), every 5 while short of peers
    const needPeers = this.state !== "seeding" && this.peers.size < this.engine.options.maxPeersPerTorrent / 2;
    if (!this.info?.private && (this.lastDhtLookup === 0 || now - this.lastDhtLookup > (needPeers ? 5 : 15) * 60_000)) {
      this.lastDhtLookup = now;
      this.engine.dhtLookup(this.infoHash, (peers) => this.addPeers(peers, "dht"));
    }
    this.announcer.tick(now, needPeers);

    if (this.state === "seeding") {
      this.seedSeconds += elapsed / 1000;
      const limits = this.seedLimits();
      if ((limits.ratio || limits.minutes) && seedingDone(limits, this.ratio, this.seedSeconds)) return void this.stopSeeding();
    }
    if ((this.state === "downloading" || this.state === "seeding") && now - this.lastResumeSave > RESUME_EVERY_MS) {
      this.lastResumeSave = now;
      void this.saveResume();
    }
  }

  /**
   * Spends what arrived from the download limits (per block), pausing reads while either is
   * empty or the disk is behind: unbounded, a fast network outran Bun's writes by gigabytes.
   */
  private limitDownload(bytes: number): void {
    const engineLimit = this.engine.downloadLimit;
    this.downloadLimit.spend(bytes);
    engineLimit.spend(bytes);
    const paused = this.downloadLimit.exhausted || engineLimit.exhausted || this.writeBytes > this.engine.options.maxBufferBytes / 8;
    if (paused === this.readPaused) return;
    this.readPaused = paused;
    for (const peer of this.peers) {
      if (paused) peer.socket.pause();
      else peer.socket.resume();
    }
  }

  /** Uploaded ÷ selected bytes, all time. */
  public get ratio(): number {
    return this.selectedBytes > 0 ? this.totalUploaded / this.selectedBytes : 0;
  }

  /** The engine's seed limits with this torrent's override. */
  public seedLimits(): SeedLimits {
    return seedLimits(this.engine.options.seed, this.options.seed);
  }

  // ---------- Lifecycle ---------- //

  /** Everything selected is on disk: announce it, then seed or stop. */
  private finish(): void {
    if (this.state !== "downloading") return;
    const limits = this.seedLimits();
    const seed = limits.enabled && !seedingDone(limits, this.ratio, this.seedSeconds);
    this.state = seed ? "seeding" : "done";
    if (!this.startedComplete) this.announcer.completed();
    this.startedComplete = true;
    void this.saveResume();
    this.emit("done");
    if (!seed) return this.leave();
    // Say we only upload now, and drop peers that only upload too
    for (const peer of [...this.peers]) {
      if (peer.extended) peer.message(MSG.extended, this.extHandshake(), 0);
      this.dropIfUseless(peer);
    }
  }

  /** The seed limits are reached: stop serving. */
  private stopSeeding(): void {
    this.state = "done";
    void this.saveResume();
    this.emit("seeded");
    this.leave();
  }

  /** Done for good: disconnect and tell trackers we left. */
  private leave(): void {
    this.server?.cache.clear();
    for (const peer of [...this.peers]) peer.close("done");
    this.swarm.closeAll("done");
    void this.announcer.stop();
  }

  private fail(error: Error): void {
    if (this.state === "closed") return;
    this.emit("error", error);
    void this.pause();
  }

  /**
   * Stops all transfers and disconnects every peer, keeping the files and
   * writing resume state. In-flight pieces that weren't complete are dropped.
   */
  public async pause(): Promise<void> {
    if (this.state === "closed" || this.state === "paused") return;
    const wasGateOpen = this.gateOpen;
    const wasActive = this.state !== "done";
    this.state = "paused";
    this.gateOpen = false;
    this.swarm.closeAll("torrent closed");
    this.picker?.reset();
    this.server?.cache.clear();
    if (wasActive) void this.announcer.stop();
    await Promise.allSettled([...this.writes]);
    if (wasGateOpen) await this.saveResume();
  }

  /** Continues after `pause()` (or after adding paused). */
  public resume(): void {
    if (this.state !== "paused") return;
    if (!this.picker) {
      this.state = "metadata";
      return;
    }
    if (!this.selection.length) {
      this.state = "waiting";
      if (this.options.files) void this.select(this.options.files);
      else if (this.options.start !== "metadata-only") void this.select((this.info as Info).files.map((_, i) => i));
      return;
    }
    this.swarm.retryAll();
    if (!this.picker.done) return this.open();
    const limits = this.seedLimits();
    this.gateOpen = true;
    this.state = limits.enabled && !seedingDone(limits, this.ratio, this.seedSeconds) ? "seeding" : "done";
  }

  /** Ends the torrent. Files are kept unless `deleteFiles` is set. */
  public async close(options: { deleteFiles?: boolean } = {}): Promise<void> {
    if (this.state === "closed") return;
    await this.pause();
    this.state = "closed";
    this.engine.removed(this);
    await this.storage?.close();
    if (options.deleteFiles) {
      if (this.storage) for (const f of this.files()) await rm(f.path, { force: true });
      if (this.engine.options.resumeDir) await deleteResume(resumePath(this.engine.options.resumeDir, this.infoHashHex));
    }
    this.emit("close");
  }

  private async saveResume(): Promise<void> {
    const dir = this.engine.options.resumeDir;
    if (!dir || !this.picker || !this.storage || !this.selection.length) return;
    await Promise.allSettled([...this.writes]);
    const unverified = this.server?.unverified;
    await saveResume(resumePath(dir, this.infoHashHex), {
      infoHash: this.infoHashHex,
      bitfield: Buffer.from(this.picker.have.bytes).toString("base64"),
      files: await this.storage.stat(),
      uploaded: this.totalUploaded,
      downloaded: this.totalDownloaded,
      seedSeconds: Math.round(this.seedSeconds),
      unverified: unverified ? Buffer.from(unverified.bytes).toString("base64") : undefined,
    }).catch((error: Error) => this.emit("warning", `Could not save resume state: ${error.message}`));
  }

  /** Bytes of the selected files not yet verified (the whole torrent before selection). */
  private bytesLeft(): number {
    if (!this.picker || !this.info) return this.info?.length ?? 1;
    if (!this.selection.length) return this.info.length;
    return this.files().reduce((n, f) => n + (f.selected ? f.length - f.downloaded : 0), 0);
  }

  /** A snapshot for diagnostics: why is it slow? */
  public stats(): TorrentStats {
    return {
      state: this.state,
      progress: this.progress,
      downloadRate: this.downloadRate,
      uploadRate: this.uploadRate,
      downloaded: this.downloaded,
      uploaded: this.uploaded,
      wasted: this.wasted,
      hashFailures: this.hashFailures,
      peers: [...this.peers].map((p) => ({
        address: p.address,
        client: p.client,
        source: this.swarm.source(p.address),
        downloadRate: p.rateDown,
        uploadRate: p.rateUp,
        downloaded: p.downloaded,
        rtt: p.rtt,
        requests: p.requests.size,
        depth: this.depth(p),
        peerChoking: p.peerChoking,
        amInterested: p.amInterested,
        encrypted: p.encrypted,
        seed: p.seed,
      })),
      ...this.swarm.stats(),
      activePieces: this.picker?.active.size ?? 0,
      endgame: this.picker?.endgameActive ?? false,
      trackers: this.announcer.trackers,
      totalUploaded: this.totalUploaded,
      totalDownloaded: this.totalDownloaded,
      ratio: this.ratio,
      seedSeconds: this.seedSeconds,
      slots: this.swarm.slots(),
      cache: { reads: this.server?.cache.reads ?? 0, hits: this.server?.cache.hits ?? 0 },
      unverified: this.server?.unverified?.count ?? 0,
    };
  }
}

