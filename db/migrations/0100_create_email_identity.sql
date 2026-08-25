CREATE SCHEMA auth;
SET LOCAL search_path TO auth;

CREATE TABLE "user" (
  "id" text NOT NULL PRIMARY KEY,
  "name" text NOT NULL,
  "email" text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL,
  "image" text,
  "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE "session" (
  "id" text NOT NULL PRIMARY KEY,
  "expiresAt" timestamptz NOT NULL,
  "token" text NOT NULL UNIQUE,
  "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamptz NOT NULL,
  "ipAddress" text,
  "userAgent" text,
  "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
);

CREATE TABLE "account" (
  "id" text NOT NULL PRIMARY KEY,
  "issuer" text NOT NULL,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  "scope" text,
  "password" text,
  "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamptz NOT NULL
);

CREATE TABLE "verification" (
  "id" text NOT NULL PRIMARY KEY,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE "rateLimit" (
  "id" text NOT NULL PRIMARY KEY,
  "key" text NOT NULL UNIQUE,
  "count" integer NOT NULL,
  "lastRequest" bigint NOT NULL
);

CREATE INDEX "session_userId_idx" ON "session" ("userId");
CREATE INDEX "account_userId_idx" ON "account" ("userId");
CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");
CREATE UNIQUE INDEX "account_issuer_accountId_uidx" ON "account" ("issuer", "accountId");

CREATE TABLE app.login_rate_locks (
  key text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT login_rate_locks_key_not_blank CHECK (btrim(key) <> '')
);

CREATE TABLE app.login_send_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_hash character(64) NOT NULL,
  ip_hash character(64) NOT NULL,
  status text NOT NULL DEFAULT 'reserved',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CONSTRAINT login_send_attempts_email_hash_format CHECK (email_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT login_send_attempts_ip_hash_format CHECK (ip_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT login_send_attempts_status_allowed CHECK (status IN ('reserved', 'sent', 'failed')),
  CONSTRAINT login_send_attempts_completion_consistent CHECK (
    (status = 'reserved' AND completed_at IS NULL)
    OR (status IN ('sent', 'failed') AND completed_at IS NOT NULL)
  )
);

CREATE INDEX login_send_attempts_email_created_idx
  ON app.login_send_attempts (email_hash, created_at DESC);
CREATE INDEX login_send_attempts_ip_created_idx
  ON app.login_send_attempts (ip_hash, created_at DESC);
CREATE INDEX login_send_attempts_created_idx
  ON app.login_send_attempts (created_at DESC);

CREATE TABLE app.login_mail_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL UNIQUE,
  recipient_hash character(64) NOT NULL,
  provider_request_id text NOT NULL UNIQUE,
  provider_message_id text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT login_mail_deliveries_attempt_fk
    FOREIGN KEY (attempt_id) REFERENCES app.login_send_attempts (id) ON DELETE RESTRICT,
  CONSTRAINT login_mail_deliveries_recipient_hash_format CHECK (recipient_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT login_mail_deliveries_request_id_not_blank CHECK (btrim(provider_request_id) <> ''),
  CONSTRAINT login_mail_deliveries_message_id_not_blank CHECK (btrim(provider_message_id) <> '')
);

COMMENT ON SCHEMA auth IS 'Better Auth 1.7.1 managed identity data';
COMMENT ON TABLE auth."user" IS 'Better Auth user records';
COMMENT ON TABLE auth."session" IS 'Better Auth persistent sessions';
COMMENT ON TABLE auth."account" IS 'Better Auth identity accounts';
COMMENT ON TABLE auth."verification" IS 'Better Auth hashed OTP verification records';
COMMENT ON TABLE auth."rateLimit" IS 'Better Auth database-backed request limits';
COMMENT ON TABLE app.login_rate_locks IS 'Concurrency locks for email delivery limits';
COMMENT ON TABLE app.login_send_attempts IS 'Digest-only login email send reservations and results';
COMMENT ON TABLE app.login_mail_deliveries IS 'Provider delivery identifiers without recipient addresses';
