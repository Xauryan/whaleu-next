-- Canonical public institution IDs are reviewed five-digit strings, not UUIDs.
-- Existing UUIDs remain private surrogate keys: no relationship or source row is rewritten.
-- No names are matched and no catalog data is seeded by this migration.
CREATE TABLE whaleu_campus.school_identifier_sources (
  id text PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 100),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 500),
  publisher text NOT NULL CHECK (char_length(publisher) BETWEEN 1 AND 200),
  url text NOT NULL CHECK (url ~ '^https://'),
  published_on date,
  retrieved_at timestamptz NOT NULL,
  content_sha256 text CHECK (content_sha256 ~ '^[a-f0-9]{64}$')
);

CREATE TABLE whaleu_campus.school_identifiers (
  institution_id uuid PRIMARY KEY REFERENCES whaleu_campus.institutions(id),
  school_code text NOT NULL UNIQUE CHECK (school_code ~ '^[0-9]{5}$'),
  moe_code text NOT NULL UNIQUE CHECK (moe_code ~ '^4[12][0-9]{2}0[0-9]{5}$'),
  five_digit_source_id text NOT NULL REFERENCES whaleu_campus.school_identifier_sources(id),
  moe_source_id text NOT NULL REFERENCES whaleu_campus.school_identifier_sources(id),
  reviewed_by text NOT NULL CHECK (char_length(reviewed_by) BETWEEN 1 AND 200),
  reviewed_at timestamptz NOT NULL,
  review_note text NOT NULL CHECK (char_length(review_note) BETWEEN 1 AND 2000),
  -- Applicable ONLY to the reviewed higher-education MOE scheme, not admissions codes.
  CHECK (right(moe_code, 5) = school_code)
);

CREATE TABLE whaleu_campus.school_identifier_aliases (
  scheme text NOT NULL CHECK (scheme IN ('moe-five-historical','moe-ten-historical','provincial-admissions','institution-admissions','research-institute','other')),
  scope text NOT NULL CHECK (char_length(scope) BETWEEN 1 AND 200),
  value text NOT NULL CHECK (char_length(value) BETWEEN 1 AND 200),
  institution_id uuid NOT NULL REFERENCES whaleu_campus.school_identifiers(institution_id),
  valid_from date,
  valid_to date,
  source_id text NOT NULL REFERENCES whaleu_campus.school_identifier_sources(id),
  reviewed_by text NOT NULL CHECK (char_length(reviewed_by) BETWEEN 1 AND 200),
  reviewed_at timestamptz NOT NULL,
  review_note text NOT NULL CHECK (char_length(review_note) BETWEEN 1 AND 2000),
  -- Scope MUST identify issuer, jurisdiction and catalog/admission year or version.
  -- Reuse across historical versions is represented by distinct explicit scopes.
  PRIMARY KEY (scheme, scope, value),
  CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_from <= valid_to),
  CHECK (scheme <> 'moe-five-historical' OR value ~ '^[0-9]{5}$'),
  CHECK (scheme <> 'moe-ten-historical' OR value ~ '^[0-9]{10}$')
);
CREATE INDEX school_identifier_alias_institution ON whaleu_campus.school_identifier_aliases(institution_id);

CREATE TABLE whaleu_campus.school_legacy_crosswalks (
  source_system text NOT NULL CHECK (char_length(source_system) BETWEEN 1 AND 200),
  legacy_record_id text NOT NULL CHECK (char_length(legacy_record_id) BETWEEN 1 AND 200),
  institution_id uuid NOT NULL REFERENCES whaleu_campus.school_identifiers(institution_id),
  source_id text NOT NULL REFERENCES whaleu_campus.school_identifier_sources(id),
  reviewed_by text NOT NULL CHECK (char_length(reviewed_by) BETWEEN 1 AND 200),
  reviewed_at timestamptz NOT NULL,
  review_note text NOT NULL CHECK (char_length(review_note) BETWEEN 1 AND 2000),
  PRIMARY KEY (source_system, legacy_record_id)
);
CREATE INDEX school_legacy_crosswalk_institution ON whaleu_campus.school_legacy_crosswalks(institution_id);
