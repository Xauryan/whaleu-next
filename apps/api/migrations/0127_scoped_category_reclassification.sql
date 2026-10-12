-- Inactive without explicitly accepted source, issuer and exact Review evidence.
-- Original post/category/publication/child bytes and prior migrations remain intact.
CREATE FUNCTION whaleu_community.post_category_candidate(value text) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT value IN ('discussion','confession','companions','pets','internships','scenery','dorms','research','deep_sea')
$$;
-- Strict shape is a prerequisite, never acceptance of a production crosswalk.
CREATE FUNCTION whaleu_community.post_category_policy_definition_valid(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE edge jsonb;BEGIN
 IF whaleu_community.post_owner_visibility_keys(value,ARRAY['version','authorMode','content','component','distribution','sync','anonymousDm','origin','crosswalk','transitions','continueDescendants','futureChildren','descendantMedia']) IS DISTINCT FROM true
 OR value->'version' IS DISTINCT FROM '1'::jsonb
 OR value->>'authorMode' IS DISTINCT FROM 'named' OR value->>'content' IS DISTINCT FROM 'text_only'
 OR value->>'component' IS DISTINCT FROM 'none' OR value->>'distribution' IS DISTINCT FROM 'regional'
 OR value->>'sync' IS DISTINCT FROM 'none' OR value->'anonymousDm' IS DISTINCT FROM 'false'::jsonb
 OR value->>'origin' IS DISTINCT FROM 'native' OR jsonb_typeof(value->'crosswalk') IS DISTINCT FROM 'object'
 OR jsonb_typeof(value->'transitions') IS DISTINCT FROM 'array'
 OR jsonb_typeof(value->'continueDescendants') IS DISTINCT FROM 'boolean'
 OR value->>'futureChildren' IS DISTINCT FROM 'original_envelope_plus_reviewed_current_parent'
 OR coalesce(value->>'descendantMedia' IN ('text_only','retain_current_media_proof'),false)=false THEN RETURN false;END IF;
 IF value->'crosswalk'='{}'::jsonb OR NOT (value->'crosswalk') <@ '{"discussion":2,"confession":4,"companions":99,"pets":10,"internships":11,"scenery":12,"dorms":13,"research":14,"deep_sea":15}'::jsonb
 OR jsonb_array_length(value->'transitions')=0 OR jsonb_array_length(value->'transitions')>72
 OR (SELECT count(*) FROM (SELECT DISTINCT item FROM jsonb_array_elements(value->'transitions') item) unique_edges)<>jsonb_array_length(value->'transitions') THEN RETURN false;END IF;
 FOR edge IN SELECT * FROM jsonb_array_elements(value->'transitions') LOOP
  IF whaleu_community.post_owner_visibility_keys(edge,ARRAY['from','to']) IS DISTINCT FROM true
  OR jsonb_typeof(edge->'from') IS DISTINCT FROM 'string' OR jsonb_typeof(edge->'to') IS DISTINCT FROM 'string'
  OR edge->>'from'=edge->>'to' OR NOT (value->'crosswalk') ?& ARRAY[edge->>'from',edge->>'to'] THEN RETURN false;END IF;
 END LOOP;
 RETURN true;END$$;
CREATE TABLE whaleu_community.post_category_issuers (
 id uuid PRIMARY KEY, source_ref text NOT NULL CHECK(length(btrim(source_ref))>0),
 accepted_at timestamptz NOT NULL CHECK(isfinite(accepted_at)),
 valid_until timestamptz NOT NULL CHECK(isfinite(valid_until) AND valid_until>accepted_at)
);
CREATE TABLE whaleu_community.post_category_issuer_withdrawals (
 issuer_id uuid PRIMARY KEY REFERENCES whaleu_community.post_category_issuers(id),
 withdrawn_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(withdrawn_at))
);
CREATE TABLE whaleu_community.post_category_policies (
 id uuid PRIMARY KEY, source_key text NOT NULL CHECK(length(btrim(source_key))>0),
 revision integer NOT NULL CHECK(revision>0), source_ref text NOT NULL CHECK(length(btrim(source_ref))>0),
 original_region_id uuid NOT NULL REFERENCES whaleu_campus.operating_regions(id),
 issuer_id uuid NOT NULL REFERENCES whaleu_community.post_category_issuers(id),
 definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object' AND octet_length(definition::text)<16384 AND whaleu_community.post_category_policy_definition_valid(definition)),
 digest text NOT NULL CHECK(digest=encode(sha256(convert_to('whaleu:post-category-policy:v1'||chr(10)||whaleu_community.content_canonical_json(definition),'UTF8')),'hex')),
 accepted_at timestamptz NOT NULL CHECK(isfinite(accepted_at)),
 valid_until timestamptz NOT NULL CHECK(isfinite(valid_until) AND valid_until>accepted_at),
 UNIQUE(source_key,revision),
 CHECK(coalesce(definition->>'version'='1' AND definition->>'authorMode'='named'
  AND definition->>'content'='text_only' AND definition->>'component'='none'
  AND definition->>'distribution'='regional' AND definition->>'sync'='none'
  AND definition->'anonymousDm'='false'::jsonb AND definition->>'origin'='native'
  AND jsonb_typeof(definition->'crosswalk')='object' AND jsonb_typeof(definition->'transitions')='array'
  AND jsonb_typeof(definition->'continueDescendants')='boolean'
  AND definition->>'futureChildren'='original_envelope_plus_reviewed_current_parent'
  AND definition->>'descendantMedia' IN ('text_only','retain_current_media_proof'),false))
);
CREATE INDEX post_category_policies_region ON whaleu_community.post_category_policies(original_region_id,id);
CREATE TABLE whaleu_community.post_category_policy_heads (
 source_key text PRIMARY KEY, policy_id uuid NOT NULL UNIQUE REFERENCES whaleu_community.post_category_policies(id)
);
CREATE TABLE whaleu_community.post_category_policy_withdrawals (
 policy_id uuid PRIMARY KEY REFERENCES whaleu_community.post_category_policies(id),
 withdrawn_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(withdrawn_at))
);
CREATE TABLE whaleu_community.post_category_reviews (
 id uuid PRIMARY KEY, issuer_id uuid NOT NULL REFERENCES whaleu_community.post_category_issuers(id),
 policy_id uuid NOT NULL REFERENCES whaleu_community.post_category_policies(id),
 purpose text NOT NULL CHECK(purpose IN ('community_post_category_reclassification','community_child_current_parent_classification')),
 envelope jsonb NOT NULL CHECK(jsonb_typeof(envelope)='object' AND octet_length(envelope::text)<65536),
 digest text NOT NULL CHECK(digest=encode(sha256(convert_to('whaleu:post-category-review:v1'||chr(10)||whaleu_community.content_canonical_json(envelope),'UTF8')),'hex')),
 result text NOT NULL CHECK(result IN ('allow','reject','pending')),
 accepted_at timestamptz NOT NULL CHECK(isfinite(accepted_at)),
 valid_until timestamptz NOT NULL CHECK(isfinite(valid_until) AND valid_until>accepted_at),
 CHECK(envelope->>'purpose' IS NOT DISTINCT FROM purpose), CHECK(envelope->>'version' IS NOT DISTINCT FROM '1')
);
CREATE INDEX post_category_review_exact ON whaleu_community.post_category_reviews(purpose,digest,accepted_at DESC,id DESC);
CREATE TABLE whaleu_community.post_category_review_withdrawals (
 review_id uuid PRIMARY KEY REFERENCES whaleu_community.post_category_reviews(id),
 withdrawn_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(withdrawn_at))
);
CREATE TABLE whaleu_community.post_category_commands (
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,
 post_id uuid NOT NULL REFERENCES whaleu_community.posts(id),session_id uuid NOT NULL REFERENCES whaleu_identity.sessions(id),
 grant_id uuid REFERENCES whaleu_authorization.role_grants(id),
 intent_hash text NOT NULL CHECK(intent_hash ~ '^[a-f0-9]{64}$'), command jsonb NOT NULL CHECK(jsonb_typeof(command)='object'), receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt)='object'),
 mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(), PRIMARY KEY(actor_id,request_id),
 CHECK(request_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 CHECK(octet_length(command::text)<4096 AND octet_length(receipt::text)<4096),
 CHECK(intent_hash=encode(sha256(convert_to('whaleu:post-category-command:v1'||chr(10)||whaleu_community.content_canonical_json(jsonb_build_object('actor',actor_id::text,'command',command)),'UTF8')),'hex')),
 CHECK(command->>'clientRequestId' IS NOT DISTINCT FROM request_id::text),
 CHECK(command->>'postId' IS NOT DISTINCT FROM post_id::text),
 CHECK(receipt->>'requestId' IS NOT DISTINCT FROM request_id::text),
 CHECK(receipt->>'postId' IS NOT DISTINCT FROM post_id::text),
 CHECK(receipt->'expectedRevision' IS NOT DISTINCT FROM command->'expectedRevision'),
 CHECK(receipt->'targetCategory' IS NOT DISTINCT FROM command->'targetCategory')
);
CREATE TABLE whaleu_community.post_category_events (
 id uuid PRIMARY KEY, post_id uuid NOT NULL REFERENCES whaleu_community.posts(id),
 revision integer NOT NULL CHECK(revision>0), previous_event_id uuid REFERENCES whaleu_community.post_category_events(id),
 original_category text NOT NULL CHECK(whaleu_community.post_category_candidate(original_category)),
 previous_category text NOT NULL CHECK(whaleu_community.post_category_candidate(previous_category)),
 current_category text NOT NULL CHECK(whaleu_community.post_category_candidate(current_category)),
 original_decision_id uuid NOT NULL REFERENCES whaleu_community.content_approval_decisions(id), original_digest text NOT NULL CHECK(original_digest ~ '^[a-f0-9]{64}$'),
 policy_id uuid NOT NULL REFERENCES whaleu_community.post_category_policies(id),
 review_id uuid NOT NULL UNIQUE REFERENCES whaleu_community.post_category_reviews(id),
 grant_id uuid NOT NULL REFERENCES whaleu_authorization.role_grants(id),
 selected_authority jsonb NOT NULL CHECK(jsonb_typeof(selected_authority)='object'),
 actor_id uuid NOT NULL, request_id uuid NOT NULL,
 recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at)),
 continuation_cutoff timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(continuation_cutoff)),
 mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 UNIQUE(post_id,revision), UNIQUE(actor_id,request_id), UNIQUE(id,post_id,revision,current_category),
 FOREIGN KEY(actor_id,request_id) REFERENCES whaleu_community.post_category_commands(actor_id,request_id) DEFERRABLE INITIALLY DEFERRED,
 CHECK(current_category<>previous_category), CHECK((revision=1)=(previous_event_id IS NULL))
);
CREATE TABLE whaleu_community.post_category_heads (
 post_id uuid PRIMARY KEY REFERENCES whaleu_community.posts(id),
 current_category text NOT NULL, revision integer NOT NULL CHECK(revision>0), event_id uuid NOT NULL UNIQUE,
 original_space_id uuid NOT NULL REFERENCES whaleu_community.spaces(id),
 original_published_at timestamptz NOT NULL CHECK(isfinite(original_published_at)),
 mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 FOREIGN KEY(event_id,post_id,revision,current_category) REFERENCES whaleu_community.post_category_events(id,post_id,revision,current_category) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX post_category_heads_filter ON whaleu_community.post_category_heads(current_category,post_id);
CREATE INDEX post_category_heads_scope_seek ON whaleu_community.post_category_heads(current_category,original_space_id,original_published_at DESC,post_id DESC);
CREATE TABLE whaleu_community.post_category_child_bindings (
 content_kind text NOT NULL CHECK(content_kind IN ('comment','reply')),content_id uuid NOT NULL,
 post_id uuid NOT NULL REFERENCES whaleu_community.posts(id),event_id uuid NOT NULL REFERENCES whaleu_community.post_category_events(id),
 original_decision_id uuid NOT NULL REFERENCES whaleu_community.content_approval_decisions(id),
 original_digest text NOT NULL CHECK(original_digest ~ '^[a-f0-9]{64}$'),review_id uuid NOT NULL UNIQUE REFERENCES whaleu_community.post_category_reviews(id),
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,
 mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),PRIMARY KEY(content_kind,content_id),
 UNIQUE(actor_id,request_id), UNIQUE(original_decision_id),
 CHECK(request_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
);
CREATE INDEX post_category_child_parent ON whaleu_community.post_category_child_bindings(post_id,event_id);
CREATE FUNCTION whaleu_community.post_category_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Category evidence cannot be removed or rewritten' USING ERRCODE='23514',CONSTRAINT='post_category_causal';END$$;
DO $$DECLARE table_name text; BEGIN
 FOREACH table_name IN ARRAY ARRAY['post_category_issuers','post_category_issuer_withdrawals','post_category_policies','post_category_policy_withdrawals','post_category_reviews','post_category_review_withdrawals','post_category_commands','post_category_events','post_category_child_bindings'] LOOP
 EXECUTE format('CREATE TRIGGER category_immutable BEFORE UPDATE OR DELETE ON whaleu_community.%I FOR EACH ROW EXECUTE FUNCTION whaleu_community.post_category_immutable()',table_name);
 EXECUTE format('CREATE TRIGGER category_retain BEFORE TRUNCATE ON whaleu_community.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.post_category_immutable()',table_name);
 END LOOP;
 FOREACH table_name IN ARRAY ARRAY['post_category_issuers','post_category_issuer_withdrawals','post_category_policies','post_category_policy_heads','post_category_policy_withdrawals','post_category_reviews','post_category_review_withdrawals','post_category_heads','post_category_events','post_category_child_bindings'] LOOP
 EXECUTE format('CREATE TRIGGER a_discovery_count_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.advance_discovery_count_epoch()',table_name);
 END LOOP;
END$$;
CREATE TRIGGER category_heads_no_delete BEFORE DELETE OR TRUNCATE ON whaleu_community.post_category_heads FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.post_category_immutable();
CREATE TRIGGER category_policy_heads_no_delete BEFORE DELETE OR TRUNCATE ON whaleu_community.post_category_policy_heads FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.post_category_immutable();
CREATE FUNCTION whaleu_community.post_category_policy_head_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n whaleu_community.post_category_policies;o whaleu_community.post_category_policies;BEGIN
 SELECT * INTO n FROM whaleu_community.post_category_policies WHERE id=NEW.policy_id;
 IF TG_OP='UPDATE' THEN SELECT * INTO o FROM whaleu_community.post_category_policies WHERE id=OLD.policy_id;END IF;
 IF n.source_key IS DISTINCT FROM NEW.source_key OR (TG_OP='UPDATE' AND (OLD.source_key<>NEW.source_key OR n.original_region_id<>o.original_region_id OR n.revision<=o.revision)) THEN RAISE EXCEPTION 'Exact monotonic policy head required' USING ERRCODE='23514',CONSTRAINT='post_category_causal';END IF;
 RETURN NEW;END$$;
CREATE TRIGGER category_policy_head_guard BEFORE INSERT OR UPDATE ON whaleu_community.post_category_policy_heads FOR EACH ROW EXECUTE FUNCTION whaleu_community.post_category_policy_head_guard();
CREATE VIEW whaleu_community.post_category_policy_live AS
 SELECT p.*,least(p.valid_until,i.valid_until) AS effective_until FROM whaleu_community.post_category_policies p
 JOIN whaleu_community.post_category_policy_heads h ON h.policy_id=p.id AND h.source_key=p.source_key
 JOIN whaleu_community.post_category_issuers i ON i.id=p.issuer_id
 WHERE p.accepted_at<=clock_timestamp() AND p.valid_until>clock_timestamp()
 AND i.accepted_at<=clock_timestamp() AND i.valid_until>clock_timestamp() AND p.accepted_at>=i.accepted_at
 AND NOT EXISTS(SELECT 1 FROM whaleu_community.post_category_policy_withdrawals w WHERE w.policy_id=p.id)
 AND NOT EXISTS(SELECT 1 FROM whaleu_community.post_category_issuer_withdrawals w WHERE w.issuer_id=i.id);
CREATE VIEW whaleu_community.post_category_review_live AS
 SELECT r.*,least(r.valid_until,p.effective_until) AS effective_until FROM whaleu_community.post_category_reviews r
 JOIN whaleu_community.post_category_policy_live p ON p.id=r.policy_id AND p.issuer_id=r.issuer_id
 WHERE r.result='allow' AND r.accepted_at>=p.accepted_at AND r.accepted_at<=clock_timestamp() AND r.valid_until>clock_timestamp()
 AND NOT EXISTS(SELECT 1 FROM whaleu_community.post_category_review_withdrawals w WHERE w.review_id=r.id)
 AND NOT EXISTS(SELECT 1 FROM whaleu_community.post_category_reviews newer WHERE newer.purpose=r.purpose AND newer.digest=r.digest AND (newer.accepted_at,newer.id)>(r.accepted_at,r.id));
-- Scalar predicate is used for bounded exact event validation, not whole-history scans.
CREATE FUNCTION whaleu_community.post_category_policy_allows(definition jsonb,original text,previous text,target text) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT whaleu_community.post_category_policy_definition_valid(definition) AND whaleu_community.post_category_candidate(original) AND whaleu_community.post_category_candidate(previous) AND whaleu_community.post_category_candidate(target)
 AND definition->'crosswalk' ?& ARRAY[original,previous,target]
 AND definition->'transitions' @> jsonb_build_array(jsonb_build_object('from',previous,'to',target))
 AND (definition->'crosswalk') <@ '{"discussion":2,"confession":4,"companions":99,"pets":10,"internships":11,"scenery":12,"dorms":13,"research":14,"deep_sea":15}'::jsonb
$$;
CREATE FUNCTION whaleu_community.post_category_original_review_current(decision uuid) RETURNS boolean LANGUAGE sql STABLE STRICT AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_community.content_approval_decisions d
 JOIN whaleu_community.content_approval_heads h ON h.decision_id=d.id
 JOIN whaleu_community.content_approval_events e ON (e.id,e.decision_id)=(h.event_id,d.id)
 JOIN whaleu_community.content_approval_policies p ON p.id=d.policy_revision_id
 WHERE d.id=decision AND d.result='allow' AND d.coverage='complete' AND d.provenance='accepted'
 AND d.evaluated_at<=clock_timestamp() AND (d.visibility_until IS NULL OR d.visibility_until>clock_timestamp())
 AND e.state='allow' AND e.coverage='complete' AND e.provenance='accepted' AND e.occurred_at>=d.evaluated_at AND e.occurred_at<=clock_timestamp()
 AND p.coverage='complete' AND p.provenance='accepted' AND p.valid_from<=d.evaluated_at AND p.valid_from<=clock_timestamp()
 AND (p.valid_until IS NULL OR p.valid_until>clock_timestamp()))
$$;
CREATE VIEW whaleu_community.post_category_live AS
 SELECT h.post_id,h.current_category,h.revision,h.event_id,e.policy_id,e.review_id,
 least(r.valid_until,p.effective_until,original.visibility_until,original.policy_valid_until) AS valid_until,
 h.original_space_id,h.original_published_at
 FROM whaleu_community.post_category_heads h
 -- Exact-key barriers keep both execution and join planning bounded. The one
 -- category policy proof is shared by transition and Review validation; the one
 -- original approval chain supplies both current validity and its deadline.
 JOIN LATERAL (SELECT candidate.* FROM whaleu_community.post_category_events candidate
  WHERE (candidate.id,candidate.post_id,candidate.revision,candidate.current_category)=(h.event_id,h.post_id,h.revision,h.current_category)
  OFFSET 0) e ON true
 JOIN LATERAL (SELECT candidate.* FROM whaleu_community.post_category_policy_live candidate
  WHERE candidate.id=e.policy_id OFFSET 0) p ON true
 -- Exactly post_category_review_live's predicates, sharing p rather than
 -- expanding policy_live again. Any newer exact intent suppresses this review,
 -- including future, pending, rejecting, withdrawn or separately allowed rows.
 JOIN LATERAL (SELECT candidate.valid_until FROM whaleu_community.post_category_reviews candidate
  WHERE candidate.id=e.review_id AND candidate.policy_id=p.id AND candidate.issuer_id=p.issuer_id
  AND candidate.purpose='community_post_category_reclassification' AND candidate.result='allow'
  AND candidate.accepted_at>=p.accepted_at AND candidate.accepted_at<=clock_timestamp() AND candidate.valid_until>clock_timestamp()
  AND NOT EXISTS(SELECT 1 FROM whaleu_community.post_category_review_withdrawals w WHERE w.review_id=candidate.id)
  AND NOT EXISTS(SELECT 1 FROM whaleu_community.post_category_reviews newer WHERE newer.purpose=candidate.purpose AND newer.digest=candidate.digest
   AND (newer.accepted_at,newer.id)>(candidate.accepted_at,candidate.id))
  OFFSET 0) r ON true
 -- The immutable post/binding match is unchanged. Inline exactly the predicates
 -- of post_category_original_review_current once, reusing the same original
 -- decision and policy for the visibility horizon instead of querying them twice.
 JOIN LATERAL (
  SELECT b.scope,d.visibility_until,policy.valid_until AS policy_valid_until
  FROM whaleu_community.posts post
  JOIN whaleu_community.content_approval_bindings b ON b.content_kind='post' AND b.content_id=post.id
   AND b.decision_id=e.original_decision_id AND b.digest=e.original_digest
  JOIN whaleu_community.content_approval_decisions d ON d.id=b.decision_id
  JOIN whaleu_community.content_approval_heads original_head ON original_head.decision_id=d.id
  JOIN whaleu_community.content_approval_events original_event ON (original_event.id,original_event.decision_id)=(original_head.event_id,d.id)
  JOIN whaleu_community.content_approval_policies policy ON policy.id=d.policy_revision_id
  WHERE post.id=e.post_id AND post.category=e.original_category
  AND post.space_id=h.original_space_id AND post.published_at=h.original_published_at
  AND d.result='allow' AND d.coverage='complete' AND d.provenance='accepted'
  AND d.evaluated_at<=clock_timestamp() AND (d.visibility_until IS NULL OR d.visibility_until>clock_timestamp())
  AND original_event.state='allow' AND original_event.coverage='complete' AND original_event.provenance='accepted'
  AND original_event.occurred_at>=d.evaluated_at AND original_event.occurred_at<=clock_timestamp()
  AND policy.coverage='complete' AND policy.provenance='accepted' AND policy.valid_from<=d.evaluated_at AND policy.valid_from<=clock_timestamp()
  AND (policy.valid_until IS NULL OR policy.valid_until>clock_timestamp())
  OFFSET 0) original ON true
 WHERE e.selected_authority->>'id'=e.grant_id::text AND e.selected_authority->>'accountId'=e.actor_id::text
 AND ((e.selected_authority->>'role'='super_admin' AND e.selected_authority->'operatingRegionId'='null'::jsonb)
 OR (e.selected_authority->>'role'='school_admin' AND e.selected_authority->>'operatingRegionId'=p.original_region_id::text))
 AND original.scope->>'originalRegionId'=p.original_region_id::text
 AND whaleu_community.post_category_policy_allows(p.definition,e.original_category,e.previous_category,e.current_category);
CREATE FUNCTION whaleu_community.post_category_command_envelope(actor uuid,body jsonb,selected_grant uuid,selected_policy uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('version',1,'purpose','community_post_category_reclassification',
  'postId',p.id,'actorId',actor,'requestId',body->>'clientRequestId','command',body,
  'intentHash',encode(sha256(convert_to('whaleu:post-category-command:v1'||chr(10)||whaleu_community.content_canonical_json(jsonb_build_object('actor',actor::text,'command',body)),'UTF8')),'hex'),
  'grantId',selected_grant,'original',jsonb_build_object('decisionId',b.decision_id,'digest',b.digest,'envelope',b.envelope),
  'previous',jsonb_build_object('revision',coalesce(h.revision,0),'eventId',h.event_id,'category',coalesce(h.current_category,p.category)),
  'targetCategory',body->>'targetCategory','policy',jsonb_build_object('id',s.id,'sourceKey',s.source_key,'revision',s.revision,'digest',s.digest))
 FROM whaleu_community.posts p JOIN whaleu_community.content_approval_bindings b ON b.content_kind='post' AND b.content_id=p.id
 LEFT JOIN whaleu_community.post_category_heads h ON h.post_id=p.id
 JOIN whaleu_community.post_category_policies s ON s.id=selected_policy
 WHERE p.id=(body->>'postId')::uuid
$$;
CREATE FUNCTION whaleu_community.post_category_supported(postid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT coalesce(p.visibility='approved' AND p.deleted_at IS NULL AND p.author_mode='named'
 AND NOT coalesce(v.owner_hidden,false) AND s.is_active AND s.kind='regional' AND s.operating_region_id IS NOT NULL
 AND whaleu_community.post_category_candidate(p.category) AND b.envelope_version IN(1,2)
 AND b.envelope->>'authorMode'='named' AND b.envelope->'images'='[]'::jsonb
 AND b.envelope->'component'='{"kind":"none"}'::jsonb AND b.envelope->'trading'='null'::jsonb
 AND coalesce(b.envelope->'allowAnonymousDm','false'::jsonb)='false'::jsonb
 AND b.scope->>'sync'='none' AND b.scope->>'originalRegionId'=s.operating_region_id::text
 AND b.scope->>'originalSpaceId'=p.space_id::text
 AND b.envelope->>'category'=p.category AND b.envelope->>'accountId'=p.account_id::text
 AND b.envelope->>'text'=p.text AND b.envelope->>'spaceId'=p.space_id::text
 AND b.envelope->>'commentsPolicy'=p.comments_policy
 AND b.envelope=d.envelope AND b.digest=d.digest AND b.account_id=p.account_id
 AND EXISTS(SELECT 1 FROM whaleu_campus.operating_regions region WHERE region.id=s.operating_region_id AND region.is_active)
 AND NOT EXISTS(SELECT 1 FROM whaleu_community.post_images image WHERE image.post_id=p.id)
 AND EXISTS(SELECT 1 FROM whaleu_community.report_origins origin
 JOIN whaleu_community.publication_requests request ON (request.account_id,request.client_request_id)=(origin.owner_account_id,origin.source_request_id)
 WHERE origin.kind='post' AND origin.target_id=p.id AND origin.owner_account_id=p.account_id AND origin.provenance='native_publication'
 AND request.operation='publish_post' AND request.receipt->>'outcome'='created' AND request.receipt->>'resourceId'=p.id::text)
 AND d.result='allow' AND d.provenance='accepted' AND d.coverage='complete'
 AND e.state='allow' AND e.provenance='accepted' AND e.coverage='complete'
 AND e.occurred_at>=d.evaluated_at AND e.occurred_at<=clock_timestamp() AND d.evaluated_at<=clock_timestamp()
 AND (d.visibility_until IS NULL OR d.visibility_until>clock_timestamp())
 AND pol.provenance='accepted' AND pol.coverage='complete' AND pol.valid_from<=d.evaluated_at AND pol.valid_from<=clock_timestamp()
 AND (pol.valid_until IS NULL OR pol.valid_until>clock_timestamp()),false)
 FROM whaleu_community.posts p JOIN whaleu_community.spaces s ON s.id=p.space_id
 JOIN whaleu_community.content_approval_bindings b ON b.content_kind='post' AND b.content_id=p.id
 JOIN whaleu_community.content_approval_decisions d ON d.id=b.decision_id
 JOIN whaleu_community.content_approval_heads h ON h.decision_id=d.id
 JOIN whaleu_community.content_approval_events e ON e.id=h.event_id AND e.decision_id=d.id
 JOIN whaleu_community.content_approval_policies pol ON pol.id=d.policy_revision_id
 LEFT JOIN whaleu_community.post_owner_visibility v ON v.post_id=p.id WHERE p.id=postid
$$;
CREATE FUNCTION whaleu_community.post_category_grant_allowed(actor uuid,selected_grant uuid,postid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_authorization.role_grants g
 JOIN whaleu_community.content_approval_bindings b ON b.content_kind='post' AND b.content_id=postid
 WHERE g.id=selected_grant AND g.account_id=actor AND g.revoked_at IS NULL
 AND g.valid_from<=clock_timestamp() AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp())
 AND ((g.role='super_admin' AND g.operating_region_id IS NULL) OR
 (g.role='school_admin' AND g.operating_region_id::text=b.scope->>'originalRegionId')))
$$;
CREATE FUNCTION whaleu_community.post_category_authority_snapshot(selected_grant uuid) RETURNS jsonb LANGUAGE sql STABLE STRICT AS $$
 SELECT jsonb_build_object('id',g.id,'accountId',g.account_id,'role',g.role,'operatingRegionId',g.operating_region_id,
 'validFrom',g.valid_from,'expiresAt',g.expires_at) FROM whaleu_authorization.role_grants g WHERE g.id=selected_grant
$$;
CREATE FUNCTION whaleu_community.post_category_command_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Category writes require current committed facts' USING ERRCODE='23514',CONSTRAINT='post_category_causal';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:post-category-request:v1:'||NEW.actor_id::text||':'||NEW.request_id::text,0));
 -- An exact durable cancellation is identity/key metadata only. Malformed
 -- lookalikes still fail the strict command/receipt/hash constraints below.
 IF (NEW.receipt->>'outcome'='rejected' AND NEW.receipt->>'code'='POST_CATEGORY_CANCELLED') IS DISTINCT FROM true THEN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('whaleu:named-block-policy:v1',0));
  PERFORM 1 FROM whaleu_community.posts WHERE id=NEW.post_id FOR UPDATE;
 END IF;
 IF NEW.mutation_transaction<>pg_current_xact_id() OR
 (whaleu_community.post_owner_visibility_keys(NEW.command,ARRAY['clientRequestId','postId','expectedRevision','targetCategory'])
 AND jsonb_typeof(NEW.command->'clientRequestId')='string' AND jsonb_typeof(NEW.command->'postId')='string'
 AND jsonb_typeof(NEW.command->'targetCategory')='string' AND jsonb_typeof(NEW.command->'expectedRevision')='number'
 AND (NEW.command->>'expectedRevision')~'^(0|[1-9][0-9]{0,9})$'
 AND (NEW.command->>'expectedRevision')::numeric BETWEEN 0 AND 2147483646
 AND whaleu_community.post_category_candidate(NEW.command->>'targetCategory')
 AND NEW.receipt->>'outcome' IN('applied','unchanged','rejected')
 AND whaleu_community.post_owner_visibility_keys(NEW.receipt,CASE WHEN NEW.receipt->>'outcome'='rejected'
 THEN ARRAY['requestId','postId','expectedRevision','targetCategory','outcome','code']
 ELSE ARRAY['requestId','postId','expectedRevision','targetCategory','outcome','revision','eventId','recordedAt'] END)) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'Exact strict category command required' USING ERRCODE='23514',CONSTRAINT='post_category_causal';END IF;
 IF NEW.receipt->>'outcome'='rejected' THEN
  IF coalesce(NEW.receipt->>'code' IN('POST_CATEGORY_STALE','POST_CATEGORY_CANCELLED','POST_CATEGORY_UNAVAILABLE'),false)=false THEN RAISE EXCEPTION 'Known terminal category rejection required' USING ERRCODE='23514',CONSTRAINT='post_category_causal';END IF;
 ELSE
  -- Public recovery receipts use the native UTC ISO contract (at most millis).
  -- PostgreSQL's timestamp parser also accepts words and wider precision; those
  -- are not transport-safe receipt values. The separate server cutoff remains
  -- full precision and is never serialized as this public audit timestamp.
  IF (jsonb_typeof(NEW.receipt->'recordedAt')='string' AND (NEW.receipt->>'recordedAt')~'^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]{1,3})?Z$') IS DISTINCT FROM true
  THEN RAISE EXCEPTION 'Native UTC ISO category receipt timestamp required' USING ERRCODE='23514',CONSTRAINT='post_category_causal';END IF;
  IF (jsonb_typeof(NEW.receipt->'revision')='number' AND (NEW.receipt->>'revision')~'^(0|[1-9][0-9]{0,9})$'
   AND (NEW.receipt->>'revision')::numeric BETWEEN 0 AND 2147483647
   AND jsonb_typeof(NEW.receipt->'recordedAt')='string' AND isfinite((NEW.receipt->>'recordedAt')::timestamptz)
   AND (NEW.receipt->>'recordedAt')::timestamptz<=clock_timestamp()
   AND ((NEW.receipt->>'outcome'='applied' AND NEW.receipt->'revision'=to_jsonb((NEW.command->>'expectedRevision')::integer+1))
     OR (NEW.receipt->>'outcome'='unchanged' AND NEW.receipt->'revision'=NEW.command->'expectedRevision'))
   AND ((NEW.receipt->'revision'='0'::jsonb AND NEW.receipt->'eventId'='null'::jsonb)
     OR ((NEW.receipt->>'revision')::integer>0 AND jsonb_typeof(NEW.receipt->'eventId')='string'
       AND (NEW.receipt->>'eventId')::uuid IS NOT NULL))) IS DISTINCT FROM true
  THEN RAISE EXCEPTION 'Exact typed category result required' USING ERRCODE='23514',CONSTRAINT='post_category_causal';END IF;
 END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER category_command_guard BEFORE INSERT ON whaleu_community.post_category_commands FOR EACH ROW EXECUTE FUNCTION whaleu_community.post_category_command_guard();
CREATE FUNCTION whaleu_community.post_category_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p whaleu_community.posts;h whaleu_community.post_category_heads;q whaleu_community.post_category_commands;
 r whaleu_community.post_category_review_live;s whaleu_community.post_category_policy_live;b whaleu_community.content_approval_bindings;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Category writes require current committed facts' USING ERRCODE='23514',CONSTRAINT='post_category_causal';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:post-category-request:v1:'||NEW.actor_id::text||':'||NEW.request_id::text,0));
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('whaleu:named-block-policy:v1',0));
 SELECT * INTO p FROM whaleu_community.posts WHERE id=NEW.post_id FOR UPDATE;
 -- Prior child transactions held this same parent SHARE lock. Use server time
 -- after acquiring UPDATE, independent of rounded/backdated audit timestamps.
 NEW.continuation_cutoff:=clock_timestamp();
 SELECT * INTO h FROM whaleu_community.post_category_heads WHERE post_id=NEW.post_id;
 SELECT * INTO q FROM whaleu_community.post_category_commands WHERE actor_id=NEW.actor_id AND request_id=NEW.request_id;
 SELECT * INTO r FROM whaleu_community.post_category_review_live WHERE id=NEW.review_id;
 SELECT * INTO s FROM whaleu_community.post_category_policy_live WHERE id=NEW.policy_id;
 SELECT * INTO b FROM whaleu_community.content_approval_bindings WHERE content_kind='post' AND content_id=NEW.post_id;
 IF NEW.selected_authority IS NULL THEN NEW.selected_authority:=whaleu_community.post_category_authority_snapshot(NEW.grant_id);END IF;
 IF NEW.selected_authority IS DISTINCT FROM whaleu_community.post_category_authority_snapshot(NEW.grant_id)
 OR whaleu_community.post_category_supported(NEW.post_id) IS DISTINCT FROM true
 OR whaleu_community.post_category_grant_allowed(NEW.actor_id,NEW.grant_id,NEW.post_id) IS DISTINCT FROM true
 OR q.request_id IS NULL OR q.mutation_transaction<>pg_current_xact_id() OR NEW.mutation_transaction<>pg_current_xact_id()
 OR (q.post_id,q.grant_id) IS DISTINCT FROM (NEW.post_id,NEW.grant_id)
 OR q.receipt->>'outcome' IS DISTINCT FROM 'applied'
 OR q.receipt->>'eventId' IS DISTINCT FROM NEW.id::text OR q.receipt->>'revision' IS DISTINCT FROM NEW.revision::text
 OR q.command->>'expectedRevision' IS DISTINCT FROM coalesce(h.revision,0)::text
 OR q.command->>'targetCategory' IS DISTINCT FROM NEW.current_category
 OR NEW.revision<>coalesce(h.revision,0)+1 OR NEW.previous_event_id IS DISTINCT FROM h.event_id
 OR NEW.previous_category IS DISTINCT FROM coalesce(h.current_category,p.category)
 OR (NEW.original_category,NEW.original_decision_id,NEW.original_digest) IS DISTINCT FROM (p.category,b.decision_id,b.digest)
 OR NEW.recorded_at>clock_timestamp() OR NEW.continuation_cutoff<r.accepted_at OR (q.receipt->>'recordedAt')::timestamptz IS DISTINCT FROM NEW.recorded_at
 OR (h.event_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM whaleu_community.post_category_live WHERE post_id=NEW.post_id))
 OR r.id IS NULL OR s.id IS NULL OR r.policy_id<>s.id OR r.purpose<>'community_post_category_reclassification'
 OR s.original_region_id::text IS DISTINCT FROM b.scope->>'originalRegionId'
 OR whaleu_community.post_category_policy_allows(s.definition,NEW.original_category,NEW.previous_category,NEW.current_category) IS DISTINCT FROM true
 OR r.envelope IS DISTINCT FROM whaleu_community.post_category_command_envelope(NEW.actor_id,q.command,NEW.grant_id,NEW.policy_id)
 THEN RAISE EXCEPTION 'Exact category event evidence required' USING ERRCODE='23514',CONSTRAINT='post_category_causal';END IF;
 IF s.definition->'continueDescendants'<>'true'::jsonb AND
 (EXISTS(SELECT 1 FROM whaleu_community.root_comments WHERE post_id=NEW.post_id) OR EXISTS(SELECT 1 FROM whaleu_community.replies WHERE post_id=NEW.post_id))
 THEN RAISE EXCEPTION 'Explicit descendant continuation required' USING ERRCODE='23514',CONSTRAINT='post_category_causal';END IF;
 IF s.definition->>'descendantMedia'='text_only' AND
 (EXISTS(SELECT 1 FROM whaleu_community.root_comments c JOIN whaleu_community.comment_images i ON i.comment_id=c.id WHERE c.post_id=NEW.post_id)
 OR EXISTS(SELECT 1 FROM whaleu_community.replies c JOIN whaleu_community.reply_images i ON i.reply_id=c.id WHERE c.post_id=NEW.post_id))
 THEN RAISE EXCEPTION 'Explicit descendant Media continuation required' USING ERRCODE='23514',CONSTRAINT='post_category_causal';END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER category_event_guard BEFORE INSERT ON whaleu_community.post_category_events FOR EACH ROW EXECUTE FUNCTION whaleu_community.post_category_event_guard();
CREATE FUNCTION whaleu_community.post_category_head_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e whaleu_community.post_category_events;p whaleu_community.posts;BEGIN
 SELECT * INTO p FROM whaleu_community.posts WHERE id=NEW.post_id FOR UPDATE;
 IF NEW.original_space_id IS NULL THEN NEW.original_space_id:=p.space_id;END IF;
 IF NEW.original_published_at IS NULL THEN NEW.original_published_at:=p.published_at;END IF;
 IF (NEW.original_space_id,NEW.original_published_at) IS DISTINCT FROM (p.space_id,p.published_at)
 OR (TG_OP='UPDATE' AND (NEW.original_space_id,NEW.original_published_at) IS DISTINCT FROM (OLD.original_space_id,OLD.original_published_at))
 THEN RAISE EXCEPTION 'Category head requires exact immutable source scope and ordering' USING ERRCODE='23514',CONSTRAINT='post_category_causal';END IF;
 SELECT * INTO e FROM whaleu_community.post_category_events WHERE id=NEW.event_id;
 IF e.id IS NULL OR e.mutation_transaction<>pg_current_xact_id() OR NEW.mutation_transaction<>pg_current_xact_id()
 OR (e.post_id,e.revision,e.current_category) IS DISTINCT FROM (NEW.post_id,NEW.revision,NEW.current_category)
 OR (TG_OP='INSERT' AND (NEW.revision<>1 OR e.previous_event_id IS NOT NULL))
 OR (TG_OP='UPDATE' AND (NEW.post_id<>OLD.post_id OR NEW.revision<>OLD.revision+1 OR e.previous_event_id<>OLD.event_id OR e.previous_category<>OLD.current_category))
 THEN RAISE EXCEPTION 'Exact monotonic category head required' USING ERRCODE='23514',CONSTRAINT='post_category_causal';END IF;
 RETURN NEW;END$$;
CREATE TRIGGER category_head_guard BEFORE INSERT OR UPDATE ON whaleu_community.post_category_heads FOR EACH ROW EXECUTE FUNCTION whaleu_community.post_category_head_guard();
CREATE FUNCTION whaleu_community.post_category_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h whaleu_community.post_category_heads;e whaleu_community.post_category_events;p whaleu_community.posts;selected_token text;BEGIN
 -- Raw writers receive the same retained identity fences as ordinary callers.
 -- The command records a session, not its bearer token: preserve the existing
 -- one-live-token-in-session SQL contract; API separately proves its exact token.
 PERFORM id FROM whaleu_identity.accounts WHERE id=NEW.actor_id FOR SHARE NOWAIT;
 PERFORM id FROM whaleu_identity.sessions WHERE id=NEW.session_id AND account_id=NEW.actor_id FOR SHARE NOWAIT;
 SELECT token.token_hash INTO selected_token FROM whaleu_identity.access_tokens token
 WHERE token.session_id=NEW.session_id AND token.expires_at>clock_timestamp()
 ORDER BY token.expires_at DESC,token.token_hash LIMIT 1 FOR SHARE NOWAIT;
 IF NOT EXISTS(SELECT 1 FROM whaleu_identity.sessions s JOIN whaleu_identity.accounts a ON a.id=s.account_id WHERE s.id=NEW.session_id AND s.account_id=NEW.actor_id AND a.status='active' AND s.revoked_at IS NULL AND s.absolute_expires_at>clock_timestamp()
 AND EXISTS(SELECT 1 FROM whaleu_identity.access_tokens token WHERE token.token_hash=selected_token AND token.session_id=s.id AND token.expires_at>clock_timestamp()))
 THEN RAISE EXCEPTION 'Current authenticated category actor required' USING ERRCODE='23514',CONSTRAINT='post_category_causal';END IF;
 SELECT * INTO e FROM whaleu_community.post_category_events WHERE actor_id=NEW.actor_id AND request_id=NEW.request_id;
 IF NEW.receipt->>'outcome'='rejected' AND NEW.receipt->>'code'='POST_CATEGORY_CANCELLED' THEN
  IF e.id IS NOT NULL THEN RAISE EXCEPTION 'Cancelled command cannot create event' USING ERRCODE='23514',CONSTRAINT='post_category_causal';END IF;
  RETURN NULL;
 END IF;
 -- Every fresh positive intent, including a stale terminal result, requires
 -- current authority in the fixed original scope. Only cancellation is exempt.
 -- NOWAIT fails closed behind a concurrent grant writer without reversing the
 -- ordinary request/Safety/parent lock order into an unbounded wait.
 PERFORM id FROM whaleu_authorization.role_grants WHERE id=NEW.grant_id FOR SHARE NOWAIT;
 IF whaleu_community.post_category_grant_allowed(NEW.actor_id,NEW.grant_id,NEW.post_id) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'Current category authority required' USING ERRCODE='23514',CONSTRAINT='post_category_causal';END IF;
 SELECT * INTO h FROM whaleu_community.post_category_heads WHERE post_id=NEW.post_id;
 SELECT * INTO p FROM whaleu_community.posts WHERE id=NEW.post_id;
 IF NEW.receipt->>'outcome'='rejected' THEN
  IF e.id IS NOT NULL THEN RAISE EXCEPTION 'Rejected command cannot create event' USING ERRCODE='23514',CONSTRAINT='post_category_causal';END IF;
  IF NEW.receipt->>'code'='POST_CATEGORY_UNAVAILABLE' AND p.deleted_at IS NOT NULL THEN RETURN NULL;END IF;
  IF NEW.receipt->>'code'='POST_CATEGORY_STALE' AND coalesce(h.revision,0)<>(NEW.command->>'expectedRevision')::integer THEN RETURN NULL;END IF;
  RAISE EXCEPTION 'Category rejection must be causal' USING ERRCODE='23514',CONSTRAINT='post_category_causal';
 END IF;
 PERFORM whaleu_community.require_post_owner_restore_safety(NEW.actor_id);
 IF whaleu_community.post_category_grant_allowed(NEW.actor_id,NEW.grant_id,NEW.post_id) IS DISTINCT FROM true OR whaleu_community.post_category_supported(NEW.post_id) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'Current category authority required' USING ERRCODE='23514',CONSTRAINT='post_category_causal';END IF;
 IF NEW.receipt->>'outcome'='unchanged' THEN
  IF e.id IS NOT NULL OR NEW.receipt->'revision' IS DISTINCT FROM to_jsonb(coalesce(h.revision,0))
  OR NEW.receipt->'expectedRevision' IS DISTINCT FROM NEW.receipt->'revision'
  OR NEW.receipt->'eventId' IS DISTINCT FROM coalesce(to_jsonb(h.event_id::text),'null'::jsonb)
  OR NEW.command->>'targetCategory' IS DISTINCT FROM coalesce(h.current_category,p.category)
  OR (h.event_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM whaleu_community.post_category_live WHERE post_id=NEW.post_id))
  THEN RAISE EXCEPTION 'Exact no-op required' USING ERRCODE='23514',CONSTRAINT='post_category_causal';END IF;
 ELSE
  IF e.id IS NULL OR e.mutation_transaction<>pg_current_xact_id() OR h.event_id IS DISTINCT FROM e.id
  OR h.mutation_transaction<>pg_current_xact_id() OR NOT EXISTS(SELECT 1 FROM whaleu_community.post_category_live WHERE post_id=NEW.post_id)
  THEN RAISE EXCEPTION 'Applied command requires surviving exact head' USING ERRCODE='23514',CONSTRAINT='post_category_causal';END IF;
 END IF;
 RETURN NULL;END$$;
CREATE CONSTRAINT TRIGGER category_complete AFTER INSERT ON whaleu_community.post_category_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.post_category_complete();
-- Selected administrative authority is command-time evidence. Future grant
-- expiry/revocation cannot undo a committed classification; immutable source and
-- current original/category Review independently control continued visibility.
CREATE TABLE whaleu_community.post_category_read_epoch(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),version bigint NOT NULL DEFAULT 0 CHECK(version>=0));
INSERT INTO whaleu_community.post_category_read_epoch(singleton,version) VALUES(true,0);
CREATE FUNCTION whaleu_community.advance_post_category_read_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN UPDATE whaleu_community.post_category_read_epoch SET version=version+1 WHERE singleton=true;IF NOT FOUND THEN RAISE EXCEPTION 'Missing category read epoch' USING ERRCODE='23514',CONSTRAINT='post_category_causal';END IF;RETURN NULL;END$$;
DO $$DECLARE table_name text;BEGIN
 FOREACH table_name IN ARRAY ARRAY['post_category_issuers','post_category_issuer_withdrawals','post_category_policies','post_category_policy_heads','post_category_policy_withdrawals','post_category_review_withdrawals','post_category_heads','post_category_events'] LOOP
 EXECUTE format('CREATE TRIGGER b_category_read_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.advance_post_category_read_epoch()',table_name);
 END LOOP;
END$$;
-- First issuance and new supplemental bindings do not change existing category
-- result sets. Only an inserted Review superseding already-consumed exact intent
-- invalidates category cursors; every write still bumps Community count epochs.
CREATE FUNCTION whaleu_community.post_category_review_read_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM new_category_reviews n
 JOIN whaleu_community.post_category_reviews previous ON previous.purpose=n.purpose AND previous.digest=n.digest AND previous.id<>n.id
 WHERE EXISTS(SELECT 1 FROM whaleu_community.post_category_events e WHERE e.review_id=previous.id)
 OR EXISTS(SELECT 1 FROM whaleu_community.post_category_child_bindings c WHERE c.review_id=previous.id)) THEN
  UPDATE whaleu_community.post_category_read_epoch SET version=version+1 WHERE singleton=true;
  IF NOT FOUND THEN RAISE EXCEPTION 'Missing category read epoch' USING ERRCODE='23514',CONSTRAINT='post_category_causal';END IF;
 END IF;
 RETURN NULL;END$$;
CREATE TRIGGER b_category_review_read_epoch AFTER INSERT ON whaleu_community.post_category_reviews
 REFERENCING NEW TABLE AS new_category_reviews FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.post_category_review_read_epoch();
-- Supplemental approval signs the exact old definition and request plus current
-- parent context. The immutable binding then attaches that approval to the child
-- generated by this publication transaction; original canonical Review is intact.
CREATE FUNCTION whaleu_community.post_category_child_envelope(actor uuid,request uuid,kind text,old_decision uuid,parent_event uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('version',1,'purpose','community_child_current_parent_classification',
 'actorId',actor,'requestId',request,'childKind',kind,'original',jsonb_build_object('decisionId',d.id,'digest',d.digest,'envelope',d.envelope),
 'parent',jsonb_build_object('postId',e.post_id,'eventId',e.id,'revision',e.revision,'category',e.current_category,'policyId',e.policy_id,'reviewId',e.review_id))
 FROM whaleu_community.content_approval_decisions d JOIN whaleu_community.post_category_events e ON e.id=parent_event
 WHERE d.id=old_decision AND d.account_id=actor AND d.envelope->>'postId'=e.post_id::text
 AND d.operation=CASE kind WHEN 'comment' THEN 'publish_comment' WHEN 'reply' THEN 'publish_reply' ELSE '' END
$$;
-- Acceptance and Review source identity cannot be substituted by a raw writer.
CREATE FUNCTION whaleu_community.post_category_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE issuer whaleu_community.post_category_issuers;policy whaleu_community.post_category_policies;expected jsonb;previous jsonb;BEGIN
 -- Accepted source evidence is already effective at ingestion. This bounded
 -- slice has no scheduled issuer/policy activation that could bypass epochs.
 IF TG_TABLE_NAME='post_category_issuers' THEN
  IF NEW.accepted_at>clock_timestamp() THEN RAISE EXCEPTION 'Issuer acceptance cannot be scheduled' USING ERRCODE='23514',CONSTRAINT='post_category_causal';END IF;
 ELSIF TG_TABLE_NAME='post_category_policies' THEN
  IF NEW.accepted_at>clock_timestamp() THEN RAISE EXCEPTION 'Policy acceptance cannot be scheduled' USING ERRCODE='23514',CONSTRAINT='post_category_causal';END IF;
  SELECT * INTO issuer FROM whaleu_community.post_category_issuers WHERE id=NEW.issuer_id;
  IF issuer.id IS NULL OR NEW.accepted_at<issuer.accepted_at THEN RAISE EXCEPTION 'Policy acceptance must follow exact issuer acceptance' USING ERRCODE='23514',CONSTRAINT='post_category_causal';END IF;
 ELSE
  SELECT * INTO policy FROM whaleu_community.post_category_policies WHERE id=NEW.policy_id;
  IF policy.id IS NULL OR policy.issuer_id<>NEW.issuer_id OR NEW.accepted_at<policy.accepted_at
  THEN RAISE EXCEPTION 'Review requires exact accepted policy issuer' USING ERRCODE='23514',CONSTRAINT='post_category_causal';END IF;
  IF NEW.purpose='community_post_category_reclassification' THEN
   expected:=whaleu_community.post_category_command_envelope((NEW.envelope->>'actorId')::uuid,NEW.envelope->'command',(NEW.envelope->>'grantId')::uuid,NEW.policy_id);
   IF NEW.envelope->'previous'->'eventId'='null'::jsonb THEN
    SELECT jsonb_build_object('revision',0,'eventId',NULL,'category',category) INTO previous FROM whaleu_community.posts WHERE id=(NEW.envelope->>'postId')::uuid;
   ELSE
    SELECT jsonb_build_object('revision',revision,'eventId',id,'category',current_category) INTO previous FROM whaleu_community.post_category_events
    WHERE id=(NEW.envelope->'previous'->>'eventId')::uuid AND post_id=(NEW.envelope->>'postId')::uuid;
   END IF;
   expected:=jsonb_set(expected,'{previous}',previous);
   IF previous IS NULL OR NEW.envelope->'command'->'expectedRevision' IS DISTINCT FROM previous->'revision'
    OR NEW.envelope->>'targetCategory'=previous->>'category'
    OR whaleu_community.post_owner_visibility_keys(NEW.envelope->'command',ARRAY['clientRequestId','postId','expectedRevision','targetCategory']) IS DISTINCT FROM true
   THEN expected:=NULL;END IF;
  ELSE
   expected:=whaleu_community.post_category_child_envelope((NEW.envelope->>'actorId')::uuid,(NEW.envelope->>'requestId')::uuid,NEW.envelope->>'childKind',(NEW.envelope->'original'->>'decisionId')::uuid,(NEW.envelope->'parent'->>'eventId')::uuid);
   IF NEW.envelope->'parent'->>'policyId' IS DISTINCT FROM NEW.policy_id::text THEN expected:=NULL;END IF;
  END IF;
  IF expected IS NULL OR NEW.envelope IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Exact purpose-specific Review envelope required' USING ERRCODE='23514',CONSTRAINT='post_category_causal';END IF;
 END IF;
 RETURN NEW;END$$;
CREATE TRIGGER category_issuer_source_guard BEFORE INSERT ON whaleu_community.post_category_issuers FOR EACH ROW EXECUTE FUNCTION whaleu_community.post_category_source_guard();
CREATE TRIGGER category_policy_source_guard BEFORE INSERT ON whaleu_community.post_category_policies FOR EACH ROW EXECUTE FUNCTION whaleu_community.post_category_source_guard();
CREATE TRIGGER category_review_source_guard BEFORE INSERT ON whaleu_community.post_category_reviews FOR EACH ROW EXECUTE FUNCTION whaleu_community.post_category_source_guard();
-- Source changes join the existing Safety writer gate before Community epoch
-- writes. Readers still fence actual selected owners and exact DB deadlines.
DO $$DECLARE table_name text;BEGIN
 FOREACH table_name IN ARRAY ARRAY['post_category_issuers','post_category_issuer_withdrawals','post_category_policies','post_category_policy_heads','post_category_policy_withdrawals','post_category_reviews','post_category_review_withdrawals'] LOOP
 EXECUTE format('CREATE TRIGGER a0_category_source_writer BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_policy_writer_gate()',table_name);
 END LOOP;
END$$;
CREATE FUNCTION whaleu_community.post_category_child_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b whaleu_community.content_approval_bindings;r whaleu_community.post_category_review_live;h whaleu_community.post_category_heads;
BEGIN
 PERFORM 1 FROM whaleu_community.posts WHERE id=NEW.post_id FOR SHARE;
 SELECT * INTO b FROM whaleu_community.content_approval_bindings WHERE content_kind=NEW.content_kind AND content_id=NEW.content_id;
 SELECT * INTO r FROM whaleu_community.post_category_review_live WHERE id=NEW.review_id;
 SELECT * INTO h FROM whaleu_community.post_category_heads WHERE post_id=NEW.post_id;
 IF NEW.mutation_transaction<>pg_current_xact_id() OR b.decision_id IS DISTINCT FROM NEW.original_decision_id OR b.digest IS DISTINCT FROM NEW.original_digest
 OR b.account_id IS DISTINCT FROM NEW.actor_id OR b.envelope->>'postId' IS DISTINCT FROM NEW.post_id::text
 OR h.event_id IS DISTINCT FROM NEW.event_id OR r.id IS NULL
 OR NOT EXISTS(SELECT 1 FROM whaleu_community.post_category_live l WHERE l.post_id=NEW.post_id AND l.event_id=NEW.event_id AND l.policy_id=r.policy_id)
 OR r.envelope IS DISTINCT FROM whaleu_community.post_category_child_envelope(NEW.actor_id,NEW.request_id,NEW.content_kind,NEW.original_decision_id,NEW.event_id)
 OR r.purpose IS DISTINCT FROM 'community_child_current_parent_classification'
 OR NOT EXISTS(SELECT 1 FROM whaleu_community.publication_requests q WHERE q.account_id=NEW.actor_id AND q.client_request_id=NEW.request_id AND q.operation=b.operation
 AND (q.receipt IS NULL OR (q.receipt->>'outcome'='created' AND q.receipt->>'resourceId'=NEW.content_id::text)))
 OR NOT EXISTS(SELECT 1 FROM whaleu_community.content_approval_decisions d WHERE d.id=b.decision_id AND d.consume_until>clock_timestamp())
 OR whaleu_community.post_category_original_review_current(b.decision_id) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'Exact child current-parent Review binding required' USING ERRCODE='23514',CONSTRAINT='post_category_causal';END IF;
 RETURN NEW;END$$;
CREATE TRIGGER category_child_binding_guard BEFORE INSERT ON whaleu_community.post_category_child_bindings FOR EACH ROW EXECUTE FUNCTION whaleu_community.post_category_child_binding_guard();
-- The raw child table, original approval binding and supplemental binding all
-- schedule the same final proof, so omission or reordering cannot evade it.
CREATE FUNCTION whaleu_community.post_category_assert_child(child_kind text,child uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE payload jsonb;creation xid8;b whaleu_community.content_approval_bindings;c whaleu_community.post_category_child_bindings;
 h whaleu_community.post_category_heads;r whaleu_community.post_category_review_live;policy whaleu_community.post_category_policy_live;q whaleu_community.publication_requests;
BEGIN
 EXECUTE format('SELECT to_jsonb(child_row),approval_publication_transaction FROM whaleu_community.%I child_row WHERE id=$1',CASE child_kind WHEN 'comment' THEN 'root_comments' ELSE 'replies' END) INTO payload,creation USING child;
 IF payload IS NULL THEN RAISE EXCEPTION 'Category child publication must survive' USING ERRCODE='23514',CONSTRAINT='post_category_causal';END IF;
 SELECT * INTO h FROM whaleu_community.post_category_heads WHERE post_id=(payload->>'post_id')::uuid;
 IF h.event_id IS NULL THEN RETURN;END IF;
 SELECT * INTO b FROM whaleu_community.content_approval_bindings WHERE content_kind=child_kind AND content_id=child;
 SELECT * INTO c FROM whaleu_community.post_category_child_bindings WHERE content_kind=child_kind AND content_id=child;
 SELECT * INTO r FROM whaleu_community.post_category_review_live WHERE id=c.review_id;
 SELECT * INTO policy FROM whaleu_community.post_category_policy_live WHERE id=r.policy_id;
 SELECT * INTO q FROM whaleu_community.publication_requests WHERE account_id=c.actor_id AND client_request_id=c.request_id;
 IF creation IS DISTINCT FROM pg_current_xact_id() OR c.mutation_transaction IS DISTINCT FROM pg_current_xact_id()
 OR b.decision_id IS NULL OR c.review_id IS NULL OR r.id IS NULL OR policy.id IS NULL OR q.client_request_id IS NULL
 OR (c.event_id,c.post_id,c.original_decision_id,c.original_digest,c.actor_id) IS DISTINCT FROM (h.event_id,h.post_id,b.decision_id,b.digest,b.account_id)
 OR b.account_id::text IS DISTINCT FROM payload->>'account_id' OR b.envelope->>'postId' IS DISTINCT FROM payload->>'post_id'
 OR r.purpose IS DISTINCT FROM 'community_child_current_parent_classification'
 OR r.envelope IS DISTINCT FROM whaleu_community.post_category_child_envelope(c.actor_id,c.request_id,child_kind,b.decision_id,h.event_id)
 OR whaleu_community.post_category_original_review_current(b.decision_id) IS DISTINCT FROM true
 OR NOT EXISTS(SELECT 1 FROM whaleu_community.content_approval_decisions d WHERE d.id=b.decision_id AND d.consume_until>clock_timestamp())
 OR NOT EXISTS(SELECT 1 FROM whaleu_community.post_category_live l WHERE l.post_id=h.post_id AND l.event_id=h.event_id AND l.policy_id=r.policy_id)
 OR q.operation IS DISTINCT FROM b.operation OR q.receipt->>'outcome' IS DISTINCT FROM 'created'
 OR q.receipt->>'operation' IS DISTINCT FROM b.operation OR q.receipt->>'requestId' IS DISTINCT FROM c.request_id::text
 OR q.receipt->>'resourceId' IS DISTINCT FROM child::text
 OR NOT EXISTS(SELECT 1 FROM whaleu_community.report_origins origin WHERE origin.kind=child_kind AND origin.target_id=child AND origin.owner_account_id=c.actor_id AND origin.source_request_id=c.request_id AND origin.provenance='native_publication')
 OR (policy.definition->>'descendantMedia'='text_only' AND b.envelope->'images' IS DISTINCT FROM '[]'::jsonb)
 THEN RAISE EXCEPTION 'New child requires exact same-transaction publication and supplemental parent context' USING ERRCODE='23514',CONSTRAINT='post_category_causal';END IF;
END$$;
CREATE FUNCTION whaleu_community.post_category_child_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME IN ('root_comments','replies') THEN
  PERFORM whaleu_community.post_category_assert_child(CASE TG_TABLE_NAME WHEN 'root_comments' THEN 'comment' ELSE 'reply' END,NEW.id);
 ELSIF NEW.content_kind<>'post' THEN PERFORM whaleu_community.post_category_assert_child(NEW.content_kind,NEW.content_id);END IF;
 RETURN NULL;END$$;
CREATE FUNCTION whaleu_community.post_category_child_parent_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Child classification requires current committed facts' USING ERRCODE='23514',CONSTRAINT='post_category_causal';END IF;
 PERFORM 1 FROM whaleu_community.posts WHERE id=NEW.post_id FOR SHARE;RETURN NEW;END$$;
-- Also anchor the first approval itself. The original 0016 binding validator
-- requires the same immutable publication transaction, so a historical raw row
-- cannot acquire its first approval after the first category head was installed.
CREATE FUNCTION whaleu_community.post_category_original_child_parent_lock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent uuid;BEGIN
 IF NEW.content_kind='post' THEN RETURN NEW;END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Child approval requires current committed facts' USING ERRCODE='23514',CONSTRAINT='post_category_causal';END IF;
 IF NEW.content_kind='comment' THEN SELECT post_id INTO parent FROM whaleu_community.root_comments WHERE id=NEW.content_id;
 ELSE SELECT post_id INTO parent FROM whaleu_community.replies WHERE id=NEW.content_id;END IF;
 PERFORM 1 FROM whaleu_community.posts WHERE id=parent FOR SHARE;
 RETURN NEW;END$$;
CREATE TRIGGER category_child_original_parent_lock BEFORE INSERT ON whaleu_community.content_approval_bindings
 FOR EACH ROW EXECUTE FUNCTION whaleu_community.post_category_original_child_parent_lock();
CREATE TRIGGER category_child_parent_lock BEFORE INSERT ON whaleu_community.root_comments FOR EACH ROW EXECUTE FUNCTION whaleu_community.post_category_child_parent_lock();
CREATE TRIGGER category_child_parent_lock BEFORE INSERT ON whaleu_community.replies FOR EACH ROW EXECUTE FUNCTION whaleu_community.post_category_child_parent_lock();
CREATE CONSTRAINT TRIGGER category_child_complete AFTER INSERT ON whaleu_community.content_approval_bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.post_category_child_complete();
CREATE CONSTRAINT TRIGGER category_child_complete AFTER INSERT ON whaleu_community.post_category_child_bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.post_category_child_complete();
CREATE CONSTRAINT TRIGGER category_child_complete AFTER INSERT ON whaleu_community.root_comments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.post_category_child_complete();
CREATE CONSTRAINT TRIGGER category_child_complete AFTER INSERT ON whaleu_community.replies DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.post_category_child_complete();
-- Validate every event/head insert independently of whether its command trigger
-- already ran under SET CONSTRAINTS. Only an exact one-step CAS can survive.
CREATE FUNCTION whaleu_community.post_category_assert_event(event uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE e whaleu_community.post_category_events;prior whaleu_community.post_category_events;h whaleu_community.post_category_heads;
 q whaleu_community.post_category_commands;b whaleu_community.content_approval_bindings;r whaleu_community.post_category_review_live;p whaleu_community.post_category_policy_live;expected jsonb;
BEGIN
 SELECT * INTO e FROM whaleu_community.post_category_events WHERE id=event;
 SELECT * INTO prior FROM whaleu_community.post_category_events WHERE id=e.previous_event_id;
 SELECT * INTO h FROM whaleu_community.post_category_heads WHERE post_id=e.post_id;
 SELECT * INTO q FROM whaleu_community.post_category_commands WHERE (actor_id,request_id)=(e.actor_id,e.request_id);
 SELECT * INTO b FROM whaleu_community.content_approval_bindings WHERE content_kind='post' AND content_id=e.post_id;
 SELECT * INTO r FROM whaleu_community.post_category_review_live WHERE id=e.review_id;
 SELECT * INTO p FROM whaleu_community.post_category_policy_live WHERE id=e.policy_id;
 expected:=whaleu_community.post_category_command_envelope(e.actor_id,q.command,e.grant_id,e.policy_id);
 expected:=jsonb_set(expected,'{previous}',jsonb_build_object('revision',e.revision-1,'eventId',e.previous_event_id,'category',e.previous_category));
 IF e.id IS NULL OR e.mutation_transaction IS DISTINCT FROM pg_current_xact_id() OR q.mutation_transaction IS DISTINCT FROM pg_current_xact_id()
 OR h.mutation_transaction IS DISTINCT FROM pg_current_xact_id() OR h.event_id IS DISTINCT FROM e.id
 OR (h.post_id,h.revision,h.current_category) IS DISTINCT FROM (e.post_id,e.revision,e.current_category)
 OR q.post_id IS DISTINCT FROM e.post_id OR q.grant_id IS DISTINCT FROM e.grant_id
 OR q.receipt->>'outcome' IS DISTINCT FROM 'applied' OR q.receipt->>'eventId' IS DISTINCT FROM e.id::text
 OR q.command->'expectedRevision' IS DISTINCT FROM to_jsonb(e.revision-1) OR q.receipt->'revision' IS DISTINCT FROM to_jsonb(e.revision)
 OR q.command->>'targetCategory' IS DISTINCT FROM e.current_category OR (q.receipt->>'recordedAt')::timestamptz IS DISTINCT FROM e.recorded_at
 OR (e.revision=1 AND (e.previous_event_id IS NOT NULL OR e.previous_category<>e.original_category))
 OR (e.revision>1 AND (prior.id IS NULL OR (prior.post_id,prior.revision,prior.current_category) IS DISTINCT FROM (e.post_id,e.revision-1,e.previous_category)))
 OR (e.revision>1 AND NOT EXISTS(SELECT 1 FROM whaleu_community.post_category_review_live previous_review WHERE previous_review.id=prior.review_id AND previous_review.policy_id=prior.policy_id AND previous_review.purpose='community_post_category_reclassification'))
 OR (e.original_decision_id,e.original_digest) IS DISTINCT FROM (b.decision_id,b.digest)
 OR r.id IS NULL OR p.id IS NULL OR r.policy_id IS DISTINCT FROM p.id OR r.purpose IS DISTINCT FROM 'community_post_category_reclassification'
 OR r.envelope IS DISTINCT FROM expected OR e.continuation_cutoff<r.accepted_at OR e.recorded_at>clock_timestamp()
 OR e.selected_authority IS DISTINCT FROM whaleu_community.post_category_authority_snapshot(e.grant_id)
 OR whaleu_community.post_category_grant_allowed(e.actor_id,e.grant_id,e.post_id) IS DISTINCT FROM true
 OR whaleu_community.post_category_supported(e.post_id) IS DISTINCT FROM true
 OR NOT EXISTS(SELECT 1 FROM whaleu_community.post_category_live l WHERE l.post_id=e.post_id AND l.event_id=e.id)
 OR (p.definition->'continueDescendants'<>'true'::jsonb AND (EXISTS(SELECT 1 FROM whaleu_community.root_comments c WHERE c.post_id=e.post_id) OR EXISTS(SELECT 1 FROM whaleu_community.replies c WHERE c.post_id=e.post_id)))
 OR (p.definition->>'descendantMedia'='text_only' AND
  (EXISTS(SELECT 1 FROM whaleu_community.root_comments c JOIN whaleu_community.comment_images i ON i.comment_id=c.id WHERE c.post_id=e.post_id)
   OR EXISTS(SELECT 1 FROM whaleu_community.replies c JOIN whaleu_community.reply_images i ON i.reply_id=c.id WHERE c.post_id=e.post_id)))
 THEN RAISE EXCEPTION 'Exact surviving event, head, original approval, authority and command required' USING ERRCODE='23514',CONSTRAINT='post_category_causal';END IF;
 PERFORM whaleu_community.require_post_owner_restore_safety(e.actor_id);
END$$;
CREATE FUNCTION whaleu_community.post_category_event_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='post_category_events' THEN PERFORM whaleu_community.post_category_assert_event(NEW.id);
 ELSE PERFORM whaleu_community.post_category_assert_event(NEW.event_id);END IF;
 RETURN NULL;END$$;
CREATE CONSTRAINT TRIGGER category_event_complete AFTER INSERT ON whaleu_community.post_category_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.post_category_event_complete();
CREATE CONSTRAINT TRIGGER category_head_complete AFTER INSERT OR UPDATE ON whaleu_community.post_category_heads DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.post_category_event_complete();
-- Cursor epoch is writable only through the registered nested source trigger.
CREATE FUNCTION whaleu_community.post_category_read_epoch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'UPDATE' OR pg_trigger_depth()<2 OR NEW.singleton IS DISTINCT FROM OLD.singleton OR NEW.version<>OLD.version+1
 THEN RAISE EXCEPTION 'Category cursor epoch is source-owned' USING ERRCODE='23514',CONSTRAINT='post_category_causal';END IF;
 RETURN NEW;END$$;
CREATE TRIGGER category_read_epoch_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.post_category_read_epoch FOR EACH ROW EXECUTE FUNCTION whaleu_community.post_category_read_epoch_guard();
CREATE TRIGGER category_read_epoch_retain BEFORE TRUNCATE ON whaleu_community.post_category_read_epoch FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.post_category_immutable();
