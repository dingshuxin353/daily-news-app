CREATE TABLE app.user_profiles (
  user_id text PRIMARY KEY,
  nickname text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT user_profiles_user_fk
    FOREIGN KEY (user_id) REFERENCES auth."user" ("id") ON DELETE CASCADE,
  CONSTRAINT user_profiles_nickname_state CHECK (
    (
      nickname IS NULL
      AND completed_at IS NULL
    )
    OR
    (
      nickname IS NOT NULL
      AND nickname = btrim(nickname)
      AND char_length(nickname) BETWEEN 1 AND 24
      AND nickname !~ '[[:cntrl:]]'
      AND completed_at IS NOT NULL
    )
  )
);

UPDATE app.home_profiles
SET display_name = CASE
  WHEN btrim(regexp_replace(display_name, '[[:cntrl:]]', ' ', 'g')) = '' THEN '我的日报'
  ELSE left(btrim(regexp_replace(display_name, '[[:cntrl:]]', ' ', 'g')), 40)
END;

ALTER TABLE app.home_profiles
  ADD CONSTRAINT home_profiles_display_name_length
  CHECK (char_length(display_name) BETWEEN 1 AND 40);

ALTER TABLE app.home_profiles
  ADD CONSTRAINT home_profiles_display_name_trimmed
  CHECK (display_name = btrim(display_name));

DROP INDEX app.publications_one_default_per_space;

ALTER TABLE app.publications
  DROP CONSTRAINT publications_space_sort_order_unique;

CREATE TEMP TABLE m4_publication_names ON COMMIT DROP AS
SELECT space_id,
       publication_id,
       status,
       sort_order,
       CASE
         WHEN btrim(regexp_replace(display_name, '[[:cntrl:]]', ' ', 'g')) = ''
         THEN left(publication_id, 40)
         ELSE left(btrim(regexp_replace(display_name, '[[:cntrl:]]', ' ', 'g')), 40)
       END AS base_name,
       NULL::text AS final_name
FROM app.publications;

DO $$
DECLARE
  entry record;
  candidate text;
  suffix text;
  attempt integer;
BEGIN
  FOR entry IN
    SELECT space_id, publication_id, base_name
    FROM m4_publication_names
    ORDER BY space_id, status = 'inactive', sort_order NULLS LAST, publication_id
  LOOP
    candidate := entry.base_name;
    attempt := 1;
    WHILE EXISTS (
      SELECT 1
      FROM m4_publication_names
      WHERE space_id = entry.space_id
        AND final_name IS NOT NULL
        AND lower(final_name) = lower(candidate)
    ) LOOP
      attempt := attempt + 1;
      suffix := format(' (%s)', attempt);
      candidate := left(entry.base_name, 40 - char_length(suffix)) || suffix;
    END LOOP;
    UPDATE m4_publication_names
    SET final_name = candidate
    WHERE space_id = entry.space_id AND publication_id = entry.publication_id;
  END LOOP;
END
$$;

UPDATE app.publications AS publication
SET display_name = names.final_name
FROM m4_publication_names AS names
WHERE publication.space_id = names.space_id
  AND publication.publication_id = names.publication_id;

WITH ranked AS (
  SELECT space_id, publication_id,
         row_number() OVER (PARTITION BY space_id ORDER BY sort_order, publication_id) - 1 AS position
  FROM app.publications
  WHERE status = 'active'
)
UPDATE app.publications AS publication
SET sort_order = ranked.position
FROM ranked
WHERE publication.space_id = ranked.space_id
  AND publication.publication_id = ranked.publication_id;

ALTER TABLE app.publications
  ALTER COLUMN sort_order DROP NOT NULL;

UPDATE app.publications
SET sort_order = NULL
WHERE status = 'inactive';

ALTER TABLE app.publications
  DROP CONSTRAINT publications_sort_order_non_negative;

ALTER TABLE app.publications
  DROP COLUMN is_default;

ALTER TABLE app.publications
  ADD CONSTRAINT publications_sort_order_state CHECK (
    (status = 'active' AND sort_order IS NOT NULL AND sort_order >= 0)
    OR
    (status = 'inactive' AND sort_order IS NULL)
  );

ALTER TABLE app.publications
  ADD CONSTRAINT publications_display_name_length
  CHECK (char_length(display_name) BETWEEN 1 AND 40);

ALTER TABLE app.publications
  ADD CONSTRAINT publications_display_name_trimmed
  CHECK (display_name = btrim(display_name));

CREATE UNIQUE INDEX publications_active_sort_order_unique
  ON app.publications (space_id, sort_order)
  WHERE status = 'active';

CREATE UNIQUE INDEX publications_space_display_name_unique
  ON app.publications (space_id, lower(display_name));

ALTER TABLE app.theme_selections
  DROP CONSTRAINT theme_selections_target_allowed;

ALTER TABLE app.theme_selections
  DROP CONSTRAINT theme_selections_theme_revision_positive;

ALTER TABLE app.theme_selections
  DROP CONSTRAINT theme_selections_active_payload_object;

ALTER TABLE app.theme_selections
  DROP COLUMN theme_revision;

ALTER TABLE app.theme_selections
  DROP COLUMN active_payload;

ALTER TABLE app.theme_selections
  ADD CONSTRAINT theme_selections_target_allowed CHECK (
    (
      target_type = 'home'
      AND publication_id IS NULL
      AND selection_mode = 'override'
      AND theme_id IS NOT NULL
    )
    OR
    (
      target_type = 'publication'
      AND publication_id IS NOT NULL
      AND (
        (selection_mode = 'inherit' AND theme_id IS NULL)
        OR
        (selection_mode = 'override' AND theme_id IS NOT NULL)
      )
    )
  );

CREATE TABLE app.custom_themes (
  space_id uuid NOT NULL,
  theme_id text NOT NULL,
  display_name text NOT NULL,
  current_revision integer NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz,
  PRIMARY KEY (space_id, theme_id),
  CONSTRAINT custom_themes_space_fk
    FOREIGN KEY (space_id) REFERENCES app.spaces (id) ON DELETE RESTRICT,
  CONSTRAINT custom_themes_current_revision_fk
    FOREIGN KEY (space_id, theme_id, current_revision)
    REFERENCES app.theme_definitions (space_id, theme_id, revision)
    ON DELETE RESTRICT,
  CONSTRAINT custom_themes_theme_id_format
    CHECK (theme_id ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CONSTRAINT custom_themes_display_name_valid CHECK (
    display_name = btrim(display_name)
    AND char_length(display_name) BETWEEN 1 AND 40
    AND display_name !~ '[[:cntrl:]]'
  ),
  CONSTRAINT custom_themes_revision_positive CHECK (current_revision >= 1),
  CONSTRAINT custom_themes_status_allowed CHECK (status IN ('active', 'deleted')),
  CONSTRAINT custom_themes_deletion_state CHECK (
    (status = 'active' AND deleted_at IS NULL)
    OR
    (status = 'deleted' AND deleted_at IS NOT NULL)
  )
);

INSERT INTO app.custom_themes (space_id, theme_id, display_name, current_revision)
SELECT definition.space_id,
       definition.theme_id,
       CASE
         WHEN NULLIF(btrim(definition.definition_payload ->> 'name'), '') IS NOT NULL
          AND char_length(btrim(definition.definition_payload ->> 'name')) BETWEEN 1 AND 40
          AND btrim(definition.definition_payload ->> 'name') !~ '[[:cntrl:]]'
         THEN btrim(definition.definition_payload ->> 'name')
         ELSE left(definition.theme_id, 40)
       END,
       definition.revision
FROM app.theme_definitions AS definition
JOIN (
  SELECT space_id, theme_id, max(revision) AS revision
  FROM app.theme_definitions
  GROUP BY space_id, theme_id
) AS current
  ON current.space_id = definition.space_id
 AND current.theme_id = definition.theme_id
 AND current.revision = definition.revision;

DROP TABLE app.theme_candidates;

COMMENT ON TABLE app.user_profiles IS 'Explicit DailyNews nickname completion separate from identity email';
COMMENT ON TABLE app.custom_themes IS 'Space-scoped custom Theme identity and current revision';
COMMENT ON COLUMN app.publications.sort_order IS 'Contiguous active Publication order; the first active Publication is primary';
COMMENT ON TABLE app.theme_selections IS 'Current Home and Publication Theme ID selection; revisions resolve at read time';
