/**
 * One peer connection after the transport (and MSE, if any) is set up:
 * protocol state, the parser, batched writes, and the cheap meters the
 * torrent uses to size request queues and judge peers.
 *
 * Writes from one event-loop turn are gathered in an `OutBuffer` and leave as
 * one socket write, after encryption if the stream is RC4.
 */

import type { Socket } from "node:net";
import { Bitfield } from "./bitfield";
import type { StreamCipher } from "./mse";
import type { PieceState, PickerPeer } from "./picker";
import { handshake, MSG, OutBuffer, readU32, WireError, type WireHandler, WireParser } from "./wire";

/** Why a peer was disconnected, kept for diagnostics. */
export type CloseReason =
  | "closed by peer"
  | "error"
  | "protocol"
  | "self"
  | "duplicate"
  | "wrong torrent"
  | "timeout"
  | "slow"
  | "useless"
  | "not needed"
  | "hash failures"
  | "torrent closed"
  | "done";

/** What a peer reports to its torrent. Implemented by `Torrent`. */
export interface PeerOwner {
  readonly infoHash: Uint8Array;
  readonly peerId: Uint8Array;
  peerReady(peer: Peer): void;
  peerClosed(peer: Peer, reason: CloseReason): void;
  peerMessage(peer: Peer, id: number, payload: Uint8Array): void;
  blockTarget(peer: Peer, index: number, begin: number, length: number): Uint8Array | null;
  blockArrived(peer: Peer, index: number, begin: number, length: number): void;
}

export class Peer implements WireHandler, PickerPeer {
  public peerId: Uint8Array | null = null;
  public bitfield: Bitfield;
  public seed = false;
  public readonly requests = new Map<number, number>();
  public current: PieceState | null = null;

  // Protocol state
  public amChoking = true;
  public amInterested = false;
  public peerChoking = true;
  public peerInterested = false;
  public fast = false;
  public extended = false;
  /** Extension message ids the peer assigned (BEP 10). */
  public readonly ext: Record<string, number> = {};
  /** The peer's request queue limit. */
  public reqq = 250;
  public metadataSize = 0;
  public listenPort = 0;
  public client = "";
  /** The peer said it only uploads (BEP 21): it wants nothing from us. */
  public uploadOnly = false;
  /** Pieces we may request while choked (BEP 6). */
  public readonly allowedFast = new Set<number>();

  // Meters, decayed once per tick by the torrent
  public downloaded = 0;
  public uploaded = 0;
  public tickDown = 0;
  public tickUp = 0;
  public rateDown = 0;
  public rateUp = 0;
  /** Best recent round trip for a block request, in ms. */
  public rtt = 500;
  public connectedAt = Date.now();
  public lastBlockAt = Date.now();
  public lastUsefulAt = Date.now();
  public snubbed = false;
  public hashFailures = 0;
  public closed = false;
  public closeReason: CloseReason | null = null;
  /** Pending block uploads: [index, begin, length]. */
  public readonly uploads: number[][] = [];
  /** Whether a block upload is being read from disk. */
  public uploading = false;
  /** Whether uploads wait for the socket to drain. */
  public waitingDrain = false;
  /** When we last unchoked it, and last choked it (or connected): seed slots rotate by these. */
  public unchokedAt = 0;
  public chokedAt = Date.now();
  /** The block being copied into a piece buffer right now, or -1. */
  public streamingKey = -1;
  /** Whether this peer's pieces are counted in the picker's availability. */
  public counted = false;
  /** Availability that arrived before the torrent knew its piece count. */
  public early: { bitfield?: Uint8Array; haves: number[]; all: boolean } = { haves: [], all: false };
  public lastSentAt = Date.now();
  /** When any bytes last arrived. */
  public lastReceivedAt = Date.now();
  public readyAt = 0;

  private readonly parser: WireParser;
  private readonly out = new OutBuffer();
  private flushQueued = false;
  private handshakeSent: boolean;

  constructor(
    private readonly owner: PeerOwner,
    public readonly socket: Socket,
    /** `ip:port` as dialled, or as seen for incoming peers. */
    public readonly address: string,
    public readonly outgoing: boolean,
    private readonly encrypt: StreamCipher,
    private readonly decrypt: StreamCipher,
    pieceCount: number,
    /** Bytes already read past the transport handshake, decrypted. */
    initial: Uint8Array,
    /** Whether our handshake was already sent (inside MSE). */
    handshakeSent: boolean,
    public readonly encrypted: boolean,
  ) {
    this.bitfield = new Bitfield(pieceCount);
    this.parser = new WireParser(this);
    this.handshakeSent = handshakeSent;

    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    socket.on("close", () => this.close("closed by peer"));
    socket.on("error", () => this.close("error"));
    socket.setTimeout(0);
    if (outgoing && !handshakeSent) this.sendHandshake();
    if (initial.length) this.parse(initial);
  }

  /** The torrent learned its piece count (after fetching metadata). */
  public resize(pieceCount: number): void {
    if (this.bitfield.size === pieceCount) return;
    const old = this.bitfield;
    this.bitfield = new Bitfield(pieceCount, old.bytes);
  }

  // ---------- Receiving ---------- //

  private receive(chunk: Uint8Array): void {
    if (this.closed) return;
    this.lastReceivedAt = Date.now();
    this.parse(this.decrypt ? this.decrypt.update(chunk) : chunk);
  }

  /** Feeds decrypted bytes to the parser; a protocol violation drops the peer. */
  private parse(data: Uint8Array): void {
    try {
      this.parser.push(data);
    } catch (error) {
      if (error instanceof WireError || error instanceof RangeError) this.close("protocol");
      else throw error;
    }
  }

  public onHandshake(infoHash: Uint8Array, peerId: Uint8Array, reserved: Uint8Array): void {
    if (!Buffer.from(infoHash).equals(this.owner.infoHash)) return this.close("wrong torrent");
    if (Buffer.from(peerId).equals(this.owner.peerId)) return this.close("self");
    this.peerId = peerId;
    this.client = clientName(peerId);
    this.extended = ((reserved[5] as number) & 0x10) !== 0;
    this.fast = ((reserved[7] as number) & 0x04) !== 0;
    if (!this.handshakeSent) this.sendHandshake();
    this.owner.peerReady(this);
  }

  // A peer closed partway through a chunk (say, for a bad piece) ignores the
  // rest of it: a block started now would never be cleaned up
  public onMessage(id: number, payload: Uint8Array): void {
    if (!this.closed) this.owner.peerMessage(this, id, payload);
  }

  public onPieceStart(index: number, begin: number, length: number): Uint8Array | null {
    return this.closed ? null : this.owner.blockTarget(this, index, begin, length);
  }

  public onPieceEnd(index: number, begin: number, length: number): void {
    if (this.closed) return;
    this.downloaded += length;
    this.tickDown += length;
    this.owner.blockArrived(this, index, begin, length);
  }

  // ---------- Sending ---------- //

  private sendHandshake(): void {
    this.handshakeSent = true;
    this.out.raw(handshake(this.owner.infoHash, this.owner.peerId));
    this.flush();
  }

  public choke(choke: boolean, now = Date.now()): void {
    if (this.amChoking === choke) return;
    this.amChoking = choke;
    if (choke) this.chokedAt = now;
    else this.unchokedAt = now;
    this.out.simple(choke ? MSG.choke : MSG.unchoke);
    if (choke) {
      // Choking discards queued uploads; with the fast extension, reject each
      if (this.fast) for (const [i, b, l] of this.uploads) this.out.block(MSG.reject, i as number, b as number, l as number);
      this.uploads.length = 0;
    }
    this.schedule();
  }

  public interested(interested: boolean): void {
    if (this.amInterested === interested) return;
    this.amInterested = interested;
    this.out.simple(interested ? MSG.interested : MSG.notInterested);
    this.schedule();
  }

  public have(index: number): void {
    this.out.have(index);
    this.schedule();
  }

  public request(index: number, begin: number, length: number): void {
    this.out.block(MSG.request, index, begin, length);
    this.schedule();
  }

  public cancel(index: number, begin: number, length: number): void {
    this.out.block(MSG.cancel, index, begin, length);
    this.schedule();
  }

  public reject(index: number, begin: number, length: number): void {
    if (!this.fast) return;
    this.out.block(MSG.reject, index, begin, length);
    this.schedule();
  }

  public message(id: number, payload: Uint8Array, prefix?: number): void {
    this.out.payload(id, payload, prefix);
    this.schedule();
  }

  public simple(id: number): void {
    this.out.simple(id);
    this.schedule();
  }

  /** An empty message, so the peer doesn't time us out while nothing else is said. */
  public keepAlive(): void {
    this.out.raw(new Uint8Array(4));
    this.schedule();
  }

  /**
   * Queues one block of upload data; the caller flushes once per batch.
   * Returns false when the socket is backed up. (Writing cached bytes to the
   * socket without the copy saved 13% CPU on plaintext uploads but doubled
   * peak memory, so blocks are copied.)
   */
  public block(index: number, begin: number, data: Uint8Array): boolean {
    this.out.pieceHeader(index, begin, data.length);
    this.uploaded += data.length;
    this.tickUp += data.length;
    this.out.raw(data);
    return !this.socket.writableNeedDrain;
  }

  /** Bytes queued and not yet written. */
  public get queued(): number {
    return this.out.size;
  }

  /** Flushes after the current turn, so a burst of messages leaves as one write. */
  private schedule(): void {
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => this.flush());
  }

  /** Writes everything queued. Returns false when the socket is backed up. */
  public flush(): boolean {
    this.flushQueued = false;
    if (this.closed || this.out.size === 0) return true;
    const data = this.out.take();
    this.lastSentAt = Date.now();
    const out = this.encrypt ? this.encrypt.update(data) : data;
    // A large batch's buffer goes back to the OutBuffer once written
    if (out.length <= 1 << 16) return this.socket.write(out);
    return this.socket.write(out, (error) => error || this.out.recycle(out));
  }

  /** Disconnects; the torrent hears about it once. */
  public close(reason: CloseReason): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    this.socket.destroy();
    this.owner.peerClosed(this, reason);
  }
}

/** Reads a request-shaped payload (index, begin, length). */
export function blockFields(payload: Uint8Array): [number, number, number] {
  return [readU32(payload, 0), readU32(payload, 4), readU32(payload, 8)];
}

/** A short client name from an Azureus-style peer id, such as `qB 4.6.2`. */
function clientName(peerId: Uint8Array): string {
  if (peerId[0] !== 0x2d || peerId[7] !== 0x2d) return "";
  return new TextDecoder().decode(peerId.subarray(1, 7));
}
