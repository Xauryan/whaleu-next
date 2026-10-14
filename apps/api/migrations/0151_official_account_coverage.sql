-- Synthetic-only registry. No account, program, grant, eligibility or coverage is seeded.
CREATE SCHEMA whaleu_official;
CREATE TABLE whaleu_official.accounts (
 id uuid PRIMARY KEY, label text NOT NULL CHECK(char_length(label) BETWEEN 1 AND 100),
 destination_ref uuid NOT NULL UNIQUE, revision text NOT NULL CHECK(revision ~ '^[a-f0-9]{64}$'),
 profile text NOT NULL CHECK(profile='synthetic-official-v1'), revoked_at timestamptz
);
CREATE TABLE whaleu_official.programs (
 id uuid PRIMARY KEY, account_ref uuid NOT NULL REFERENCES whaleu_official.accounts(id),
 institution_id uuid NOT NULL REFERENCES whaleu_campus.institutions(id),
 school_space_id uuid NOT NULL REFERENCES whaleu_community.spaces(id),
 city_space_id uuid REFERENCES whaleu_community.spaces(id),
 region_ids uuid[] NOT NULL CHECK(cardinality(region_ids) BETWEEN 1 AND 8),
 lineage_ref uuid NOT NULL UNIQUE, UNIQUE(school_space_id), revision text NOT NULL CHECK(revision ~ '^[a-f0-9]{64}$'),
 revoked_at timestamptz, UNIQUE(account_ref,school_space_id)
);
CREATE TABLE whaleu_official.source_roots (
 space_id uuid PRIMARY KEY REFERENCES whaleu_community.spaces(id),
 head bigint NOT NULL DEFAULT 0 CHECK(head>=0), baseline_highwater uuid,
 baseline_cursor uuid, baseline_started boolean NOT NULL DEFAULT false,
 baseline_exhausted boolean NOT NULL DEFAULT false,
 settled_head bigint NOT NULL DEFAULT 0 CHECK(settled_head>=0 AND settled_head<=head),
 ready boolean NOT NULL DEFAULT false, rebuild_generation bigint NOT NULL DEFAULT 1
);
CREATE TABLE whaleu_official.source_events (
 space_id uuid NOT NULL REFERENCES whaleu_official.source_roots(space_id),
 sequence bigint NOT NULL CHECK(sequence>0), post_id uuid NOT NULL,
 owner_table text NOT NULL, source_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
 PRIMARY KEY(space_id,sequence)
);
CREATE INDEX official_events_post ON whaleu_official.source_events(space_id,post_id,sequence);
CREATE TABLE whaleu_official.source_dirty (
 space_id uuid NOT NULL REFERENCES whaleu_official.source_roots(space_id), post_id uuid NOT NULL,
 first_sequence bigint NOT NULL, last_sequence bigint NOT NULL,
 PRIMARY KEY(space_id,post_id), CHECK(first_sequence<=last_sequence)
);
CREATE INDEX official_dirty_frontier ON whaleu_official.source_dirty(space_id,first_sequence,post_id);
CREATE TABLE whaleu_official.export_eligibility (
 post_id uuid PRIMARY KEY REFERENCES whaleu_community.posts(id),
 publication_xid xid8 NOT NULL, evidence_id uuid NOT NULL UNIQUE,
 revision text NOT NULL CHECK(revision ~ '^[a-f0-9]{64}$'),
 decision text NOT NULL CHECK(decision IN('allow','deny','unknown')),
 profile text NOT NULL CHECK(profile='synthetic-official-v1'), revoked_at timestamptz
);
CREATE TABLE whaleu_official.source_ranks (
 space_id uuid NOT NULL REFERENCES whaleu_official.source_roots(space_id), post_id uuid NOT NULL,
 published_at timestamptz NOT NULL CHECK(isfinite(published_at)),
 score numeric(24,4), certificate_hash text, daily_active boolean NOT NULL DEFAULT false, structural_present boolean NOT NULL DEFAULT true, next_proof_at timestamptz,
 decision text NOT NULL CHECK(decision IN('allow','deny','unknown')),
 source_digest text NOT NULL CHECK(source_digest ~ '^[a-f0-9]{64}$'),
 settled_sequence bigint NOT NULL CHECK(settled_sequence>=0),valid_until timestamptz,
 PRIMARY KEY(space_id,post_id),
 CHECK(decision<>'allow' OR (score IS NOT NULL AND certificate_hash ~ '^[a-f0-9]{64}$'))
);
CREATE INDEX official_rank_frontier ON whaleu_official.source_ranks(space_id,score DESC,post_id DESC) INCLUDE(published_at,certificate_hash) WHERE daily_active AND decision='allow';
CREATE INDEX official_rank_active_time ON whaleu_official.source_ranks(space_id,published_at,post_id) WHERE daily_active;
CREATE INDEX official_rank_inactive_time ON whaleu_official.source_ranks(space_id,published_at,post_id) WHERE NOT daily_active AND structural_present;
CREATE INDEX official_rank_unknown ON whaleu_official.source_ranks(space_id,published_at,post_id) WHERE daily_active AND decision='unknown';
CREATE INDEX official_manual_prefix ON whaleu_community.posts(space_id,published_at DESC,id DESC);
CREATE INDEX official_bootstrap_prefix ON whaleu_community.posts(space_id,id);

CREATE FUNCTION whaleu_official.mark_post(p uuid, owner_name text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE s uuid; n bigint;
BEGIN
 FOR s IN SELECT space_id FROM whaleu_community.posts WHERE id=p
          UNION SELECT space_id FROM whaleu_official.source_ranks WHERE post_id=p LOOP
  INSERT INTO whaleu_official.source_roots(space_id) VALUES(s) ON CONFLICT DO NOTHING;
  UPDATE whaleu_official.source_roots SET head=head+1,ready=false WHERE space_id=s RETURNING head INTO n;
  INSERT INTO whaleu_official.source_events(space_id,sequence,post_id,owner_table) VALUES(s,n,p,owner_name);
  INSERT INTO whaleu_official.source_dirty(space_id,post_id,first_sequence,last_sequence) VALUES(s,p,n,n)
   ON CONFLICT(space_id,post_id) DO UPDATE SET last_sequence=EXCLUDED.last_sequence;
 END LOOP;
END $$;
CREATE FUNCTION whaleu_official.source_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p uuid;
BEGIN
 p := (COALESCE(to_jsonb(NEW),to_jsonb(OLD))->>CASE WHEN TG_TABLE_NAME='posts' THEN 'id' ELSE 'post_id' END)::uuid;
 PERFORM whaleu_official.mark_post(p,TG_TABLE_SCHEMA||'.'||TG_TABLE_NAME);
 RETURN NULL;
END $$;
CREATE TRIGGER official_post_change AFTER INSERT OR UPDATE OR DELETE ON whaleu_community.posts FOR EACH ROW EXECUTE FUNCTION whaleu_official.source_changed();
CREATE TRIGGER official_visibility_change AFTER INSERT OR UPDATE OR DELETE ON whaleu_community.post_owner_visibility FOR EACH ROW EXECUTE FUNCTION whaleu_official.source_changed();
CREATE TRIGGER official_eligibility_change AFTER INSERT OR UPDATE OR DELETE ON whaleu_official.export_eligibility FOR EACH ROW EXECUTE FUNCTION whaleu_official.source_changed();
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['scores','subscription_baselines','subscription_states','subscription_sources','subscription_receipts','like_baselines','like_states','like_sources','like_receipts','comment_baselines','comment_states','comment_sources','comment_receipts','view_baselines','view_states'] LOOP
 EXECUTE format('CREATE TRIGGER official_score_change AFTER INSERT OR UPDATE OR DELETE ON whaleu_post_hotness.%I FOR EACH ROW EXECUTE FUNCTION whaleu_official.source_changed()',tab);
 END LOOP;
END $$;
CREATE TRIGGER official_event_immutable BEFORE UPDATE OR DELETE ON whaleu_official.source_events FOR EACH ROW EXECUTE FUNCTION whaleu_media.immutable_record();
CREATE TRIGGER official_event_retain BEFORE TRUNCATE ON whaleu_official.source_events FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.immutable_record();
CREATE TRIGGER official_account_identity BEFORE UPDATE OR DELETE ON whaleu_official.accounts FOR EACH ROW EXECUTE FUNCTION whaleu_media.guard_mutable_record('label,revision,revoked_at');
CREATE TRIGGER official_program_identity BEFORE UPDATE OR DELETE ON whaleu_official.programs FOR EACH ROW EXECUTE FUNCTION whaleu_media.guard_mutable_record('revision,revoked_at');

CREATE INDEX official_rank_deadline ON whaleu_official.source_ranks(space_id,valid_until,post_id) WHERE valid_until IS NOT NULL;
-- Every derived write, including an out-of-band repair, invalidates exact coverage.
-- The maintainer accounts only for its own affected rows and must still prove the
-- complete predecessor plus owner facts before clearing those identities.
CREATE FUNCTION whaleu_official.rank_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; n bigint;
BEGIN
 IF TG_OP='DELETE' THEN r:=OLD; ELSE r:=NEW; END IF;
 UPDATE whaleu_official.source_roots SET head=head+1,ready=false WHERE space_id=r.space_id RETURNING head INTO STRICT n;
 INSERT INTO whaleu_official.source_events(space_id,sequence,post_id,owner_table) VALUES(r.space_id,n,r.post_id,'whaleu_official.source_ranks');
 INSERT INTO whaleu_official.source_dirty(space_id,post_id,first_sequence,last_sequence) VALUES(r.space_id,r.post_id,n,n)
 ON CONFLICT(space_id,post_id) DO UPDATE SET last_sequence=EXCLUDED.last_sequence;
 RETURN NULL;
END $$;
CREATE TRIGGER official_rank_change AFTER INSERT OR UPDATE OR DELETE ON whaleu_official.source_ranks FOR EACH ROW EXECUTE FUNCTION whaleu_official.rank_changed();
CREATE TRIGGER official_rank_identity BEFORE UPDATE ON whaleu_official.source_ranks FOR EACH ROW EXECUTE FUNCTION whaleu_media.guard_mutable_record('published_at,score,certificate_hash,daily_active,structural_present,next_proof_at,decision,source_digest,settled_sequence,valid_until');
CREATE TABLE whaleu_official.maintenance_claim(singleton boolean PRIMARY KEY CHECK(singleton),token uuid,lease_until timestamptz,CHECK((token IS NULL)=(lease_until IS NULL)));
INSERT INTO whaleu_official.maintenance_claim(singleton) VALUES(true);

CREATE INDEX official_active_expiry ON whaleu_official.source_ranks(space_id,valid_until,post_id) WHERE daily_active AND valid_until IS NOT NULL;

CREATE TRIGGER official_rank_retain BEFORE TRUNCATE ON whaleu_official.source_ranks FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.immutable_record();

CREATE INDEX official_unknown_retry ON whaleu_official.source_ranks(space_id,next_proof_at,post_id) WHERE daily_active AND decision='unknown';
-- Accepted program enrollment creates only empty generation roots. It does not
-- assert that historical inventory is covered and keeps manual empty reads usable.
CREATE FUNCTION whaleu_official.program_roots() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO whaleu_official.source_roots(space_id) VALUES(NEW.school_space_id) ON CONFLICT DO NOTHING;
 IF NEW.city_space_id IS NOT NULL THEN INSERT INTO whaleu_official.source_roots(space_id) VALUES(NEW.city_space_id) ON CONFLICT DO NOTHING;END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER official_program_roots AFTER INSERT ON whaleu_official.programs FOR EACH ROW EXECUTE FUNCTION whaleu_official.program_roots();
