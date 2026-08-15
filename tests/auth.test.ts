import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerUser, testApp } from "./helpers.js";

let app: FastifyInstance;

beforeEach(async () => {
  app = await testApp();
});

afterEach(async () => {
  await app.close();
});

describe("register & login", () => {
  it("registers, stores an argon2id hash, and returns tokens", async () => {
    const session = await registerUser(app);
    expect(session.accessToken.split(".")).toHaveLength(3); // JWT shape
    expect(session.refreshCookie).toMatch(/^scurt_refresh=[0-9a-f]{64}$/);

    const user = app.auth.findUserByEmail("ana@example.com");
    expect(user?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(user?.passwordHash).not.toContain("parola");
  });

  it("sets the refresh cookie httpOnly, SameSite=Strict, scoped to /api/auth", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      body: { email: "b@example.com", password: "parola-foarte-buna" },
    });
    const cookie = String(res.headers["set-cookie"]);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/api/auth");
  });

  it("rejects duplicate emails, short passwords and bad emails", async () => {
    await registerUser(app);
    const dup = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      body: { email: "ana@example.com", password: "alta-parola-buna" },
    });
    expect(dup.statusCode).toBe(409);

    const short = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      body: { email: "c@example.com", password: "scurta" },
    });
    expect(short.statusCode).toBe(400);

    const badEmail = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      body: { email: "not-an-email", password: "parola-foarte-buna" },
    });
    expect(badEmail.statusCode).toBe(400);
  });

  it("logs in with correct credentials and 401s wrong ones identically for unknown emails", async () => {
    await registerUser(app);
    const ok = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      body: { email: "ana@example.com", password: "parola-foarte-buna" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().accessToken).toBeDefined();

    const wrongPassword = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      body: { email: "ana@example.com", password: "parola-gresita!" },
    });
    const unknownEmail = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      body: { email: "nimeni@example.com", password: "parola-gresita!" },
    });
    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    expect(wrongPassword.json()).toEqual(unknownEmail.json());
  });

  it("locks the account after repeated failures", async () => {
    await registerUser(app); // threshold is 3 in the test config
    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: "POST",
        url: "/api/auth/login",
        body: { email: "ana@example.com", password: "parola-gresita!" },
      });
    }
    const locked = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      body: { email: "ana@example.com", password: "parola-foarte-buna" },
    });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().retryAfterSeconds).toBeGreaterThan(0);
  });
});

describe("access tokens", () => {
  it("guards /api/me and accepts a valid bearer token", async () => {
    const anonymous = await app.inject({ method: "GET", url: "/api/me" });
    expect(anonymous.statusCode).toBe(401);

    const garbage = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: "Bearer nu.e.jwt" },
    });
    expect(garbage.statusCode).toBe(401);

    const session = await registerUser(app);
    const me = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().email).toBe("ana@example.com");
  });
});

describe("refresh rotation", () => {
  it("rotates the refresh token and detects reuse of the old one", async () => {
    const session = await registerUser(app);

    const first = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      headers: { cookie: session.refreshCookie },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().accessToken).toBeDefined();
    const rotatedCookie = String(first.headers["set-cookie"]).split(";")[0] ?? "";
    expect(rotatedCookie).not.toBe(session.refreshCookie);

    // Replaying the ORIGINAL (already-rotated) token = reuse → the whole
    // family dies, including the freshly rotated token.
    const replay = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      headers: { cookie: session.refreshCookie },
    });
    expect(replay.statusCode).toBe(401);

    const afterReuse = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      headers: { cookie: rotatedCookie },
    });
    expect(afterReuse.statusCode).toBe(401);
  });

  it("logout revokes the refresh token", async () => {
    const session = await registerUser(app);
    const out = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: session.refreshCookie },
    });
    expect(out.statusCode).toBe(204);

    const refresh = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      headers: { cookie: session.refreshCookie },
    });
    expect(refresh.statusCode).toBe(401);
  });
});

describe("link ownership", () => {
  it("attributes links created with a token and lists them under /api/my/links", async () => {
    const session = await registerUser(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/links",
      headers: { authorization: `Bearer ${session.accessToken}` },
      body: { url: "https://example.com/owned" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().owned).toBe(true);

    const mine = await app.inject({
      method: "GET",
      url: "/api/my/links",
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect(mine.json().items).toHaveLength(1);
    expect(mine.json().items[0].targetUrl).toBe("https://example.com/owned");
  });

  it("lets the owner delete without a delete token, but not other users", async () => {
    const ana = await registerUser(app, "ana@example.com");
    const bob = await registerUser(app, "bob@example.com");
    const created = await app.inject({
      method: "POST",
      url: "/api/links",
      headers: { authorization: `Bearer ${ana.accessToken}` },
      body: { url: "https://example.com/owned" },
    });
    const slug = created.json().slug;

    const bobTry = await app.inject({
      method: "DELETE",
      url: `/api/links/${slug}`,
      headers: { authorization: `Bearer ${bob.accessToken}` },
    });
    expect(bobTry.statusCode).toBe(403);

    const anaDelete = await app.inject({
      method: "DELETE",
      url: `/api/links/${slug}`,
      headers: { authorization: `Bearer ${ana.accessToken}` },
    });
    expect(anaDelete.statusCode).toBe(204);
  });
});

describe("rate limiting & CORS", () => {
  it("429s auth endpoints past the per-route limit", async () => {
    const limited = await testApp({
      rateLimit: { globalMax: 1000, createMax: 1000, authMax: 2, windowMs: 60_000 },
    });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 3; i++) {
        const res = await limited.inject({
          method: "POST",
          url: "/api/auth/login",
          body: { email: "x@example.com", password: "parola-foarte-buna" },
        });
        codes.push(res.statusCode);
      }
      expect(codes).toEqual([401, 401, 429]);
    } finally {
      await limited.close();
    }
  });

  it("sends no CORS headers by default", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: "https://evil.example" },
      body: { email: "x@example.com", password: "parola-foarte-buna" },
    });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("allows only the configured origin when CORS is opened", async () => {
    const open = await testApp({ cors: { origins: ["https://app.example"] } });
    try {
      const allowed = await open.inject({
        method: "GET",
        url: "/healthz",
        headers: { origin: "https://app.example" },
      });
      expect(allowed.headers["access-control-allow-origin"]).toBe("https://app.example");
      expect(allowed.headers["access-control-allow-credentials"]).toBe("true");

      const denied = await open.inject({
        method: "GET",
        url: "/healthz",
        headers: { origin: "https://evil.example" },
      });
      expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
    } finally {
      await open.close();
    }
  });
});
