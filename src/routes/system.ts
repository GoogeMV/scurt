import type { FastifyInstance } from "fastify";

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  app.get("/healthz", { config: { rateLimit: false } }, async (_request, reply) => {
    if (!app.repo.ping()) {
      return reply.code(503).send({ status: "degraded", db: "unreachable" });
    }
    return { status: "ok", links: app.repo.countLinks() };
  });

  app.get("/metrics", { config: { rateLimit: false } }, async (_request, reply) => {
    reply.header("content-type", app.metrics.registry.contentType);
    return app.metrics.registry.metrics();
  });
}
