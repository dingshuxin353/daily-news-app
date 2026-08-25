CREATE TABLE app.spaces (
  id uuid PRIMARY KEY,
  user_id text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'initializing',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT spaces_user_id_not_blank CHECK (btrim(user_id) <> ''),
  CONSTRAINT spaces_user_id_length CHECK (char_length(user_id) <= 512),
  CONSTRAINT spaces_status_allowed CHECK (status IN ('initializing', 'ready'))
);

CREATE TABLE app.home_profiles (
  space_id uuid PRIMARY KEY,
  display_name text NOT NULL,
  time_zone text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT home_profiles_space_fk
    FOREIGN KEY (space_id) REFERENCES app.spaces (id) ON DELETE RESTRICT,
  CONSTRAINT home_profiles_display_name_not_blank CHECK (btrim(display_name) <> ''),
  CONSTRAINT home_profiles_time_zone_not_blank CHECK (btrim(time_zone) <> '')
);

CREATE TABLE app.publications (
  space_id uuid NOT NULL,
  publication_id text NOT NULL,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  is_default boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (space_id, publication_id),
  CONSTRAINT publications_space_fk
    FOREIGN KEY (space_id) REFERENCES app.spaces (id) ON DELETE RESTRICT,
  CONSTRAINT publications_id_format
    CHECK (publication_id ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CONSTRAINT publications_display_name_not_blank CHECK (btrim(display_name) <> ''),
  CONSTRAINT publications_status_allowed CHECK (status IN ('active', 'inactive')),
  CONSTRAINT publications_sort_order_non_negative CHECK (sort_order >= 0),
  CONSTRAINT publications_space_sort_order_unique UNIQUE (space_id, sort_order)
);

CREATE UNIQUE INDEX publications_one_default_per_space
  ON app.publications (space_id)
  WHERE is_default;

CREATE TABLE app.publication_configs (
  space_id uuid NOT NULL,
  publication_id text NOT NULL,
  time_zone text NOT NULL,
  priority_limits jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (space_id, publication_id),
  CONSTRAINT publication_configs_publication_fk
    FOREIGN KEY (space_id, publication_id)
    REFERENCES app.publications (space_id, publication_id)
    ON DELETE RESTRICT,
  CONSTRAINT publication_configs_time_zone_not_blank CHECK (btrim(time_zone) <> ''),
  CONSTRAINT publication_configs_priority_limits_shape CHECK (
    jsonb_typeof(priority_limits) = 'object'
    AND priority_limits ?& ARRAY['lead', 'important', 'normal']
    AND priority_limits - ARRAY['lead', 'important', 'normal'] = '{}'::jsonb
    AND jsonb_typeof(priority_limits -> 'lead') = 'number'
    AND (priority_limits ->> 'lead') ~ '^\d+$'
    AND jsonb_typeof(priority_limits -> 'important') = 'number'
    AND (priority_limits ->> 'important') ~ '^\d+$'
    AND (
      jsonb_typeof(priority_limits -> 'normal') = 'null'
      OR (
        jsonb_typeof(priority_limits -> 'normal') = 'number'
        AND (priority_limits ->> 'normal') ~ '^\d+$'
      )
    )
  )
);

CREATE TABLE app.theme_selections (
  id uuid PRIMARY KEY,
  space_id uuid NOT NULL,
  target_type text NOT NULL,
  publication_id text,
  selection_mode text NOT NULL,
  theme_id text,
  theme_revision integer,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT theme_selections_space_fk
    FOREIGN KEY (space_id) REFERENCES app.spaces (id) ON DELETE RESTRICT,
  CONSTRAINT theme_selections_publication_fk
    FOREIGN KEY (space_id, publication_id)
    REFERENCES app.publications (space_id, publication_id)
    ON DELETE RESTRICT,
  CONSTRAINT theme_selections_target_allowed CHECK (
    (
      target_type = 'home'
      AND publication_id IS NULL
      AND selection_mode = 'override'
      AND theme_id IS NOT NULL
      AND theme_revision IS NOT NULL
    )
    OR
    (
      target_type = 'publication'
      AND publication_id IS NOT NULL
      AND (
        (selection_mode = 'inherit' AND theme_id IS NULL AND theme_revision IS NULL)
        OR
        (selection_mode = 'override' AND theme_id IS NOT NULL AND theme_revision IS NOT NULL)
      )
    )
  ),
  CONSTRAINT theme_selections_theme_id_not_blank
    CHECK (theme_id IS NULL OR btrim(theme_id) <> ''),
  CONSTRAINT theme_selections_theme_id_format
    CHECK (theme_id IS NULL OR theme_id ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CONSTRAINT theme_selections_theme_revision_positive
    CHECK (theme_revision IS NULL OR theme_revision > 0)
);

CREATE UNIQUE INDEX theme_selections_one_home_per_space
  ON app.theme_selections (space_id)
  WHERE target_type = 'home';

CREATE UNIQUE INDEX theme_selections_one_per_publication
  ON app.theme_selections (space_id, publication_id)
  WHERE target_type = 'publication';

CREATE TABLE app.todo_profiles (
  space_id uuid PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT todo_profiles_space_fk
    FOREIGN KEY (space_id) REFERENCES app.spaces (id) ON DELETE RESTRICT
);

COMMENT ON TABLE app.spaces IS 'One private DailyNews tenant per authenticated user';
COMMENT ON TABLE app.home_profiles IS 'Space-scoped Home defaults';
COMMENT ON TABLE app.publications IS 'Space-scoped publication registry';
COMMENT ON TABLE app.publication_configs IS 'Space and publication constrained DailyNews configuration';
COMMENT ON TABLE app.theme_selections IS 'Current Home and publication theme selection';
COMMENT ON TABLE app.todo_profiles IS 'Space-scoped Personal Todo enablement';
