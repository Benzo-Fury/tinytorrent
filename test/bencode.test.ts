import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { BencodeError, decode, decodePrefix, decodeWithSpan, encode, text } from "../src/bencode";

const enc = (s: string) => new TextEncoder().encode(s);

describe("bencode", () => {
  test("decodes every type", () => {
    const value = decode(enc("d3:agei-42e4:listli1ei2ee4:name5:hello5:emptyle1:dd1:xi0eee")) as Record<string, unknown>;
    expect(value.age).toBe(-42);
    expect(value.list).toEqual([1, 2]);
    expect(text(value.name as Uint8Array)).toBe("hello");
    expect(value.empty).toEqual([]);
    expect(value.d).toEqual({ x: 0 } as never);
  });

  test("byte strings are views into the source, not copies", () => {
    const source = enc("4:spam");
    const value = decode(source) as Uint8Array;
    expect(value.buffer).toBe(source.buffer);
  });

  test("encodes with sorted keys and round-trips", () => {
    const input = { z: 1, a: "x", m: [1, "two", new Uint8Array([0, 255])], n: { b: 2, a: 1 } };
    const bytes = encode(input);
    expect(new TextDecoder().decode(bytes).startsWith("d1:a1:x1:m")).toBe(true);
    expect(encode(decode(bytes) as never)).toEqual(bytes);
  });

  test("binary dictionary keys survive a round trip", () => {
    const key = String.fromCharCode(0, 200, 255);
    const bytes = encode({ [key]: 1 });
    expect(Object.keys(decode(bytes) as object)).toEqual([key]);
  });

  test("decodeWithSpan reports the raw bytes of a top-level key", () => {
    const bytes = enc("d8:announce3:url4:infod4:name1:xee");
    const { span } = decodeWithSpan(bytes, "info");
    expect(new TextDecoder().decode(bytes.subarray(span![0], span![1]))).toBe("d4:name1:xe");
  });

  test("decodePrefix stops after one value", () => {
    const { value, end } = decodePrefix(enc("d1:ai1eeTRAILING"));
    expect(value).toEqual({ a: 1 } as never);
    expect(end).toBe(8);
  });

  test("rejects malformed input", () => {
    for (const bad of ["", "i", "i12", "ie", "i1x2e", "5:abc", "l", "d1:a", "x", "di1ei2ee", "d1:ai1ee extra"]) {
      expect(() => decode(enc(bad))).toThrow(BencodeError);
    }
    expect(() => decode(enc(`${"l".repeat(100)}${"e".repeat(100)}`))).toThrow(BencodeError);
    expect(() => encode(1.5)).toThrow(BencodeError);
  });

  test("fuzz: random and truncated input only ever throws BencodeError", () => {
    const valid = encode({ a: [1, 2, { b: "c" }], d: new Uint8Array(randomBytes(30)) });
    for (let i = 0; i < 5000; i++) {
      const input =
        i % 2 ? new Uint8Array(randomBytes(Math.floor(Math.random() * 64))) : valid.slice(0, Math.floor(Math.random() * valid.length));
      if (i % 3 === 0 && input.length) input[Math.floor(Math.random() * input.length)] = Math.floor(Math.random() * 256);
      try {
        decode(input);
      } catch (error) {
        expect(error).toBeInstanceOf(BencodeError);
      }
    }
  });
});
