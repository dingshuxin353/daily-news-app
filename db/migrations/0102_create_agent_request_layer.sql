ALTER TABLE app.agent_rate_limit_events
  DROP CONSTRAINT agent_rate_limit_events_action_allowed;

ALTER TABLE app.agent_rate_limit_events
  ADD CONSTRAINT agent_rate_limit_events_action_allowed
  CHECK (action IN ('pairing_claim', 'pairing_verify', 'api_read_token', 'api_read_ip', 'api_write_token', 'api_write_ip'));

CREATE TABLE app.agent_write_leases (
  id uuid PRIMARY KEY,
  space_id uuid NOT NULL,
  credential_id uuid NOT NULL,
  request_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT agent_write_leases_space_fk
    FOREIGN KEY (space_id) REFERENCES app.spaces (id) ON DELETE RESTRICT,
  CONSTRAINT agent_write_leases_credential_fk
    FOREIGN KEY (credential_id) REFERENCES app.agent_credentials (id) ON DELETE RESTRICT,
  CONSTRAINT agent_write_leases_request_not_blank CHECK (btrim(request_id) <> ''),
  CONSTRAINT agent_write_leases_expiry_after_creation CHECK (expires_at > created_at)
);

CREATE INDEX agent_write_leases_space_expiry_idx
  ON app.agent_write_leases (space_id, expires_at);

ALTER TABLE app.todo_submission_runs
  ADD COLUMN client_run_id text;

UPDATE app.todo_submission_runs
SET client_run_id = 'legacy-' || md5(space_id::text || ':' || candidate_id);

ALTER TABLE app.todo_submission_runs
  ALTER COLUMN client_run_id SET NOT NULL;

ALTER TABLE app.todo_submission_runs
  DROP CONSTRAINT todo_submission_runs_pkey;

ALTER TABLE app.todo_submission_runs
  ADD CONSTRAINT todo_submission_runs_pkey PRIMARY KEY (space_id, client_run_id);

ALTER TABLE app.todo_submission_runs
  ADD CONSTRAINT todo_submission_runs_candidate_unique UNIQUE (space_id, candidate_id);

ALTER TABLE app.todo_submission_runs
  ADD CONSTRAINT todo_submission_runs_client_run_format
  CHECK (client_run_id ~ '^[A-Za-z0-9._-]{8,80}$');

COMMENT ON TABLE app.agent_write_leases IS 'Short-lived cross-process leases enforcing per-Space Agent write concurrency';
COMMENT ON COLUMN app.todo_submission_runs.client_run_id IS 'Protocol-level idempotency key shared by JSON API and MCP';
