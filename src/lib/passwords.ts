import { createHmac } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";

/**
 * Passwords are peppered, then hashed with argon2id.
 *
 * - argon2id with the OWASP-recommended cost (19 MiB memory, 2 iterations,
 *   parallelism 1) — memory-hard, so GPU cracking rigs lose their advantage.
 *   Per-password random salts are built into argon2.
 * - The pepper is an HMAC-SHA256 with a secret that lives only in the
 *   environment: a stolen database alone is not enough to even *start*
 *   offline cracking.
 */
const ARGON2_OPTIONS = {
  memoryCost: 19 * 1024,
  timeCost: 2,
  parallelism: 1,
};

// Note: the peppered value is passed to argon2 as a base64 STRING —
// @node-rs/argon2 does not round-trip raw Buffer inputs reliably.
function pepper(password: string, secret: string): string {
  return createHmac("sha256", secret).update(password, "utf8").digest("base64");
}

export async function hashPassword(password: string, pepperSecret: string): Promise<string> {
  return hash(pepper(password, pepperSecret), ARGON2_OPTIONS);
}

export async function verifyPassword(
  passwordHash: string,
  password: string,
  pepperSecret: string,
): Promise<boolean> {
  try {
    return await verify(passwordHash, pepper(password, pepperSecret));
  } catch {
    return false;
  }
}

/**
 * A throwaway hash used when the email doesn't exist, so a login attempt
 * against an unknown account costs the same time as against a real one —
 * otherwise response timing would leak which emails are registered.
 */
export async function makeDummyHash(pepperSecret: string): Promise<string> {
  return hashPassword("dummy-password-for-timing", pepperSecret);
}
