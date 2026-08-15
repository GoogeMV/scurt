import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import type { Config } from "../src/config.js";

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    baseUrl: "http://short.test",
    dbPath: ":memory:",
    logLevel: "silent",
    rateLimit: { globalMax: 1000, createMax: 1000, authMax: 1000, windowMs: 60_000 },
    auth: {
      jwtSecret: "test-jwt-secret-that-is-long-enough!",
      passwordPepper: "test-pepper-secret-that-is-long-enough",
      accessTtlSeconds: 900,
      refreshTtlDays: 30,
      lockoutThreshold: 3,
      lockoutSeconds: 900,
      secureCookies: false,
    },
    cors: { origins: [] },
    ...overrides,
  };
}

export async function testApp(overrides: Partial<Config> = {}): Promise<FastifyInstance> {
  return buildApp(testConfig(overrides));
}

export async function createLink(
  app: FastifyInstance,
  body: Record<string, unknown> = { url: "https://example.com/page" },
): Promise<{ slug: string; shortUrl: string; deleteToken: string }> {
  const res = await app.inject({ method: "POST", url: "/api/links", body });
  if (res.statusCode !== 201) {
    throw new Error(`link creation failed: ${res.statusCode} ${res.body}`);
  }
  return res.json();
}

export interface Session {
  accessToken: string;
  refreshCookie: string;
  userId: number;
}

export async function registerUser(
  app: FastifyInstance,
  email = "ana@example.com",
  password = "parola-foarte-buna",
): Promise<Session> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    body: { email, password },
  });
  if (res.statusCode !== 201) {
    throw new Error(`register failed: ${res.statusCode} ${res.body}`);
  }
  const setCookie = res.headers["set-cookie"];
  const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return {
    accessToken: res.json().accessToken,
    refreshCookie: (cookieHeader ?? "").split(";")[0] ?? "",
    userId: res.json().user.id,
  };
}
