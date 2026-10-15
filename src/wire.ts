/**
 * The peer wire protocol: a push parser fed straight from socket chunks, and
 * encoders for outgoing messages.
 *
 * The parser never builds message objects and never concatenates chunks for
 * block data. When a `piece` message's 13-byte header has arrived, it asks
 * the handler for a destination (a view into the piece's buffer) and copies
 * the payload there as chunks arrive: one copy per byte, socket to piece.
 * Only small control messages that straddle a chunk boundary are buffered.
 */

/** Message ids (BEP 3, BEP 6, BEP 10). */
export const MSG = {
  choke: 0,
  unchoke: 1,
  interested: 2,
  notInterested: 3,
  have: 4,
  bitfield: 5,
  request: 6,
  piece: 7,
  cancel: 8,
  port: 9,
  suggest: 13,
  haveAll: 14,
  haveNone: 15,
  reject: 16,
  allowedFast: 17,
  extended: 20,
} as const;

/** Largest non-piece message accepted: a bitfield for 2M pieces, or an extension message. */
const MAX_MESSAGE = 1 << 18;
/** Largest block a peer may send; requests are 16 KiB and some clients allow up to 128 KiB. */
const MAX_BLOCK = 1 << 17;

const PROTOCOL = new TextEncoder().encode("BitTorrent protocol");

/** What the parser calls as messages arrive. Implemented by `Peer`. */
export interface WireHandler {
  onHandshake(infoHash: Uint8Array, peerId: Uint8Array, reserved: Uint8Array): void;
  /** Any non-piece message. `payload` is only valid during the call. */
  onMessage(id: number, payload: Uint8Array): void;
  /**
   * A block is arriving; return the piece's buffer (its bytes go at `begin`),
   * or `null` to discard them.
   */
  onPieceStart(index: number, begin: number, length: number): Uint8Array | null;
  /** The block announced by `onPieceStart` has fully arrived. */
  onPieceEnd(index: number, begin: number, length: number): void;
}

/** Thrown for protocol violations; the peer is dropped. */
export class WireError extends Error {}

export class WireParser {
  /** Bytes of an incomplete message, kept across chunks. */
  private pending: Uint8Array | null = null;
  private handshaken = false;
  // Block currently streaming into its destination
  private blockDest: Uint8Array | null = null;
  private blockRemaining = 0;
  private blockIndex = 0;
  private blockBegin = 0;
  private blockLength = 0;
  private blockWritten = 0;

  constructor(
    private readonly handler: WireHandler,
    /** False when the handshake was already consumed (an MSE stream or an incoming connection). */
    expectHandshake = true,
  ) {
    this.handshaken = !expectHandshake;
  }

  /** Feeds one socket chunk. Throws `WireError` on a protocol violation. */
  public push(chunk: Uint8Array): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.blockRemaining > 0) {
        offset = this.streamBlock(chunk, offset);
      } else if (this.pending) {
        offset = this.completePending(chunk, offset);
      } else {
        const consumed = this.handshaken ? this.message(chunk, offset) : this.handshake(chunk, offset);
        if (consumed === 0) {
          // Incomplete: keep the tail (a copy, since the chunk may be reused)
          this.pending = chunk.slice(offset);
          return;
        }
        offset += consumed;
      }
    }
  }

  /**
   * Extends a fragment that straddled chunks with just the bytes it still
   * needs, never the rest of the chunk, so block data is not copied twice.
   */
  private completePending(chunk: Uint8Array, offset: number): number {
    const pending = this.pending as Uint8Array;
    const need = this.bytesNeeded(pending);
    const take = Math.min(need - pending.length, chunk.length - offset);
    const joined = new Uint8Array(pending.length + take);
    joined.set(pending);
    joined.set(chunk.subarray(offset, offset + take), pending.length);
    this.pending = null;

    if (joined.length < need) {
      this.pending = joined;
    } else if (joined.length === need) {
      // Complete only if it is the whole message; a 4- or 5-byte prefix just
      // told us how much more to wait for
      const consumed = this.handshaken ? this.message(joined, 0) : this.handshake(joined, 0);
      if (consumed === 0) this.pending = joined;
    }
    return offset + take;
  }

  /** How many bytes the fragment at the front of `pending` needs before it can be parsed. */
  private bytesNeeded(pending: Uint8Array): number {
    if (!this.handshaken) return 68;
    if (pending.length < 4) return 4;
    const length = readU32(pending, 0);
    if (length === 0) return 4;
    if (pending.length < 5) return 5;
    if (pending[4] === MSG.piece) return 13;
    if (length > MAX_MESSAGE) throw new WireError(`Message of ${length} bytes is too large`);
    return 4 + length;
  }

  /** Parses the 68-byte handshake; returns bytes consumed, or 0 if incomplete. */
  private handshake(data: Uint8Array, offset: number): number {
    if (data.length - offset < 68) {
      // Reject garbage early instead of waiting for 68 bytes
      if (data[offset] !== 19) throw new WireError("Not a BitTorrent handshake");
      return 0;
    }
    if (data[offset] !== 19) throw new WireError("Not a BitTorrent handshake");
    for (let i = 0; i < 19; i++) {
      if (data[offset + 1 + i] !== PROTOCOL[i]) throw new WireError("Not a BitTorrent handshake");
    }
    this.handshaken = true;
    this.handler.onHandshake(
      data.slice(offset + 28, offset + 48),
      data.slice(offset + 48, offset + 68),
      data.slice(offset + 20, offset + 28),
    );
    return 68;
  }

  /** Parses one length-prefixed message; returns bytes consumed, or 0 if incomplete. */
  private message(data: Uint8Array, offset: number): number {
    const available = data.length - offset;
    if (available < 4) return 0;
    const length = readU32(data, offset);
    if (length === 0) return 4; // keep-alive
    if (available < 5) return 0;
    const id = data[offset + 4] as number;

    if (id === MSG.piece) {
      if (length < 9 || length - 9 > MAX_BLOCK) throw new WireError("Bad piece length");
      if (available < 13) return 0;
      this.blockIndex = readU32(data, offset + 5);
      this.blockBegin = readU32(data, offset + 9);
      this.blockLength = length - 9;
      this.blockRemaining = this.blockLength;
      this.blockWritten = 0;
      this.blockDest = this.handler.onPieceStart(this.blockIndex, this.blockBegin, this.blockLength);
      if (this.blockLength === 0) this.finishBlock();
      return 13;
    }

    if (length > MAX_MESSAGE) throw new WireError(`Message of ${length} bytes is too large`);
    if (available < 4 + length) return 0;
    this.handler.onMessage(id, data.subarray(offset + 5, offset + 4 + length));
    return 4 + length;
  }

  /** Copies block bytes from `data` into the destination; returns the new offset. */
  private streamBlock(data: Uint8Array, offset: number): number {
    const take = Math.min(this.blockRemaining, data.length - offset);
    if (this.blockDest) {
      // Whole chunks (the common case on slow links) need no view
      const bytes = offset === 0 && take === data.length ? data : data.subarray(offset, offset + take);
      this.blockDest.set(bytes, this.blockBegin + this.blockWritten);
    }
    this.blockWritten += take;
    this.blockRemaining -= take;
    if (this.blockRemaining === 0) this.finishBlock();
    return offset + take;
  }

  private finishBlock(): void {
    const hadDest = this.blockDest !== null;
    this.blockDest = null;
    if (hadDest) this.handler.onPieceEnd(this.blockIndex, this.blockBegin, this.blockLength);
  }
}

// ---------- Encoding ---------- //

/** The 68-byte handshake. Reserved bits advertise the extension protocol (BEP 10), fast extension (BEP 6) and DHT. */
export function handshake(infoHash: Uint8Array, peerId: Uint8Array): Uint8Array {
  const out = new Uint8Array(68);
  out[0] = 19;
  out.set(PROTOCOL, 1);
  out[20 + 5] = 0x10; // extension protocol
  out[20 + 7] = 0x05; // fast extension (0x04) and DHT (0x01)
  out.set(infoHash, 28);
  out.set(peerId, 48);
  return out;
}

/** Size of the pooled buffers upload batches are built in (a 256 KiB batch and its headers fit). */
const LARGE = 512 * 1024;
/**
 * Large buffers shared by every connection, at most 16 MiB: a batch is built
 * in one and handed to the socket, which gives it back once written. Growing
 * a fresh buffer per batch instead left hundreds of MB of garbage.
 */
const pool: Uint8Array[] = [];

/**
 * Builds outgoing messages into one buffer, flushed as a single socket
 * write. Requests, haves and control messages from one event-loop turn
 * leave in one packet instead of dozens.
 */
export class OutBuffer {
  private readonly small = new Uint8Array(1024);
  private buf: Uint8Array = this.small;
  private len = 0;

  /** Bytes waiting to be flushed. */
  public get size(): number {
    return this.len;
  }

  /**
   * Hands the queued bytes to the socket. Small batches are copied, so the
   * buffer is reused; a large batch of upload blocks gives its buffer away
   * instead (see `recycle`) and the next starts small again.
   */
  public take(): Uint8Array {
    const len = this.len;
    const full = this.buf;
    this.len = 0;
    this.buf = this.small;
    if (len > 1 << 16) return full.subarray(0, len);
    if (full !== this.small) this.recycle(full); // a large buffer holding a small batch
    return full.slice(0, len);
  }

  /**
   * Takes back a buffer from `take` once the socket has written it (Bun
   * keeps a reference until then, so reusing it sooner corrupts the stream).
   */
  public recycle(data: Uint8Array): void {
    const whole = new Uint8Array(data.buffer);
    if (whole.length === LARGE && pool.length < 32) pool.push(whole);
  }

  /** A message with only an id. */
  public simple(id: number): void {
    const o = this.reserve(5);
    writeU32(this.buf, o, 1);
    this.buf[o + 4] = id;
  }

  public have(index: number): void {
    const o = this.reserve(9);
    writeU32(this.buf, o, 5);
    this.buf[o + 4] = MSG.have;
    writeU32(this.buf, o + 5, index);
  }

  /** `request`, `cancel` and `reject` share a layout. */
  public block(id: number, index: number, begin: number, length: number): void {
    const o = this.reserve(17);
    writeU32(this.buf, o, 13);
    this.buf[o + 4] = id;
    writeU32(this.buf, o + 5, index);
    writeU32(this.buf, o + 9, begin);
    writeU32(this.buf, o + 13, length);
  }

  /** A message with an arbitrary payload (bitfield, extended, port). */
  public payload(id: number, payload: Uint8Array, prefix?: number): void {
    const extra = prefix === undefined ? 0 : 1;
    const o = this.reserve(5 + extra + payload.length);
    writeU32(this.buf, o, 1 + extra + payload.length);
    this.buf[o + 4] = id;
    if (prefix !== undefined) this.buf[o + 5] = prefix;
    this.buf.set(payload, o + 5 + extra);
  }

  /** A `piece` message header; the block data follows as a separate write. */
  public pieceHeader(index: number, begin: number, length: number): void {
    const o = this.reserve(13);
    writeU32(this.buf, o, 9 + length);
    this.buf[o + 4] = MSG.piece;
    writeU32(this.buf, o + 5, index);
    writeU32(this.buf, o + 9, begin);
  }

  /** Raw bytes, such as a block's data or a handshake. */
  public raw(data: Uint8Array): void {
    const o = this.reserve(data.length);
    this.buf.set(data, o);
  }

  private reserve(n: number): number {
    if (this.len + n > this.buf.length) {
      // Outgrowing the small buffer moves into a pooled large one (returned by `take`)
      const need = Math.max(this.buf.length * 2, this.len + n);
      const grown = need <= LARGE ? (pool.pop() ?? unzeroed(LARGE)) : unzeroed(need);
      grown.set(this.buf.subarray(0, this.len));
      if (this.buf !== this.small) this.recycle(this.buf);
      this.buf = grown;
    }
    const at = this.len;
    this.len += n;
    return at;
  }
}

/**
 * A plain `Uint8Array` without zero-filling, which showed in upload profiles.
 * Not a `Buffer`: its `slice` would be a view, not the copy `take` relies on.
 */
export function unzeroed(n: number): Uint8Array {
  const b = Buffer.allocUnsafeSlow(n);
  return new Uint8Array(b.buffer, b.byteOffset, n);
}

export function readU32(b: Uint8Array, o: number): number {
  return (((b[o] as number) << 24) | ((b[o + 1] as number) << 16) | ((b[o + 2] as number) << 8) | (b[o + 3] as number)) >>> 0;
}

export function writeU32(b: Uint8Array, o: number, v: number): void {
  b[o] = v >>> 24;
  b[o + 1] = v >>> 16;
  b[o + 2] = v >>> 8;
  b[o + 3] = v;
}
