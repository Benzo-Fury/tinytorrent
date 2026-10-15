/**
 * Message Stream Encryption (MSE/PE), the obfuscation most clients speak.
 *
 * The Diffie-Hellman exchange uses the protocol's fixed 768-bit group with
 * BigInt arithmetic: about 1–2 ms per handshake. `node:crypto`'s
 * `createDiffieHellman` re-validates the prime for every connection, which
 * costs ~200 ms of main-thread CPU per peer on ARM under Bun — the single
 * largest cost measured in WebTorrent. A key pair is reused for a few dozen
 * connections, halving the modular exponentiations.
 *
 * RC4 is a few lines of JavaScript that transform data in place. Bun's native
 * cipher allocates a new buffer per call, and with VPN-sized chunks (~1.2 KB)
 * that per-call cost dominated: the JS version is 1.4× faster on ARM and
 * allocates nothing.
 *
 * `MseHandshake` is a byte-driven state machine for either side. It is fed
 * raw socket chunks and emits bytes to send, then finishes with the stream
 * ciphers (or none, if plaintext was selected) and any bytes that arrived
 * after the handshake, already decrypted.
 */

import { createHash, randomBytes } from "node:crypto";

const PRIME_HEX =
  "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A63A36210000000000090563";
const P = BigInt(`0x${PRIME_HEX}`);
const G = 2n;
const KEY_BYTES = 96;
const MAX_PAD = 512;
const VC = new Uint8Array(8);

/** Crypto methods in `crypto_provide` / `crypto_select`. */
export const CRYPTO_PLAIN = 0x01;
export const CRYPTO_RC4 = 0x02;

/** Thrown when the handshake fails; the connection is dropped. */
export class MseError extends Error {}

/** RC4 with the first 1024 bytes of keystream dropped, as MSE requires. Transforms in place. */
export class Rc4 {
  private readonly s = new Uint8Array(256);
  private i = 0;
  private j = 0;

  constructor(key: Uint8Array) {
    const s = this.s;
    for (let i = 0; i < 256; i++) s[i] = i;
    for (let i = 0, j = 0; i < 256; i++) {
      j = (j + (s[i] as number) + (key[i % key.length] as number)) & 255;
      const t = s[i] as number;
      s[i] = s[j] as number;
      s[j] = t;
    }
    this.update(new Uint8Array(1024));
  }

  /** Encrypts or decrypts `data` in place and returns it. */
  public update(data: Uint8Array): Uint8Array {
    const s = this.s;
    let i = this.i;
    let j = this.j;
    for (let k = 0; k < data.length; k++) {
      i = (i + 1) & 255;
      const si = s[i] as number;
      j = (j + si) & 255;
      const sj = s[j] as number;
      s[i] = sj;
      s[j] = si;
      data[k]! ^= s[(si + sj) & 255] as number;
    }
    this.i = i;
    this.j = j;
    return data;
  }
}

type Cipher = Rc4;

/** Converts an RC4-or-plaintext stream; `null` means plaintext. */
export type StreamCipher = Rc4 | null;

/** The outcome of a finished handshake. */
export interface MseResult {
  /** Encrypts outgoing bytes, or `null` for plaintext. */
  encrypt: StreamCipher;
  /** Decrypts incoming bytes, or `null` for plaintext. */
  decrypt: StreamCipher;
  /** The torrent the peer asked for (receiver side). */
  infoHash: Uint8Array;
  /** Bytes after the handshake, already decrypted: usually the peer's BitTorrent handshake. */
  rest: Uint8Array;
}

/** Options for one side of a handshake. */
export interface MseOptions {
  /** Initiator: the torrent's info hash. Receiver: every info hash we serve. */
  infoHashes: Uint8Array[];
  /** Initiator: methods offered. Receiver: methods accepted, preferring RC4 unless `preferPlain`. */
  allow: number;
  preferPlain?: boolean;
  /** Initiator: bytes sent encrypted inside the handshake (our BitTorrent handshake). */
  initialPayload?: Uint8Array;
  send: (bytes: Uint8Array) => void;
}

// ---------- Diffie-Hellman ---------- //

/** Connections that share one key pair before a fresh one is made. */
const KEY_REUSE = 32;
let sharedKeys: { keys: MseKeyPair; uses: number } | null = null;

/** A key pair, shared by a few connections: the exponentiation is the expensive half of the handshake. */
function keyPair(): MseKeyPair {
  if (!sharedKeys || sharedKeys.uses >= KEY_REUSE) sharedKeys = { keys: new MseKeyPair(), uses: 0 };
  sharedKeys.uses++;
  return sharedKeys.keys;
}

/** One side's key pair in the fixed MSE group. */
export class MseKeyPair {
  private readonly secret = BigInt(`0x${randomBytes(20).toString("hex")}`);
  /** Our public key, 96 bytes big-endian. */
  public readonly publicKey = toBytes(modPow(G, this.secret));

  /** The shared secret S for the other side's public key. */
  public sharedSecret(otherPublic: Uint8Array): Uint8Array {
    const y = BigInt(`0x${Buffer.from(otherPublic).toString("hex") || "0"}`);
    if (y <= 1n || y >= P - 1n) throw new MseError("Invalid public key");
    return toBytes(modPow(y, this.secret));
  }
}

function modPow(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let b = base % P;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return result;
}

function toBytes(n: bigint): Uint8Array {
  return new Uint8Array(Buffer.from(n.toString(16).padStart(KEY_BYTES * 2, "0"), "hex"));
}

// ---------- Handshake ---------- //

type Stage = "await-key" | "await-sync" | "await-crypto" | "await-pad" | "await-ia-len" | "await-ia" | "done";

export class MseHandshake {
  private readonly keys = keyPair();
  private buf: Uint8Array = new Uint8Array(0);
  private stage: Stage = "await-key";
  private secret: Uint8Array | null = null;
  private skey: Uint8Array | null = null;
  private encrypt: Cipher | null = null;
  private decrypt: Cipher | null = null;
  private select = 0;
  private padLength = 0;
  private iaLength = 0;
  /** Receiver: bytes scanned for the sync point; initiator: the encrypted VC it looks for. */
  private syncTarget: Uint8Array | null = null;

  constructor(
    private readonly initiator: boolean,
    private readonly options: MseOptions,
    private readonly onDone: (result: MseResult) => void,
  ) {
    if (initiator) options.send(concat(this.keys.publicKey, randomBytes(randomPad())));
  }

  /** Feeds raw bytes from the socket. Throws `MseError` when the peer misbehaves. */
  public push(chunk: Uint8Array): void {
    if (this.stage === "done") throw new MseError("Handshake already finished");
    this.buf = this.buf.length ? concat(this.buf, chunk) : chunk;
    for (;;) {
      const before: Stage = this.stage;
      if (this.initiator) this.stepInitiator();
      else this.stepReceiver();
      if ((this.stage as Stage) === "done" || this.stage === before) return;
    }
  }

  private stepInitiator(): void {
    const { options } = this;
    switch (this.stage) {
      case "await-key": {
        if (this.buf.length < KEY_BYTES) return;
        this.secret = this.keys.sharedSecret(this.buf.subarray(0, KEY_BYTES));
        this.buf = this.buf.subarray(KEY_BYTES);
        this.skey = options.infoHashes[0] as Uint8Array;
        this.encrypt = rc4(sha1("keyA", this.secret, this.skey));
        this.decrypt = rc4(sha1("keyB", this.secret, this.skey));
        // What B's encrypted VC will look like, from a twin of B's cipher
        this.syncTarget = rc4(sha1("keyB", this.secret, this.skey)).update(new Uint8Array(8));

        // Step 3: sync hash, obfuscated torrent hash, crypto offer, our handshake
        const ia = options.initialPayload ?? new Uint8Array(0);
        const plain = new Uint8Array(8 + 4 + 2 + 2 + ia.length);
        const view = new DataView(plain.buffer);
        view.setUint32(8, options.allow);
        view.setUint16(12, 0);
        view.setUint16(14, ia.length);
        plain.set(ia, 16);
        options.send(
          concat(sha1("req1", this.secret), xor(sha1("req2", this.skey), sha1("req3", this.secret)), this.encrypt.update(plain)),
        );
        this.stage = "await-sync";
        return;
      }
      case "await-sync": {
        // Find B's encrypted VC somewhere in its padding
        const at = indexOf(this.buf, this.syncTarget as Uint8Array);
        if (at < 0) {
          if (this.buf.length > MAX_PAD + 8) throw new MseError("No sync point from receiver");
          return;
        }
        (this.decrypt as Cipher).update(this.buf.subarray(at, at + 8));
        this.buf = this.buf.subarray(at + 8);
        this.stage = "await-crypto";
        return;
      }
      case "await-crypto": {
        if (this.buf.length < 6) return;
        const head = (this.decrypt as Cipher).update(this.buf.subarray(0, 6));
        this.select = new DataView(head.buffer, head.byteOffset, 6).getUint32(0);
        this.padLength = new DataView(head.buffer, head.byteOffset, 6).getUint16(4);
        if ((this.select !== CRYPTO_PLAIN && this.select !== CRYPTO_RC4) || !(this.select & options.allow)) {
          throw new MseError(`Receiver selected unsupported method ${this.select}`);
        }
        if (this.padLength > MAX_PAD) throw new MseError("Pad too long");
        this.buf = this.buf.subarray(6);
        this.stage = "await-pad";
        return;
      }
      case "await-pad": {
        if (this.buf.length < this.padLength) return;
        (this.decrypt as Cipher).update(this.buf.subarray(0, this.padLength));
        this.buf = this.buf.subarray(this.padLength);
        this.finish(new Uint8Array(0));
        return;
      }
      default:
        return;
    }
  }

  private stepReceiver(): void {
    const { options } = this;
    switch (this.stage) {
      case "await-key": {
        if (this.buf.length < KEY_BYTES) return;
        this.secret = this.keys.sharedSecret(this.buf.subarray(0, KEY_BYTES));
        this.buf = this.buf.subarray(KEY_BYTES);
        options.send(concat(this.keys.publicKey, randomBytes(randomPad())));
        this.syncTarget = sha1("req1", this.secret);
        this.stage = "await-sync";
        return;
      }
      case "await-sync": {
        // Skip A's padding up to the req1 hash, then identify the torrent
        const at = indexOf(this.buf, this.syncTarget as Uint8Array);
        if (at < 0) {
          if (this.buf.length > MAX_PAD + 20) throw new MseError("No sync point from initiator");
          return;
        }
        if (this.buf.length < at + 40) return;
        const obfuscated = xor(this.buf.subarray(at + 20, at + 40), sha1("req3", this.secret as Uint8Array));
        this.skey = options.infoHashes.find((ih) => equal(sha1("req2", ih), obfuscated)) ?? null;
        if (!this.skey) throw new MseError("Peer asked for a torrent we do not have");
        this.decrypt = rc4(sha1("keyA", this.secret as Uint8Array, this.skey));
        this.encrypt = rc4(sha1("keyB", this.secret as Uint8Array, this.skey));
        this.buf = this.buf.subarray(at + 40);
        this.stage = "await-crypto";
        return;
      }
      case "await-crypto": {
        if (this.buf.length < 14) return;
        const head = (this.decrypt as Cipher).update(this.buf.subarray(0, 14));
        if (!equal(head.subarray(0, 8), VC)) throw new MseError("Bad verification constant");
        const view = new DataView(head.buffer, head.byteOffset, 14);
        const provide = view.getUint32(8);
        this.padLength = view.getUint16(12);
        if (this.padLength > MAX_PAD) throw new MseError("Pad too long");
        const common = provide & options.allow;
        if (!common) throw new MseError("No common crypto method");
        this.select = common & CRYPTO_PLAIN && (options.preferPlain || !(common & CRYPTO_RC4)) ? CRYPTO_PLAIN : CRYPTO_RC4;
        this.buf = this.buf.subarray(14);
        this.stage = "await-pad";
        return;
      }
      case "await-pad": {
        if (this.buf.length < this.padLength + 2) return;
        const tail = (this.decrypt as Cipher).update(this.buf.subarray(0, this.padLength + 2));
        this.iaLength = (tail[this.padLength] as number) * 256 + (tail[this.padLength + 1] as number);
        this.buf = this.buf.subarray(this.padLength + 2);
        this.stage = "await-ia";
        return;
      }
      case "await-ia": {
        if (this.buf.length < this.iaLength) return;
        const ia = (this.decrypt as Cipher).update(this.buf.subarray(0, this.iaLength));
        this.buf = this.buf.subarray(this.iaLength);

        // Step 4: VC, our choice, no padding
        const reply = new Uint8Array(14);
        new DataView(reply.buffer).setUint32(8, this.select);
        options.send((this.encrypt as Cipher).update(reply));
        this.finish(ia);
        return;
      }
      default:
        return;
    }
  }

  /** Hands over the stream: ciphers for RC4, none for plaintext, plus the bytes already received. */
  private finish(initial: Uint8Array): void {
    this.stage = "done";
    const rc4Selected = this.select === CRYPTO_RC4;
    const decrypt = rc4Selected ? this.decrypt : null;
    const tail = decrypt && this.buf.length ? decrypt.update(this.buf) : this.buf;
    this.onDone({
      encrypt: rc4Selected ? this.encrypt : null,
      decrypt,
      infoHash: this.skey as Uint8Array,
      rest: initial.length ? concat(initial, tail) : new Uint8Array(tail),
    });
  }
}

// ---------- Helpers ---------- //

function rc4(key: Uint8Array): Cipher {
  return new Rc4(key);
}

function sha1(label: string, ...parts: Uint8Array[]): Uint8Array {
  const hash = createHash("sha1").update(label);
  for (const part of parts) hash.update(part);
  return new Uint8Array(hash.digest());
}

function randomPad(): number {
  return Math.floor(Math.random() * 64); // short pads: less to send, still unfingerprintable
}

function concat(...parts: Uint8Array[]): Uint8Array {
  return new Uint8Array(Buffer.concat(parts));
}

function xor(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] as number) ^ (b[i] as number);
  return out;
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && Buffer.from(a.buffer, a.byteOffset, a.length).equals(b);
}

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  return Buffer.from(haystack.buffer, haystack.byteOffset, haystack.length).indexOf(needle);
}
