import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";

export const redirectRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    "/:slug",
    { schema: { params: Type.Object({ slug: Type.String({ minLength: 1, maxLength: 64 }) }) } },
    async (request, reply) => {
      const target = app.repo.resolveAndTrack(request.params.slug);
      if (!target) {
        app.metrics.redirects.inc({ outcome: "miss" });
        return reply.code(404).send({ error: "not found" });
      }
      app.metrics.redirects.inc({ outcome: "hit" });
      // 302 (not 301) on purpose: browsers cache 301 aggressively, which would
      // bypass the service entirely — no click counting, no expiry enforcement.
      return reply.code(302).header("cache-control", "no-store").redirect(target);
    },
  );
};
