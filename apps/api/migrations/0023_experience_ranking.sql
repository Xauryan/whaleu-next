-- Read-only known-participant ordering; no enrollment or historical backfill.
CREATE INDEX account_states_ranking_idx
  ON whaleu_experience.account_states (balance DESC, owner_id ASC);
