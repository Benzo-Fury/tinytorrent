/**
 * A load generator for the seeding benchmark: leechers that keep a deep queue
 * of requests open and throw the blocks away, with no hashing, no disk and no
 * picker. They cost far less per byte than a real engine, so a seeder is
 * measured rather than the leechers feeding off it. Several of these run at
 * once so no single thread caps them.
 *
 *   bun bench/sink.ts <json options>
 *
 * Prints one `sample` line per connection every half second, with bytes
 * received so far, and exits after `seconds`.
 */

import net from "node:net";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { parseTorrent } from "../src/metainfo";
import { CRYPTO_PLAIN, CRYPTO_RC4, MseHandshake, type StreamCipher } from "../src/mse";
import { type WireHandler, WireParser } from "../src/wire";

/** What the CLI passes in. */
export interface SinkOptions {
  torrentPath: string;
  host: string;
  port: number;
  /** Connections from this process; each is its own peer. */
  conns: number;
  /** Index of this process's first connection, so piece ranges differ between processes. */
  first: number;
  /** Connections across all processes. */
  total: number;
  seconds: number;
  /** `plain`: a plaintext handshake. `mse-plain`: MSE offering plaintext only. `rc4`: MSE offering RC4 only. */
  crypto: "plain" | "mse-plain" | "rc4";
  /** Blocks in flight per connection. */
  queue: number;
}

/** One line per connection per sample. */
export interface SinkSample {
  type: "sample";
  conn: number;
  bytes: number;
}

const BLOCK = 16 * 1024;
const options = JSON.parse(process.argv[2] ?? "{}") as SinkOptions;
const meta = parseTorrent(new Uint8Array(await readFile(options.torrentPath)));
const pieceSize = (i: number): number => Math.min(meta.pieceLength, meta.length - i * meta.pieceLength);

/** The 68-byte handshake with no extension bits: the seeder sees the simplest possible peer. */
function plainHandshake(): Uint8Array {
  const out = new Uint8Array(68);
  out[0] = 19;
  out.set(new TextEncoder().encode("BitTorrent protocol"), 1);
  out.set(meta.infoHash, 28);
  out.set(new TextEncoder().encode("-TS0001-"), 48);
  out.set(randomBytes(12), 56);
  return out;
}

/** One leecher, walking the torrent from `startPiece` and wrapping round. */
function leech(conn: number, startPiece: number): { bytes: () => number } {
  let received = 0;
  let encrypt: StreamCipher = null;
  let decrypt: StreamCipher = null;
  let unchoked = false;
  let inflight = 0;
  let piece = startPiece;
  let begin = 0;
  const socket = net.connect({ host: options.host, port: options.port, noDelay: true });
  const send = (bytes: Uint8Array): void => {
    socket.write(encrypt ? encrypt.update(bytes) : bytes);
  };
  // Tops the pipeline up in one write once it has drained by a quarter
  const request = (): void => {
    if (!unchoked || inflight > (options.queue * 3) / 4) return;
    const count = options.queue - inflight;
    const out = new Uint8Array(count * 17);
    const view = new DataView(out.buffer);
    for (let k = 0; k < count; k++) {
      const size = pieceSize(piece);
      const n = Math.min(BLOCK, size - begin);
      view.setUint32(k * 17, 13);
      out[k * 17 + 4] = 6;
      view.setUint32(k * 17 + 5, piece);
      view.setUint32(k * 17 + 9, begin);
      view.setUint32(k * 17 + 13, n);
      begin += n;
      if (begin === size) {
        begin = 0;
        piece = (piece + 1) % meta.pieceCount;
      }
    }
    inflight += count;
    send(out);
  };
  const handler: WireHandler = {
    // Interest follows the seeder's handshake, as real clients do: WebTorrent ignores it sooner
    onHandshake: () => send(interested),
    onMessage: (id) => {
      // Without the fast extension a choke drops everything in flight
      if (id === 0) {
        unchoked = false;
        inflight = 0;
      } else if (id === 1) {
        unchoked = true;
        request();
      }
    },
    // Block data is skipped where it lies, never copied; it is counted as it starts arriving
    onPieceStart: (_index, _begin, length) => {
      received += length;
      inflight--;
      request();
      return null;
    },
    onPieceEnd: () => {},
  };
  const parser = new WireParser(handler, true);
  const interested = new Uint8Array([0, 0, 0, 1, 2]);
  let mse: MseHandshake | null = null;
  socket.on("connect", () => {
    if (options.crypto === "plain") {
      send(plainHandshake());
      return;
    }
    mse = new MseHandshake(
      true,
      { infoHashes: [meta.infoHash], allow: options.crypto === "rc4" ? CRYPTO_RC4 : CRYPTO_PLAIN, initialPayload: plainHandshake(), send: (b) => socket.write(b) },
      (result) => {
        encrypt = result.encrypt;
        decrypt = result.decrypt;
        mse = null;
        if (result.rest.length) parser.push(result.rest);
      },
    );
  });
  socket.on("data", (chunk: Buffer) => {
    const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length);
    if (mse) mse.push(bytes);
    else parser.push(decrypt ? decrypt.update(bytes) : bytes);
  });
  socket.on("error", (e) => process.stderr.write(`sink connection ${conn}: ${e.message}\n`));
  return { bytes: () => received };
}

const leechers = Array.from({ length: options.conns }, (_, k) => {
  const conn = options.first + k;
  return { conn, ...leech(conn, Math.floor((conn * meta.pieceCount) / options.total)) };
});
const report = (): void => {
  for (const l of leechers) process.stdout.write(`${JSON.stringify({ type: "sample", conn: l.conn, bytes: l.bytes() } satisfies SinkSample)}\n`);
};
const ticker = setInterval(report, 500);
setTimeout(() => {
  clearInterval(ticker);
  report();
  process.exit(0);
}, options.seconds * 1000);
