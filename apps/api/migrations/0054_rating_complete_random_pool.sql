-- Forward-only complete Ratings random scope mutation metadata. No catalog,
-- import, approval, grant or authority fact is created by this migration.
-- This intentionally serializes rating pool writers; it does not change the
-- narrower meaning or the per-item capacity of the existing navigation proof.
CREATE TABLE whaleu_ratings.random_pool_epoch (
 singleton boolean PRIMARY KEY CHECK(singleton),
 version integer NOT NULL CHECK(version=1),
 epoch bigint NOT NULL CHECK(epoch>=0)
);
INSERT INTO whaleu_ratings.random_pool_epoch VALUES(true,1,0);
CREATE FUNCTION whaleu_ratings.guard_random_pool_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'Rating pool epoch is retained' USING ERRCODE='23514'; END IF;
 IF pg_trigger_depth()<2 OR NEW.singleton IS DISTINCT FROM OLD.singleton OR NEW.version IS DISTINCT FROM OLD.version
 OR OLD.epoch=9223372036854775807 OR NEW.epoch IS DISTINCT FROM OLD.epoch+1 THEN
  RAISE EXCEPTION 'Invalid rating pool epoch advance' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER rating_pool_epoch_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.random_pool_epoch FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.guard_random_pool_epoch();
CREATE TRIGGER rating_pool_epoch_retain BEFORE TRUNCATE ON whaleu_ratings.random_pool_epoch FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.guard_random_pool_epoch();
CREATE FUNCTION whaleu_ratings.advance_random_pool_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE whaleu_ratings.random_pool_epoch SET epoch=epoch+1 WHERE singleton AND version=1 AND epoch<9223372036854775807;
 IF NOT FOUND THEN RAISE EXCEPTION 'Rating pool epoch absent or exhausted' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
-- BEFORE STATEMENT runs before row locks/causal mutations. ROW EXCLUSIVE on
-- the epoch remains held through commit, including zero-row statements. A
-- final SHARE NOWAIT fence therefore rejects both pending and committed ABA.
DO $$ DECLARE t text; BEGIN
 -- These tables already have rating_authority_writer, which acquires the
 -- exclusive common policy gate. Lexical trigger order must keep that gate
 -- before the pool epoch: ordinary scoring already holds the shared gate.
 FOREACH t IN ARRAY ARRAY['catalogs','catalog_heads','categories','target_memberships','targets','target_sources'] LOOP
  EXECUTE format('CREATE TRIGGER rating_complete_pool_epoch BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.advance_random_pool_epoch()',t);
 END LOOP;
 -- Never add an exclusive common policy-gate upgrade to ordinary score writes.
 FOREACH t IN ARRAY ARRAY['target_creations','score_baselines','score_summaries','scores','score_transitions','target_state_revisions'] LOOP
  EXECUTE format('CREATE TRIGGER a0_rating_complete_pool_epoch BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.advance_random_pool_epoch()',t);
 END LOOP;
END $$;
CREATE INDEX rating_complete_pool_category_children ON whaleu_ratings.categories(catalog_id,parent_id,level,id);
CREATE INDEX rating_complete_pool_membership_category ON whaleu_ratings.target_memberships(catalog_id,category_id,target_id);

-- Binding INSERT was intentionally outside the old Review epoch, because
-- per-item publication captures that epoch before inserting its own binding.
-- A separate complete-pool binding epoch retains that protocol unchanged.
CREATE TABLE whaleu_community.rating_review_binding_epoch (
 singleton boolean PRIMARY KEY CHECK(singleton),
 version integer NOT NULL CHECK(version=1),
 epoch bigint NOT NULL CHECK(epoch>=0)
);
INSERT INTO whaleu_community.rating_review_binding_epoch VALUES(true,1,0);
CREATE FUNCTION whaleu_community.guard_rating_review_binding_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'Rating binding epoch is retained' USING ERRCODE='23514'; END IF;
 IF pg_trigger_depth()<2 OR NEW.singleton IS DISTINCT FROM OLD.singleton OR NEW.version IS DISTINCT FROM OLD.version
 OR OLD.epoch=9223372036854775807 OR NEW.epoch IS DISTINCT FROM OLD.epoch+1 THEN
  RAISE EXCEPTION 'Invalid rating binding epoch advance' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER rating_binding_epoch_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.rating_review_binding_epoch FOR EACH ROW EXECUTE FUNCTION whaleu_community.guard_rating_review_binding_epoch();
CREATE TRIGGER rating_binding_epoch_retain BEFORE TRUNCATE ON whaleu_community.rating_review_binding_epoch FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.guard_rating_review_binding_epoch();
CREATE FUNCTION whaleu_community.advance_rating_review_binding_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 -- Do not upgrade the shared publication policy gate to exclusive here.
 UPDATE whaleu_community.rating_review_binding_epoch SET epoch=epoch+1 WHERE singleton AND version=1 AND epoch<9223372036854775807;
 IF NOT FOUND THEN RAISE EXCEPTION 'Rating binding epoch absent or exhausted' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER a0_rating_complete_binding_epoch BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.rating_approval_bindings FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.advance_rating_review_binding_epoch();
