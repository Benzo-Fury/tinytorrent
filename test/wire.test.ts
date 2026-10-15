import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { handshake, MSG, OutBuffer, type WireHandler, WireError, WireParser } from "../src/wire";

/** Records everything the parser reports. */
function recorder() {
  const events: string[] = [];
  const piece = new Uint8Array(65536);
  const handler: WireHandler = {
    onHandshake: (ih, id) => events.push(`hs ${ih[0]} ${id[0]}`),
    onMessage: (id, payload) => events.push(`m${id} ${Buffer.from(payload).toString("hex")}`),
    onPieceStart: (i, b, l) => (events.push(`start ${i} ${b} ${l}`), piece),
    onPieceEnd: (i, b, l) => events.push(`end ${i} ${b} ${l} ${Buffer.from(piece.subarray(b, b + l)).toString("hex").slice(0, 16)}`),
  };
  return { events, handler };
}

/** A realistic stream: handshake, then a mix of control messages and blocks. */
function stream(): Uint8Array {
  const out = new OutBuffer();
  out.raw(handshake(new Uint8Array(20).fill(1), new Uint8Array(20).fill(2)));
  out.raw(new Uint8Array(4)); // keep-alive
  out.simple(MSG.unchoke);
  out.have(7);
  out.payload(MSG.bitfield, Uint8Array.of(0xff, 0x80));
  out.payload(MSG.extended, new TextEncoder().encode("d1:md11:ut_metadatai1eee"), 0);
  out.block(MSG.request, 1, 16384, 16384);
  for (let i = 0; i < 3; i++) {
    out.pieceHeader(i, i * 16384, 16384);
    out.raw(new Uint8Array(randomBytes(16384)));
  }
  out.pieceHeader(9, 0, 100);
  out.raw(new Uint8Array(100).fill(0xab));
  return out.take();
}

describe("wire parser", () => {
  test("gives identical events however the stream is split", () => {
    const data = stream();
    const whole = recorder();
    new WireParser(whole.handler).push(data);
    expect(whole.events.length).toBe(14);
    for (const size of [1, 3, 13, 17, 1460, 4096]) {
      const split = recorder();
      const p = new WireParser(split.handler);
      for (let o = 0; o < data.length; o += size) p.push(data.subarray(o, o + size));
      expect(split.events).toEqual(whole.events);
    }
    // And random splits
    for (let round = 0; round < 50; round++) {
      const split = recorder();
      const p = new WireParser(split.handler);
      let o = 0;
      while (o < data.length) {
        const n = 1 + Math.floor(Math.random() * 3000);
        p.push(data.subarray(o, o + n));
        o += n;
      }
      expect(split.events).toEqual(whole.events);
    }
  });

  test("a discarded block is skipped without corrupting the stream", () => {
    const out = new OutBuffer();
    out.pieceHeader(0, 0, 16384);
    out.raw(new Uint8Array(16384));
    out.simple(MSG.choke);
    const seen: number[] = [];
    const p = new WireParser(
      { onHandshake: () => undefined, onMessage: (id) => seen.push(id), onPieceStart: () => null, onPieceEnd: () => seen.push(-1) },
      false,
    );
    const data = out.take();
    for (let o = 0; o < data.length; o += 1000) p.push(data.subarray(o, o + 1000));
    expect(seen).toEqual([MSG.choke]);
  });

  test("rejects a bad handshake and oversized messages", () => {
    const { handler } = recorder();
    expect(() => new WireParser(handler).push(new TextEncoder().encode("GET / HTTP/1.1\r\n"))).toThrow(WireError);
    const huge = new Uint8Array(5);
    new DataView(huge.buffer).setUint32(0, 1 << 24);
    huge[4] = MSG.bitfield;
    expect(() => new WireParser(handler, false).push(huge)).toThrow(WireError);
    const bigBlock = new Uint8Array(13);
    new DataView(bigBlock.buffer).setUint32(0, 9 + (1 << 20));
    bigBlock[4] = MSG.piece;
    expect(() => new WireParser(handler, false).push(bigBlock)).toThrow(WireError);
  });

  test("fuzz: random bytes never throw anything but WireError", () => {
    const { handler } = recorder();
    for (let i = 0; i < 3000; i++) {
      const p = new WireParser(handler, i % 2 === 0);
      try {
        for (let k = 0; k < 4; k++) p.push(new Uint8Array(randomBytes(Math.floor(Math.random() * 300))));
      } catch (error) {
        expect(error).toBeInstanceOf(WireError);
      }
    }
  });

  test("OutBuffer batches messages into one write and reuses its buffer", () => {
    const out = new OutBuffer();
    for (let i = 0; i < 100; i++) out.block(MSG.request, i, 0, 16384);
    const first = out.take();
    expect(first.length).toBe(1700);
    out.simple(MSG.interested);
    const second = out.take();
    expect(second).toEqual(Uint8Array.of(0, 0, 0, 1, MSG.interested));
    expect(first[4]).toBe(MSG.request); // the first take was a copy, untouched by the second
  });
});
