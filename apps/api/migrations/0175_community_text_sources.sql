-- Explicit immutable authored source. No formatter, policy activation, historical
-- adoption, media provider admission, publication edit, or deletion owner grant.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));

CREATE FUNCTION whaleu_community.text_source_hash(format text,source text) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT CASE WHEN format IN ('plain','markdown') THEN encode(sha256(convert_to('whaleu-community-text-source:v1'||chr(10)||format||chr(10)||source,'UTF8')),'hex') ELSE NULL END
$$;
CREATE FUNCTION whaleu_community.text_source_envelope_valid(e jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE s jsonb:=e->'textSource';field text;BEGIN
 IF whaleu_community.related_sync_exact_keys(e,ARRAY['version','accountId','purpose','spaceId','category','authorMode','commentsPolicy','postId','rootCommentId','targetReplyId','text','images','component','trading','scope','allowAnonymousDm','textSource']) IS DISTINCT FROM true
 OR e->'version' IS DISTINCT FROM '6'::jsonb OR e->>'purpose' IS NULL OR e->>'purpose' NOT IN ('publish_post','publish_comment','publish_reply')
 OR e->>'category' IS NULL OR e->>'category' NOT IN ('discussion','confession','companions','pets','internships','scenery','dorms','research','deep_sea')
 OR e->>'authorMode' IS NULL OR e->>'authorMode' NOT IN ('named','anonymous') OR e->>'commentsPolicy' IS DISTINCT FROM 'open'
 OR e->'component' IS DISTINCT FROM '{"kind":"none"}'::jsonb OR e->'trading' IS DISTINCT FROM 'null'::jsonb
 -- This initial local lane is explicitly text-only. It cannot manufacture Media proof.
 OR e->'images' IS DISTINCT FROM '[]'::jsonb OR e->'allowAnonymousDm' IS NULL OR e->'allowAnonymousDm' NOT IN ('null'::jsonb,'false'::jsonb)
 OR ((e->>'purpose'<>'publish_post' OR e->>'authorMode'='anonymous') AND e->'allowAnonymousDm'<>'null'::jsonb)
 OR jsonb_typeof(e->'text') IS DISTINCT FROM 'string' OR whaleu_profile.moderation_text_valid(e->>'text',CASE WHEN e->>'purpose'='publish_post' THEN 2500 ELSE 500 END) IS DISTINCT FROM true
 OR whaleu_profile.moderation_trim(e->>'text')='' OR whaleu_community.profile_moderation_scope_valid(e->'scope') IS DISTINCT FROM true
 OR e->'spaceId' IS DISTINCT FROM e->'scope'->'originalSpaceId' THEN RETURN false;END IF;
 FOREACH field IN ARRAY ARRAY['accountId','spaceId'] LOOP IF whaleu_community.related_sync_uuid(e->field) IS DISTINCT FROM true THEN RETURN false;END IF;END LOOP;
 FOREACH field IN ARRAY ARRAY['postId','rootCommentId','targetReplyId'] LOOP IF whaleu_community.rating_scoped_nullable_id(e->field) IS DISTINCT FROM true THEN RETURN false;END IF;END LOOP;
 IF (e->>'purpose'='publish_post' AND (e->'postId'<>'null'::jsonb OR e->'rootCommentId'<>'null'::jsonb OR e->'targetReplyId'<>'null'::jsonb))
 OR (e->>'purpose'='publish_comment' AND (e->'postId'='null'::jsonb OR e->'rootCommentId'<>'null'::jsonb OR e->'targetReplyId'<>'null'::jsonb))
 OR (e->>'purpose'='publish_reply' AND (e->'postId'='null'::jsonb OR e->'rootCommentId'='null'::jsonb)) THEN RETURN false;END IF;
 IF s->'version' IS DISTINCT FROM '1'::jsonb OR s->>'format' IS NULL OR s->>'format' NOT IN ('plain','markdown')
 -- Temporary Markdown admission fence, on original source without tokenization:
 -- reject every ASCII #digit sequence (even code, links, escapes, or non-reference
 -- lengths) until the AST and all native reference consumers agree. Plain is unchanged.
 OR (s->>'format'='markdown' AND (position('whaleu-asset:' IN e->>'text')>0 OR ((e->>'text') COLLATE "C") ~ '#[0-9]'))
 OR jsonb_typeof(s->'sourceHash') IS DISTINCT FROM 'string' OR s->>'sourceHash' !~ '^[a-f0-9]{64}$'
 OR s->>'sourceHash' IS DISTINCT FROM whaleu_community.text_source_hash(s->>'format',e->>'text') THEN RETURN false;END IF;
 IF s->>'format'='plain' THEN
  RETURN whaleu_community.related_sync_exact_keys(s,ARRAY['version','format','readingFormatting','sourceHash']) IS TRUE AND jsonb_typeof(s->'readingFormatting')='string' AND s->>'readingFormatting' IN ('auto','off');
 END IF;
 RETURN whaleu_community.related_sync_exact_keys(s,ARRAY['version','format','sourceHash']) IS TRUE;
EXCEPTION WHEN OTHERS THEN RETURN false;END$$;

CREATE TABLE whaleu_community.community_text_sources (
 content_kind text NOT NULL CHECK(content_kind IN ('post','comment','reply')),content_id uuid NOT NULL,
 source_revision integer NOT NULL DEFAULT 1 CHECK(source_revision=1),source_version integer NOT NULL DEFAULT 1 CHECK(source_version=1),
 source_format text NOT NULL CHECK(source_format IN ('plain','markdown')),reading_formatting text,
 source_hash text NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 client_request_id uuid NOT NULL,requested_author_mode text NOT NULL CHECK(requested_author_mode IN ('named','anonymous')),
 original_intent_hash text NOT NULL CHECK(original_intent_hash ~ '^[a-f0-9]{64}$'),
 decision_id uuid NOT NULL UNIQUE REFERENCES whaleu_community.content_approval_decisions(id),approval_digest text NOT NULL CHECK(approval_digest ~ '^[a-f0-9]{64}$'),
 publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),created_at timestamptz NOT NULL DEFAULT transaction_timestamp() CHECK(isfinite(created_at)),
 PRIMARY KEY(content_kind,content_id),UNIQUE(account_id,client_request_id),
 FOREIGN KEY(account_id,client_request_id) REFERENCES whaleu_community.publication_requests(account_id,client_request_id),
 CHECK((source_format='plain' AND reading_formatting IS NOT NULL AND reading_formatting IN ('auto','off')) OR (source_format='markdown' AND reading_formatting IS NULL))
);
CREATE INDEX community_text_sources_transaction ON whaleu_community.community_text_sources(publication_transaction);
-- Server-owned cohort observations, not authorization evidence. Historical
-- V1-V5 rows stay NULL. No backfill and no new retention/erasure relation.
ALTER TABLE whaleu_community.content_approval_decisions ADD COLUMN text_source_issuance_transaction xid8;
ALTER TABLE whaleu_community.text_review_requests ADD COLUMN text_source_transition_transaction xid8;
ALTER TABLE whaleu_community.content_approval_decisions ADD CONSTRAINT text_source_decision_cohort CHECK
 ((envelope_version=6 AND text_source_issuance_transaction IS NOT NULL) OR (envelope_version<>6 AND text_source_issuance_transaction IS NULL));
ALTER TABLE whaleu_community.text_review_requests ADD CONSTRAINT text_source_queue_cohort CHECK
 ((envelope->>'version'='6' AND text_source_transition_transaction IS NOT NULL) OR (envelope->>'version'<>'6' AND text_source_transition_transaction IS NULL));
CREATE INDEX text_source_decision_transaction ON whaleu_community.content_approval_decisions(text_source_issuance_transaction) WHERE envelope_version=6;
CREATE INDEX text_source_queue_transaction ON whaleu_community.text_review_requests(text_source_transition_transaction) WHERE envelope->>'version'='6';

CREATE TRIGGER text_source_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_community.community_text_sources FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_approval_immutable();

-- Reconstruct from immutable source columns plus the actual owner body. The
-- accepted envelope may supply only its existing scope snapshot, never format,
-- reading policy, source hash, original author mode, body, or image evidence.
CREATE FUNCTION whaleu_community.text_source_definition(kind text,target uuid,scope jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE s whaleu_community.community_text_sources;p whaleu_community.posts;c jsonb;creation xid8;e jsonb;descriptor jsonb;relation text;has_images boolean;BEGIN
 IF kind IS NULL OR kind NOT IN ('post','comment','reply') THEN RETURN NULL;END IF;
 SELECT * INTO s FROM whaleu_community.community_text_sources WHERE content_kind=kind AND content_id=target;
 IF s.content_id IS NULL THEN RETURN NULL;END IF;
 relation:=CASE kind WHEN 'post' THEN 'posts' WHEN 'comment' THEN 'root_comments' ELSE 'replies' END;
 EXECUTE format('SELECT to_jsonb(n),%I FROM whaleu_community.%I n WHERE id=$1',CASE WHEN kind='post' THEN 'publication_transaction' ELSE 'approval_publication_transaction' END,relation) INTO c,creation USING target;
 SELECT * INTO p FROM whaleu_community.posts WHERE id=CASE WHEN kind='post' THEN target ELSE (c->>'post_id')::uuid END;
 IF c IS NULL OR p.id IS NULL OR p.publication_state<>'published' OR s.account_id::text IS DISTINCT FROM c->>'account_id' OR s.publication_transaction IS DISTINCT FROM creation
 OR (kind='post' AND p.publication_envelope_version<>6) OR (kind<>'post' AND p.publication_envelope_version NOT IN (1,2,6))
 OR p.feedback IS NOT NULL OR p.category IN ('feedback','trading') OR p.comments_policy<>'open'
 OR (kind='post' AND (p.allow_anonymous_dm IS TRUE OR (p.author_mode='anonymous' AND p.allow_anonymous_dm IS NOT NULL)))
 OR EXISTS(SELECT 1 FROM whaleu_community.post_distribution_bindings WHERE post_id=p.id)
 OR (kind='post' AND (EXISTS(SELECT 1 FROM whaleu_community.polls WHERE post_id=target) OR EXISTS(SELECT 1 FROM whaleu_community.formations WHERE post_id=target) OR EXISTS(SELECT 1 FROM whaleu_community.trading_listings WHERE post_id=target) OR EXISTS(SELECT 1 FROM whaleu_community.post_rating_target_links WHERE post_id=target)))
 OR s.source_hash IS DISTINCT FROM whaleu_community.text_source_hash(s.source_format,c->>'text') THEN RETURN NULL;END IF;
 EXECUTE format('SELECT EXISTS(SELECT 1 FROM whaleu_community.%I WHERE %I=$1)',kind||'_images',kind||'_id') INTO has_images USING target;
 IF has_images THEN RETURN NULL;END IF;
 descriptor:=jsonb_build_object('version',s.source_version,'format',s.source_format,'sourceHash',s.source_hash);
 IF s.source_format='plain' THEN descriptor:=descriptor||jsonb_build_object('readingFormatting',s.reading_formatting);END IF;
 e:=jsonb_build_object('version',6,'accountId',s.account_id,'purpose','publish_'||kind,'spaceId',p.space_id,'category',p.category,'authorMode',c->>'author_mode','commentsPolicy',p.comments_policy,
  'postId',CASE WHEN kind='post' THEN NULL ELSE p.id END,'rootCommentId',CASE WHEN kind='reply' THEN c->'root_comment_id' ELSE 'null'::jsonb END,'targetReplyId',CASE WHEN kind='reply' THEN c->'target_reply_id' ELSE 'null'::jsonb END,
  'text',c->>'text','images','[]'::jsonb,'component',jsonb_build_object('kind','none'),'trading',NULL,'scope',scope,'allowAnonymousDm',CASE WHEN kind='post' THEN p.allow_anonymous_dm ELSE NULL END,'textSource',descriptor);
 RETURN CASE WHEN whaleu_community.text_source_envelope_valid(e) IS TRUE THEN e ELSE NULL END;
EXCEPTION WHEN OTHERS THEN RETURN NULL;END$$;

ALTER FUNCTION whaleu_community.profile_moderation_definition(text,uuid,jsonb) RENAME TO profile_moderation_definition_pre_text_source;
CREATE FUNCTION whaleu_community.profile_moderation_definition(target_kind text,target uuid,scope jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM whaleu_community.community_text_sources WHERE content_kind=target_kind AND content_id=target)
 OR EXISTS(SELECT 1 FROM whaleu_community.content_approval_bindings WHERE content_kind=target_kind AND content_id=target AND envelope_version=6)
 OR (target_kind='post' AND EXISTS(SELECT 1 FROM whaleu_community.posts WHERE id=target AND publication_envelope_version=6)) THEN
  RETURN whaleu_community.text_source_definition(target_kind,target,scope);
 END IF;
 RETURN whaleu_community.profile_moderation_definition_pre_text_source(target_kind,target,scope);
END$$;

CREATE FUNCTION whaleu_community.text_source_intent_hash(e jsonb,requested_mode text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE intent text;source text;BEGIN
 IF whaleu_community.text_source_envelope_valid(e) IS DISTINCT FROM true OR requested_mode IS NULL OR requested_mode NOT IN ('named','anonymous') THEN RETURN NULL;END IF;
 source:='{"version":1,"format":'||(e->'textSource'->'format')::text;
 IF e->'textSource'->>'format'='plain' THEN source:=source||',"readingFormatting":'||(e->'textSource'->'readingFormatting')::text;END IF;
 source:=source||'}';
 IF e->>'purpose'='publish_post' THEN
  intent:='{"spaceId":'||(e->'spaceId')::text||',"category":'||(e->'category')::text||',"text":'||(e->'text')::text||',"imageAssetIds":[],"authorMode":'||to_jsonb(requested_mode)::text||',"commentsPolicy":"open"';
  IF e->'allowAnonymousDm'='false'::jsonb THEN intent:=intent||',"allowAnonymousDm":false';END IF;
 ELSIF e->>'purpose'='publish_comment' THEN intent:='{"postId":'||(e->'postId')::text||',"text":'||(e->'text')::text||',"imageAssetIds":[],"authorMode":'||to_jsonb(requested_mode)::text;
 ELSE intent:='{"rootCommentId":'||(e->'rootCommentId')::text||',"targetReplyId":'||(e->'targetReplyId')::text||',"text":'||(e->'text')::text||',"imageAssetIds":[],"authorMode":'||to_jsonb(requested_mode)::text;END IF;
 RETURN encode(sha256(convert_to('whaleu-community-text-source-intent:v1'||chr(10)||'{"operation":'||(e->'purpose')::text||',"intent":'||intent||',"textSource":'||source||'}}','UTF8')),'hex');
END$$;

-- Current Review proof is independent of publication completeness. Consumption
-- expiry is checked at publication; it is not an ongoing visibility deadline.
CREATE FUNCTION whaleu_community.text_source_review_current(decision uuid,consume boolean DEFAULT false) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT coalesce((SELECT d.envelope_version IN (1,2,6) AND d.result='allow' AND d.coverage='complete' AND d.provenance='accepted'
 AND p.policy_key=CASE WHEN d.envelope_version=6 THEN 'local-text-source-v1' ELSE 'local-explicit-v1' END AND p.version=1 AND p.coverage='complete' AND p.provenance='accepted'
 AND (d.envelope_version<>6 OR whaleu_community.text_source_envelope_valid(d.envelope))
 AND d.digest=encode(sha256(convert_to('whaleu-content-approval:v'||d.envelope_version::text||chr(10)||whaleu_community.content_canonical_json(d.envelope),'UTF8')),'hex')
 AND length(whaleu_profile.moderation_trim(p.issuer))>0 AND length(whaleu_profile.moderation_trim(p.provenance_ref))>0 AND length(whaleu_profile.moderation_trim(d.issuer))>0 AND length(whaleu_profile.moderation_trim(d.provenance_ref))>0
 AND length(whaleu_profile.moderation_trim(e.issuer))>0 AND length(whaleu_profile.moderation_trim(e.provenance_ref))>0
 AND e.state='allow' AND e.coverage='complete' AND e.provenance='accepted' AND isfinite(p.valid_from) AND isfinite(d.evaluated_at) AND isfinite(e.occurred_at) AND isfinite(d.consume_until)
 -- Consumption selects the newest exact decision BEFORE judging usability.
 -- A newer reject/pending/headless decision prevents fallback to an older allow.
 -- Durable bound visibility deliberately does not use this selector.
 AND (NOT consume OR d.id=(SELECT latest.id FROM whaleu_community.content_approval_decisions latest
  WHERE (latest.account_id,latest.operation,latest.envelope_version,latest.digest)=(d.account_id,d.operation,d.envelope_version,d.digest)
  ORDER BY latest.evaluated_at DESC,latest.id DESC LIMIT 1))
 AND (d.visibility_until IS NULL OR isfinite(d.visibility_until)) AND (p.valid_until IS NULL OR isfinite(p.valid_until)) AND p.valid_from<=d.evaluated_at AND d.evaluated_at<=clock_timestamp() AND e.occurred_at>=d.evaluated_at AND e.occurred_at<=clock_timestamp()
 AND (p.valid_until IS NULL OR p.valid_until>clock_timestamp()) AND (d.visibility_until IS NULL OR d.visibility_until>clock_timestamp()) AND (NOT consume OR d.consume_until>clock_timestamp())
 FROM whaleu_community.content_approval_decisions d JOIN whaleu_community.content_approval_policies p ON p.id=d.policy_revision_id JOIN whaleu_community.content_approval_heads h ON h.decision_id=d.id JOIN whaleu_community.content_approval_events e ON e.id=h.event_id AND e.decision_id=d.id WHERE d.id=decision),false)
$$;
CREATE FUNCTION whaleu_community.text_source_destination_current(actor uuid,scope jsonb,mode text,category text,operation text,root_mode text) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE a whaleu_verification.assertions; v whaleu_verification.snapshots; selection whaleu_campus.community_identity_selections;
 topo whaleu_campus.community_topology_snapshots; cfg whaleu_community.region_policy_revisions;
 verified boolean:=false; origin jsonb; identity_region jsonb; target_region jsonb; assignment jsonb; field text; space_kind text; instant timestamptz:=clock_timestamp();
BEGIN
 SELECT kind INTO space_kind FROM whaleu_community.spaces WHERE id=(scope->>'originalSpaceId')::uuid;
 IF mode IS NULL OR mode NOT IN ('named','anonymous') OR whaleu_community.related_sync_exact_keys(scope,ARRAY['originalSpaceId','originalRegionId','authorOriginRegionId','identityRegionId','topologySnapshotId','sync','configurationRevisionId','identityCampusId','identitySelectionId','affiliationSnapshotId','affiliationAssertionId']) IS DISTINCT FROM true
 OR scope->>'sync' IS DISTINCT FROM 'none' OR NOT whaleu_community.related_sync_uuid(scope->'originalSpaceId') OR NOT whaleu_community.rating_scoped_nullable_id(scope->'originalRegionId')
 OR NOT whaleu_profile.moderation_actor_current(actor,instant) OR NOT whaleu_safety.account_punishment_allows(actor,'interaction')
 OR NOT EXISTS(SELECT 1 FROM whaleu_community.spaces s WHERE s.id=(scope->>'originalSpaceId')::uuid AND s.is_active AND (s.kind='regional' OR (s.kind='global' AND category='discussion')) AND s.operating_region_id::text IS NOT DISTINCT FROM scope->>'originalRegionId') THEN RETURN false;END IF;
 FOREACH field IN ARRAY ARRAY['authorOriginRegionId','identityRegionId','topologySnapshotId','configurationRevisionId','identityCampusId','identitySelectionId','affiliationSnapshotId','affiliationAssertionId'] LOOP
  IF NOT whaleu_community.rating_scoped_nullable_id(scope->field) THEN RETURN false;END IF;
 END LOOP;
 SELECT s.* INTO v FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON (s.id,s.account_id,s.revision)=(h.snapshot_id,h.account_id,h.revision) WHERE h.account_id=actor;
 SELECT * INTO a FROM whaleu_verification.assertions WHERE id=v.affiliation_assertion_id AND account_id=actor AND fact_kind='affiliation';
 IF a.id IS NULL OR a.coverage_state<>'complete' OR a.provenance_state<>'accepted' OR a.source_account_id IS DISTINCT FROM actor
 OR coalesce(length(whaleu_profile.moderation_trim(a.source_reference)),0)=0 OR coalesce(length(whaleu_profile.moderation_trim(a.policy_reference)),0)=0
 OR a.issuer_institution_id IS DISTINCT FROM a.source_issuer_institution_id THEN RETURN false; END IF;
 IF a.method='native_enrollment' THEN
  IF a.assertion_state<>'unverified' OR a.source_reference IS DISTINCT FROM 'native_enrollment:'||actor::text OR a.policy_reference<>'native-account-absence/v1'
   OR a.issuer_institution_id IS NOT NULL OR a.origin_region_id IS NOT NULL OR a.phone_binding_reference IS NOT NULL OR a.student_number IS NOT NULL
   OR a.verified_at IS NOT NULL OR a.expiry_kind<>'policy_exempt' OR a.expires_at IS NOT NULL THEN RETURN false; END IF;
 ELSE
  IF a.method NOT IN('document_review','institutional_email','institutional_sso','reconciled_import','administrator_correction') THEN RETURN false; END IF;
  IF a.assertion_state='verified' THEN
   IF a.verified_at IS NULL OR NOT isfinite(a.verified_at) OR a.verified_at>instant
    OR NOT ((a.expiry_kind='policy_exempt' AND a.expires_at IS NULL) OR (a.expiry_kind='at' AND isfinite(a.expires_at) AND a.expires_at>a.verified_at)) THEN RETURN false; END IF;
   verified:=a.expires_at IS NULL OR a.expires_at>instant;
   IF verified AND (a.issuer_institution_id IS NULL OR a.origin_region_id IS NULL) THEN RETURN false; END IF;
  ELSIF a.assertion_state NOT IN('unverified','revoked','expired') THEN RETURN false; END IF;
 END IF;
 IF NOT verified THEN
  IF space_kind<>'regional' OR mode<>'named' OR (operation<>'publish_post' AND root_mode IS DISTINCT FROM 'named') THEN RETURN false; END IF;
  FOREACH field IN ARRAY ARRAY['authorOriginRegionId','identityRegionId','topologySnapshotId','identityCampusId','identitySelectionId','affiliationSnapshotId','affiliationAssertionId'] LOOP
   IF scope->field IS DISTINCT FROM 'null'::jsonb THEN RETURN false; END IF;
  END LOOP;
  SELECT p.* INTO cfg FROM whaleu_community.region_policy_heads h JOIN whaleu_community.region_policy_revisions p ON (p.id,p.region_id,p.revision)=(h.revision_id,h.region_id,h.revision) WHERE h.region_id=(scope->>'originalRegionId')::uuid;
  RETURN coalesce(cfg.id::text=scope->>'configurationRevisionId' AND (CASE WHEN operation='publish_post' THEN cfg.unverified_post_enabled AND category=ANY(cfg.unverified_categories) ELSE cfg.unverified_comment_enabled END) AND cfg.coverage_state='complete' AND cfg.provenance_state='accepted'
   AND length(whaleu_profile.moderation_trim(cfg.source_reference))>0 AND length(whaleu_profile.moderation_trim(cfg.policy_reference))>0
   AND isfinite(cfg.effective_at) AND cfg.effective_at<=instant AND ((cfg.expiry_kind='policy_exempt' AND cfg.valid_until IS NULL) OR (cfg.expiry_kind='at' AND isfinite(cfg.valid_until) AND cfg.valid_until>cfg.effective_at AND cfg.valid_until>instant)),false);
 END IF;
 IF scope->'configurationRevisionId' IS DISTINCT FROM 'null'::jsonb OR scope->>'authorOriginRegionId' IS DISTINCT FROM a.origin_region_id::text OR scope->>'affiliationSnapshotId' IS DISTINCT FROM v.id::text OR scope->>'affiliationAssertionId' IS DISTINCT FROM a.id::text THEN RETURN false; END IF;
 SELECT s.* INTO selection FROM whaleu_campus.community_identity_heads h JOIN whaleu_campus.community_identity_selections s ON (s.id,s.account_id,s.revision)=(h.selection_id,h.account_id,h.revision) WHERE h.account_id=actor;
 SELECT s.* INTO topo FROM whaleu_campus.community_topology_heads h JOIN whaleu_campus.community_topology_snapshots s ON (s.id,s.revision)=(h.snapshot_id,h.revision) WHERE h.scope_key='community';
 IF selection.id IS NULL OR topo.id IS NULL OR selection.selection_state<>'selected' OR selection.id::text IS DISTINCT FROM scope->>'identitySelectionId'
 OR selection.campus_id::text IS DISTINCT FROM scope->>'identityCampusId' OR selection.affiliation_snapshot_id IS DISTINCT FROM v.id OR selection.affiliation_assertion_id IS DISTINCT FROM a.id
 OR selection.topology_snapshot_id IS DISTINCT FROM topo.id OR topo.id::text IS DISTINCT FROM scope->>'topologySnapshotId'
 OR selection.coverage_state<>'complete' OR selection.provenance_state<>'accepted' OR coalesce(length(whaleu_profile.moderation_trim(selection.source_reference)),0)=0 OR coalesce(length(whaleu_profile.moderation_trim(selection.policy_reference)),0)=0
 OR NOT isfinite(selection.effective_at) OR selection.effective_at>instant OR NOT ((selection.expiry_kind='policy_exempt' AND selection.valid_until IS NULL) OR (selection.expiry_kind='at' AND isfinite(selection.valid_until) AND selection.valid_until>selection.effective_at AND selection.valid_until>instant))
 OR topo.coverage_state<>'complete' OR topo.provenance_state<>'accepted' OR coalesce(length(whaleu_profile.moderation_trim(topo.source_reference)),0)=0 OR coalesce(length(whaleu_profile.moderation_trim(topo.policy_reference)),0)=0
 OR NOT isfinite(topo.effective_at) OR topo.effective_at>instant OR NOT ((topo.expiry_kind='policy_exempt' AND topo.valid_until IS NULL) OR (topo.expiry_kind='at' AND isfinite(topo.valid_until) AND topo.valid_until>topo.effective_at AND topo.valid_until>instant))
 OR whaleu_campus.community_distribution_topology_valid(topo.topology) IS DISTINCT FROM true THEN RETURN false; END IF;
 SELECT r INTO origin FROM jsonb_array_elements(topo.topology->'regions') r WHERE r->>'regionId'=a.origin_region_id::text;
 SELECT p INTO assignment FROM jsonb_array_elements(topo.topology->'assignments') p WHERE p->>'campusId'=selection.campus_id::text;
 SELECT r INTO identity_region FROM jsonb_array_elements(topo.topology->'regions') r WHERE r->>'regionId'=assignment->>'regionId';
 SELECT r INTO target_region FROM jsonb_array_elements(topo.topology->'regions') r WHERE r->>'regionId'=scope->>'originalRegionId';
 IF origin IS NULL OR identity_region IS NULL OR (space_kind='regional' AND target_region IS NULL) OR assignment IS NULL OR assignment->>'coverage' IS DISTINCT FROM 'complete' OR assignment->'isActive' IS DISTINCT FROM 'true'::jsonb
 OR origin->>'institutionId' IS DISTINCT FROM a.issuer_institution_id::text OR assignment->>'institutionId' IS DISTINCT FROM a.issuer_institution_id::text
 OR identity_region->>'groupId' IS DISTINCT FROM origin->>'groupId' OR scope->>'identityRegionId' IS DISTINCT FROM identity_region->>'regionId' THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM (VALUES(origin),(identity_region),(target_region)) node(value)
  WHERE value IS NOT NULL AND (value->>'coverage' IS DISTINCT FROM 'complete' OR value->'isActive' IS DISTINCT FROM 'true'::jsonb
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(topo.topology->'groups') g WHERE g->>'groupId'=value->>'groupId' AND g->>'coverage'='complete' AND g->'isActive'='true'::jsonb)
  OR NOT EXISTS(SELECT 1 FROM whaleu_campus.operating_regions r WHERE r.id=(value->>'regionId')::uuid AND r.is_active))) THEN RETURN false; END IF;
 IF operation='publish_post' AND space_kind='regional' AND mode='anonymous' AND target_region->>'groupId' IS DISTINCT FROM identity_region->>'groupId' THEN RETURN false;END IF;
 RETURN EXISTS(SELECT 1 FROM whaleu_campus.campuses c JOIN whaleu_campus.institutions i ON i.id=c.institution_id JOIN whaleu_campus.campus_region_assignments assignment ON assignment.campus_id=c.id
  WHERE c.id=selection.campus_id AND c.is_active AND c.institution_id=a.issuer_institution_id AND assignment.operating_region_id=(scope->>'identityRegionId')::uuid);
EXCEPTION WHEN OTHERS THEN RETURN false;END $$;

CREATE FUNCTION whaleu_community.text_source_ancestors_current(value jsonb) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE actor uuid:=(value->>'accountId')::uuid;p whaleu_community.posts;n record;b whaleu_community.content_approval_bindings;d whaleu_community.content_approval_decisions;expected integer;BEGIN
 IF value->>'purpose'='publish_post' THEN RETURN true;END IF;
 SELECT * INTO p FROM whaleu_community.posts WHERE id=(value->>'postId')::uuid;
 IF p.id IS NULL OR p.publication_state<>'published' OR p.publication_envelope_version NOT IN (1,2,6)
 OR p.space_id::text IS DISTINCT FROM value->>'spaceId' OR p.category IS DISTINCT FROM value->>'category' OR p.comments_policy IS DISTINCT FROM 'open'
 OR EXISTS(SELECT 1 FROM whaleu_community.post_owner_visibility WHERE post_id=p.id AND owner_hidden)
 -- No new classification owner is implied by explicit source admission.
 OR EXISTS(SELECT 1 FROM whaleu_community.post_category_heads WHERE post_id=p.id)
 OR p.allow_anonymous_dm IS TRUE OR EXISTS(SELECT 1 FROM whaleu_community.polls WHERE post_id=p.id) OR EXISTS(SELECT 1 FROM whaleu_community.formations WHERE post_id=p.id) OR EXISTS(SELECT 1 FROM whaleu_community.trading_listings WHERE post_id=p.id) OR EXISTS(SELECT 1 FROM whaleu_community.post_rating_target_links WHERE post_id=p.id)
 OR EXISTS(SELECT 1 FROM whaleu_community.post_distribution_bindings WHERE post_id=p.id)
 OR (p.author_mode='anonymous' AND actor=p.account_id AND value->>'authorMode'<>'anonymous') THEN RETURN false;END IF;
 expected:=CASE WHEN value->>'purpose'='publish_comment' THEN 1 WHEN value->'targetReplyId'='null'::jsonb THEN 2 ELSE 3 END;
 FOR n IN
  SELECT 'post' kind,id,account_id,author_mode,visibility,deleted_at FROM whaleu_community.posts WHERE id=p.id
  UNION ALL SELECT 'comment',id,account_id,author_mode,visibility,deleted_at FROM whaleu_community.root_comments WHERE id=(value->>'rootCommentId')::uuid AND post_id=p.id
  UNION ALL SELECT 'reply',id,account_id,author_mode,visibility,deleted_at FROM whaleu_community.replies WHERE id=(value->>'targetReplyId')::uuid AND post_id=p.id AND root_comment_id=(value->>'rootCommentId')::uuid
 LOOP
  expected:=expected-1;
  SELECT * INTO b FROM whaleu_community.content_approval_bindings WHERE content_kind=n.kind AND content_id=n.id AND content_version=1;
  SELECT * INTO d FROM whaleu_community.content_approval_decisions WHERE id=b.decision_id;
  IF n.visibility<>'approved' OR n.deleted_at IS NOT NULL OR b.content_id IS NULL OR b.envelope_version NOT IN (1,2,6)
   OR (b.account_id,b.operation,b.envelope_version,b.digest,b.envelope,b.scope) IS DISTINCT FROM (n.account_id,'publish_'||n.kind,d.envelope_version,d.digest,d.envelope,d.envelope->'scope')
   OR b.envelope IS DISTINCT FROM whaleu_community.profile_moderation_definition(n.kind,n.id,b.scope)
   OR whaleu_community.text_source_review_current(b.decision_id) IS DISTINCT FROM true
   OR whaleu_community.profile_moderation_media_current(n.kind,n.id,b.envelope->'images') IS DISTINCT FROM true
   OR NOT EXISTS(SELECT 1 FROM whaleu_identity.accounts WHERE id=n.account_id AND status='active' AND lifecycle='active')
   OR NOT EXISTS(SELECT 1 FROM whaleu_community.report_origins o JOIN whaleu_community.publication_requests q ON (q.account_id,q.client_request_id)=(o.owner_account_id,o.source_request_id)
    WHERE o.kind=n.kind AND o.target_id=n.id AND o.owner_account_id=n.account_id AND o.provenance='native_publication'
    AND q.operation='publish_'||n.kind AND q.receipt->>'operation'=q.operation AND q.receipt->>'requestId'=q.client_request_id::text AND q.receipt->>'outcome'='created' AND q.receipt->>'resourceId'=n.id::text) THEN RETURN false;END IF;
  IF n.author_mode='named' AND n.account_id<>actor AND (
   NOT EXISTS(SELECT 1 FROM whaleu_safety.account_heads h WHERE h.account_id=n.account_id AND h.block_coverage='complete' AND h.provenance='native_account_creation' AND (h.valid_until IS NULL OR h.valid_until>clock_timestamp()))
   OR EXISTS(SELECT 1 FROM whaleu_safety.blocks WHERE active AND ((blocker_id=actor AND blocked_id=n.account_id) OR (blocker_id=n.account_id AND blocked_id=actor)))) THEN RETURN false;END IF;
 END LOOP;
 RETURN expected=0;
EXCEPTION WHEN OTHERS THEN RETURN false;END$$;
CREATE FUNCTION whaleu_community.text_source_admitted(value jsonb) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE root_mode text;BEGIN
 IF whaleu_community.text_source_envelope_valid(value) IS DISTINCT FROM true THEN RETURN false;END IF;
 IF value->>'purpose'<>'publish_post' THEN SELECT author_mode INTO root_mode FROM whaleu_community.posts WHERE id=(value->>'postId')::uuid;END IF;
 RETURN EXISTS(SELECT 1 FROM whaleu_identity.accounts WHERE id=(value->>'accountId')::uuid AND status='active' AND lifecycle='active')
 AND whaleu_community.text_source_destination_current((value->>'accountId')::uuid,value->'scope',value->>'authorMode',value->>'category',value->>'purpose',root_mode) IS TRUE
 AND whaleu_community.text_source_ancestors_current(value) IS TRUE;
EXCEPTION WHEN OTHERS THEN RETURN false;END$$;
CREATE FUNCTION whaleu_community.text_source_fence() RETURNS void LANGUAGE plpgsql AS $$BEGIN
 -- Every native actor/ancestry/Review source writer advances these existing
 -- full-vector generations before mutation. NOWAIT fails closed on races.
 LOCK TABLE whaleu_community.related_sync_actor_generation,whaleu_community.related_sync_admission_generation,whaleu_campus.community_distribution_generation,whaleu_community.related_sync_view_generation,
 whaleu_community.content_approval_heads,whaleu_community.content_approval_policies,whaleu_media.media_owner_states,whaleu_community.publication_cancel_fences,whaleu_safety.account_punishment_heads,whaleu_safety.account_punishments,whaleu_safety.account_punishment_terminals,
 -- These exact definition/causal sources do not all advance inherited actor
 -- generations; fence them directly, without changing the legacy writers.
 whaleu_community.post_distribution_bindings,whaleu_community.trading_listings,whaleu_community.post_rating_target_links,
 whaleu_community.report_origins,whaleu_community.publication_requests,whaleu_community.outbox IN SHARE MODE NOWAIT;
END$$;

-- Preserve the old SQL predicates verbatim, extending only the v6 domain.
DO $$DECLARE pair text[];definition text;BEGIN
 FOREACH pair SLICE 1 IN ARRAY ARRAY[
  ['posts','post_anonymous_dm_definition','publication_envelope_version=6 AND category IN (''discussion'',''confession'',''companions'',''pets'',''internships'',''scenery'',''dorms'',''research'',''deep_sea'') AND feedback IS NULL AND comments_policy=''open'' AND (allow_anonymous_dm IS NULL OR (author_mode=''named'' AND allow_anonymous_dm=false))'],
  ['content_approval_decisions','content_approval_envelope_identity','envelope_version=6 AND envelope->>''accountId''=account_id::text AND envelope->>''purpose''=operation AND whaleu_community.text_source_envelope_valid(envelope)'],
  ['text_review_requests','text_review_identity','envelope->>''version''=''6'' AND envelope->>''accountId''=account_id::text AND envelope->>''purpose''=operation AND whaleu_community.text_source_envelope_valid(envelope)'],
  ['text_review_requests','text_review_scope_definition','envelope->>''version''=''6'' AND whaleu_community.text_source_envelope_valid(envelope)']
 ] LOOP
  SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint WHERE conrelid=('whaleu_community.'||pair[1])::regclass AND conname=pair[2];
  IF definition IS NULL THEN RAISE EXCEPTION 'Missing historical content constraint';END IF;
  EXECUTE format('ALTER TABLE whaleu_community.%I DROP CONSTRAINT %I',pair[1],pair[2]);
  EXECUTE format('ALTER TABLE whaleu_community.%I ADD CONSTRAINT %I CHECK (%s OR coalesce((%s),false))',pair[1],pair[2],substr(definition,7),pair[3]);
 END LOOP;END$$;
ALTER TABLE whaleu_community.content_approval_decisions DROP CONSTRAINT content_approval_envelope_version;
ALTER TABLE whaleu_community.content_approval_decisions ADD CONSTRAINT content_approval_envelope_version CHECK(envelope_version IN (1,2,3,4,5,6));
ALTER TABLE whaleu_community.content_approval_bindings DROP CONSTRAINT content_binding_envelope_version;
ALTER TABLE whaleu_community.content_approval_bindings ADD CONSTRAINT content_binding_envelope_version CHECK(envelope_version IN (1,2,3,4,5,6) AND envelope->>'version'=envelope_version::text AND (envelope_version IN (1,4,6) OR (content_kind='post' AND operation='publish_post')));
ALTER TABLE whaleu_community.content_approval_policies DROP CONSTRAINT content_approval_policies_policy_key_check;
ALTER TABLE whaleu_community.content_approval_policies ADD CONSTRAINT content_approval_policies_policy_key_check CHECK(policy_key IN ('local-explicit-v1','local-related-v1','local-text-source-v1'));
CREATE OR REPLACE FUNCTION whaleu_community.related_review_policy_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE key text;BEGIN
 SELECT policy_key INTO key FROM whaleu_community.content_approval_policies WHERE id=NEW.policy_revision_id;
 IF NEW.envelope_version=6 THEN
  IF key IS DISTINCT FROM 'local-text-source-v1' THEN RAISE EXCEPTION 'Review envelope policy domain mismatch' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 IF (NEW.envelope_version=4 AND key IS DISTINCT FROM 'local-related-v1') OR (NEW.envelope_version<>4 AND key IS DISTINCT FROM 'local-explicit-v1') THEN RAISE EXCEPTION 'Review envelope policy domain mismatch' USING ERRCODE='23514'; END IF;
 IF NEW.envelope_version=4 AND NEW.envelope->>'purpose'='publish_post' AND NOT EXISTS(SELECT 1 FROM whaleu_community.related_sync_policies p WHERE p.id=(NEW.envelope->'scope'->>'syncPolicyId')::uuid AND p.review_policy_revision_id=NEW.policy_revision_id) THEN RAISE EXCEPTION 'Root Review requires exact applicability reviewer' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END$$;
CREATE OR REPLACE FUNCTION whaleu_community.content_binding_dm_definition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE post whaleu_community.posts;BEGIN
 IF NEW.envelope_version=6 THEN
  IF whaleu_community.text_source_envelope_valid(NEW.envelope) IS DISTINCT FROM true
   OR NEW.envelope IS DISTINCT FROM whaleu_community.text_source_definition(NEW.content_kind,NEW.content_id,NEW.scope)
   THEN RAISE EXCEPTION 'Text source reviewed definition mismatch' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 IF EXISTS(SELECT 1 FROM whaleu_community.community_text_sources WHERE content_kind=NEW.content_kind AND content_id=NEW.content_id) THEN
  RAISE EXCEPTION 'Explicit source cannot acquire a legacy approval' USING ERRCODE='23514';END IF;
 IF NEW.envelope_version=4 THEN
  IF whaleu_community.related_sync_envelope_valid(NEW.envelope) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Invalid v4 content definition' USING ERRCODE='23514'; END IF;
  IF NEW.content_kind='post' THEN
   IF NOT EXISTS(SELECT 1 FROM whaleu_community.posts p WHERE p.id=NEW.content_id AND p.publication_envelope_version=4 AND to_jsonb(p.allow_anonymous_dm)=nullif(NEW.envelope->'allowAnonymousDm','null'::jsonb)) AND NOT EXISTS(SELECT 1 FROM whaleu_community.posts p WHERE p.id=NEW.content_id AND p.publication_envelope_version=4 AND p.allow_anonymous_dm IS NULL AND NEW.envelope->'allowAnonymousDm'='null'::jsonb) THEN RAISE EXCEPTION 'Related root DM definition mismatch' USING ERRCODE='23514'; END IF;
  ELSIF NOT EXISTS(SELECT 1 FROM whaleu_community.posts p WHERE p.id=(NEW.envelope->>'postId')::uuid AND p.publication_envelope_version=4) THEN RAISE EXCEPTION 'Inherited child requires related root' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.content_kind<>'post' AND EXISTS(SELECT 1 FROM whaleu_community.posts p WHERE p.id=(NEW.envelope->>'postId')::uuid AND p.publication_envelope_version=4) THEN RAISE EXCEPTION 'Related child cannot downgrade to v1' USING ERRCODE='23514'; END IF;
 IF NEW.content_kind='post' THEN
  SELECT * INTO post FROM whaleu_community.posts WHERE id=NEW.content_id FOR SHARE;
  IF NOT FOUND OR post.publication_envelope_version IS DISTINCT FROM NEW.envelope_version OR
   (NEW.envelope_version=1 AND (post.allow_anonymous_dm IS NOT NULL OR NEW.envelope ? 'allowAnonymousDm')) OR
   (NEW.envelope_version=2 AND (post.author_mode<>'named' OR jsonb_typeof(NEW.envelope->'allowAnonymousDm') IS DISTINCT FROM 'boolean' OR to_jsonb(post.allow_anonymous_dm) IS DISTINCT FROM NEW.envelope->'allowAnonymousDm')) THEN
   RAISE EXCEPTION 'Anonymous DM reviewed definition mismatch' USING ERRCODE='23514';END IF;
 ELSIF NEW.envelope_version<>1 OR NEW.envelope ? 'allowAnonymousDm' THEN
  RAISE EXCEPTION 'Anonymous DM consent requires a named post' USING ERRCODE='23514';END IF;
 RETURN NEW;
END$$;

CREATE FUNCTION whaleu_community.text_source_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c jsonb;creation xid8;relation text;p whaleu_community.posts;BEGIN
 IF NEW.content_kind NOT IN ('post','comment','reply') THEN RAISE EXCEPTION 'Invalid source kind' USING ERRCODE='23514';END IF;
 relation:=CASE NEW.content_kind WHEN 'post' THEN 'posts' WHEN 'comment' THEN 'root_comments' ELSE 'replies' END;
 EXECUTE format('SELECT to_jsonb(n),%I FROM whaleu_community.%I n WHERE id=$1 FOR SHARE',CASE WHEN NEW.content_kind='post' THEN 'publication_transaction' ELSE 'approval_publication_transaction' END,relation) INTO c,creation USING NEW.content_id;
 SELECT * INTO p FROM whaleu_community.posts WHERE id=CASE WHEN NEW.content_kind='post' THEN NEW.content_id ELSE (c->>'post_id')::uuid END;
 IF c IS NULL OR p.id IS NULL OR creation IS DISTINCT FROM pg_current_xact_id() OR NEW.publication_transaction IS DISTINCT FROM pg_current_xact_id()
 OR NEW.created_at IS DISTINCT FROM transaction_timestamp() OR c->>'account_id' IS DISTINCT FROM NEW.account_id::text
 OR NEW.source_hash IS DISTINCT FROM whaleu_community.text_source_hash(NEW.source_format,c->>'text')
 OR c->>'author_mode' IS DISTINCT FROM (CASE WHEN NEW.content_kind<>'post' AND p.author_mode='anonymous' AND p.account_id=NEW.account_id THEN 'anonymous' ELSE NEW.requested_author_mode END)
 OR EXISTS(SELECT 1 FROM whaleu_community.content_approval_bindings WHERE content_kind=NEW.content_kind AND content_id=NEW.content_id)
 THEN RAISE EXCEPTION 'Source requires its exact fresh original publication' USING ERRCODE='23514',CONSTRAINT='text_source_causal';END IF;
 PERFORM whaleu_community.text_source_fence();
 RETURN NEW;
END$$;
CREATE TRIGGER text_source_insert_guard BEFORE INSERT ON whaleu_community.community_text_sources FOR EACH ROW EXECUTE FUNCTION whaleu_community.text_source_insert_guard();

CREATE FUNCTION whaleu_community.text_source_assert(kind text,target uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE s whaleu_community.community_text_sources;b whaleu_community.content_approval_bindings;d whaleu_community.content_approval_decisions;q whaleu_community.publication_requests;e jsonb;c jsonb;creation xid8;relation text;p whaleu_community.posts;BEGIN
 SELECT * INTO s FROM whaleu_community.community_text_sources WHERE content_kind=kind AND content_id=target;
 SELECT * INTO b FROM whaleu_community.content_approval_bindings WHERE content_kind=kind AND content_id=target AND content_version=1;
 IF s.content_id IS NULL AND b.envelope_version IS DISTINCT FROM 6
 AND NOT (kind='post' AND EXISTS(SELECT 1 FROM whaleu_community.posts WHERE id=target AND publication_envelope_version=6)) THEN RETURN;END IF;
 IF kind IS NULL OR kind NOT IN ('post','comment','reply') THEN RAISE EXCEPTION 'Invalid source identity' USING ERRCODE='23514';END IF;
 relation:=CASE kind WHEN 'post' THEN 'posts' WHEN 'comment' THEN 'root_comments' ELSE 'replies' END;
 EXECUTE format('SELECT to_jsonb(n),%I FROM whaleu_community.%I n WHERE id=$1',CASE WHEN kind='post' THEN 'publication_transaction' ELSE 'approval_publication_transaction' END,relation) INTO c,creation USING target;
 SELECT * INTO p FROM whaleu_community.posts WHERE id=CASE WHEN kind='post' THEN target ELSE (c->>'post_id')::uuid END;
 SELECT * INTO d FROM whaleu_community.content_approval_decisions WHERE id=s.decision_id;
 SELECT * INTO q FROM whaleu_community.publication_requests WHERE account_id=s.account_id AND client_request_id=s.client_request_id;
 e:=whaleu_community.text_source_definition(kind,target,b.scope);
 IF s.content_id IS NULL OR b.content_id IS NULL OR b.envelope_version IS DISTINCT FROM 6 OR d.id IS NULL OR q.account_id IS NULL OR c IS NULL OR e IS NULL
 OR (s.account_id,s.decision_id,s.approval_digest) IS DISTINCT FROM (b.account_id,b.decision_id,b.digest)
 OR (d.account_id,d.operation,d.envelope_version,d.digest,d.envelope) IS DISTINCT FROM (s.account_id,'publish_'||kind,6,s.approval_digest,e)
 OR b.envelope IS DISTINCT FROM e OR b.operation IS DISTINCT FROM 'publish_'||kind OR b.scope IS DISTINCT FROM e->'scope'
 OR creation IS DISTINCT FROM s.publication_transaction OR c->>'account_id' IS DISTINCT FROM s.account_id::text
 OR c->>'author_mode' IS DISTINCT FROM (CASE WHEN kind<>'post' AND p.author_mode='anonymous' AND p.account_id=s.account_id THEN 'anonymous' ELSE s.requested_author_mode END)
 OR q.operation IS DISTINCT FROM 'publish_'||kind OR q.payload_hash IS DISTINCT FROM s.original_intent_hash
 OR s.original_intent_hash IS DISTINCT FROM whaleu_community.text_source_intent_hash(e,s.requested_author_mode)
 OR q.receipt->>'outcome' IS DISTINCT FROM 'created' OR q.receipt->>'resourceId' IS DISTINCT FROM target::text OR q.receipt->>'requestId' IS DISTINCT FROM s.client_request_id::text OR q.receipt->>'operation' IS DISTINCT FROM q.operation
 OR EXISTS(SELECT 1 FROM whaleu_community.publication_cancel_fences WHERE account_id=s.account_id AND client_request_id=s.client_request_id)
 OR NOT EXISTS(SELECT 1 FROM whaleu_community.report_origins o WHERE o.kind=text_source_assert.kind AND o.target_id=target AND o.owner_account_id=s.account_id AND o.source_request_id=s.client_request_id AND o.provenance='native_publication')
 OR NOT EXISTS(SELECT 1 FROM whaleu_community.outbox WHERE event_key=kind||':'||target::text||':created' AND event_type=kind||'_created' AND resource_id=target)
 THEN RAISE EXCEPTION 'Text source causal completeness failed' USING ERRCODE='23514',CONSTRAINT='text_source_causal';END IF;
 IF s.publication_transaction=pg_current_xact_id() THEN
  PERFORM whaleu_community.text_source_fence();
  IF whaleu_community.text_source_admitted(e) IS DISTINCT FROM true OR whaleu_community.text_source_review_current(s.decision_id,true) IS DISTINCT FROM true
  OR whaleu_community.profile_moderation_media_current(kind,target,e->'images') IS DISTINCT FROM true
  THEN RAISE EXCEPTION 'Current source publication authority changed' USING ERRCODE='23514',CONSTRAINT='text_source_causal';END IF;
 END IF;
END$$;
CREATE FUNCTION whaleu_community.text_source_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind text;target uuid;q whaleu_community.publication_requests;BEGIN
 IF TG_TABLE_NAME='posts' THEN kind:='post';target:=NEW.id;
 ELSIF TG_TABLE_NAME='root_comments' THEN kind:='comment';target:=NEW.id;
 ELSIF TG_TABLE_NAME='replies' THEN kind:='reply';target:=NEW.id;
 ELSIF TG_TABLE_NAME='publication_requests' THEN
  -- Deferred INSERT NEW may still contain NULL; re-read the final original key.
  SELECT * INTO q FROM whaleu_community.publication_requests WHERE account_id=NEW.account_id AND client_request_id=NEW.client_request_id;
  IF q.receipt->>'outcome' IS DISTINCT FROM 'created' THEN RETURN NULL;END IF;
  kind:=CASE q.operation WHEN 'publish_post' THEN 'post' WHEN 'publish_comment' THEN 'comment' WHEN 'publish_reply' THEN 'reply' ELSE NULL END;
  target:=(q.receipt->>'resourceId')::uuid;
 ELSE kind:=NEW.content_kind;target:=NEW.content_id;END IF;
 PERFORM whaleu_community.text_source_assert(kind,target);RETURN NULL;
END$$;
CREATE CONSTRAINT TRIGGER text_source_complete AFTER INSERT ON whaleu_community.community_text_sources DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.text_source_complete();
CREATE CONSTRAINT TRIGGER text_source_post_complete AFTER INSERT ON whaleu_community.posts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.publication_envelope_version=6) EXECUTE FUNCTION whaleu_community.text_source_complete();
CREATE CONSTRAINT TRIGGER text_source_comment_complete AFTER INSERT ON whaleu_community.root_comments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.text_source_complete();
CREATE CONSTRAINT TRIGGER text_source_reply_complete AFTER INSERT ON whaleu_community.replies DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.text_source_complete();
CREATE CONSTRAINT TRIGGER text_source_binding_complete AFTER INSERT ON whaleu_community.content_approval_bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.text_source_complete();
CREATE CONSTRAINT TRIGGER text_source_request_complete AFTER INSERT OR UPDATE ON whaleu_community.publication_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.text_source_complete();

CREATE FUNCTION whaleu_community.text_source_review_assert(e jsonb,intent text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
DECLARE original_mode text;BEGIN
 IF e->>'version' IS DISTINCT FROM '6' THEN RETURN;END IF;
 PERFORM whaleu_community.text_source_fence();
 IF whaleu_community.text_source_admitted(e) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Current source review authority unavailable' USING ERRCODE='23514',CONSTRAINT='text_source_causal';END IF;
 IF intent IS NOT NULL THEN
  original_mode:=e->>'authorMode';
  IF intent IS DISTINCT FROM whaleu_community.text_source_intent_hash(e,original_mode) AND NOT (
   e->>'purpose'<>'publish_post' AND e->>'authorMode'='anonymous'
   AND EXISTS(SELECT 1 FROM whaleu_community.posts WHERE id=(e->>'postId')::uuid AND account_id=(e->>'accountId')::uuid AND author_mode='anonymous')
   AND intent=whaleu_community.text_source_intent_hash(e,'named')) THEN
   RAISE EXCEPTION 'Source review must retain original author intent' USING ERRCODE='23514',CONSTRAINT='text_source_causal';END IF;
 END IF;
END$$;
-- A client may not choose or move a cohort transaction. Decisions are already
-- immutable; queue snapshots stay immutable and only their real first decision
-- link stamps a new transaction. A no-op UPDATE retains the earlier observation.
CREATE FUNCTION whaleu_community.text_source_cohort_capture() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d whaleu_community.content_approval_decisions;BEGIN
 IF TG_TABLE_NAME='content_approval_decisions' THEN
  IF NEW.text_source_issuance_transaction IS NOT NULL THEN RAISE EXCEPTION 'Source decision transaction is server owned' USING ERRCODE='23514',CONSTRAINT='text_source_cohort';END IF;
  IF NEW.envelope_version=6 THEN NEW.text_source_issuance_transaction:=pg_current_xact_id();END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.text_source_transition_transaction IS NOT NULL THEN RAISE EXCEPTION 'Source queue transaction is server owned' USING ERRCODE='23514',CONSTRAINT='text_source_cohort';END IF;
  IF NEW.envelope->>'version'='6' THEN NEW.text_source_transition_transaction:=pg_current_xact_id();END IF;
 ELSIF NEW.text_source_transition_transaction IS DISTINCT FROM OLD.text_source_transition_transaction THEN
  RAISE EXCEPTION 'Source queue transaction is immutable to callers' USING ERRCODE='23514',CONSTRAINT='text_source_cohort';
 ELSIF NEW.envelope->>'version'='6' AND OLD.decision_id IS NULL AND NEW.decision_id IS NOT NULL THEN
  SELECT * INTO d FROM whaleu_community.content_approval_decisions WHERE id=NEW.decision_id;
  IF d.id IS NULL OR (d.account_id,d.operation,d.envelope_version,d.digest,d.envelope) IS DISTINCT FROM (NEW.account_id,NEW.operation,6,NEW.digest,NEW.envelope)
   OR NOT EXISTS(SELECT 1 FROM whaleu_community.publication_requests p WHERE (p.account_id,p.client_request_id,p.operation,p.payload_hash)=(NEW.account_id,NEW.client_request_id,NEW.operation,NEW.intent_hash))
   THEN RAISE EXCEPTION 'Source queue transition requires exact original decision and request' USING ERRCODE='23514',CONSTRAINT='text_source_cohort';END IF;
  NEW.text_source_transition_transaction:=pg_current_xact_id();
 END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER text_source_cohort_capture BEFORE INSERT ON whaleu_community.content_approval_decisions FOR EACH ROW EXECUTE FUNCTION whaleu_community.text_source_cohort_capture();
CREATE TRIGGER text_source_cohort_capture BEFORE INSERT OR UPDATE ON whaleu_community.text_review_requests FOR EACH ROW EXECUTE FUNCTION whaleu_community.text_source_cohort_capture();

CREATE FUNCTION whaleu_community.text_source_review_fresh() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.envelope->>'version'='6' THEN PERFORM whaleu_community.text_source_review_assert(NEW.envelope,CASE WHEN TG_TABLE_NAME='text_review_requests' THEN to_jsonb(NEW)->>'intent_hash' ELSE NULL END);END IF;
 RETURN NEW;
END$$;
CREATE FUNCTION whaleu_community.text_source_review_complete() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.envelope->>'version'='6' THEN PERFORM whaleu_community.text_source_review_assert(NEW.envelope,CASE WHEN TG_TABLE_NAME='text_review_requests' THEN to_jsonb(NEW)->>'intent_hash' ELSE NULL END);END IF;
 RETURN NULL;
END$$;
CREATE TRIGGER text_source_review_fresh BEFORE INSERT ON whaleu_community.text_review_requests FOR EACH ROW EXECUTE FUNCTION whaleu_community.text_source_review_fresh();
CREATE TRIGGER text_source_decision_fresh BEFORE INSERT ON whaleu_community.content_approval_decisions FOR EACH ROW WHEN(NEW.envelope_version=6) EXECUTE FUNCTION whaleu_community.text_source_review_fresh();
CREATE CONSTRAINT TRIGGER text_source_review_complete AFTER INSERT OR UPDATE ON whaleu_community.text_review_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.text_source_review_complete();
CREATE CONSTRAINT TRIGGER text_source_decision_complete AFTER INSERT ON whaleu_community.content_approval_decisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.envelope_version=6) EXECUTE FUNCTION whaleu_community.text_source_review_complete();

-- Phase one: current authority is independently checkable immediately after
-- source INSERT, while binding/receipt/origin/outbox are legitimately unfinished.
-- Never call full deferred completeness unconditionally from AFTER STATEMENT.
CREATE FUNCTION whaleu_community.text_source_authority_assert(kind text,target uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE s whaleu_community.community_text_sources;d whaleu_community.content_approval_decisions;e jsonb;BEGIN
 SELECT * INTO s FROM whaleu_community.community_text_sources WHERE content_kind=kind AND content_id=target AND publication_transaction=pg_current_xact_id();
 IF s.content_id IS NULL THEN RETURN;END IF;
 PERFORM whaleu_community.text_source_fence();
 SELECT * INTO d FROM whaleu_community.content_approval_decisions WHERE id=s.decision_id;
 e:=whaleu_community.text_source_definition(kind,target,d.envelope->'scope');
 IF e IS NULL OR d.id IS NULL OR (d.account_id,d.operation,d.envelope_version,d.digest,d.envelope) IS DISTINCT FROM (s.account_id,'publish_'||kind,6,s.approval_digest,e)
 OR s.original_intent_hash IS DISTINCT FROM whaleu_community.text_source_intent_hash(e,s.requested_author_mode)
 OR NOT EXISTS(SELECT 1 FROM whaleu_community.publication_requests q WHERE (q.account_id,q.client_request_id,q.operation,q.payload_hash)=(s.account_id,s.client_request_id,'publish_'||kind,s.original_intent_hash))
 OR EXISTS(SELECT 1 FROM whaleu_community.publication_cancel_fences WHERE account_id=s.account_id AND client_request_id=s.client_request_id)
 OR whaleu_community.text_source_admitted(e) IS DISTINCT FROM true OR whaleu_community.text_source_review_current(s.decision_id,true) IS DISTINCT FROM true
 OR whaleu_community.profile_moderation_media_current(kind,target,e->'images') IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'Current source publication authority changed' USING ERRCODE='23514',CONSTRAINT='text_source_causal';END IF;
END$$;
CREATE FUNCTION whaleu_community.text_source_review_cohorts_assert() RETURNS void LANGUAGE plpgsql AS $$
DECLARE q record;d record;BEGIN
 FOR q IN SELECT * FROM whaleu_community.text_review_requests WHERE envelope->>'version'='6'
  -- The server stamps INSERT as well as the first decision-link UPDATE. One
  -- indexed cohort therefore includes fresh submissions and old queue transitions.
  AND text_source_transition_transaction=pg_current_xact_id() LOOP
  IF EXISTS(SELECT 1 FROM whaleu_community.publication_cancel_fences WHERE account_id=q.account_id AND client_request_id=q.client_request_id)
   THEN RAISE EXCEPTION 'Current source Review was cancelled' USING ERRCODE='23514',CONSTRAINT='text_source_causal';END IF;
  PERFORM whaleu_community.text_source_review_assert(q.envelope,q.intent_hash);
 END LOOP;
 -- A new decision need not yet have an event/head and may legitimately reject.
 -- This cohort asserts current issuance authority, never result/visibility.
 FOR d IN SELECT envelope FROM whaleu_community.content_approval_decisions WHERE envelope_version=6 AND text_source_issuance_transaction=pg_current_xact_id() LOOP
  PERFORM whaleu_community.text_source_review_assert(d.envelope);
 END LOOP;
END$$;
CREATE FUNCTION whaleu_community.text_source_recheck_authority() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s record;BEGIN
 FOR s IN SELECT content_kind,content_id FROM whaleu_community.community_text_sources WHERE publication_transaction=pg_current_xact_id() LOOP
  PERFORM whaleu_community.text_source_authority_assert(s.content_kind,s.content_id);
  -- TRUNCATE is not a construction step. It must not erase original causal
  -- evidence after an earlier constraint flush; normal INSERT staging is intact.
  IF TG_OP='TRUNCATE' THEN PERFORM whaleu_community.text_source_assert(s.content_kind,s.content_id);END IF;
 END LOOP;
 PERFORM whaleu_community.text_source_review_cohorts_assert();
 RETURN NULL;
END$$;
-- Phase two: final complete source/binding/original receipt/effects closure.
-- Inherited BEFORE-generation callbacks stay deferred and retain their locks;
-- post-statement authority is the independent IMMEDIATE-timing closure.
CREATE FUNCTION whaleu_community.text_source_recheck_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s record;BEGIN
 FOR s IN SELECT content_kind,content_id FROM whaleu_community.community_text_sources WHERE publication_transaction=pg_current_xact_id() LOOP
  PERFORM whaleu_community.text_source_assert(s.content_kind,s.content_id);
 END LOOP;
 PERFORM whaleu_community.text_source_review_cohorts_assert();
 RETURN NULL;
END$$;
DO $$DECLARE relation text;BEGIN
 FOREACH relation IN ARRAY ARRAY['whaleu_community.related_sync_actor_generation','whaleu_community.related_sync_admission_generation','whaleu_campus.community_distribution_generation','whaleu_community.related_sync_view_generation'] LOOP
  EXECUTE format('CREATE CONSTRAINT TRIGGER text_source_recheck AFTER INSERT OR UPDATE ON %s DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.text_source_recheck_transaction()',relation);
 END LOOP;
 -- These exact causal owners do not all bump inherited generations. A row
 -- mutation after constraints become IMMEDIATE still rechecks full closure.
 FOREACH relation IN ARRAY ARRAY['whaleu_community.report_origins','whaleu_community.publication_requests','whaleu_community.outbox'] LOOP
  EXECUTE format('CREATE CONSTRAINT TRIGGER text_source_causal_recheck AFTER INSERT OR UPDATE OR DELETE ON %s DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.text_source_recheck_transaction()',relation);
 END LOOP;
END$$;

-- Explicit new definition dependency, with the unchanged administrative and
-- account-lifecycle guards. This is NOT a reviewed account-erasure owner.
CREATE TRIGGER a_discovery_count_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.community_text_sources FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.advance_discovery_count_epoch();
CREATE TRIGGER a000_related_actor_generation BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.community_text_sources FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.related_sync_advance_generation('actor');
CREATE TRIGGER a00_admin_post_removal_source_statement BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.community_text_sources FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.admin_post_removal_source_statement_guard();
CREATE TRIGGER a00_admin_discussion_removal_source_statement BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.community_text_sources FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.admin_discussion_removal_source_statement_guard();
CREATE TRIGGER a000_account_deletion_writer_fence BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.community_text_sources FOR EACH ROW EXECUTE FUNCTION whaleu_account_deletion.writer_fence();
DO $$BEGIN
 IF whaleu_community.admin_post_removal_inventory_current() IS DISTINCT FROM true OR whaleu_community.admin_discussion_removal_inventory_current() IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'Incomplete text-source administrative input inventory';END IF;
END$$;
REVOKE ALL ON whaleu_community.community_text_sources FROM PUBLIC;

-- Complete post-statement dependency closure, including inherited original
-- BEFORE-generation sources and direct v6 definition/causal sources. Explicit
-- inventory, no dynamic discovery that could silently admit a future owner.
-- Zero-row statements still run this check; TRUNCATE sees post-truncation state.
DO $$DECLARE relation text;BEGIN
 FOREACH relation IN ARRAY ARRAY[
 'whaleu_campus.community_topology_snapshots','whaleu_campus.community_topology_heads','whaleu_campus.operating_regions',
 'whaleu_community.region_policy_revisions','whaleu_community.region_policy_heads','whaleu_campus.community_identity_selections','whaleu_campus.community_identity_heads','whaleu_campus.campuses','whaleu_campus.institutions','whaleu_campus.campus_region_assignments',
 'whaleu_verification.account_heads','whaleu_verification.snapshots','whaleu_verification.assertions','whaleu_community.spaces',
 'whaleu_identity.accounts','whaleu_safety.account_heads','whaleu_safety.blocks','whaleu_authorization.role_grants',
 'whaleu_community.posts','whaleu_community.root_comments','whaleu_community.replies','whaleu_community.post_owner_visibility','whaleu_community.post_category_heads','whaleu_community.post_category_events','whaleu_community.post_category_issuers','whaleu_community.post_category_issuer_withdrawals',
 'whaleu_community.post_category_policies','whaleu_community.post_category_policy_heads','whaleu_community.post_category_policy_withdrawals','whaleu_community.post_category_reviews','whaleu_community.post_category_review_withdrawals',
 'whaleu_community.post_images','whaleu_community.comment_images','whaleu_community.reply_images','whaleu_community.polls','whaleu_community.poll_options','whaleu_community.formations','whaleu_community.formation_members',
 'whaleu_community.content_approval_bindings','whaleu_community.content_approval_policies','whaleu_community.content_approval_decisions','whaleu_community.content_approval_events','whaleu_community.content_approval_heads',
 'whaleu_media.assets','whaleu_media.upload_intents','whaleu_media.asset_safety_heads','whaleu_media.asset_safety_events','whaleu_media.bindings',
 'whaleu_safety.account_punishment_heads','whaleu_safety.account_punishments','whaleu_safety.account_punishment_terminals','whaleu_community.publication_cancel_fences','whaleu_media.media_owner_states',
 'whaleu_community.community_text_sources','whaleu_community.post_distribution_bindings','whaleu_community.trading_listings','whaleu_community.post_rating_target_links',
 'whaleu_community.report_origins','whaleu_community.publication_requests','whaleu_community.outbox','whaleu_community.text_review_requests'] LOOP
  EXECUTE format('CREATE TRIGGER text_source_dependency_recheck AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.text_source_recheck_authority()',relation);
 END LOOP;
END$$;
