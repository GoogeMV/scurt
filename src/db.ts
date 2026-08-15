import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  target_url TEXT NOT NULL,
  delete_token TEXT NOT NULL,
  clicks INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  last_access_at INTEGER,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS links_expires ON links (expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  family TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS refresh_tokens_family ON refresh_tokens (family);
`;

export function openDatabase(dbPath: string): Database.Database {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  // Migration for databases created before accounts existed. Must run before
  // any index that references the new column.
  const cols = db.pragma("table_info(links)") as { name: string }[];
  if (!cols.some((c) => c.name === "user_id")) {
    db.exec("ALTER TABLE links ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL");
  }
  db.exec("CREATE INDEX IF NOT EXISTS links_user ON links (user_id) WHERE user_id IS NOT NULL");
  return db;
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------- links

export interface Link {
  slug: string;
  targetUrl: string;
  clicks: number;
  createdAt: number;
  expiresAt: number | null;
  lastAccessAt: number | null;
  userId: number | null;
}

interface LinkRow {
  slug: string;
  target_url: string;
  delete_token: string;
  clicks: number;
  created_at: number;
  expires_at: number | null;
  last_access_at: number | null;
  user_id: number | null;
}

function toLink(row: LinkRow): Link {
  return {
    slug: row.slug,
    targetUrl: row.target_url,
    clicks: row.clicks,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastAccessAt: row.last_access_at,
    userId: row.user_id,
  };
}

export class LinkRepository {
  constructor(private readonly db: Database.Database) {}

  /** @throws with SQLITE_CONSTRAINT_UNIQUE code when the slug is taken. */
  create(input: {
    slug: string;
    targetUrl: string;
    deleteToken: string;
    expiresAt: number | null;
    userId: number | null;
  }): Link {
    const createdAt = now();
    this.db
      .prepare(
        `INSERT INTO links (slug, target_url, delete_token, created_at, expires_at, user_id)
         VALUES (@slug, @targetUrl, @deleteToken, @createdAt, @expiresAt, @userId)`,
      )
      .run({ ...input, createdAt });
    return {
      slug: input.slug,
      targetUrl: input.targetUrl,
      clicks: 0,
      createdAt,
      expiresAt: input.expiresAt,
      lastAccessAt: null,
      userId: input.userId,
    };
  }

  /**
   * Resolves a slug for redirecting: atomically bumps the click counter and
   * returns the target, or null when the slug is unknown or expired.
   * Expiry is enforced here (lazily) and by the periodic sweep.
   */
  resolveAndTrack(slug: string): string | null {
    const row = this.db
      .prepare(
        `UPDATE links SET clicks = clicks + 1, last_access_at = @now
         WHERE slug = @slug AND (expires_at IS NULL OR expires_at > @now)
         RETURNING target_url`,
      )
      .get({ slug, now: now() }) as { target_url: string } | undefined;
    return row?.target_url ?? null;
  }

  getBySlug(slug: string): Link | null {
    const row = this.db.prepare("SELECT * FROM links WHERE slug = ?").get(slug) as
      | LinkRow
      | undefined;
    return row ? toLink(row) : null;
  }

  listByUser(userId: number): Link[] {
    const rows = this.db
      .prepare("SELECT * FROM links WHERE user_id = ? ORDER BY created_at DESC")
      .all(userId) as LinkRow[];
    return rows.map(toLink);
  }

  /** Returns "deleted" | "forbidden" | "not_found". Owners skip the token check. */
  deleteBySlug(
    slug: string,
    auth: { deleteToken?: string; userId?: number },
  ): "deleted" | "forbidden" | "not_found" {
    const row = this.db
      .prepare("SELECT delete_token, user_id FROM links WHERE slug = ?")
      .get(slug) as { delete_token: string; user_id: number | null } | undefined;
    if (!row) return "not_found";
    const isOwner = auth.userId !== undefined && row.user_id === auth.userId;
    const hasToken = auth.deleteToken !== undefined && row.delete_token === auth.deleteToken;
    if (!isOwner && !hasToken) return "forbidden";
    this.db.prepare("DELETE FROM links WHERE slug = ?").run(slug);
    return "deleted";
  }

  /** Removes expired rows; returns how many were deleted. */
  sweepExpired(): number {
    return this.db
      .prepare("DELETE FROM links WHERE expires_at IS NOT NULL AND expires_at <= ?")
      .run(now()).changes;
  }

  countLinks(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM links").get() as { n: number }).n;
  }

  /** Cheap connectivity check for the health endpoint. */
  ping(): boolean {
    return this.db.prepare("SELECT 1 AS ok").get() !== undefined;
  }
}

// ---------------------------------------------------------------- auth

export interface User {
  id: number;
  email: string;
  passwordHash: string;
  createdAt: number;
  failedLogins: number;
  lockedUntil: number | null;
}

interface UserRow {
  id: number;
  email: string;
  password_hash: string;
  created_at: number;
  failed_logins: number;
  locked_until: number | null;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
    failedLogins: row.failed_logins,
    lockedUntil: row.locked_until,
  };
}

export interface RefreshTokenRecord {
  id: number;
  userId: number;
  family: string;
  expiresAt: number;
  revokedAt: number | null;
}

export class AuthRepository {
  constructor(private readonly db: Database.Database) {}

  /** @throws with SQLITE_CONSTRAINT_UNIQUE code when the email is taken. */
  createUser(email: string, passwordHash: string): User {
    const createdAt = now();
    const result = this.db
      .prepare("INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)")
      .run(email, passwordHash, createdAt);
    return {
      id: result.lastInsertRowid as number,
      email,
      passwordHash,
      createdAt,
      failedLogins: 0,
      lockedUntil: null,
    };
  }

  findUserByEmail(email: string): User | null {
    const row = this.db.prepare("SELECT * FROM users WHERE email = ?").get(email) as
      | UserRow
      | undefined;
    return row ? toUser(row) : null;
  }

  findUserById(id: number): User | null {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
    return row ? toUser(row) : null;
  }

  /**
   * Records a failed login; once the threshold is reached the account locks
   * for `lockoutSeconds`. Returns the lock expiry, if now locked.
   */
  recordLoginFailure(userId: number, threshold: number, lockoutSeconds: number): number | null {
    const row = this.db
      .prepare(
        "UPDATE users SET failed_logins = failed_logins + 1 WHERE id = ? RETURNING failed_logins",
      )
      .get(userId) as { failed_logins: number } | undefined;
    if (!row) return null;
    if (row.failed_logins >= threshold) {
      const lockedUntil = now() + lockoutSeconds;
      this.db
        .prepare("UPDATE users SET locked_until = ?, failed_logins = 0 WHERE id = ?")
        .run(lockedUntil, userId);
      return lockedUntil;
    }
    return null;
  }

  resetLoginFailures(userId: number): void {
    this.db
      .prepare("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?")
      .run(userId);
  }

  createRefreshToken(input: {
    userId: number;
    tokenHash: string;
    family: string;
    expiresAt: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO refresh_tokens (user_id, token_hash, family, created_at, expires_at)
         VALUES (@userId, @tokenHash, @family, @createdAt, @expiresAt)`,
      )
      .run({ ...input, createdAt: now() });
  }

  findRefreshToken(tokenHash: string): RefreshTokenRecord | null {
    const row = this.db
      .prepare(
        "SELECT id, user_id, family, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = ?",
      )
      .get(tokenHash) as
      | {
          id: number;
          user_id: number;
          family: string;
          expires_at: number;
          revoked_at: number | null;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      userId: row.user_id,
      family: row.family,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
    };
  }

  revokeToken(id: number): void {
    this.db
      .prepare("UPDATE refresh_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(now(), id);
  }

  revokeFamily(family: string): void {
    this.db
      .prepare("UPDATE refresh_tokens SET revoked_at = ? WHERE family = ? AND revoked_at IS NULL")
      .run(now(), family);
  }

  countUsers(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
  }

  /** Deletes expired/revoked rows past their window; returns how many. */
  sweepTokens(): number {
    return this.db.prepare("DELETE FROM refresh_tokens WHERE expires_at <= ?").run(now()).changes;
  }
}
