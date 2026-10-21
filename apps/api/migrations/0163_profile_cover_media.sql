-- Independent Profile cover protocol 18. No legacy rows, providers or policy
-- approvals are changed or seeded. The cover owner has its own revision domain.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));

ALTER TABLE whaleu_media.upload_request_fences DROP CONSTRAINT upload_request_fences_protocol_namespace_check;
ALTER TABLE whaleu_media.upload_request_fences ADD CONSTRAINT upload_request_fences_protocol_namespace_check CHECK(protocol_namespace IS NULL OR protocol_namespace IN(8,9,10,11,12,13,14,15,16,17,18));
ALTER TABLE whaleu_media.upload_intents DROP CONSTRAINT media_protocol_identity;
ALTER TABLE whaleu_media.upload_intents ADD CONSTRAINT media_protocol_identity CHECK(
 (protocol_version=1 AND request_hash IS NULL AND declared_sha256 IS NULL) OR
 (protocol_version IN(2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18) AND request_hash IS NOT NULL AND declared_sha256 IS NOT NULL));
ALTER TABLE whaleu_media.upload_intents DROP CONSTRAINT media_profile_scope;
ALTER TABLE whaleu_media.upload_intents ADD CONSTRAINT media_profile_scope CHECK(
 (protocol_version=5 AND owner_kind='profile' AND resource_kind='avatar' AND audience='profile-public' AND target_kind='edit' AND content_version=1 AND slot='avatar' AND ordinal=0 AND purpose='profile-avatar-image') OR
 (protocol_version=18 AND owner_kind='profile' AND resource_kind='cover' AND audience='profile-public' AND target_kind='edit' AND content_version=1 AND slot='cover' AND ordinal=0 AND purpose='profile-cover-image') OR
 (protocol_version NOT IN(5,18) AND owner_kind<>'profile' AND(target_kind<>'edit' OR protocol_version IN(6,8,9,10,11,12,13,14,15,16,17)) AND audience<>'profile-public' AND purpose NOT IN('profile-avatar-image','profile-cover-image')));
ALTER TABLE whaleu_media.assets DROP CONSTRAINT media_profile_asset_scope;
ALTER TABLE whaleu_media.assets ADD CONSTRAINT media_profile_asset_scope CHECK(
 (owner_kind='profile' AND resource_kind='avatar' AND audience='profile-public' AND target_kind='edit' AND content_version=1 AND slot='avatar' AND ordinal=0 AND purpose='profile-avatar-image') OR
 (owner_kind='profile' AND resource_kind='cover' AND audience='profile-public' AND target_kind='edit' AND content_version=1 AND slot='cover' AND ordinal=0 AND purpose='profile-cover-image') OR
 (owner_kind<>'profile' AND(target_kind<>'edit' OR owner_kind IN('ratings','school_configuration','organizations','activities','announcements','verification','errands','messaging','majors')) AND audience<>'profile-public' AND purpose NOT IN('profile-avatar-image','profile-cover-image')));
ALTER TABLE whaleu_media.bindings DROP CONSTRAINT media_profile_binding_slot;
ALTER TABLE whaleu_media.bindings ADD CONSTRAINT media_profile_binding_slot CHECK(owner_kind<>'profile' OR
 (resource_kind='avatar' AND content_version=1 AND slot='avatar' AND ordinal=0) OR
 (resource_kind='cover' AND content_version=1 AND slot='cover' AND ordinal=0));
ALTER TABLE whaleu_media.scope_consumptions ADD CONSTRAINT media_profile_consumption_scope CHECK(owner_kind<>'profile' OR (resource_kind IN('avatar','cover') AND content_version=1));

CREATE TABLE whaleu_media.profile_cover_request_markers (
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),client_request_id uuid NOT NULL,
 request_hash whaleu_media.digest NOT NULL,PRIMARY KEY(actor_id,client_request_id),
 FOREIGN KEY(actor_id,client_request_id) REFERENCES whaleu_media.upload_request_fences(actor_id,client_request_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TRIGGER a0_media_policy_gate BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_media.profile_cover_request_markers FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_policy_writer_gate();
CREATE TRIGGER a1_media_owner_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_media.profile_cover_request_markers FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.advance_owner_epoch();
CREATE TRIGGER media_retain BEFORE TRUNCATE ON whaleu_media.profile_cover_request_markers FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.immutable_record();
CREATE TRIGGER media_immutable BEFORE UPDATE OR DELETE ON whaleu_media.profile_cover_request_markers FOR EACH ROW EXECUTE FUNCTION whaleu_media.immutable_record();

-- Both absent-intent cancellation and prepared intents retain exact protocol
-- identity. Every competing marker write participates, including a late legacy
-- tombstone written after the cover marker. A marker never grants bytes.
CREATE FUNCTION whaleu_media.profile_cover_request_consistent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE marker whaleu_media.profile_cover_request_markers;f whaleu_media.upload_request_fences;i whaleu_media.upload_intents;actor uuid:=NEW.actor_id;request uuid;
BEGIN
 IF TG_TABLE_NAME='ratings_discussion_batch_request_fences' THEN request:=NEW.batch_request_id;ELSE request:=NEW.client_request_id;END IF;
 SELECT * INTO marker FROM whaleu_media.profile_cover_request_markers WHERE actor_id=actor AND client_request_id=request;
 SELECT * INTO f FROM whaleu_media.upload_request_fences WHERE actor_id=actor AND client_request_id=request;
 IF marker.actor_id IS NULL THEN
  IF f.protocol_namespace=18 THEN RAISE EXCEPTION 'Cover fence requires exact Media18 marker' USING ERRCODE='23514';END IF;
  IF TG_TABLE_NAME='upload_intents' THEN
   IF NEW.protocol_version=18 THEN RAISE EXCEPTION 'Cover intent requires Media18 marker' USING ERRCODE='23514';END IF;
  END IF;
  RETURN NULL;
 END IF;
 IF f.actor_id IS NULL OR f.protocol_namespace IS DISTINCT FROM 18 OR f.request_hash IS DISTINCT FROM marker.request_hash
 OR EXISTS(SELECT 1 FROM whaleu_media.profile_request_markers WHERE actor_id=actor AND client_request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_media.ratings_request_markers WHERE actor_id=actor AND client_request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_media.ratings_discussion_request_markers WHERE actor_id=actor AND client_request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_media.category_icon_request_markers WHERE actor_id=actor AND client_request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_media.ratings_discussion_batch_request_fences WHERE actor_id=actor AND batch_request_id=request)
 THEN RAISE EXCEPTION 'Cover requires exclusive exact Media18 shared request namespace' USING ERRCODE='23514';END IF;
 IF f.intent_id IS NOT NULL THEN
  SELECT * INTO STRICT i FROM whaleu_media.upload_intents WHERE id=f.intent_id;
  IF i.protocol_version<>18 OR (i.actor_id,i.client_request_id,i.request_hash) IS DISTINCT FROM(actor,request,marker.request_hash)
  THEN RAISE EXCEPTION 'Cover request protocol mismatch' USING ERRCODE='23514';END IF;
 END IF;
 IF TG_TABLE_NAME='upload_intents' THEN
  IF NEW.protocol_version<>18 OR f.intent_id IS DISTINCT FROM NEW.id THEN
   RAISE EXCEPTION 'Cover intent requires its original exact request fence' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NULL;
END $$;
DO $$DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['profile_cover_request_markers','upload_intents','upload_request_fences','profile_request_markers','ratings_request_markers','ratings_discussion_request_markers','category_icon_request_markers','ratings_discussion_batch_request_fences'] LOOP
  EXECUTE format('CREATE CONSTRAINT TRIGGER media18_request_consistent AFTER INSERT OR UPDATE ON whaleu_media.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_media.profile_cover_request_consistent()',t);
 END LOOP;
END $$;

CREATE FUNCTION whaleu_media.profile_cover_intent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_profile.cover_edits e WHERE e.id=NEW.resource_id AND e.actor_id=NEW.actor_id
  AND e.client_request_id=NEW.client_request_id AND e.scope_revision=NEW.scope_revision
  AND e.request_hash=NEW.request_hash AND e.declaration=jsonb_build_object('mime',NEW.declared_mime,'bytes',NEW.declared_bytes,'sha256',NEW.declared_sha256)
  AND e.expires_at=NEW.expires_at) THEN
  RAISE EXCEPTION 'Cover intent requires exact immutable cover edit' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER media_profile_cover_intent BEFORE INSERT ON whaleu_media.upload_intents FOR EACH ROW WHEN(NEW.protocol_version=18) EXECUTE FUNCTION whaleu_media.profile_cover_intent_guard();

-- Keep the latest avatar moderation and retention implementations intact. Their
-- old broad owner routing must not run against this independent cover resource.
DROP TRIGGER avatar_media_complete ON whaleu_media.bindings;
CREATE CONSTRAINT TRIGGER avatar_media_complete AFTER INSERT OR UPDATE ON whaleu_media.bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.owner_kind='profile' AND NEW.resource_kind='avatar') EXECUTE FUNCTION whaleu_profile.avatar_definition_complete();
DROP TRIGGER media_profile_binding_retention ON whaleu_media.bindings;
CREATE TRIGGER media_profile_binding_retention BEFORE INSERT ON whaleu_media.bindings FOR EACH ROW WHEN(NEW.owner_kind='profile' AND NEW.resource_kind='avatar') EXECUTE FUNCTION whaleu_media.profile_binding_retention_guard();
DROP TRIGGER media_profile_binding_retention_final ON whaleu_media.bindings;
CREATE CONSTRAINT TRIGGER media_profile_binding_retention_final AFTER INSERT ON whaleu_media.bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.owner_kind='profile' AND NEW.resource_kind='avatar') EXECUTE FUNCTION whaleu_media.profile_binding_retention_guard();

-- The shared binding_guard remains enabled for cover: it still proves current
-- Safety, exact ready asset, ordinal and same-transaction scope consumption.
-- Add the cover-specific edit deadline and immutable version18 evidence before
-- insertion and again after all deferred transaction waits.
CREATE FUNCTION whaleu_media.profile_cover_binding_retention_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a whaleu_media.assets;i whaleu_media.upload_intents;deadline timestamptz;approved boolean;
BEGIN
 SELECT * INTO STRICT a FROM whaleu_media.assets WHERE id=NEW.asset_id;
 SELECT * INTO STRICT i FROM whaleu_media.upload_intents WHERE id=a.intent_id;
 SELECT least(a.created_at+interval '24 hours',e.expires_at) INTO deadline FROM whaleu_profile.cover_edits e
  WHERE e.id=a.resource_id AND e.actor_id=a.actor_id AND e.scope_revision=a.scope_revision;
 SELECT e.state='allow' AND e.effective_at<=clock_timestamp() AND e.valid_until>clock_timestamp()
  AND e.manifest_digest=a.manifest_digest AND e.policy_revision=a.policy_revision INTO approved
 FROM whaleu_media.asset_safety_heads h JOIN whaleu_media.asset_safety_events e ON(e.asset_id,e.revision,e.id)=(h.asset_id,h.revision,h.event_id) WHERE h.asset_id=a.id;
 IF deadline IS NULL OR deadline<=clock_timestamp() OR i.protocol_version<>18 OR i.state<>'ready' OR approved IS DISTINCT FROM true
 OR (a.owner_kind,a.resource_kind,a.target_kind,a.content_version,a.slot,a.ordinal,a.purpose,a.audience) IS DISTINCT FROM('profile','cover','edit',1::bigint,'cover',0,'profile-cover-image','profile-public')
 OR NEW.attach_evidence IS DISTINCT FROM jsonb_build_object('version',18,'scopeId',a.resource_id::text,'scopeRevision',a.scope_revision) THEN
  RAISE EXCEPTION 'Cover binding requires live exact cover edit, Safety and version18 evidence' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER media_profile_cover_binding_retention BEFORE INSERT ON whaleu_media.bindings FOR EACH ROW WHEN(NEW.owner_kind='profile' AND NEW.resource_kind='cover') EXECUTE FUNCTION whaleu_media.profile_cover_binding_retention_guard();
CREATE CONSTRAINT TRIGGER media_profile_cover_binding_retention_final AFTER INSERT ON whaleu_media.bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.owner_kind='profile' AND NEW.resource_kind='cover') EXECUTE FUNCTION whaleu_media.profile_cover_binding_retention_guard();

-- Preserve every existing Media17 exclusion and all old owner paths. Cover uses
-- its separate atomic completion guard rather than avatar's shared branch.
DROP TRIGGER media_scope_consumption_complete ON whaleu_media.scope_consumptions;
CREATE CONSTRAINT TRIGGER media_scope_consumption_complete AFTER INSERT ON whaleu_media.scope_consumptions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.owner_kind NOT IN('verification','announcements','activities','organizations','school_configuration') AND NOT(NEW.owner_kind='ratings' AND NEW.resource_kind IN('rating_comment','rating_reply','category_icon')) AND NOT(NEW.owner_kind='errands' AND NEW.resource_kind='errand_image') AND NOT(NEW.owner_kind='messaging' AND NEW.resource_kind='private_message_image') AND NOT(NEW.owner_kind='ratings' AND NEW.resource_kind='window_discussion_image') AND NOT(NEW.owner_kind='majors' AND NEW.resource_kind='major_discussion_image') AND NOT(NEW.owner_kind='profile' AND NEW.resource_kind='cover')) EXECUTE FUNCTION whaleu_media.scope_consumption_complete();
CREATE FUNCTION whaleu_media.profile_cover_scope_consumption_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cover_assets jsonb;
BEGIN
 SELECT jsonb_agg(jsonb_build_object('assetId',a.id::text,'digest',a.manifest_digest) ORDER BY b.ordinal)
  INTO cover_assets FROM whaleu_media.assets a JOIN whaleu_media.bindings b ON b.asset_id=a.id
  JOIN whaleu_media.upload_intents i ON i.id=a.intent_id
  WHERE a.actor_id=NEW.actor_id AND a.owner_kind='profile' AND a.resource_kind='cover'
   AND a.target_kind='edit' AND a.resource_id=NEW.scope_resource_id AND a.scope_revision=NEW.scope_revision
   AND i.protocol_version=18 AND b.owner_kind='profile' AND b.resource_kind='cover' AND b.resource_id=NEW.resource_id
   AND b.content_version=1 AND b.slot='cover' AND b.ordinal=0 AND b.detached_at IS NULL;
 IF NEW.content_version<>1 OR NEW.transaction_id<>pg_current_xact_id() OR cover_assets IS NULL OR jsonb_array_length(cover_assets)<>1
  OR NEW.attach_evidence IS DISTINCT FROM jsonb_build_object('version',18,'operation','select_cover','assets',cover_assets) THEN
  RAISE EXCEPTION 'Cover edit requires atomic exact single cover binding' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER media_profile_cover_scope_complete AFTER INSERT ON whaleu_media.scope_consumptions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.owner_kind='profile' AND NEW.resource_kind='cover') EXECUTE FUNCTION whaleu_media.profile_cover_scope_consumption_complete();

-- Extend only the exact fresh caller-owned source/purpose registrations. All
-- existing policy branches, cold cancellation behavior and cleanup are retained.
CREATE OR REPLACE FUNCTION whaleu_safety.account_policy_consumer_keys(relation text) RETURNS text[] LANGUAGE plpgsql IMMUTABLE STRICT AS $$BEGIN
 CASE relation
 WHEN 'whaleu_profile.cover_edits','whaleu_profile.cover_command_receipts' THEN RETURN ARRAY['actor_id','client_request_id'];
 WHEN 'whaleu_ratings.course_commands' THEN RETURN ARRAY['actor_id','request_id'];
 WHEN 'whaleu_ratings.course_comment_commands' THEN RETURN ARRAY['actor_id','request_id'];
 WHEN 'whaleu_ratings.window_commands' THEN RETURN ARRAY['actor_id','request_id'];
 WHEN 'whaleu_ratings.dish_commands' THEN RETURN ARRAY['actor_id','request_id'];
 WHEN 'whaleu_ratings.floor_commands' THEN RETURN ARRAY['actor_id','request_id'];
 WHEN 'whaleu_ratings.window_discussion_commands' THEN RETURN ARRAY['actor_id','request_id'];
 WHEN 'whaleu_majors.major_discussion_commands' THEN RETURN ARRAY['actor_id','request_id'];
 WHEN 'whaleu_majors.major_discussion_delete_commands' THEN RETURN ARRAY['actor_id','request_id'];
 WHEN 'whaleu_community.post_pin_commands' THEN RETURN ARRAY['actor_id','request_id'];
 WHEN 'whaleu_community.post_owner_visibility_commands' THEN RETURN ARRAY['actor_id','request_id'];
 WHEN 'whaleu_community.post_category_commands' THEN RETURN ARRAY['actor_id','request_id'];
 WHEN 'whaleu_profile.moderation_commands' THEN RETURN ARRAY['actor_id','request_id'];
 WHEN 'whaleu_profile.avatar_moderation_commands' THEN RETURN ARRAY['actor_id','request_id'];
 WHEN 'whaleu_community.admin_post_removal_commands' THEN RETURN ARRAY['actor_id','request_id'];
 WHEN 'whaleu_community.admin_discussion_removal_commands' THEN RETURN ARRAY['actor_id','request_id'];
 WHEN 'whaleu_authorization.school_admin_management_commands' THEN RETURN ARRAY['actor_id','request_id'];
 WHEN 'whaleu_community.region_policy_commands' THEN RETURN ARRAY['actor_id','client_request_id'];
 WHEN 'whaleu_experience.requests' THEN RETURN ARRAY['owner_id','request_id'];
 WHEN 'whaleu_experience.maintenance_requests' THEN RETURN ARRAY['actor_id','request_id'];
 WHEN 'whaleu_ratings.scoped_command_preparations' THEN RETURN ARRAY['account_id','request_id'];
 WHEN 'whaleu_ratings.scoped_command_outcomes' THEN RETURN ARRAY['account_id','request_id'];
 WHEN 'whaleu_community.publication_requests' THEN RETURN ARRAY['account_id','client_request_id'];
 WHEN 'whaleu_community.poll_ballot_requests' THEN RETURN ARRAY['account_id','client_request_id'];
 WHEN 'whaleu_community.discussion_requests' THEN RETURN ARRAY['account_id','client_request_id'];
 WHEN 'whaleu_community.trading_requests' THEN RETURN ARRAY['account_id','client_request_id'];
 WHEN 'whaleu_community.formation_requests' THEN RETURN ARRAY['account_id','client_request_id'];
 WHEN 'whaleu_community.saved_requests' THEN RETURN ARRAY['account_id','client_request_id'];
 WHEN 'whaleu_community.post_like_requests' THEN RETURN ARRAY['account_id','client_request_id'];
 WHEN 'whaleu_ratings.requests' THEN RETURN ARRAY['account_id','request_id'];
 WHEN 'whaleu_errands.requests' THEN RETURN ARRAY['account_id','request_id'];
 WHEN 'whaleu_messaging.requests' THEN RETURN ARRAY['account_id','request_id'];
 WHEN 'whaleu_safety.errand_restriction_requests' THEN RETURN ARRAY['account_id','request_id'];
 WHEN 'whaleu_safety.requests' THEN RETURN ARRAY['account_id','client_request_id'];
 WHEN 'whaleu_safety.report_requests' THEN RETURN ARRAY['account_id','client_request_id'];
 WHEN 'whaleu_campus.identity_selection_requests' THEN RETURN ARRAY['account_id','client_request_id'];
 WHEN 'whaleu_profile.avatar_command_receipts' THEN RETURN ARRAY['actor_id','client_request_id'];
 WHEN 'whaleu_verification.student_requests' THEN RETURN ARRAY['actor_id','client_request_id'];
 WHEN 'whaleu_organizations.organization_requests' THEN RETURN ARRAY['actor_id','client_request_id'];
 WHEN 'whaleu_school_configuration.requests' THEN RETURN ARRAY['actor_id','client_request_id'];
 WHEN 'whaleu_activities.publication_receipts' THEN RETURN ARRAY['actor_id','client_request_id'];
 WHEN 'whaleu_announcements.native_requests' THEN RETURN ARRAY['actor_id','client_request_id'];
 WHEN 'whaleu_profile.avatar_edits' THEN RETURN ARRAY['actor_id','client_request_id'];
 WHEN 'whaleu_ratings.target_cover_upload_scopes' THEN RETURN ARRAY['actor_id','client_request_id'];
 WHEN 'whaleu_ratings.category_icon_upload_scopes' THEN RETURN ARRAY['actor_id','client_request_id'];
 WHEN 'whaleu_school_configuration.qr_upload_scopes' THEN RETURN ARRAY['actor_id','client_request_id'];
 WHEN 'whaleu_organizations.media_upload_scopes' THEN RETURN ARRAY['actor_id','client_request_id'];
 WHEN 'whaleu_activities.media_upload_scopes' THEN RETURN ARRAY['actor_id','client_request_id'];
 WHEN 'whaleu_announcements.media_upload_scopes' THEN RETURN ARRAY['actor_id','client_request_id'];
 WHEN 'whaleu_media.verification_evidence_scopes' THEN RETURN ARRAY['actor_id','client_request_id'];
 WHEN 'whaleu_media.errand_scopes' THEN RETURN ARRAY['actor_id','client_request_id'];
 WHEN 'whaleu_media.private_message_scopes' THEN RETURN ARRAY['actor_id','client_request_id'];
 WHEN 'whaleu_media.window_discussion_scopes' THEN RETURN ARRAY['actor_id','client_request_id'];
 WHEN 'whaleu_media.major_discussion_scopes' THEN RETURN ARRAY['actor_id','client_request_id'];
 WHEN 'whaleu_verification.phone_proofs' THEN RETURN ARRAY['account_id','request_id'];
 WHEN 'whaleu_verification.phone_requests' THEN RETURN ARRAY['account_id','request_id'];
 WHEN 'whaleu_media.upload_intents' THEN RETURN ARRAY['actor_id','client_request_id'];
 WHEN 'whaleu_media.publication_batch_commands' THEN RETURN ARRAY['actor_id','command_id'];
 WHEN 'whaleu_profile.self_edit_causes' THEN RETURN ARRAY['actor_id','id'];
 ELSE RAISE EXCEPTION 'Unregistered consumer source' USING ERRCODE='23514',CONSTRAINT='account_policy_consumer_causal';
 END CASE;
END$$;

CREATE OR REPLACE FUNCTION whaleu_safety.account_policy_consumer_action(relation text,value jsonb) RETURNS text LANGUAGE plpgsql VOLATILE STRICT AS $$BEGIN
 CASE relation
 WHEN 'whaleu_profile.cover_edits','whaleu_profile.cover_command_receipts' THEN RETURN 'private_self_service';
 WHEN 'whaleu_ratings.course_commands' THEN
  RETURN 'interaction';
 WHEN 'whaleu_ratings.course_comment_commands' THEN
  IF value->'receipt'->>'outcome'='rejected' AND value->'receipt'->>'code'='COURSE_COMMENT_CANCELLED' THEN RETURN NULL;END IF;
  RETURN 'interaction';
 WHEN 'whaleu_ratings.window_commands' THEN
  IF value->'receipt'->>'outcome'='rejected' AND value->'receipt'->>'code'='WINDOW_SCORE_CANCELLED' THEN RETURN NULL;END IF;
  RETURN 'interaction';
 WHEN 'whaleu_ratings.dish_commands' THEN
  IF value->'receipt'->>'outcome'='rejected' AND value->'receipt'->>'code'='DISH_CANCELLED' THEN RETURN NULL;END IF;
  CASE value->>'operation' WHEN 'window.dish.recommend.v1' THEN RETURN 'interaction'; WHEN 'window.dish.retract.v1' THEN RETURN 'protective_cleanup'; ELSE RAISE EXCEPTION 'Unknown dish operation' USING ERRCODE='23514',CONSTRAINT='account_policy_consumer_causal'; END CASE;
 WHEN 'whaleu_ratings.floor_commands' THEN
  IF value->'receipt'->>'outcome'='rejected' AND value->'receipt'->>'code'='FLOOR_SCORE_CANCELLED' THEN RETURN NULL;END IF;
  RETURN 'interaction';
 WHEN 'whaleu_ratings.window_discussion_commands' THEN
  IF value->'receipt'->>'outcome'='rejected' AND value->'receipt'->>'code'='WINDOW_DISCUSSION_CANCELLED' THEN RETURN NULL;END IF;
  RETURN 'interaction';
 WHEN 'whaleu_majors.major_discussion_commands' THEN
  IF value->'receipt'->>'outcome'='rejected' AND value->'receipt'->>'code'='MAJOR_DISCUSSION_CANCELLED' THEN RETURN NULL;END IF;
  RETURN 'interaction';
 WHEN 'whaleu_majors.major_discussion_delete_commands' THEN
  IF value->'receipt'->>'outcome'='rejected' AND value->'receipt'->>'code'='MAJOR_DISCUSSION_CANCELLED' THEN RETURN NULL;END IF;
  IF value->'authority'->>'kind'='administrator' THEN RETURN 'content_management'; END IF;RETURN 'protective_cleanup';
 WHEN 'whaleu_community.post_pin_commands' THEN
  IF value->'receipt'->>'outcome'='rejected' AND value->'receipt'->>'code'='POST_PIN_CANCELLED' THEN RETURN NULL;END IF;
  CASE value->'command'->>'operation' WHEN 'read' THEN RETURN 'passive_bookkeeping'; WHEN 'pin' THEN RETURN 'content_management'; WHEN 'unpin' THEN RETURN 'content_management'; ELSE RAISE EXCEPTION 'Unknown pin operation' USING ERRCODE='23514',CONSTRAINT='account_policy_consumer_causal'; END CASE;
 WHEN 'whaleu_community.post_owner_visibility_commands' THEN
  IF value->'receipt'->>'outcome'='rejected' AND value->'receipt'->>'code'='POST_OWNER_VISIBILITY_CANCELLED' THEN RETURN NULL;END IF;
  CASE value->'command'->'ownerHidden' WHEN 'true'::jsonb THEN RETURN 'protective_cleanup'; WHEN 'false'::jsonb THEN RETURN 'interaction'; ELSE RAISE EXCEPTION 'Unknown owner visibility operation' USING ERRCODE='23514',CONSTRAINT='account_policy_consumer_causal'; END CASE;
 WHEN 'whaleu_community.post_category_commands' THEN
  IF value->'receipt'->>'outcome'='rejected' AND value->'receipt'->>'code'='POST_CATEGORY_CANCELLED' THEN RETURN NULL;END IF;
  RETURN 'content_management';
 WHEN 'whaleu_profile.moderation_commands' THEN
  IF value->'receipt'->>'outcome'='rejected' AND value->'receipt'->>'code'='PROFILE_MODERATION_CANCELLED' THEN RETURN NULL;END IF;
  RETURN 'content_management';
 WHEN 'whaleu_profile.avatar_moderation_commands' THEN
  IF value->'receipt'->>'outcome'='rejected' AND value->'receipt'->>'code'='PROFILE_AVATAR_MODERATION_CANCELLED' THEN RETURN NULL;END IF;
  RETURN 'content_management';
 WHEN 'whaleu_community.admin_post_removal_commands' THEN
  IF value->'receipt'->>'outcome'='rejected' AND value->'receipt'->>'code'='ADMIN_POST_REMOVAL_CANCELLED' THEN RETURN NULL;END IF;
  RETURN 'content_management';
 WHEN 'whaleu_community.admin_discussion_removal_commands' THEN
  IF value->'receipt'->>'outcome'='rejected' AND value->'receipt'->>'code'='ADMIN_DISCUSSION_REMOVAL_CANCELLED' THEN RETURN NULL;END IF;
  RETURN 'content_management';
 WHEN 'whaleu_authorization.school_admin_management_commands' THEN
  IF value->'receipt'->>'outcome'='rejected' AND value->'receipt'->>'code'='SCHOOL_ADMIN_MANAGEMENT_CANCELLED' THEN RETURN NULL;END IF;
  RETURN 'noncontent_management';
 WHEN 'whaleu_community.region_policy_commands' THEN
  RETURN 'noncontent_management';
 WHEN 'whaleu_experience.requests' THEN
  RETURN 'private_self_service';
 WHEN 'whaleu_experience.maintenance_requests' THEN
  RETURN 'noncontent_management';
 WHEN 'whaleu_ratings.scoped_command_preparations' THEN
  CASE value->>'operation'
   WHEN 'create_categories_scoped','edit_category_base_scoped','set_category_override_scoped','set_category_visibility_scoped','reorder_categories_scoped','set_category_scope_scoped','set_category_lifecycle_scoped','batch_update_subcategories_scoped','create_system_category_scoped' THEN RETURN 'content_management';
   WHEN 'set_score_scoped','create_comment_scoped','create_reply_scoped','create_target_scoped','edit_target_scoped' THEN RETURN 'interaction';
   WHEN 'set_comment_like_scoped','set_reply_like_scoped' THEN
    CASE value->'intent'->'payload'->'liked' WHEN 'true'::jsonb THEN RETURN 'interaction'; WHEN 'false'::jsonb THEN RETURN 'protective_cleanup'; ELSE RAISE EXCEPTION 'Unknown like intent' USING ERRCODE='23514',CONSTRAINT='account_policy_consumer_causal'; END CASE;
   WHEN 'set_target_subscription_scoped' THEN
    CASE value->'intent'->'payload'->'subscribed' WHEN 'true'::jsonb THEN RETURN 'interaction'; WHEN 'false'::jsonb THEN RETURN 'protective_cleanup'; ELSE RAISE EXCEPTION 'Unknown subscription intent' USING ERRCODE='23514',CONSTRAINT='account_policy_consumer_causal'; END CASE;
   ELSE RAISE EXCEPTION 'Unknown scoped operation' USING ERRCODE='23514',CONSTRAINT='account_policy_consumer_causal'; END CASE;
 WHEN 'whaleu_ratings.scoped_command_outcomes' THEN
  IF value->>'outcome'='closed' THEN RETURN NULL;END IF;
  CASE value->>'operation'
   WHEN 'create_categories_scoped','edit_category_base_scoped','set_category_override_scoped','set_category_visibility_scoped','reorder_categories_scoped','set_category_scope_scoped','set_category_lifecycle_scoped','batch_update_subcategories_scoped','create_system_category_scoped' THEN RETURN 'content_management';
   WHEN 'set_score_scoped','create_comment_scoped','create_reply_scoped','create_target_scoped','edit_target_scoped' THEN RETURN 'interaction';
   WHEN 'set_comment_like_scoped','set_reply_like_scoped' THEN
    CASE value->'intent'->'payload'->'liked' WHEN 'true'::jsonb THEN RETURN 'interaction'; WHEN 'false'::jsonb THEN RETURN 'protective_cleanup'; ELSE RAISE EXCEPTION 'Unknown like intent' USING ERRCODE='23514',CONSTRAINT='account_policy_consumer_causal'; END CASE;
   WHEN 'set_target_subscription_scoped' THEN
    CASE value->'intent'->'payload'->'subscribed' WHEN 'true'::jsonb THEN RETURN 'interaction'; WHEN 'false'::jsonb THEN RETURN 'protective_cleanup'; ELSE RAISE EXCEPTION 'Unknown subscription intent' USING ERRCODE='23514',CONSTRAINT='account_policy_consumer_causal'; END CASE;
   ELSE RAISE EXCEPTION 'Unknown scoped operation' USING ERRCODE='23514',CONSTRAINT='account_policy_consumer_causal'; END CASE;

 WHEN 'whaleu_community.publication_requests' THEN
  IF value->>'operation' IN('publish_post','publish_comment','publish_reply') THEN RETURN 'interaction'; END IF;RAISE EXCEPTION 'Unknown mutable consumer operation' USING ERRCODE='23514',CONSTRAINT='account_policy_consumer_causal';
 WHEN 'whaleu_community.poll_ballot_requests','whaleu_community.formation_requests' THEN RETURN 'interaction';
 WHEN 'whaleu_community.discussion_requests' THEN
  CASE value->>'operation' WHEN 'set_comment_pin' THEN RETURN 'content_management';
   WHEN 'set_comment_like','set_reply_like' THEN
    IF value->'receipt'->>'outcome'='rejected' THEN RETURN 'interaction';END IF;
    CASE value->'receipt'->'desired' WHEN 'true'::jsonb THEN RETURN 'interaction'; WHEN 'false'::jsonb THEN RETURN 'protective_cleanup'; ELSE RAISE EXCEPTION 'Unknown mutable consumer operation' USING ERRCODE='23514',CONSTRAINT='account_policy_consumer_causal'; END CASE;
   ELSE RAISE EXCEPTION 'Unknown mutable consumer operation' USING ERRCODE='23514',CONSTRAINT='account_policy_consumer_causal'; END CASE;
 WHEN 'whaleu_community.trading_requests' THEN
  IF value->'receipt'->>'outcome'='rejected' THEN RETURN 'interaction';END IF;
  CASE value->'receipt'->>'resolution' WHEN 'open' THEN RETURN 'interaction'; WHEN 'resolved' THEN RETURN 'protective_cleanup'; ELSE RAISE EXCEPTION 'Unknown mutable consumer operation' USING ERRCODE='23514',CONSTRAINT='account_policy_consumer_causal'; END CASE;
 WHEN 'whaleu_community.saved_requests' THEN
  CASE value->>'operation' WHEN 'set_post_saved' THEN CASE value->'desired' WHEN 'true'::jsonb THEN RETURN 'interaction'; WHEN 'false'::jsonb THEN RETURN 'protective_cleanup'; ELSE RAISE EXCEPTION 'Unknown mutable consumer operation' USING ERRCODE='23514',CONSTRAINT='account_policy_consumer_causal'; END CASE;
   WHEN 'set_post_update_preference' THEN CASE value->'desired' WHEN 'true'::jsonb THEN RETURN 'private_self_service'; WHEN 'false'::jsonb THEN RETURN 'protective_cleanup'; ELSE RAISE EXCEPTION 'Unknown mutable consumer operation' USING ERRCODE='23514',CONSTRAINT='account_policy_consumer_causal'; END CASE;
   ELSE RAISE EXCEPTION 'Unknown mutable consumer operation' USING ERRCODE='23514',CONSTRAINT='account_policy_consumer_causal'; END CASE;
 WHEN 'whaleu_community.post_like_requests' THEN CASE value->'liked' WHEN 'true'::jsonb THEN RETURN 'interaction'; WHEN 'false'::jsonb THEN RETURN 'protective_cleanup'; ELSE RAISE EXCEPTION 'Unknown mutable consumer operation' USING ERRCODE='23514',CONSTRAINT='account_policy_consumer_causal'; END CASE;
 WHEN 'whaleu_ratings.requests' THEN
  IF value->'receipt'->>'outcome'='closed' AND value->>'operation' IN('set_score_scoped','create_comment_scoped','create_reply_scoped','set_comment_like_scoped','set_reply_like_scoped','set_target_subscription_scoped','create_target_scoped','edit_target_scoped','create_categories_scoped','edit_category_base_scoped','set_category_override_scoped','set_category_visibility_scoped','reorder_categories_scoped','set_category_scope_scoped','set_category_lifecycle_scoped','batch_update_subcategories_scoped','create_system_category_scoped') THEN RETURN NULL;END IF;
  CASE value->>'operation'
   WHEN 'set_score','create_comment','create_reply','create_target','edit_target','set_score_scoped','create_comment_scoped','create_reply_scoped','create_target_scoped','edit_target_scoped' THEN RETURN 'interaction';
   WHEN 'delete_comment','delete_reply','delete_target' THEN RETURN 'protective_cleanup';
   WHEN 'admin_delete_comment','admin_delete_reply','create_categories','create_categories_scoped','edit_category_base_scoped','set_category_override_scoped','set_category_visibility_scoped','reorder_categories_scoped','set_category_scope_scoped','set_category_lifecycle_scoped','batch_update_subcategories_scoped','create_system_category_scoped' THEN RETURN 'content_management';
   WHEN 'set_comment_like','set_reply_like','set_comment_like_scoped','set_reply_like_scoped' THEN
    IF value->'receipt'->>'outcome'='rejected' THEN RETURN 'interaction';END IF;
    CASE coalesce(value->'receipt'->'liked',value->'receipt'->'result'->'liked') WHEN 'true'::jsonb THEN RETURN 'interaction'; WHEN 'false'::jsonb THEN RETURN 'protective_cleanup'; ELSE RAISE EXCEPTION 'Unknown mutable consumer operation' USING ERRCODE='23514',CONSTRAINT='account_policy_consumer_causal'; END CASE;
   WHEN 'set_target_subscription','set_target_subscription_scoped' THEN
    IF value->'receipt'->>'outcome'='rejected' THEN RETURN 'interaction';END IF;
    CASE coalesce(value->'receipt'->'subscribed',value->'receipt'->'result'->'subscribed') WHEN 'true'::jsonb THEN RETURN 'interaction'; WHEN 'false'::jsonb THEN RETURN 'protective_cleanup'; ELSE RAISE EXCEPTION 'Unknown mutable consumer operation' USING ERRCODE='23514',CONSTRAINT='account_policy_consumer_causal'; END CASE;
   ELSE RAISE EXCEPTION 'Unknown mutable consumer operation' USING ERRCODE='23514',CONSTRAINT='account_policy_consumer_causal'; END CASE;
 WHEN 'whaleu_errands.requests' THEN
  CASE value->>'operation' WHEN 'publish','accept','complete' THEN RETURN 'interaction'; WHEN 'cancel','delete' THEN RETURN 'protective_cleanup'; WHEN 'admin_delete' THEN RETURN 'content_management'; WHEN 'restrict_accepter' THEN RETURN 'noncontent_management'; ELSE RAISE EXCEPTION 'Unknown mutable consumer operation' USING ERRCODE='23514',CONSTRAINT='account_policy_consumer_causal'; END CASE;
 WHEN 'whaleu_messaging.requests' THEN
  IF value->'receipt'->>'outcome'='rejected' AND value->'receipt'->>'code'='DM_COMMAND_CANCELLED' THEN RETURN NULL;END IF;
  CASE value->>'operation' WHEN 'open','send','send_image','reopen' THEN RETURN 'interaction'; WHEN 'read' THEN RETURN 'passive_bookkeeping'; WHEN 'hide','recall','block' THEN RETURN 'protective_cleanup'; ELSE RAISE EXCEPTION 'Unknown mutable consumer operation' USING ERRCODE='23514',CONSTRAINT='account_policy_consumer_causal'; END CASE;
 WHEN 'whaleu_safety.requests' THEN
  IF value->>'operation' IN('block_named','unblock_named') THEN RETURN 'protective_cleanup';END IF;RAISE EXCEPTION 'Unknown mutable consumer operation' USING ERRCODE='23514',CONSTRAINT='account_policy_consumer_causal';
 WHEN 'whaleu_safety.report_requests' THEN
  IF value->>'operation' IN('report','vote') THEN RETURN 'interaction';END IF;RAISE EXCEPTION 'Unknown mutable consumer operation' USING ERRCODE='23514',CONSTRAINT='account_policy_consumer_causal';
 WHEN 'whaleu_safety.errand_restriction_requests' THEN
  IF value->>'operation' IN('issue','release') THEN RETURN 'noncontent_management';END IF;RAISE EXCEPTION 'Unknown mutable consumer operation' USING ERRCODE='23514',CONSTRAINT='account_policy_consumer_causal';
 WHEN 'whaleu_campus.identity_selection_requests','whaleu_profile.avatar_command_receipts' THEN RETURN 'private_self_service';
 WHEN 'whaleu_verification.student_requests' THEN
  IF EXISTS(SELECT 1 FROM whaleu_verification.student_applications a WHERE a.id=(value->>'application_id')::uuid AND a.account_id=(value->>'actor_id')::uuid) THEN RETURN 'private_self_service';END IF;
  RETURN 'noncontent_management';
 WHEN 'whaleu_organizations.organization_requests' THEN
  CASE value->'command'->>'action' WHEN 'create','save','submit','approve','reject' THEN RETURN 'content_management'; WHEN 'add_admin','remove_admin','transfer_owner' THEN RETURN 'noncontent_management'; ELSE RAISE EXCEPTION 'Unknown mutable consumer operation' USING ERRCODE='23514',CONSTRAINT='account_policy_consumer_causal'; END CASE;
 WHEN 'whaleu_school_configuration.requests' THEN RETURN 'noncontent_management';
 WHEN 'whaleu_activities.publication_receipts' THEN
  CASE (SELECT q.command->>'action' FROM whaleu_activities.publication_requests q WHERE q.actor_id=(value->>'actor_id')::uuid AND q.client_request_id=(value->>'client_request_id')::uuid)
   WHEN 'create','save','publish' THEN RETURN 'content_management'; WHEN 'cancel_draft' THEN RETURN 'protective_cleanup'; ELSE RAISE EXCEPTION 'Unknown mutable consumer operation' USING ERRCODE='23514',CONSTRAINT='account_policy_consumer_causal'; END CASE;
 WHEN 'whaleu_announcements.native_requests' THEN
  CASE value->'command'->>'action' WHEN 'create','save','publish','update','set_enabled' THEN RETURN 'content_management'; WHEN 'cancel_draft' THEN RETURN 'protective_cleanup'; ELSE RAISE EXCEPTION 'Unknown mutable consumer operation' USING ERRCODE='23514',CONSTRAINT='account_policy_consumer_causal'; END CASE;
 WHEN 'whaleu_profile.avatar_edits' THEN RETURN 'private_self_service';
 WHEN 'whaleu_ratings.target_cover_upload_scopes' THEN RETURN 'interaction';
 WHEN 'whaleu_ratings.category_icon_upload_scopes' THEN RETURN 'content_management';
 WHEN 'whaleu_school_configuration.qr_upload_scopes' THEN RETURN 'noncontent_management';
 WHEN 'whaleu_organizations.media_upload_scopes' THEN RETURN 'content_management';
 WHEN 'whaleu_activities.media_upload_scopes' THEN RETURN 'content_management';
 WHEN 'whaleu_announcements.media_upload_scopes' THEN RETURN 'content_management';
 WHEN 'whaleu_media.verification_evidence_scopes' THEN RETURN 'private_self_service';
 WHEN 'whaleu_media.errand_scopes' THEN RETURN 'interaction';
 WHEN 'whaleu_media.private_message_scopes' THEN RETURN 'interaction';
 WHEN 'whaleu_media.window_discussion_scopes' THEN RETURN 'interaction';
 WHEN 'whaleu_media.major_discussion_scopes' THEN RETURN 'interaction';
 WHEN 'whaleu_verification.phone_proofs' THEN RETURN 'private_self_service';
 WHEN 'whaleu_verification.phone_requests' THEN RETURN 'private_self_service';
 WHEN 'whaleu_media.publication_batch_commands' THEN
  IF value->>'kind' IN('layout','seal','reopen') THEN RETURN 'interaction';END IF;
  RAISE EXCEPTION 'Unknown Media batch operation' USING ERRCODE='23514',CONSTRAINT='account_policy_consumer_causal';
 WHEN 'whaleu_media.upload_intents' THEN
  -- The original exact protocol/owner/resource/slot guards remain mandatory.
  -- Audience alone is deliberately NOT an action classifier.
  CASE value->>'purpose'
   WHEN 'community-post-image','community-comment-image','community-reply-image','ratings-target-cover-image','ratings-comment-image','ratings-reply-image','private-message-image','errand-public-image','errand-private-image','window-discussion-image','major-discussion-image' THEN RETURN 'interaction';
   WHEN 'profile-avatar-image','profile-cover-image','verification-evidence-image' THEN RETURN 'private_self_service';
   WHEN 'school-configuration-qr-image' THEN RETURN 'noncontent_management';
   WHEN 'ratings-category-icon-image','organization-image','activity-image','announcement-image' THEN RETURN 'content_management';
   ELSE RAISE EXCEPTION 'Unknown Media purpose' USING ERRCODE='23514',CONSTRAINT='account_policy_consumer_causal';END CASE;
 WHEN 'whaleu_profile.self_edit_causes' THEN RETURN 'private_self_service';
 ELSE RAISE EXCEPTION 'Unregistered consumer source' USING ERRCODE='23514',CONSTRAINT='account_policy_consumer_causal';
 END CASE;
END$$;

CREATE TRIGGER account_policy_consumer_capture AFTER INSERT ON whaleu_profile.cover_edits FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT ON whaleu_profile.cover_command_receipts FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
