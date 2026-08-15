import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLink, testApp } from "./helpers.js";

let app: FastifyInstance;

beforeEach(async () => {
  app = await testApp();
});

afterEach(async () => {
  await app.close();
});

describe("POST /api/links", () => {
  it("creates a link and returns the short URL", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/links",
      body: { url: "https://example.com/some/long/path" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.slug).toMatch(/^[1-9A-HJ-NP-Za-km-z]{7}$/);
    expect(body.shortUrl).toBe(`http://short.test/${body.slug}`);
    expect(body.deleteToken).toMatch(/^[0-9a-f]{32}$/);
    expect(body.expiresAt).toBeNull();
  });

  it("honours a custom slug and rejects a duplicate with 409", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/api/links",
      body: { url: "https://example.com", slug: "my-link" },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().slug).toBe("my-link");

    const dup = await app.inject({
      method: "POST",
      url: "/api/links",
      body: { url: "https://example.org", slug: "my-link" },
    });
    expect(dup.statusCode).toBe(409);
  });

  it("rejects reserved slugs, bad URLs and bad TTLs", async () => {
    const reserved = await app.inject({
      method: "POST",
      url: "/api/links",
      body: { url: "https://example.com", slug: "api" },
    });
    expect(reserved.statusCode).toBe(400);

    const badUrl = await app.inject({
      method: "POST",
      url: "/api/links",
      body: { url: "javascript:alert(1)" },
    });
    expect(badUrl.statusCode).toBe(400);

    const badTtl = await app.inject({
      method: "POST",
      url: "/api/links",
      body: { url: "https://example.com", expiresInSeconds: 5 },
    });
    expect(badTtl.statusCode).toBe(400);
  });
});

describe("GET /:slug", () => {
  it("302-redirects to the target and counts the click", async () => {
    const { slug } = await createLink(app, { url: "https://example.com/target" });

    const redirect = await app.inject({ method: "GET", url: `/${slug}` });
    expect(redirect.statusCode).toBe(302);
    expect(redirect.headers.location).toBe("https://example.com/target");
    expect(redirect.headers["cache-control"]).toBe("no-store");

    await app.inject({ method: "GET", url: `/${slug}` });
    const stats = await app.inject({ method: "GET", url: `/api/links/${slug}` });
    expect(stats.json().clicks).toBe(2);
    expect(stats.json().lastAccessAt).not.toBeNull();
  });

  it("404s for unknown slugs", async () => {
    const res = await app.inject({ method: "GET", url: "/nope123" });
    expect(res.statusCode).toBe(404);
  });

  it("404s for expired links without counting them", async () => {
    // Insert an already-expired row directly — the API refuses TTLs < 60s.
    app.repo.create({
      slug: "expired1",
      targetUrl: "https://example.com",
      deleteToken: "t",
      expiresAt: Math.floor(Date.now() / 1000) - 10,
      userId: null,
    });
    const res = await app.inject({ method: "GET", url: "/expired1" });
    expect(res.statusCode).toBe(404);
    const stats = await app.inject({ method: "GET", url: "/api/links/expired1" });
    expect(stats.json().clicks).toBe(0);
  });
});

describe("DELETE /api/links/:slug", () => {
  it("deletes with the right token, refuses the wrong one", async () => {
    const { slug, deleteToken } = await createLink(app);

    const wrong = await app.inject({
      method: "DELETE",
      url: `/api/links/${slug}`,
      headers: { "x-delete-token": "wrong" },
    });
    expect(wrong.statusCode).toBe(403);

    const ok = await app.inject({
      method: "DELETE",
      url: `/api/links/${slug}`,
      headers: { "x-delete-token": deleteToken },
    });
    expect(ok.statusCode).toBe(204);

    const gone = await app.inject({ method: "GET", url: `/${slug}` });
    expect(gone.statusCode).toBe(404);
  });
});

describe("rate limiting", () => {
  it("429s link creation past the per-route limit", async () => {
    const limited = await testApp({
      rateLimit: { globalMax: 1000, createMax: 2, authMax: 1000, windowMs: 60_000 },
    });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 3; i++) {
        const res = await limited.inject({
          method: "POST",
          url: "/api/links",
          body: { url: `https://example.com/${i}` },
        });
        codes.push(res.statusCode);
      }
      expect(codes).toEqual([201, 201, 429]);
    } finally {
      await limited.close();
    }
  });
});

describe("system endpoints", () => {
  it("healthz reports ok and link count", async () => {
    await createLink(app);
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", links: 1 });
  });

  it("metrics exposes prometheus counters", async () => {
    const { slug } = await createLink(app);
    await app.inject({ method: "GET", url: `/${slug}` });
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("links_created_total 1");
    expect(res.body).toContain('redirects_total{outcome="hit"} 1');
  });
});

describe("expiry sweep", () => {
  it("removes only expired rows", async () => {
    await createLink(app);
    app.repo.create({
      slug: "old1",
      targetUrl: "https://example.com",
      deleteToken: "t",
      expiresAt: Math.floor(Date.now() / 1000) - 10,
      userId: null,
    });
    expect(app.repo.sweepExpired()).toBe(1);
    expect(app.repo.countLinks()).toBe(1);
  });
});
