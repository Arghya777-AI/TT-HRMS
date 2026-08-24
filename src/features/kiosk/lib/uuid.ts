/**
 * uuid.ts — a v4 UUID that does not require Safari 15.4.
 *
 * `crypto.randomUUID()` is the right call and the gate used it in four places: two
 * idempotency keys and two client event ids. It landed in Safari 15.4 (March 2022), so on an
 * iPad that has not been updated it is simply `undefined` and calling it throws a TypeError.
 * The throw happens inside the scan loop and inside `deviceCall`, which means the terminal
 * comes up, shows a viewfinder, and then fails on the first punch — the worst shape of
 * failure for a wall-mounted device, because it looks like it is working.
 *
 * `crypto.getRandomValues` has been available since Safari 5, so the fallback is real
 * randomness rather than a degraded guess: same 122 bits of entropy, same version and
 * variant bits, just assembled by hand. Nothing about the identifier's quality changes, and
 * every consumer of it — the server's dedup key, the IndexedDB primary key — is unaffected.
 *
 * `crypto` itself is only present in a secure context. The gate is HTTPS-only (the camera
 * requires it), so a missing `crypto` means something is wrong that a UUID cannot fix, and
 * this throws with a sentence that says so rather than a bare TypeError.
 */

/** A v4 UUID, using the platform generator when it exists. */
export function uuid(): string {
  const c: Crypto | undefined = typeof crypto === "undefined" ? undefined : crypto;
  if (c === undefined) {
    throw new Error(
      "This browser exposes no Web Crypto, which usually means the page is not on HTTPS. " +
        "The gate terminal needs a secure connection.",
    );
  }
  // Guarded rather than assumed: the whole point of this module.
  if (typeof c.randomUUID === "function") return c.randomUUID();

  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  // Version 4, variant 1 — the two fixed fields that make this a well-formed v4 rather
  // than 16 random bytes wearing a UUID's punctuation.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex: string[] = [];
  for (const byte of bytes) hex.push(byte.toString(16).padStart(2, "0"));
  return (
    hex.slice(0, 4).join("") +
    "-" +
    hex.slice(4, 6).join("") +
    "-" +
    hex.slice(6, 8).join("") +
    "-" +
    hex.slice(8, 10).join("") +
    "-" +
    hex.slice(10, 16).join("")
  );
}
