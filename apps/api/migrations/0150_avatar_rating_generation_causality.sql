-- Preserve every rating-card invalidation edge. A scoped avatar retirement now
-- has an exact receipt for its own Media -> rating -> Community epoch effect.
-- No original request hash, input facts, applied migration or budget is changed.
CREATE TABLE whaleu_profile.avatar_moderation_rating_epochs (
 actor_id uuid NOT NULL,request_id uuid NOT NULL,statement_sequence integer NOT NULL CHECK(statement_sequence BETWEEN 1 AND 7),
 slot integer NOT NULL CHECK(slot BETWEEN 0 AND 127),version integer NOT NULL CHECK(version=1),
 before_epoch bigint NOT NULL CHECK(before_epoch>=0),after_epoch bigint NOT NULL CHECK(after_epoch=before_epoch+1),
 before_hash text NOT NULL CHECK(before_hash~'^[0-9a-f]{64}$'),after_hash text NOT NULL CHECK(after_hash~'^[0-9a-f]{64}$'),
 before_generation uuid NOT NULL,after_generation uuid NOT NULL CHECK(after_generation<>before_generation),
 mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),PRIMARY KEY(actor_id,request_id,statement_sequence),
 FOREIGN KEY(actor_id,request_id,statement_sequence) REFERENCES whaleu_profile.avatar_moderation_media_epochs(actor_id,request_id,statement_sequence)
);
CREATE FUNCTION whaleu_profile.avatar_moderation_community_vector() RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN count(*)=128 AND min(slot)=0 AND max(slot)=127 AND bool_and(version=1 AND epoch>=0)
 THEN jsonb_agg(jsonb_build_array(slot,version,epoch::text) ORDER BY slot) ELSE NULL END
 FROM whaleu_community.discovery_count_epochs
$$;
CREATE FUNCTION whaleu_profile.avatar_moderation_rating_epoch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_profile.avatar_moderation_commands;e whaleu_profile.avatar_moderation_media_epochs;
 s whaleu_profile.avatar_moderation_media_statements;p whaleu_profile.avatar_moderation_rating_epochs;v jsonb;g uuid;BEGIN
 SELECT * INTO q FROM whaleu_profile.avatar_moderation_commands WHERE(actor_id,request_id)=(NEW.actor_id,NEW.request_id);
 SELECT * INTO e FROM whaleu_profile.avatar_moderation_media_epochs WHERE(actor_id,request_id,statement_sequence)=(NEW.actor_id,NEW.request_id,NEW.statement_sequence);
 SELECT * INTO s FROM whaleu_profile.avatar_moderation_media_statements WHERE(actor_id,request_id,sequence)=(NEW.actor_id,NEW.request_id,NEW.statement_sequence);
 SELECT * INTO p FROM whaleu_profile.avatar_moderation_rating_epochs WHERE(actor_id,request_id)=(NEW.actor_id,NEW.request_id) ORDER BY statement_sequence DESC LIMIT 1;
 v:=whaleu_profile.avatar_moderation_community_vector();
 SELECT generation INTO g FROM whaleu_community.rating_target_link_generation WHERE singleton AND version=1;
 IF pg_trigger_depth()<2 OR q.request_id IS NULL OR e.statement_sequence IS NULL OR s.sequence IS NULL
 OR q.receipt->>'outcome' IS DISTINCT FROM 'applied'
 OR q.mutation_transaction IS DISTINCT FROM pg_current_xact_id() OR NEW.mutation_transaction IS DISTINCT FROM q.mutation_transaction
 OR e.mutation_transaction IS DISTINCT FROM q.mutation_transaction OR s.mutation_transaction IS DISTINCT FROM q.mutation_transaction
 OR NEW.statement_sequence IS DISTINCT FROM coalesce(p.statement_sequence,0)+1
 OR NEW.statement_sequence IS DISTINCT FROM (SELECT max(sequence) FROM whaleu_profile.avatar_moderation_media_statements WHERE(actor_id,request_id)=(NEW.actor_id,NEW.request_id))
 OR NEW.statement_sequence IS DISTINCT FROM (SELECT count(*)::integer FROM whaleu_profile.avatar_moderation_media_epochs WHERE(actor_id,request_id)=(NEW.actor_id,NEW.request_id))
 OR s.epoch_before_hash IS DISTINCT FROM e.before_hash OR e.after_hash IS DISTINCT FROM whaleu_profile.avatar_moderation_media_epoch_hash()
 OR NOT whaleu_profile.avatar_moderation_media_inventory_current() OR NOT whaleu_profile.avatar_moderation_rating_epoch_inventory_current()
 OR v IS NULL OR NEW.after_hash IS DISTINCT FROM whaleu_profile.moderation_hash(v)
 OR (v->NEW.slot) IS DISTINCT FROM jsonb_build_array(NEW.slot,NEW.version,NEW.after_epoch::text)
 OR NEW.before_hash IS DISTINCT FROM whaleu_profile.moderation_hash(jsonb_set(v,ARRAY[NEW.slot::text,'2'],to_jsonb(NEW.before_epoch::text),false))
 OR g IS NULL OR NEW.after_generation IS DISTINCT FROM g
 OR (p.statement_sequence IS NOT NULL AND (NEW.before_hash IS DISTINCT FROM p.after_hash OR NEW.before_generation IS DISTINCT FROM p.after_generation))
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q.retirement_before->'bindings') b
   WHERE b->0->>'id'=q.old_binding_id::text AND b->0->>'asset_id'=q.old_asset_id::text
   AND b->0->>'owner_kind'='profile' AND b->0->>'resource_kind'='avatar' AND b->0->>'resource_id'=q.previous_appearance_id::text)
 THEN RAISE EXCEPTION 'Exact avatar-owned rating generation transition required' USING ERRCODE='23514',CONSTRAINT='profile_avatar_moderation_causal';END IF;
 RETURN NEW;
END$$;
CREATE FUNCTION whaleu_profile.avatar_moderation_rating_epoch_inventory_current() RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT NOT EXISTS(SELECT 1 FROM (VALUES
 ('whaleu_media.media_owner_states'::regclass,'rating_target_link_generation','whaleu_community.advance_rating_target_link_generation()'::regprocedure,60),
 ('whaleu_community.rating_target_link_generation'::regclass,'a_discovery_count_epoch','whaleu_community.advance_discovery_count_epoch()'::regprocedure,62),
 ('whaleu_community.rating_target_link_generation'::regclass,'rating_target_link_generation_guard','whaleu_community.rating_target_link_generation_guard()'::regprocedure,31),
 ('whaleu_profile.avatar_moderation_rating_epochs'::regclass,'avatar_moderation_rating_epoch_guard','whaleu_profile.avatar_moderation_rating_epoch_guard()'::regprocedure,7),
 ('whaleu_profile.avatar_moderation_rating_epochs'::regclass,'avatar_moderation_rating_epoch_immutable','whaleu_profile.moderation_immutable()'::regprocedure,58),
 ('whaleu_profile.avatar_moderation_rating_epochs'::regclass,'avatar_moderation_rating_epoch_complete','whaleu_profile.avatar_moderation_recheck_active()'::regprocedure,5)
 ) wanted(relation,name,fn,type) WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t
 WHERE t.tgrelid=wanted.relation AND t.tgname=wanted.name AND t.tgfoid=wanted.fn AND t.tgtype=wanted.type
 AND t.tgenabled IN('O','A') AND t.tgqual IS NULL AND t.tgnargs=0 AND NOT t.tgisinternal
 AND (wanted.name<>'avatar_moderation_rating_epoch_complete' OR (t.tgdeferrable AND t.tginitdeferred))))
$$;
CREATE TRIGGER avatar_moderation_rating_epoch_guard BEFORE INSERT ON whaleu_profile.avatar_moderation_rating_epochs FOR EACH ROW EXECUTE FUNCTION whaleu_profile.avatar_moderation_rating_epoch_guard();
CREATE TRIGGER avatar_moderation_rating_epoch_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_profile.avatar_moderation_rating_epochs FOR EACH STATEMENT EXECUTE FUNCTION whaleu_profile.moderation_immutable();
CREATE CONSTRAINT TRIGGER avatar_moderation_rating_epoch_complete AFTER INSERT ON whaleu_profile.avatar_moderation_rating_epochs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_profile.avatar_moderation_recheck_active();

CREATE OR REPLACE FUNCTION whaleu_community.advance_rating_target_link_generation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_profile.avatar_moderation_commands;e whaleu_profile.avatar_moderation_media_epochs;
 before_vector jsonb;after_vector jsonb;before_g uuid;after_g uuid;changed_slot integer;changed_count integer;BEGIN
 IF TG_TABLE_SCHEMA='whaleu_media' AND TG_TABLE_NAME='media_owner_states'
 AND EXISTS(SELECT 1 FROM whaleu_profile.avatar_moderation_commands WHERE mutation_transaction=pg_current_xact_id()) THEN
  IF TG_OP<>'UPDATE' OR (SELECT count(*) FROM whaleu_profile.avatar_moderation_commands WHERE mutation_transaction=pg_current_xact_id())<>1
  OR NOT whaleu_profile.avatar_moderation_media_inventory_current() OR NOT whaleu_profile.avatar_moderation_rating_epoch_inventory_current()
  THEN RAISE EXCEPTION 'Exact avatar Media generation cause required' USING ERRCODE='23514',CONSTRAINT='profile_avatar_moderation_causal';END IF;
  SELECT * INTO q FROM whaleu_profile.avatar_moderation_commands WHERE mutation_transaction=pg_current_xact_id();
  SELECT * INTO e FROM whaleu_profile.avatar_moderation_media_epochs WHERE(actor_id,request_id)=(q.actor_id,q.request_id) ORDER BY statement_sequence DESC LIMIT 1;
  IF q.receipt->>'outcome' IS DISTINCT FROM 'applied' OR e.statement_sequence IS NULL OR e.mutation_transaction IS DISTINCT FROM q.mutation_transaction
  OR e.after_hash IS DISTINCT FROM whaleu_profile.avatar_moderation_media_epoch_hash()
  OR e.statement_sequence IS DISTINCT FROM (SELECT count(*)::integer+1 FROM whaleu_profile.avatar_moderation_rating_epochs WHERE(actor_id,request_id)=(q.actor_id,q.request_id))
  THEN RAISE EXCEPTION 'Unconsumed avatar Media epoch required' USING ERRCODE='23514',CONSTRAINT='profile_avatar_moderation_causal';END IF;
  before_vector:=whaleu_profile.avatar_moderation_community_vector();
  SELECT generation INTO before_g FROM whaleu_community.rating_target_link_generation WHERE singleton AND version=1;
  IF before_vector IS NULL OR before_g IS NULL THEN RAISE EXCEPTION 'Complete original generation vector required' USING ERRCODE='23514',CONSTRAINT='profile_avatar_moderation_causal';END IF;
  -- Same UPDATE and lock order as0149; the CAS rejects an intervening source.
  UPDATE whaleu_community.rating_target_link_generation SET generation=gen_random_uuid() WHERE singleton AND generation=before_g RETURNING generation INTO after_g;
  IF NOT FOUND OR after_g IS NULL THEN RAISE EXCEPTION 'Rating generation changed during avatar retirement' USING ERRCODE='23514',CONSTRAINT='profile_avatar_moderation_causal';END IF;
  after_vector:=whaleu_profile.avatar_moderation_community_vector();
  SELECT count(*)::integer,min(n) INTO changed_count,changed_slot FROM generate_series(0,127) n WHERE before_vector->n IS DISTINCT FROM after_vector->n;
  IF after_vector IS NULL OR changed_count<>1
  OR after_vector->changed_slot IS DISTINCT FROM jsonb_build_array(changed_slot,1,((before_vector->changed_slot->>2)::bigint+1)::text)
  THEN RAISE EXCEPTION 'Only one actual derived Community epoch is permitted' USING ERRCODE='23514',CONSTRAINT='profile_avatar_moderation_causal';END IF;
  INSERT INTO whaleu_profile.avatar_moderation_rating_epochs(actor_id,request_id,statement_sequence,slot,version,before_epoch,after_epoch,before_hash,after_hash,before_generation,after_generation)
  VALUES(q.actor_id,q.request_id,e.statement_sequence,changed_slot,1,(before_vector->changed_slot->>2)::bigint,(after_vector->changed_slot->>2)::bigint,
   whaleu_profile.moderation_hash(before_vector),whaleu_profile.moderation_hash(after_vector),before_g,after_g);
 ELSE
  UPDATE whaleu_community.rating_target_link_generation SET generation=gen_random_uuid() WHERE singleton;
  IF NOT FOUND THEN RAISE EXCEPTION 'Missing rating link generation' USING ERRCODE='23514';END IF;
 END IF;RETURN NULL;
END$$;

CREATE FUNCTION whaleu_profile.avatar_moderation_rating_original_community(q whaleu_profile.avatar_moderation_commands) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE facts jsonb;v jsonb;r record;next_sequence integer;expected_generation uuid;epochs integer;receipts integer;BEGIN
 facts:=whaleu_profile.avatar_moderation_input_facts(q.actor_id,q.grant_id,q.target_kind,q.target_id);
 IF facts IS NULL OR NOT whaleu_profile.avatar_moderation_rating_epoch_inventory_current() THEN RETURN NULL;END IF;
 SELECT count(*)::integer INTO epochs FROM whaleu_profile.avatar_moderation_media_epochs WHERE(actor_id,request_id)=(q.actor_id,q.request_id);
 SELECT count(*)::integer INTO receipts FROM whaleu_profile.avatar_moderation_rating_epochs WHERE(actor_id,request_id)=(q.actor_id,q.request_id);
 IF epochs<>receipts OR epochs>7 THEN RETURN NULL;END IF;
 IF epochs=0 THEN
  IF q.input_hash IS DISTINCT FROM whaleu_profile.moderation_hash(facts) THEN RETURN NULL;END IF;
  RETURN facts->'community';
 END IF;
 IF q.mutation_transaction IS DISTINCT FROM pg_current_xact_id() OR q.receipt->>'outcome' IS DISTINCT FROM 'applied'
 OR NOT whaleu_profile.avatar_moderation_media_epoch_complete(q) THEN RETURN NULL;END IF;
 v:=facts->'community';next_sequence:=epochs;
 SELECT generation INTO expected_generation FROM whaleu_community.rating_target_link_generation WHERE singleton AND version=1;
 IF v IS NULL OR v IS DISTINCT FROM whaleu_profile.avatar_moderation_community_vector() OR expected_generation IS NULL THEN RETURN NULL;END IF;
 FOR r IN SELECT receipt.*,e.mutation_transaction media_transaction,s.mutation_transaction statement_transaction,e.before_hash media_before_hash,s.epoch_before_hash
 FROM whaleu_profile.avatar_moderation_rating_epochs receipt
 JOIN whaleu_profile.avatar_moderation_media_epochs e USING(actor_id,request_id,statement_sequence)
 JOIN whaleu_profile.avatar_moderation_media_statements s ON(s.actor_id,s.request_id,s.sequence)=(e.actor_id,e.request_id,e.statement_sequence)
 WHERE(receipt.actor_id,receipt.request_id)=(q.actor_id,q.request_id) ORDER BY receipt.statement_sequence DESC LOOP
  IF r.statement_sequence<>next_sequence OR r.mutation_transaction IS DISTINCT FROM q.mutation_transaction
  OR r.media_transaction IS DISTINCT FROM q.mutation_transaction OR r.statement_transaction IS DISTINCT FROM q.mutation_transaction
  OR r.media_before_hash IS DISTINCT FROM r.epoch_before_hash
  OR r.after_generation IS DISTINCT FROM expected_generation OR r.after_hash IS DISTINCT FROM whaleu_profile.moderation_hash(v)
  OR v->r.slot IS DISTINCT FROM jsonb_build_array(r.slot,r.version,r.after_epoch::text) THEN RETURN NULL;END IF;
  v:=jsonb_set(v,ARRAY[r.slot::text,'2'],to_jsonb(r.before_epoch::text),false);
  IF r.before_hash IS DISTINCT FROM whaleu_profile.moderation_hash(v) THEN RETURN NULL;END IF;
  expected_generation:=r.before_generation;next_sequence:=next_sequence-1;
 END LOOP;
 IF next_sequence<>0 OR q.input_hash IS DISTINCT FROM whaleu_profile.moderation_hash(jsonb_set(facts,ARRAY['community'],v,false)) THEN RETURN NULL;END IF;
 RETURN v;
END$$;

CREATE FUNCTION whaleu_profile.avatar_moderation_rating_inputs_current(q whaleu_profile.avatar_moderation_commands) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT whaleu_profile.avatar_moderation_rating_original_community(q) IS NOT NULL
$$;
-- The application bridge requires its exact command even for a zero-effect
-- rejection. It cannot borrow another request or fall back after a missing row.
CREATE FUNCTION whaleu_profile.avatar_moderation_command_community(actor uuid,request uuid,kind text,target uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE q whaleu_profile.avatar_moderation_commands;BEGIN
 SELECT * INTO q FROM whaleu_profile.avatar_moderation_commands
 WHERE actor_id=actor AND request_id=request AND target_kind=kind AND target_id=target
 AND mutation_transaction=pg_current_xact_id() AND grant_id IS NOT NULL;
 IF NOT FOUND THEN RETURN NULL;END IF;
 RETURN whaleu_profile.avatar_moderation_rating_original_community(q);
END$$;

-- Original0129 final checker, with only its input comparison delegated to the
-- exact reverse-delta proof above. All identity, lock, grant and cause checks stay.
CREATE OR REPLACE FUNCTION whaleu_profile.avatar_moderation_assert_complete(q whaleu_profile.avatar_moderation_commands) RETURNS void LANGUAGE plpgsql AS $$
DECLARE p record;t whaleu_profile.avatar_moderation_transitions;v whaleu_profile.avatar_moderation_pointer_transitions;e whaleu_profile.avatar_moderation_events;
 current_fingerprint text;BEGIN
 -- NOWAIT relation fences include queued revocation writers, even when the
 -- original command already holds a SHARE row lock. Existing budgets stay put.
 LOCK TABLE whaleu_identity.accounts,whaleu_identity.sessions,whaleu_identity.access_tokens IN SHARE MODE NOWAIT;
 IF NOT whaleu_profile.moderation_identity_current(q.actor_id,q.session_id,q.token_hash)
 OR q.identity_hash IS DISTINCT FROM whaleu_profile.moderation_hash(whaleu_profile.moderation_identity_facts(q.actor_id,q.session_id,q.token_hash))
 THEN RAISE EXCEPTION 'Original current avatar moderator identity required' USING ERRCODE='23514',CONSTRAINT='profile_avatar_moderation_causal';END IF;
 SELECT * INTO t FROM whaleu_profile.avatar_moderation_transitions WHERE actor_id=q.actor_id AND request_id=q.request_id;
 SELECT * INTO v FROM whaleu_profile.avatar_moderation_pointer_transitions WHERE actor_id=q.actor_id AND request_id=q.request_id;
 SELECT * INTO e FROM whaleu_profile.avatar_moderation_events WHERE actor_id=q.actor_id AND request_id=q.request_id;
 IF q.receipt->>'code'='PROFILE_AVATAR_MODERATION_CANCELLED' THEN
  IF t.request_id IS NOT NULL OR v.request_id IS NOT NULL OR e.id IS NOT NULL OR q.subject_id IS NOT NULL OR q.grant_id IS NOT NULL
  OR EXISTS(SELECT 1 FROM whaleu_profile.avatar_moderation_media_statements s WHERE (s.actor_id,s.request_id)=(q.actor_id,q.request_id))
  OR EXISTS(SELECT 1 FROM whaleu_profile.avatar_moderation_media_epochs epoch_receipt WHERE (epoch_receipt.actor_id,epoch_receipt.request_id)=(q.actor_id,q.request_id))
  THEN RAISE EXCEPTION 'Avatar cancellation cannot produce side effects' USING ERRCODE='23514',CONSTRAINT='profile_avatar_moderation_causal';END IF;RETURN;
 END IF;
 LOCK TABLE whaleu_authorization.role_grants,whaleu_verification.account_heads,whaleu_verification.snapshots,whaleu_verification.assertions,
 whaleu_community.discovery_count_epochs,whaleu_safety.discovery_count_epochs,whaleu_campus.discovery_count_epochs IN SHARE MODE NOWAIT;
 -- Unlike 0128, comparison below is exact target Media facts, not the global
 -- Media epoch changed by this command's separately constrained retirement.
 LOCK TABLE whaleu_media.media_owner_states,whaleu_media.upload_intents,whaleu_media.assets,whaleu_media.bindings,
 whaleu_media.asset_safety_heads,whaleu_media.asset_safety_events,whaleu_media.variants,whaleu_media.object_attempts,
 whaleu_media.derived_object_attempts,whaleu_media.quota_reservations,whaleu_media.upload_ingress,whaleu_media.cleanup_obligations IN SHARE MODE NOWAIT;
 LOCK TABLE whaleu_community.rating_target_link_generation IN SHARE MODE NOWAIT;
 IF NOT whaleu_profile.avatar_moderation_media_inventory_current() OR NOT whaleu_profile.avatar_moderation_media_epoch_complete(q)
 OR NOT whaleu_profile.moderation_grant_allowed(q.actor_id,q.grant_id,q.original_region_id)
 OR NOT whaleu_community.profile_moderation_supported(q.actor_id,q.target_kind,q.target_id)
 OR NOT whaleu_profile.moderation_actor_current(q.actor_id,clock_timestamp())
 OR NOT whaleu_profile.avatar_moderation_rating_inputs_current(q)
 THEN RAISE EXCEPTION 'Original current scoped avatar inputs required' USING ERRCODE='23514',CONSTRAINT='profile_avatar_moderation_causal';END IF;
 SELECT * INTO p FROM whaleu_profile.profiles WHERE account_id=q.subject_id;
 SELECT whaleu_profile.moderation_hash(jsonb_build_array(to_jsonb(current),current.xmin::text,current.ctid::text)) INTO current_fingerprint FROM whaleu_profile.profiles current WHERE current.account_id=q.subject_id;
 IF q.receipt->>'outcome'='rejected' THEN
  IF p.account_id IS NULL OR t.request_id IS NOT NULL OR v.request_id IS NOT NULL OR e.id IS NOT NULL
  OR q.before_hash IS DISTINCT FROM whaleu_profile.moderation_hash(to_jsonb(p)) OR q.before_fingerprint IS DISTINCT FROM current_fingerprint
  OR q.avatar_hash IS DISTINCT FROM whaleu_profile.moderation_hash(whaleu_profile.moderation_avatar_facts(q.subject_id))
  OR EXISTS(SELECT 1 FROM whaleu_profile.avatar_moderation_media_statements s WHERE (s.actor_id,s.request_id)=(q.actor_id,q.request_id))
  THEN RAISE EXCEPTION 'Rejected avatar command must remain read-only' USING ERRCODE='23514',CONSTRAINT='profile_avatar_moderation_causal';END IF;RETURN;
 END IF;
 IF p.account_id IS NULL OR e.id IS NULL OR t.request_id IS NULL OR v.request_id IS NULL
 OR e.mutation_transaction<>pg_current_xact_id() OR t.mutation_transaction<>pg_current_xact_id() OR v.mutation_transaction<>pg_current_xact_id()
 OR t.before_hash IS DISTINCT FROM q.before_hash OR t.unchanged_hash IS DISTINCT FROM q.unchanged_hash
 OR t.after_hash IS DISTINCT FROM whaleu_profile.moderation_hash(to_jsonb(p)) OR t.after_fingerprint IS DISTINCT FROM current_fingerprint
 OR v.before_hash IS DISTINCT FROM q.avatar_hash OR v.after_hash IS DISTINCT FROM whaleu_profile.moderation_hash(whaleu_profile.moderation_avatar_facts(q.subject_id))
 OR p.revision IS DISTINCT FROM e.revision OR t.after_revision IS DISTINCT FROM e.revision
 OR NOT whaleu_profile.avatar_moderation_definition_authorized(q.appearance_id)
 OR NOT whaleu_profile.avatar_moderation_retirement_complete(q)
 OR NOT EXISTS(SELECT 1 FROM whaleu_notifications.profile_avatar_moderation_notices n JOIN whaleu_notifications.system_notice_ids i ON (i.id,i.kind,i.recipient_account_id)=(n.id,n.kind,n.recipient_account_id)
  WHERE n.event_id=e.id AND n.recipient_account_id=e.subject_id AND n.created_at=e.recorded_at AND n.read_at IS NULL)
 THEN RAISE EXCEPTION 'Avatar command, dual transition, event, retirement and unread notice must commit together' USING ERRCODE='23514',CONSTRAINT='profile_avatar_moderation_causal';END IF;
END$$;
