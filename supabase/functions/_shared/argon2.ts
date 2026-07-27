/**
 * _shared/argon2.ts — Argon2id hashing and verification for the two secrets the
 * database stores as Argon2id and nothing else may hold in the clear:
 *
 *   secure.kiosk_device_secrets.secret_hash    (migration 012 §7)
 *   secure.kiosk_operator_secrets.pin_hash     (migration 012 §8)
 *
 * ADDITION to the `_shared` inventory of spec-architecture §4, deliberately
 * small: `auth.ts` owns *who you are*, this file owns *one primitive*. It exists
 * because Postgres cannot compute Argon2id (see the note on `loadArgon2` in
 * deps.ts) and because duplicating crypto parameters in two edge functions is
 * how two functions end up disagreeing about them.
 *
 * Parameters are the OWASP 2024 "second recommended" Argon2id configuration —
 * m = 19 MiB, t = 2, p = 1 — chosen over the memory-heavier variants because an
 * edge isolate is memory-capped and a kiosk PIN check sits in the 700 ms
 * good-frame→green budget of spec-kiosk §4.4. ~40–60 ms per verify.
 *
 * Three rules:
 *   1. `verifySecret` NEVER throws on bad input. A malformed or truncated stored
 *      hash is a failed verification, not a 500 — otherwise a corrupt row turns
 *      into an outage, and the error text can hint at what is stored.
 *   2. Nothing here logs. The plaintext is a device secret or a guard PIN; the
 *      encoded hash is matched by log.ts's redactor precisely because it must
 *      never appear in a log line either.
 *   3. Parameters live in `ARGON2ID_PARAMS` only. The salt is per-hash and
 *      travels inside the PHC-encoded string, so rotating parameters needs no
 *      migration: old hashes keep verifying with the parameters they carry.
 */

import { loadArgon2 } from "./deps.ts";
import { serverError } from "./errors.ts";

/** OWASP 2024: Argon2id, 19 MiB, 2 iterations, 1 lane, 32-byte tag. */
export const ARGON2ID_PARAMS = {
  parallelism: 1,
  iterations: 2,
  /** KiB, not bytes: 19 456 KiB = 19 MiB. */
  memorySize: 19_456,
  hashLength: 32,
} as const;

/** 16 bytes, the libsodium/PHC default. */
export const ARGON2ID_SALT_BYTES = 16;

type Argon2Module = Awaited<ReturnType<typeof loadArgon2>>;

let cached: Argon2Module | null = null;

/** Load once per isolate: the WASM instantiation is the expensive part, not the hash. */
async function argon2(): Promise<Argon2Module> {
  if (cached === null) cached = await loadArgon2();
  return cached;
}

/** True for a string that looks like a PHC-encoded Argon2 hash. Cheap pre-filter. */
export function isArgon2Hash(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("$argon2") && value.length >= 40;
}

/**
 * Hash a secret for storage. Returns the PHC-encoded string
 * (`$argon2id$v=19$m=19456,t=2,p=1$<salt>$<tag>`), which is what the
 * `*_hash` columns hold — salt and parameters included, so verification needs no
 * companion columns.
 */
export async function hashSecret(plaintext: string): Promise<string> {
  if (plaintext === "") {
    throw serverError("argon2", "Refusing to hash an empty secret.", { code: "EMPTY_SECRET" });
  }
  const { argon2id } = await argon2();
  const encoded = await argon2id({
    password: plaintext,
    salt: crypto.getRandomValues(new Uint8Array(ARGON2ID_SALT_BYTES)),
    ...ARGON2ID_PARAMS,
    outputType: "encoded",
  });
  if (typeof encoded !== "string") {
    throw serverError("argon2", "Secret hashing produced an unexpected result.", {
      code: "HASH_FAILED",
    });
  }
  return encoded;
}

/**
 * Verify a presented secret against a stored PHC hash.
 *
 * `false` for every failure mode — wrong secret, NULL column, hash written by
 * another algorithm, truncated string. Constant-time comparison of the tag is
 * argon2's own job; the work factor makes the timing of the surrounding code
 * uninteresting.
 */
export async function verifySecret(
  storedHash: string | null | undefined,
  plaintext: string,
): Promise<boolean> {
  if (!isArgon2Hash(storedHash) || plaintext === "") return false;
  try {
    const { argon2Verify } = await argon2();
    return await argon2Verify({ password: plaintext, hash: storedHash }) === true;
  } catch {
    // Malformed stored hash. A denial, never an exception (rule 1).
    return false;
  }
}

/**
 * Verify against several candidate hashes — the rotation-grace shape both
 * `secure.*_secrets` tables use (`secret_hash` + `previous_secret_hash`).
 * Returns the index of the hash that matched, or `-1`. Callers use the index to
 * tell "current" from "previous" (a previous-secret match is worth an audit note
 * and a nudge to finish the rotation).
 *
 * Every candidate is evaluated: no early exit, so the number of Argon2 passes
 * does not reveal which slot matched.
 */
export async function verifyAgainst(
  candidates: readonly (string | null | undefined)[],
  plaintext: string,
): Promise<number> {
  let matchedIndex = -1;
  for (let i = 0; i < candidates.length; i++) {
    const ok = await verifySecret(candidates[i], plaintext);
    if (ok && matchedIndex === -1) matchedIndex = i;
  }
  return matchedIndex;
}
