import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp(config);

  // Expiry is enforced lazily on every redirect; this sweep just keeps the
  // table from accumulating dead rows.
  const sweep = setInterval(() => {
    const removed = app.repo.sweepExpired();
    if (removed > 0) app.log.info({ removed }, "swept expired links");
    const tokens = app.auth.sweepTokens();
    if (tokens > 0) app.log.info({ tokens }, "swept expired refresh tokens");
  }, SWEEP_INTERVAL_MS);
  sweep.unref();

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    clearInterval(sweep);
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: config.host, port: config.port });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
