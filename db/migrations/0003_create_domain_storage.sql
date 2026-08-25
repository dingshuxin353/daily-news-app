CREATE TABLE app.daily_candidates (
  id uuid PRIMARY KEY,
  space_id uuid NOT NULL,
  publication_id text NOT NULL,
  issue_date date NOT NULL,
  client_run_id text NOT NULL,
  mode text NOT NULL,
  payload_hash character(64) NOT NULL,
  candidate_payload jsonb NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT daily_candidates_publication_fk
    FOREIGN KEY (space_id, publication_id)
    REFERENCES app.publications (space_id, publication_id)
    ON DELETE RESTRICT,
  CONSTRAINT daily_candidates_scope_id_unique
    UNIQUE (space_id, publication_id, id),
  CONSTRAINT daily_candidates_client_run_unique
    UNIQUE (space_id, publication_id, client_run_id),
  CONSTRAINT daily_candidates_client_run_format
    CHECK (client_run_id ~ '^[A-Za-z0-9._-]{8,80}$'),
  CONSTRAINT daily_candidates_mode_allowed CHECK (mode IN ('update', 'replace')),
  CONSTRAINT daily_candidates_hash_format CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT daily_candidates_payload_object CHECK (jsonb_typeof(candidate_payload) = 'object'),
  CONSTRAINT daily_candidates_payload_date_matches
    CHECK (candidate_payload ->> 'date' = issue_date::text)
);

CREATE TABLE app.daily_submission_runs (
  space_id uuid NOT NULL,
  publication_id text NOT NULL,
  client_run_id text NOT NULL,
  candidate_id uuid NOT NULL UNIQUE,
  payload_hash character(64) NOT NULL,
  result_payload jsonb NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (space_id, publication_id, client_run_id),
  CONSTRAINT daily_submission_runs_candidate_fk
    FOREIGN KEY (space_id, publication_id, candidate_id)
    REFERENCES app.daily_candidates (space_id, publication_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT daily_submission_runs_hash_format CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT daily_submission_runs_result_object CHECK (jsonb_typeof(result_payload) = 'object')
);

CREATE TABLE app.issues (
  space_id uuid NOT NULL,
  publication_id text NOT NULL,
  issue_date date NOT NULL,
  revision integer NOT NULL,
  issue_payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (space_id, publication_id, issue_date),
  CONSTRAINT issues_publication_fk
    FOREIGN KEY (space_id, publication_id)
    REFERENCES app.publications (space_id, publication_id)
    ON DELETE RESTRICT,
  CONSTRAINT issues_revision_positive CHECK (revision >= 1),
  CONSTRAINT issues_payload_object CHECK (jsonb_typeof(issue_payload) = 'object'),
  CONSTRAINT issues_payload_date_matches CHECK (issue_payload ->> 'date' = issue_date::text),
  CONSTRAINT issues_payload_revision_matches
    CHECK ((issue_payload ->> 'revision') ~ '^\d+$' AND (issue_payload ->> 'revision')::integer = revision)
);

CREATE TABLE app.compiled_editions (
  space_id uuid NOT NULL,
  publication_id text NOT NULL,
  issue_date date NOT NULL,
  revision integer NOT NULL,
  compiled_payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (space_id, publication_id, issue_date),
  CONSTRAINT compiled_editions_issue_fk
    FOREIGN KEY (space_id, publication_id, issue_date)
    REFERENCES app.issues (space_id, publication_id, issue_date)
    ON DELETE RESTRICT,
  CONSTRAINT compiled_editions_revision_positive CHECK (revision >= 1),
  CONSTRAINT compiled_editions_payload_object CHECK (jsonb_typeof(compiled_payload) = 'object'),
  CONSTRAINT compiled_editions_payload_date_matches
    CHECK (compiled_payload ->> 'date' = issue_date::text),
  CONSTRAINT compiled_editions_payload_revision_matches
    CHECK ((compiled_payload ->> 'revision') ~ '^\d+$' AND (compiled_payload ->> 'revision')::integer = revision)
);

CREATE TABLE app.publication_date_locks (
  space_id uuid NOT NULL,
  publication_id text NOT NULL,
  issue_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (space_id, publication_id, issue_date),
  CONSTRAINT publication_date_locks_publication_fk
    FOREIGN KEY (space_id, publication_id)
    REFERENCES app.publications (space_id, publication_id)
    ON DELETE RESTRICT
);

CREATE TABLE app.todo_states (
  space_id uuid PRIMARY KEY,
  revision integer NOT NULL,
  state_payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT todo_states_profile_fk
    FOREIGN KEY (space_id) REFERENCES app.todo_profiles (space_id) ON DELETE RESTRICT,
  CONSTRAINT todo_states_revision_non_negative CHECK (revision >= 0),
  CONSTRAINT todo_states_payload_object CHECK (jsonb_typeof(state_payload) = 'object'),
  CONSTRAINT todo_states_payload_revision_matches
    CHECK ((state_payload ->> 'revision') ~ '^\d+$' AND (state_payload ->> 'revision')::integer = revision)
);

CREATE TABLE app.todo_submission_runs (
  space_id uuid NOT NULL,
  candidate_id text NOT NULL,
  payload_hash character(64) NOT NULL,
  candidate_payload jsonb NOT NULL,
  result_payload jsonb NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (space_id, candidate_id),
  CONSTRAINT todo_submission_runs_profile_fk
    FOREIGN KEY (space_id) REFERENCES app.todo_profiles (space_id) ON DELETE RESTRICT,
  CONSTRAINT todo_submission_runs_candidate_id_format
    CHECK (candidate_id ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CONSTRAINT todo_submission_runs_hash_format CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT todo_submission_runs_candidate_object CHECK (jsonb_typeof(candidate_payload) = 'object'),
  CONSTRAINT todo_submission_runs_result_object CHECK (jsonb_typeof(result_payload) = 'object')
);

CREATE TABLE app.theme_definitions (
  space_id uuid NOT NULL,
  theme_id text NOT NULL,
  revision integer NOT NULL,
  definition_payload jsonb NOT NULL,
  compiled_css text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (space_id, theme_id, revision),
  CONSTRAINT theme_definitions_space_fk
    FOREIGN KEY (space_id) REFERENCES app.spaces (id) ON DELETE RESTRICT,
  CONSTRAINT theme_definitions_theme_id_format
    CHECK (theme_id ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CONSTRAINT theme_definitions_revision_positive CHECK (revision >= 1),
  CONSTRAINT theme_definitions_payload_object CHECK (jsonb_typeof(definition_payload) = 'object'),
  CONSTRAINT theme_definitions_payload_identity_matches CHECK (
    definition_payload ->> 'id' = theme_id
    AND (definition_payload ->> 'revision') ~ '^\d+$'
    AND (definition_payload ->> 'revision')::integer = revision
  ),
  CONSTRAINT theme_definitions_css_not_blank CHECK (btrim(compiled_css) <> '')
);

CREATE TABLE app.theme_candidates (
  space_id uuid NOT NULL,
  theme_id text NOT NULL,
  candidate_hash character(64) NOT NULL,
  input_hash character(64) NOT NULL,
  manifest_payload jsonb NOT NULL,
  compiled_css text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (space_id, theme_id),
  CONSTRAINT theme_candidates_space_fk
    FOREIGN KEY (space_id) REFERENCES app.spaces (id) ON DELETE RESTRICT,
  CONSTRAINT theme_candidates_theme_id_format
    CHECK (theme_id ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CONSTRAINT theme_candidates_candidate_hash_format CHECK (candidate_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT theme_candidates_input_hash_format CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT theme_candidates_manifest_object CHECK (jsonb_typeof(manifest_payload) = 'object'),
  CONSTRAINT theme_candidates_manifest_identity_matches
    CHECK (manifest_payload ->> 'themeId' = theme_id),
  CONSTRAINT theme_candidates_css_not_blank CHECK (btrim(compiled_css) <> '')
);

ALTER TABLE app.theme_selections
  ADD COLUMN active_payload jsonb;

ALTER TABLE app.theme_selections
  ADD CONSTRAINT theme_selections_active_payload_object
  CHECK (active_payload IS NULL OR jsonb_typeof(active_payload) = 'object');

COMMENT ON TABLE app.daily_candidates IS 'Accepted Content Candidate payloads scoped to one Publication';
COMMENT ON TABLE app.daily_submission_runs IS 'Daily idempotency results keyed inside one Publication';
COMMENT ON TABLE app.issues IS 'Current formal DailyNews Issue per Publication date';
COMMENT ON TABLE app.compiled_editions IS 'Deterministic compiled edition paired with a formal Issue';
COMMENT ON TABLE app.publication_date_locks IS 'Stable PostgreSQL row locks for Publication dates without an Issue';
COMMENT ON TABLE app.todo_states IS 'Current Personal Todo state per Space';
COMMENT ON TABLE app.todo_submission_runs IS 'Todo Candidate and idempotency result per Space';
COMMENT ON TABLE app.theme_definitions IS 'Space-scoped custom Theme revisions and compiled CSS';
COMMENT ON TABLE app.theme_candidates IS 'Latest Space-scoped Theme preview fact';
