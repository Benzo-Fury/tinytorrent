/** A fixed-size bit set in BitTorrent's order: piece 0 is the high bit of byte 0. */
export class Bitfield {
  public readonly bytes: Uint8Array;
  private setCount = 0;

  constructor(
    public readonly size: number,
    from?: Uint8Array,
  ) {
    this.bytes = new Uint8Array(Math.ceil(size / 8));
    if (from) {
      this.bytes.set(from.subarray(0, this.bytes.length));
      // Spare bits past the end must be clear
      if (size % 8) this.bytes[this.bytes.length - 1]! &= 0xff << (8 - (size % 8));
      for (const b of this.bytes) this.setCount += POPCOUNT[b] as number;
    }
  }

  /** Number of set bits. */
  public get count(): number {
    return this.setCount;
  }

  public get full(): boolean {
    return this.setCount === this.size;
  }

  public has(i: number): boolean {
    return ((this.bytes[i >> 3] as number) & (0x80 >> (i & 7))) !== 0;
  }

  /** Sets a bit; returns false if it was already set. */
  public set(i: number): boolean {
    const mask = 0x80 >> (i & 7);
    const byte = this.bytes[i >> 3] as number;
    if (byte & mask || i >= this.size || i < 0) return false;
    this.bytes[i >> 3] = byte | mask;
    this.setCount++;
    return true;
  }

  /** Clears a bit; returns false if it was already clear. */
  public clear(i: number): boolean {
    const mask = 0x80 >> (i & 7);
    const byte = this.bytes[i >> 3] as number;
    if (!(byte & mask)) return false;
    this.bytes[i >> 3] = byte & ~mask;
    this.setCount--;
    return true;
  }

  /** Sets every bit. */
  public fill(): void {
    this.bytes.fill(0xff);
    if (this.size % 8) this.bytes[this.bytes.length - 1] = 0xff << (8 - (this.size % 8));
    this.setCount = this.size;
  }
}

const POPCOUNT = Uint8Array.from({ length: 256 }, (_, n) => {
  let c = 0;
  for (let v = n; v; v &= v - 1) c++;
  return c;
});
