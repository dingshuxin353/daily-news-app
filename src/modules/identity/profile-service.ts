import type { PostgresPool } from "../../adapters/postgres/pool.js";

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

export type ProfileErrorCode = "PROFILE_INPUT_INVALID" | "PROFILE_TARGET_NOT_FOUND" | "PROFILE_STORAGE_FAILED";

export class ProfileError extends Error {
  constructor(readonly code: ProfileErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProfileError";
  }
}

export interface UserProfile {
  userId: string;
  email: string;
  nickname: string | null;
  complete: boolean;
}

interface IdentityRow {
  id: string;
  name: string;
  email: string;
  nickname: string | null;
  completed_at: Date | null;
}

export function normalizeNickname(value: unknown): string {
  if (typeof value !== "string") {
    throw new ProfileError("PROFILE_INPUT_INVALID", "nickname must be a string");
  }
  const normalized = value.trim();
  if (normalized.length < 1 || [...normalized].length > 24 || CONTROL.test(normalized)) {
    throw new ProfileError("PROFILE_INPUT_INVALID", "nickname is invalid");
  }
  return normalized;
}

function reusableIdentityName(name: string, email: string): string | null {
  try {
    const normalized = normalizeNickname(name);
    return normalized.localeCompare(email, undefined, { sensitivity: "accent" }) === 0 ? null : normalized;
  } catch {
    return null;
  }
}

export class UserProfileService {
  constructor(private readonly pool: PostgresPool) {}

  async read(userId: string): Promise<UserProfile | null> {
    if (typeof userId !== "string" || userId.trim() === "") {
      throw new ProfileError("PROFILE_INPUT_INVALID", "user id is invalid");
    }
    const result = await this.pool.query<IdentityRow & import("pg").QueryResultRow>(
      `SELECT identity."id" AS id,
              identity."name" AS name,
              identity."email" AS email,
              profile.nickname,
              profile.completed_at
       FROM auth."user" AS identity
       LEFT JOIN app.user_profiles AS profile ON profile.user_id = identity."id"
       WHERE identity."id" = $1`,
      [userId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const nickname = row.nickname ?? reusableIdentityName(row.name, row.email);
    return {
      userId: row.id,
      email: row.email,
      nickname,
      complete: nickname !== null,
    };
  }

  async setNickname(userId: string, value: unknown): Promise<UserProfile> {
    if (typeof userId !== "string" || userId.trim() === "") {
      throw new ProfileError("PROFILE_INPUT_INVALID", "user id is invalid");
    }
    const nickname = normalizeNickname(value);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const identity = await client.query<{ email: string } & import("pg").QueryResultRow>(
        `SELECT "email" AS email FROM auth."user" WHERE "id" = $1 FOR UPDATE`,
        [userId],
      );
      if (!identity.rows[0]) {
        throw new ProfileError("PROFILE_TARGET_NOT_FOUND", "user profile is unavailable");
      }
      await client.query(
        `INSERT INTO app.user_profiles (user_id, nickname, completed_at)
         VALUES ($1, $2, clock_timestamp())
         ON CONFLICT (user_id) DO UPDATE
           SET nickname = EXCLUDED.nickname,
               completed_at = clock_timestamp(),
               updated_at = clock_timestamp()`,
        [userId, nickname],
      );
      await client.query(
        `UPDATE auth."user" SET "name" = $2, "updatedAt" = clock_timestamp() WHERE "id" = $1`,
        [userId, nickname],
      );
      await client.query("COMMIT");
      return { userId, email: identity.rows[0].email, nickname, complete: true };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      if (error instanceof ProfileError) throw error;
      throw new ProfileError("PROFILE_STORAGE_FAILED", "profile update failed", { cause: error });
    } finally {
      client.release();
    }
  }
}
