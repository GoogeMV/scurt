import { createHash, randomBytes } from "node:crypto";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { FastifyReply } from "fastify";
import { hashPassword, verifyPassword } from "../lib/passwords.js";

const REFRESH_COOKIE = "scurt_refresh";
/** The refresh cookie is only ever sent to the auth endpoints. */
const REFRESH_COOKIE_PATH = "/api/auth";

const credentialsBody = Type.Object({
  email: Type.String({ format: "email", maxLength: 254 }),
  // NIST 800-63B: length is the primary strength factor; no composition rules.
  password: Type.String({ minLength: 10, maxLength: 128 }),
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

export const authRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const { auth } = app.config;
  const refreshTtlSeconds = auth.refreshTtlDays * 24 * 3600;

  const authRateLimit = {
    rateLimit: { max: app.config.rateLimit.authMax, timeWindow: app.config.rateLimit.windowMs },
  };

  function setRefreshCookie(reply: FastifyReply, token: string): void {
    void reply.setCookie(REFRESH_COOKIE, token, {
      path: REFRESH_COOKIE_PATH,
      httpOnly: true,
      sameSite: "strict",
      secure: auth.secureCookies,
      maxAge: refreshTtlSeconds,
    });
  }

  function clearRefreshCookie(reply: FastifyReply): void {
    void reply.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
  }

  /** Mints an access token + a refresh token in the given rotation family. */
  function issueTokens(
    reply: FastifyReply,
    userId: number,
    family: string,
  ): { accessToken: string } {
    const refreshToken = randomBytes(32).toString("hex");
    app.auth.createRefreshToken({
      userId,
      tokenHash: sha256(refreshToken),
      family,
      expiresAt: Math.floor(Date.now() / 1000) + refreshTtlSeconds,
    });
    setRefreshCookie(reply, refreshToken);
    const accessToken = app.jwt.sign({ sub: String(userId) }, { expiresIn: auth.accessTtlSeconds });
    return { accessToken };
  }

  app.post(
    "/register",
    { config: authRateLimit, schema: { body: credentialsBody } },
    async (request, reply) => {
      const email = request.body.email.toLowerCase();
      const passwordHash = await hashPassword(request.body.password, auth.passwordPepper);
      try {
        const user = app.auth.createUser(email, passwordHash);
        const { accessToken } = issueTokens(reply, user.id, randomBytes(16).toString("hex"));
        return reply.code(201).send({ user: { id: user.id, email: user.email }, accessToken });
      } catch (err) {
        if (isUniqueViolation(err)) {
          // Same status/body as success would be ideal against enumeration,
          // but a usable API needs the conflict; the rate limit is the
          // mitigation for bulk probing.
          return reply.code(409).send({ error: "email already registered" });
        }
        throw err;
      }
    },
  );

  app.post(
    "/login",
    { config: authRateLimit, schema: { body: credentialsBody } },
    async (request, reply) => {
      const email = request.body.email.toLowerCase();
      const user = app.auth.findUserByEmail(email);

      if (!user) {
        // Burn the same argon2 time as a real check — response timing must
        // not reveal whether the email exists.
        await verifyPassword(app.dummyPasswordHash, request.body.password, auth.passwordPepper);
        return reply.code(401).send({ error: "invalid credentials" });
      }

      const nowSec = Math.floor(Date.now() / 1000);
      if (user.lockedUntil !== null && user.lockedUntil > nowSec) {
        return reply.code(429).send({
          error: "account temporarily locked after repeated failures",
          retryAfterSeconds: user.lockedUntil - nowSec,
        });
      }

      const valid = await verifyPassword(
        user.passwordHash,
        request.body.password,
        auth.passwordPepper,
      );
      if (!valid) {
        const lockedUntil = app.auth.recordLoginFailure(
          user.id,
          auth.lockoutThreshold,
          auth.lockoutSeconds,
        );
        if (lockedUntil) {
          request.log.warn({ userId: user.id }, "account locked after repeated failures");
        }
        return reply.code(401).send({ error: "invalid credentials" });
      }

      app.auth.resetLoginFailures(user.id);
      const { accessToken } = issueTokens(reply, user.id, randomBytes(16).toString("hex"));
      return { user: { id: user.id, email: user.email }, accessToken };
    },
  );

  app.post("/refresh", { config: authRateLimit }, async (request, reply) => {
    const presented = request.cookies[REFRESH_COOKIE];
    if (!presented) return reply.code(401).send({ error: "no refresh token" });

    const record = app.auth.findRefreshToken(sha256(presented));
    if (!record || record.expiresAt <= Math.floor(Date.now() / 1000)) {
      clearRefreshCookie(reply);
      return reply.code(401).send({ error: "invalid refresh token" });
    }

    if (record.revokedAt !== null) {
      // Rotation reuse: this token was already exchanged once. Either the
      // legitimate client or a thief is replaying it — revoke the whole
      // family so both sides get logged out and must re-authenticate.
      app.auth.revokeFamily(record.family);
      clearRefreshCookie(reply);
      request.log.warn({ userId: record.userId }, "refresh token reuse detected");
      return reply.code(401).send({ error: "invalid refresh token" });
    }

    app.auth.revokeToken(record.id);
    const { accessToken } = issueTokens(reply, record.userId, record.family);
    return { accessToken };
  });

  app.post("/logout", async (request, reply) => {
    const presented = request.cookies[REFRESH_COOKIE];
    if (presented) {
      const record = app.auth.findRefreshToken(sha256(presented));
      if (record) app.auth.revokeToken(record.id);
    }
    clearRefreshCookie(reply);
    return reply.code(204).send();
  });
};
