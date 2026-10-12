-- W3 v2 images: new typed Media16 and exact ordered-set Review. Old SQL is immutable.
-- New Next bounded policy: <=3 JPEG/PNG images per root/reply; static-v1 budgets.
SET LOCAL lock_timeout='5s';
CREATE FUNCTION whaleu_ratings.window_discussion_images_valid(v jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE image jsonb;seen text[]:=ARRAY[]::text[];BEGIN
 IF jsonb_typeof(v) IS DISTINCT FROM 'array' OR jsonb_array_length(v)>3 THEN RETURN false;END IF;
 FOR image IN SELECT value FROM jsonb_array_elements(v) LOOP
  IF NOT whaleu_community.rating_scoped_keys(image,ARRAY['assetId','manifestDigest']) OR NOT whaleu_community.rating_scoped_ids(image,ARRAY['assetId']) OR jsonb_typeof(image->'manifestDigest') IS DISTINCT FROM 'string' OR image->>'manifestDigest' !~ '^[a-f0-9]{64}$' OR image->>'assetId'=ANY(seen) THEN RETURN false;END IF;
  seen:=array_append(seen,image->>'assetId');
 END LOOP;RETURN true;
END$$;
CREATE TABLE whaleu_community.window_discussion_media_review_policies(
 id uuid PRIMARY KEY,issuer text NOT NULL CHECK(length(btrim(issuer)) BETWEEN 1 AND 200),source_reference text NOT NULL CHECK(length(btrim(source_reference)) BETWEEN 1 AND 2000),coverage text NOT NULL CHECK(coverage IN('complete','unknown')),
 valid_from timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(valid_from)),valid_until timestamptz NOT NULL CHECK(isfinite(valid_until) AND valid_until>valid_from)
);
CREATE TABLE whaleu_community.window_discussion_media_review_decisions(
 id uuid PRIMARY KEY,actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,window_id uuid NOT NULL REFERENCES whaleu_ratings.window_identities(id),catalog_id uuid NOT NULL,window_revision uuid NOT NULL,
 purpose text NOT NULL CHECK(purpose IN('window.discussion.root.v2','window.discussion.reply.v2')),root_id uuid,reply_to_reply_id uuid,reply_to_actor_id uuid REFERENCES whaleu_identity.accounts(id),body text NOT NULL,images jsonb NOT NULL CHECK(whaleu_ratings.window_discussion_images_valid(images)),CHECK((body='' OR whaleu_ratings.window_discussion_body_valid(body)) AND(body<>'' OR jsonb_array_length(images)>0)),
 policy_id uuid NOT NULL REFERENCES whaleu_community.window_discussion_media_review_policies(id),verdict text NOT NULL CHECK(verdict IN('allow','reject')),digest text NOT NULL,
 issued_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(issued_at)),consume_until timestamptz NOT NULL CHECK(isfinite(consume_until) AND consume_until>issued_at),visibility_until timestamptz NOT NULL CHECK(isfinite(visibility_until) AND visibility_until>issued_at),
 FOREIGN KEY(catalog_id,window_id,window_revision) REFERENCES whaleu_ratings.window_entries(catalog_id,window_id,revision),UNIQUE(id,actor_id,request_id),
 CHECK((purpose='window.discussion.reply.v2')=(root_id IS NOT NULL)),CHECK((reply_to_reply_id IS NULL)=(reply_to_actor_id IS NULL)),CHECK(root_id IS NOT NULL OR reply_to_reply_id IS NULL),
 CHECK(digest=encode(sha256(convert_to('whaleu:window-discussion-review:v2'||chr(10)||whaleu_community.content_canonical_json(jsonb_build_object('version',2,'images',images,'purpose',purpose,'actorId',actor_id::text,'requestId',request_id::text,'windowId',window_id::text,'catalogRevision',catalog_id::text,'windowRevision',window_revision::text,'body',body,'rootId',root_id::text,'replyToReplyId',reply_to_reply_id::text,'replyToActorId',reply_to_actor_id::text)),'UTF8')),'hex'))
);
CREATE TABLE whaleu_community.window_discussion_media_review_heads(actor_id uuid NOT NULL,request_id uuid NOT NULL,decision_id uuid NOT NULL,state text NOT NULL CHECK(state IN('active','revoked')),PRIMARY KEY(actor_id,request_id),FOREIGN KEY(decision_id,actor_id,request_id) REFERENCES whaleu_community.window_discussion_media_review_decisions(id,actor_id,request_id));

ALTER TABLE whaleu_ratings.window_discussion_comments ADD COLUMN publication_version integer NOT NULL DEFAULT 1 CHECK(publication_version IN(1,2)),ADD COLUMN image_set jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(whaleu_ratings.window_discussion_images_valid(image_set)),ADD COLUMN media_review_decision_id uuid UNIQUE REFERENCES whaleu_community.window_discussion_media_review_decisions(id);
ALTER TABLE whaleu_ratings.window_discussion_comments ALTER COLUMN review_decision_id DROP NOT NULL;
ALTER TABLE whaleu_ratings.window_discussion_comments DROP CONSTRAINT window_discussion_comments_body_check;
ALTER TABLE whaleu_ratings.window_discussion_comments ADD CONSTRAINT window_discussion_versioned_body CHECK(
 (publication_version=1 AND review_decision_id IS NOT NULL AND media_review_decision_id IS NULL AND image_set='[]'::jsonb AND whaleu_ratings.window_discussion_body_valid(body)) OR
 (publication_version=2 AND review_decision_id IS NULL AND media_review_decision_id IS NOT NULL AND(body='' OR whaleu_ratings.window_discussion_body_valid(body)) AND(body<>'' OR jsonb_array_length(image_set)>0)));
-- Replace only operation/subject/hash checks; all original row-size and key/receipt checks remain.
DO $$DECLARE c record;BEGIN FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='whaleu_ratings.window_discussion_commands'::regclass AND contype='c' AND(pg_get_constraintdef(oid) LIKE '%window.discussion.root.v1%' OR pg_get_constraintdef(oid) LIKE '%whaleu:window-discussion-command:v1%') LOOP EXECUTE format('ALTER TABLE whaleu_ratings.window_discussion_commands DROP CONSTRAINT %I',c.conname);END LOOP;END$$;
ALTER TABLE whaleu_ratings.window_discussion_commands ADD CONSTRAINT window_discussion_versioned_operation CHECK(operation IN('window.discussion.root.v1','window.discussion.reply.v1','window.discussion.like.v1','window.discussion.root.v2','window.discussion.reply.v2')),
 ADD CONSTRAINT window_discussion_versioned_subject CHECK((operation IN('window.discussion.root.v1','window.discussion.root.v2'))=(subject_id IS NULL)),
 ADD CONSTRAINT window_discussion_versioned_hash CHECK(intent_hash=encode(sha256(convert_to(CASE WHEN operation IN('window.discussion.root.v2','window.discussion.reply.v2') THEN 'whaleu:window-discussion-command:v2' ELSE 'whaleu:window-discussion-command:v1' END||chr(10)||whaleu_community.content_canonical_json(jsonb_build_object('actorId',actor_id::text,'windowId',window_id::text,'subjectId',subject_id::text,'operation',operation,'command',command)),'UTF8')),'hex'));
CREATE TABLE whaleu_ratings.window_discussion_media_cancels(
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,session_id uuid NOT NULL REFERENCES whaleu_identity.sessions(id),window_id uuid NOT NULL REFERENCES whaleu_ratings.window_identities(id),root_id uuid,operation text NOT NULL CHECK(operation IN('window.discussion.root.v2','window.discussion.reply.v2')),intent_hash text CHECK(intent_hash~'^[a-f0-9]{64}$'),receipt jsonb NOT NULL,transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),PRIMARY KEY(actor_id,request_id),CHECK((operation='window.discussion.reply.v2')=(root_id IS NOT NULL)));
CREATE FUNCTION whaleu_ratings.window_discussion_media_cancel_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 PERFORM whaleu_ratings.window_discussion_lock(NEW.actor_id,NEW.request_id,NULL);
 IF NOT whaleu_identity.window_rating_session(NEW.actor_id,NEW.session_id,clock_timestamp()) OR NEW.transaction_id<>pg_current_xact_id() OR EXISTS(SELECT 1 FROM whaleu_ratings.window_discussion_commands WHERE actor_id=NEW.actor_id AND request_id=NEW.request_id) OR NEW.receipt IS DISTINCT FROM (jsonb_build_object('requestId',NEW.request_id::text,'windowId',NEW.window_id::text,'operation',NEW.operation,'outcome','rejected','code','WINDOW_DISCUSSION_CANCELLED')||CASE WHEN NEW.root_id IS NOT NULL THEN jsonb_build_object('rootId',NEW.root_id::text) ELSE '{}'::jsonb END) THEN RAISE EXCEPTION 'Exact session-owned original cancellation fence required' USING ERRCODE='23514',CONSTRAINT='window_discussion_causal';END IF;RETURN NEW;
END$$;
CREATE TRIGGER window_discussion_media_cancel_guard BEFORE INSERT ON whaleu_ratings.window_discussion_media_cancels FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.window_discussion_media_cancel_guard();
CREATE TRIGGER window_discussion_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_ratings.window_discussion_media_cancels FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.window_discussion_immutable();
CREATE TRIGGER window_discussion_epoch AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_ratings.window_discussion_media_cancels FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.window_discussion_epoch_advance();
DO $$DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['window_discussion_media_review_policies','window_discussion_media_review_decisions','window_discussion_media_review_heads'] LOOP EXECUTE format('CREATE TRIGGER window_discussion_review_epoch AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.window_discussion_review_epoch_advance()',t);END LOOP;
 FOREACH t IN ARRAY ARRAY['window_discussion_media_review_policies','window_discussion_media_review_decisions'] LOOP EXECUTE format('CREATE TRIGGER window_discussion_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_community.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.window_discussion_immutable()',t);END LOOP;
END$$;
CREATE FUNCTION whaleu_community.window_discussion_media_review_status(did uuid,consume boolean,instant timestamptz) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT CASE WHEN h.state='revoked' THEN 'deny' WHEN p.coverage<>'complete' OR p.valid_from>d.issued_at OR d.issued_at>instant OR p.valid_until<=instant OR d.visibility_until<=instant OR (consume AND d.consume_until<=instant) THEN 'unavailable' ELSE d.verdict END FROM whaleu_community.window_discussion_media_review_decisions d JOIN whaleu_community.window_discussion_media_review_policies p ON p.id=d.policy_id JOIN whaleu_community.window_discussion_media_review_heads h ON h.decision_id=d.id AND h.actor_id=d.actor_id AND h.request_id=d.request_id WHERE d.id=did),'unavailable')
$$;
CREATE FUNCTION whaleu_ratings.window_discussion_complete_v1(actor uuid,rid uuid) RETURNS void LANGUAGE plpgsql VOLATILE AS $$
DECLARE q whaleu_ratings.window_discussion_commands;c whaleu_ratings.window_discussion_comments;target whaleu_ratings.window_discussion_comments;root whaleu_ratings.window_discussion_comments;e whaleu_ratings.window_discussion_like_events;own whaleu_ratings.window_discussion_like_events;d whaleu_community.window_discussion_review_decisions;source jsonb;instant timestamptz;pub boolean;reply boolean;positive boolean;expected uuid;keys text[];BEGIN
 PERFORM whaleu_ratings.window_discussion_fence();instant:=clock_timestamp();
 SELECT * INTO q FROM whaleu_ratings.window_discussion_commands WHERE actor_id=actor AND request_id=rid;
 IF q.request_id IS NULL OR q.transaction_id<>pg_current_xact_id() OR NOT whaleu_identity.window_rating_session(actor,q.session_id,instant) THEN RAISE EXCEPTION 'Window discussion requires current owner session and exact command' USING ERRCODE='23514',CONSTRAINT='window_discussion_causal';END IF;
 pub:=q.operation<>'window.discussion.like.v1';reply:=q.operation='window.discussion.reply.v1';
 keys:=CASE WHEN NOT pub THEN ARRAY['clientRequestId','expectedCatalogRevision','expectedWindowRevision','expectedMembershipRevision','active'] WHEN reply THEN ARRAY['clientRequestId','expectedCatalogRevision','expectedWindowRevision','body','replyToReplyId'] ELSE ARRAY['clientRequestId','expectedCatalogRevision','expectedWindowRevision','body'] END;
 IF NOT whaleu_community.rating_scoped_keys(q.command,keys) OR NOT whaleu_community.rating_scoped_ids(q.command,ARRAY['clientRequestId','expectedCatalogRevision','expectedWindowRevision']) OR(pub AND(jsonb_typeof(q.command->'body') IS DISTINCT FROM 'string' OR NOT whaleu_ratings.window_discussion_body_valid(q.command->>'body'))) OR(reply AND q.command->'replyToReplyId'<>'null'::jsonb AND NOT whaleu_community.rating_scoped_ids(q.command,ARRAY['replyToReplyId'])) OR(NOT pub AND(jsonb_typeof(q.command->'active') IS DISTINCT FROM 'boolean' OR(q.command->'expectedMembershipRevision'<>'null'::jsonb AND NOT whaleu_community.rating_scoped_ids(q.command,ARRAY['expectedMembershipRevision'])))) THEN RAISE EXCEPTION 'Strict exact Window intent required' USING ERRCODE='23514',CONSTRAINT='window_discussion_causal';END IF;
 IF(reply AND q.receipt->>'rootId' IS DISTINCT FROM q.subject_id::text) OR(NOT pub AND q.receipt->>'commentId' IS DISTINCT FROM q.subject_id::text) THEN RAISE EXCEPTION 'Exact Window receipt subject required' USING ERRCODE='23514',CONSTRAINT='window_discussion_causal';END IF;
 SELECT * INTO c FROM whaleu_ratings.window_discussion_comments WHERE actor_id=actor AND request_id=rid;
 SELECT * INTO e FROM whaleu_ratings.window_discussion_like_events WHERE actor_id=actor AND request_id=rid;
 -- Every expected recipient exists once, and there are no extra or forged rows.
 IF EXISTS((SELECT recipient_id,kind,event_id,window_id,comment_id,root_id FROM whaleu_notifications.window_discussion_expected(actor,rid) EXCEPT SELECT recipient_id,kind,event_id,window_id,comment_id,root_id FROM whaleu_notifications.window_discussion_notices WHERE actor_id=actor AND request_id=rid) UNION ALL(SELECT recipient_id,kind,event_id,window_id,comment_id,root_id FROM whaleu_notifications.window_discussion_notices WHERE actor_id=actor AND request_id=rid EXCEPT SELECT recipient_id,kind,event_id,window_id,comment_id,root_id FROM whaleu_notifications.window_discussion_expected(actor,rid))) OR EXISTS(SELECT 1 FROM whaleu_notifications.window_discussion_notices WHERE actor_id=actor AND request_id=rid AND(transaction_id<>pg_current_xact_id() OR created_at<>date_trunc('milliseconds',transaction_timestamp()))) THEN RAISE EXCEPTION 'Exact atomic transition notice obligations required' USING ERRCODE='23514',CONSTRAINT='window_discussion_causal';END IF;
 IF q.receipt->>'outcome'='rejected' THEN
  keys:=ARRAY['requestId','operation','windowId','outcome','code']||CASE WHEN reply THEN ARRAY['rootId'] WHEN NOT pub THEN ARRAY['commentId'] ELSE ARRAY[]::text[] END;
  IF NOT whaleu_community.rating_scoped_keys(q.receipt,keys) OR c.id IS NOT NULL OR e.id IS NOT NULL THEN RAISE EXCEPTION 'Rejection has no mutation' USING ERRCODE='23514',CONSTRAINT='window_discussion_causal';END IF;
  IF q.receipt->>'code'='WINDOW_DISCUSSION_CANCELLED' THEN RETURN;END IF;
 END IF;
 positive:=pub OR(q.command->>'active')::boolean;
 IF positive THEN
  IF NOT whaleu_ratings.window_access(actor,q.session_id,instant) THEN RAISE EXCEPTION 'Fresh Window actions need phone and Safety' USING ERRCODE='23514',CONSTRAINT='window_discussion_causal';END IF;
  source:=whaleu_ratings.window_discussion_source(q.window_id,instant);
  IF source IS NULL OR source->>'population' IS NULL OR source->>'likes' IS NULL THEN RAISE EXCEPTION 'Independent Window discussion histories required' USING ERRCODE='23514',CONSTRAINT='window_discussion_causal';END IF;
  IF q.receipt->>'outcome'='rejected' AND q.receipt->>'code'='WINDOW_REVISION_CONFLICT' THEN
   IF(source->>'catalog',source->>'revision') IS NOT DISTINCT FROM(q.command->>'expectedCatalogRevision',q.command->>'expectedWindowRevision') THEN RAISE EXCEPTION 'Source conflict must be causal' USING ERRCODE='23514',CONSTRAINT='window_discussion_causal';END IF;RETURN;
  END IF;
  IF(source->>'catalog',source->>'revision') IS DISTINCT FROM(q.command->>'expectedCatalogRevision',q.command->>'expectedWindowRevision') THEN RAISE EXCEPTION 'Current exact Window source required' USING ERRCODE='23514',CONSTRAINT='window_discussion_causal';END IF;
 END IF;
 IF pub THEN
  IF reply THEN
   SELECT * INTO root FROM whaleu_ratings.window_discussion_comments WHERE id=q.subject_id AND window_id=q.window_id AND root_id IS NULL;
   IF root.id IS NULL OR whaleu_ratings.window_discussion_visibility(root.id,actor,instant)<>'allow' THEN RAISE EXCEPTION 'Reply requires current same-window root' USING ERRCODE='23514',CONSTRAINT='window_discussion_causal';END IF;
   IF q.command->>'replyToReplyId' IS NOT NULL THEN SELECT * INTO target FROM whaleu_ratings.window_discussion_comments WHERE id=(q.command->>'replyToReplyId')::uuid AND window_id=q.window_id AND root_id=root.id;
    IF target.id IS NULL OR whaleu_ratings.window_discussion_visibility(target.id,actor,instant)<>'allow' THEN RAISE EXCEPTION 'Addressed reply requires same root and current visibility' USING ERRCODE='23514',CONSTRAINT='window_discussion_causal';END IF;
   END IF;
  END IF;
  SELECT decisions.* INTO d FROM whaleu_community.window_discussion_review_decisions decisions JOIN whaleu_community.window_discussion_review_heads h ON h.decision_id=decisions.id WHERE h.actor_id=actor AND h.request_id=rid;
  IF d.id IS NULL OR(d.actor_id,d.request_id,d.window_id,d.catalog_id::text,d.window_revision::text,d.purpose,d.root_id,d.reply_to_reply_id,d.reply_to_actor_id,d.body) IS DISTINCT FROM(actor,rid,q.window_id,q.command->>'expectedCatalogRevision',q.command->>'expectedWindowRevision',q.operation,root.id,target.id,target.actor_id,q.command->>'body') THEN RAISE EXCEPTION 'Exact original Window root/reply Review required' USING ERRCODE='23514',CONSTRAINT='window_discussion_causal';END IF;
  IF q.receipt->>'outcome'='rejected' AND q.receipt->>'code'='CONTENT_REJECTED' AND whaleu_community.window_discussion_review_status(d.id,true,instant)='reject' THEN RETURN;END IF;
  keys:=ARRAY['requestId','operation','windowId','outcome','commentId','createdAt']||CASE WHEN reply THEN ARRAY['rootId'] ELSE ARRAY[]::text[] END;
  IF q.receipt->>'outcome' IS DISTINCT FROM 'applied' OR NOT whaleu_community.rating_scoped_keys(q.receipt,keys) OR c.id IS NULL OR e.id IS NOT NULL OR(c.window_id,c.root_id,c.reply_to_reply_id,c.reply_to_actor_id,c.body,c.catalog_id::text,c.window_revision::text,c.population_assertion_id::text,c.review_decision_id) IS DISTINCT FROM(q.window_id,root.id,target.id,target.actor_id,q.command->>'body',source->>'catalog',source->>'revision',source->>'population',d.id) OR c.transaction_id<>pg_current_xact_id() OR c.created_at<>date_trunc('milliseconds',transaction_timestamp()) OR q.receipt->>'commentId' IS DISTINCT FROM c.id::text OR q.receipt->>'createdAt' IS DISTINCT FROM to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') OR whaleu_community.window_discussion_review_status(d.id,true,instant)<>'allow' OR NOT EXISTS(SELECT 1 FROM whaleu_profile.profiles WHERE account_id=actor) THEN RAISE EXCEPTION 'Publication needs exact atomic content, Review, profile and receipt' USING ERRCODE='23514',CONSTRAINT='window_discussion_causal';END IF;
 ELSE
  expected:=(q.command->>'expectedMembershipRevision')::uuid;
  IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.window_discussion_comments WHERE id=q.subject_id AND window_id=q.window_id) THEN RAISE EXCEPTION 'Like membership subject must exist in exact window' USING ERRCODE='23514',CONSTRAINT='window_discussion_causal';END IF;
  SELECT events.* INTO own FROM whaleu_ratings.window_discussion_like_heads h JOIN whaleu_ratings.window_discussion_like_events events ON events.id=h.revision WHERE h.window_id=q.window_id AND h.comment_id=q.subject_id AND h.actor_id=actor;
  IF positive THEN
   IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.window_discussion_comments WHERE id=q.subject_id AND window_id=q.window_id) OR whaleu_ratings.window_discussion_visibility(q.subject_id,actor,instant)<>'allow' THEN RAISE EXCEPTION 'Positive like needs current subject' USING ERRCODE='23514',CONSTRAINT='window_discussion_causal';END IF;
  ELSIF own.id IS NULL AND whaleu_ratings.window_discussion_history(q.window_id,'likes',instant) IS NULL THEN RAISE EXCEPTION 'Missing membership is not known absence' USING ERRCODE='23514',CONSTRAINT='window_discussion_causal';END IF;
  IF q.receipt->>'outcome'='rejected' AND q.receipt->>'code'='WINDOW_DISCUSSION_MEMBERSHIP_CONFLICT' THEN IF own.id IS NOT DISTINCT FROM expected THEN RAISE EXCEPTION 'Like CAS conflict must be causal' USING ERRCODE='23514',CONSTRAINT='window_discussion_causal';END IF;RETURN;END IF;
  keys:=ARRAY['requestId','operation','windowId','commentId','outcome','active','membershipRevision','recordedAt'];
  IF NOT whaleu_community.rating_scoped_keys(q.receipt,keys) OR c.id IS NOT NULL OR q.receipt->'active' IS DISTINCT FROM q.command->'active' THEN RAISE EXCEPTION 'Exact like receipt required' USING ERRCODE='23514',CONSTRAINT='window_discussion_causal';END IF;
  IF q.receipt->>'outcome'='noop' THEN
   IF e.id IS NOT NULL OR own.id IS DISTINCT FROM expected OR coalesce(own.active,false)<>positive OR q.receipt->'membershipRevision' IS DISTINCT FROM coalesce(to_jsonb(own.id::text),'null'::jsonb) OR q.receipt->'recordedAt' IS DISTINCT FROM coalesce(to_jsonb(to_char(own.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),'null'::jsonb) THEN RAISE EXCEPTION 'Noop requires CAS before state equality and no event' USING ERRCODE='23514',CONSTRAINT='window_discussion_causal';END IF;RETURN;
  END IF;
  IF q.receipt->>'outcome' IS DISTINCT FROM 'applied' OR e.id IS NULL OR own.id IS DISTINCT FROM e.id OR e.window_id<>q.window_id OR e.comment_id<>q.subject_id OR e.active<>positive OR e.transaction_id<>pg_current_xact_id() OR e.recorded_at<>date_trunc('milliseconds',transaction_timestamp()) OR e.previous_revision IS DISTINCT FROM expected OR q.receipt->>'membershipRevision' IS DISTINCT FROM e.id::text OR q.receipt->>'recordedAt' IS DISTINCT FROM to_char(e.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') OR(positive AND(e.catalog_id::text,e.window_revision::text,e.population_assertion_id::text,e.likes_assertion_id::text) IS DISTINCT FROM(source->>'catalog',source->>'revision',source->>'population',source->>'likes')) THEN RAISE EXCEPTION 'Like applied requires atomic causal event/head/receipt' USING ERRCODE='23514',CONSTRAINT='window_discussion_causal';END IF;
 END IF;
END$$;

-- Media16 Window discussion images. Empty independent owner storage only.
-- No provider/retention/source/issuer production seed and no bound-image deletion path.
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
ALTER TABLE whaleu_media.upload_request_fences DROP CONSTRAINT upload_request_fences_protocol_namespace_check;
ALTER TABLE whaleu_media.upload_request_fences ADD CONSTRAINT upload_request_fences_protocol_namespace_check CHECK(protocol_namespace IS NULL OR protocol_namespace IN(8,9,10,11,12,13,14,15,16));
ALTER TABLE whaleu_media.upload_intents DROP CONSTRAINT media_protocol_identity;
ALTER TABLE whaleu_media.upload_intents ADD CONSTRAINT media_protocol_identity CHECK((protocol_version=1 AND request_hash IS NULL AND declared_sha256 IS NULL) OR(protocol_version IN(2,3,4,5,6,7,8,9,10,11,12,13,14,15,16) AND request_hash IS NOT NULL AND declared_sha256 IS NOT NULL));
ALTER TABLE whaleu_media.upload_intents DROP CONSTRAINT media_profile_scope;
ALTER TABLE whaleu_media.upload_intents ADD CONSTRAINT media_profile_scope CHECK(
 (protocol_version=5 AND owner_kind='profile' AND resource_kind='avatar' AND audience='profile-public' AND target_kind='edit' AND content_version=1 AND slot='avatar' AND ordinal=0 AND purpose='profile-avatar-image') OR
 (protocol_version<>5 AND owner_kind<>'profile' AND(target_kind<>'edit' OR protocol_version IN(6,8,9,10,11,12,13,14,15,16)) AND audience<>'profile-public' AND purpose<>'profile-avatar-image'));
ALTER TABLE whaleu_media.upload_intents DROP CONSTRAINT media_ratings_scope;
ALTER TABLE whaleu_media.upload_intents ADD CONSTRAINT media_ratings_scope CHECK(
 (protocol_version=6 AND owner_kind='ratings' AND resource_kind='target_cover' AND audience='content-gated'
 AND target_kind='edit' AND content_version=1 AND slot='cover' AND ordinal=0 AND purpose='ratings-target-cover-image') OR
 (protocol_version=7 AND owner_kind='ratings' AND audience='content-gated' AND target_kind='draft' AND content_version=1 AND slot='images'
 AND ((resource_kind='rating_comment' AND purpose='ratings-comment-image') OR (resource_kind='rating_reply' AND purpose='ratings-reply-image'))) OR
 (protocol_version=8 AND owner_kind='ratings' AND resource_kind='category_icon' AND audience='content-gated'
 AND target_kind='edit' AND content_version=1 AND slot='icon' AND ordinal=0 AND purpose='ratings-category-icon-image') OR
 (protocol_version=16 AND owner_kind='ratings' AND resource_kind='window_discussion_image' AND audience='content-gated' AND target_kind='edit' AND content_version=1 AND slot='images' AND ordinal BETWEEN 0 AND 2 AND purpose='window-discussion-image') OR
 (protocol_version NOT IN (6,7,8,16) AND owner_kind<>'ratings' AND purpose NOT IN ('ratings-target-cover-image','ratings-comment-image','ratings-reply-image','ratings-category-icon-image','window-discussion-image')));
ALTER TABLE whaleu_media.assets DROP CONSTRAINT media_ratings_asset_scope;
ALTER TABLE whaleu_media.assets ADD CONSTRAINT media_ratings_asset_scope CHECK(
 (owner_kind='ratings' AND resource_kind='target_cover' AND audience='content-gated' AND target_kind='edit'
 AND content_version=1 AND slot='cover' AND ordinal=0 AND purpose='ratings-target-cover-image') OR
 (owner_kind='ratings' AND audience='content-gated' AND target_kind='draft' AND content_version=1 AND slot='images'
 AND ((resource_kind='rating_comment' AND purpose='ratings-comment-image') OR (resource_kind='rating_reply' AND purpose='ratings-reply-image'))) OR
 (owner_kind='ratings' AND resource_kind='category_icon' AND audience='content-gated' AND target_kind='edit'
 AND content_version=1 AND slot='icon' AND ordinal=0 AND purpose='ratings-category-icon-image') OR
 (owner_kind='ratings' AND resource_kind='window_discussion_image' AND audience='content-gated' AND target_kind='edit' AND content_version=1 AND slot='images' AND ordinal BETWEEN 0 AND 2 AND purpose='window-discussion-image') OR
 (owner_kind<>'ratings' AND purpose NOT IN ('ratings-target-cover-image','ratings-comment-image','ratings-reply-image','ratings-category-icon-image','window-discussion-image')));
ALTER TABLE whaleu_media.bindings DROP CONSTRAINT media_ratings_binding_slot;
ALTER TABLE whaleu_media.bindings ADD CONSTRAINT media_ratings_binding_slot CHECK(owner_kind<>'ratings' OR
 (resource_kind='target_cover' AND content_version=1 AND slot='cover' AND ordinal=0) OR
 (resource_kind='rating_comment' AND content_version=1 AND slot='images' AND ordinal BETWEEN 0 AND 8) OR
 (resource_kind='rating_reply' AND content_version=1 AND slot='images' AND ordinal BETWEEN 0 AND 2) OR
 (resource_kind='category_icon' AND content_version=1 AND slot='icon' AND ordinal=0) OR
 (resource_kind='window_discussion_image' AND content_version=1 AND slot='images' AND ordinal BETWEEN 0 AND 2));

ALTER TABLE whaleu_media.upload_intents ADD CONSTRAINT window_discussion_media_scope CHECK(
 (protocol_version=16 AND owner_kind='ratings' AND resource_kind='window_discussion_image' AND target_kind='edit' AND content_version=1 AND ordinal BETWEEN 0 AND 2 AND slot='images' AND audience='content-gated' AND purpose='window-discussion-image') OR
 (protocol_version<>16 AND resource_kind<>'window_discussion_image' AND purpose<>'window-discussion-image'));
ALTER TABLE whaleu_media.assets ADD CONSTRAINT window_discussion_media_asset_scope CHECK(
 (owner_kind='ratings' AND resource_kind='window_discussion_image' AND target_kind='edit' AND content_version=1 AND ordinal BETWEEN 0 AND 2 AND slot='images' AND audience='content-gated' AND purpose='window-discussion-image') OR
 (resource_kind<>'window_discussion_image' AND purpose<>'window-discussion-image'));
CREATE TABLE whaleu_media.window_discussion_scopes(
 id uuid PRIMARY KEY,actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),client_request_id uuid NOT NULL,
 window_id uuid NOT NULL REFERENCES whaleu_ratings.window_identities(id),publication_request_id uuid NOT NULL,
 catalog_revision uuid NOT NULL,window_revision uuid NOT NULL,root_id uuid,reply_to_reply_id uuid,ordinal integer NOT NULL CHECK(ordinal BETWEEN 0 AND 2),
 context_digest whaleu_media.digest NOT NULL,scope_revision whaleu_media.digest NOT NULL,input jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),expires_at timestamptz NOT NULL,
 UNIQUE(actor_id,client_request_id),CHECK(root_id IS NOT NULL OR reply_to_reply_id IS NULL),
 FOREIGN KEY(catalog_revision,window_id,window_revision) REFERENCES whaleu_ratings.window_entries(catalog_id,window_id,revision),
 CHECK(isfinite(expires_at) AND expires_at>created_at AND expires_at<=created_at+interval '30 minutes')
);
CREATE TABLE whaleu_media.window_discussion_cancel_scopes(
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),client_request_id uuid NOT NULL,request_hash whaleu_media.digest NOT NULL,
 window_id uuid NOT NULL,publication_request_id uuid NOT NULL,PRIMARY KEY(actor_id,client_request_id)
);
CREATE TABLE whaleu_media.window_discussion_appearances(
 id uuid PRIMARY KEY,comment_id uuid NOT NULL REFERENCES whaleu_ratings.window_discussion_comments(id) DEFERRABLE INITIALLY DEFERRED,
 window_id uuid NOT NULL REFERENCES whaleu_ratings.window_identities(id),actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 publication_request_id uuid NOT NULL,context_digest whaleu_media.digest NOT NULL,ordinal integer NOT NULL CHECK(ordinal BETWEEN 0 AND 2),
 asset_id uuid NOT NULL UNIQUE REFERENCES whaleu_media.assets(id),manifest_digest whaleu_media.digest NOT NULL,
 binding_id uuid NOT NULL UNIQUE REFERENCES whaleu_media.bindings(id) DEFERRABLE INITIALLY DEFERRED,
 publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),UNIQUE(comment_id,ordinal),UNIQUE(actor_id,publication_request_id,ordinal)
);
DO $$DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['window_discussion_scopes','window_discussion_cancel_scopes','window_discussion_appearances'] LOOP
 EXECUTE format('CREATE TRIGGER a0_window_discussion_policy BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_media.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_policy_writer_gate()',t);
 EXECUTE format('CREATE TRIGGER a1_window_discussion_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_media.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.advance_owner_epoch()',t);
 EXECUTE format('CREATE TRIGGER window_discussion_retain BEFORE TRUNCATE ON whaleu_media.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.immutable_record()',t);
 EXECUTE format('CREATE TRIGGER window_discussion_immutable BEFORE UPDATE OR DELETE ON whaleu_media.%I FOR EACH ROW EXECUTE FUNCTION whaleu_media.immutable_record()',t);
 END LOOP;
END$$;
CREATE FUNCTION whaleu_media.window_discussion_request_hash(actor uuid,v jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT encode(sha256(convert_to('whaleu-window-discussion-media-prepare:v1'||chr(10)||
 '{"protocol":"window-discussion-media-v1","actorAccountId":'||to_json(actor::text)::text||
 ',"clientRequestId":'||to_json(v->>'clientRequestId')::text||',"publicationRequestId":'||to_json(v->>'publicationRequestId')::text||
 ',"windowId":'||to_json(v->>'windowId')::text||',"catalogRevision":'||to_json(v->>'catalogRevision')::text||',"windowRevision":'||to_json(v->>'windowRevision')::text||
 ',"rootId":'||coalesce(to_json(v->>'rootId')::text,'null')||',"replyToReplyId":'||coalesce(to_json(v->>'replyToReplyId')::text,'null')||',"ordinal":'||(v->>'ordinal')||
 ',"declaration":{"mime":'||to_json(v->'declaration'->>'mime')::text||',"bytes":'||(v->'declaration'->>'bytes')||',"sha256":'||to_json(v->'declaration'->>'sha256')::text||'}}','UTF8')),'hex')
$$;
CREATE FUNCTION whaleu_media.window_discussion_context_hash(actor uuid,pub uuid,wid uuid,catalog uuid,revision uuid,root uuid,reply uuid,addressed uuid) RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT encode(sha256(convert_to('whaleu:window-discussion-media-context:v1'||chr(10)||whaleu_community.content_canonical_json(jsonb_build_object('actorId',actor::text,'publicationRequestId',pub::text,'windowId',wid::text,'catalogRevision',catalog::text,'windowRevision',revision::text,'rootId',root::text,'replyToReplyId',reply::text,'replyToActorId',addressed::text)),'UTF8')),'hex')
$$;
CREATE FUNCTION whaleu_media.window_discussion_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v jsonb:=NEW.input;source jsonb;target whaleu_ratings.window_discussion_comments;instant timestamptz:=clock_timestamp();BEGIN
 PERFORM whaleu_ratings.window_discussion_lock(NEW.actor_id,NEW.publication_request_id,NULL);
 source:=whaleu_ratings.window_discussion_source(NEW.window_id,instant);
 IF NEW.reply_to_reply_id IS NOT NULL THEN SELECT * INTO target FROM whaleu_ratings.window_discussion_comments WHERE id=NEW.reply_to_reply_id AND window_id=NEW.window_id AND root_id=NEW.root_id;END IF;
 IF NOT coalesce(whaleu_community.rating_scoped_keys(v,ARRAY['protocol','clientRequestId','publicationRequestId','windowId','catalogRevision','windowRevision','rootId','replyToReplyId','ordinal','declaration'])
 AND whaleu_community.rating_scoped_ids(v,ARRAY['clientRequestId','publicationRequestId','windowId','catalogRevision','windowRevision'])
 AND v->>'protocol'='window-discussion-media-v1' AND v->>'clientRequestId'=NEW.client_request_id::text AND v->>'windowId'=NEW.window_id::text AND v->>'publicationRequestId'=NEW.publication_request_id::text
 AND v->>'catalogRevision'=NEW.catalog_revision::text AND v->>'windowRevision'=NEW.window_revision::text
 AND v->'rootId'=coalesce(to_jsonb(NEW.root_id::text),'null'::jsonb) AND v->'replyToReplyId'=coalesce(to_jsonb(NEW.reply_to_reply_id::text),'null'::jsonb)
 AND whaleu_community.rating_scoped_integer(v->'ordinal',0) AND(v->>'ordinal')::integer=NEW.ordinal
 AND NEW.scope_revision=whaleu_media.window_discussion_request_hash(NEW.actor_id,v)
 AND whaleu_community.rating_scoped_keys(v->'declaration',ARRAY['mime','bytes','sha256']) AND v->'declaration'->>'mime' IN('image/jpeg','image/png')
 AND whaleu_community.rating_scoped_integer(v->'declaration'->'bytes',1) AND(v->'declaration'->>'bytes')::bigint BETWEEN 1 AND 5242880 AND jsonb_typeof(v->'declaration'->'sha256')='string' AND v->'declaration'->>'sha256' ~ '^[a-f0-9]{64}$'
 AND source->>'catalog'=NEW.catalog_revision::text AND source->>'revision'=NEW.window_revision::text AND source->>'population' IS NOT NULL AND source->>'likes' IS NOT NULL
 AND(NEW.root_id IS NULL OR EXISTS(SELECT 1 FROM whaleu_ratings.window_discussion_comments r WHERE r.id=NEW.root_id AND r.window_id=NEW.window_id AND r.root_id IS NULL AND whaleu_ratings.window_discussion_visibility(r.id,NEW.actor_id,instant)='allow'))
 AND(NEW.reply_to_reply_id IS NULL OR(target.id IS NOT NULL AND whaleu_ratings.window_discussion_visibility(target.id,NEW.actor_id,instant)='allow'))
 AND NEW.context_digest=whaleu_media.window_discussion_context_hash(NEW.actor_id,NEW.publication_request_id,NEW.window_id,NEW.catalog_revision,NEW.window_revision,NEW.root_id,NEW.reply_to_reply_id,target.actor_id)
 AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.window_discussion_commands r WHERE(r.actor_id,r.request_id)=(NEW.actor_id,NEW.publication_request_id))
 AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.window_discussion_media_cancels r WHERE(r.actor_id,r.request_id)=(NEW.actor_id,NEW.publication_request_id)),false)
 THEN RAISE EXCEPTION 'Window media requires exact current original publication scope' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE TRIGGER window_discussion_scope BEFORE INSERT ON whaleu_media.window_discussion_scopes FOR EACH ROW EXECUTE FUNCTION whaleu_media.window_discussion_scope_guard();
CREATE FUNCTION whaleu_media.window_discussion_intent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s whaleu_media.window_discussion_scopes;BEGIN
 SELECT * INTO s FROM whaleu_media.window_discussion_scopes WHERE id=NEW.resource_id AND actor_id=NEW.actor_id;
 IF s.id IS NULL OR(NEW.client_request_id,NEW.scope_revision,NEW.request_hash,NEW.expires_at,NEW.ordinal) IS DISTINCT FROM(s.client_request_id,s.scope_revision,s.scope_revision,s.expires_at,s.ordinal)
 OR NEW.declared_bytes<>(s.input->'declaration'->>'bytes')::bigint OR NEW.declared_mime<>s.input->'declaration'->>'mime' OR NEW.declared_sha256<>s.input->'declaration'->>'sha256'
 THEN RAISE EXCEPTION 'Window media intent must match exact immutable scope' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE TRIGGER window_discussion_intent BEFORE INSERT ON whaleu_media.upload_intents FOR EACH ROW WHEN(NEW.protocol_version=16) EXECUTE FUNCTION whaleu_media.window_discussion_intent_guard();
CREATE FUNCTION whaleu_media.window_discussion_namespace_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE f whaleu_media.upload_request_fences;i whaleu_media.upload_intents;actor uuid:=NEW.actor_id;request uuid;BEGIN
 IF TG_TABLE_NAME='ratings_discussion_batch_request_fences' THEN request:=NEW.batch_request_id;ELSE request:=NEW.client_request_id;END IF;
 SELECT * INTO f FROM whaleu_media.upload_request_fences WHERE actor_id=actor AND client_request_id=request;
 IF f.protocol_namespace IS DISTINCT FROM 16 THEN
 IF TG_TABLE_NAME='upload_intents' THEN IF NEW.protocol_version=16 THEN RAISE EXCEPTION 'Window media requires Media16 receipt' USING ERRCODE='23514';END IF;END IF;RETURN NULL;END IF;
 IF EXISTS(SELECT 1 FROM whaleu_media.profile_request_markers WHERE actor_id=actor AND client_request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_media.ratings_request_markers WHERE actor_id=actor AND client_request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_media.ratings_discussion_request_markers WHERE actor_id=actor AND client_request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_media.category_icon_request_markers WHERE actor_id=actor AND client_request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_media.ratings_discussion_batch_request_fences WHERE actor_id=actor AND batch_request_id=request)
 THEN RAISE EXCEPTION 'Window media receipt namespace is exclusive' USING ERRCODE='23514';END IF;
 IF f.intent_id IS NOT NULL THEN SELECT * INTO STRICT i FROM whaleu_media.upload_intents WHERE id=f.intent_id;
 IF i.protocol_version<>16 OR(i.actor_id,i.client_request_id,i.request_hash) IS DISTINCT FROM(actor,request,f.request_hash) THEN RAISE EXCEPTION 'Window media receipt mismatch' USING ERRCODE='23514';END IF;
 ELSE IF NOT EXISTS(SELECT 1 FROM whaleu_media.window_discussion_cancel_scopes s WHERE(s.actor_id,s.client_request_id,s.request_hash)=(actor,request,f.request_hash)) THEN RAISE EXCEPTION 'Window media cancellation receipt requires original command closure' USING ERRCODE='23514';END IF;END IF;
 IF TG_TABLE_NAME='upload_intents' THEN IF NEW.protocol_version<>16 OR f.intent_id IS DISTINCT FROM NEW.id THEN RAISE EXCEPTION 'Window media intent mismatch' USING ERRCODE='23514';END IF;END IF;RETURN NULL;
END$$;
DO $$DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['upload_intents','upload_request_fences','profile_request_markers','ratings_request_markers','ratings_discussion_request_markers','category_icon_request_markers','ratings_discussion_batch_request_fences'] LOOP
 EXECUTE format('CREATE CONSTRAINT TRIGGER window_discussion_namespace AFTER INSERT OR UPDATE ON whaleu_media.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_media.window_discussion_namespace_guard()',t);END LOOP;
END$$;
DROP TRIGGER media_binding_guard ON whaleu_media.bindings;
CREATE TRIGGER media_binding_guard BEFORE INSERT ON whaleu_media.bindings FOR EACH ROW WHEN(NEW.owner_kind NOT IN('verification','announcements','activities','organizations','school_configuration') AND NOT(NEW.owner_kind='ratings' AND NEW.resource_kind IN('rating_comment','rating_reply','category_icon')) AND NOT(NEW.owner_kind='errands' AND NEW.resource_kind='errand_image') AND NOT(NEW.owner_kind='messaging' AND NEW.resource_kind='private_message_image') AND NOT(NEW.owner_kind='ratings' AND NEW.resource_kind='window_discussion_image')) EXECUTE FUNCTION whaleu_media.binding_guard();
DROP TRIGGER media_scope_consumption_complete ON whaleu_media.scope_consumptions;
CREATE CONSTRAINT TRIGGER media_scope_consumption_complete AFTER INSERT ON whaleu_media.scope_consumptions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.owner_kind NOT IN('verification','announcements','activities','organizations','school_configuration') AND NOT(NEW.owner_kind='ratings' AND NEW.resource_kind IN('rating_comment','rating_reply','category_icon')) AND NOT(NEW.owner_kind='errands' AND NEW.resource_kind='errand_image') AND NOT(NEW.owner_kind='messaging' AND NEW.resource_kind='private_message_image') AND NOT(NEW.owner_kind='ratings' AND NEW.resource_kind='window_discussion_image')) EXECUTE FUNCTION whaleu_media.scope_consumption_complete();
CREATE FUNCTION whaleu_media.window_discussion_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a whaleu_media.assets;i whaleu_media.upload_intents;s whaleu_media.window_discussion_scopes;c whaleu_media.scope_consumptions;BEGIN
 SELECT * INTO STRICT a FROM whaleu_media.assets WHERE id=NEW.asset_id;SELECT * INTO STRICT i FROM whaleu_media.upload_intents WHERE id=a.intent_id;
 SELECT * INTO s FROM whaleu_media.window_discussion_scopes WHERE id=a.resource_id AND actor_id=a.actor_id;
 SELECT * INTO c FROM whaleu_media.scope_consumptions WHERE actor_id=a.actor_id AND owner_kind='ratings' AND resource_kind='window_discussion_image' AND scope_resource_id=a.resource_id;
 IF i.protocol_version<>16 OR i.state<>'ready' OR s.id IS NULL OR least(s.expires_at,a.created_at+interval '24 hours')<=clock_timestamp() OR NEW.detached_at IS NOT NULL
 OR(NEW.owner_kind,NEW.resource_kind,NEW.content_version,NEW.slot,NEW.ordinal,NEW.manifest_digest) IS DISTINCT FROM(a.owner_kind,a.resource_kind,a.content_version,a.slot,a.ordinal,a.manifest_digest)
 OR NEW.attach_evidence IS DISTINCT FROM jsonb_build_object('version',16,'scopeId',a.resource_id::text,'scopeRevision',a.scope_revision)
 OR c.transaction_id IS DISTINCT FROM pg_current_xact_id() OR c.resource_id IS DISTINCT FROM NEW.resource_id OR c.scope_revision IS DISTINCT FROM a.scope_revision OR c.content_version IS DISTINCT FROM 1::bigint
 OR c.attach_evidence IS DISTINCT FROM jsonb_build_object('version',16,'assets',jsonb_build_array(jsonb_build_object('assetId',a.id::text,'digest',a.manifest_digest)))
 OR NOT EXISTS(SELECT 1 FROM whaleu_media.asset_safety_heads h JOIN whaleu_media.asset_safety_events e ON(e.asset_id,e.revision,e.id)=(h.asset_id,h.revision,h.event_id) WHERE h.asset_id=a.id AND e.state='allow' AND e.manifest_digest=a.manifest_digest AND e.policy_revision=a.policy_revision AND e.effective_at<=clock_timestamp() AND e.valid_until>clock_timestamp())
 THEN RAISE EXCEPTION 'Window image requires exact current Media16 acceptance' USING ERRCODE='23514';END IF;
 IF TG_WHEN='AFTER' AND NOT EXISTS(SELECT 1 FROM whaleu_media.window_discussion_appearances p JOIN whaleu_ratings.window_discussion_comments msg ON msg.id=p.comment_id
 WHERE p.id=NEW.resource_id AND p.binding_id=NEW.id AND p.asset_id=a.id AND p.manifest_digest=a.manifest_digest AND p.ordinal=NEW.ordinal
 AND(p.actor_id,p.window_id,p.publication_request_id,p.context_digest,p.ordinal)=(s.actor_id,s.window_id,s.publication_request_id,s.context_digest,s.ordinal)
 AND(msg.actor_id,msg.window_id,msg.request_id,msg.catalog_id,msg.window_revision,msg.root_id,msg.reply_to_reply_id) IS NOT DISTINCT FROM(p.actor_id,p.window_id,p.publication_request_id,s.catalog_revision,s.window_revision,s.root_id,s.reply_to_reply_id)
 AND msg.publication_version=2 AND msg.transaction_id=pg_current_xact_id() AND p.publication_transaction=pg_current_xact_id()
 AND msg.image_set->p.ordinal=jsonb_build_object('assetId',a.id::text,'manifestDigest',a.manifest_digest))
 THEN RAISE EXCEPTION 'Window image binding requires atomic exact publication appearance' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE TRIGGER window_discussion_binding BEFORE INSERT ON whaleu_media.bindings FOR EACH ROW WHEN(NEW.resource_kind='window_discussion_image') EXECUTE FUNCTION whaleu_media.window_discussion_binding_guard();
CREATE CONSTRAINT TRIGGER window_discussion_binding_final AFTER INSERT ON whaleu_media.bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.resource_kind='window_discussion_image') EXECUTE FUNCTION whaleu_media.window_discussion_binding_guard();
CREATE FUNCTION whaleu_media.window_discussion_appearance_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.publication_transaction<>pg_current_xact_id() OR NOT EXISTS(SELECT 1 FROM whaleu_media.bindings b JOIN whaleu_media.assets a ON a.id=b.asset_id JOIN whaleu_media.window_discussion_scopes s ON s.id=a.resource_id JOIN whaleu_ratings.window_discussion_comments msg ON msg.id=NEW.comment_id
 WHERE b.id=NEW.binding_id AND b.resource_id=NEW.id AND b.asset_id=NEW.asset_id AND b.manifest_digest=NEW.manifest_digest AND b.resource_kind='window_discussion_image' AND b.owner_kind='ratings' AND b.ordinal=NEW.ordinal AND b.detached_at IS NULL
 AND(s.actor_id,s.window_id,s.publication_request_id,s.context_digest,s.ordinal)=(NEW.actor_id,NEW.window_id,NEW.publication_request_id,NEW.context_digest,NEW.ordinal)
 AND(msg.actor_id,msg.window_id,msg.request_id,msg.catalog_id,msg.window_revision,msg.root_id,msg.reply_to_reply_id) IS NOT DISTINCT FROM(NEW.actor_id,NEW.window_id,NEW.publication_request_id,s.catalog_revision,s.window_revision,s.root_id,s.reply_to_reply_id)
 AND msg.publication_version=2 AND msg.transaction_id=pg_current_xact_id() AND msg.image_set->NEW.ordinal=jsonb_build_object('assetId',a.id::text,'manifestDigest',a.manifest_digest)
 AND s.context_digest=whaleu_media.window_discussion_context_hash(msg.actor_id,msg.request_id,msg.window_id,msg.catalog_id,msg.window_revision,msg.root_id,msg.reply_to_reply_id,msg.reply_to_actor_id))
 THEN RAISE EXCEPTION 'Window appearance requires exact immutable owner and binding' USING ERRCODE='23514';END IF;RETURN NULL;
END$$;
CREATE CONSTRAINT TRIGGER window_discussion_appearance_final AFTER INSERT ON whaleu_media.window_discussion_appearances DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_media.window_discussion_appearance_guard();
CREATE FUNCTION whaleu_media.window_discussion_consumption_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.transaction_id<>pg_current_xact_id() OR NOT EXISTS(SELECT 1 FROM whaleu_media.bindings b JOIN whaleu_media.assets a ON a.id=b.asset_id JOIN whaleu_media.window_discussion_appearances p ON p.id=b.resource_id AND p.binding_id=b.id WHERE b.owner_kind='ratings' AND b.resource_kind='window_discussion_image' AND b.resource_id=NEW.resource_id AND b.detached_at IS NULL AND a.resource_id=NEW.scope_resource_id AND a.actor_id=NEW.actor_id AND a.scope_revision=NEW.scope_revision AND p.publication_transaction=pg_current_xact_id())
 THEN RAISE EXCEPTION 'Window media consumption requires atomic exact binding' USING ERRCODE='23514';END IF;RETURN NULL;
END$$;
CREATE CONSTRAINT TRIGGER window_discussion_consumption_final AFTER INSERT ON whaleu_media.scope_consumptions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.resource_kind='window_discussion_image') EXECUTE FUNCTION whaleu_media.window_discussion_consumption_guard();
CREATE FUNCTION whaleu_media.window_discussion_cancel_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_media.upload_request_fences f WHERE(f.actor_id,f.client_request_id,f.request_hash)=(NEW.actor_id,NEW.client_request_id,NEW.request_hash) AND f.protocol_namespace=16 AND f.intent_id IS NULL AND f.state='cancelled_before_prepare')
 THEN RAISE EXCEPTION 'Window upload cancellation requires its exact original key fence' USING ERRCODE='23514';END IF;RETURN NULL;
END$$;
CREATE CONSTRAINT TRIGGER window_discussion_cancel_final AFTER INSERT ON whaleu_media.window_discussion_cancel_scopes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_media.window_discussion_cancel_guard();
-- Neither temporary source loss nor upload expiry is authority to detach a bound
-- Window image. This slice deliberately defines no deletion/retirement cause.
CREATE FUNCTION whaleu_media.window_discussion_no_detach() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.detached_at IS NOT NULL THEN RAISE EXCEPTION 'Window bound image has no accepted retirement cause' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE TRIGGER window_discussion_no_detach BEFORE UPDATE ON whaleu_media.bindings FOR EACH ROW WHEN(OLD.resource_kind='window_discussion_image') EXECUTE FUNCTION whaleu_media.window_discussion_no_detach();
CREATE FUNCTION whaleu_media.window_discussion_bound_cleanup_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 -- The shared pipeline may finish removing staging or sealed input after
 -- publication. Protect exact delivery variants, regardless of cleanup origin.
 IF EXISTS(SELECT 1 FROM whaleu_media.variants v JOIN whaleu_media.assets a ON a.id=v.asset_id JOIN whaleu_media.bindings b ON b.asset_id=a.id
  WHERE a.owner_kind='ratings' AND a.resource_kind='window_discussion_image'
  AND(v.provider,v.environment,v.bucket,v.object_key,v.object_version)=(NEW.provider,NEW.environment,NEW.bucket,NEW.object_key,NEW.object_version))
 THEN RAISE EXCEPTION 'Window bound delivery variant has no accepted cleanup cause' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE TRIGGER window_discussion_bound_cleanup BEFORE INSERT OR UPDATE ON whaleu_media.cleanup_obligations FOR EACH ROW EXECUTE FUNCTION whaleu_media.window_discussion_bound_cleanup_guard();
-- Full-set proof for all Window projections, counts, ancestor visibility and notices.
-- Missing evidence is unavailable; only a current exact held/revoked Safety event
-- is denial. A good first image can never authorize a bad or missing sibling.
CREATE FUNCTION whaleu_media.window_discussion_set_status(cid uuid,instant timestamptz) RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE c whaleu_ratings.window_discussion_comments;p whaleu_media.window_discussion_appearances;a whaleu_media.assets;b whaleu_media.bindings;i whaleu_media.upload_intents;s whaleu_media.window_discussion_scopes;e whaleu_media.asset_safety_events;entry record;variants jsonb;denied boolean:=false;BEGIN
 SELECT * INTO c FROM whaleu_ratings.window_discussion_comments WHERE id=cid;
 IF c.id IS NULL OR NOT whaleu_ratings.window_discussion_images_valid(c.image_set) OR c.publication_version NOT IN(1,2) THEN RETURN 'unavailable';END IF;
 IF c.publication_version=1 AND c.image_set<>'[]'::jsonb THEN RETURN 'unavailable';END IF;
 IF(SELECT count(*) FROM whaleu_media.window_discussion_appearances WHERE comment_id=cid)<>jsonb_array_length(c.image_set) THEN RETURN 'unavailable';END IF;
 FOR entry IN SELECT value,ordinality-1 ordinal FROM jsonb_array_elements(c.image_set) WITH ORDINALITY LOOP
  SELECT * INTO p FROM whaleu_media.window_discussion_appearances WHERE comment_id=cid AND ordinal=entry.ordinal;
  IF p.id IS NULL OR(p.actor_id,p.window_id,p.publication_request_id) IS DISTINCT FROM(c.actor_id,c.window_id,c.request_id) OR entry.value IS DISTINCT FROM jsonb_build_object('assetId',p.asset_id::text,'manifestDigest',p.manifest_digest) OR p.publication_transaction<>c.transaction_id THEN RETURN 'unavailable';END IF;
  SELECT * INTO b FROM whaleu_media.bindings WHERE id=p.binding_id;SELECT * INTO a FROM whaleu_media.assets WHERE id=p.asset_id;
  IF b.id IS NULL OR a.id IS NULL OR (b.owner_kind,b.resource_kind,b.resource_id,b.asset_id,b.manifest_digest,b.content_version,b.slot,b.ordinal) IS DISTINCT FROM('ratings','window_discussion_image',p.id,p.asset_id,p.manifest_digest,1::bigint,'images',p.ordinal) OR b.detached_at IS NOT NULL THEN RETURN 'unavailable';END IF;
  IF(a.owner_kind,a.resource_kind,a.target_kind,a.content_version,a.audience,a.purpose,a.slot,a.ordinal,a.actor_id,a.manifest_digest) IS DISTINCT FROM('ratings','window_discussion_image','edit',1::bigint,'content-gated','window-discussion-image','images',p.ordinal,p.actor_id,p.manifest_digest)
   OR a.manifest_digest<>encode(sha256(convert_to(E'whaleu-media-manifest:v1\n'||whaleu_media.canonical_json(a.manifest),'UTF8')),'hex') THEN RETURN 'unavailable';END IF;
  SELECT jsonb_agg(jsonb_build_object('name',v.variant_name,'object',jsonb_build_object('provider',v.provider,'environment',v.environment,'bucket',v.bucket,'key',v.object_key,'version',v.object_version),'sha256',v.sha256,'mime',v.actual_mime,'bytes',v.bytes,'width',v.width,'height',v.height) ORDER BY CASE v.variant_name WHEN 'thumb-v1' THEN 0 ELSE 1 END) INTO variants FROM whaleu_media.variants v WHERE v.asset_id=a.id;
  -- complete_asset's deferred constraint already validates original schema,
  -- immutable exact objects and decoded dimensions. Re-match both immutable
  -- delivery rows and the entire manifest envelope in every whole-set read.
  IF(SELECT count(*) FROM whaleu_media.variants WHERE asset_id=a.id)<>2 OR a.policy_revision<>'media-static-v1'
   OR a.manifest IS DISTINCT FROM jsonb_build_object('version',1,'policyVersion','media-static-v1','transformVersion','static-reencode-v1','original',a.manifest->'original','variants',variants)
   OR EXISTS(SELECT 1 FROM whaleu_media.variants v WHERE v.asset_id=a.id AND v.transform_version<>'static-reencode-v1') THEN RETURN 'unavailable';END IF;
  SELECT * INTO s FROM whaleu_media.window_discussion_scopes WHERE id=a.resource_id;
  IF s.id IS NULL OR(s.actor_id,s.window_id,s.publication_request_id,s.catalog_revision,s.window_revision,s.root_id,s.reply_to_reply_id,s.ordinal,s.scope_revision,s.context_digest) IS DISTINCT FROM(c.actor_id,c.window_id,c.request_id,c.catalog_id,c.window_revision,c.root_id,c.reply_to_reply_id,p.ordinal,a.scope_revision,p.context_digest)
   OR p.context_digest<>whaleu_media.window_discussion_context_hash(c.actor_id,c.request_id,c.window_id,c.catalog_id,c.window_revision,c.root_id,c.reply_to_reply_id,c.reply_to_actor_id) THEN RETURN 'unavailable';END IF;
  SELECT * INTO i FROM whaleu_media.upload_intents WHERE id=a.intent_id;
  IF i.id IS NULL OR i.protocol_version<>16 OR i.state<>'ready' THEN RETURN 'unavailable';END IF;
  IF (SELECT count(*) FROM whaleu_media.bindings WHERE resource_id=p.id AND owner_kind='ratings' AND resource_kind='window_discussion_image')<>1 THEN RETURN 'unavailable';END IF;
  SELECT event.* INTO e FROM whaleu_media.asset_safety_heads h JOIN whaleu_media.asset_safety_events event ON(event.asset_id,event.revision,event.id)=(h.asset_id,h.revision,h.event_id) WHERE h.asset_id=a.id;
  IF e.id IS NULL OR e.manifest_digest<>a.manifest_digest OR e.policy_revision<>a.policy_revision OR e.effective_at>instant OR e.valid_until<=instant OR e.valid_until<=e.effective_at OR e.state='unknown' THEN RETURN 'unavailable';END IF;
  IF e.state IN('held','revoked') THEN denied:=true;ELSIF e.state<>'allow' THEN RETURN 'unavailable';END IF;
 END LOOP;
 RETURN CASE WHEN denied THEN 'deny' ELSE 'allow' END;
END$$;
CREATE FUNCTION whaleu_media.window_discussion_set_deadline(cid uuid) RETURNS timestamptz LANGUAGE sql STABLE AS $$
 SELECT min(e.valid_until) FROM whaleu_media.window_discussion_appearances p JOIN whaleu_media.asset_safety_heads h ON h.asset_id=p.asset_id JOIN whaleu_media.asset_safety_events e ON(e.asset_id,e.revision,e.id)=(h.asset_id,h.revision,h.event_id) WHERE p.comment_id=cid
$$;
CREATE FUNCTION whaleu_media.window_discussion_set_complete() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF whaleu_media.window_discussion_set_status(NEW.id,clock_timestamp())<>'allow' THEN RAISE EXCEPTION 'Window publication requires its complete current exact ordered image set' USING ERRCODE='23514';END IF;RETURN NULL;
END$$;
CREATE CONSTRAINT TRIGGER window_discussion_set_complete AFTER INSERT ON whaleu_ratings.window_discussion_comments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_media.window_discussion_set_complete();

-- The v1 verifier is preserved as an independent byte-domain branch.
CREATE OR REPLACE FUNCTION whaleu_ratings.window_discussion_complete(actor uuid,rid uuid) RETURNS void LANGUAGE plpgsql VOLATILE AS $$
DECLARE q whaleu_ratings.window_discussion_commands;c whaleu_ratings.window_discussion_comments;root whaleu_ratings.window_discussion_comments;target whaleu_ratings.window_discussion_comments;d whaleu_community.window_discussion_media_review_decisions;source jsonb;instant timestamptz;reply boolean;keys text[];BEGIN
 SELECT * INTO q FROM whaleu_ratings.window_discussion_commands WHERE actor_id=actor AND request_id=rid;
 IF EXISTS(SELECT 1 FROM whaleu_ratings.window_discussion_media_cancels WHERE actor_id=actor AND request_id=rid) THEN RAISE EXCEPTION 'Cancelled Window request cannot publish under any version' USING ERRCODE='23514',CONSTRAINT='window_discussion_causal';END IF;
 IF q.operation NOT IN('window.discussion.root.v2','window.discussion.reply.v2') THEN PERFORM whaleu_ratings.window_discussion_complete_v1(actor,rid);RETURN;END IF;
 PERFORM whaleu_ratings.window_discussion_fence();instant:=clock_timestamp();reply:=q.operation='window.discussion.reply.v2';
 IF q.request_id IS NULL OR q.transaction_id<>pg_current_xact_id() OR NOT whaleu_identity.window_rating_session(actor,q.session_id,instant) THEN RAISE EXCEPTION 'Window media publication requires current owner session and exact command' USING ERRCODE='23514',CONSTRAINT='window_discussion_causal';END IF;
 keys:=ARRAY['protocol','clientRequestId','expectedCatalogRevision','expectedWindowRevision','body','images']||CASE WHEN reply THEN ARRAY['replyToReplyId'] ELSE ARRAY[]::text[] END;
 IF NOT whaleu_community.rating_scoped_keys(q.command,keys) OR q.command->>'protocol' IS DISTINCT FROM 'window-discussion-v2' OR NOT whaleu_community.rating_scoped_ids(q.command,ARRAY['clientRequestId','expectedCatalogRevision','expectedWindowRevision']) OR jsonb_typeof(q.command->'body') IS DISTINCT FROM 'string' OR NOT whaleu_ratings.window_discussion_images_valid(q.command->'images') OR NOT((q.command->>'body'='' OR whaleu_ratings.window_discussion_body_valid(q.command->>'body')) AND(q.command->>'body'<>'' OR jsonb_array_length(q.command->'images')>0)) OR(reply AND q.command->'replyToReplyId'<>'null'::jsonb AND NOT whaleu_community.rating_scoped_ids(q.command,ARRAY['replyToReplyId'])) OR(reply AND q.receipt->>'rootId' IS DISTINCT FROM q.subject_id::text) THEN RAISE EXCEPTION 'Strict v2 Window image intent required' USING ERRCODE='23514',CONSTRAINT='window_discussion_causal';END IF;
 SELECT * INTO c FROM whaleu_ratings.window_discussion_comments WHERE actor_id=actor AND request_id=rid;
 IF EXISTS(SELECT 1 FROM whaleu_ratings.window_discussion_like_events WHERE actor_id=actor AND request_id=rid) OR EXISTS((SELECT recipient_id,kind,event_id,window_id,comment_id,root_id FROM whaleu_notifications.window_discussion_expected(actor,rid) EXCEPT SELECT recipient_id,kind,event_id,window_id,comment_id,root_id FROM whaleu_notifications.window_discussion_notices WHERE actor_id=actor AND request_id=rid) UNION ALL(SELECT recipient_id,kind,event_id,window_id,comment_id,root_id FROM whaleu_notifications.window_discussion_notices WHERE actor_id=actor AND request_id=rid EXCEPT SELECT recipient_id,kind,event_id,window_id,comment_id,root_id FROM whaleu_notifications.window_discussion_expected(actor,rid))) OR EXISTS(SELECT 1 FROM whaleu_notifications.window_discussion_notices WHERE actor_id=actor AND request_id=rid AND(transaction_id<>pg_current_xact_id() OR created_at<>date_trunc('milliseconds',transaction_timestamp()))) THEN RAISE EXCEPTION 'Exact atomic v2 publication and notice obligations required' USING ERRCODE='23514',CONSTRAINT='window_discussion_causal';END IF;
 IF q.receipt->>'outcome'='rejected' THEN
  keys:=ARRAY['requestId','operation','windowId','outcome','code']||CASE WHEN reply THEN ARRAY['rootId'] ELSE ARRAY[]::text[] END;
  IF NOT whaleu_community.rating_scoped_keys(q.receipt,keys) OR c.id IS NOT NULL OR EXISTS(SELECT 1 FROM whaleu_media.window_discussion_appearances WHERE actor_id=actor AND publication_request_id=rid) THEN RAISE EXCEPTION 'V2 rejection has no publication or bindings' USING ERRCODE='23514',CONSTRAINT='window_discussion_causal';END IF;
 END IF;
 IF NOT whaleu_ratings.window_access(actor,q.session_id,instant) THEN RAISE EXCEPTION 'Fresh Window images need phone and Safety' USING ERRCODE='23514',CONSTRAINT='window_discussion_causal';END IF;
 source:=whaleu_ratings.window_discussion_source(q.window_id,instant);
 IF source IS NULL OR source->>'population' IS NULL OR source->>'likes' IS NULL THEN RAISE EXCEPTION 'Independent Window histories required' USING ERRCODE='23514',CONSTRAINT='window_discussion_causal';END IF;
 IF q.receipt->>'outcome'='rejected' AND q.receipt->>'code'='WINDOW_REVISION_CONFLICT' THEN
  IF(source->>'catalog',source->>'revision') IS NOT DISTINCT FROM(q.command->>'expectedCatalogRevision',q.command->>'expectedWindowRevision') THEN RAISE EXCEPTION 'V2 source conflict must be causal' USING ERRCODE='23514',CONSTRAINT='window_discussion_causal';END IF;RETURN;
 END IF;
 IF(source->>'catalog',source->>'revision') IS DISTINCT FROM(q.command->>'expectedCatalogRevision',q.command->>'expectedWindowRevision') THEN RAISE EXCEPTION 'Current exact Window source required' USING ERRCODE='23514',CONSTRAINT='window_discussion_causal';END IF;
 IF reply THEN
  SELECT * INTO root FROM whaleu_ratings.window_discussion_comments WHERE id=q.subject_id AND window_id=q.window_id AND root_id IS NULL;
  IF root.id IS NULL OR whaleu_ratings.window_discussion_visibility(root.id,actor,instant)<>'allow' THEN RAISE EXCEPTION 'V2 reply requires current same-window root and whole image set' USING ERRCODE='23514',CONSTRAINT='window_discussion_causal';END IF;
  IF q.command->>'replyToReplyId' IS NOT NULL THEN
   SELECT * INTO target FROM whaleu_ratings.window_discussion_comments WHERE id=(q.command->>'replyToReplyId')::uuid AND window_id=q.window_id AND root_id=root.id;
   IF target.id IS NULL OR whaleu_ratings.window_discussion_visibility(target.id,actor,instant)<>'allow' THEN RAISE EXCEPTION 'V2 addressed reply requires same-root current subject' USING ERRCODE='23514',CONSTRAINT='window_discussion_causal';END IF;
  END IF;
 END IF;
 SELECT decisions.* INTO d FROM whaleu_community.window_discussion_media_review_decisions decisions JOIN whaleu_community.window_discussion_media_review_heads h ON h.decision_id=decisions.id WHERE h.actor_id=actor AND h.request_id=rid;
 IF d.id IS NULL OR(d.actor_id,d.request_id,d.window_id,d.catalog_id::text,d.window_revision::text,d.purpose,d.root_id,d.reply_to_reply_id,d.reply_to_actor_id,d.body,d.images) IS DISTINCT FROM(actor,rid,q.window_id,q.command->>'expectedCatalogRevision',q.command->>'expectedWindowRevision',q.operation,root.id,target.id,target.actor_id,q.command->>'body',q.command->'images') THEN RAISE EXCEPTION 'Exact original v2 ordered-set Review required' USING ERRCODE='23514',CONSTRAINT='window_discussion_causal';END IF;
 IF q.receipt->>'outcome'='rejected' AND q.receipt->>'code'='CONTENT_REJECTED' AND whaleu_community.window_discussion_media_review_status(d.id,true,instant)='reject' THEN RETURN;END IF;
 keys:=ARRAY['requestId','operation','windowId','outcome','commentId','createdAt']||CASE WHEN reply THEN ARRAY['rootId'] ELSE ARRAY[]::text[] END;
 IF q.receipt->>'outcome' IS DISTINCT FROM 'applied' OR NOT whaleu_community.rating_scoped_keys(q.receipt,keys) OR c.id IS NULL OR(c.publication_version,c.window_id,c.root_id,c.reply_to_reply_id,c.reply_to_actor_id,c.body,c.image_set,c.catalog_id::text,c.window_revision::text,c.population_assertion_id::text,c.media_review_decision_id) IS DISTINCT FROM(2,q.window_id,root.id,target.id,target.actor_id,q.command->>'body',q.command->'images',source->>'catalog',source->>'revision',source->>'population',d.id) OR c.transaction_id<>pg_current_xact_id() OR c.created_at<>date_trunc('milliseconds',transaction_timestamp()) OR q.receipt->>'commentId' IS DISTINCT FROM c.id::text OR q.receipt->>'createdAt' IS DISTINCT FROM to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') OR whaleu_community.window_discussion_media_review_status(d.id,true,instant)<>'allow' OR whaleu_media.window_discussion_set_status(c.id,instant)<>'allow' OR NOT EXISTS(SELECT 1 FROM whaleu_profile.profiles WHERE account_id=actor) THEN RAISE EXCEPTION 'V2 publication needs atomic exact content, images, bindings, Review and receipt' USING ERRCODE='23514',CONSTRAINT='window_discussion_causal';END IF;
END$$;
CREATE OR REPLACE FUNCTION whaleu_ratings.window_discussion_visibility_base(cid uuid,viewer uuid,instant timestamptz) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT CASE WHEN r.status IN('deny','reject') OR s.status='deny' OR m.status='deny' THEN 'deny' WHEN r.status='allow' AND s.status='allow' AND m.status='allow' AND whaleu_profile.window_discussion_display_known(c.actor_id) THEN 'allow' ELSE 'unavailable' END FROM whaleu_ratings.window_discussion_comments c CROSS JOIN LATERAL(SELECT CASE WHEN c.publication_version=1 THEN whaleu_community.window_discussion_review_status(c.review_decision_id,false,instant) ELSE whaleu_community.window_discussion_media_review_status(c.media_review_decision_id,false,instant) END status) r CROSS JOIN LATERAL(SELECT whaleu_safety.window_discussion_named(viewer,c.actor_id,instant) status) s CROSS JOIN LATERAL(SELECT CASE WHEN c.publication_version=1 THEN 'allow' ELSE whaleu_media.window_discussion_set_status(c.id,instant) END status) m WHERE c.id=cid),'unavailable')
$$;

CREATE OR REPLACE FUNCTION whaleu_ratings.window_discussion_fence() RETURNS void LANGUAGE plpgsql VOLATILE AS $$BEGIN
 PERFORM whaleu_ratings.window_fence();
 LOCK TABLE whaleu_ratings.window_discussion_media_cancels,whaleu_community.window_discussion_media_review_policies,whaleu_community.window_discussion_media_review_decisions,whaleu_community.window_discussion_media_review_heads,whaleu_media.window_discussion_scopes,whaleu_media.window_discussion_cancel_scopes,whaleu_media.window_discussion_appearances,whaleu_media.media_owner_states IN SHARE MODE NOWAIT;
 LOCK TABLE whaleu_ratings.window_discussion_history_assertions,whaleu_ratings.window_discussion_history_heads,whaleu_ratings.window_discussion_comments,whaleu_ratings.window_discussion_like_events,whaleu_ratings.window_discussion_like_heads,whaleu_ratings.window_discussion_commands,whaleu_ratings.window_discussion_epoch,whaleu_community.window_discussion_review_policies,whaleu_community.window_discussion_review_decisions,whaleu_community.window_discussion_review_heads,whaleu_community.window_discussion_review_epoch,whaleu_safety.blocks,whaleu_profile.profiles,whaleu_notifications.window_discussion_notices IN SHARE MODE NOWAIT;
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.window_discussion_epoch WHERE singleton) OR NOT EXISTS(SELECT 1 FROM whaleu_community.window_discussion_review_epoch WHERE singleton) THEN RAISE EXCEPTION 'Window discussion epochs unavailable' USING ERRCODE='23514',CONSTRAINT='window_discussion_causal';END IF;
END$$;
CREATE FUNCTION whaleu_ratings.window_discussion_deadline_v1(wid uuid,instant timestamptz) RETURNS timestamptz LANGUAGE sql STABLE AS $$
 SELECT min(value) FROM(
 SELECT boundary.value FROM whaleu_ratings.window_discussion_history_heads h JOIN whaleu_ratings.window_discussion_history_assertions a ON a.id=h.assertion_id CROSS JOIN LATERAL(VALUES(a.accepted_at),(a.valid_until)) boundary(value) WHERE h.window_id=wid AND boundary.value>instant
 UNION ALL SELECT boundary.value FROM whaleu_ratings.window_discussion_comments c JOIN whaleu_community.window_discussion_review_decisions d ON d.id=c.review_decision_id JOIN whaleu_community.window_discussion_review_policies p ON p.id=d.policy_id LEFT JOIN whaleu_safety.account_heads s ON s.account_id=c.actor_id CROSS JOIN LATERAL(VALUES(d.issued_at),(d.visibility_until),(p.valid_from),(p.valid_until),(s.valid_until)) boundary(value) WHERE c.window_id=wid AND boundary.value>instant
 ) boundaries
$$;
CREATE OR REPLACE FUNCTION whaleu_ratings.window_discussion_deadline(wid uuid,instant timestamptz) RETURNS timestamptz LANGUAGE sql STABLE AS $$
 SELECT min(value) FROM(
 SELECT whaleu_ratings.window_discussion_deadline_v1(wid,instant) value
 UNION ALL SELECT boundary.value FROM whaleu_ratings.window_discussion_comments c JOIN whaleu_community.window_discussion_media_review_decisions d ON d.id=c.media_review_decision_id JOIN whaleu_community.window_discussion_media_review_policies p ON p.id=d.policy_id LEFT JOIN whaleu_safety.account_heads s ON s.account_id=c.actor_id CROSS JOIN LATERAL(VALUES(d.issued_at),(d.visibility_until),(p.valid_from),(p.valid_until),(s.valid_until)) boundary(value) WHERE c.window_id=wid AND boundary.value>instant
 UNION ALL SELECT boundary.value FROM whaleu_media.window_discussion_appearances a JOIN whaleu_media.asset_safety_heads h ON h.asset_id=a.asset_id JOIN whaleu_media.asset_safety_events e ON e.id=h.event_id CROSS JOIN LATERAL(VALUES(e.effective_at),(e.valid_until)) boundary(value) WHERE a.window_id=wid AND boundary.value>instant
 ) boundaries
$$;
