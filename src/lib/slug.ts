import { customAlphabet } from "nanoid";

// Base58: no 0/O/I/l, so slugs survive being read aloud or handwritten.
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export const GENERATED_SLUG_LENGTH = 7;

// 58^7 ≈ 2.2e12 possible slugs — collisions stay negligible for millions of
// links, and the create path retries on the rare conflict anyway.
export const generateSlug = customAlphabet(ALPHABET, GENERATED_SLUG_LENGTH);

/** Route prefixes and would-be confusing values that custom slugs may not claim. */
const RESERVED_SLUGS = new Set(["api", "healthz", "metrics", "admin", "docs", "static"]);

export const CUSTOM_SLUG_PATTERN = "^[a-zA-Z0-9_-]{3,32}$";
const customSlugRegex = new RegExp(CUSTOM_SLUG_PATTERN);

export function validateCustomSlug(slug: string): string | null {
  if (!customSlugRegex.test(slug)) {
    return `slug must match ${CUSTOM_SLUG_PATTERN}`;
  }
  if (RESERVED_SLUGS.has(slug.toLowerCase())) {
    return `slug "${slug}" is reserved`;
  }
  return null;
}

/** Only redirect to plain web URLs — never javascript:, data:, file: etc. */
export function validateTargetUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "url must be a valid absolute URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "url must use http or https";
  }
  return null;
}
