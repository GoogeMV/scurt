import { Counter, collectDefaultMetrics, Histogram, Registry } from "prom-client";

export interface Metrics {
  registry: Registry;
  httpRequestDuration: Histogram<"method" | "route" | "status">;
  linksCreated: Counter<string>;
  redirects: Counter<"outcome">;
}

export function createMetrics(): Metrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  return {
    registry,
    httpRequestDuration: new Histogram({
      name: "http_request_duration_seconds",
      help: "HTTP request duration by method, route and status code",
      labelNames: ["method", "route", "status"],
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
      registers: [registry],
    }),
    linksCreated: new Counter({
      name: "links_created_total",
      help: "Short links created",
      registers: [registry],
    }),
    redirects: new Counter({
      name: "redirects_total",
      help: "Redirect lookups by outcome",
      labelNames: ["outcome"],
      registers: [registry],
    }),
  };
}
