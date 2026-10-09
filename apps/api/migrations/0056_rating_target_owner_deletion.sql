-- M2A: creator-only retained target tombstones. No content, Review, source,
-- role, notification, reward, origin or existing historical row is rewritten.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
-- Same lowercase UUID grammar as the public Zod UUID contract (including nil/max).
CREATE FUNCTION whaleu_ratings.owner_delete_id_valid(id text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT coalesce(id ~ '^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$',false)
$$;
CREATE FUNCTION whaleu_ratings.owner_delete_intent_valid(i jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT coalesce(jsonb_typeof(i)='object' AND
   i-ARRAY['clientRequestId','targetId','expectedTargetRevision']='{}'::jsonb AND
   NOT EXISTS(SELECT 1 FROM unnest(ARRAY['clientRequestId','targetId','expectedTargetRevision']) k
     WHERE jsonb_typeof(i->k) IS DISTINCT FROM 'string' OR
       NOT whaleu_ratings.owner_delete_id_valid(i->>k)),false)
$$;
CREATE FUNCTION whaleu_ratings.owner_delete_intent_hash(i jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT encode(sha256(convert_to(E'whaleu:rating-target-delete:v1\n'||
   whaleu_ratings.creation_canonical_json(jsonb_build_object('operation','delete_target','intent',i)),'UTF8')),'hex')
$$;
CREATE TABLE whaleu_ratings.target_owner_delete_audits (
 id uuid PRIMARY KEY,actor_account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,
 intent_hash text NOT NULL,intent jsonb NOT NULL,target_id uuid NOT NULL REFERENCES whaleu_ratings.targets(id),
 before_revision uuid NOT NULL,after_revision uuid NOT NULL,before_active boolean NOT NULL,
 outcome text NOT NULL CHECK(outcome IN ('applied','noop')),
 source_delete_audit_id uuid REFERENCES whaleu_ratings.target_owner_delete_audits(id),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(occurred_at)),
 mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 UNIQUE(actor_account_id,request_id),FOREIGN KEY(actor_account_id,request_id) REFERENCES whaleu_ratings.requests(account_id,request_id),
 CHECK(whaleu_ratings.owner_delete_intent_valid(intent)),
 CHECK(whaleu_ratings.owner_delete_id_valid(after_revision::text)),
 CHECK(intent_hash=whaleu_ratings.owner_delete_intent_hash(intent)),
 CHECK(intent->>'clientRequestId'=request_id::text AND intent->>'targetId'=target_id::text AND intent->>'expectedTargetRevision'=before_revision::text),
 CHECK((outcome='applied' AND before_revision<>after_revision AND source_delete_audit_id IS NULL)
   OR (outcome='noop' AND before_revision=after_revision AND NOT before_active AND source_delete_audit_id IS NOT NULL))
);
CREATE UNIQUE INDEX rating_target_owner_delete_revision ON whaleu_ratings.target_owner_delete_audits(target_id,after_revision) WHERE outcome='applied';
CREATE UNIQUE INDEX rating_target_owner_delete_transaction ON whaleu_ratings.target_owner_delete_audits(target_id,mutation_transaction) WHERE outcome='applied';
CREATE TABLE whaleu_ratings.target_owner_tombstones (
 target_id uuid PRIMARY KEY REFERENCES whaleu_ratings.targets(id),delete_audit_id uuid NOT NULL UNIQUE REFERENCES whaleu_ratings.target_owner_delete_audits(id),
 cause text NOT NULL CHECK(cause='owner_deleted'),actor_account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,
 after_revision uuid NOT NULL,deleted_at timestamptz NOT NULL CHECK(isfinite(deleted_at)),
 mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 FOREIGN KEY(actor_account_id,request_id) REFERENCES whaleu_ratings.requests(account_id,request_id)
);
CREATE TABLE whaleu_ratings.target_owner_delete_closures (
 actor_account_id uuid NOT NULL,request_id uuid NOT NULL,intent_hash text NOT NULL,intent jsonb NOT NULL,
 code text NOT NULL CHECK(code IN ('RATING_NOT_FOUND','RATING_REVISION_CONFLICT','PHONE_VERIFICATION_REQUIRED','SAFETY_ACTION_RESTRICTED','RATING_TARGET_DELETION_CANCELLED')),
 mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),PRIMARY KEY(actor_account_id,request_id),
 FOREIGN KEY(actor_account_id,request_id) REFERENCES whaleu_ratings.requests(account_id,request_id),
 CHECK(whaleu_ratings.owner_delete_intent_valid(intent)),
 CHECK(intent->>'clientRequestId'=request_id::text AND intent_hash=whaleu_ratings.owner_delete_intent_hash(intent))
);
CREATE FUNCTION whaleu_ratings.target_owner_delete_writer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
 -- Acquire epoch fences before audit guards lock the real target/command rows.
 -- Merely locking does not turn noop/cancellation into a public mutation.
 LOCK TABLE whaleu_ratings.random_pool_epoch,whaleu_ratings.navigation_epoch IN ROW EXCLUSIVE MODE;
 RETURN NULL;
END $$;
-- Statement triggers run before any target/claim row lock in the new guards.
-- Lexical order is explicitly common exclusive gate -> pool -> navigation.
DO $$ DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['target_owner_delete_audits','target_owner_tombstones','target_owner_delete_closures'] LOOP
  EXECUTE format('CREATE TRIGGER a0_rating_owner_delete_writer BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.target_owner_delete_writer()',tab);
  EXECUTE format('CREATE TRIGGER rating_owner_delete_immutable BEFORE UPDATE OR DELETE ON whaleu_ratings.%I FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.immutable()',tab);
  EXECUTE format('CREATE TRIGGER rating_owner_delete_retain BEFORE TRUNCATE ON whaleu_ratings.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.immutable()',tab);
 END LOOP;
END $$;
CREATE TRIGGER a1_rating_owner_delete_pool BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.target_owner_tombstones FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.advance_random_pool_epoch();
CREATE TRIGGER a2_rating_owner_delete_navigation BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.target_owner_tombstones FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.advance_navigation_epoch();

CREATE FUNCTION whaleu_ratings.owner_delete_audit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t whaleu_ratings.targets;q whaleu_ratings.requests;d whaleu_ratings.target_owner_tombstones;before_state whaleu_ratings.target_state_revisions;instant timestamptz;
BEGIN
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=NEW.target_id FOR UPDATE NOWAIT;
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=NEW.actor_account_id AND request_id=NEW.request_id FOR UPDATE NOWAIT;
 SELECT * INTO d FROM whaleu_ratings.target_owner_tombstones WHERE target_id=NEW.target_id;
 SELECT * INTO before_state FROM whaleu_ratings.target_state_revisions WHERE target_id=NEW.target_id AND revision=NEW.before_revision;
 instant:=clock_timestamp();NEW.occurred_at:=instant;
 IF NOT coalesce(t.id IS NOT NULL AND t.creator_id=NEW.actor_account_id AND t.revision=NEW.before_revision AND t.active=NEW.before_active
  AND before_state.target_id=t.id AND before_state.active=t.active AND before_state.occurred_at<=NEW.occurred_at
  AND q.operation='delete_target' AND q.intent_hash=NEW.intent_hash AND q.receipt IS NULL
  AND NEW.mutation_transaction=pg_current_xact_id() AND NEW.occurred_at<=instant,false)
 THEN RAISE EXCEPTION 'Owner target deletion before-state mismatch' USING ERRCODE='23514';END IF;
 IF NEW.outcome='applied' THEN
  IF d.target_id IS NOT NULL OR EXISTS(SELECT 1 FROM whaleu_ratings.target_state_revisions WHERE target_id=NEW.target_id AND revision=NEW.after_revision)
  THEN RAISE EXCEPTION 'Owner target deletion cannot repeat or rewind' USING ERRCODE='23514';END IF;
 ELSE
  IF NOT coalesce(d.target_id=t.id AND d.delete_audit_id=NEW.source_delete_audit_id AND d.after_revision=t.revision AND NOT t.active,false)
  THEN RAISE EXCEPTION 'Owner target deletion noop requires exact tombstone' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER rating_owner_delete_audit_guard BEFORE INSERT ON whaleu_ratings.target_owner_delete_audits FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.owner_delete_audit_guard();

-- Preserve every old immutable creation field. The ONLY same-active exception
-- in M2A is an exact fresh false->false owner-delete cause. Editing stays closed.
CREATE OR REPLACE FUNCTION whaleu_ratings.target_definition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a whaleu_ratings.target_owner_delete_audits;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Target definition is immutable' USING ERRCODE='23514';END IF;
 IF ROW(NEW.id,NEW.category_id,NEW.creator_id,NEW.region_id,NEW.source_id,NEW.name,NEW.description,NEW.envelope,NEW.content_version,NEW.creation_transaction,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.category_id,OLD.creator_id,OLD.region_id,OLD.source_id,OLD.name,OLD.description,OLD.envelope,OLD.content_version,OLD.creation_transaction,OLD.created_at)
 OR NEW.revision=OLD.revision OR EXISTS(SELECT 1 FROM whaleu_ratings.target_owner_tombstones WHERE target_id=OLD.id)
 THEN RAISE EXCEPTION 'Target definition or owner tombstone is immutable' USING ERRCODE='23514';END IF;
 SELECT * INTO a FROM whaleu_ratings.target_owner_delete_audits WHERE target_id=OLD.id AND after_revision=NEW.revision AND outcome='applied' AND mutation_transaction=pg_current_xact_id();
 IF a.id IS NOT NULL THEN
  IF NOT coalesce(a.actor_account_id=OLD.creator_id AND a.before_revision=OLD.revision AND a.before_active=OLD.active AND NOT NEW.active,false)
  THEN RAISE EXCEPTION 'Target lifecycle does not match owner deletion' USING ERRCODE='23514';END IF;
 ELSIF NEW.active=OLD.active THEN RAISE EXCEPTION 'Target definition is immutable' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION whaleu_ratings.owner_tombstone_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a whaleu_ratings.target_owner_delete_audits;t whaleu_ratings.targets;q whaleu_ratings.requests;
BEGIN
 SELECT * INTO a FROM whaleu_ratings.target_owner_delete_audits WHERE id=NEW.delete_audit_id;
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=NEW.target_id FOR UPDATE NOWAIT;
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=NEW.actor_account_id AND request_id=NEW.request_id FOR UPDATE NOWAIT;
 IF NOT coalesce(a.id IS NOT NULL AND a.outcome='applied' AND a.mutation_transaction=pg_current_xact_id()
  AND (a.target_id,a.actor_account_id,a.request_id,a.after_revision,a.occurred_at,a.mutation_transaction)
   =(NEW.target_id,NEW.actor_account_id,NEW.request_id,NEW.after_revision,NEW.deleted_at,NEW.mutation_transaction)
  AND t.creator_id=NEW.actor_account_id AND t.revision=NEW.after_revision AND NOT t.active
  AND q.operation='delete_target' AND q.intent_hash=a.intent_hash AND q.receipt IS NULL,false)
 THEN RAISE EXCEPTION 'Owner tombstone has no exact lifecycle cause' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER rating_owner_tombstone_guard BEFORE INSERT ON whaleu_ratings.target_owner_tombstones FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.owner_tombstone_guard();

ALTER TABLE whaleu_ratings.requests DROP CONSTRAINT requests_operation_check;
ALTER TABLE whaleu_ratings.requests ADD CONSTRAINT requests_operation_check CHECK(operation IN ('set_score','create_comment','delete_comment','create_reply','delete_reply','set_comment_like','set_reply_like','set_target_subscription','admin_delete_comment','admin_delete_reply','create_target','delete_target'));
DROP TRIGGER rating_request_causal ON whaleu_ratings.requests;
CREATE CONSTRAINT TRIGGER rating_request_causal AFTER INSERT OR UPDATE ON whaleu_ratings.requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.operation NOT IN ('set_comment_like','set_reply_like','set_target_subscription','admin_delete_comment','admin_delete_reply','create_target','delete_target')) EXECUTE FUNCTION whaleu_ratings.request_causal();

CREATE FUNCTION whaleu_ratings.verify_target_owner_delete(actor uuid,request uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE q whaleu_ratings.requests;a whaleu_ratings.target_owner_delete_audits;d whaleu_ratings.target_owner_tombstones;
 c whaleu_ratings.target_owner_delete_closures;t whaleu_ratings.targets;s whaleu_ratings.target_state_revisions;keys text[];n integer;
BEGIN
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=actor AND request_id=request;
 SELECT * INTO a FROM whaleu_ratings.target_owner_delete_audits WHERE actor_account_id=actor AND request_id=request;
 SELECT * INTO c FROM whaleu_ratings.target_owner_delete_closures WHERE actor_account_id=actor AND request_id=request;
 SELECT array_agg(k ORDER BY k) INTO keys FROM jsonb_object_keys(q.receipt) k;
 IF q.receipt->>'outcome'='rejected' THEN
  IF NOT coalesce(q.operation='delete_target' AND keys=ARRAY['code','operation','outcome','requestId']
    AND q.receipt->>'operation'='delete_target' AND q.receipt->>'requestId'=request::text AND q.receipt->>'code'=c.code
    AND c.intent_hash=q.intent_hash AND c.mutation_transaction=pg_current_xact_id() AND a.id IS NULL
    AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.target_state_revisions WHERE target_id=(c.intent->>'targetId')::uuid AND mutation_transaction=pg_current_xact_id()),false)
  THEN RAISE EXCEPTION 'Owner target deletion terminal receipt mismatch' USING ERRCODE='23514';END IF;
  RETURN;
 END IF;
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=a.target_id;
 SELECT * INTO d FROM whaleu_ratings.target_owner_tombstones WHERE target_id=a.target_id;
 IF NOT coalesce(q.operation='delete_target' AND a.id IS NOT NULL AND c.actor_account_id IS NULL
  AND a.intent_hash=q.intent_hash AND a.mutation_transaction=pg_current_xact_id()
  AND keys=ARRAY['occurredAt','operation','outcome','requestId','revision','targetId']
  AND q.receipt->>'operation'='delete_target' AND q.receipt->>'requestId'=request::text
  AND q.receipt->>'outcome'=a.outcome AND q.receipt->>'targetId'=a.target_id::text
  AND q.receipt->>'revision'=a.after_revision::text AND q.receipt->>'occurredAt'=to_char(a.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  AND t.creator_id=actor AND t.revision=a.after_revision AND NOT t.active
  AND d.target_id=t.id AND d.after_revision=t.revision,false)
 THEN RAISE EXCEPTION 'Owner target deletion receipt or current state mismatch' USING ERRCODE='23514';END IF;
 IF a.outcome='applied' THEN
  SELECT * INTO s FROM whaleu_ratings.target_state_revisions WHERE target_id=a.target_id AND revision=a.after_revision;
  SELECT count(*) INTO n FROM whaleu_ratings.target_state_revisions WHERE target_id=a.target_id AND mutation_transaction=pg_current_xact_id();
  IF NOT coalesce(d.delete_audit_id=a.id AND d.actor_account_id=actor AND d.request_id=request
    AND d.deleted_at=a.occurred_at AND d.mutation_transaction=a.mutation_transaction
    AND s.target_id=t.id AND NOT s.active AND s.mutation_transaction=a.mutation_transaction
    AND s.occurred_at>=a.occurred_at AND s.occurred_at<=clock_timestamp() AND n=1,false)
  THEN RAISE EXCEPTION 'Owner deletion lifecycle/tombstone causal link incomplete' USING ERRCODE='23514';END IF;
 ELSE
  IF NOT coalesce(d.delete_audit_id=a.source_delete_audit_id AND d.after_revision=a.before_revision AND d.deleted_at<=a.occurred_at,false)
   OR EXISTS(SELECT 1 FROM whaleu_ratings.target_state_revisions WHERE target_id=a.target_id AND mutation_transaction=pg_current_xact_id())
  THEN RAISE EXCEPTION 'Owner deletion noop changed lifecycle or lacks source' USING ERRCODE='23514';END IF;
 END IF;
END $$;
CREATE FUNCTION whaleu_ratings.target_owner_delete_causal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='requests' THEN PERFORM whaleu_ratings.verify_target_owner_delete(NEW.account_id,NEW.request_id);
 ELSE PERFORM whaleu_ratings.verify_target_owner_delete(NEW.actor_account_id,NEW.request_id);END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER rating_owner_delete_request_causal AFTER INSERT OR UPDATE ON whaleu_ratings.requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.operation='delete_target') EXECUTE FUNCTION whaleu_ratings.target_owner_delete_causal();
CREATE CONSTRAINT TRIGGER rating_owner_delete_audit_causal AFTER INSERT ON whaleu_ratings.target_owner_delete_audits DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.target_owner_delete_causal();
CREATE CONSTRAINT TRIGGER rating_owner_tombstone_causal AFTER INSERT ON whaleu_ratings.target_owner_tombstones DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.target_owner_delete_causal();
CREATE CONSTRAINT TRIGGER rating_owner_delete_closure_causal AFTER INSERT ON whaleu_ratings.target_owner_delete_closures DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.target_owner_delete_causal();
CREATE FUNCTION whaleu_ratings.target_owner_delete_state_causal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a whaleu_ratings.target_owner_delete_audits;
BEGIN
 SELECT * INTO a FROM whaleu_ratings.target_owner_delete_audits WHERE target_id=NEW.id AND after_revision=NEW.revision AND outcome='applied' AND mutation_transaction=pg_current_xact_id();
 IF a.id IS NOT NULL THEN
  IF (a.before_revision,a.before_active,a.actor_account_id) IS DISTINCT FROM (OLD.revision,OLD.active,OLD.creator_id)
  THEN RAISE EXCEPTION 'Owner deletion lifecycle predecessor mismatch' USING ERRCODE='23514';END IF;
  PERFORM whaleu_ratings.verify_target_owner_delete(a.actor_account_id,a.request_id);
 END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER rating_owner_delete_state_causal AFTER UPDATE ON whaleu_ratings.targets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.target_owner_delete_state_causal();
