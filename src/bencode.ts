/**
 * Bencode, the encoding of torrent files, tracker responses, DHT messages and
 * peer extension messages. Decoding is zero-copy: byte strings come back as
 * `subarray` views into the source buffer, so a 30 MB `.torrent` file is never
 * duplicated.
 */

/** A decoded bencode value. Byte strings stay bytes; use `text()` to read one as UTF-8. */
export type BValue = number | Uint8Array | BValue[] | BDict;

/** A decoded dictionary. Keys are read as Latin-1, so arbitrary binary keys round-trip. */
export interface BDict {
  [key: string]: BValue | undefined;
}

/** A value the encoder accepts: decoded values, plus plain strings and `null`-free objects. */
export type BInput = number | string | Uint8Array | BInput[] | { [key: string]: BInput | undefined };

/** Thrown for malformed input. Decoding never throws anything else. */
export class BencodeError extends Error {}

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

/** Reads a byte string as UTF-8, or returns `fallback` when it isn't one. */
export function text(value: BValue | undefined, fallback = ""): string {
  return value instanceof Uint8Array ? textDecoder.decode(value) : fallback;
}

/** Narrows a value to a dictionary, or returns `undefined`. */
export function dict(value: BValue | undefined): BDict | undefined {
  return value !== undefined && typeof value === "object" && !(value instanceof Uint8Array) && !Array.isArray(value)
    ? value
    : undefined;
}

/** Narrows a value to a byte string, or returns `undefined`. */
export function bytes(value: BValue | undefined): Uint8Array | undefined {
  return value instanceof Uint8Array ? value : undefined;
}

// ---------- Decoding ---------- //

/** The result of `decodeWithSpan`: the value and where one top-level key's raw value sits. */
export interface SpanResult {
  value: BValue;
  /** Byte range of the top-level dictionary's `key` value, for hashing a torrent's `info`. */
  span?: [start: number, end: number];
}

/** Decodes exactly one value; trailing bytes are an error (see `decodePrefix`). */
export function decode(buf: Uint8Array): BValue {
  const decoder = new Decoder(buf);
  const value = decoder.value(0);
  if (decoder.pos !== buf.length) throw new BencodeError("Trailing bytes after value");
  return value;
}

/** Decodes one value from the start of `buf` and returns it with the offset just past it. */
export function decodePrefix(buf: Uint8Array): { value: BValue; end: number } {
  const decoder = new Decoder(buf);
  const value = decoder.value(0);
  return { value, end: decoder.pos };
}

/** Decodes a dictionary and also reports the raw byte range of one top-level key's value. */
export function decodeWithSpan(buf: Uint8Array, key: string): SpanResult {
  const decoder = new Decoder(buf, key);
  const value = decoder.value(0);
  if (decoder.pos !== buf.length) throw new BencodeError("Trailing bytes after value");
  return { value, span: decoder.span };
}

/** Nesting limit, so hostile input cannot overflow the stack. */
const MAX_DEPTH = 64;

class Decoder {
  public pos = 0;
  public span?: [number, number];

  constructor(
    private readonly buf: Uint8Array,
    private readonly spanKey?: string,
  ) {}

  public value(depth: number): BValue {
    if (depth > MAX_DEPTH) throw new BencodeError("Nesting too deep");
    const c = this.buf[this.pos];
    if (c === 0x69) return this.integer(); // i
    if (c === 0x6c) return this.list(depth); // l
    if (c === 0x64) return this.dictionary(depth); // d
    if (c !== undefined && c >= 0x30 && c <= 0x39) return this.string();
    throw new BencodeError(c === undefined ? "Unexpected end of input" : `Unexpected byte ${c} at ${this.pos}`);
  }

  private integer(): number {
    const end = this.buf.indexOf(0x65, this.pos + 1); // e
    if (end < 0) throw new BencodeError("Unterminated integer");
    const n = this.parseDigits(this.pos + 1, end, true);
    this.pos = end + 1;
    return n;
  }

  private string(): Uint8Array {
    const colon = this.buf.indexOf(0x3a, this.pos); // :
    if (colon < 0) throw new BencodeError("Unterminated string length");
    const length = this.parseDigits(this.pos, colon, false);
    const start = colon + 1;
    const end = start + length;
    if (end > this.buf.length) throw new BencodeError("String runs past the end");
    this.pos = end;
    return this.buf.subarray(start, end);
  }

  private list(depth: number): BValue[] {
    this.pos++;
    const out: BValue[] = [];
    while (this.buf[this.pos] !== 0x65) {
      if (this.pos >= this.buf.length) throw new BencodeError("Unterminated list");
      out.push(this.value(depth + 1));
    }
    this.pos++;
    return out;
  }

  private dictionary(depth: number): BDict {
    this.pos++;
    const out: BDict = Object.create(null);
    while (this.buf[this.pos] !== 0x65) {
      if (this.pos >= this.buf.length) throw new BencodeError("Unterminated dictionary");
      const key = latin1(this.string());
      const start = this.pos;
      out[key] = this.value(depth + 1);
      if (depth === 0 && key === this.spanKey) this.span = [start, this.pos];
    }
    this.pos++;
    return out;
  }

  /** Parses ASCII digits in [from, to), with an optional sign. */
  private parseDigits(from: number, to: number, signed: boolean): number {
    let i = from;
    let negative = false;
    if (signed && this.buf[i] === 0x2d) {
      negative = true;
      i++;
    }
    if (i >= to || to - i > 16) throw new BencodeError("Bad number");
    let n = 0;
    for (; i < to; i++) {
      const d = (this.buf[i] as number) - 0x30;
      if (d < 0 || d > 9) throw new BencodeError("Bad digit");
      n = n * 10 + d;
    }
    return negative ? -n : n;
  }
}

/** Latin-1 keeps every byte as one char, so binary dictionary keys survive a round trip. */
function latin1(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i] as number);
  return s;
}

// ---------- Encoding ---------- //

/** Encodes a value. Dictionary keys are sorted, as the format requires. */
export function encode(value: BInput): Uint8Array {
  const parts: Uint8Array[] = [];
  write(value, parts);
  return concat(parts);
}

function write(value: BInput, parts: Uint8Array[]): void {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new BencodeError("Only integers can be encoded");
    parts.push(textEncoder.encode(`i${value}e`));
  } else if (typeof value === "string") {
    const b = textEncoder.encode(value);
    parts.push(textEncoder.encode(`${b.length}:`), b);
  } else if (value instanceof Uint8Array) {
    parts.push(textEncoder.encode(`${value.length}:`), value);
  } else if (Array.isArray(value)) {
    parts.push(L);
    for (const item of value) write(item, parts);
    parts.push(E);
  } else {
    parts.push(D);
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item === undefined) continue;
      const k = Uint8Array.from(key, (ch) => ch.charCodeAt(0) & 0xff);
      parts.push(textEncoder.encode(`${k.length}:`), k);
      write(item, parts);
    }
    parts.push(E);
  }
}

const L = Uint8Array.of(0x6c);
const D = Uint8Array.of(0x64);
const E = Uint8Array.of(0x65);

/** Joins byte arrays into one. */
export function concat(parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const p of parts) length += p.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
