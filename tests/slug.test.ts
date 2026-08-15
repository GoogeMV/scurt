import { describe, expect, it } from "vitest";
import {
  GENERATED_SLUG_LENGTH,
  generateSlug,
  validateCustomSlug,
  validateTargetUrl,
} from "../src/lib/slug.js";

describe("generateSlug", () => {
  it("produces slugs of the configured length from the base58 alphabet", () => {
    for (let i = 0; i < 100; i++) {
      const slug = generateSlug();
      expect(slug).toHaveLength(GENERATED_SLUG_LENGTH);
      expect(slug).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
    }
  });

  it("does not repeat across a small sample", () => {
    const sample = new Set(Array.from({ length: 1000 }, () => generateSlug()));
    expect(sample.size).toBe(1000);
  });
});

describe("validateCustomSlug", () => {
  it("accepts reasonable slugs", () => {
    expect(validateCustomSlug("my-link_1")).toBeNull();
    expect(validateCustomSlug("abc")).toBeNull();
  });

  it("rejects bad shapes", () => {
    expect(validateCustomSlug("ab")).not.toBeNull(); // too short
    expect(validateCustomSlug("a".repeat(33))).not.toBeNull(); // too long
    expect(validateCustomSlug("spa ce")).not.toBeNull();
    expect(validateCustomSlug("diacritice-ăî")).not.toBeNull();
  });

  it("rejects reserved slugs regardless of case", () => {
    expect(validateCustomSlug("api")).not.toBeNull();
    expect(validateCustomSlug("API")).not.toBeNull();
    expect(validateCustomSlug("metrics")).not.toBeNull();
  });
});

describe("validateTargetUrl", () => {
  it("accepts http and https URLs", () => {
    expect(validateTargetUrl("https://example.com/a?b=c")).toBeNull();
    expect(validateTargetUrl("http://localhost:3000/dev")).toBeNull();
  });

  it("rejects non-web schemes and garbage", () => {
    expect(validateTargetUrl("javascript:alert(1)")).not.toBeNull();
    expect(validateTargetUrl("data:text/html,hi")).not.toBeNull();
    expect(validateTargetUrl("file:///etc/passwd")).not.toBeNull();
    expect(validateTargetUrl("not a url")).not.toBeNull();
  });
});
