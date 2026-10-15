import { describe, expect, test } from "bun:test";
import { createDiffieHellman, randomBytes } from "node:crypto";
import { createCipheriv } from "node:crypto";
import { CRYPTO_PLAIN, CRYPTO_RC4, MseHandshake, MseKeyPair, type MseResult, Rc4 } from "../src/mse";

/** Runs both sides against each other, delivering bytes in random-sized pieces. */
function pair(allowA: number, allowB: number, preferPlain = false, payload = new Uint8Array(68).fill(7)) {
  const infoHash = new Uint8Array(randomBytes(20));
  const results: { a?: MseResult; b?: MseResult } = {};
  const toA: Uint8Array[] = [];
  const toB: Uint8Array[] = [];
  const a = new MseHandshake(true, { infoHashes: [infoHash], allow: allowA, initialPayload: payload, send: (x) => toB.push(x) }, (r) => (results.a = r));
  const b = new MseHandshake(false, { infoHashes: [new Uint8Array(20), infoHash], allow: allowB, preferPlain, send: (x) => toA.push(x) }, (r) => (results.b = r));
  const deliver = (queue: Uint8Array[], side: MseHandshake, done: () => boolean) => {
    while (queue.length && !done()) {
      const chunk = queue.shift() as Uint8Array;
      // Split each send into random fragments
      let o = 0;
      while (o < chunk.length && !done()) {
        const n = 1 + Math.floor(Math.random() * 40);
        side.push(chunk.subarray(o, o + n));
        o += n;
      }
      if (o < chunk.length) return chunk.subarray(o);
    }
    return null;
  };
  for (let i = 0; i < 20 && !(results.a && results.b); i++) {
    const restB = deliver(toB, b, () => !!results.b);
    const restA = deliver(toA, a, () => !!results.a);
    if (restB) results.b!.rest = Buffer.concat([results.b!.rest, results.b!.decrypt ? results.b!.decrypt.update(restB) : restB]);
    if (restA) results.a!.rest = Buffer.concat([results.a!.rest, results.a!.decrypt ? results.a!.decrypt.update(restA) : restA]);
  }
  return { infoHash, ...results };
}

describe("MSE", () => {
  test("the BigInt key exchange agrees with node:crypto's Diffie-Hellman", () => {
    const prime = "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A63A36210000000000090563";
    const ours = new MseKeyPair();
    const theirs = createDiffieHellman(prime, "hex", Buffer.from([2]));
    const theirPublic = theirs.generateKeys();
    expect(Buffer.from(ours.sharedSecret(theirPublic)).toString("hex")).toBe(theirs.computeSecret(Buffer.from(ours.publicKey)).toString("hex"));
  });

  test("the JavaScript RC4 matches the native cipher, keystream dropped by 1024 bytes", () => {
    const key = new Uint8Array(randomBytes(20));
    const native = createCipheriv("rc4", key, null);
    native.update(new Uint8Array(1024));
    const data = new Uint8Array(randomBytes(5000));
    expect(new Rc4(key).update(data.slice())).toEqual(new Uint8Array(native.update(data)));
  });

  test("RC4 handshake: both sides agree and the initial payload arrives", () => {
    const { a, b, infoHash } = pair(CRYPTO_RC4 | CRYPTO_PLAIN, CRYPTO_RC4 | CRYPTO_PLAIN);
    expect(a && b).toBeTruthy();
    expect(Buffer.from(b!.infoHash).equals(infoHash)).toBe(true);
    expect(b!.rest).toEqual(new Uint8Array(68).fill(7));
    expect(a!.encrypt).not.toBeNull();
    // The stream continues in both directions
    const msg = new Uint8Array(randomBytes(1000));
    const sent = a!.encrypt!.update(msg.slice());
    expect(sent).not.toEqual(msg);
    expect(b!.decrypt!.update(sent)).toEqual(msg);
    expect(a!.decrypt!.update(b!.encrypt!.update(msg.slice()))).toEqual(msg);
  });

  test("plaintext is selected when the receiver prefers it", () => {
    const { a, b } = pair(CRYPTO_RC4 | CRYPTO_PLAIN, CRYPTO_RC4 | CRYPTO_PLAIN, true);
    expect(a!.encrypt).toBeNull();
    expect(b!.decrypt).toBeNull();
    expect(b!.rest).toEqual(new Uint8Array(68).fill(7));
  });

  test("no common method fails", () => {
    expect(() => pair(CRYPTO_PLAIN, CRYPTO_RC4)).toThrow();
  });

  test("garbage never hangs or throws anything but an error", () => {
    for (let i = 0; i < 200; i++) {
      const side = new MseHandshake(i % 2 === 0, { infoHashes: [new Uint8Array(20)], allow: 3, send: () => undefined }, () => undefined);
      try {
        side.push(new Uint8Array(randomBytes(Math.floor(Math.random() * 1500))));
        side.push(new Uint8Array(randomBytes(700)));
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
    }
  });
});
