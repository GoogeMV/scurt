# scurt

A URL shortener whose point is not the feature set — it's the execution: typed
end-to-end, tested, rate-limited, observable, containerized, CI-gated.
("scurt" = Romanian for "short".)

## API

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/links` | Create a short link (works logged-out; with a bearer token the link is owned). Body: `{ url, slug?, expiresInSeconds? }` |
| `GET` | `/:slug` | `302` redirect to the target; counts the click |
| `GET` | `/api/links/:slug` | Public stats: clicks, createdAt, lastAccessAt, expiresAt |
| `DELETE` | `/api/links/:slug` | Delete; owner's bearer token **or** the `x-delete-token` header from creation |
| `POST` | `/api/auth/register` | `{ email, password }` → user + access token + refresh cookie |
| `POST` | `/api/auth/login` | Same shape; per-account lockout after repeated failures |
| `POST` | `/api/auth/refresh` | Rotates the refresh token, returns a new access token |
| `POST` | `/api/auth/logout` | Revokes the refresh token, clears the cookie |
| `GET` | `/api/me` · `/api/my/links` | Current user / their links (bearer token) |
| `GET` | `/healthz` | Liveness + DB check |
| `GET` | `/metrics` | Prometheus metrics |

## Web UI

A small vanilla-JS frontend is served at `/` (assets under `/static/`, a
reserved slug so short links at root never collide): register/login, shorten a
URL with optional custom slug and TTL, and a live table of your own links with
click counts and delete. The access token lives only in a JS variable — on page
load the UI silently calls `/api/auth/refresh`, which succeeds while the
httpOnly refresh cookie is valid, so a reload stays logged in without ever
exposing the long-lived token to JavaScript.

## Authentication design

- **Passwords: argon2id + pepper.** OWASP-recommended cost (19 MiB, t=2) —
  memory-hard against GPU rigs; per-password salts built in. Before hashing,
  passwords are HMAC-peppered with a secret that exists only in the
  environment, so a stolen database alone can't even start offline cracking.
  Password policy follows NIST 800-63B: length (≥10), no composition rules.
- **Tokens: short-lived JWT + rotating refresh.** The access token (15 min,
  HS256) is returned in the JSON body — the client keeps it in memory, never
  in localStorage. The refresh token is opaque (32 random bytes, stored as a
  SHA-256 hash), lives in an **httpOnly, SameSite=Strict cookie scoped to
  `/api/auth`**, and is **rotated on every use**. Reusing an already-rotated
  token trips reuse detection: the whole token family is revoked and both the
  legitimate user and the thief are logged out.
- **Login hardening**: unknown emails burn the same argon2 time as real ones
  (no timing oracle), invalid-credential responses are identical for wrong
  password vs. unknown email, failed attempts lock the account temporarily,
  and auth endpoints have their own strict per-IP rate limit.
- **CORS is closed by default**: no configured origins → the CORS plugin is
  not even registered, so no cross-origin request ever receives an allow
  header. `CORS_ORIGINS` opens an exact-match allowlist with credentials.
- Secrets (`JWT_SECRET`, `PASSWORD_PEPPER`) are required config — the app
  refuses to boot without them; there are no built-in defaults to forget to
  change.

```bash
curl -X POST http://localhost:8080/api/links \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com/very/long/path","expiresInSeconds":3600}'
```

## Design decisions

- **302, not 301.** Browsers cache 301 permanently, so subsequent visits would
  bypass the service — no click stats, no expiry enforcement. The redirect also
  sends `cache-control: no-store`.
- **Slugs are 7 chars of base58** (no `0/O/I/l` — survives being read aloud).
  58⁷ ≈ 2.2×10¹² combinations; collisions are handled by retrying inside the
  unique constraint rather than checked-then-inserted (no TOCTOU race).
- **Expiry is enforced lazily** in the redirect query (`WHERE expires_at >
  now`), with an hourly sweep for hygiene only — correctness never depends on
  the sweep having run.
- **Deletion is capability-based**: creating a link returns a random
  `deleteToken`; no accounts, no sessions, still no one else can delete your
  link.
- **Click counting is atomic** (`UPDATE ... SET clicks = clicks + 1 ...
  RETURNING`), one statement per redirect — no read-modify-write race.
- **Rate limits are two-tier**: a global per-IP ceiling plus a stricter limit
  on link creation, the only write-amplifying endpoint.
- **SQLite (WAL mode)** because a single-node shortener is read-heavy and tiny;
  the repository layer (`src/db.ts`) is the only file that would change if it
  outgrew that.
- **Metrics label routes by pattern** (`/:slug`), never raw URLs — unbounded
  label cardinality is a classic Prometheus footgun.
- **Validation is schema-first** (TypeBox): each route declares its
  body/params schema once, and both runtime validation and static types derive
  from it.

## Development

```bash
npm install
npm run dev        # tsx watch, http://localhost:8080
npm test           # vitest — unit + integration via fastify.inject()
npm run typecheck  # tsc --noEmit (strict)
npm run lint       # biome
```

Configuration is environment-driven with sane defaults: `PORT`, `HOST`,
`BASE_URL`, `DB_PATH`, `LOG_LEVEL`, `RATE_LIMIT_GLOBAL_MAX`,
`RATE_LIMIT_CREATE_MAX`, `RATE_LIMIT_WINDOW_MS`.

## Docker

```bash
docker build -t scurt .
docker run -p 8080:8080 -v scurt-data:/app/data scurt
```

Multi-stage build, production-only dependencies, runs as the unprivileged
`node` user, ships a container healthcheck.

## CI

GitHub Actions runs typecheck, lint, tests and the production build on every
push/PR, then builds the Docker image and smoke-tests it (health endpoint +
link creation) before it can merge.
