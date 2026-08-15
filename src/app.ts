import path from "node:path";
import { fileURLToPath } from "node:url";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Config } from "./config.js";
import { AuthRepository, LinkRepository, openDatabase } from "./db.js";
import { makeDummyHash } from "./lib/passwords.js";
import { createMetrics } from "./metrics.js";
import { authRoutes } from "./routes/auth.js";
import { linkRoutes } from "./routes/links.js";
import { redirectRoutes } from "./routes/redirect.js";
import { systemRoutes } from "./routes/system.js";

declare module "fastify" {
  interface FastifyInstance {
    repo: LinkRepository;
    auth: AuthRepository;
    config: Config;
    metrics: ReturnType<typeof createMetrics>;
    dummyPasswordHash: string;
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string };
    user: { sub: string };
  }
}

export async function buildApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel },
    // Behind a reverse proxy the client IP arrives in X-Forwarded-For;
    // rate limiting keys on request.ip, so it must be the real client.
    trustProxy: true,
  }).withTypeProvider<TypeBoxTypeProvider>();

  const db = openDatabase(config.dbPath);
  app.decorate("repo", new LinkRepository(db));
  app.decorate("auth", new AuthRepository(db));
  app.decorate("config", config);
  app.decorate("metrics", createMetrics());
  app.decorate("dummyPasswordHash", await makeDummyHash(config.auth.passwordPepper));

  await app.register(cookie);
  await app.register(jwt, { secret: config.auth.jwtSecret });

  // CORS is closed by default: with no configured origins the plugin is not
  // registered at all, so no cross-origin request ever gets an allow header.
  // Configured origins are matched exactly and get credentials support.
  if (config.cors.origins.length > 0) {
    await app.register(cors, {
      origin: config.cors.origins,
      credentials: true,
      methods: ["GET", "POST", "DELETE"],
    });
  }

  app.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
    } catch {
      await reply.code(401).send({ error: "missing or invalid access token" });
    }
  });

  await app.register(rateLimit, {
    global: true,
    max: config.rateLimit.globalMax,
    timeWindow: config.rateLimit.windowMs,
  });

  app.addHook("onResponse", (request, reply, done) => {
    app.metrics.httpRequestDuration.observe(
      {
        method: request.method,
        // routeOptions.url is the route pattern ("/:slug"), not the raw URL —
        // raw URLs would explode label cardinality.
        route: request.routeOptions.url ?? "unmatched",
        status: reply.statusCode,
      },
      reply.elapsedTime / 1000,
    );
    done();
  });

  app.addHook("onClose", async () => {
    db.close();
  });

  // The browser UI: index.html at "/" and assets under "/static/" ("static"
  // is a reserved slug, so this never collides with a short link at root).
  const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
  await app.register(fastifyStatic, { root: publicDir, prefix: "/static/" });
  app.get("/", { config: { rateLimit: false } }, (_request, reply) => {
    return reply.sendFile("index.html");
  });

  await app.register(systemRoutes);
  await app.register(authRoutes, { prefix: "/api/auth" });
  await app.register(linkRoutes, { prefix: "/api" });
  // Registered last: /:slug is a catch-all and must not shadow other routes.
  await app.register(redirectRoutes);

  return app;
}
