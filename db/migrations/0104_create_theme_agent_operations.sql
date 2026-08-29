CREATE TABLE app.theme_operation_runs (
  space_id uuid NOT NULL,
  client_run_id text NOT NULL,
  operation text NOT NULL,
  theme_id text NOT NULL,
  payload_hash character(64) NOT NULL,
  result_payload jsonb NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (space_id, client_run_id),
  CONSTRAINT theme_operation_runs_space_fk
    FOREIGN KEY (space_id) REFERENCES app.spaces (id) ON DELETE RESTRICT,
  CONSTRAINT theme_operation_runs_client_run_format
    CHECK (client_run_id ~ '^[A-Za-z0-9._-]{8,80}$'),
  CONSTRAINT theme_operation_runs_operation_allowed
    CHECK (operation IN ('create', 'update', 'delete')),
  CONSTRAINT theme_operation_runs_theme_id_format
    CHECK (theme_id ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CONSTRAINT theme_operation_runs_hash_format
    CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT theme_operation_runs_result_object
    CHECK (jsonb_typeof(result_payload) = 'object')
);

COMMENT ON TABLE app.theme_operation_runs IS
  'Cross-protocol idempotency results for Agent-managed custom Theme mutations';
