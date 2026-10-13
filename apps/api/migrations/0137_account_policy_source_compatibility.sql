-- Preserve the pre-existing source-owner writer contract. Migration0136 is
-- immutable history. No row, receipt, sidecar or epoch is rewritten here.
-- Original BEFORE ROW/STATEMENT guards must keep deciding their own immutable
-- diagnostics and legitimate zero-row epoch touches. A successful real UPDATE
-- or DELETE still cannot escape the added consumer fallback.
CREATE FUNCTION whaleu_safety.account_policy_consumer_changed_statement()
RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF TG_LEVEL<>'STATEMENT' OR TG_WHEN<>'AFTER' OR TG_OP NOT IN ('UPDATE','DELETE')
 OR EXISTS(SELECT 1 FROM affected) THEN
  RAISE EXCEPTION 'Consumer source rows cannot be changed or removed'
   USING ERRCODE='23514',CONSTRAINT='account_policy_consumer_causal';
 END IF;
 RETURN NULL;
END$$;

DO $$DECLARE relation text;BEGIN
 FOREACH relation IN ARRAY ARRAY[
  'whaleu_ratings.course_commands',
  'whaleu_ratings.course_comment_commands',
  'whaleu_ratings.window_commands',
  'whaleu_ratings.dish_commands',
  'whaleu_ratings.floor_commands',
  'whaleu_ratings.window_discussion_commands',
  'whaleu_majors.major_discussion_commands',
  'whaleu_majors.major_discussion_delete_commands',
  'whaleu_community.post_pin_commands',
  'whaleu_community.post_owner_visibility_commands',
  'whaleu_community.post_category_commands',
  'whaleu_profile.moderation_commands',
  'whaleu_profile.avatar_moderation_commands',
  'whaleu_community.admin_post_removal_commands',
  'whaleu_community.admin_discussion_removal_commands',
  'whaleu_authorization.school_admin_management_commands',
  'whaleu_community.region_policy_commands',
  'whaleu_experience.requests',
  'whaleu_experience.maintenance_requests',
  'whaleu_ratings.scoped_command_preparations',
  'whaleu_ratings.scoped_command_outcomes'
 ] LOOP
  -- Only these21 old command sources got0136 blanket statement/empty-insert
  -- guards. The37 other source lifecycles and all original triggers are intact.
  EXECUTE format('DROP TRIGGER account_policy_consumer_source_immutable ON %s',relation);
  EXECUTE format('DROP TRIGGER account_policy_consumer_insert_statement ON %s',relation);
  EXECUTE format('CREATE TRIGGER zz_account_policy_consumer_source_retain BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_immutable()',relation);
  EXECUTE format('CREATE TRIGGER account_policy_consumer_changed_update AFTER UPDATE ON %s REFERENCING OLD TABLE AS affected FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_changed_statement()',relation);
  EXECUTE format('CREATE TRIGGER account_policy_consumer_changed_delete AFTER DELETE ON %s REFERENCING OLD TABLE AS affected FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_changed_statement()',relation);
 END LOOP;
END$$;

-- A source-trigger capture reaches this BEFORE ROW gate before old command
-- AFTER STATEMENT checks. Report unsupported isolation precisely, while keeping
-- both this requirement and every original owner's own isolation guard.
CREATE OR REPLACE FUNCTION whaleu_safety.account_policy_consumer_admit()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE observed record;BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'Consumer policy source capture requires read committed'
   USING ERRCODE='23514',CONSTRAINT='account_policy_consumer_causal';
 END IF;
 SELECT * INTO observed FROM whaleu_safety.account_punishment_policy_observation(NEW.actor_id,NEW.action);
 -- Only the fixed source-table AFTER INSERT capture may add evidence. The
 -- original source's existing identity, intent and effect guards still apply.
 IF pg_trigger_depth()<>2
 OR NEW.creation_transaction<>pg_current_xact_id()
 OR NEW.punishment_fingerprint IS DISTINCT FROM observed.fingerprint
 OR NEW.allowed IS DISTINCT FROM observed.allowed
 OR NEW.suspended IS DISTINCT FROM observed.suspended
 OR NEW.observed_until IS DISTINCT FROM observed.until::timestamptz
 THEN RAISE EXCEPTION 'Exact source-trigger policy proof required' USING ERRCODE='23514',CONSTRAINT='account_policy_consumer_causal';END IF;
 RETURN NEW;
END$$;

-- Independently reviewed exact own Profile concurrency proof.
-- Per-cause statement evidence replaces unrelated actors' global Profile epoch
-- as the own-write witness. Existing epoch columns/rows remain historical
-- observations; no historical record, source writer or API contract is rewritten.
CREATE TABLE whaleu_profile.self_edit_statements (
 cause_id uuid PRIMARY KEY REFERENCES whaleu_profile.self_edit_causes(id),
 before_fingerprint text NOT NULL,
 mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE TRIGGER self_edit_statement_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_profile.self_edit_statements FOR EACH STATEMENT EXECUTE FUNCTION whaleu_profile.moderation_immutable();
CREATE FUNCTION whaleu_profile.self_edit_statement_admit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_profile.self_edit_causes;BEGIN
 SELECT * INTO q FROM whaleu_profile.self_edit_causes WHERE id=NEW.cause_id AND mutation_transaction=pg_current_xact_id();
 IF pg_trigger_depth()<>2 OR q.id IS NULL OR NEW.mutation_transaction<>pg_current_xact_id()
 OR NEW.before_fingerprint IS DISTINCT FROM q.before_fingerprint
 OR EXISTS(SELECT 1 FROM whaleu_profile.self_edit_transitions WHERE cause_id=q.id)
 THEN PERFORM whaleu_profile.self_edit_unavailable();END IF;RETURN NEW;
END$$;
CREATE TRIGGER self_edit_statement_admit BEFORE INSERT ON whaleu_profile.self_edit_statements FOR EACH ROW EXECUTE FUNCTION whaleu_profile.self_edit_statement_admit();
CREATE FUNCTION whaleu_profile.self_edit_statement_insert_complete() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM inserted) THEN PERFORM whaleu_profile.self_edit_unavailable();END IF;RETURN NULL;
END$$;
CREATE TRIGGER self_edit_statement_insert_complete AFTER INSERT ON whaleu_profile.self_edit_statements REFERENCING NEW TABLE AS inserted FOR EACH STATEMENT EXECUTE FUNCTION whaleu_profile.self_edit_statement_insert_complete();
CREATE FUNCTION whaleu_profile.self_edit_statement_current(q whaleu_profile.self_edit_causes) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT q.mutation_transaction=pg_current_xact_id() AND EXISTS(
 SELECT 1 FROM whaleu_profile.self_edit_statements s WHERE s.cause_id=q.id
 AND s.before_fingerprint=q.before_fingerprint AND s.mutation_transaction=pg_current_xact_id())
$$;
CREATE OR REPLACE FUNCTION whaleu_profile.self_edit_admit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p whaleu_profile.profiles;original_profile text;original_epoch_sum numeric;original_identity text;BEGIN
 IF current_setting('transaction_isolation')<>'read committed' OR NEW.mutation_transaction<>pg_current_xact_id()
 OR jsonb_typeof(NEW.patch) IS DISTINCT FROM 'object'
 OR NEW.patch='{}'::jsonb
 OR NOT ((NEW.patch-ARRAY['nickname','bio']='{}'::jsonb)
   OR (NEW.patch ? 'preferences' AND NEW.patch-'preferences'='{}'::jsonb)
   OR (NEW.patch ? 'selectedCampusId' AND NEW.patch-'selectedCampusId'='{}'::jsonb))
 OR (NEW.patch ? 'nickname' AND jsonb_typeof(NEW.patch->'nickname') IS DISTINCT FROM 'string')
 OR (NEW.patch ? 'bio' AND jsonb_typeof(NEW.patch->'bio') IS DISTINCT FROM 'string')
 OR (NEW.patch ? 'preferences' AND jsonb_typeof(NEW.patch->'preferences') IS DISTINCT FROM 'object')
 OR (NEW.patch ? 'selectedCampusId' AND jsonb_typeof(NEW.patch->'selectedCampusId') IS DISTINCT FROM 'string')
 THEN PERFORM whaleu_profile.self_edit_unavailable();END IF;
 -- Snapshot before even the actor advisory wait; never rebase raw cause input
 -- onto a newer same-value Profile tuple or refreshed/replaced credential.
 IF NOT whaleu_profile.self_edit_identity_current(NEW.actor_id,NEW.session_id,NEW.token_hash) THEN PERFORM whaleu_profile.self_edit_unavailable();END IF;
 original_identity:=whaleu_profile.moderation_hash(whaleu_profile.moderation_identity_facts(NEW.actor_id,NEW.session_id,NEW.token_hash));
 IF NEW.identity_hash IS DISTINCT FROM original_identity THEN PERFORM whaleu_profile.self_edit_unavailable();END IF;
 SELECT whaleu_profile.moderation_hash(jsonb_build_array(to_jsonb(x),x.xmin::text,x.ctid::text)) INTO original_profile FROM whaleu_profile.profiles x WHERE account_id=NEW.actor_id;
 SELECT sum(epoch) INTO original_epoch_sum FROM whaleu_profile.admin_count_epochs;
 -- Preserve original owner lock order; Identity is real caller, not inferred
 -- from an administrator command's subject Profile.
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:profile-avatar:actor:v1:'||NEW.actor_id::text,0));
 PERFORM id FROM whaleu_identity.accounts WHERE id=NEW.actor_id FOR SHARE NOWAIT;
 PERFORM id FROM whaleu_identity.sessions WHERE id=NEW.session_id AND account_id=NEW.actor_id FOR SHARE NOWAIT;
 PERFORM token_hash FROM whaleu_identity.access_tokens WHERE token_hash=NEW.token_hash AND session_id=NEW.session_id FOR SHARE NOWAIT;
 IF NOT whaleu_profile.self_edit_identity_current(NEW.actor_id,NEW.session_id,NEW.token_hash)
 THEN PERFORM whaleu_profile.self_edit_unavailable();END IF;
 PERFORM whaleu_safety.require_account_punishment_allowed(NEW.actor_id,'private_self_service');
 SELECT * INTO p FROM whaleu_profile.profiles WHERE account_id=NEW.actor_id FOR UPDATE NOWAIT;
 IF p.account_id IS NULL OR p.revision<>NEW.expected_revision THEN PERFORM whaleu_profile.self_edit_unavailable();END IF;
 NEW.before_row:=to_jsonb(p);
 SELECT whaleu_profile.moderation_hash(jsonb_build_array(to_jsonb(x),x.xmin::text,x.ctid::text)) INTO NEW.before_fingerprint FROM whaleu_profile.profiles x WHERE account_id=NEW.actor_id;
 IF NEW.before_fingerprint IS DISTINCT FROM original_profile
 OR NEW.identity_hash IS DISTINCT FROM whaleu_profile.moderation_hash(whaleu_profile.moderation_identity_facts(NEW.actor_id,NEW.session_id,NEW.token_hash))
 THEN PERFORM whaleu_profile.self_edit_unavailable();END IF;
 IF NEW.patch ? 'selectedCampusId' THEN
  PERFORM c.id FROM whaleu_campus.campuses c JOIN whaleu_campus.institutions i ON i.id=c.institution_id WHERE c.id=(NEW.patch->>'selectedCampusId')::uuid AND c.is_active FOR SHARE OF c,i NOWAIT;
  IF NOT FOUND THEN PERFORM whaleu_profile.self_edit_unavailable();END IF;
  SELECT whaleu_profile.moderation_hash(jsonb_build_array(to_jsonb(c),c.xmin::text,c.ctid::text)) INTO NEW.campus_fingerprint FROM whaleu_campus.campuses c WHERE c.id=(NEW.patch->>'selectedCampusId')::uuid;
 ELSE NEW.campus_fingerprint:=NULL;END IF;
 NEW.before_epoch_sum:=original_epoch_sum;
 RETURN NEW;
END$$;
CREATE OR REPLACE FUNCTION whaleu_profile.self_edit_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_profile.self_edit_causes;fingerprint text;BEGIN
 SELECT * INTO q FROM whaleu_profile.self_edit_causes WHERE mutation_transaction=pg_current_xact_id() ORDER BY id LIMIT 1;
 IF q.id IS NULL THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF TG_OP<>'UPDATE' THEN PERFORM whaleu_profile.self_edit_unavailable();END IF;
 IF OLD.account_id IS DISTINCT FROM q.actor_id OR NEW.account_id IS DISTINCT FROM q.actor_id
 THEN PERFORM whaleu_profile.self_edit_unavailable();END IF;
 SELECT whaleu_profile.moderation_hash(jsonb_build_array(to_jsonb(p),p.xmin::text,p.ctid::text)) INTO fingerprint FROM whaleu_profile.profiles p WHERE account_id=q.actor_id;
 IF fingerprint IS DISTINCT FROM q.before_fingerprint
 OR NOT whaleu_profile.self_edit_statement_current(q)
 THEN PERFORM whaleu_profile.self_edit_unavailable();END IF;RETURN NEW;
END$$;
CREATE OR REPLACE FUNCTION whaleu_profile.self_edit_capture() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_profile.self_edit_causes;expected jsonb;fingerprint text;BEGIN
 SELECT * INTO q FROM whaleu_profile.self_edit_causes WHERE actor_id=NEW.account_id AND mutation_transaction=pg_current_xact_id();
 IF q.id IS NULL THEN RETURN NULL;END IF;
 expected:=q.before_row || jsonb_build_object('revision',q.expected_revision+1);
 IF q.patch ? 'nickname' THEN expected:=expected||jsonb_build_object('nickname',q.patch->'nickname');END IF;
 IF q.patch ? 'bio' THEN expected:=expected||jsonb_build_object('bio',q.patch->'bio');END IF;
 IF q.patch ? 'preferences' THEN expected:=expected||jsonb_build_object('preferences',q.patch->'preferences');END IF;
 IF q.patch ? 'selectedCampusId' THEN expected:=expected||jsonb_build_object('selected_campus_id',q.patch->'selectedCampusId');END IF;
 IF NOT whaleu_profile.self_edit_statement_current(q)
 OR to_jsonb(OLD) IS DISTINCT FROM q.before_row
 OR to_jsonb(NEW)-'updated_at' IS DISTINCT FROM expected-'updated_at'
 OR NOT isfinite(NEW.updated_at) OR NEW.updated_at<OLD.updated_at
 THEN PERFORM whaleu_profile.self_edit_unavailable();END IF;
 SELECT whaleu_profile.moderation_hash(jsonb_build_array(to_jsonb(p),p.xmin::text,p.ctid::text)) INTO fingerprint FROM whaleu_profile.profiles p WHERE account_id=q.actor_id;
 INSERT INTO whaleu_profile.self_edit_transitions(cause_id,after_fingerprint,profile_epochs) VALUES(q.id,fingerprint,whaleu_profile.self_edit_epoch_hash());
 RETURN NULL;
END$$;
CREATE OR REPLACE FUNCTION whaleu_profile.self_edit_assert(q whaleu_profile.self_edit_causes) RETURNS void LANGUAGE plpgsql AS $$
DECLARE t whaleu_profile.self_edit_transitions;fingerprint text;BEGIN
 IF q.mutation_transaction<>pg_current_xact_id() THEN PERFORM whaleu_profile.self_edit_unavailable();END IF;
 -- Exact original authority rows, not tables used by unrelated actors.
 PERFORM id FROM whaleu_identity.accounts WHERE id=q.actor_id FOR SHARE NOWAIT;
 PERFORM id FROM whaleu_identity.sessions WHERE id=q.session_id AND account_id=q.actor_id FOR SHARE NOWAIT;
 PERFORM token_hash FROM whaleu_identity.access_tokens WHERE token_hash=q.token_hash AND session_id=q.session_id FOR SHARE NOWAIT;
 PERFORM account_id FROM whaleu_profile.profiles WHERE account_id=q.actor_id FOR SHARE NOWAIT;
 SELECT * INTO t FROM whaleu_profile.self_edit_transitions WHERE cause_id=q.id;
 SELECT whaleu_profile.moderation_hash(jsonb_build_array(to_jsonb(p),p.xmin::text,p.ctid::text)) INTO fingerprint FROM whaleu_profile.profiles p WHERE account_id=q.actor_id;
 IF t.cause_id IS NULL OR t.mutation_transaction<>pg_current_xact_id()
 OR NOT whaleu_profile.self_edit_statement_current(q)
 OR t.after_fingerprint IS DISTINCT FROM fingerprint
 OR NOT whaleu_profile.self_edit_identity_current(q.actor_id,q.session_id,q.token_hash)
 OR q.identity_hash IS DISTINCT FROM whaleu_profile.moderation_hash(whaleu_profile.moderation_identity_facts(q.actor_id,q.session_id,q.token_hash))
 OR (q.patch ? 'selectedCampusId' AND q.campus_fingerprint IS DISTINCT FROM (SELECT whaleu_profile.moderation_hash(jsonb_build_array(to_jsonb(c),c.xmin::text,c.ctid::text)) FROM whaleu_campus.campuses c WHERE c.id=(q.patch->>'selectedCampusId')::uuid AND c.is_active))
 THEN PERFORM whaleu_profile.self_edit_unavailable();END IF;
 PERFORM whaleu_safety.require_account_punishment_allowed(q.actor_id,'private_self_service');
END$$;
CREATE OR REPLACE FUNCTION whaleu_profile.self_edit_source_writer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_profile.self_edit_causes;BEGIN
 SELECT * INTO q FROM whaleu_profile.self_edit_causes WHERE mutation_transaction=pg_current_xact_id() ORDER BY id LIMIT 1;
 IF q.id IS NULL THEN RETURN NULL;END IF;
 IF TG_TABLE_SCHEMA<>'whaleu_profile' OR TG_TABLE_NAME<>'profiles' OR TG_OP<>'UPDATE'
 OR EXISTS(SELECT 1 FROM whaleu_profile.self_edit_transitions WHERE cause_id=q.id)
 OR EXISTS(SELECT 1 FROM whaleu_profile.self_edit_statements WHERE cause_id=q.id)
 THEN PERFORM whaleu_profile.self_edit_unavailable();END IF;
 -- Even a zero-row UPDATE consumes the single allowed source statement. It
 -- cannot supply the required row transition or precede a second real UPDATE.
 INSERT INTO whaleu_profile.self_edit_statements(cause_id,before_fingerprint)
 VALUES(q.id,q.before_fingerprint);
 RETURN NULL;
END$$;
