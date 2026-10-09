-- M1 development authority. No issuer, grant, approval or production fact is seeded.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
-- Deployment source policy is not a per-account permission or administrator role.
CREATE TABLE whaleu_ratings.native_create_policies (
 id uuid PRIMARY KEY,region_id uuid REFERENCES whaleu_campus.operating_regions(id),
 generic_kind text NOT NULL CHECK(generic_kind='general'),
 source_reference text NOT NULL CHECK(length(btrim(source_reference)) BETWEEN 1 AND 500),
 policy_reference text NOT NULL CHECK(length(btrim(policy_reference)) BETWEEN 1 AND 500),
 issuer text NOT NULL CHECK(length(btrim(issuer)) BETWEEN 1 AND 200),revision integer NOT NULL CHECK(revision>0),
 enabled boolean NOT NULL,require_known_origin boolean NOT NULL DEFAULT false,coverage text NOT NULL CHECK(coverage IN ('complete','missing','conflicting')),
 provenance text NOT NULL CHECK(provenance IN ('accepted','unknown','conflicting')),
 effective_at timestamptz NOT NULL CHECK(isfinite(effective_at)),valid_until timestamptz NOT NULL CHECK(isfinite(valid_until) AND valid_until>effective_at),
 UNIQUE NULLS NOT DISTINCT(region_id,generic_kind,revision)
);
CREATE TABLE whaleu_ratings.native_create_policy_heads (
 scope_key text NOT NULL,generic_kind text NOT NULL,policy_id uuid NOT NULL REFERENCES whaleu_ratings.native_create_policies(id),PRIMARY KEY(scope_key,generic_kind)
);
CREATE FUNCTION whaleu_ratings.native_policy_head_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a whaleu_ratings.native_create_policies;b whaleu_ratings.native_create_policies;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Policy head is durable' USING ERRCODE='23514';END IF;
 SELECT * INTO a FROM whaleu_ratings.native_create_policies WHERE id=NEW.policy_id;
 IF ROW(coalesce(a.region_id::text,'global'),a.generic_kind) IS DISTINCT FROM ROW(NEW.scope_key,NEW.generic_kind) THEN RAISE EXCEPTION 'Policy head mismatch' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' THEN
 SELECT * INTO b FROM whaleu_ratings.native_create_policies WHERE id=OLD.policy_id;
 IF ROW(NEW.scope_key,NEW.generic_kind) IS DISTINCT FROM ROW(OLD.scope_key,OLD.generic_kind) OR a.revision<=b.revision OR a.effective_at<=b.effective_at THEN RAISE EXCEPTION 'Policy head cannot rewind' USING ERRCODE='23514';END IF;END IF;RETURN NEW;
END $$;
CREATE TRIGGER native_policy_head_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.native_create_policy_heads FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.native_policy_head_guard();
-- Exact independent origin provenance, never used to grant user eligibility.
-- An owning issuer must attest original campus for this request; no region inversion.
CREATE TABLE whaleu_ratings.native_origin_evidence (
 id uuid PRIMARY KEY,account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,intent_hash text NOT NULL CHECK(intent_hash ~ '^[a-f0-9]{64}$'),
 region_id uuid REFERENCES whaleu_campus.operating_regions(id),policy_id uuid NOT NULL REFERENCES whaleu_ratings.native_create_policies(id),
 origin_state text NOT NULL CHECK(origin_state IN ('known_school','schoolless')),origin_campus_id uuid REFERENCES whaleu_campus.campuses(id),
 source_reference text NOT NULL CHECK(length(btrim(source_reference)) BETWEEN 1 AND 500),policy_reference text NOT NULL CHECK(length(btrim(policy_reference)) BETWEEN 1 AND 500),
 effective_at timestamptz NOT NULL CHECK(isfinite(effective_at)),valid_until timestamptz NOT NULL CHECK(isfinite(valid_until) AND valid_until>effective_at),
 CHECK((origin_state='known_school')=(origin_campus_id IS NOT NULL)),UNIQUE(account_id,request_id)
);
-- Preparation reserves the common command namespace without minting a receipt.
CREATE TABLE whaleu_ratings.command_claims (
 account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,operation text NOT NULL,intent_hash text NOT NULL,
 PRIMARY KEY(account_id,request_id),CHECK(intent_hash ~ '^[a-f0-9]{64}$')
);
INSERT INTO whaleu_ratings.command_claims SELECT account_id,request_id,operation,intent_hash FROM whaleu_ratings.requests;
CREATE FUNCTION whaleu_ratings.claim_command() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c whaleu_ratings.command_claims;op text;
BEGIN
 IF TG_TABLE_NAME='target_preparations' THEN op:='create_target';ELSE op:=NEW.operation;END IF;
 INSERT INTO whaleu_ratings.command_claims VALUES(NEW.account_id,NEW.request_id,op,NEW.intent_hash) ON CONFLICT DO NOTHING;
 SELECT * INTO c FROM whaleu_ratings.command_claims WHERE account_id=NEW.account_id AND request_id=NEW.request_id FOR UPDATE;
 IF ROW(c.operation,c.intent_hash) IS DISTINCT FROM ROW(op,NEW.intent_hash) THEN RAISE EXCEPTION 'Command namespace conflict' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER rating_command_claim BEFORE INSERT ON whaleu_ratings.requests FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.claim_command();
-- Canonical hash verification is limited to the strict M1 JSON intent shape.
CREATE FUNCTION whaleu_ratings.creation_canonical_json(value jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT CASE jsonb_typeof(value)
 WHEN 'object' THEN '{'||coalesce((SELECT string_agg(to_jsonb(key)::text||':'||whaleu_ratings.creation_canonical_json(val),',' ORDER BY key COLLATE "C") FROM jsonb_each(value) x(key,val)),'')||'}'
 WHEN 'array' THEN '['||coalesce((SELECT string_agg(whaleu_ratings.creation_canonical_json(val),',' ORDER BY ord) FROM jsonb_array_elements(value) WITH ORDINALITY x(val,ord)),'')||']'
 ELSE value::text END
$$;
CREATE TABLE whaleu_ratings.target_preparations (
 account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,intent_hash text NOT NULL,
 session_id uuid NOT NULL,target_id uuid NOT NULL UNIQUE,revision uuid NOT NULL,context_revision text NOT NULL UNIQUE CHECK(context_revision ~ '^[A-Za-z0-9_-]{43}$'),
 policy_id uuid NOT NULL REFERENCES whaleu_ratings.native_create_policies(id),origin_evidence_id uuid REFERENCES whaleu_ratings.native_origin_evidence(id),intent jsonb NOT NULL,envelope jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),valid_until timestamptz NOT NULL,
 PRIMARY KEY(account_id,request_id),FOREIGN KEY(account_id,request_id) REFERENCES whaleu_ratings.command_claims(account_id,request_id),
 CHECK(isfinite(created_at) AND isfinite(valid_until) AND valid_until>created_at)
);
CREATE FUNCTION whaleu_ratings.preparation_definition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE keys text[];e jsonb;expected_hash text;
BEGIN
 e:=NEW.envelope;
 SELECT array_agg(k ORDER BY k) INTO keys FROM jsonb_object_keys(NEW.intent) k;
 expected_hash:=encode(sha256(convert_to(E'whaleu:rating-target-create:v1\n'||whaleu_ratings.creation_canonical_json(jsonb_build_object('operation','create_target','intent',NEW.intent)),'UTF8')),'hex');
 IF NOT coalesce(keys=ARRAY['assetIds','categoryId','clientRequestId','description','expectedCatalogRevision','expectedCategoryRevision','name','regionId'] AND expected_hash=NEW.intent_hash
 AND NEW.intent->>'clientRequestId'=NEW.request_id::text AND e->>'clientRequestId'=NEW.request_id::text AND e->>'accountId'=NEW.account_id::text
 AND e->>'targetId'=NEW.target_id::text AND e->>'targetRevision'=NEW.revision::text AND e->>'purpose'='publish_rating_target' AND e->>'version'='1'
 AND e->'assetIds'='[]'::jsonb AND NEW.intent->'assetIds'='[]'::jsonb
 AND NEW.intent->'categoryId'=e->'categoryId' AND NEW.intent->'expectedCategoryRevision'=e->'categoryRevision' AND NEW.intent->'expectedCatalogRevision'=e->'catalogRevision'
 AND NEW.intent->'name'=e->'name' AND NEW.intent->'description'=e->'description' AND NEW.intent->'regionId'=e->'scope'->'regionId',false)
 THEN RAISE EXCEPTION 'Preparation intent mismatch' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER rating_preparation_definition BEFORE INSERT ON whaleu_ratings.target_preparations FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.preparation_definition();
CREATE TRIGGER rating_preparation_claim BEFORE INSERT ON whaleu_ratings.target_preparations FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.claim_command();
ALTER TABLE whaleu_ratings.requests DROP CONSTRAINT requests_operation_check;
ALTER TABLE whaleu_ratings.requests ADD CHECK(operation IN ('set_score','create_comment','delete_comment','create_reply','delete_reply','set_comment_like','set_reply_like','set_target_subscription','admin_delete_comment','admin_delete_reply','create_target'));
DROP TRIGGER rating_request_causal ON whaleu_ratings.requests;
CREATE CONSTRAINT TRIGGER rating_request_causal AFTER INSERT OR UPDATE ON whaleu_ratings.requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.operation NOT IN ('set_comment_like','set_reply_like','set_target_subscription','admin_delete_comment','admin_delete_reply','create_target')) EXECUTE FUNCTION whaleu_ratings.request_causal();
CREATE TABLE whaleu_ratings.target_create_transitions (
 target_id uuid PRIMARY KEY REFERENCES whaleu_ratings.targets(id),account_id uuid NOT NULL,request_id uuid NOT NULL,
 source_id uuid NOT NULL UNIQUE REFERENCES whaleu_ratings.target_sources(id),baseline_id uuid NOT NULL UNIQUE REFERENCES whaleu_ratings.score_baselines(id),
 origin_source_id uuid NOT NULL UNIQUE REFERENCES whaleu_ratings.target_origin_sources(id),policy_id uuid NOT NULL REFERENCES whaleu_ratings.native_create_policies(id),
 before_catalog_id uuid NOT NULL REFERENCES whaleu_ratings.catalogs(id),after_catalog_id uuid NOT NULL UNIQUE REFERENCES whaleu_ratings.catalogs(id),
 revision uuid NOT NULL,occurred_at timestamptz NOT NULL,mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 UNIQUE(account_id,request_id),FOREIGN KEY(account_id,request_id) REFERENCES whaleu_ratings.requests(account_id,request_id),
 FOREIGN KEY(account_id,request_id) REFERENCES whaleu_ratings.target_preparations(account_id,request_id),CHECK(before_catalog_id<>after_catalog_id)
);
CREATE TABLE whaleu_ratings.target_creation_closures (
 account_id uuid NOT NULL,request_id uuid NOT NULL,intent_hash text NOT NULL,intent jsonb NOT NULL,
 code text NOT NULL CHECK(code IN ('RATING_CREATION_CONTEXT_CHANGED','CONTENT_REJECTED','RATING_CREATION_CANCELLED')),
 mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),PRIMARY KEY(account_id,request_id),
 FOREIGN KEY(account_id,request_id) REFERENCES whaleu_ratings.requests(account_id,request_id)
);
CREATE FUNCTION whaleu_ratings.verify_target_create(actor uuid,request uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE q whaleu_ratings.requests;p whaleu_ratings.target_preparations;e whaleu_ratings.target_create_transitions;
 closed whaleu_ratings.target_creation_closures;t whaleu_ratings.targets;s whaleu_ratings.target_sources;b whaleu_ratings.score_baselines;a whaleu_ratings.native_create_policies;
 v whaleu_ratings.native_origin_evidence;o whaleu_ratings.target_origin_sources;c whaleu_ratings.catalogs;old whaleu_ratings.catalogs;keys text[];
BEGIN
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=actor AND request_id=request;
 SELECT * INTO closed FROM whaleu_ratings.target_creation_closures WHERE account_id=actor AND request_id=request;
 IF q.receipt->>'outcome'='rejected' THEN
 SELECT array_agg(k ORDER BY k) INTO keys FROM jsonb_object_keys(q.receipt) k;
 IF NOT coalesce(keys=ARRAY['code','operation','outcome','requestId'] AND q.operation='create_target' AND q.receipt->>'operation'='create_target' AND q.receipt->>'requestId'=request::text AND q.receipt->>'code'=closed.code
 AND closed.intent_hash=q.intent_hash AND closed.intent->>'clientRequestId'=request::text AND closed.mutation_transaction=pg_current_xact_id()
 AND closed.intent_hash=encode(sha256(convert_to(E'whaleu:rating-target-create:v1\n'||whaleu_ratings.creation_canonical_json(jsonb_build_object('operation','create_target','intent',closed.intent)),'UTF8')),'hex'),false)
 OR EXISTS(SELECT 1 FROM whaleu_ratings.target_create_transitions WHERE account_id=actor AND request_id=request)
 THEN RAISE EXCEPTION 'Invalid terminal creation receipt' USING ERRCODE='23514';END IF;RETURN;
 END IF;
 IF closed.account_id IS NOT NULL THEN RAISE EXCEPTION 'Closed creation cannot apply' USING ERRCODE='23514';END IF;
 SELECT * INTO p FROM whaleu_ratings.target_preparations WHERE account_id=actor AND request_id=request;
 SELECT * INTO e FROM whaleu_ratings.target_create_transitions WHERE account_id=actor AND request_id=request;
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=e.target_id;
 SELECT * INTO s FROM whaleu_ratings.target_sources WHERE id=e.source_id;
 SELECT * INTO b FROM whaleu_ratings.score_baselines WHERE id=e.baseline_id;
 SELECT * INTO a FROM whaleu_ratings.native_create_policies WHERE id=e.policy_id;
 SELECT * INTO v FROM whaleu_ratings.native_origin_evidence WHERE id=p.origin_evidence_id;
 SELECT * INTO o FROM whaleu_ratings.target_origin_sources WHERE id=e.origin_source_id;
 SELECT * INTO c FROM whaleu_ratings.catalogs WHERE id=e.after_catalog_id;
 SELECT * INTO old FROM whaleu_ratings.catalogs WHERE id=e.before_catalog_id;
 SELECT array_agg(k ORDER BY k) INTO keys FROM jsonb_object_keys(q.receipt) k;
 IF NOT coalesce(q.operation='create_target' AND q.intent_hash=p.intent_hash AND q.receipt->>'outcome'='applied' AND q.receipt->>'operation'='create_target' AND q.receipt->>'requestId'=request::text
 AND q.receipt->>'targetId'=t.id::text AND q.receipt->>'revision'=e.revision::text AND q.receipt->>'catalogRevision'=c.id::text AND (q.receipt->>'occurredAt')::timestamptz=e.occurred_at
 AND keys=ARRAY['catalogRevision','occurredAt','operation','outcome','requestId','revision','targetId']
 AND p.target_id=t.id AND p.revision=t.revision AND e.revision=t.revision AND t.creator_id=actor AND p.envelope=t.envelope
 AND t.envelope->>'clientRequestId'=request::text AND t.envelope->>'catalogRevision'=old.id::text AND t.envelope->>'accountId'=actor::text
 AND p.policy_id=a.id AND a.region_id IS NOT DISTINCT FROM t.region_id AND a.enabled AND a.coverage='complete' AND a.provenance='accepted'
 AND a.effective_at<=e.occurred_at AND a.valid_until>clock_timestamp() AND p.valid_until>clock_timestamp()
 AND e.mutation_transaction=pg_current_xact_id() AND t.creation_transaction=e.mutation_transaction AND s.source_transaction=e.mutation_transaction AND b.creation_transaction=e.mutation_transaction
 AND s.target_id=t.id AND t.source_id=s.id AND b.target_id=t.id AND b.source_id=s.id AND s.origin='new_native' AND s.coverage='complete' AND s.provenance='accepted'
 AND s.source_reference='rating-create:'||actor::text||':'||request::text AND s.policy_reference=a.policy_reference AND b.source_reference=s.source_reference AND b.policy_reference=s.policy_reference
 AND e.occurred_at=t.created_at AND s.effective_at=t.created_at
 AND o.target_id=t.id AND ((p.origin_evidence_id IS NULL AND NOT a.require_known_origin AND o.state='unknown' AND o.origin_campus_id IS NULL AND o.coverage_state='missing' AND o.provenance_state='unknown' AND o.source_reference=s.source_reference AND o.policy_reference=a.policy_reference) OR (v.account_id=actor AND v.request_id=request AND v.intent_hash=q.intent_hash AND v.policy_id=a.id AND v.region_id IS NOT DISTINCT FROM t.region_id AND v.effective_at<=e.occurred_at AND v.valid_until>clock_timestamp() AND (NOT a.require_known_origin OR v.origin_state='known_school') AND o.state=v.origin_state AND o.origin_campus_id IS NOT DISTINCT FROM v.origin_campus_id AND o.source_reference=v.source_reference AND o.policy_reference=v.policy_reference AND o.coverage_state='complete' AND o.provenance_state='accepted')) AND NOT o.revoked AND o.effective_at=e.occurred_at
 AND old.sealed AND old.coverage='complete' AND old.provenance='accepted' AND old.effective_at<e.occurred_at AND (old.valid_until IS NULL OR old.valid_until>clock_timestamp())
 AND c.sealed AND c.coverage='complete' AND c.provenance='accepted' AND c.region_id IS NOT DISTINCT FROM old.region_id AND c.region_id IS NOT DISTINCT FROM t.region_id
 AND c.effective_at=e.occurred_at AND c.valid_until IS NOT DISTINCT FROM old.valid_until AND c.source_reference='rating-create:'||actor::text||':'||request::text AND c.policy_reference=a.policy_reference,false)
 THEN RAISE EXCEPTION 'Invalid native target creation chain' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.native_create_policy_heads WHERE policy_id=a.id)
 OR NOT EXISTS(SELECT 1 FROM whaleu_ratings.catalog_heads WHERE catalog_id=c.id AND scope_key=coalesce(t.region_id::text,'global'))
 OR NOT EXISTS(SELECT 1 FROM whaleu_ratings.target_origin_heads WHERE source_id=o.id AND target_id=t.id)
 OR NOT EXISTS(SELECT 1 FROM whaleu_ratings.categories WHERE catalog_id=old.id AND id=t.category_id AND kind=a.generic_kind AND revision=(t.envelope->>'categoryRevision')::uuid)
 THEN RAISE EXCEPTION 'Creation authority or head mismatch' USING ERRCODE='23514';END IF;
 IF (SELECT count(*) FROM (SELECT 1 FROM whaleu_ratings.categories WHERE catalog_id=old.id LIMIT 10001) x)>10000
 OR (SELECT count(*) FROM (SELECT 1 FROM whaleu_ratings.target_memberships WHERE catalog_id=old.id LIMIT 100001) x)>100000
 OR EXISTS(WITH RECURSIVE path AS (SELECT *,1 depth FROM whaleu_ratings.categories WHERE catalog_id=old.id AND id=t.category_id UNION ALL SELECT x.*,ancestor.depth+1 FROM whaleu_ratings.categories x JOIN path ancestor ON x.catalog_id=ancestor.catalog_id AND x.id=ancestor.parent_id WHERE ancestor.depth<3) SELECT 1 FROM path WHERE NOT active OR hidden)
 THEN RAISE EXCEPTION 'Creation catalog budget or ancestry unavailable' USING ERRCODE='23514';END IF;
 -- Full set equality, excluding only the catalog key; no page-sized publication.
 IF EXISTS((SELECT to_jsonb(x)-'catalog_id' FROM whaleu_ratings.categories x WHERE catalog_id=old.id EXCEPT SELECT to_jsonb(x)-'catalog_id' FROM whaleu_ratings.categories x WHERE catalog_id=c.id)
 UNION ALL (SELECT to_jsonb(x)-'catalog_id' FROM whaleu_ratings.categories x WHERE catalog_id=c.id EXCEPT SELECT to_jsonb(x)-'catalog_id' FROM whaleu_ratings.categories x WHERE catalog_id=old.id))
 OR EXISTS((SELECT to_jsonb(x)-'catalog_id' FROM whaleu_ratings.target_memberships x WHERE catalog_id=old.id EXCEPT SELECT to_jsonb(x)-'catalog_id' FROM whaleu_ratings.target_memberships x WHERE catalog_id=c.id AND target_id<>t.id)
 UNION ALL (SELECT to_jsonb(x)-'catalog_id' FROM whaleu_ratings.target_memberships x WHERE catalog_id=c.id AND target_id<>t.id EXCEPT SELECT to_jsonb(x)-'catalog_id' FROM whaleu_ratings.target_memberships x WHERE catalog_id=old.id))
 OR NOT EXISTS(SELECT 1 FROM whaleu_ratings.target_memberships WHERE catalog_id=c.id AND target_id=t.id AND category_id=t.category_id)
 THEN RAISE EXCEPTION 'Incomplete catalog derivation' USING ERRCODE='23514';END IF;
END $$;
CREATE FUNCTION whaleu_ratings.target_create_causal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM whaleu_ratings.verify_target_create(NEW.account_id,NEW.request_id);RETURN NULL;END $$;
CREATE CONSTRAINT TRIGGER rating_create_request_causal AFTER INSERT OR UPDATE ON whaleu_ratings.requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.operation='create_target') EXECUTE FUNCTION whaleu_ratings.target_create_causal();
CREATE CONSTRAINT TRIGGER rating_create_closure_causal AFTER INSERT ON whaleu_ratings.target_creation_closures DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.target_create_causal();
CREATE CONSTRAINT TRIGGER rating_create_transition_causal AFTER INSERT ON whaleu_ratings.target_create_transitions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.target_create_causal();
-- Only managed sources carry this marker. Existing historical/import fixtures remain
-- distinct; they cannot manufacture a managed fresh source without its transition.
CREATE FUNCTION whaleu_ratings.managed_source_causal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e whaleu_ratings.target_create_transitions;
BEGIN
 IF NEW.source_reference LIKE 'rating-create:%' THEN
 SELECT * INTO e FROM whaleu_ratings.target_create_transitions WHERE source_id=NEW.id;
 IF e.target_id IS NULL THEN RAISE EXCEPTION 'Managed native source requires create command' USING ERRCODE='23514';END IF;
 PERFORM whaleu_ratings.verify_target_create(e.account_id,e.request_id);END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER rating_managed_source_causal AFTER INSERT ON whaleu_ratings.target_sources DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.managed_source_causal();
DO $$ DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['native_create_policies','native_origin_evidence','target_preparations','target_create_transitions','target_creation_closures','command_claims'] LOOP
 EXECUTE format('CREATE TRIGGER rating_create_immutable BEFORE UPDATE OR DELETE ON whaleu_ratings.%I FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.immutable()',tab);
 EXECUTE format('CREATE TRIGGER rating_create_retain BEFORE TRUNCATE ON whaleu_ratings.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.immutable()',tab);END LOOP;
 FOREACH tab IN ARRAY ARRAY['native_create_policies','native_create_policy_heads','native_origin_evidence','target_preparations','target_create_transitions','target_creation_closures'] LOOP
 EXECUTE format('CREATE TRIGGER a0_rating_create_writer BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.policy_writer()',tab);END LOOP;
END $$;

CREATE TRIGGER rating_create_policy_head_retain BEFORE TRUNCATE ON whaleu_ratings.native_create_policy_heads FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.immutable();
