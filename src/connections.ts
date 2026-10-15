/**
 * Getting from an address to a `Peer`: dialling with a short timeout, the
 * optional MSE handshake, and falling back to the other mode when a peer
 * hangs up during the handshake (some require encryption, some refuse it).
 * Also the per-torrent candidate list, which decides who to dial next and
 * backs off from addresses that keep failing.
 */

import type { Socket } from "node:net";
import { CRYPTO_PLAIN, CRYPTO_RC4, type MseResult, MseHandshake } from "./mse";
import type { Transport } from "./transport";
import { handshake } from "./wire";

/** How peer connections are encrypted. */
export type EncryptionPolicy = "require" | "prefer" | "prefer-plaintext" | "off";

/** A connection ready to become a `Peer`. */
export interface Established {
  socket: Socket;
  encrypt: MseResult["encrypt"];
  decrypt: MseResult["decrypt"];
  /** Bytes received after the transport handshake, decrypted. */
  rest: Uint8Array;
  /** Whether our BitTorrent handshake already went out inside MSE. */
  handshakeSent: boolean;
  encrypted: boolean;
  /** Info hash, for incoming connections. */
  infoHash?: Uint8Array;
}

const DIAL_TIMEOUT_MS = 5000;

/** A failed dial; `connected` tells a refusal apart from a hang-up during the handshake. */
export class DialError extends Error {
  constructor(
    message: string,
    public readonly connected: boolean,
  ) {
    super(message);
  }
}
const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * Dials a peer. With `mse`, runs the encryption handshake and sends our
 * BitTorrent handshake inside it; otherwise the caller's `Peer` sends it.
 */
export function dial(
  transport: Transport,
  host: string,
  port: number,
  infoHash: Uint8Array,
  peerId: Uint8Array,
  mse: false | { allow: number },
): Promise<Established> {
  return new Promise((resolve, reject) => {
    let socket: Socket;
    try {
      socket = transport.connect(host, port);
    } catch (error) {
      return reject(error);
    }
    let connected = false;
    const fail = (reason: string): void => {
      socket.destroy();
      reject(new DialError(reason, connected));
    };
    socket.setTimeout(DIAL_TIMEOUT_MS, () => fail("timeout"));
    socket.once("error", (e) => fail(e.message));
    socket.once("close", () => fail("closed"));

    socket.once("connect", () => {
      connected = true;
      socket.setTimeout(HANDSHAKE_TIMEOUT_MS, () => fail("handshake timeout"));
      if (!mse) {
        // Plain: wait for the first bytes so a hang-up during the handshake is caught here
        socket.once("data", (chunk: Buffer) => {
          detach(socket);
          resolve({ socket, encrypt: null, decrypt: null, rest: chunk, handshakeSent: true, encrypted: false });
        });
        socket.write(handshake(infoHash, peerId));
        return;
      }
      const shake = new MseHandshake(
        true,
        { infoHashes: [infoHash], allow: mse.allow, initialPayload: handshake(infoHash, peerId), send: (b) => socket.write(b) },
        (result) => {
          socket.off("data", onData);
          detach(socket);
          resolve({ socket, ...result, handshakeSent: true, encrypted: result.encrypt !== null });
        },
      );
      const onData = (chunk: Buffer): void => {
        try {
          shake.push(chunk);
        } catch (error) {
          fail((error as Error).message);
        }
      };
      socket.on("data", onData);
    });
  });
}

/**
 * Reads an incoming connection's opening: a plain BitTorrent handshake, or
 * MSE for one of `infoHashes`. Resolves with the bytes to feed the `Peer`,
 * the handshake included, and the info hash asked for.
 */
export function accept(socket: Socket, infoHashes: () => Uint8Array[], policy: EncryptionPolicy): Promise<Established> {
  return new Promise((resolve, reject) => {
    const fail = (reason: string): void => {
      socket.destroy();
      reject(new Error(reason));
    };
    socket.setTimeout(HANDSHAKE_TIMEOUT_MS, () => fail("handshake timeout"));
    socket.once("error", (e) => fail(e.message));
    socket.once("close", () => fail("closed"));

    let buffered = new Uint8Array(0);
    let shake: MseHandshake | null = null;
    const onData = (chunk: Buffer): void => {
      try {
        if (shake) return shake.push(chunk);
        buffered = buffered.length ? new Uint8Array(Buffer.concat([buffered, chunk])) : new Uint8Array(chunk);
        if (buffered.length < 48) return;

        // A plain handshake starts with "\x13BitTorrent protocol"
        if (buffered[0] === 19 && Buffer.from(buffered.subarray(1, 20)).toString() === "BitTorrent protocol") {
          if (policy === "require") return fail("plaintext refused");
          const infoHash = buffered.slice(28, 48);
          socket.off("data", onData);
          detach(socket);
          return resolve({ socket, encrypt: null, decrypt: null, rest: buffered, handshakeSent: false, encrypted: false, infoHash });
        }
        if (policy === "off") return fail("encryption refused");
        shake = new MseHandshake(
          false,
          {
            infoHashes: infoHashes(),
            allow: policy === "require" ? CRYPTO_RC4 : CRYPTO_RC4 | CRYPTO_PLAIN,
            preferPlain: policy === "prefer-plaintext",
            send: (b) => socket.write(b),
          },
          (result) => {
            socket.off("data", onData);
            detach(socket);
            resolve({ socket, ...result, handshakeSent: false, encrypted: result.encrypt !== null });
          },
        );
        const first = buffered;
        buffered = new Uint8Array(0);
        shake.push(first);
      } catch (error) {
        fail((error as Error).message);
      }
    };
    socket.on("data", onData);
  });
}

/** Removes the setup listeners and timeout; the `Peer` installs its own. */
function detach(socket: Socket): void {
  socket.setTimeout(0);
  socket.removeAllListeners("timeout");
  socket.removeAllListeners("error");
  socket.removeAllListeners("close");
  socket.removeAllListeners("data");
}

// ---------- Candidates ---------- //

/** Where a peer address came from. */
export type PeerSource = "tracker" | "dht" | "pex" | "manual" | "incoming";

/** An address we may dial. */
export interface Candidate {
  address: string;
  host: string;
  port: number;
  source: PeerSource;
  failures: number;
  /** Earliest time to dial again. */
  retryAt: number;
  /** Try MSE on the next dial (flipped after a hang-up during the handshake). */
  useMse: boolean;
  /** Whether it ever completed a handshake. */
  worked: boolean;
}

/** Addresses we know of for one torrent, and which to try next. */
export class Candidates {
  private readonly all = new Map<string, Candidate>();
  /** Most addresses kept; plenty for any swarm, bounded for memory. */
  private static readonly LIMIT = 3000;

  constructor(private readonly policy: EncryptionPolicy) {}

  public get size(): number {
    return this.all.size;
  }

  /** Adds an address, ignoring bad and known ones. Returns whether it was new. */
  public add(address: string, source: PeerSource): boolean {
    if (this.all.has(address) || this.all.size >= Candidates.LIMIT) return false;
    const split = splitHostPort(address);
    if (!split) return false;
    this.all.set(address, {
      address,
      host: split[0],
      port: split[1],
      source,
      failures: 0,
      retryAt: 0,
      useMse: this.policy === "require" || this.policy === "prefer",
      worked: false,
    });
    return true;
  }

  public get(address: string): Candidate | undefined {
    return this.all.get(address);
  }

  /**
   * Up to `n` addresses ready to dial that aren't connected or connecting.
   * Addresses that worked before come first, then never-tried ones.
   */
  public next(n: number, now: number, busy: (address: string) => boolean): Candidate[] {
    const ready: Candidate[] = [];
    for (const c of this.all.values()) {
      if (c.retryAt <= now && !busy(c.address)) ready.push(c);
    }
    ready.sort((a, b) => Number(b.worked) - Number(a.worked) || a.failures - b.failures);
    return ready.slice(0, n);
  }

  /** Whether any address is ready to dial. */
  public waiting(now: number, busy: (address: string) => boolean): boolean {
    for (const c of this.all.values()) if (c.retryAt <= now && !busy(c.address)) return true;
    return false;
  }

  /**
   * Records a failed dial. A hang-up during the handshake flips the
   * encryption mode for the next try, when the policy allows both.
   */
  public failed(c: Candidate, now: number, duringHandshake: boolean): void {
    c.failures++;
    if (duringHandshake && (this.policy === "prefer" || this.policy === "prefer-plaintext") && c.failures === 1) {
      c.useMse = !c.useMse;
      c.retryAt = now;
      return;
    }
    if (c.failures >= 5 && !c.worked) {
      this.all.delete(c.address);
      return;
    }
    c.retryAt = now + Math.min(15_000 * 2 ** c.failures, 30 * 60_000);
  }

  /** Records a successful handshake. */
  public worked(c: Candidate): void {
    c.worked = true;
    c.failures = 0;
  }

  /** Makes every address dialable now, as after a pause. */
  public retryAll(): void {
    for (const c of this.all.values()) c.retryAt = 0;
  }

  /** Schedules a peer we disconnected (or that left) for a later retry. */
  public later(address: string, now: number, delayMs: number): void {
    const c = this.all.get(address);
    if (c) c.retryAt = now + delayMs;
  }
}

/** Splits `host:port` or `[v6]:port`. */
export function splitHostPort(address: string): [string, number] | null {
  const match = /^\[?([^\]]+?)\]?:(\d+)$/.exec(address);
  if (!match) return null;
  const port = Number(match[2]);
  if (!port || port > 65535) return null;
  return [match[1] as string, port];
}

/** Crypto methods to offer when dialling with MSE. */
export function mseOffer(policy: EncryptionPolicy): number {
  return policy === "require" ? CRYPTO_RC4 : CRYPTO_RC4 | CRYPTO_PLAIN;
}
