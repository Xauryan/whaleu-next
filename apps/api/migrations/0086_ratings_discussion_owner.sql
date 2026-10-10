-- Independent discussion command4 / context4 / Review7 / Media7. No source,
-- adoption, provider or approval is seeded by this migration.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));

DO $$DECLARE definition text;BEGIN SELECT pg_get_functiondef('whaleu_ratings.scoped_context_record_digest(jsonb,jsonb,jsonb)'::regprocedure) INTO definition; EXECUTE replace(definition,'FUNCTION whaleu_ratings.scoped_context_record_digest(', 'FUNCTION whaleu_ratings.scoped_context_record_digest_pre_discussion_media(');END$$;

CREATE OR REPLACE FUNCTION whaleu_ratings.scoped_context_record_digest(context_body jsonb,authority_body jsonb,protocol_body jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT CASE WHEN context_body->'protocolVersion'='4'::jsonb THEN whaleu_ratings.scoped_digest('discussion-media-context-record',jsonb_build_object('context',context_body,'authority',authority_body,'protocolTuples',protocol_body))
 ELSE whaleu_ratings.scoped_context_record_digest_pre_discussion_media(context_body,authority_body,protocol_body) END
$$;
ALTER TABLE whaleu_ratings.scoped_contexts DROP CONSTRAINT scoped_context_protocol_dispatch;
ALTER TABLE whaleu_ratings.scoped_contexts ADD CONSTRAINT scoped_context_protocol_dispatch CHECK(
 context->>'id'=id::text AND context->>'actorId'=account_id::text AND context->>'tokenDigest'=token_digest AND
 (context->'protocolVersion'='2'::jsonb OR (context->'protocolVersion'='3'::jsonb AND authority->>'contextAuthority'='ratings-target-cover-context-v1' AND jsonb_typeof(authority->'targetCoverCapabilities')='array')
 OR (context->'protocolVersion'='4'::jsonb AND authority->>'contextAuthority'='ratings-discussion-media-context-v1' AND context->>'purpose' IN ('read','interact')
 AND context->'capabilities' ? 'discussion_images' AND whaleu_ratings.discussion_media_capability_shape(context->'discussionMedia') AND jsonb_array_length(authority->'discussionMediaCapabilities')=1)));
CREATE FUNCTION whaleu_ratings.discussion_media_context_current(context_id uuid,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT c.context->'protocolVersion'='4'::jsonb AND c.authority->>'contextAuthority'='ratings-discussion-media-context-v1'
 AND c.context->'capabilities' ? 'discussion_images' AND c.context->>'purpose' IN ('read','interact') AND jsonb_array_length(c.protocol_tuples)=1
 AND jsonb_array_length(c.authority->'discussionMediaCapabilities')=1
 AND a.id::text=c.context->'discussionMedia'->>'id' AND a.generation::text=c.context->'discussionMedia'->>'generation'
 AND a.adoption_digest=c.context->'discussionMedia'->>'sourceDigest'
 AND (c.context->'discussionMedia'->>'validUntil')::timestamptz=date_trunc('milliseconds',least(a.valid_until,s.valid_until))
 AND c.authority->'discussionMediaCapabilities'=jsonb_build_array((c.context->'discussionMedia')||jsonb_build_object('protocolVersionId',a.protocol_version_id))
 AND a.protocol_version_id::text=c.protocol_tuples->0->>'versionId' AND whaleu_ratings.discussion_media_capability_current(a.id,instant)
 FROM whaleu_ratings.scoped_contexts c JOIN whaleu_ratings.discussion_media_capability_sources a ON a.id::text=c.context->'discussionMedia'->>'id'
 JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(a.source_id,a.source_revision) WHERE c.id=context_id),false)
$$;

DO $$DECLARE definition text;BEGIN SELECT pg_get_functiondef('whaleu_ratings.scoped_context_current(uuid,uuid,uuid,timestamp with time zone)'::regprocedure) INTO definition; EXECUTE replace(definition,'FUNCTION whaleu_ratings.scoped_context_current(', 'FUNCTION whaleu_ratings.scoped_context_current_pre_discussion_media(');END$$;

CREATE OR REPLACE FUNCTION whaleu_ratings.scoped_context_current(context_id uuid,actor uuid,session uuid,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT whaleu_ratings.scoped_context_current_pre_discussion_media(context_id,actor,session,instant)
 AND coalesce((SELECT context->'protocolVersion'<>'4'::jsonb OR whaleu_ratings.discussion_media_context_current(id,instant) FROM whaleu_ratings.scoped_contexts WHERE id=context_id),false)
$$;

DO $$DECLARE definition text;BEGIN SELECT pg_get_functiondef('whaleu_ratings.scoped_intent_valid(jsonb)'::regprocedure) INTO definition; EXECUTE replace(definition,'FUNCTION whaleu_ratings.scoped_intent_valid(', 'FUNCTION whaleu_ratings.scoped_intent_valid_pre_discussion_media(');END$$;

DO $$DECLARE definition text;BEGIN SELECT pg_get_functiondef('whaleu_ratings.scoped_intent_hash(jsonb)'::regprocedure) INTO definition; EXECUTE replace(definition,'FUNCTION whaleu_ratings.scoped_intent_hash(', 'FUNCTION whaleu_ratings.scoped_intent_hash_pre_discussion_media(');END$$;

DO $$DECLARE definition text;BEGIN SELECT pg_get_functiondef('whaleu_ratings.scoped_preparation_envelope(whaleu_ratings.scoped_command_preparations)'::regprocedure) INTO definition; EXECUTE replace(definition,'FUNCTION whaleu_ratings.scoped_preparation_envelope(', 'FUNCTION whaleu_ratings.scoped_preparation_envelope_pre_discussion_media(');END$$;

DO $$DECLARE definition text;BEGIN SELECT pg_get_functiondef('whaleu_ratings.rating_scoped_operation_rule(text,integer)'::regprocedure) INTO definition; EXECUTE replace(definition,'FUNCTION whaleu_ratings.rating_scoped_operation_rule(', 'FUNCTION whaleu_ratings.rating_scoped_operation_rule_pre_discussion_media(');END$$;

CREATE OR REPLACE FUNCTION whaleu_ratings.scoped_intent_valid(i jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN i->'protocolVersion'='4'::jsonb THEN whaleu_ratings.discussion_media_intent_valid(i) ELSE whaleu_ratings.scoped_intent_valid_pre_discussion_media(i) END
$$;
CREATE OR REPLACE FUNCTION whaleu_ratings.scoped_intent_hash(i jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT CASE WHEN i->'protocolVersion'='4'::jsonb THEN whaleu_ratings.discussion_media_intent_hash(i) ELSE whaleu_ratings.scoped_intent_hash_pre_discussion_media(i) END
$$;
CREATE OR REPLACE FUNCTION whaleu_ratings.rating_scoped_operation_rule(op text,protocol integer) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN protocol=4 THEN CASE op
 WHEN 'create_comment_scoped' THEN '{"domain":"create_comment","purpose":"publish_rating_comment_media_scoped","effect":"root_created"}'::jsonb
 WHEN 'create_reply_scoped' THEN '{"domain":"create_reply","purpose":"publish_rating_reply_media_scoped","effect":"reply_created"}'::jsonb ELSE NULL END
 ELSE whaleu_ratings.rating_scoped_operation_rule_pre_discussion_media(op,protocol) END
$$;
CREATE OR REPLACE FUNCTION whaleu_ratings.scoped_preparation_envelope(p whaleu_ratings.scoped_command_preparations) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE e jsonb;v jsonb:=p.intent->'payload';BEGIN
 e:=whaleu_ratings.scoped_preparation_envelope_pre_discussion_media(p);
 IF p.intent->'protocolVersion'<>'4'::jsonb THEN RETURN e;END IF;
 RETURN (e-'assetIds')||jsonb_build_object('version',7,'purpose',whaleu_ratings.rating_scoped_operation_rule(p.operation,4)->'purpose',
 'discussionMedia',p.intent->'context'->'discussionMedia','draftRevision',v->'draftRevision','batchRequestId',v->'batchRequestId','batchId',v->'batchId',
 'sealedPlanDigest',v->'sealedPlanDigest','images',p.before_state->'resolvedDiscussionImages',
 'attachmentSetDigest',whaleu_community.rating_discussion_attachment_set_digest(p.before_state->'resolvedDiscussionImages'));
END$$;

DO $$DECLARE definition text;BEGIN SELECT pg_get_functiondef('whaleu_community.rating_envelope_shape(jsonb,text)'::regprocedure) INTO definition; EXECUTE replace(definition,'FUNCTION whaleu_community.rating_envelope_shape(', 'FUNCTION whaleu_community.rating_envelope_shape_pre_discussion_media(');END$$;

CREATE OR REPLACE FUNCTION whaleu_community.rating_envelope_shape(e jsonb,op text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN op IN ('publish_rating_comment_media_scoped','publish_rating_reply_media_scoped') THEN whaleu_community.rating_discussion_media_envelope_shape(e,op) ELSE whaleu_community.rating_envelope_shape_pre_discussion_media(e,op) END
$$;
ALTER TABLE whaleu_community.rating_approval_decisions DROP CONSTRAINT rating_decision_protocol_v6;
ALTER TABLE whaleu_community.rating_approval_decisions ADD CONSTRAINT rating_decision_protocol_v7 CHECK(
 (operation IN ('publish_rating_target','publish_rating_comment') AND envelope_version=1) OR (operation='publish_rating_reply' AND envelope_version=2)
 OR (operation='edit_rating_target' AND envelope_version=3) OR (operation='publish_rating_categories' AND envelope_version=4)
 OR (operation IN ('publish_rating_target_scoped','edit_rating_target_scoped','publish_rating_comment_scoped','publish_rating_reply_scoped','publish_rating_category_base_scoped','publish_rating_category_override_scoped') AND envelope_version=5)
 OR (operation IN ('publish_rating_target_cover_scoped','edit_rating_target_cover_scoped') AND envelope_version=6)
 OR (operation IN ('publish_rating_comment_media_scoped','publish_rating_reply_media_scoped') AND envelope_version=7));
CREATE TABLE whaleu_community.rating_discussion_media_bindings(
 kind text NOT NULL CHECK(kind IN ('comment','reply')),subject_id uuid NOT NULL,subject_revision uuid NOT NULL,content_version integer NOT NULL CHECK(content_version=1),
 decision_id uuid NOT NULL UNIQUE,account_id uuid NOT NULL,operation text NOT NULL,envelope_version integer NOT NULL CHECK(envelope_version=7),digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),envelope jsonb NOT NULL,scope jsonb NOT NULL,attachment_set_digest text NOT NULL,
 bound_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(bound_at)),publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),PRIMARY KEY(kind,subject_id),
 FOREIGN KEY(decision_id,account_id,operation,envelope_version,digest) REFERENCES whaleu_community.rating_approval_decisions(id,account_id,operation,envelope_version,digest),
 CHECK(whaleu_community.rating_discussion_media_envelope_shape(envelope,operation)),
 CHECK(operation=CASE kind WHEN 'comment' THEN 'publish_rating_comment_media_scoped' ELSE 'publish_rating_reply_media_scoped' END),
 CHECK(envelope->>'subjectId'=subject_id::text AND envelope->>'subjectRevision'=subject_revision::text AND envelope->>'accountId'=account_id::text AND scope=envelope->'scope'),
 CHECK(attachment_set_digest=envelope->>'attachmentSetDigest' AND digest=whaleu_community.rating_discussion_media_approval_digest(envelope))
);

CREATE FUNCTION whaleu_community.rating_discussion_media_decision_current(_decision uuid,_consume boolean) RETURNS boolean LANGUAGE sql AS $$
 WITH instant AS MATERIALIZED (SELECT clock_timestamp() now)
 SELECT coalesce((SELECT d.envelope_version=7 AND whaleu_community.rating_discussion_media_envelope_shape(d.envelope,d.operation)
  AND d.digest=encode(sha256(convert_to('whaleu-rating-content-approval:v7'||chr(10)||whaleu_community.content_canonical_json(d.envelope),'UTF8')),'hex')
  AND d.result='allow' AND d.coverage='complete' AND d.provenance='accepted'
  AND p.policy_key='local-explicit-v1' AND p.version=1 AND p.coverage='complete' AND p.provenance='accepted'
  AND e.state='allow' AND e.coverage='complete' AND e.provenance='accepted'
  AND length(btrim(d.issuer))>0 AND length(btrim(d.provenance_ref))>0 AND length(btrim(p.issuer))>0 AND length(btrim(p.provenance_ref))>0 AND length(btrim(e.issuer))>0 AND length(btrim(e.provenance_ref))>0
  AND isfinite(d.evaluated_at) AND d.evaluated_at<=instant.now AND isfinite(p.valid_from) AND p.valid_from<=d.evaluated_at AND (p.valid_until IS NULL OR (isfinite(p.valid_until) AND p.valid_until>instant.now))
  AND isfinite(e.occurred_at) AND e.occurred_at>=d.evaluated_at AND e.occurred_at<=instant.now AND isfinite(d.consume_until) AND d.consume_until>d.evaluated_at AND (NOT _consume OR d.consume_until>instant.now)
  AND ((d.visibility_model='durable' AND d.visibility_until IS NULL) OR (d.visibility_model='until' AND isfinite(d.visibility_until) AND d.visibility_until>d.evaluated_at AND d.visibility_until>instant.now))
 FROM whaleu_community.rating_approval_decisions d JOIN whaleu_identity.accounts a ON a.id=d.account_id
 JOIN whaleu_community.content_approval_policies p ON p.id=d.policy_revision_id JOIN whaleu_community.rating_approval_heads h ON h.decision_id=d.id
 JOIN whaleu_community.rating_approval_events e ON e.id=h.event_id AND e.decision_id=d.id CROSS JOIN instant WHERE d.id=_decision),false)
$$;

CREATE FUNCTION whaleu_community.rating_discussion_media_binding_validate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d whaleu_community.rating_approval_decisions;instant timestamptz;BEGIN
 SELECT * INTO d FROM whaleu_community.rating_approval_decisions WHERE id=NEW.decision_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Scoped Review decision missing' USING ERRCODE='23514';END IF;
 PERFORM id FROM whaleu_identity.accounts WHERE id=d.account_id FOR SHARE;
 PERFORM decision_id FROM whaleu_community.rating_approval_heads WHERE decision_id=d.id FOR SHARE;instant:=clock_timestamp();
 IF NOT whaleu_community.rating_discussion_media_decision_current(d.id,true) OR NEW.publication_transaction IS DISTINCT FROM pg_current_xact_id()
  OR (NEW.account_id,NEW.operation,NEW.envelope_version,NEW.digest,NEW.envelope) IS DISTINCT FROM (d.account_id,d.operation,d.envelope_version,d.digest,d.envelope)
  OR EXISTS(SELECT 1 FROM whaleu_community.rating_approval_decisions n WHERE n.account_id=d.account_id AND n.operation=d.operation AND n.envelope_version=d.envelope_version AND n.digest=d.digest AND (n.evaluated_at,n.id)>(d.evaluated_at,d.id))
  OR EXISTS(SELECT 1 FROM whaleu_community.rating_discussion_media_bindings WHERE decision_id=d.id)
  OR EXISTS(SELECT 1 FROM whaleu_community.rating_scoped_content_bindings WHERE decision_id=d.id)
  OR EXISTS(SELECT 1 FROM whaleu_community.rating_target_cover_definition_bindings WHERE decision_id=d.id)
  OR EXISTS(SELECT 1 FROM whaleu_community.rating_scoped_category_source_bindings WHERE decision_id=d.id)
 THEN RAISE EXCEPTION 'Scoped exact Review consumption mismatch' USING ERRCODE='23514';END IF;
 NEW.bound_at:=instant;RETURN NEW;END $$;

CREATE FUNCTION whaleu_ratings.discussion_media_set_current(e jsonb,instant timestamptz) RETURNS boolean LANGUAGE sql AS $$
 SELECT coalesce(whaleu_community.rating_discussion_media_envelope_shape(e,e->>'purpose')
 AND (SELECT count(*) FROM whaleu_media.bindings b WHERE b.owner_kind='ratings' AND b.resource_kind=CASE e->>'purpose' WHEN 'publish_rating_comment_media_scoped' THEN 'rating_comment' ELSE 'rating_reply' END
  AND b.resource_id=(e->>'subjectId')::uuid AND b.content_version=1 AND b.detached_at IS NULL)=jsonb_array_length(e->'images')
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(e->'images') image WHERE NOT EXISTS(
 SELECT 1 FROM whaleu_media.bindings b JOIN whaleu_media.assets a ON a.id=b.asset_id JOIN whaleu_media.upload_intents i ON i.id=a.intent_id
 JOIN whaleu_media.asset_safety_heads h ON h.asset_id=a.id JOIN whaleu_media.asset_safety_events event ON (event.asset_id,event.revision,event.id)=(h.asset_id,h.revision,h.event_id)
 WHERE b.owner_kind='ratings' AND b.resource_kind=CASE e->>'purpose' WHEN 'publish_rating_comment_media_scoped' THEN 'rating_comment' ELSE 'rating_reply' END
 AND b.resource_id=(e->>'subjectId')::uuid AND b.slot='images' AND b.content_version=1 AND b.detached_at IS NULL
 AND b.ordinal=(image->>'ordinal')::integer AND b.asset_id=(image->>'assetId')::uuid AND b.manifest_digest=image->>'manifestDigest'
 AND a.actor_id=(e->>'accountId')::uuid AND a.owner_kind='ratings' AND a.resource_kind=b.resource_kind AND a.target_kind='draft' AND a.slot='images'
 AND a.audience='content-gated' AND a.content_version=1 AND a.purpose=CASE b.resource_kind WHEN 'rating_comment' THEN 'ratings-comment-image' ELSE 'ratings-reply-image' END
 AND a.manifest_digest=b.manifest_digest AND a.manifest_digest=encode(sha256(convert_to(E'whaleu-media-manifest:v1\n'||whaleu_media.canonical_json(a.manifest),'UTF8')),'hex')
 AND i.protocol_version=7 AND i.state='ready' AND event.state='allow' AND event.manifest_digest=a.manifest_digest AND event.policy_revision=a.policy_revision
 AND isfinite(event.effective_at) AND event.effective_at<=instant AND isfinite(event.valid_until) AND event.valid_until>instant)),false)
$$;
CREATE FUNCTION whaleu_community.rating_discussion_media_content_current(_kind text,_subject uuid,_revision uuid,_envelope jsonb) RETURNS boolean LANGUAGE sql AS $$
 SELECT coalesce((SELECT b.subject_revision=_revision AND b.envelope=_envelope AND b.scope=_envelope->'scope' AND b.attachment_set_digest=_envelope->>'attachmentSetDigest'
 AND whaleu_community.rating_discussion_media_envelope_shape(_envelope,b.operation)
 AND (d.account_id,d.operation,d.envelope_version,d.digest,d.envelope)=(b.account_id,b.operation,b.envelope_version,b.digest,b.envelope)
 AND isfinite(b.bound_at) AND b.bound_at>=d.evaluated_at AND b.bound_at<=clock_timestamp() AND whaleu_community.rating_discussion_media_decision_current(b.decision_id,false)
 AND whaleu_ratings.discussion_media_set_current(_envelope,clock_timestamp())
 FROM whaleu_community.rating_discussion_media_bindings b JOIN whaleu_community.rating_approval_decisions d ON d.id=b.decision_id
 WHERE b.kind=_kind AND b.subject_id=_subject),false)
$$;

DO $$DECLARE definition text;BEGIN SELECT pg_get_functiondef('whaleu_community.rating_scoped_parent_review_current(text,uuid,uuid)'::regprocedure) INTO definition; EXECUTE replace(definition,'FUNCTION whaleu_community.rating_scoped_parent_review_current(', 'FUNCTION whaleu_community.rating_scoped_parent_review_current_pre_discussion_media(');END$$;

CREATE OR REPLACE FUNCTION whaleu_community.rating_scoped_parent_review_current(_kind text,_subject uuid,_revision uuid) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE content_row record;BEGIN
 SELECT x.* INTO content_row FROM (
 SELECT c.envelope,c.revision,c.account_id,c.body,c.author_mode,c.target_id,c.deleted_at FROM whaleu_ratings.comments c WHERE _kind='comment' AND c.id=_subject
 UNION ALL SELECT c.envelope,c.revision,c.account_id,c.body,c.author_mode,c.target_id,c.deleted_at FROM whaleu_ratings.replies c WHERE _kind='reply' AND c.id=_subject) x;
 IF FOUND AND content_row.envelope->'version'='7'::jsonb THEN
 RETURN coalesce(content_row.deleted_at IS NULL AND content_row.revision=_revision AND content_row.envelope->>'accountId'=content_row.account_id::text
 AND content_row.envelope->>'targetId'=content_row.target_id::text AND content_row.envelope->>'body'=content_row.body AND content_row.envelope->>'authorMode'=content_row.author_mode
 AND whaleu_community.rating_discussion_media_content_current(_kind,_subject,_revision,content_row.envelope),false);
 END IF;
 RETURN whaleu_community.rating_scoped_parent_review_current_pre_discussion_media(_kind,_subject,_revision);
END$$;

CREATE FUNCTION whaleu_ratings.verify_discussion_media_content(kind text,subject uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE rowdata jsonb;content_envelope jsonb;p whaleu_ratings.scoped_command_preparations;t whaleu_ratings.targets;b whaleu_community.rating_discussion_media_bindings;
BEGIN
 IF kind='comment' THEN SELECT to_jsonb(c) INTO rowdata FROM whaleu_ratings.comments c WHERE id=subject;
 ELSIF kind='reply' THEN SELECT to_jsonb(c) INTO rowdata FROM whaleu_ratings.replies c WHERE id=subject;
 ELSE RAISE EXCEPTION 'Unknown scoped content kind' USING ERRCODE='23514';END IF;
 content_envelope:=rowdata->'envelope';SELECT * INTO p FROM whaleu_ratings.scoped_command_preparations WHERE account_id=(rowdata->>'account_id')::uuid AND request_id=(rowdata->>'request_id')::uuid;
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=p.target_id;
 SELECT * INTO b FROM whaleu_community.rating_discussion_media_bindings WHERE rating_discussion_media_bindings.kind=verify_discussion_media_content.kind AND subject_id=subject;
 IF NOT coalesce(p.operation=CASE kind WHEN 'comment' THEN 'create_comment_scoped' ELSE 'create_reply_scoped' END
 AND p.envelope=content_envelope AND p.subject_id=subject AND p.subject_revision::text=rowdata->>'revision' AND p.target_id::text=rowdata->>'target_id'
 AND p.target_revision=t.revision AND t.active AND t.category_id::text=p.intent->'payload'->>'categoryId'
 AND content_envelope->'targetOrigin'->>'regionId' IS NOT DISTINCT FROM t.region_id::text
 AND content_envelope->>'authorMode'=rowdata->>'author_mode' AND content_envelope->>'body'=rowdata->>'body'
 AND rowdata->'deleted_at'='null'::jsonb AND rowdata->>'publication_transaction'=pg_current_xact_id()::text
 AND b.envelope=content_envelope AND b.subject_revision=p.subject_revision AND b.publication_transaction=pg_current_xact_id()
 AND whaleu_community.rating_discussion_media_content_current(kind,subject,p.subject_revision,content_envelope)
 AND EXISTS(SELECT 1 FROM whaleu_ratings.scoped_categories c WHERE c.catalog_id=(p.intent->'context'->>'catalogRevision')::uuid AND c.category_id=t.category_id AND c.effective_revision::text=p.intent->'payload'->>'expectedCategoryRevision'),false)
 THEN RAISE EXCEPTION 'Scoped content/review/preparation reverse mismatch' USING ERRCODE='23514';END IF;
 IF kind='reply' AND NOT coalesce(EXISTS(SELECT 1 FROM whaleu_ratings.comments c WHERE c.id=(rowdata->>'root_id')::uuid AND c.target_id=t.id AND c.deleted_at IS NULL AND c.revision::text=content_envelope->>'rootRevision' AND whaleu_community.rating_scoped_parent_review_current('comment',c.id,c.revision))
  AND content_envelope->>'rootId'=rowdata->>'root_id' AND ((rowdata->'reply_to_id'='null'::jsonb AND content_envelope->'replyTo'='null'::jsonb) OR EXISTS(SELECT 1 FROM whaleu_ratings.replies r WHERE r.id=(rowdata->>'reply_to_id')::uuid AND r.root_id=(rowdata->>'root_id')::uuid AND r.target_id=t.id AND r.deleted_at IS NULL AND content_envelope->'replyTo'=jsonb_build_object('replyId',r.id,'revision',r.revision) AND whaleu_community.rating_scoped_parent_review_current('reply',r.id,r.revision))),false)
 THEN RAISE EXCEPTION 'Scoped reply ancestry mismatch' USING ERRCODE='23514';END IF;
 PERFORM whaleu_ratings.scoped_domain_request(p.account_id,p.request_id);
END $$;

DO $$DECLARE definition text;BEGIN SELECT pg_get_functiondef('whaleu_ratings.verify_scoped_content(text,uuid)'::regprocedure) INTO definition; -- Preserve the implicit PL/pgSQL function block qualifier when copying the predecessor.
 IF position('verify_scoped_content.kind' IN definition)=0 THEN RAISE EXCEPTION 'Unexpected scoped content predecessor qualifier';END IF;
 definition:=replace(definition,'verify_scoped_content.kind','verify_scoped_content_pre_discussion_media.kind');
 EXECUTE replace(definition,'FUNCTION whaleu_ratings.verify_scoped_content(', 'FUNCTION whaleu_ratings.verify_scoped_content_pre_discussion_media(');END$$;

CREATE OR REPLACE FUNCTION whaleu_ratings.verify_scoped_content(kind text,subject uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM whaleu_ratings.comments WHERE kind='comment' AND id=subject AND envelope->'version'='7'::jsonb
 UNION ALL SELECT 1 FROM whaleu_ratings.replies WHERE kind='reply' AND id=subject AND envelope->'version'='7'::jsonb)
 THEN PERFORM whaleu_ratings.verify_discussion_media_content(kind,subject);
 ELSE PERFORM whaleu_ratings.verify_scoped_content_pre_discussion_media(kind,subject);END IF;
END$$;

CREATE OR REPLACE FUNCTION whaleu_ratings.require_review_binding() RETURNS trigger LANGUAGE plpgsql AS $dispatch$
BEGIN IF TG_TABLE_SCHEMA='whaleu_ratings' AND NEW.envelope->'version' IN ('5'::jsonb,'6'::jsonb,'7'::jsonb) THEN
BEGIN
 IF TG_TABLE_NAME='targets' THEN PERFORM whaleu_ratings.verify_scoped_target_initial(NEW.id);
 ELSE PERFORM whaleu_ratings.verify_scoped_content(CASE TG_TABLE_NAME WHEN 'replies' THEN 'reply' ELSE 'comment' END,NEW.id);END IF;
 RETURN NULL;END;
ELSE

DECLARE requested_kind text;subject uuid;definition jsonb;publication xid8;b whaleu_community.rating_approval_bindings;t whaleu_ratings.targets;c whaleu_ratings.comments;category whaleu_ratings.categories;r whaleu_ratings.replies;parent whaleu_ratings.comments;direct whaleu_ratings.replies;
BEGIN
 IF TG_TABLE_SCHEMA='whaleu_community' THEN requested_kind:=NEW.kind;subject:=NEW.subject_id;ELSE requested_kind:=CASE TG_TABLE_NAME WHEN 'targets' THEN 'target' WHEN 'replies' THEN 'reply' ELSE 'comment' END;subject:=NEW.id;END IF;
 IF requested_kind='target' THEN
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=subject;definition:=t.envelope;publication:=t.creation_transaction;
 IF NOT coalesce(t.id IS NOT NULL AND definition->>'accountId'=t.creator_id::text AND definition->>'purpose'='publish_rating_target' AND definition->>'targetId'=t.id::text AND definition->>'targetRevision'=t.revision::text AND definition->>'categoryId'=t.category_id::text AND definition->>'name'=t.name AND definition->>'description'=t.description AND (definition->'scope'->>'regionId') IS NOT DISTINCT FROM t.region_id::text,false) THEN RAISE EXCEPTION 'Target definition mismatch' USING ERRCODE='23514';END IF;
 ELSIF requested_kind='reply' THEN
 SELECT * INTO r FROM whaleu_ratings.replies WHERE id=subject;definition:=r.envelope;publication:=r.publication_transaction;
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=r.target_id;
 SELECT * INTO parent FROM whaleu_ratings.comments WHERE id=r.root_id AND target_id=r.target_id;
 IF NOT coalesce(r.id IS NOT NULL AND definition->>'accountId'=r.account_id::text AND definition->>'purpose'='publish_rating_reply' AND definition->>'targetId'=r.target_id::text AND definition->>'targetRevision'=t.revision::text AND definition->>'rootId'=r.root_id::text AND definition->>'rootRevision'=parent.revision::text AND parent.deleted_at IS NULL AND t.active AND definition->>'categoryId'=t.category_id::text AND definition->>'clientRequestId'=r.request_id::text AND definition->>'authorMode'=r.author_mode AND definition->>'body'=r.body,false) THEN RAISE EXCEPTION 'Reply definition mismatch' USING ERRCODE='23514';END IF;
 IF r.reply_to_id IS NULL THEN IF definition->'replyTo' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'Reply root binding mismatch' USING ERRCODE='23514';END IF;
 ELSE SELECT * INTO direct FROM whaleu_ratings.replies WHERE id=r.reply_to_id AND root_id=r.root_id AND target_id=r.target_id;
 IF direct.id IS NULL OR direct.deleted_at IS NOT NULL OR definition->'replyTo' IS DISTINCT FROM jsonb_build_object('replyId',direct.id,'revision',direct.revision) THEN RAISE EXCEPTION 'Reply direct binding mismatch' USING ERRCODE='23514';END IF;END IF;
 ELSE
 SELECT * INTO c FROM whaleu_ratings.comments WHERE id=subject;definition:=c.envelope;publication:=c.publication_transaction;SELECT * INTO t FROM whaleu_ratings.targets WHERE id=c.target_id;
 IF NOT coalesce(c.id IS NOT NULL AND definition->>'accountId'=c.account_id::text AND definition->>'purpose'='publish_rating_comment' AND definition->>'targetId'=c.target_id::text AND definition->>'targetRevision'=t.revision::text AND definition->>'categoryId'=t.category_id::text AND t.active AND definition->>'clientRequestId'=c.request_id::text AND definition->>'authorMode'=c.author_mode AND definition->>'body'=c.body,false) THEN RAISE EXCEPTION 'Comment definition mismatch' USING ERRCODE='23514';END IF;
 END IF;
 SELECT * INTO b FROM whaleu_community.rating_approval_bindings WHERE kind=requested_kind AND subject_id=subject;
 IF b.subject_id IS NULL OR b.envelope IS DISTINCT FROM definition OR b.publication_transaction IS DISTINCT FROM publication OR publication<>pg_current_xact_id() OR b.content_version<>1 OR definition->'assetIds' IS DISTINCT FROM '[]'::jsonb THEN RAISE EXCEPTION 'Exact same-transaction review binding required' USING ERRCODE='23514';END IF;
 SELECT * INTO category FROM whaleu_ratings.categories WHERE catalog_id=(definition->>'catalogRevision')::uuid AND id=(definition->>'categoryId')::uuid;
 IF category.id IS NULL OR category.revision::text<>definition->>'categoryRevision' THEN RAISE EXCEPTION 'Category review mismatch' USING ERRCODE='23514';END IF;RETURN NULL;
END;
END IF;END $dispatch$;

CREATE OR REPLACE FUNCTION whaleu_ratings.like_subject_guard() RETURNS trigger LANGUAGE plpgsql AS $discussion$
BEGIN IF EXISTS(SELECT 1 FROM whaleu_community.rating_discussion_media_bindings WHERE kind=NEW.kind AND subject_id=NEW.id) THEN

DECLARE c whaleu_ratings.comments;r whaleu_ratings.replies;ct whaleu_ratings.comment_transitions;rt whaleu_ratings.reply_transitions;b whaleu_community.rating_discussion_media_bindings;q whaleu_ratings.requests;a whaleu_ratings.like_activations;actor uuid;req uuid;created timestamptz;definition jsonb;revision uuid;
BEGIN
 IF NEW.creation_transaction<>pg_current_xact_id() THEN RAISE EXCEPTION 'Like baseline creation is not fresh' USING ERRCODE='23514';END IF;
 SELECT * INTO c FROM whaleu_ratings.comments WHERE id=NEW.root_id AND target_id=NEW.target_id;
 IF NEW.kind='comment' THEN SELECT * INTO ct FROM whaleu_ratings.comment_transitions WHERE id=NEW.comment_transition_id AND operation='create_comment';actor:=c.account_id;req:=c.request_id;created:=c.created_at;definition:=c.envelope;revision:=ct.revision;
 IF ct.id IS NULL OR (ct.comment_id,ct.target_id,ct.account_id,ct.request_id,ct.occurred_at,ct.mutation_transaction) IS DISTINCT FROM (c.id,c.target_id,c.account_id,c.request_id,c.created_at,c.publication_transaction) OR NEW.publication_transaction IS DISTINCT FROM c.publication_transaction THEN RAISE EXCEPTION 'Root like baseline publication mismatch' USING ERRCODE='23514';END IF;
 ELSE SELECT * INTO r FROM whaleu_ratings.replies WHERE id=NEW.reply_id AND root_id=NEW.root_id AND target_id=NEW.target_id;SELECT * INTO rt FROM whaleu_ratings.reply_transitions WHERE id=NEW.reply_transition_id AND operation='create_reply';actor:=r.account_id;req:=r.request_id;created:=r.created_at;definition:=r.envelope;revision:=rt.revision;
 IF rt.id IS NULL OR (rt.reply_id,rt.root_id,rt.target_id,rt.account_id,rt.request_id,rt.occurred_at,rt.mutation_transaction) IS DISTINCT FROM (r.id,r.root_id,r.target_id,r.account_id,r.request_id,r.created_at,r.publication_transaction) OR NEW.publication_transaction IS DISTINCT FROM r.publication_transaction THEN RAISE EXCEPTION 'Reply like baseline publication mismatch' USING ERRCODE='23514';END IF;END IF;
 SELECT * INTO b FROM whaleu_community.rating_discussion_media_bindings WHERE kind=NEW.kind AND subject_id=NEW.id;
 IF b.subject_id IS NULL OR (b.envelope,b.publication_transaction,b.content_version) IS DISTINCT FROM (definition,NEW.publication_transaction,1) THEN RAISE EXCEPTION 'Like baseline review provenance missing' USING ERRCODE='23514';END IF;
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=actor AND request_id=req;
 q:=whaleu_ratings.scoped_domain_request(q.account_id,q.request_id);
 IF q.operation IS DISTINCT FROM (CASE NEW.kind WHEN 'comment' THEN 'create_comment' ELSE 'create_reply' END) THEN RAISE EXCEPTION 'Like baseline request missing' USING ERRCODE='23514';END IF;
 IF NEW.provenance='native-publication' THEN
 IF NEW.publication_transaction<>pg_current_xact_id() OR NEW.baseline_at<>created OR q.receipt IS NOT NULL THEN RAISE EXCEPTION 'Old publication cannot claim fresh baseline' USING ERRCODE='23514';END IF;
 ELSE SELECT * INTO a FROM whaleu_ratings.like_activations WHERE id=NEW.activation_id;
 IF a.activation_transaction IS DISTINCT FROM pg_current_xact_id() OR NEW.baseline_at IS DISTINCT FROM a.activated_at OR created>a.activated_at OR q.receipt->>'outcome' IS DISTINCT FROM 'applied' OR q.receipt->>'revision' IS DISTINCT FROM revision::text OR (q.receipt->>'occurredAt')::timestamptz IS DISTINCT FROM created OR q.receipt->>'targetId' IS DISTINCT FROM NEW.target_id::text OR coalesce(q.receipt->>'subjectId',q.receipt->>'replyId') IS DISTINCT FROM NEW.id::text THEN RAISE EXCEPTION 'Like cutover publication receipt mismatch' USING ERRCODE='23514';END IF;END IF;
 RETURN NEW;
END;
ELSE
BEGIN
 IF EXISTS(SELECT 1 FROM whaleu_community.rating_scoped_content_bindings WHERE kind=NEW.kind AND subject_id=NEW.id) THEN

DECLARE c whaleu_ratings.comments;r whaleu_ratings.replies;ct whaleu_ratings.comment_transitions;rt whaleu_ratings.reply_transitions;b whaleu_community.rating_scoped_content_bindings;q whaleu_ratings.requests;a whaleu_ratings.like_activations;actor uuid;req uuid;created timestamptz;definition jsonb;revision uuid;
BEGIN
 IF NEW.creation_transaction<>pg_current_xact_id() THEN RAISE EXCEPTION 'Like baseline creation is not fresh' USING ERRCODE='23514';END IF;
 SELECT * INTO c FROM whaleu_ratings.comments WHERE id=NEW.root_id AND target_id=NEW.target_id;
 IF NEW.kind='comment' THEN SELECT * INTO ct FROM whaleu_ratings.comment_transitions WHERE id=NEW.comment_transition_id AND operation='create_comment';actor:=c.account_id;req:=c.request_id;created:=c.created_at;definition:=c.envelope;revision:=ct.revision;
 IF ct.id IS NULL OR (ct.comment_id,ct.target_id,ct.account_id,ct.request_id,ct.occurred_at,ct.mutation_transaction) IS DISTINCT FROM (c.id,c.target_id,c.account_id,c.request_id,c.created_at,c.publication_transaction) OR NEW.publication_transaction IS DISTINCT FROM c.publication_transaction THEN RAISE EXCEPTION 'Root like baseline publication mismatch' USING ERRCODE='23514';END IF;
 ELSE SELECT * INTO r FROM whaleu_ratings.replies WHERE id=NEW.reply_id AND root_id=NEW.root_id AND target_id=NEW.target_id;SELECT * INTO rt FROM whaleu_ratings.reply_transitions WHERE id=NEW.reply_transition_id AND operation='create_reply';actor:=r.account_id;req:=r.request_id;created:=r.created_at;definition:=r.envelope;revision:=rt.revision;
 IF rt.id IS NULL OR (rt.reply_id,rt.root_id,rt.target_id,rt.account_id,rt.request_id,rt.occurred_at,rt.mutation_transaction) IS DISTINCT FROM (r.id,r.root_id,r.target_id,r.account_id,r.request_id,r.created_at,r.publication_transaction) OR NEW.publication_transaction IS DISTINCT FROM r.publication_transaction THEN RAISE EXCEPTION 'Reply like baseline publication mismatch' USING ERRCODE='23514';END IF;END IF;
 SELECT * INTO b FROM whaleu_community.rating_scoped_content_bindings WHERE kind=NEW.kind AND subject_id=NEW.id;
 IF b.subject_id IS NULL OR (b.envelope,b.publication_transaction,b.content_version) IS DISTINCT FROM (definition,NEW.publication_transaction,1) THEN RAISE EXCEPTION 'Like baseline review provenance missing' USING ERRCODE='23514';END IF;
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=actor AND request_id=req;
 q:=whaleu_ratings.scoped_domain_request(q.account_id,q.request_id);
 IF q.operation IS DISTINCT FROM (CASE NEW.kind WHEN 'comment' THEN 'create_comment' ELSE 'create_reply' END) THEN RAISE EXCEPTION 'Like baseline request missing' USING ERRCODE='23514';END IF;
 IF NEW.provenance='native-publication' THEN
 IF NEW.publication_transaction<>pg_current_xact_id() OR NEW.baseline_at<>created OR q.receipt IS NOT NULL THEN RAISE EXCEPTION 'Old publication cannot claim fresh baseline' USING ERRCODE='23514';END IF;
 ELSE SELECT * INTO a FROM whaleu_ratings.like_activations WHERE id=NEW.activation_id;
 IF a.activation_transaction IS DISTINCT FROM pg_current_xact_id() OR NEW.baseline_at IS DISTINCT FROM a.activated_at OR created>a.activated_at OR q.receipt->>'outcome' IS DISTINCT FROM 'applied' OR q.receipt->>'revision' IS DISTINCT FROM revision::text OR (q.receipt->>'occurredAt')::timestamptz IS DISTINCT FROM created OR q.receipt->>'targetId' IS DISTINCT FROM NEW.target_id::text OR coalesce(q.receipt->>'subjectId',q.receipt->>'replyId') IS DISTINCT FROM NEW.id::text THEN RAISE EXCEPTION 'Like cutover publication receipt mismatch' USING ERRCODE='23514';END IF;END IF;
 RETURN NEW;
END;
 ELSE

DECLARE c whaleu_ratings.comments;r whaleu_ratings.replies;ct whaleu_ratings.comment_transitions;rt whaleu_ratings.reply_transitions;b whaleu_community.rating_approval_bindings;q whaleu_ratings.requests;a whaleu_ratings.like_activations;actor uuid;req uuid;created timestamptz;definition jsonb;revision uuid;
BEGIN
 IF NEW.creation_transaction<>pg_current_xact_id() THEN RAISE EXCEPTION 'Like baseline creation is not fresh' USING ERRCODE='23514';END IF;
 SELECT * INTO c FROM whaleu_ratings.comments WHERE id=NEW.root_id AND target_id=NEW.target_id;
 IF NEW.kind='comment' THEN SELECT * INTO ct FROM whaleu_ratings.comment_transitions WHERE id=NEW.comment_transition_id AND operation='create_comment';actor:=c.account_id;req:=c.request_id;created:=c.created_at;definition:=c.envelope;revision:=ct.revision;
 IF ct.id IS NULL OR (ct.comment_id,ct.target_id,ct.account_id,ct.request_id,ct.occurred_at,ct.mutation_transaction) IS DISTINCT FROM (c.id,c.target_id,c.account_id,c.request_id,c.created_at,c.publication_transaction) OR NEW.publication_transaction IS DISTINCT FROM c.publication_transaction THEN RAISE EXCEPTION 'Root like baseline publication mismatch' USING ERRCODE='23514';END IF;
 ELSE SELECT * INTO r FROM whaleu_ratings.replies WHERE id=NEW.reply_id AND root_id=NEW.root_id AND target_id=NEW.target_id;SELECT * INTO rt FROM whaleu_ratings.reply_transitions WHERE id=NEW.reply_transition_id AND operation='create_reply';actor:=r.account_id;req:=r.request_id;created:=r.created_at;definition:=r.envelope;revision:=rt.revision;
 IF rt.id IS NULL OR (rt.reply_id,rt.root_id,rt.target_id,rt.account_id,rt.request_id,rt.occurred_at,rt.mutation_transaction) IS DISTINCT FROM (r.id,r.root_id,r.target_id,r.account_id,r.request_id,r.created_at,r.publication_transaction) OR NEW.publication_transaction IS DISTINCT FROM r.publication_transaction THEN RAISE EXCEPTION 'Reply like baseline publication mismatch' USING ERRCODE='23514';END IF;END IF;
 SELECT * INTO b FROM whaleu_community.rating_approval_bindings WHERE kind=NEW.kind AND subject_id=NEW.id;
 IF b.subject_id IS NULL OR (b.envelope,b.publication_transaction,b.content_version) IS DISTINCT FROM (definition,NEW.publication_transaction,1) THEN RAISE EXCEPTION 'Like baseline review provenance missing' USING ERRCODE='23514';END IF;
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=actor AND request_id=req;
 IF q.operation IS DISTINCT FROM (CASE NEW.kind WHEN 'comment' THEN 'create_comment' ELSE 'create_reply' END) THEN RAISE EXCEPTION 'Like baseline request missing' USING ERRCODE='23514';END IF;
 IF NEW.provenance='native-publication' THEN
 IF NEW.publication_transaction<>pg_current_xact_id() OR NEW.baseline_at<>created OR q.receipt IS NOT NULL THEN RAISE EXCEPTION 'Old publication cannot claim fresh baseline' USING ERRCODE='23514';END IF;
 ELSE SELECT * INTO a FROM whaleu_ratings.like_activations WHERE id=NEW.activation_id;
 IF a.activation_transaction IS DISTINCT FROM pg_current_xact_id() OR NEW.baseline_at IS DISTINCT FROM a.activated_at OR created>a.activated_at OR q.receipt->>'outcome' IS DISTINCT FROM 'applied' OR q.receipt->>'revision' IS DISTINCT FROM revision::text OR (q.receipt->>'occurredAt')::timestamptz IS DISTINCT FROM created OR q.receipt->>'targetId' IS DISTINCT FROM NEW.target_id::text OR coalesce(q.receipt->>'subjectId',q.receipt->>'replyId') IS DISTINCT FROM NEW.id::text THEN RAISE EXCEPTION 'Like cutover publication receipt mismatch' USING ERRCODE='23514';END IF;END IF;
 RETURN NEW;
END;
 END IF;
END;
END IF;END $discussion$;

CREATE OR REPLACE FUNCTION whaleu_ratings.like_subject_complete() RETURNS trigger LANGUAGE plpgsql AS $discussion$
BEGIN IF EXISTS(SELECT 1 FROM whaleu_community.rating_discussion_media_bindings WHERE kind=NEW.kind AND subject_id=NEW.id) THEN

DECLARE q whaleu_ratings.requests;req uuid;actor uuid;created timestamptz;revision uuid;
BEGIN
 IF NEW.kind='comment' THEN SELECT account_id,request_id,occurred_at,t.revision INTO actor,req,created,revision FROM whaleu_ratings.comment_transitions t WHERE id=NEW.comment_transition_id;
 ELSE SELECT account_id,request_id,occurred_at,t.revision INTO actor,req,created,revision FROM whaleu_ratings.reply_transitions t WHERE id=NEW.reply_transition_id;END IF;
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=actor AND request_id=req;
 q:=whaleu_ratings.scoped_domain_request(q.account_id,q.request_id);
 IF q.receipt->>'outcome' IS DISTINCT FROM 'applied' OR q.receipt->>'revision' IS DISTINCT FROM revision::text OR (q.receipt->>'occurredAt')::timestamptz IS DISTINCT FROM created OR coalesce(q.receipt->>'subjectId',q.receipt->>'replyId') IS DISTINCT FROM NEW.id::text OR NOT EXISTS(SELECT 1 FROM whaleu_ratings.like_states WHERE subject_id=NEW.id) THEN RAISE EXCEPTION 'Native like baseline receipt incomplete' USING ERRCODE='23514';END IF;RETURN NULL;
END;
ELSE
BEGIN
 IF EXISTS(SELECT 1 FROM whaleu_community.rating_scoped_content_bindings WHERE kind=NEW.kind AND subject_id=NEW.id) THEN

DECLARE q whaleu_ratings.requests;req uuid;actor uuid;created timestamptz;revision uuid;
BEGIN
 IF NEW.kind='comment' THEN SELECT account_id,request_id,occurred_at,t.revision INTO actor,req,created,revision FROM whaleu_ratings.comment_transitions t WHERE id=NEW.comment_transition_id;
 ELSE SELECT account_id,request_id,occurred_at,t.revision INTO actor,req,created,revision FROM whaleu_ratings.reply_transitions t WHERE id=NEW.reply_transition_id;END IF;
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=actor AND request_id=req;
 q:=whaleu_ratings.scoped_domain_request(q.account_id,q.request_id);
 IF q.receipt->>'outcome' IS DISTINCT FROM 'applied' OR q.receipt->>'revision' IS DISTINCT FROM revision::text OR (q.receipt->>'occurredAt')::timestamptz IS DISTINCT FROM created OR coalesce(q.receipt->>'subjectId',q.receipt->>'replyId') IS DISTINCT FROM NEW.id::text OR NOT EXISTS(SELECT 1 FROM whaleu_ratings.like_states WHERE subject_id=NEW.id) THEN RAISE EXCEPTION 'Native like baseline receipt incomplete' USING ERRCODE='23514';END IF;RETURN NULL;
END;
 ELSE

DECLARE q whaleu_ratings.requests;req uuid;actor uuid;created timestamptz;revision uuid;
BEGIN
 IF NEW.kind='comment' THEN SELECT account_id,request_id,occurred_at,t.revision INTO actor,req,created,revision FROM whaleu_ratings.comment_transitions t WHERE id=NEW.comment_transition_id;
 ELSE SELECT account_id,request_id,occurred_at,t.revision INTO actor,req,created,revision FROM whaleu_ratings.reply_transitions t WHERE id=NEW.reply_transition_id;END IF;
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=actor AND request_id=req;
 IF q.receipt->>'outcome' IS DISTINCT FROM 'applied' OR q.receipt->>'revision' IS DISTINCT FROM revision::text OR (q.receipt->>'occurredAt')::timestamptz IS DISTINCT FROM created OR coalesce(q.receipt->>'subjectId',q.receipt->>'replyId') IS DISTINCT FROM NEW.id::text OR NOT EXISTS(SELECT 1 FROM whaleu_ratings.like_states WHERE subject_id=NEW.id) THEN RAISE EXCEPTION 'Native like baseline receipt incomplete' USING ERRCODE='23514';END IF;RETURN NULL;
END;
 END IF;
END;
END IF;END $discussion$;

CREATE TRIGGER discussion_media_like_enrollment AFTER INSERT ON whaleu_community.rating_discussion_media_bindings FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.enroll_native_like_subject();
CREATE TRIGGER discussion_media_review_validate BEFORE INSERT ON whaleu_community.rating_discussion_media_bindings FOR EACH ROW EXECUTE FUNCTION whaleu_community.rating_discussion_media_binding_validate();
CREATE TRIGGER discussion_media_review_immutable BEFORE UPDATE OR DELETE ON whaleu_community.rating_discussion_media_bindings FOR EACH ROW EXECUTE FUNCTION whaleu_community.content_approval_immutable();
CREATE TRIGGER discussion_media_review_retain BEFORE TRUNCATE ON whaleu_community.rating_discussion_media_bindings FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_approval_immutable();
CREATE TRIGGER a00_discussion_media_review_writer BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.rating_discussion_media_bindings FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.target_edit_writer();
CREATE TRIGGER a01_discussion_media_review_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.rating_discussion_media_bindings FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.advance_rating_review_binding_epoch();
CREATE TRIGGER a02_discussion_media_review_navigation BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.rating_discussion_media_bindings FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.advance_navigation_epoch();
CREATE FUNCTION whaleu_ratings.discussion_media_review_causal() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 PERFORM whaleu_ratings.verify_discussion_media_content(NEW.kind,NEW.subject_id);RETURN NULL;END$$;
CREATE CONSTRAINT TRIGGER discussion_media_review_causal AFTER INSERT ON whaleu_community.rating_discussion_media_bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.discussion_media_review_causal();
DO $$DECLARE c record;tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['comments','replies'] LOOP
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid=('whaleu_ratings.'||tab)::regclass AND contype='c' AND (pg_get_constraintdef(oid) LIKE '%length(btrim(body))%' OR pg_get_constraintdef(oid) LIKE '%canonical_text(body,%') LOOP
 EXECUTE format('ALTER TABLE whaleu_ratings.%I DROP CONSTRAINT %I',tab,c.conname);END LOOP;
 EXECUTE format('ALTER TABLE whaleu_ratings.%I ADD CONSTRAINT discussion_media_body CHECK(whaleu_ratings.canonical_text(body,500) OR (body='''' AND envelope->''version''=''7''::jsonb AND whaleu_community.rating_discussion_media_envelope_shape(envelope,envelope->>''purpose'') AND jsonb_array_length(envelope->''images'') BETWEEN 1 AND %s)) NOT VALID',tab,CASE tab WHEN 'comments' THEN 9 ELSE 3 END);
 END LOOP;END$$;

CREATE FUNCTION whaleu_ratings.discussion_media_preparation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c whaleu_ratings.scoped_contexts;b whaleu_media.ratings_discussion_batches;h whaleu_ratings.target_definition_heads;images jsonb;expected_identity jsonb;BEGIN
 IF NEW.intent->'protocolVersion'<>'4'::jsonb THEN RETURN NEW;END IF;
 SELECT * INTO c FROM whaleu_ratings.scoped_contexts WHERE id=NEW.context_id;
 SELECT * INTO h FROM whaleu_ratings.target_definition_heads WHERE target_id=NEW.target_id;
 IF NOT coalesce(whaleu_ratings.discussion_media_context_current(c.id,clock_timestamp()) AND c.context->'discussionMedia'=NEW.intent->'context'->'discussionMedia'
 AND NEW.valid_until<=c.valid_until AND NEW.valid_until<=(c.context->'discussionMedia'->>'validUntil')::timestamptz
 AND (h.definition_revision::text,h.content_version)=(NEW.intent->'payload'->>'expectedDefinitionRevision',(NEW.intent->'payload'->>'expectedContentVersion')::integer)
 AND NEW.definition_revision=h.definition_revision AND NEW.content_version=h.content_version
 AND EXISTS(SELECT 1 FROM whaleu_ratings.scoped_categories leaf WHERE leaf.catalog_id=(NEW.intent->'context'->>'catalogRevision')::uuid AND leaf.category_id=(NEW.intent->'payload'->>'categoryId')::uuid AND leaf.kind='general')
 AND whaleu_community.rating_discussion_media_envelope_shape(NEW.envelope,NEW.envelope->>'purpose'),false)
 THEN RAISE EXCEPTION 'Discussion preparation requires exact adopted context and current definition' USING ERRCODE='23514';END IF;
 images:=NEW.envelope->'images';
 IF jsonb_array_length(images)=0 THEN RETURN NEW;END IF;
 SELECT * INTO b FROM whaleu_media.ratings_discussion_batches WHERE id=(NEW.intent->'payload'->>'batchId')::uuid;
 expected_identity:=jsonb_build_object('protocol','ratings-discussion-media-v1','batchRequestId',NEW.intent->'payload'->'batchRequestId','commandRequestId',NEW.request_id,
 'draftRevision',NEW.intent->'payload'->'draftRevision','categoryId',NEW.intent->'payload'->'categoryId','expectedCategoryRevision',NEW.intent->'payload'->'expectedCategoryRevision','context',NEW.intent->'context',
 'target',jsonb_build_object('kind',CASE NEW.operation WHEN 'create_comment_scoped' THEN 'root' ELSE 'reply' END,'targetId',NEW.target_id,'expectedTargetRevision',NEW.intent->'payload'->'expectedTargetRevision',
 'expectedDefinitionRevision',NEW.intent->'payload'->'expectedDefinitionRevision','expectedContentVersion',NEW.intent->'payload'->'expectedContentVersion')||
 CASE WHEN NEW.operation='create_reply_scoped' THEN jsonb_build_object('rootId',NEW.intent->'payload'->'rootId','expectedRootRevision',NEW.intent->'payload'->'expectedRootRevision','replyTo',NEW.intent->'payload'->'replyTo') ELSE '{}'::jsonb END);
 IF NOT coalesce(b.actor_id=NEW.account_id AND b.state='sealed' AND b.identity=expected_identity AND b.command_request_id=NEW.request_id
 AND b.expires_at>clock_timestamp() AND b.sealed_plan_digest=NEW.intent->'payload'->>'sealedPlanDigest'
 AND b.sealed_plan->'orderedMembers'=images AND b.sealed_plan->>'batchIdentityHash'=b.identity_hash
 AND NEW.before_state->'resolvedDiscussionImages'=images
 AND (SELECT jsonb_agg(x-'manifestDigest' ORDER BY (x->>'ordinal')::integer) FROM jsonb_array_elements(images) x)=NEW.intent->'payload'->'images',false)
 THEN RAISE EXCEPTION 'Discussion preparation differs from exact sealed batch' USING ERRCODE='23514';END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER discussion_media_preparation_guard BEFORE INSERT ON whaleu_ratings.scoped_command_preparations FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.discussion_media_preparation_guard();

CREATE FUNCTION whaleu_ratings.discussion_media_publication_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p whaleu_ratings.scoped_command_preparations;b whaleu_media.ratings_discussion_batches;parent jsonb;BEGIN
 IF TG_TABLE_SCHEMA='whaleu_media' THEN
  IF NEW.state<>'consumed' THEN RETURN NULL;END IF;
  SELECT * INTO p FROM whaleu_ratings.scoped_command_preparations WHERE account_id=NEW.actor_id AND request_id=NEW.command_request_id;
 ELSE
  SELECT * INTO p FROM whaleu_ratings.scoped_command_preparations WHERE account_id=NEW.account_id AND request_id=NEW.request_id;
  IF p.intent->'protocolVersion' IS DISTINCT FROM '4'::jsonb OR NEW.outcome='closed' THEN RETURN NULL;END IF;
 END IF;
 IF NOT coalesce(p.intent->'protocolVersion'='4'::jsonb AND whaleu_ratings.discussion_media_context_current(p.context_id,clock_timestamp())
 AND whaleu_ratings.scoped_context_current(p.context_id,p.account_id,p.session_id,clock_timestamp()) AND p.envelope=whaleu_ratings.scoped_preparation_envelope(p)
 AND EXISTS(SELECT 1 FROM whaleu_ratings.scoped_command_outcomes o WHERE o.account_id=p.account_id AND o.request_id=p.request_id AND o.outcome='applied' AND o.intent=p.intent AND o.mutation_transaction=pg_current_xact_id()),false)
 THEN RAISE EXCEPTION 'Discussion publication has no exact original applied command' USING ERRCODE='23514';END IF;
 IF jsonb_array_length(p.envelope->'images')=0 THEN
  IF EXISTS(SELECT 1 FROM whaleu_media.bindings WHERE owner_kind='ratings' AND resource_kind IN ('rating_comment','rating_reply') AND resource_id=p.subject_id) THEN RAISE EXCEPTION 'Text-only discussion cannot hide media' USING ERRCODE='23514';END IF;
  RETURN NULL;
 END IF;
 SELECT * INTO b FROM whaleu_media.ratings_discussion_batches WHERE id=(p.envelope->>'batchId')::uuid;
 parent:=jsonb_build_object('ownerKind','ratings','resourceKind',CASE p.operation WHEN 'create_comment_scoped' THEN 'rating_comment' ELSE 'rating_reply' END,
 'targetId',p.target_id,'resourceId',p.subject_id,'contentVersion',1)||CASE p.operation WHEN 'create_reply_scoped' THEN jsonb_build_object('rootId',p.intent->'payload'->'rootId') ELSE '{}'::jsonb END;
 IF NOT coalesce(b.actor_id=p.account_id AND b.command_request_id=p.request_id AND b.state='consumed' AND b.consumed_parent=parent AND b.sealed_plan_digest=p.envelope->>'sealedPlanDigest'
 AND b.sealed_plan->'orderedMembers'=p.envelope->'images' AND whaleu_ratings.discussion_media_set_current(p.envelope,clock_timestamp())
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.envelope->'images') image WHERE NOT EXISTS(
 SELECT 1 FROM whaleu_media.bindings binding JOIN whaleu_media.ratings_discussion_members m ON m.member_id=(image->>'memberId')::uuid AND m.batch_id=b.id
 JOIN whaleu_media.assets a ON a.id=binding.asset_id AND a.intent_id=m.intent_id
 WHERE binding.owner_kind='ratings' AND binding.resource_kind=parent->>'resourceKind' AND binding.resource_id=p.subject_id AND binding.slot='images' AND binding.content_version=1
 AND binding.ordinal=(image->>'ordinal')::integer AND binding.asset_id=(image->>'assetId')::uuid AND binding.manifest_digest=image->>'manifestDigest' AND binding.detached_at IS NULL
 AND m.state='bound' AND a.resource_id=b.server_scope_id AND a.scope_revision=b.scope_revision AND a.ordinal=m.source_slot
 AND binding.attach_evidence=jsonb_build_object('version',7,'batchId',b.id,'memberId',m.member_id,'sourceSlot',m.source_slot,'sealedPlanDigest',b.sealed_plan_digest,'scopeId',b.server_scope_id,'scopeRevision',b.scope_revision))),false)
 THEN RAISE EXCEPTION 'Discussion publication must consume the complete exact set' USING ERRCODE='23514';END IF;
 PERFORM whaleu_ratings.verify_discussion_media_content(CASE p.operation WHEN 'create_comment_scoped' THEN 'comment' ELSE 'reply' END,p.subject_id);
 RETURN NULL;
END$$;
CREATE CONSTRAINT TRIGGER discussion_media_publication_complete AFTER INSERT ON whaleu_ratings.scoped_command_outcomes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.discussion_media_publication_complete();
CREATE CONSTRAINT TRIGGER discussion_media_batch_publication_complete AFTER INSERT OR UPDATE ON whaleu_media.ratings_discussion_batches DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.discussion_media_publication_complete();

-- All three request identities share original Ratings claims. The command hash
-- is reserved only by the original publication owner after its exact set freezes.
CREATE FUNCTION whaleu_ratings.discussion_media_request_namespace() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor uuid;request uuid;op text;hash text;BEGIN
 IF TG_TABLE_SCHEMA='whaleu_media' AND TG_TABLE_NAME='ratings_discussion_batches' THEN
  actor:=NEW.actor_id;request:=NEW.batch_request_id;op:='prepare_discussion_media_batch';hash:=NEW.identity_hash;
  IF NEW.command_request_id=NEW.batch_request_id OR EXISTS(SELECT 1 FROM whaleu_ratings.command_claims WHERE account_id=actor AND request_id=NEW.command_request_id)
   OR EXISTS(SELECT 1 FROM whaleu_media.ratings_discussion_batches WHERE actor_id=actor AND command_request_id=NEW.command_request_id)
  THEN RAISE EXCEPTION 'Discussion batch command key already claimed' USING ERRCODE='23514';END IF;
 ELSIF TG_TABLE_SCHEMA='whaleu_media' THEN
  actor:=NEW.actor_id;request:=NEW.client_request_id;op:='prepare_discussion_media_member';
  SELECT request_hash INTO hash FROM whaleu_media.upload_intents WHERE id=NEW.intent_id;
 ELSE
  actor:=NEW.account_id;request:=NEW.request_id;
  IF EXISTS(SELECT 1 FROM whaleu_media.ratings_discussion_batches WHERE actor_id=actor AND batch_request_id=request)
   OR EXISTS(SELECT 1 FROM whaleu_media.ratings_discussion_members WHERE actor_id=actor AND client_request_id=request)
  THEN RAISE EXCEPTION 'Original command conflicts with discussion media key' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.command_claims WHERE account_id=actor AND request_id=request AND operation=op AND intent_hash=hash)
 THEN RAISE EXCEPTION 'Discussion media lacks original exact request claim' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM whaleu_media.ratings_discussion_batches WHERE actor_id=actor AND command_request_id=request)
 THEN RAISE EXCEPTION 'Media request cannot use a publication command key' USING ERRCODE='23514';END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER discussion_media_batch_namespace BEFORE INSERT ON whaleu_media.ratings_discussion_batches FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.discussion_media_request_namespace();
CREATE TRIGGER discussion_media_member_namespace BEFORE INSERT ON whaleu_media.ratings_discussion_members FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.discussion_media_request_namespace();
CREATE TRIGGER discussion_media_command_namespace BEFORE INSERT ON whaleu_ratings.requests FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.discussion_media_request_namespace();
CREATE TRIGGER discussion_media_preparation_namespace BEFORE INSERT ON whaleu_ratings.scoped_command_preparations FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.discussion_media_request_namespace();

-- A scrubbed journal can close its original command with only the immutable
-- operation/hash. This is a cancellation cause, never a publication owner.
CREATE TABLE whaleu_ratings.discussion_command_recovery_fences(
 account_id uuid NOT NULL,request_id uuid NOT NULL,operation text NOT NULL CHECK(operation IN ('create_comment_scoped','create_reply_scoped')),
 intent_hash text NOT NULL CHECK(intent_hash ~ '^[a-f0-9]{64}$'),session_id uuid NOT NULL REFERENCES whaleu_identity.sessions(id),
 mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(account_id,request_id),FOREIGN KEY(account_id,request_id) REFERENCES whaleu_ratings.requests(account_id,request_id)
);
CREATE FUNCTION whaleu_ratings.verify_discussion_recovery_fence(actor uuid,request uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE f whaleu_ratings.discussion_command_recovery_fences;q whaleu_ratings.requests;BEGIN
 SELECT * INTO f FROM whaleu_ratings.discussion_command_recovery_fences WHERE account_id=actor AND request_id=request;
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=actor AND request_id=request;
 IF NOT coalesce(f.mutation_transaction=pg_current_xact_id() AND (f.operation,f.intent_hash)=(q.operation,q.intent_hash)
 AND whaleu_ratings.target_edit_session_current(actor,f.session_id,clock_timestamp())
 AND EXISTS(SELECT 1 FROM whaleu_ratings.command_claims c WHERE c.account_id=actor AND c.request_id=request AND (c.operation,c.intent_hash)=(f.operation,f.intent_hash))
 AND q.receipt=jsonb_build_object('protocolVersion',4,'requestId',request,'operation',f.operation,'intentHash',f.intent_hash,'outcome','closed','code','RATING_CREATION_CANCELLED'),false)
 OR EXISTS(SELECT 1 FROM whaleu_ratings.scoped_command_preparations p WHERE p.account_id=actor AND p.request_id=request AND
 (p.intent->'protocolVersion'<>'4'::jsonb OR (p.operation,p.intent_hash) IS DISTINCT FROM (f.operation,f.intent_hash)))
 OR EXISTS(SELECT 1 FROM whaleu_ratings.scoped_command_outcomes WHERE account_id=actor AND request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_ratings.scoped_command_causes WHERE account_id=actor AND request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_ratings.effect_events WHERE actor_account_id=actor AND request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_ratings.score_transitions WHERE account_id=actor AND request_id=request
 UNION ALL SELECT 1 FROM whaleu_ratings.comment_transitions WHERE account_id=actor AND request_id=request
 UNION ALL SELECT 1 FROM whaleu_ratings.reply_transitions WHERE account_id=actor AND request_id=request
 UNION ALL SELECT 1 FROM whaleu_ratings.like_transitions WHERE account_id=actor AND request_id=request
 UNION ALL SELECT 1 FROM whaleu_ratings.subscription_transitions WHERE account_id=actor AND request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_community.rating_discussion_media_bindings b WHERE b.account_id=actor AND b.envelope->>'clientRequestId'=request::text)
 OR EXISTS(SELECT 1 FROM whaleu_media.ratings_discussion_batches b WHERE b.actor_id=actor AND b.command_request_id=request AND b.state='consumed')
 THEN RAISE EXCEPTION 'Discussion hash cancellation must be an exact fresh original-owner closure without publication' USING ERRCODE='23514';END IF;
END$$;
CREATE FUNCTION whaleu_ratings.discussion_recovery_fence_complete() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 PERFORM whaleu_ratings.verify_discussion_recovery_fence(NEW.account_id,NEW.request_id);RETURN NULL;
END$$;
CREATE CONSTRAINT TRIGGER discussion_recovery_fence_complete AFTER INSERT ON whaleu_ratings.discussion_command_recovery_fences DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.discussion_recovery_fence_complete();
CREATE TRIGGER discussion_recovery_fence_immutable BEFORE UPDATE OR DELETE ON whaleu_ratings.discussion_command_recovery_fences FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.immutable();
CREATE TRIGGER discussion_recovery_fence_retain BEFORE TRUNCATE ON whaleu_ratings.discussion_command_recovery_fences FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.immutable();
CREATE TRIGGER a00_discussion_recovery_fence_writer BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_ratings.discussion_command_recovery_fences FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.target_edit_writer();
CREATE TRIGGER a01_discussion_recovery_fence_navigation BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_ratings.discussion_command_recovery_fences FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.advance_navigation_epoch();

CREATE OR REPLACE FUNCTION whaleu_ratings.verify_scoped_command(actor uuid,request uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE q whaleu_ratings.requests;p whaleu_ratings.scoped_command_preparations;o whaleu_ratings.scoped_command_outcomes;cause whaleu_ratings.scoped_command_causes;expected jsonb;n integer;t whaleu_ratings.targets;
BEGIN
 IF EXISTS(SELECT 1 FROM whaleu_ratings.discussion_command_recovery_fences WHERE account_id=actor AND request_id=request) THEN PERFORM whaleu_ratings.verify_discussion_recovery_fence(actor,request);RETURN;END IF;
 IF EXISTS(SELECT 1 FROM whaleu_ratings.requests WHERE account_id=actor AND request_id=request AND whaleu_ratings.category_management_operation(operation)) THEN PERFORM whaleu_ratings.verify_category_management_command(actor,request);RETURN;END IF;

 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=actor AND request_id=request;
 SELECT * INTO o FROM whaleu_ratings.scoped_command_outcomes WHERE account_id=actor AND request_id=request;
 IF NOT coalesce(whaleu_ratings.rating_scoped_operation_rule(q.operation,2) IS NOT NULL AND o.operation=q.operation AND o.intent_hash=q.intent_hash AND o.mutation_transaction=pg_current_xact_id(),false)
 THEN RAISE EXCEPTION 'Scoped outcome is absent or not exact' USING ERRCODE='23514';END IF;
 expected:=jsonb_build_object('protocolVersion',o.intent->'protocolVersion','requestId',request,'operation',q.operation,'intentHash',q.intent_hash,'outcome',o.outcome)||CASE WHEN o.outcome='closed' THEN jsonb_build_object('code',o.code) ELSE jsonb_build_object('result',o.result) END;
 IF q.receipt IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Scoped receipt bytes differ from immutable outcome' USING ERRCODE='23514';END IF;
 SELECT count(*) INTO n FROM (SELECT id FROM whaleu_ratings.score_transitions WHERE account_id=actor AND request_id=request UNION ALL SELECT id FROM whaleu_ratings.comment_transitions WHERE account_id=actor AND request_id=request UNION ALL SELECT id FROM whaleu_ratings.reply_transitions WHERE account_id=actor AND request_id=request UNION ALL SELECT id FROM whaleu_ratings.like_transitions WHERE account_id=actor AND request_id=request UNION ALL SELECT id FROM whaleu_ratings.subscription_transitions WHERE account_id=actor AND request_id=request) mutations;
 IF o.outcome='closed' THEN
  IF n<>0 OR EXISTS(SELECT 1 FROM whaleu_ratings.scoped_command_causes WHERE account_id=actor AND request_id=request)
   OR EXISTS(SELECT 1 FROM whaleu_ratings.effect_events WHERE actor_account_id=actor AND request_id=request)
   OR (o.code='RATING_CREATION_CANCELLED' AND q.operation<>'create_target_scoped' AND NOT (o.intent->'protocolVersion'='4'::jsonb AND q.operation IN ('create_comment_scoped','create_reply_scoped'))) OR (o.code='RATING_EDIT_CANCELLED' AND q.operation<>'edit_target_scoped')
  THEN RAISE EXCEPTION 'Scoped closure cannot hide a mutation' USING ERRCODE='23514';END IF;RETURN;
 END IF;
 SELECT * INTO p FROM whaleu_ratings.scoped_command_preparations WHERE account_id=actor AND request_id=request;
 PERFORM whaleu_ratings.scoped_domain_request(actor,request);
 IF NOT whaleu_ratings.scoped_command_parents_current(p) OR p.intent IS DISTINCT FROM o.intent OR p.envelope IS DISTINCT FROM whaleu_ratings.scoped_preparation_envelope(p) OR p.valid_until<=clock_timestamp() OR p.before_state IS NULL
 OR NOT whaleu_ratings.target_edit_session_current(actor,p.session_id,clock_timestamp()) OR o.result->>'targetId' IS DISTINCT FROM p.target_id::text
 OR NOT coalesce(o.result->>'occurredAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$',false)
 THEN RAISE EXCEPTION 'Scoped success preparation/session mismatch' USING ERRCODE='23514';END IF;
 IF (SELECT array_agg(cause_kind ORDER BY cause_kind) FROM whaleu_ratings.scoped_command_causes WHERE account_id=actor AND request_id=request)
 IS DISTINCT FROM (CASE WHEN q.operation='create_target_scoped' THEN ARRAY['catalog_release','execution','target_initial'] WHEN q.operation='edit_target_scoped' AND o.outcome='applied' THEN ARRAY['execution','target_edit'] ELSE ARRAY['execution'] END)
 THEN RAISE EXCEPTION 'Scoped request has missing or extra typed causes' USING ERRCODE='23514';END IF;
 IF q.operation='set_score_scoped' THEN
  IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.scores x WHERE x.target_id=p.target_id AND x.account_id=actor AND x.score=(p.intent->'payload'->>'score')::smallint AND x.revision::text=o.result->>'revision')
   OR (o.outcome='applied' AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.score_transitions x WHERE x.account_id=actor AND x.request_id=request AND x.target_id=p.target_id AND x.new_score=(p.intent->'payload'->>'score')::smallint AND x.old_revision::text IS NOT DISTINCT FROM p.intent->'payload'->>'expectedRevision'))
   OR (o.outcome='noop' AND o.result->>'revision' IS DISTINCT FROM p.intent->'payload'->>'expectedRevision')
  THEN RAISE EXCEPTION 'Scoped score differs from exact original desired state/CAS' USING ERRCODE='23514';END IF;
 ELSIF q.operation IN ('set_comment_like_scoped','set_reply_like_scoped') THEN
  IF (o.outcome='applied' AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.like_transitions x WHERE x.account_id=actor AND x.request_id=request AND x.target_id=p.target_id
    AND x.root_id::text=p.intent->'payload'->>'rootId' AND x.reply_id::text IS NOT DISTINCT FROM p.intent->'payload'->>'replyId'
    AND x.old_revision::text=p.intent->'payload'->>'expectedLikeRevision' AND (x.delta=1)=(p.intent->'payload'->>'liked')::boolean))
   OR (o.outcome='noop' AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.like_noop_observations x WHERE x.account_id=actor AND x.request_id=request
    AND x.subject_id::text=coalesce(p.intent->'payload'->>'replyId',p.intent->'payload'->>'rootId') AND x.revision::text=p.intent->'payload'->>'expectedLikeRevision' AND x.liked=(p.intent->'payload'->>'liked')::boolean))
  THEN RAISE EXCEPTION 'Scoped like differs from original exact subject/CAS/desired state' USING ERRCODE='23514';END IF;
 ELSIF q.operation='set_target_subscription_scoped' THEN
  IF (o.outcome='applied' AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.subscription_transitions x WHERE x.account_id=actor AND x.request_id=request AND x.target_id=p.target_id AND x.old_revision::text=p.intent->'payload'->>'expectedSubscriptionRevision' AND (x.delta=1)=(p.intent->'payload'->>'subscribed')::boolean))
   OR (o.outcome='noop' AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.subscription_noop_observations x WHERE x.account_id=actor AND x.request_id=request AND x.target_id=p.target_id AND x.revision::text=p.intent->'payload'->>'expectedSubscriptionRevision' AND x.subscribed=(p.intent->'payload'->>'subscribed')::boolean))
  THEN RAISE EXCEPTION 'Scoped subscription differs from exact original target/CAS/desired state' USING ERRCODE='23514';END IF;
 END IF;
 IF q.operation IN ('create_target_scoped','edit_target_scoped') THEN
  IF n<>0 OR EXISTS(SELECT 1 FROM whaleu_ratings.effect_events WHERE actor_account_id=actor AND request_id=request) THEN RAISE EXCEPTION 'Target definition cannot cause scalar/content rewards' USING ERRCODE='23514';END IF;
  IF q.operation='create_target_scoped' THEN
   IF o.outcome<>'applied' THEN RAISE EXCEPTION 'Scoped creation cannot noop' USING ERRCODE='23514';END IF;
   PERFORM whaleu_ratings.verify_scoped_target_initial(p.target_id);
   SELECT * INTO cause FROM whaleu_ratings.scoped_command_causes WHERE account_id=actor AND request_id=request AND cause_kind='catalog_release';
   IF NOT coalesce(cause.mutation_transaction=pg_current_xact_id() AND cause.proof->>'catalogId'=o.result->>'catalogRevision'
    AND EXISTS(SELECT 1 FROM whaleu_ratings.scoped_releases r JOIN whaleu_ratings.scoped_catalogs c ON c.release_id=r.id JOIN whaleu_ratings.scoped_catalog_heads h ON h.catalog_id=c.id
     WHERE r.id=cause.artifact_id AND r.cause_kind='create_target_scoped' AND r.cause->>'accountId'=actor::text AND r.cause->>'requestId'=request::text
     AND c.id::text=o.result->>'catalogRevision' AND h.head_revision=cause.artifact_revision AND EXISTS(SELECT 1 FROM whaleu_ratings.scoped_target_memberships m WHERE m.catalog_id=c.id AND m.target_id=p.target_id)),false)
   THEN RAISE EXCEPTION 'Scoped creation requires exact full after catalog' USING ERRCODE='23514';END IF;
  ELSIF o.outcome='applied' THEN PERFORM whaleu_ratings.verify_scoped_target_edit(actor,request);
  ELSE SELECT * INTO t FROM whaleu_ratings.targets WHERE id=p.target_id;
   IF NOT coalesce(t.active AND t.creator_id=actor AND t.revision::text=p.intent->'payload'->>'expectedTargetRevision'
    AND (p.intent->'protocolVersion'<>'3'::jsonb OR coalesce(p.before_state->'definition'->'envelope'->'cover','null'::jsonb)=p.envelope->'cover')
    AND p.before_state->>'name'=p.intent->'payload'->>'name' AND p.before_state->>'description'=p.intent->'payload'->>'description'
    AND o.result->>'revision'=t.revision::text AND o.result->>'definitionRevision'=p.intent->'payload'->>'expectedDefinitionRevision'
    AND o.result->'contentVersion'=p.intent->'payload'->'expectedContentVersion'
    AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.scoped_command_causes WHERE account_id=actor AND request_id=request AND cause_kind<>'execution'),false)
   THEN RAISE EXCEPTION 'Scoped edit noop must retain exact unchanged tuple' USING ERRCODE='23514';END IF;
  END IF;
 ELSE
  IF n<>(CASE WHEN o.outcome='applied' THEN 1 ELSE 0 END) THEN RAISE EXCEPTION 'Scoped scalar/content cardinality mismatch' USING ERRCODE='23514';END IF;
  IF q.operation='create_comment_scoped' THEN PERFORM whaleu_ratings.verify_scoped_content('comment',p.subject_id);
  ELSIF q.operation='create_reply_scoped' THEN PERFORM whaleu_ratings.verify_scoped_content('reply',p.subject_id);END IF;
 END IF;
END $$;

CREATE FUNCTION whaleu_ratings.discussion_media_reserved_command_key() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b whaleu_media.ratings_discussion_batches;i jsonb;BEGIN
 SELECT * INTO b FROM whaleu_media.ratings_discussion_batches WHERE actor_id=NEW.account_id AND command_request_id=NEW.request_id;
 IF NOT FOUND THEN RETURN NULL;END IF;
 IF TG_TABLE_NAME='requests' AND EXISTS(SELECT 1 FROM whaleu_ratings.discussion_command_recovery_fences f
 WHERE f.account_id=NEW.account_id AND f.request_id=NEW.request_id AND f.intent_hash=NEW.intent_hash
 AND f.operation=NEW.operation AND f.operation=CASE b.identity->'target'->>'kind' WHEN 'root' THEN 'create_comment_scoped' ELSE 'create_reply_scoped' END)
 THEN PERFORM whaleu_ratings.verify_discussion_recovery_fence(NEW.account_id,NEW.request_id);RETURN NULL;END IF;
 IF TG_TABLE_NAME='scoped_command_preparations' THEN i:=NEW.intent;
 ELSE SELECT intent INTO i FROM whaleu_ratings.scoped_command_outcomes WHERE account_id=NEW.account_id AND request_id=NEW.request_id;END IF;
 IF NOT coalesce(i->'protocolVersion'='4'::jsonb AND whaleu_ratings.discussion_media_intent_valid(i)
 AND i->'payload'->>'batchId'=b.id::text AND i->'payload'->>'batchRequestId'=b.batch_request_id::text
 AND i->'payload'->>'draftRevision'=b.identity->>'draftRevision' AND i->'context'=b.identity->'context'
 AND i->'payload'->>'targetId'=b.identity->'target'->>'targetId'
 AND i->>'operation'=CASE b.identity->'target'->>'kind' WHEN 'root' THEN 'create_comment_scoped' ELSE 'create_reply_scoped' END,false)
 THEN RAISE EXCEPTION 'Discussion reserved publication key cannot be claimed by another owner or intent' USING ERRCODE='23514';END IF;
 RETURN NULL;
END$$;
CREATE CONSTRAINT TRIGGER discussion_media_command_key AFTER INSERT OR UPDATE ON whaleu_ratings.requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.discussion_media_reserved_command_key();
CREATE CONSTRAINT TRIGGER discussion_media_preparation_key AFTER INSERT ON whaleu_ratings.scoped_command_preparations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.discussion_media_reserved_command_key();

CREATE FUNCTION whaleu_ratings.discussion_media_draft_id(actor uuid,request uuid) RETURNS uuid LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE bytes bytea;BEGIN
 bytes:=substring(sha256(convert_to('whaleu:rating-discussion-draft:v1'||chr(10)||actor::text||chr(10)||request::text,'UTF8')) FROM 1 FOR 16);
 bytes:=set_byte(bytes,6,(get_byte(bytes,6)&15)|64);bytes:=set_byte(bytes,8,(get_byte(bytes,8)&63)|128);
 RETURN encode(bytes,'hex')::uuid;
END$$;
CREATE FUNCTION whaleu_ratings.discussion_media_batch_owner_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c whaleu_ratings.scoped_contexts;t whaleu_ratings.targets;h whaleu_ratings.target_definition_heads;r whaleu_ratings.comments;q whaleu_ratings.replies;v jsonb:=NEW.identity;BEGIN
 SELECT * INTO c FROM whaleu_ratings.scoped_contexts WHERE id=(v->'context'->>'id')::uuid;
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=(v->'target'->>'targetId')::uuid;
 SELECT * INTO h FROM whaleu_ratings.target_definition_heads WHERE target_id=t.id;
 IF NOT coalesce(c.account_id=NEW.actor_id AND c.context->>'mode'='public' AND c.context->>'purpose'='interact'
 AND whaleu_ratings.scoped_context_current(c.id,c.account_id,c.session_id,clock_timestamp()) AND whaleu_ratings.discussion_media_context_current(c.id,clock_timestamp())
 AND v->'context'=jsonb_build_object('id',c.id,'token',c.context->'token','tokenDigest',c.token_digest,'selector',c.context->'selector','scopeRevision',c.context->'scopeRevision',
 'protocolGeneration',c.context->'protocolGeneration','catalogRevision',c.context->'heads'->0->'catalogRevision','headRevision',c.context->'heads'->0->'headRevision','sourceDigest',c.context->'sourceDigest','discussionMedia',c.context->'discussionMedia')
 AND NEW.server_scope_id=whaleu_ratings.discussion_media_draft_id(NEW.actor_id,NEW.batch_request_id) AND NEW.scope_revision=NEW.identity_hash AND NEW.expires_at=c.valid_until
 AND t.active AND t.revision::text=v->'target'->>'expectedTargetRevision' AND t.category_id::text=v->>'categoryId'
 AND h.definition_revision::text=v->'target'->>'expectedDefinitionRevision' AND h.content_version=(v->'target'->>'expectedContentVersion')::integer
 AND EXISTS(SELECT 1 FROM whaleu_ratings.target_definition_versions d WHERE (d.target_id,d.content_version,d.definition_revision)=(h.target_id,h.content_version,h.definition_revision)
  AND whaleu_community.rating_target_definition_current(d.target_id,d.content_version,d.definition_revision,d.applied_target_revision,d.envelope))
 AND EXISTS(SELECT 1 FROM whaleu_ratings.scoped_target_memberships m JOIN whaleu_ratings.scoped_categories category ON (category.catalog_id,category.category_id)=(m.catalog_id,m.category_id)
  WHERE m.catalog_id=(v->'context'->>'catalogRevision')::uuid AND m.target_id=t.id AND m.category_id=t.category_id AND category.kind='general'
  AND category.effective_revision::text=v->>'expectedCategoryRevision' AND whaleu_ratings.scoped_category_current(category.catalog_id,category.category_id)),false)
 THEN RAISE EXCEPTION 'Discussion upload batch has no exact current original owner scope' USING ERRCODE='23514';END IF;
 IF v->'target'->>'kind'='reply' THEN
  SELECT * INTO r FROM whaleu_ratings.comments WHERE id=(v->'target'->>'rootId')::uuid;
  IF NOT coalesce(r.target_id=t.id AND r.deleted_at IS NULL AND r.revision::text=v->'target'->>'expectedRootRevision'
   AND whaleu_community.rating_scoped_parent_review_current('comment',r.id,r.revision),false) THEN RAISE EXCEPTION 'Discussion upload root is unavailable' USING ERRCODE='23514';END IF;
  IF v->'target'->'replyTo'<>'null'::jsonb THEN
   SELECT * INTO q FROM whaleu_ratings.replies WHERE id=(v->'target'->'replyTo'->>'replyId')::uuid;
   IF NOT coalesce(q.target_id=t.id AND q.root_id=r.id AND q.deleted_at IS NULL AND q.revision::text=v->'target'->'replyTo'->>'expectedRevision'
    AND whaleu_community.rating_scoped_parent_review_current('reply',q.id,q.revision),false) THEN RAISE EXCEPTION 'Discussion upload quote reference is unavailable' USING ERRCODE='23514';END IF;
  END IF;
 END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER discussion_media_batch_owner BEFORE INSERT ON whaleu_media.ratings_discussion_batches FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.discussion_media_batch_owner_guard();
CREATE CONSTRAINT TRIGGER discussion_media_batch_owner_final AFTER INSERT ON whaleu_media.ratings_discussion_batches DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.discussion_media_batch_owner_guard();

-- Existing like/text commands retain their old byte protocol. Only when their
-- actual referenced content is Review7 do they require the independently adopted
-- discussion capability. Unrelated target subscriptions/random pools do not.
CREATE FUNCTION whaleu_ratings.discussion_media_existing_operation_scope_current(context_id uuid,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT jsonb_array_length(c.protocol_tuples)=1 AND NOT EXISTS(
 SELECT 1 FROM jsonb_array_elements(c.protocol_tuples) p LEFT JOIN whaleu_ratings.discussion_media_capability_sources a ON a.protocol_version_id=(p->>'versionId')::uuid
 WHERE a.id IS NULL OR NOT whaleu_ratings.discussion_media_capability_current(a.id,instant)) FROM whaleu_ratings.scoped_contexts c WHERE c.id=context_id),false)
$$;
DO $$DECLARE definition text;BEGIN
 SELECT pg_get_functiondef('whaleu_ratings.scoped_command_parents_current(whaleu_ratings.scoped_command_preparations)'::regprocedure) INTO definition;
 EXECUTE replace(definition,'FUNCTION whaleu_ratings.scoped_command_parents_current(', 'FUNCTION whaleu_ratings.scoped_command_parents_current_pre_discussion_media(');
END$$;
CREATE OR REPLACE FUNCTION whaleu_ratings.scoped_command_parents_current(prepared whaleu_ratings.scoped_command_preparations) RETURNS boolean LANGUAGE sql AS $$
 SELECT whaleu_ratings.scoped_command_parents_current_pre_discussion_media(prepared) AND (
 NOT EXISTS(SELECT 1 FROM whaleu_ratings.comments c WHERE c.id::text=prepared.intent->'payload'->>'rootId' AND c.envelope->'version'='7'::jsonb
 UNION ALL SELECT 1 FROM whaleu_ratings.replies r WHERE r.id::text IN (prepared.intent->'payload'->>'replyId',prepared.intent->'payload'->'replyTo'->>'replyId') AND r.envelope->'version'='7'::jsonb)
 OR whaleu_ratings.discussion_media_existing_operation_scope_current(prepared.context_id,clock_timestamp()))
$$;

CREATE FUNCTION whaleu_ratings.discussion_media_batch_fence_owner() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.command_claims c WHERE c.account_id=NEW.actor_id AND c.request_id=NEW.batch_request_id
 AND c.operation='prepare_discussion_media_batch' AND c.intent_hash=NEW.identity_hash)
 OR EXISTS(SELECT 1 FROM whaleu_media.ratings_discussion_batches WHERE actor_id=NEW.actor_id AND command_request_id=NEW.batch_request_id)
 OR EXISTS(SELECT 1 FROM whaleu_ratings.requests WHERE account_id=NEW.actor_id AND request_id=NEW.batch_request_id)
 OR EXISTS(SELECT 1 FROM whaleu_ratings.scoped_command_preparations WHERE account_id=NEW.actor_id AND request_id=NEW.batch_request_id)
 THEN RAISE EXCEPTION 'Discussion batch recovery fence conflicts with the original owner namespace' USING ERRCODE='23514';END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER discussion_media_batch_fence_owner BEFORE INSERT ON whaleu_media.ratings_discussion_batch_request_fences FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.discussion_media_batch_fence_owner();

CREATE FUNCTION whaleu_ratings.discussion_media_member_fence_owner() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.command_claims c WHERE c.account_id=NEW.actor_id AND c.request_id=NEW.client_request_id
 AND c.operation='prepare_discussion_media_member' AND c.intent_hash=NEW.request_hash)
 OR EXISTS(SELECT 1 FROM whaleu_media.ratings_discussion_batches WHERE actor_id=NEW.actor_id AND (command_request_id=NEW.client_request_id OR batch_request_id=NEW.client_request_id))
 OR EXISTS(SELECT 1 FROM whaleu_ratings.requests WHERE account_id=NEW.actor_id AND request_id=NEW.client_request_id)
 OR EXISTS(SELECT 1 FROM whaleu_ratings.scoped_command_preparations WHERE account_id=NEW.actor_id AND request_id=NEW.client_request_id)
 THEN RAISE EXCEPTION 'Discussion member recovery fence conflicts with the original owner namespace' USING ERRCODE='23514';END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER discussion_media_member_fence_owner BEFORE INSERT ON whaleu_media.ratings_discussion_request_markers FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.discussion_media_member_fence_owner();
