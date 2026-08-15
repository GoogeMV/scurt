export interface Config {
  host: string;
  port: number;
  /** Public origin used to build short URLs, e.g. https://scurt.example.com */
  baseUrl: string;
  dbPath: string;
  logLevel: string;
  rateLimit: {
    /** Max requests per window per IP, across all routes. */
    globalMax: number;
    /** Max link creations per window per IP. */
    createMax: number;
    /** Max login/register attempts per window per IP. */
    authMax: number;
    windowMs: number;
  };
  auth: {
    /** HS256 signing secret for access tokens. */
    jwtSecret: string;
    /** HMAC pepper applied to passwords before argon2id. */
    passwordPepper: string;
    accessTtlSeconds: number;
    refreshTtlDays: number;
    /** Failed logins before the account is temporarily locked. */
    lockoutThreshold: number;
    lockoutSeconds: number;
    /** Set the refresh cookie's Secure flag (always true in production). */
    secureCookies: boolean;
  };
  cors: {
    /** Allowed cross-site origins. Empty = CORS fully closed (same-origin only). */
    origins: string[];
  };
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

function secretFromEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.length < 32) {
    throw new Error(
      `${name} must be set to a random string of at least 32 characters ` +
        `(generate one with: node -e "console.log(crypto.randomBytes(32).toString('hex'))")`,
    );
  }
  return value;
}

export function loadConfig(): Config {
  const port = intFromEnv("PORT", 8080);
  const production = process.env.NODE_ENV === "production";
  return {
    host: process.env.HOST ?? "0.0.0.0",
    port,
    baseUrl: (process.env.BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, ""),
    dbPath: process.env.DB_PATH ?? "data/scurt.db",
    logLevel: process.env.LOG_LEVEL ?? "info",
    rateLimit: {
      globalMax: intFromEnv("RATE_LIMIT_GLOBAL_MAX", 300),
      createMax: intFromEnv("RATE_LIMIT_CREATE_MAX", 20),
      authMax: intFromEnv("RATE_LIMIT_AUTH_MAX", 10),
      windowMs: intFromEnv("RATE_LIMIT_WINDOW_MS", 60_000),
    },
    auth: {
      jwtSecret: secretFromEnv("JWT_SECRET"),
      passwordPepper: secretFromEnv("PASSWORD_PEPPER"),
      accessTtlSeconds: intFromEnv("ACCESS_TTL_SECONDS", 15 * 60),
      refreshTtlDays: intFromEnv("REFRESH_TTL_DAYS", 30),
      lockoutThreshold: intFromEnv("LOCKOUT_THRESHOLD", 10),
      lockoutSeconds: intFromEnv("LOCKOUT_SECONDS", 15 * 60),
      secureCookies: production || process.env.SECURE_COOKIES === "1",
    },
    cors: {
      origins: (process.env.CORS_ORIGINS ?? "")
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean),
    },
  };
}
