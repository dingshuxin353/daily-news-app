CREATE TABLE app.agent_credentials (
  id uuid PRIMARY KEY,
  space_id uuid NOT NULL,
  name text NOT NULL,
  selector text NOT NULL UNIQUE,
  secret_digest character(64) NOT NULL,
  token_hint text NOT NULL,
  issue_operation_id uuid NOT NULL,
  issue_payload_hash character(64) NOT NULL,
  status text NOT NULL,
  rotated_from_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT agent_credentials_space_fk
    FOREIGN KEY (space_id) REFERENCES app.spaces (id) ON DELETE RESTRICT,
  CONSTRAINT agent_credentials_rotated_from_fk
    FOREIGN KEY (rotated_from_id) REFERENCES app.agent_credentials (id) ON DELETE RESTRICT,
  CONSTRAINT agent_credentials_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT agent_credentials_name_length CHECK (char_length(name) <= 80),
  CONSTRAINT agent_credentials_name_no_controls CHECK (name !~ '[[:cntrl:]]'),
  CONSTRAINT agent_credentials_selector_format CHECK (selector ~ '^[A-Za-z0-9_-]{22}$'),
  CONSTRAINT agent_credentials_secret_digest_format CHECK (secret_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT agent_credentials_token_hint_length CHECK (char_length(token_hint) BETWEEN 8 AND 64),
  CONSTRAINT agent_credentials_issue_payload_hash_format CHECK (issue_payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT agent_credentials_status_allowed CHECK (status IN ('active', 'rotated', 'revoked')),
  CONSTRAINT agent_credentials_lifecycle_consistent CHECK (
    (status = 'active' AND revoked_at IS NULL)
    OR (status IN ('rotated', 'revoked') AND revoked_at IS NOT NULL)
  ),
  CONSTRAINT agent_credentials_not_self_rotated CHECK (rotated_from_id IS NULL OR rotated_from_id <> id),
  CONSTRAINT agent_credentials_space_operation_unique UNIQUE (space_id, issue_operation_id)
);

CREATE INDEX agent_credentials_space_status_idx
  ON app.agent_credentials (space_id, status, created_at DESC);

CREATE TABLE app.agent_rate_limit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key_digest character(64) NOT NULL,
  action text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT agent_rate_limit_events_key_format CHECK (key_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT agent_rate_limit_events_action_allowed
    CHECK (action IN ('api_read_token', 'api_read_ip', 'api_write_token', 'api_write_ip'))
);

CREATE INDEX agent_rate_limit_events_lookup_idx
  ON app.agent_rate_limit_events (action, key_digest, created_at DESC);
CREATE INDEX agent_rate_limit_events_created_idx
  ON app.agent_rate_limit_events (created_at);

CREATE TABLE app.audit_events (
  id uuid PRIMARY KEY,
  space_id uuid,
  actor_digest character(64) NOT NULL,
  event_type text NOT NULL,
  target_type text NOT NULL,
  target_id text,
  result text NOT NULL,
  request_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT audit_events_space_fk
    FOREIGN KEY (space_id) REFERENCES app.spaces (id) ON DELETE RESTRICT,
  CONSTRAINT audit_events_actor_digest_format CHECK (actor_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT audit_events_event_type_not_blank CHECK (btrim(event_type) <> ''),
  CONSTRAINT audit_events_target_type_not_blank CHECK (btrim(target_type) <> ''),
  CONSTRAINT audit_events_result_not_blank CHECK (btrim(result) <> ''),
  CONSTRAINT audit_events_request_id_not_blank CHECK (btrim(request_id) <> ''),
  CONSTRAINT audit_events_text_length CHECK (
    char_length(event_type) <= 80
    AND char_length(target_type) <= 40
    AND (target_id IS NULL OR char_length(target_id) <= 128)
    AND char_length(result) <= 40
    AND char_length(request_id) <= 128
  )
);

CREATE INDEX audit_events_space_created_idx
  ON app.audit_events (space_id, created_at DESC);
CREATE INDEX audit_events_type_created_idx
  ON app.audit_events (event_type, created_at DESC);
CREATE INDEX audit_events_created_idx
  ON app.audit_events (created_at);

COMMENT ON TABLE app.agent_credentials IS 'Digest-only Agent Tokens and their lifecycle';
COMMENT ON TABLE app.agent_rate_limit_events IS 'Persistent digest-keyed Agent request rate limits';
COMMENT ON TABLE app.audit_events IS 'Minimal redacted security and write audit facts';
