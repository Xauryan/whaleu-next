-- M2B: creator-only general-target text versions. Original target definitions,
-- lifecycle history, source provenance, scores and M2A tombstones stay retained.
-- This migration installs no issuer, grant, approval or production authority.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
LOCK TABLE whaleu_ratings.random_pool_epoch,whaleu_ratings.navigation_epoch IN ROW EXCLUSIVE MODE;

CREATE FUNCTION whaleu_ratings.target_edit_intent_valid(i jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT coalesce(jsonb_typeof(i)='object'
  AND i-ARRAY['clientRequestId','targetId','regionId','expectedTargetRevision','expectedDefinitionRevision','expectedContentVersion','categoryId','expectedCategoryRevision','expectedCatalogRevision','name','description','assetIds']='{}'::jsonb
  AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['clientRequestId','targetId','expectedTargetRevision','expectedDefinitionRevision','categoryId','expectedCategoryRevision','expectedCatalogRevision']) k
   WHERE jsonb_typeof(i->k) IS DISTINCT FROM 'string' OR NOT whaleu_ratings.owner_delete_id_valid(i->>k))
  AND (i->'regionId'='null'::jsonb OR (jsonb_typeof(i->'regionId')='string' AND whaleu_ratings.owner_delete_id_valid(i->>'regionId')))
  AND jsonb_typeof(i->'expectedContentVersion')='number' AND i->>'expectedContentVersion' ~ '^[1-9][0-9]{0,9}$'
  AND (i->>'expectedContentVersion')::numeric BETWEEN 1 AND 2147483646
  AND jsonb_typeof(i->'name')='string' AND whaleu_ratings.canonical_text(i->>'name',100)
  AND jsonb_typeof(i->'description')='string' AND (i->>'description'='' OR whaleu_ratings.canonical_text(i->>'description',500))
  AND i->'assetIds'='[]'::jsonb,false)
$$;
CREATE FUNCTION whaleu_ratings.target_edit_intent_hash(i jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT encode(sha256(convert_to(E'whaleu:rating-target-edit:v1\n'||whaleu_ratings.creation_canonical_json(jsonb_build_object('operation','edit_target','intent',i)),'UTF8')),'hex')
$$;
CREATE TABLE whaleu_ratings.target_definition_versions (
 target_id uuid NOT NULL REFERENCES whaleu_ratings.targets(id),content_version integer NOT NULL CHECK(content_version>=1),
 definition_revision uuid NOT NULL,applied_target_revision uuid NOT NULL,name text NOT NULL,description text NOT NULL,envelope jsonb NOT NULL,
 publication_transaction xid8 NOT NULL,published_at timestamptz NOT NULL CHECK(isfinite(published_at)),
 PRIMARY KEY(target_id,content_version),UNIQUE(target_id,definition_revision),UNIQUE(target_id,content_version,definition_revision),
 CHECK(jsonb_typeof(envelope)='object'),CHECK(whaleu_ratings.owner_delete_id_valid(definition_revision::text)),
 CHECK(whaleu_ratings.owner_delete_id_valid(applied_target_revision::text)),
 CHECK(content_version=1 OR (whaleu_ratings.canonical_text(name,100) AND (description='' OR whaleu_ratings.canonical_text(description,500))))
);
CREATE TABLE whaleu_ratings.target_definition_heads (
 target_id uuid PRIMARY KEY REFERENCES whaleu_ratings.targets(id),content_version integer NOT NULL,definition_revision uuid NOT NULL,
 FOREIGN KEY(target_id,content_version,definition_revision) REFERENCES whaleu_ratings.target_definition_versions(target_id,content_version,definition_revision)
);
CREATE TABLE whaleu_ratings.target_definition_lifecycles (
 target_id uuid NOT NULL,target_revision uuid NOT NULL,content_version integer NOT NULL,definition_revision uuid NOT NULL,
 PRIMARY KEY(target_id,target_revision),
 FOREIGN KEY(target_id,target_revision) REFERENCES whaleu_ratings.target_state_revisions(target_id,revision),
 FOREIGN KEY(target_id,content_version,definition_revision) REFERENCES whaleu_ratings.target_definition_versions(target_id,content_version,definition_revision)
);
-- Validate historical structure without invoking creation-time/current-xid
-- guards and without treating revoked/unknown Review evidence as current allow.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM whaleu_ratings.targets t
  LEFT JOIN whaleu_community.rating_approval_bindings b ON b.kind='target' AND b.subject_id=t.id
  LEFT JOIN whaleu_community.rating_approval_decisions d ON d.id=b.decision_id
  WHERE NOT coalesce(t.content_version=1 AND whaleu_community.rating_envelope_shape(t.envelope,'publish_rating_target')
   AND t.envelope->>'accountId'=t.creator_id::text AND t.envelope->>'targetId'=t.id::text
   AND whaleu_ratings.owner_delete_id_valid(t.envelope->>'targetRevision')
   AND t.envelope->>'categoryId'=t.category_id::text AND t.envelope->>'name'=t.name AND t.envelope->>'description'=t.description
   AND (t.envelope->'scope'->>'regionId') IS NOT DISTINCT FROM t.region_id::text
   AND b.subject_id=t.id AND b.content_version=1 AND b.account_id=t.creator_id AND b.operation='publish_rating_target' AND b.envelope_version=1
   AND b.envelope=t.envelope AND b.scope=t.envelope->'scope' AND b.publication_transaction=t.creation_transaction
   AND d.id=b.decision_id AND d.account_id=b.account_id AND d.operation=b.operation AND d.envelope_version=b.envelope_version AND d.envelope=b.envelope
   AND d.digest=b.digest AND b.digest=encode(sha256(convert_to('whaleu-rating-content-approval:v1'||chr(10)||whaleu_community.content_canonical_json(t.envelope),'UTF8')),'hex')
   AND isfinite(b.bound_at) AND b.bound_at>=d.evaluated_at
   AND EXISTS(SELECT 1 FROM whaleu_ratings.categories c WHERE c.catalog_id=(t.envelope->>'catalogRevision')::uuid AND c.id=t.category_id AND c.revision::text=t.envelope->>'categoryRevision')
   AND EXISTS(SELECT 1 FROM whaleu_ratings.target_state_revisions s WHERE s.target_id=t.id AND s.revision::text=t.envelope->>'targetRevision' AND s.mutation_transaction=t.creation_transaction)
   AND EXISTS(SELECT 1 FROM whaleu_ratings.target_state_revisions s WHERE s.target_id=t.id AND s.revision=t.revision AND s.active=t.active),false))
 THEN RAISE EXCEPTION 'Historical target definition/binding structure is inconsistent' USING ERRCODE='23514';END IF;
 END $$;
INSERT INTO whaleu_ratings.target_definition_versions(target_id,content_version,definition_revision,applied_target_revision,name,description,envelope,publication_transaction,published_at)
 SELECT id,1,(envelope->>'targetRevision')::uuid,(envelope->>'targetRevision')::uuid,name,description,envelope,creation_transaction,created_at FROM whaleu_ratings.targets;
INSERT INTO whaleu_ratings.target_definition_heads(target_id,content_version,definition_revision)
 SELECT target_id,1,definition_revision FROM whaleu_ratings.target_definition_versions;
INSERT INTO whaleu_ratings.target_definition_lifecycles(target_id,target_revision,content_version,definition_revision)
 SELECT s.target_id,s.revision,1,v.definition_revision FROM whaleu_ratings.target_state_revisions s JOIN whaleu_ratings.target_definition_versions v ON v.target_id=s.target_id AND v.content_version=1;

CREATE TABLE whaleu_ratings.target_edit_preparations (
 account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,intent_hash text NOT NULL,
 session_id uuid NOT NULL,context_revision text NOT NULL UNIQUE CHECK(context_revision ~ '^[A-Za-z0-9_-]{43}$'),target_id uuid NOT NULL REFERENCES whaleu_ratings.targets(id),
 before_revision uuid NOT NULL,before_definition_revision uuid NOT NULL,before_content_version integer NOT NULL,
 after_revision uuid NOT NULL,definition_revision uuid NOT NULL,content_version integer NOT NULL,intent jsonb NOT NULL,envelope jsonb NOT NULL,
 valid_until timestamptz NOT NULL,prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(),preparation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 PRIMARY KEY(account_id,request_id),UNIQUE(target_id,after_revision),UNIQUE(target_id,definition_revision),
 FOREIGN KEY(account_id,request_id) REFERENCES whaleu_ratings.command_claims(account_id,request_id),
 FOREIGN KEY(target_id,before_revision) REFERENCES whaleu_ratings.target_state_revisions(target_id,revision),
 FOREIGN KEY(target_id,before_content_version,before_definition_revision) REFERENCES whaleu_ratings.target_definition_versions(target_id,content_version,definition_revision),
 CHECK(whaleu_ratings.target_edit_intent_valid(intent)),CHECK(intent_hash=whaleu_ratings.target_edit_intent_hash(intent)),
 CHECK(intent->>'clientRequestId'=request_id::text AND intent->>'targetId'=target_id::text AND intent->>'expectedTargetRevision'=before_revision::text
  AND intent->>'expectedDefinitionRevision'=before_definition_revision::text AND (intent->>'expectedContentVersion')::integer=before_content_version),
 CHECK(before_content_version BETWEEN 1 AND 2147483646 AND content_version=before_content_version+1),
 CHECK(after_revision<>before_revision AND definition_revision<>before_definition_revision),
 CHECK(whaleu_ratings.owner_delete_id_valid(after_revision::text) AND whaleu_ratings.owner_delete_id_valid(definition_revision::text)),
 CHECK(isfinite(prepared_at) AND isfinite(valid_until) AND valid_until>prepared_at AND valid_until<=prepared_at+interval '5 minutes')
);
CREATE TABLE whaleu_ratings.target_edit_transitions (
 id uuid PRIMARY KEY,actor_account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,intent_hash text NOT NULL,intent jsonb NOT NULL,
 target_id uuid NOT NULL REFERENCES whaleu_ratings.targets(id),before_revision uuid NOT NULL,after_revision uuid NOT NULL,
 before_definition_revision uuid NOT NULL,after_definition_revision uuid NOT NULL,before_content_version integer NOT NULL,after_content_version integer NOT NULL,
 context_revision text NOT NULL,occurred_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(occurred_at)),mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 UNIQUE(actor_account_id,request_id),UNIQUE(target_id,after_revision),UNIQUE(target_id,mutation_transaction),UNIQUE(target_id,after_content_version),
 FOREIGN KEY(actor_account_id,request_id) REFERENCES whaleu_ratings.requests(account_id,request_id),
 FOREIGN KEY(actor_account_id,request_id) REFERENCES whaleu_ratings.target_edit_preparations(account_id,request_id),
 CHECK(whaleu_ratings.target_edit_intent_valid(intent)),CHECK(intent_hash=whaleu_ratings.target_edit_intent_hash(intent)),
 CHECK(intent->>'clientRequestId'=request_id::text AND intent->>'targetId'=target_id::text AND intent->>'expectedTargetRevision'=before_revision::text
  AND intent->>'expectedDefinitionRevision'=before_definition_revision::text AND (intent->>'expectedContentVersion')::integer=before_content_version),
 CHECK(before_content_version BETWEEN 1 AND 2147483646 AND after_content_version=before_content_version+1),
 CHECK(before_revision<>after_revision AND before_definition_revision<>after_definition_revision)
);
CREATE TABLE whaleu_ratings.target_edit_noops (
 actor_account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,intent_hash text NOT NULL,intent jsonb NOT NULL,
 target_id uuid NOT NULL REFERENCES whaleu_ratings.targets(id),revision uuid NOT NULL,definition_revision uuid NOT NULL,content_version integer NOT NULL,context_revision text NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(occurred_at)),mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 PRIMARY KEY(actor_account_id,request_id),FOREIGN KEY(actor_account_id,request_id) REFERENCES whaleu_ratings.requests(account_id,request_id),
 FOREIGN KEY(actor_account_id,request_id) REFERENCES whaleu_ratings.target_edit_preparations(account_id,request_id),
 FOREIGN KEY(target_id,revision) REFERENCES whaleu_ratings.target_state_revisions(target_id,revision),
 FOREIGN KEY(target_id,content_version,definition_revision) REFERENCES whaleu_ratings.target_definition_versions(target_id,content_version,definition_revision),
 CHECK(whaleu_ratings.target_edit_intent_valid(intent)),CHECK(intent_hash=whaleu_ratings.target_edit_intent_hash(intent)),
 CHECK(intent->>'clientRequestId'=request_id::text AND intent->>'targetId'=target_id::text AND intent->>'expectedTargetRevision'=revision::text
  AND intent->>'expectedDefinitionRevision'=definition_revision::text AND (intent->>'expectedContentVersion')::integer=content_version)
);
CREATE TABLE whaleu_ratings.target_edit_closures (
 actor_account_id uuid NOT NULL,request_id uuid NOT NULL,intent_hash text NOT NULL,intent jsonb NOT NULL,
 code text NOT NULL CHECK(code IN ('RATING_EDIT_CONTEXT_CHANGED','CONTENT_REJECTED','RATING_EDIT_CANCELLED','RATING_NOT_FOUND','PHONE_VERIFICATION_REQUIRED','AFFILIATION_VERIFICATION_REQUIRED','IDENTITY_CAMPUS_REQUIRED','SAFETY_ACTION_RESTRICTED')),
 mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),PRIMARY KEY(actor_account_id,request_id),
 FOREIGN KEY(actor_account_id,request_id) REFERENCES whaleu_ratings.requests(account_id,request_id),
 CHECK(whaleu_ratings.target_edit_intent_valid(intent)),CHECK(intent_hash=whaleu_ratings.target_edit_intent_hash(intent)),CHECK(intent->>'clientRequestId'=request_id::text)
);
-- REVIEW_FRAGMENT_START: Review-owned v3 shape and exact current evidence.
-- M2B Review Owner fragment, to be included in the single atomic 0057 migration.
-- Prerequisites: migrations through 0056, including canonical Review decision,
-- policy, binding and epoch functions. This fragment reads no Ratings rows.
-- Integrator MUST add, before the migration commits:
--  (1) the new binding's deferred Ratings definition/edit reverse verifier;
--  (2) the exact new binding <-> definition tuple FK, if used by Ratings;
--  (3) an a0 statement writer for the EDIT-ONLY binding table, if the agreed
--      Ratings lock protocol requires common gate -> pool/navigation fences.
-- Do not attach that writer to the legacy comment/reply/publication table.

CREATE FUNCTION whaleu_community.rating_target_edit_uuid_valid(value text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT coalesce(value ~ '^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$',false)
$$;
CREATE FUNCTION whaleu_community.rating_target_edit_text_valid(value text,maximum integer,required boolean) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT coalesce(value IS NOT NULL AND length(value) BETWEEN CASE WHEN required THEN 1 ELSE 0 END AND maximum
  AND value=btrim(value,E'\t\n\f\r '||chr(11)||chr(160)||chr(5760)||chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)||chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279))
  AND value !~ U&'[\0001-\0008\000B-\001F\007F-\009F]',false)
$$;
CREATE FUNCTION whaleu_community.rating_target_edit_envelope_shape(e jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT coalesce(
  jsonb_typeof(e)='object' AND e->'version'='3'::jsonb AND e->>'purpose'='edit_rating_target'
  AND whaleu_community.rating_envelope_shape_v1(
    (e-ARRAY['previousTargetRevision','previousDefinitionRevision','definitionRevision','contentVersion'])
      ||jsonb_build_object('version',1,'purpose','publish_rating_target'),'publish_rating_target')
  AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['accountId','clientRequestId','targetId','targetRevision','categoryId','categoryRevision','catalogRevision','previousTargetRevision','previousDefinitionRevision','definitionRevision']) k
    WHERE jsonb_typeof(e->k) IS DISTINCT FROM 'string' OR NOT whaleu_community.rating_target_edit_uuid_valid(e->>k))
  AND (e->'scope'->'regionId'='null'::jsonb OR whaleu_community.rating_target_edit_uuid_valid(e->'scope'->>'regionId'))
  AND CASE WHEN jsonb_typeof(e->'contentVersion')='number' THEN
    (e->>'contentVersion')::numeric BETWEEN 2 AND 2147483647
    AND trunc((e->>'contentVersion')::numeric)=(e->>'contentVersion')::numeric ELSE false END
  AND e->>'previousTargetRevision'<>e->>'targetRevision'
  AND e->>'previousDefinitionRevision'<>e->>'definitionRevision'
  AND whaleu_community.rating_target_edit_text_valid(e->>'name',100,true)
  AND whaleu_community.rating_target_edit_text_valid(e->>'description',500,false),false)
$$;

-- Preserve the function OID referenced by existing CHECK constraints. The old
-- v1 and reply-v2 branches retain their original predicates unchanged.
CREATE OR REPLACE FUNCTION whaleu_community.rating_envelope_shape(e jsonb,op text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN op='edit_rating_target' THEN whaleu_community.rating_target_edit_envelope_shape(e)
 WHEN op<>'publish_rating_reply' THEN whaleu_community.rating_envelope_shape_v1(e,op) ELSE coalesce(
 e->'version'='2'::jsonb AND e->>'purpose'=op AND
 whaleu_community.rating_envelope_shape_v1((e-ARRAY['rootId','rootRevision','replyTo'])||jsonb_build_object('version',1,'purpose','publish_rating_comment'),'publish_rating_comment') AND
 NOT EXISTS(SELECT 1 FROM unnest(ARRAY['rootId','rootRevision']) k WHERE jsonb_typeof(e->k) IS DISTINCT FROM 'string' OR NOT coalesce(e->>k ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',false)) AND
 (e->'replyTo'='null'::jsonb OR (jsonb_typeof(e->'replyTo')='object' AND ((e->'replyTo')-ARRAY['replyId','revision'])='{}'::jsonb AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['replyId','revision']) k WHERE jsonb_typeof(e->'replyTo'->k) IS DISTINCT FROM 'string' OR NOT coalesce(e->'replyTo'->>k ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',false)))),false) END
$$;

-- 0045's discriminator is the single CHECK referencing exactly operation and
-- envelope_version. Discover only that exact column set, fail on ambiguity,
-- and replace only that one constraint. Digest, shape, actor, metadata, time,
-- foreign keys and every old binding constraint remain in place.
DO $$
DECLARE names text[];columns smallint[];definition text;
BEGIN
 SELECT array_agg(attnum::smallint ORDER BY attnum) INTO columns FROM pg_attribute
  WHERE attrelid='whaleu_community.rating_approval_decisions'::regclass AND attname IN ('operation','envelope_version') AND NOT attisdropped;
 IF cardinality(columns) IS DISTINCT FROM 2 THEN RAISE EXCEPTION 'Rating decision discriminator columns missing' USING ERRCODE='23514'; END IF;
 SELECT array_agg(conname) INTO names FROM pg_constraint c
  WHERE conrelid='whaleu_community.rating_approval_decisions'::regclass AND contype='c'
    AND ARRAY(SELECT k FROM unnest(c.conkey) k ORDER BY k)=columns;
 IF cardinality(names) IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'Rating decision discriminator is missing or ambiguous' USING ERRCODE='23514'; END IF;
 SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
  WHERE conrelid='whaleu_community.rating_approval_decisions'::regclass AND conname=names[1];
 IF definition NOT LIKE '%publish_rating_target%' OR definition NOT LIKE '%publish_rating_comment%' OR definition NOT LIKE '%publish_rating_reply%' OR definition LIKE '%edit_rating_target%' THEN
  RAISE EXCEPTION 'Unexpected rating decision discriminator baseline' USING ERRCODE='23514';
 END IF;
 EXECUTE format('ALTER TABLE whaleu_community.rating_approval_decisions DROP CONSTRAINT %I',names[1]);
END $$;
ALTER TABLE whaleu_community.rating_approval_decisions ADD CONSTRAINT rating_decision_protocol_v3 CHECK(
 (operation IN ('publish_rating_target','publish_rating_comment') AND envelope_version=1)
 OR (operation='publish_rating_reply' AND envelope_version=2)
 OR (operation='edit_rating_target' AND envelope_version=3));

CREATE TABLE whaleu_community.rating_target_definition_bindings (
 target_id uuid NOT NULL,content_version integer NOT NULL CHECK(content_version>=2),definition_revision uuid NOT NULL,
 decision_id uuid NOT NULL UNIQUE,account_id uuid NOT NULL,
 operation text NOT NULL CHECK(operation='edit_rating_target'),envelope_version integer NOT NULL CHECK(envelope_version=3),
 digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),envelope jsonb NOT NULL,scope jsonb NOT NULL,
 bound_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(bound_at)),
 publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 PRIMARY KEY(target_id,content_version),UNIQUE(target_id,definition_revision),
 FOREIGN KEY(decision_id,account_id,operation,envelope_version,digest)
  REFERENCES whaleu_community.rating_approval_decisions(id,account_id,operation,envelope_version,digest),
 CHECK(whaleu_community.rating_target_edit_envelope_shape(envelope)),
 CHECK(envelope->>'targetId'=target_id::text AND envelope->>'accountId'=account_id::text
  AND (envelope->>'contentVersion')::numeric=content_version AND envelope->>'definitionRevision'=definition_revision::text),
 CHECK(scope=envelope->'scope'),
 CHECK(digest=encode(sha256(convert_to('whaleu-rating-content-approval:v3'||chr(10)||whaleu_community.content_canonical_json(envelope),'UTF8')),'hex'))
);
CREATE FUNCTION whaleu_community.rating_target_definition_binding_validate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE decision whaleu_community.rating_approval_decisions;instant timestamptz;accepted boolean;
BEGIN
 SELECT * INTO decision FROM whaleu_community.rating_approval_decisions WHERE id=NEW.decision_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Target definition Review decision absent' USING ERRCODE='23514'; END IF;
 PERFORM id FROM whaleu_identity.accounts WHERE id=decision.account_id FOR SHARE;
 PERFORM decision_id FROM whaleu_community.rating_approval_heads WHERE decision_id=decision.id FOR SHARE;
 instant:=clock_timestamp();
 SELECT coalesce(d.result='allow' AND d.coverage='complete' AND d.provenance='accepted'
  AND p.policy_key='local-explicit-v1' AND p.version=1 AND p.coverage='complete' AND p.provenance='accepted'
  AND e.state='allow' AND e.coverage='complete' AND e.provenance='accepted'
  AND isfinite(d.evaluated_at) AND d.evaluated_at<=instant
  AND isfinite(p.valid_from) AND p.valid_from<=d.evaluated_at AND (p.valid_until IS NULL OR (isfinite(p.valid_until) AND p.valid_until>instant))
  AND isfinite(e.occurred_at) AND e.occurred_at>=d.evaluated_at AND e.occurred_at<=instant
  AND isfinite(d.consume_until) AND d.consume_until>d.evaluated_at AND d.consume_until>instant
  AND ((d.visibility_model='durable' AND d.visibility_until IS NULL) OR
    (d.visibility_model='until' AND isfinite(d.visibility_until) AND d.visibility_until>d.evaluated_at AND d.visibility_until>instant)),false)
 INTO accepted FROM whaleu_community.rating_approval_decisions d
 JOIN whaleu_community.content_approval_policies p ON p.id=d.policy_revision_id
 JOIN whaleu_community.rating_approval_heads h ON h.decision_id=d.id
 JOIN whaleu_community.rating_approval_events e ON e.id=h.event_id AND e.decision_id=d.id WHERE d.id=decision.id;
 IF NOT coalesce(accepted,false) OR decision.operation IS DISTINCT FROM 'edit_rating_target' OR decision.envelope_version IS DISTINCT FROM 3
  OR (NEW.account_id,NEW.operation,NEW.envelope_version,NEW.digest,NEW.envelope)
    IS DISTINCT FROM (decision.account_id,decision.operation,decision.envelope_version,decision.digest,decision.envelope)
  OR NEW.publication_transaction IS DISTINCT FROM pg_current_xact_id()
  OR EXISTS(SELECT 1 FROM whaleu_community.rating_approval_bindings WHERE decision_id=decision.id)
  OR EXISTS(SELECT 1 FROM whaleu_community.rating_approval_decisions d WHERE d.account_id=decision.account_id
    AND d.operation=decision.operation AND d.envelope_version=decision.envelope_version AND d.digest=decision.digest
    AND (d.evaluated_at,d.id)>(decision.evaluated_at,decision.id)) THEN
  RAISE EXCEPTION 'Target definition exact Review mismatch' USING ERRCODE='23514';
 END IF;
 NEW.bound_at:=instant;
 RETURN NEW;
END $$;
CREATE TRIGGER rating_target_definition_binding_validate BEFORE INSERT ON whaleu_community.rating_target_definition_bindings
 FOR EACH ROW EXECUTE FUNCTION whaleu_community.rating_target_definition_binding_validate();
CREATE TRIGGER a1_rating_target_definition_binding_epoch BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.rating_target_definition_bindings
 FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.advance_rating_review_binding_epoch();
CREATE TRIGGER rating_target_definition_binding_immutable BEFORE UPDATE OR DELETE ON whaleu_community.rating_target_definition_bindings
 FOR EACH ROW EXECUTE FUNCTION whaleu_community.content_approval_immutable();
CREATE TRIGGER rating_target_definition_binding_retain BEFORE TRUNCATE ON whaleu_community.rating_target_definition_bindings
 FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_approval_immutable();

-- Exact current (not consumption) Review qualification for Ratings SQL guards.
-- The caller owns the current head and common gate; this function only checks
-- the supplied immutable descriptor against Review. It never searches Ratings
-- history, falls back to an older version, or grants creator/current-head status.
CREATE FUNCTION whaleu_community.rating_target_definition_current(
 _target uuid,_content_version integer,_definition_revision uuid,_applied_target_revision uuid,_envelope jsonb
) RETURNS boolean LANGUAGE sql AS $$
 WITH instant AS MATERIALIZED (SELECT clock_timestamp() now),binding AS (
  SELECT b.decision_id,b.account_id,b.operation,b.envelope_version,b.digest,b.envelope,b.scope,b.bound_at
   FROM whaleu_community.rating_approval_bindings b WHERE _content_version=1 AND b.kind='target' AND b.subject_id=_target AND b.content_version=1
  UNION ALL
  SELECT b.decision_id,b.account_id,b.operation,b.envelope_version,b.digest,b.envelope,b.scope,b.bound_at
   FROM whaleu_community.rating_target_definition_bindings b WHERE _content_version>=2 AND b.target_id=_target
    AND b.content_version=_content_version AND b.definition_revision=_definition_revision
 ) SELECT coalesce((SELECT
  whaleu_community.rating_envelope_shape(_envelope,b.operation)
  AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['accountId','clientRequestId','targetId','targetRevision','categoryId','categoryRevision','catalogRevision']) k
    WHERE NOT whaleu_community.rating_target_edit_uuid_valid(_envelope->>k))
  AND (_envelope->'scope'->'regionId'='null'::jsonb OR whaleu_community.rating_target_edit_uuid_valid(_envelope->'scope'->>'regionId'))
  AND whaleu_community.rating_target_edit_text_valid(_envelope->>'name',100,true)
  AND whaleu_community.rating_target_edit_text_valid(_envelope->>'description',500,false)
  AND _envelope->>'targetId'=_target::text AND _envelope->>'targetRevision'=_applied_target_revision::text
  AND ((_content_version=1 AND _definition_revision=_applied_target_revision AND b.operation='publish_rating_target' AND b.envelope_version=1)
    OR (_content_version>=2 AND b.operation='edit_rating_target' AND b.envelope_version=3
      AND _envelope->>'definitionRevision'=_definition_revision::text AND _envelope->'contentVersion'=to_jsonb(_content_version)))
  AND b.envelope=_envelope AND b.scope=_envelope->'scope' AND b.account_id::text=_envelope->>'accountId'
  AND (d.account_id,d.operation,d.envelope_version,d.digest,d.envelope)=(b.account_id,b.operation,b.envelope_version,b.digest,b.envelope)
  AND d.digest=encode(sha256(convert_to('whaleu-rating-content-approval:v'||d.envelope_version::text||chr(10)||whaleu_community.content_canonical_json(_envelope),'UTF8')),'hex')
  AND d.result='allow' AND d.coverage='complete' AND d.provenance='accepted'
  AND p.policy_key='local-explicit-v1' AND p.version=1 AND p.coverage='complete' AND p.provenance='accepted'
  AND e.state='allow' AND e.coverage='complete' AND e.provenance='accepted'
  AND length(btrim(d.issuer))>0 AND length(btrim(d.provenance_ref))>0
  AND length(btrim(p.issuer))>0 AND length(btrim(p.provenance_ref))>0
  AND length(btrim(e.issuer))>0 AND length(btrim(e.provenance_ref))>0
  AND isfinite(d.evaluated_at) AND d.evaluated_at<=instant.now
  AND isfinite(p.valid_from) AND p.valid_from<=d.evaluated_at AND (p.valid_until IS NULL OR (isfinite(p.valid_until) AND p.valid_until>instant.now))
  AND isfinite(e.occurred_at) AND e.occurred_at>=d.evaluated_at AND e.occurred_at<=instant.now
  AND isfinite(d.consume_until) AND d.consume_until>d.evaluated_at
  AND ((d.visibility_model='durable' AND d.visibility_until IS NULL) OR (d.visibility_model='until'
    AND isfinite(d.visibility_until) AND d.visibility_until>d.evaluated_at AND d.visibility_until>instant.now))
  AND isfinite(b.bound_at) AND b.bound_at>=d.evaluated_at AND b.bound_at<=instant.now
 FROM binding b JOIN whaleu_community.rating_approval_decisions d ON d.id=b.decision_id
 JOIN whaleu_identity.accounts a ON a.id=d.account_id
 JOIN whaleu_community.content_approval_policies p ON p.id=d.policy_revision_id
 JOIN whaleu_community.rating_approval_heads h ON h.decision_id=d.id
 JOIN whaleu_community.rating_approval_events e ON e.id=h.event_id AND e.decision_id=d.id CROSS JOIN instant),false)
$$;

-- REVIEW_FRAGMENT_END

CREATE FUNCTION whaleu_ratings.target_edit_writer() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
 LOCK TABLE whaleu_ratings.random_pool_epoch,whaleu_ratings.navigation_epoch IN ROW EXCLUSIVE MODE;
 RETURN NULL;
END $$;
DO $$ DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['target_definition_versions','target_definition_heads','target_definition_lifecycles','target_edit_preparations','target_edit_transitions','target_edit_noops','target_edit_closures'] LOOP
  EXECUTE format('CREATE TRIGGER a0_rating_edit_writer BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.target_edit_writer()',tab);
  EXECUTE format('CREATE TRIGGER rating_edit_retain BEFORE TRUNCATE ON whaleu_ratings.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.immutable()',tab);
  IF tab<>'target_definition_heads' THEN
   EXECUTE format('CREATE TRIGGER rating_edit_immutable BEFORE UPDATE OR DELETE ON whaleu_ratings.%I FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.immutable()',tab);
  END IF;
 END LOOP;
 FOREACH tab IN ARRAY ARRAY['target_definition_versions','target_definition_heads','target_definition_lifecycles'] LOOP
  EXECUTE format('CREATE TRIGGER a1_rating_edit_pool BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.advance_random_pool_epoch()',tab);
  EXECUTE format('CREATE TRIGGER a2_rating_edit_navigation BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.advance_navigation_epoch()',tab);
 END LOOP;
END $$;
-- Independent raw state/binding statements follow the same order, including
-- zero-row writes. Existing ordinary score and v1/v2 binding writers are unchanged.
CREATE TRIGGER a00_rating_edit_state_writer BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.target_state_revisions FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.target_edit_writer();
CREATE TRIGGER a0_rating_edit_binding_writer BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.rating_target_definition_bindings FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.target_edit_writer();
ALTER TABLE whaleu_community.rating_target_definition_bindings ADD FOREIGN KEY(target_id,content_version,definition_revision)
 REFERENCES whaleu_ratings.target_definition_versions(target_id,content_version,definition_revision);

CREATE OR REPLACE FUNCTION whaleu_ratings.claim_command() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c whaleu_ratings.command_claims;op text;
BEGIN
 IF TG_TABLE_NAME='target_preparations' THEN op:='create_target';
 ELSIF TG_TABLE_NAME='target_edit_preparations' THEN op:='edit_target';ELSE op:=NEW.operation;END IF;
 INSERT INTO whaleu_ratings.command_claims VALUES(NEW.account_id,NEW.request_id,op,NEW.intent_hash) ON CONFLICT DO NOTHING;
 SELECT * INTO c FROM whaleu_ratings.command_claims WHERE account_id=NEW.account_id AND request_id=NEW.request_id FOR UPDATE;
 IF ROW(c.operation,c.intent_hash) IS DISTINCT FROM ROW(op,NEW.intent_hash) THEN RAISE EXCEPTION 'Command namespace conflict' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER a1_rating_edit_preparation_claim BEFORE INSERT ON whaleu_ratings.target_edit_preparations FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.claim_command();
CREATE FUNCTION whaleu_ratings.target_edit_envelope(p whaleu_ratings.target_edit_preparations) RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT jsonb_build_object('version',3,'purpose','edit_rating_target','accountId',(p).account_id,'clientRequestId',(p).request_id,
  'targetId',(p).target_id,'previousTargetRevision',(p).before_revision,'targetRevision',(p).after_revision,
  'previousDefinitionRevision',(p).before_definition_revision,'definitionRevision',(p).definition_revision,'contentVersion',(p).content_version,
  'categoryId',(p).intent->'categoryId','categoryRevision',(p).intent->'expectedCategoryRevision','catalogRevision',(p).intent->'expectedCatalogRevision',
  'scope',jsonb_build_object('regionId',(p).intent->'regionId'),'name',(p).intent->'name','description',(p).intent->'description','assetIds','[]'::jsonb)
$$;
CREATE FUNCTION whaleu_ratings.target_edit_session_current(actor uuid,session uuid,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_identity.sessions s JOIN whaleu_identity.accounts a ON a.id=s.account_id
  WHERE s.id=session AND s.account_id=actor AND a.status='active' AND s.revoked_at IS NULL
   AND s.created_at<=instant AND s.access_expires_at>instant AND s.refresh_expires_at>instant AND s.absolute_expires_at>instant)
$$;
CREATE FUNCTION whaleu_ratings.target_edit_catalog_current(target uuid,i jsonb,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 WITH RECURSIVE path AS (
  SELECT c.*,1 depth FROM whaleu_ratings.categories c WHERE c.catalog_id=(i->>'expectedCatalogRevision')::uuid AND c.id=(i->>'categoryId')::uuid
  UNION ALL SELECT c.*,p.depth+1 FROM whaleu_ratings.categories c JOIN path p ON c.catalog_id=p.catalog_id AND c.id=p.parent_id AND c.level=p.level-1 WHERE p.depth<3
 )
 SELECT EXISTS(SELECT 1 FROM whaleu_ratings.targets t
  JOIN whaleu_ratings.catalog_heads h ON h.scope_key=coalesce(t.region_id::text,'global') AND h.region_id IS NOT DISTINCT FROM t.region_id
  JOIN whaleu_ratings.catalogs c ON c.id=h.catalog_id AND c.region_id IS NOT DISTINCT FROM t.region_id
  JOIN whaleu_ratings.target_memberships m ON m.catalog_id=c.id AND m.target_id=t.id AND m.category_id=t.category_id
  JOIN whaleu_ratings.categories leaf ON leaf.catalog_id=c.id AND leaf.id=t.category_id
  WHERE t.id=target AND t.id::text=i->>'targetId' AND t.category_id::text=i->>'categoryId'
   AND t.region_id::text IS NOT DISTINCT FROM i->>'regionId' AND c.id::text=i->>'expectedCatalogRevision'
   AND c.sealed AND c.coverage='complete' AND c.provenance='accepted' AND c.effective_at<=instant AND (c.valid_until IS NULL OR c.valid_until>instant)
   AND leaf.kind='general' AND leaf.revision::text=i->>'expectedCategoryRevision'
   AND (SELECT count(*) FROM path)=leaf.level AND EXISTS(SELECT 1 FROM path WHERE level=1 AND parent_id IS NULL)
   AND NOT EXISTS(SELECT 1 FROM path WHERE NOT active OR hidden OR kind<>'general')
   AND (SELECT count(*) FROM (SELECT 1 FROM whaleu_ratings.categories x WHERE x.catalog_id=c.id LIMIT 10001) budget)<=10000
   AND (SELECT count(*) FROM (SELECT 1 FROM whaleu_ratings.target_memberships x WHERE x.catalog_id=c.id LIMIT 100001) budget)<=100000)
$$;
CREATE FUNCTION whaleu_ratings.assert_target_edit_before(p whaleu_ratings.target_edit_preparations,instant timestamptz) RETURNS void LANGUAGE plpgsql AS $$
DECLARE t whaleu_ratings.targets;h whaleu_ratings.target_definition_heads;v whaleu_ratings.target_definition_versions;
BEGIN
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=p.target_id FOR UPDATE NOWAIT;
 SELECT * INTO h FROM whaleu_ratings.target_definition_heads WHERE target_id=p.target_id FOR UPDATE NOWAIT;
 SELECT * INTO v FROM whaleu_ratings.target_definition_versions WHERE target_id=p.target_id AND content_version=p.before_content_version;
 PERFORM id FROM whaleu_identity.sessions WHERE id=p.session_id AND account_id=p.account_id FOR SHARE NOWAIT;
 IF NOT coalesce(t.id IS NOT NULL AND t.creator_id=p.account_id AND t.active AND t.revision=p.before_revision
  AND (h.content_version,h.definition_revision)=(p.before_content_version,p.before_definition_revision)
  AND v.definition_revision=p.before_definition_revision AND v.published_at<=instant
  AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.target_owner_tombstones WHERE target_id=t.id)
  AND EXISTS(SELECT 1 FROM whaleu_ratings.target_state_revisions s JOIN whaleu_ratings.target_definition_lifecycles l ON l.target_id=s.target_id AND l.target_revision=s.revision
   WHERE s.target_id=t.id AND s.revision=p.before_revision AND s.active AND s.occurred_at<=instant AND l.content_version=p.before_content_version AND l.definition_revision=p.before_definition_revision)
  AND whaleu_ratings.target_edit_session_current(p.account_id,p.session_id,instant)
  AND whaleu_ratings.target_edit_catalog_current(p.target_id,p.intent,instant)
  AND whaleu_community.rating_target_definition_current(v.target_id,v.content_version,v.definition_revision,v.applied_target_revision,v.envelope),false)
 THEN RAISE EXCEPTION 'Target edit current before-context mismatch' USING ERRCODE='23514';END IF;
END $$;
CREATE FUNCTION whaleu_ratings.target_edit_preparation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.prepared_at:=clock_timestamp();
 IF NOT coalesce(NEW.preparation_transaction=pg_current_xact_id() AND NEW.valid_until>NEW.prepared_at AND NEW.valid_until<=NEW.prepared_at+interval '5 minutes'
  AND whaleu_ratings.target_edit_intent_valid(NEW.intent) AND NEW.intent_hash=whaleu_ratings.target_edit_intent_hash(NEW.intent)
  AND NEW.envelope=whaleu_ratings.target_edit_envelope(NEW) AND whaleu_community.rating_envelope_shape(NEW.envelope,'edit_rating_target')
  AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.requests q WHERE q.account_id=NEW.account_id AND q.request_id=NEW.request_id AND q.receipt IS NOT NULL)
  AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.target_state_revisions WHERE target_id=NEW.target_id AND revision=NEW.after_revision)
  AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.target_definition_versions WHERE target_id=NEW.target_id AND definition_revision=NEW.definition_revision),false)
 THEN RAISE EXCEPTION 'Target edit preparation definition mismatch' USING ERRCODE='23514';END IF;
 PERFORM whaleu_ratings.assert_target_edit_before(NEW,NEW.prepared_at);RETURN NEW;
END $$;
CREATE TRIGGER a2_rating_edit_preparation_guard BEFORE INSERT ON whaleu_ratings.target_edit_preparations FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.target_edit_preparation_guard();
CREATE FUNCTION whaleu_ratings.target_edit_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p whaleu_ratings.target_edit_preparations;q whaleu_ratings.requests;v whaleu_ratings.target_definition_versions;
BEGIN
 SELECT * INTO p FROM whaleu_ratings.target_edit_preparations WHERE account_id=NEW.actor_account_id AND request_id=NEW.request_id FOR SHARE NOWAIT;
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=NEW.actor_account_id AND request_id=NEW.request_id FOR UPDATE NOWAIT;
 NEW.occurred_at:=clock_timestamp();
 IF NOT coalesce(p.account_id=NEW.actor_account_id AND q.operation='edit_target' AND q.intent_hash=NEW.intent_hash AND q.receipt IS NULL
  AND NEW.mutation_transaction=pg_current_xact_id() AND p.prepared_at<=NEW.occurred_at AND p.valid_until>NEW.occurred_at
  AND (NEW.target_id,NEW.before_revision,NEW.after_revision,NEW.before_definition_revision,NEW.after_definition_revision,NEW.before_content_version,NEW.after_content_version,NEW.context_revision,NEW.intent_hash,NEW.intent)
   =(p.target_id,p.before_revision,p.after_revision,p.before_definition_revision,p.definition_revision,p.before_content_version,p.content_version,p.context_revision,p.intent_hash,p.intent)
  AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.target_edit_noops WHERE actor_account_id=NEW.actor_account_id AND request_id=NEW.request_id)
  AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.target_edit_closures WHERE actor_account_id=NEW.actor_account_id AND request_id=NEW.request_id)
  AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.target_state_revisions WHERE target_id=NEW.target_id AND (revision=NEW.after_revision OR mutation_transaction=pg_current_xact_id()))
  AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.target_definition_versions WHERE target_id=NEW.target_id AND (content_version=NEW.after_content_version OR definition_revision=NEW.after_definition_revision)),false)
 THEN RAISE EXCEPTION 'Target edit transition/preparation mismatch' USING ERRCODE='23514';END IF;
 PERFORM whaleu_ratings.assert_target_edit_before(p,NEW.occurred_at);
 SELECT * INTO v FROM whaleu_ratings.target_definition_versions WHERE target_id=p.target_id AND content_version=p.before_content_version;
 IF (v.name,v.description) IS NOT DISTINCT FROM (p.intent->>'name',p.intent->>'description')
 THEN RAISE EXCEPTION 'Unchanged target definition requires noop' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER rating_edit_transition_guard BEFORE INSERT ON whaleu_ratings.target_edit_transitions FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.target_edit_transition_guard();
CREATE FUNCTION whaleu_ratings.target_edit_noop_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p whaleu_ratings.target_edit_preparations;q whaleu_ratings.requests;v whaleu_ratings.target_definition_versions;
BEGIN
 SELECT * INTO p FROM whaleu_ratings.target_edit_preparations WHERE account_id=NEW.actor_account_id AND request_id=NEW.request_id FOR SHARE NOWAIT;
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=NEW.actor_account_id AND request_id=NEW.request_id FOR UPDATE NOWAIT;
 NEW.occurred_at:=clock_timestamp();
 IF NOT coalesce(p.account_id=NEW.actor_account_id AND q.operation='edit_target' AND q.intent_hash=NEW.intent_hash AND q.receipt IS NULL
  AND NEW.mutation_transaction=pg_current_xact_id() AND p.prepared_at<=NEW.occurred_at AND p.valid_until>NEW.occurred_at
  AND (NEW.target_id,NEW.revision,NEW.definition_revision,NEW.content_version,NEW.context_revision,NEW.intent_hash,NEW.intent)
   =(p.target_id,p.before_revision,p.before_definition_revision,p.before_content_version,p.context_revision,p.intent_hash,p.intent)
  AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.target_edit_transitions WHERE actor_account_id=NEW.actor_account_id AND request_id=NEW.request_id)
  AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.target_edit_closures WHERE actor_account_id=NEW.actor_account_id AND request_id=NEW.request_id),false)
 THEN RAISE EXCEPTION 'Target edit noop/preparation mismatch' USING ERRCODE='23514';END IF;
 PERFORM whaleu_ratings.assert_target_edit_before(p,NEW.occurred_at);
 SELECT * INTO v FROM whaleu_ratings.target_definition_versions WHERE target_id=p.target_id AND content_version=p.before_content_version;
 IF (v.name,v.description) IS DISTINCT FROM (p.intent->>'name',p.intent->>'description')
 THEN RAISE EXCEPTION 'Target edit noop requires identical normalized text' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER rating_edit_noop_guard BEFORE INSERT ON whaleu_ratings.target_edit_noops FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.target_edit_noop_guard();

CREATE FUNCTION whaleu_ratings.target_definition_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t whaleu_ratings.targets;e whaleu_ratings.target_edit_transitions;p whaleu_ratings.target_edit_preparations;h whaleu_ratings.target_definition_heads;
BEGIN
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=NEW.target_id FOR UPDATE NOWAIT;
 IF NEW.content_version=1 THEN
  IF NOT coalesce(pg_trigger_depth()>=2 AND t.id=NEW.target_id AND t.creation_transaction=pg_current_xact_id()
   AND (NEW.definition_revision,NEW.applied_target_revision,NEW.name,NEW.description,NEW.envelope,NEW.publication_transaction,NEW.published_at)
    =((t.envelope->>'targetRevision')::uuid,(t.envelope->>'targetRevision')::uuid,t.name,t.description,t.envelope,t.creation_transaction,t.created_at)
   AND t.revision::text=t.envelope->>'targetRevision' AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.target_definition_heads WHERE target_id=t.id),false)
  THEN RAISE EXCEPTION 'Initial target definition requires exact fresh target insertion' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO e FROM whaleu_ratings.target_edit_transitions WHERE target_id=NEW.target_id AND after_content_version=NEW.content_version;
  SELECT * INTO p FROM whaleu_ratings.target_edit_preparations WHERE account_id=e.actor_account_id AND request_id=e.request_id;
  SELECT * INTO h FROM whaleu_ratings.target_definition_heads WHERE target_id=NEW.target_id FOR UPDATE NOWAIT;
  IF NOT coalesce(e.id IS NOT NULL AND e.mutation_transaction=pg_current_xact_id() AND t.active AND t.creator_id=e.actor_account_id AND t.revision=e.before_revision
   AND (h.content_version,h.definition_revision)=(e.before_content_version,e.before_definition_revision)
   AND (NEW.definition_revision,NEW.applied_target_revision,NEW.name,NEW.description,NEW.envelope,NEW.publication_transaction,NEW.published_at)
    =(e.after_definition_revision,e.after_revision,p.intent->>'name',p.intent->>'description',p.envelope,e.mutation_transaction,e.occurred_at)
   AND whaleu_community.rating_envelope_shape(NEW.envelope,'edit_rating_target')
   AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.target_owner_tombstones WHERE target_id=t.id),false)
  THEN RAISE EXCEPTION 'Target definition version has no exact edit cause' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER rating_definition_version_guard BEFORE INSERT ON whaleu_ratings.target_definition_versions FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.target_definition_version_guard();
CREATE FUNCTION whaleu_ratings.target_definition_head_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t whaleu_ratings.targets;v whaleu_ratings.target_definition_versions;e whaleu_ratings.target_edit_transitions;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Target definition head is retained' USING ERRCODE='23514';END IF;
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=NEW.target_id FOR UPDATE NOWAIT;
 SELECT * INTO v FROM whaleu_ratings.target_definition_versions WHERE target_id=NEW.target_id AND content_version=NEW.content_version AND definition_revision=NEW.definition_revision;
 IF TG_OP='INSERT' THEN
  IF NOT coalesce(pg_trigger_depth()>=2 AND NEW.content_version=1 AND v.publication_transaction=pg_current_xact_id()
   AND t.creation_transaction=v.publication_transaction AND t.revision=v.applied_target_revision AND NEW.definition_revision=v.applied_target_revision,false)
  THEN RAISE EXCEPTION 'Initial target definition head has no fresh target' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO e FROM whaleu_ratings.target_edit_transitions WHERE target_id=NEW.target_id AND after_content_version=NEW.content_version;
  IF NOT coalesce(NEW.target_id=OLD.target_id AND OLD.content_version<2147483647 AND NEW.content_version=OLD.content_version+1
   AND NEW.definition_revision<>OLD.definition_revision AND e.id IS NOT NULL AND e.mutation_transaction=pg_current_xact_id()
   AND (OLD.content_version,OLD.definition_revision)=(e.before_content_version,e.before_definition_revision)
   AND (NEW.content_version,NEW.definition_revision)=(e.after_content_version,e.after_definition_revision)
   AND t.active AND t.creator_id=e.actor_account_id AND t.revision=e.after_revision AND v.applied_target_revision=e.after_revision
   AND EXISTS(SELECT 1 FROM whaleu_ratings.target_definition_lifecycles l WHERE l.target_id=t.id AND l.target_revision=t.revision AND (l.content_version,l.definition_revision)=(NEW.content_version,NEW.definition_revision))
   AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.target_owner_tombstones WHERE target_id=t.id),false)
  THEN RAISE EXCEPTION 'Target definition head must advance exactly one caused version' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER rating_definition_head_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.target_definition_heads FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.target_definition_head_guard();
CREATE FUNCTION whaleu_ratings.initialize_target_definition() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO whaleu_ratings.target_definition_versions(target_id,content_version,definition_revision,applied_target_revision,name,description,envelope,publication_transaction,published_at)
  VALUES(NEW.id,1,(NEW.envelope->>'targetRevision')::uuid,(NEW.envelope->>'targetRevision')::uuid,NEW.name,NEW.description,NEW.envelope,NEW.creation_transaction,NEW.created_at);
 INSERT INTO whaleu_ratings.target_definition_heads(target_id,content_version,definition_revision) VALUES(NEW.id,1,(NEW.envelope->>'targetRevision')::uuid);
 RETURN NULL;
END $$;
-- Alphabetically before rating_target_state: the v1 head exists when its
-- initial lifecycle is recorded by the unchanged M1 creation/state triggers.
CREATE TRIGGER a0_rating_target_definition_initialize AFTER INSERT ON whaleu_ratings.targets FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.initialize_target_definition();
CREATE FUNCTION whaleu_ratings.target_state_definition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t whaleu_ratings.targets;
BEGIN
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=NEW.target_id;
 IF NOT coalesce(pg_trigger_depth()>=2 AND t.id=NEW.target_id AND t.revision=NEW.revision AND t.active=NEW.active
  AND NEW.mutation_transaction=pg_current_xact_id() AND isfinite(NEW.occurred_at) AND NEW.occurred_at<=clock_timestamp() AND NEW.occurred_at>=t.created_at,false)
 THEN RAISE EXCEPTION 'Target state requires exact current lifecycle source' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER rating_target_state_definition_guard BEFORE INSERT ON whaleu_ratings.target_state_revisions FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.target_state_definition_guard();
CREATE FUNCTION whaleu_ratings.record_target_definition_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e whaleu_ratings.target_edit_transitions;h whaleu_ratings.target_definition_heads;
BEGIN
 SELECT * INTO e FROM whaleu_ratings.target_edit_transitions WHERE target_id=NEW.target_id AND after_revision=NEW.revision AND mutation_transaction=pg_current_xact_id();
 IF e.id IS NOT NULL THEN
  INSERT INTO whaleu_ratings.target_definition_lifecycles(target_id,target_revision,content_version,definition_revision) VALUES(NEW.target_id,NEW.revision,e.after_content_version,e.after_definition_revision);
 ELSE
  SELECT * INTO h FROM whaleu_ratings.target_definition_heads WHERE target_id=NEW.target_id;
  IF h.target_id IS NULL THEN RAISE EXCEPTION 'Lifecycle definition head is absent' USING ERRCODE='23514';END IF;
  INSERT INTO whaleu_ratings.target_definition_lifecycles(target_id,target_revision,content_version,definition_revision) VALUES(NEW.target_id,NEW.revision,h.content_version,h.definition_revision);
 END IF;RETURN NULL;
END $$;
CREATE TRIGGER rating_target_definition_lifecycle AFTER INSERT ON whaleu_ratings.target_state_revisions FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.record_target_definition_lifecycle();
CREATE FUNCTION whaleu_ratings.target_definition_lifecycle_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s whaleu_ratings.target_state_revisions;t whaleu_ratings.targets;h whaleu_ratings.target_definition_heads;e whaleu_ratings.target_edit_transitions;
BEGIN
 SELECT * INTO s FROM whaleu_ratings.target_state_revisions WHERE target_id=NEW.target_id AND revision=NEW.target_revision;
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=NEW.target_id;
 SELECT * INTO h FROM whaleu_ratings.target_definition_heads WHERE target_id=NEW.target_id;
 SELECT * INTO e FROM whaleu_ratings.target_edit_transitions WHERE target_id=NEW.target_id AND after_revision=NEW.target_revision AND mutation_transaction=pg_current_xact_id();
 IF NOT coalesce(pg_trigger_depth()>=2 AND s.target_id=t.id AND t.revision=s.revision AND t.active=s.active AND s.mutation_transaction=pg_current_xact_id()
  AND ((e.id IS NOT NULL AND (NEW.content_version,NEW.definition_revision)=(e.after_content_version,e.after_definition_revision))
   OR (e.id IS NULL AND (NEW.content_version,NEW.definition_revision)=(h.content_version,h.definition_revision))),false)
 THEN RAISE EXCEPTION 'Lifecycle definition mapping has no exact state cause' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER rating_definition_lifecycle_guard BEFORE INSERT ON whaleu_ratings.target_definition_lifecycles FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.target_definition_lifecycle_guard();
-- Retain every original immutable field and every irreversible M2A condition.
-- The only additional same-active path is one exact fresh true->true edit.
CREATE OR REPLACE FUNCTION whaleu_ratings.target_definition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a whaleu_ratings.target_owner_delete_audits;e whaleu_ratings.target_edit_transitions;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Target definition is immutable' USING ERRCODE='23514';END IF;
 IF ROW(NEW.id,NEW.category_id,NEW.creator_id,NEW.region_id,NEW.source_id,NEW.name,NEW.description,NEW.envelope,NEW.content_version,NEW.creation_transaction,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.category_id,OLD.creator_id,OLD.region_id,OLD.source_id,OLD.name,OLD.description,OLD.envelope,OLD.content_version,OLD.creation_transaction,OLD.created_at)
 OR NEW.revision=OLD.revision OR EXISTS(SELECT 1 FROM whaleu_ratings.target_owner_tombstones WHERE target_id=OLD.id)
 THEN RAISE EXCEPTION 'Target definition or owner tombstone is immutable' USING ERRCODE='23514';END IF;
 SELECT * INTO a FROM whaleu_ratings.target_owner_delete_audits WHERE target_id=OLD.id AND after_revision=NEW.revision AND outcome='applied' AND mutation_transaction=pg_current_xact_id();
 SELECT * INTO e FROM whaleu_ratings.target_edit_transitions WHERE target_id=OLD.id AND mutation_transaction=pg_current_xact_id();
 IF a.id IS NOT NULL THEN
  IF e.id IS NOT NULL OR NOT coalesce(a.actor_account_id=OLD.creator_id AND a.before_revision=OLD.revision AND a.before_active=OLD.active AND NOT NEW.active,false)
  THEN RAISE EXCEPTION 'Target lifecycle does not match owner deletion' USING ERRCODE='23514';END IF;
 ELSIF e.id IS NOT NULL THEN
  IF NOT coalesce(OLD.active AND NEW.active AND e.actor_account_id=OLD.creator_id AND e.before_revision=OLD.revision AND e.after_revision=NEW.revision
   AND EXISTS(SELECT 1 FROM whaleu_ratings.target_definition_heads h WHERE h.target_id=OLD.id AND (h.content_version,h.definition_revision)=(e.before_content_version,e.before_definition_revision))
   AND EXISTS(SELECT 1 FROM whaleu_ratings.target_definition_versions v WHERE v.target_id=OLD.id AND (v.content_version,v.definition_revision,v.applied_target_revision,v.publication_transaction,v.published_at)
    =(e.after_content_version,e.after_definition_revision,e.after_revision,e.mutation_transaction,e.occurred_at)),false)
  THEN RAISE EXCEPTION 'Target lifecycle does not match exact applied edit' USING ERRCODE='23514';END IF;
 ELSIF NEW.active=OLD.active THEN RAISE EXCEPTION 'Target definition is immutable' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;

ALTER TABLE whaleu_ratings.requests DROP CONSTRAINT requests_operation_check;
ALTER TABLE whaleu_ratings.requests ADD CONSTRAINT requests_operation_check CHECK(operation IN ('set_score','create_comment','delete_comment','create_reply','delete_reply','set_comment_like','set_reply_like','set_target_subscription','admin_delete_comment','admin_delete_reply','create_target','delete_target','edit_target'));
DROP TRIGGER rating_request_causal ON whaleu_ratings.requests;
CREATE CONSTRAINT TRIGGER rating_request_causal AFTER INSERT OR UPDATE ON whaleu_ratings.requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.operation NOT IN ('set_comment_like','set_reply_like','set_target_subscription','admin_delete_comment','admin_delete_reply','create_target','delete_target','edit_target')) EXECUTE FUNCTION whaleu_ratings.request_causal();
CREATE FUNCTION whaleu_ratings.target_edit_closure_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_ratings.requests;
BEGIN
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=NEW.actor_account_id AND request_id=NEW.request_id FOR UPDATE NOWAIT;
 IF NOT coalesce(q.operation='edit_target' AND q.intent_hash=NEW.intent_hash AND q.receipt IS NULL AND NEW.mutation_transaction=pg_current_xact_id()
  AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.target_edit_transitions WHERE actor_account_id=NEW.actor_account_id AND request_id=NEW.request_id)
  AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.target_edit_noops WHERE actor_account_id=NEW.actor_account_id AND request_id=NEW.request_id),false)
 THEN RAISE EXCEPTION 'Target edit closure requires exact uncompleted command' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER rating_edit_closure_guard BEFORE INSERT ON whaleu_ratings.target_edit_closures FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.target_edit_closure_guard();
CREATE FUNCTION whaleu_ratings.verify_target_edit(actor uuid,request uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE q whaleu_ratings.requests;p whaleu_ratings.target_edit_preparations;e whaleu_ratings.target_edit_transitions;
 n whaleu_ratings.target_edit_noops;c whaleu_ratings.target_edit_closures;t whaleu_ratings.targets;h whaleu_ratings.target_definition_heads;
 v whaleu_ratings.target_definition_versions;previous whaleu_ratings.target_definition_versions;s whaleu_ratings.target_state_revisions;
 l whaleu_ratings.target_definition_lifecycles;before_l whaleu_ratings.target_definition_lifecycles;
 b whaleu_community.rating_target_definition_bindings;instant timestamptz;subject uuid;
BEGIN
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=actor AND request_id=request;
 SELECT * INTO p FROM whaleu_ratings.target_edit_preparations WHERE account_id=actor AND request_id=request;
 SELECT * INTO e FROM whaleu_ratings.target_edit_transitions WHERE actor_account_id=actor AND request_id=request;
 SELECT * INTO n FROM whaleu_ratings.target_edit_noops WHERE actor_account_id=actor AND request_id=request;
 SELECT * INTO c FROM whaleu_ratings.target_edit_closures WHERE actor_account_id=actor AND request_id=request;
 instant:=clock_timestamp();
 IF NOT coalesce(q.operation='edit_target' AND q.receipt IS NOT NULL
  AND EXISTS(SELECT 1 FROM whaleu_ratings.command_claims k WHERE k.account_id=actor AND k.request_id=request AND k.operation=q.operation AND k.intent_hash=q.intent_hash),false)
 THEN RAISE EXCEPTION 'Target edit requires complete exact command' USING ERRCODE='23514';END IF;
 IF q.receipt->>'outcome'='rejected' THEN
  subject:=(c.intent->>'targetId')::uuid;
  IF NOT coalesce(c.actor_account_id=actor AND c.intent_hash=q.intent_hash AND c.mutation_transaction=pg_current_xact_id()
   AND e.id IS NULL AND n.actor_account_id IS NULL
   AND q.receipt=jsonb_build_object('requestId',request,'operation','edit_target','outcome','rejected','code',c.code)
   AND (p.account_id IS NULL OR (p.intent_hash=c.intent_hash AND p.intent=c.intent))
   AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.target_state_revisions WHERE target_id=subject AND mutation_transaction=pg_current_xact_id())
   AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.target_definition_versions WHERE target_id=subject AND publication_transaction=pg_current_xact_id())
   AND NOT EXISTS(SELECT 1 FROM whaleu_community.rating_target_definition_bindings WHERE target_id=subject AND publication_transaction=pg_current_xact_id()),false)
  THEN RAISE EXCEPTION 'Target edit terminal receipt/artifact mismatch' USING ERRCODE='23514';END IF;RETURN;
 END IF;
 IF NOT coalesce(p.account_id=actor AND p.intent_hash=q.intent_hash AND c.actor_account_id IS NULL
  AND p.envelope=whaleu_ratings.target_edit_envelope(p) AND p.prepared_at<=instant AND p.valid_until>instant
  AND whaleu_ratings.target_edit_session_current(actor,p.session_id,instant)
  AND whaleu_ratings.target_edit_catalog_current(p.target_id,p.intent,instant),false)
 THEN RAISE EXCEPTION 'Target edit preparation/session/catalog expired or changed' USING ERRCODE='23514';END IF;
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=p.target_id;
 SELECT * INTO h FROM whaleu_ratings.target_definition_heads WHERE target_id=p.target_id;
 SELECT * INTO previous FROM whaleu_ratings.target_definition_versions WHERE target_id=p.target_id AND content_version=p.before_content_version;
 SELECT * INTO before_l FROM whaleu_ratings.target_definition_lifecycles WHERE target_id=p.target_id AND target_revision=p.before_revision;
 IF NOT coalesce(t.id=p.target_id AND t.creator_id=actor AND t.active
  AND previous.definition_revision=p.before_definition_revision
  AND (before_l.content_version,before_l.definition_revision)=(p.before_content_version,p.before_definition_revision)
  AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.target_owner_tombstones WHERE target_id=t.id)
  AND whaleu_community.rating_target_definition_current(previous.target_id,previous.content_version,previous.definition_revision,previous.applied_target_revision,previous.envelope),false)
 THEN RAISE EXCEPTION 'Target edit immutable predecessor or Review changed' USING ERRCODE='23514';END IF;
 IF q.receipt->>'outcome'='noop' THEN
  IF NOT coalesce(e.id IS NULL AND n.actor_account_id=actor AND n.intent_hash=q.intent_hash AND n.mutation_transaction=pg_current_xact_id()
   AND (n.target_id,n.revision,n.definition_revision,n.content_version,n.context_revision,n.intent)
    =(p.target_id,p.before_revision,p.before_definition_revision,p.before_content_version,p.context_revision,p.intent)
   AND t.revision=n.revision AND (h.content_version,h.definition_revision)=(n.content_version,n.definition_revision)
   AND (previous.name,previous.description)=(p.intent->>'name',p.intent->>'description') AND n.occurred_at>=p.prepared_at AND n.occurred_at<=instant
   AND q.receipt=jsonb_build_object('requestId',request,'operation','edit_target','outcome','noop','targetId',n.target_id,'revision',n.revision,
    'definitionRevision',n.definition_revision,'contentVersion',n.content_version,'occurredAt',to_char(n.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
   AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.target_state_revisions WHERE target_id=n.target_id AND mutation_transaction=pg_current_xact_id())
   AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.target_definition_versions WHERE target_id=n.target_id AND publication_transaction=pg_current_xact_id())
   AND NOT EXISTS(SELECT 1 FROM whaleu_community.rating_target_definition_bindings WHERE target_id=n.target_id AND publication_transaction=pg_current_xact_id()),false)
  THEN RAISE EXCEPTION 'Target edit noop receipt/context/artifact mismatch' USING ERRCODE='23514';END IF;
  PERFORM whaleu_ratings.assert_target_edit_before(p,instant);RETURN;
 END IF;
 SELECT * INTO v FROM whaleu_ratings.target_definition_versions WHERE target_id=p.target_id AND content_version=p.content_version;
 SELECT * INTO s FROM whaleu_ratings.target_state_revisions WHERE target_id=p.target_id AND revision=p.after_revision;
 SELECT * INTO l FROM whaleu_ratings.target_definition_lifecycles WHERE target_id=p.target_id AND target_revision=p.after_revision;
 SELECT * INTO b FROM whaleu_community.rating_target_definition_bindings WHERE target_id=p.target_id AND content_version=p.content_version;
 IF NOT coalesce(e.id IS NOT NULL AND n.actor_account_id IS NULL AND e.mutation_transaction=pg_current_xact_id() AND e.intent_hash=q.intent_hash
  AND (e.target_id,e.before_revision,e.after_revision,e.before_definition_revision,e.after_definition_revision,e.before_content_version,e.after_content_version,e.context_revision,e.intent)
   =(p.target_id,p.before_revision,p.after_revision,p.before_definition_revision,p.definition_revision,p.before_content_version,p.content_version,p.context_revision,p.intent)
  AND e.occurred_at>=p.prepared_at AND e.occurred_at<=instant AND previous.published_at<=e.occurred_at
  AND (previous.name,previous.description) IS DISTINCT FROM (p.intent->>'name',p.intent->>'description')
  AND EXISTS(SELECT 1 FROM whaleu_ratings.target_state_revisions old_state WHERE old_state.target_id=p.target_id AND old_state.revision=p.before_revision AND old_state.active AND old_state.occurred_at<=e.occurred_at AND old_state.mutation_transaction<>e.mutation_transaction)
  AND t.revision=e.after_revision AND (h.content_version,h.definition_revision)=(e.after_content_version,e.after_definition_revision)
  AND (v.target_id,v.definition_revision,v.applied_target_revision,v.name,v.description,v.envelope,v.publication_transaction,v.published_at)
   =(e.target_id,e.after_definition_revision,e.after_revision,p.intent->>'name',p.intent->>'description',p.envelope,e.mutation_transaction,e.occurred_at)
  AND s.target_id=e.target_id AND s.active AND s.mutation_transaction=e.mutation_transaction AND isfinite(s.occurred_at) AND s.occurred_at>=e.occurred_at AND s.occurred_at<=instant
  AND (l.content_version,l.definition_revision)=(e.after_content_version,e.after_definition_revision)
  AND (SELECT count(*) FROM whaleu_ratings.target_state_revisions x WHERE x.target_id=e.target_id AND x.mutation_transaction=e.mutation_transaction)=1
  AND (SELECT count(*) FROM whaleu_ratings.target_definition_versions x WHERE x.target_id=e.target_id AND x.publication_transaction=e.mutation_transaction)=1
  AND (b.target_id,b.content_version,b.definition_revision,b.account_id,b.envelope,b.publication_transaction)
   =(e.target_id,e.after_content_version,e.after_definition_revision,e.actor_account_id,p.envelope,e.mutation_transaction)
  AND b.bound_at>=e.occurred_at AND b.bound_at<=instant
  AND EXISTS(SELECT 1 FROM whaleu_community.rating_approval_decisions d WHERE d.id=b.decision_id AND d.evaluated_at<=e.occurred_at AND d.consume_until>instant)
  AND whaleu_community.rating_target_definition_current(v.target_id,v.content_version,v.definition_revision,v.applied_target_revision,v.envelope)
  AND q.receipt=jsonb_build_object('requestId',request,'operation','edit_target','outcome','applied','targetId',e.target_id,'revision',e.after_revision,
   'definitionRevision',e.after_definition_revision,'contentVersion',e.after_content_version,'occurredAt',to_char(e.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),false)
 THEN RAISE EXCEPTION 'Target edit publication causal chain incomplete' USING ERRCODE='23514';END IF;
END $$;
CREATE FUNCTION whaleu_ratings.target_edit_command_causal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_TABLE_NAME='requests' THEN PERFORM whaleu_ratings.verify_target_edit(NEW.account_id,NEW.request_id);
 ELSE PERFORM whaleu_ratings.verify_target_edit(NEW.actor_account_id,NEW.request_id);END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER rating_edit_request_causal AFTER INSERT OR UPDATE ON whaleu_ratings.requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.operation='edit_target') EXECUTE FUNCTION whaleu_ratings.target_edit_command_causal();
CREATE CONSTRAINT TRIGGER rating_edit_transition_causal AFTER INSERT ON whaleu_ratings.target_edit_transitions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.target_edit_command_causal();
CREATE CONSTRAINT TRIGGER rating_edit_noop_causal AFTER INSERT ON whaleu_ratings.target_edit_noops DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.target_edit_command_causal();
CREATE CONSTRAINT TRIGGER rating_edit_closure_causal AFTER INSERT ON whaleu_ratings.target_edit_closures DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.target_edit_command_causal();
CREATE FUNCTION whaleu_ratings.target_edit_preparation_causal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_ratings.requests;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.command_claims k WHERE k.account_id=NEW.account_id AND k.request_id=NEW.request_id AND k.operation='edit_target' AND k.intent_hash=NEW.intent_hash)
 THEN RAISE EXCEPTION 'Target edit preparation has no namespace reservation' USING ERRCODE='23514';END IF;
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=NEW.account_id AND request_id=NEW.request_id;
 IF q.account_id IS NOT NULL THEN PERFORM whaleu_ratings.verify_target_edit(NEW.account_id,NEW.request_id);
 ELSE
  IF NEW.valid_until<=clock_timestamp() THEN RAISE EXCEPTION 'Target edit preparation expired before commit' USING ERRCODE='23514';END IF;
  PERFORM whaleu_ratings.assert_target_edit_before(NEW,clock_timestamp());
 END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER rating_edit_preparation_causal AFTER INSERT ON whaleu_ratings.target_edit_preparations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.target_edit_preparation_causal();

CREATE FUNCTION whaleu_ratings.verify_target_definition_initial(target uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE t whaleu_ratings.targets;v whaleu_ratings.target_definition_versions;h whaleu_ratings.target_definition_heads;
 l whaleu_ratings.target_definition_lifecycles;b whaleu_community.rating_approval_bindings;
BEGIN
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=target;
 SELECT * INTO v FROM whaleu_ratings.target_definition_versions WHERE target_id=target AND content_version=1;
 SELECT * INTO h FROM whaleu_ratings.target_definition_heads WHERE target_id=target;
 SELECT * INTO l FROM whaleu_ratings.target_definition_lifecycles WHERE target_id=target AND target_revision=t.revision;
 SELECT * INTO b FROM whaleu_community.rating_approval_bindings WHERE kind='target' AND subject_id=target;
 IF NOT coalesce(t.id=target AND t.creation_transaction=pg_current_xact_id()
  AND (v.definition_revision,v.applied_target_revision,v.name,v.description,v.envelope,v.publication_transaction,v.published_at)
   =((t.envelope->>'targetRevision')::uuid,(t.envelope->>'targetRevision')::uuid,t.name,t.description,t.envelope,t.creation_transaction,t.created_at)
  AND t.revision=v.applied_target_revision AND (h.content_version,h.definition_revision)=(1,v.definition_revision)
  AND (l.content_version,l.definition_revision)=(1,v.definition_revision)
  AND EXISTS(SELECT 1 FROM whaleu_ratings.target_state_revisions s WHERE s.target_id=target AND s.revision=t.revision AND s.active=t.active AND s.mutation_transaction=t.creation_transaction)
  AND (b.content_version,b.account_id,b.envelope,b.publication_transaction)=(1,t.creator_id,t.envelope,t.creation_transaction),false)
 THEN RAISE EXCEPTION 'Initial target definition/head/state/binding reverse link incomplete' USING ERRCODE='23514';END IF;
END $$;
CREATE FUNCTION whaleu_ratings.verify_target_definition_lifecycle(_target uuid,_revision uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE t whaleu_ratings.targets;s whaleu_ratings.target_state_revisions;l whaleu_ratings.target_definition_lifecycles;
 h whaleu_ratings.target_definition_heads;current_l whaleu_ratings.target_definition_lifecycles;e whaleu_ratings.target_edit_transitions;
BEGIN
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=_target;
 SELECT * INTO s FROM whaleu_ratings.target_state_revisions x WHERE x.target_id=_target AND x.revision=_revision;
 SELECT * INTO l FROM whaleu_ratings.target_definition_lifecycles WHERE target_id=_target AND target_revision=_revision;
 SELECT * INTO h FROM whaleu_ratings.target_definition_heads WHERE target_id=_target;
 SELECT * INTO current_l FROM whaleu_ratings.target_definition_lifecycles WHERE target_id=_target AND target_revision=t.revision;
 SELECT * INTO e FROM whaleu_ratings.target_edit_transitions WHERE target_id=_target AND after_revision=_revision AND mutation_transaction=pg_current_xact_id();
 IF NOT coalesce(t.id=_target AND s.target_id=_target AND s.mutation_transaction=pg_current_xact_id()
  AND (l.content_version,l.definition_revision)=(h.content_version,h.definition_revision)
  AND (current_l.content_version,current_l.definition_revision)=(h.content_version,h.definition_revision)
  AND EXISTS(SELECT 1 FROM whaleu_ratings.target_state_revisions current_s WHERE current_s.target_id=t.id AND current_s.revision=t.revision AND current_s.active=t.active),false)
 THEN RAISE EXCEPTION 'Target state/current definition reverse link incomplete' USING ERRCODE='23514';END IF;
 IF e.id IS NOT NULL THEN PERFORM whaleu_ratings.verify_target_edit(e.actor_account_id,e.request_id);END IF;
END $$;
CREATE FUNCTION whaleu_ratings.target_definition_artifact_causal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e whaleu_ratings.target_edit_transitions;v whaleu_ratings.target_definition_versions;
BEGIN
 IF TG_TABLE_NAME='target_definition_lifecycles' THEN
  PERFORM whaleu_ratings.verify_target_definition_lifecycle(NEW.target_id,NEW.target_revision);RETURN NULL;
 ELSIF TG_TABLE_NAME='target_state_revisions' THEN
  PERFORM whaleu_ratings.verify_target_definition_lifecycle(NEW.target_id,NEW.revision);RETURN NULL;
 END IF;
 IF NEW.content_version=1 THEN
  PERFORM whaleu_ratings.verify_target_definition_initial(NEW.target_id);RETURN NULL;
 END IF;
 SELECT * INTO e FROM whaleu_ratings.target_edit_transitions WHERE target_id=NEW.target_id AND after_content_version=NEW.content_version;
 SELECT * INTO v FROM whaleu_ratings.target_definition_versions WHERE target_id=NEW.target_id AND content_version=NEW.content_version;
 IF NOT coalesce(e.id IS NOT NULL AND e.mutation_transaction=pg_current_xact_id()
  AND NEW.definition_revision=e.after_definition_revision AND v.definition_revision=e.after_definition_revision
  AND v.applied_target_revision=e.after_revision AND v.publication_transaction=e.mutation_transaction,false)
 THEN RAISE EXCEPTION 'Target definition artifact has no exact fresh edit' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='target_definition_heads' AND TG_OP='UPDATE' THEN
  IF (OLD.target_id,OLD.content_version,OLD.definition_revision) IS DISTINCT FROM (e.target_id,e.before_content_version,e.before_definition_revision)
  THEN RAISE EXCEPTION 'Target definition head predecessor mismatch' USING ERRCODE='23514';END IF;
 END IF;
 PERFORM whaleu_ratings.verify_target_edit(e.actor_account_id,e.request_id);RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER rating_definition_version_causal AFTER INSERT ON whaleu_ratings.target_definition_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.target_definition_artifact_causal();
CREATE CONSTRAINT TRIGGER rating_definition_head_causal AFTER INSERT OR UPDATE ON whaleu_ratings.target_definition_heads DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.target_definition_artifact_causal();
CREATE CONSTRAINT TRIGGER rating_definition_lifecycle_causal AFTER INSERT ON whaleu_ratings.target_definition_lifecycles DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.target_definition_artifact_causal();
CREATE CONSTRAINT TRIGGER rating_definition_state_causal AFTER INSERT ON whaleu_ratings.target_state_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.target_definition_artifact_causal();
CREATE CONSTRAINT TRIGGER rating_definition_binding_causal AFTER INSERT ON whaleu_community.rating_target_definition_bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.target_definition_artifact_causal();
CREATE FUNCTION whaleu_ratings.target_edit_state_causal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e whaleu_ratings.target_edit_transitions;
BEGIN
 IF TG_OP='INSERT' THEN PERFORM whaleu_ratings.verify_target_definition_initial(NEW.id);
 ELSE
  SELECT * INTO e FROM whaleu_ratings.target_edit_transitions WHERE target_id=NEW.id AND after_revision=NEW.revision AND mutation_transaction=pg_current_xact_id();
  IF e.id IS NOT NULL THEN
   IF NOT OLD.active OR NOT NEW.active OR (e.before_revision,e.actor_account_id) IS DISTINCT FROM (OLD.revision,OLD.creator_id)
   THEN RAISE EXCEPTION 'Target edit lifecycle predecessor mismatch' USING ERRCODE='23514';END IF;
   PERFORM whaleu_ratings.verify_target_edit(e.actor_account_id,e.request_id);
  END IF;
  PERFORM whaleu_ratings.verify_target_definition_lifecycle(NEW.id,NEW.revision);
 END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER rating_edit_state_causal AFTER INSERT OR UPDATE ON whaleu_ratings.targets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.target_edit_state_causal();
