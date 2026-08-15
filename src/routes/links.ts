import { randomBytes } from "node:crypto";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { FastifyRequest } from "fastify";
import {
  CUSTOM_SLUG_PATTERN,
  generateSlug,
  validateCustomSlug,
  validateTargetUrl,
} from "../lib/slug.js";

const MAX_URL_LENGTH = 2048;
const MAX_TTL_SECONDS = 60 * 60 * 24 * 365; // 1 year
const SLUG_RETRIES = 3;

const createBody = Type.Object({
  url: Type.String({ minLength: 1, maxLength: MAX_URL_LENGTH }),
  slug: Type.Optional(Type.String({ pattern: CUSTOM_SLUG_PATTERN })),
  expiresInSeconds: Type.Optional(Type.Integer({ minimum: 60, maximum: MAX_TTL_SECONDS })),
});

const slugParams = Type.Object({
  slug: Type.String({ minLength: 1, maxLength: 64 }),
});

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

/**
 * Resolves the caller's user id when a valid access token is present,
 * without requiring one — link creation works logged-out too.
 */
async function optionalUserId(request: FastifyRequest): Promise<number | null> {
  if (!request.headers.authorization) return null;
  try {
    await request.jwtVerify();
    return Number(request.user.sub);
  } catch {
    return null;
  }
}

export const linkRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.post(
    "/links",
    {
      config: {
        rateLimit: {
          max: app.config.rateLimit.createMax,
          timeWindow: app.config.rateLimit.windowMs,
        },
      },
      schema: { body: createBody },
    },
    async (request, reply) => {
      const { url, slug: customSlug, expiresInSeconds } = request.body;

      const urlError = validateTargetUrl(url);
      if (urlError) return reply.code(400).send({ error: urlError });

      if (customSlug) {
        const slugError = validateCustomSlug(customSlug);
        if (slugError) return reply.code(400).send({ error: slugError });
      }

      const userId = await optionalUserId(request);
      const deleteToken = randomBytes(16).toString("hex");
      const expiresAt = expiresInSeconds ? Math.floor(Date.now() / 1000) + expiresInSeconds : null;

      // Random slugs can collide (rarely); retry with a fresh one. A custom
      // slug conflict is the caller's problem and surfaces as 409.
      for (let attempt = 0; attempt < SLUG_RETRIES; attempt++) {
        const slug = customSlug ?? generateSlug();
        try {
          const link = app.repo.create({ slug, targetUrl: url, deleteToken, expiresAt, userId });
          app.metrics.linksCreated.inc();
          return reply.code(201).send({
            slug: link.slug,
            shortUrl: `${app.config.baseUrl}/${link.slug}`,
            targetUrl: link.targetUrl,
            deleteToken,
            expiresAt: link.expiresAt,
            owned: userId !== null,
          });
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
          if (customSlug) return reply.code(409).send({ error: "slug already in use" });
        }
      }
      request.log.error({ retries: SLUG_RETRIES }, "slug generation kept colliding");
      return reply.code(503).send({ error: "could not allocate a slug, try again" });
    },
  );

  app.get("/links/:slug", { schema: { params: slugParams } }, async (request, reply) => {
    const link = app.repo.getBySlug(request.params.slug);
    if (!link) return reply.code(404).send({ error: "not found" });
    return {
      slug: link.slug,
      targetUrl: link.targetUrl,
      shortUrl: `${app.config.baseUrl}/${link.slug}`,
      clicks: link.clicks,
      createdAt: link.createdAt,
      expiresAt: link.expiresAt,
      lastAccessAt: link.lastAccessAt,
    };
  });

  app.get("/me", { preHandler: [app.authenticate] }, async (request) => {
    const userId = Number(request.user.sub);
    const user = app.auth.findUserById(userId);
    return {
      id: userId,
      email: user?.email ?? null,
      linkCount: app.repo.listByUser(userId).length,
    };
  });

  app.get("/my/links", { preHandler: [app.authenticate] }, async (request) => {
    const userId = Number(request.user.sub);
    return {
      items: app.repo.listByUser(userId).map((link) => ({
        slug: link.slug,
        shortUrl: `${app.config.baseUrl}/${link.slug}`,
        targetUrl: link.targetUrl,
        clicks: link.clicks,
        createdAt: link.createdAt,
        expiresAt: link.expiresAt,
        lastAccessAt: link.lastAccessAt,
      })),
    };
  });

  app.delete(
    "/links/:slug",
    {
      schema: {
        params: slugParams,
        headers: Type.Object({ "x-delete-token": Type.Optional(Type.String({ minLength: 1 })) }),
      },
    },
    async (request, reply) => {
      const userId = await optionalUserId(request);
      const outcome = app.repo.deleteBySlug(request.params.slug, {
        ...(request.headers["x-delete-token"]
          ? { deleteToken: request.headers["x-delete-token"] }
          : {}),
        ...(userId !== null ? { userId } : {}),
      });
      if (outcome === "not_found") return reply.code(404).send({ error: "not found" });
      if (outcome === "forbidden") {
        return reply.code(403).send({ error: "not the owner and no valid delete token" });
      }
      return reply.code(204).send();
    },
  );
};
