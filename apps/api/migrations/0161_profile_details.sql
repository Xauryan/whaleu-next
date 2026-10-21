-- Optional self-reported display fields. No legacy or identity-data backfill.
CREATE TABLE whaleu_profile.details (
  account_id uuid PRIMARY KEY REFERENCES whaleu_identity.accounts(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK(revision >= 1),
  region text CHECK(region IS NULL OR (char_length(region) BETWEEN 1 AND 80 AND region !~ '[[:cntrl:]]')),
  gender text CHECK(gender IN ('female','male','other')),
  age smallint CHECK(age BETWEEN 0 AND 120),
  show_region boolean NOT NULL DEFAULT false,
  show_gender boolean NOT NULL DEFAULT false,
  show_age boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
