-- Forward-only consumer integration; 0135 owns the immutable punishment ledger.
-- Original migrations, receipts, source bytes and imported Safety baseline remain unchanged.

-- Authenticated browse; fresh command sidecars independently require interaction.
CREATE OR REPLACE FUNCTION whaleu_safety.course_comment_allowed(actor uuid,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT whaleu_safety.account_punishment_allows(actor,'browse') AND EXISTS(SELECT 1 FROM whaleu_safety.account_heads WHERE account_id=actor AND restriction_coverage='complete' AND block_coverage='complete' AND provenance<>'unknown' AND actions_allowed AND (valid_until IS NULL OR valid_until>instant))
$$;

-- Authenticated browse; fresh command sidecars independently require interaction.
CREATE OR REPLACE FUNCTION whaleu_safety.window_rating_allowed(actor uuid,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT whaleu_safety.account_punishment_allows(actor,'browse') AND EXISTS(SELECT 1 FROM whaleu_safety.account_heads WHERE account_id=actor AND restriction_coverage='complete' AND block_coverage='complete' AND provenance<>'unknown' AND actions_allowed AND (valid_until IS NULL OR valid_until>instant))
$$;

-- Authenticated browse; fresh command sidecars independently require interaction.
CREATE OR REPLACE FUNCTION whaleu_safety.major_rating_allowed(actor uuid,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT whaleu_safety.account_punishment_allows(actor,'browse') AND EXISTS(SELECT 1 FROM whaleu_safety.account_heads WHERE account_id=actor AND restriction_coverage='complete' AND block_coverage='complete' AND provenance<>'unknown' AND actions_allowed AND (valid_until IS NULL OR valid_until>instant))
$$;

-- Shared administrator read eligibility, retaining original baseline and authority. Fresh content commands are separately captured.
CREATE OR REPLACE FUNCTION whaleu_profile.moderation_actor_current(
  actor uuid, instant timestamptz
) RETURNS boolean LANGUAGE sql STABLE AS $$
WITH whitespace AS (
  -- ECMAScript String.trim white space and line terminators, used by the
  -- Verification owner policy. Plain btrim would accept tab-only references.
  SELECT U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF' AS chars
)
SELECT coalesce(
  actor IS NOT NULL AND instant IS NOT NULL AND isfinite(instant)
  AND EXISTS (
    SELECT 1 FROM whaleu_identity.accounts account
    WHERE account.id=actor AND account.status='active'
  )
  AND EXISTS (
    SELECT 1
    FROM whaleu_verification.account_heads head
    JOIN whaleu_verification.snapshots snapshot
      ON (snapshot.id,snapshot.account_id,snapshot.revision)
       = (head.snapshot_id,head.account_id,head.revision)
    JOIN whaleu_verification.assertions assertion
      ON assertion.id=snapshot.phone_assertion_id
     AND assertion.account_id=head.account_id
     AND assertion.fact_kind='phone'
    CROSS JOIN whitespace
    WHERE head.account_id=actor
      AND assertion.assertion_state='verified'
      AND assertion.coverage_state='complete'
      AND assertion.provenance_state='accepted'
      AND assertion.source_account_id=actor
      AND length(btrim(assertion.source_reference,whitespace.chars))>0
      AND length(btrim(assertion.policy_reference,whitespace.chars))>0
      AND assertion.method IN ('phone_provider','reconciled_import')
      -- Phone facts have no institution/origin; this also explicitly enforces
      -- the owner's issuer equality and the existing phone-table invariant.
      AND assertion.issuer_institution_id IS NULL
      AND assertion.source_issuer_institution_id IS NULL
      AND assertion.origin_region_id IS NULL
      AND assertion.phone_binding_reference IS NOT NULL
      AND assertion.verified_at IS NOT NULL
      AND isfinite(assertion.verified_at)
      AND assertion.verified_at<=instant
      AND (
        (assertion.expiry_kind='policy_exempt' AND assertion.expires_at IS NULL)
        OR (assertion.expiry_kind='at'
          AND assertion.expires_at IS NOT NULL
          AND isfinite(assertion.expires_at)
          AND assertion.expires_at>assertion.verified_at
          AND assertion.expires_at>instant)
      )
  )
  AND EXISTS (
    SELECT 1 FROM whaleu_safety.account_heads safety
    WHERE safety.account_id=actor
      AND safety.block_coverage='complete'
      AND safety.restriction_coverage='complete'
      -- This is the only known positive value in the real Safety schema.
      -- There is no Safety 'accepted' provenance value or source_reference.
      AND safety.provenance='native_account_creation'
      AND safety.actions_allowed IS TRUE
      AND whaleu_safety.account_punishment_allows(actor,'privileged_read')
      AND (safety.valid_until IS NULL
        OR (isfinite(safety.valid_until) AND safety.valid_until>instant))
  ),false);
$$;

-- Fresh category management; unchanged base eligibility and category source rules.
CREATE OR REPLACE FUNCTION whaleu_ratings.category_management_actor_current(
  actor uuid, instant timestamptz
) RETURNS boolean LANGUAGE sql STABLE AS $$
WITH whitespace AS (
  -- ECMAScript String.trim white space and line terminators, used by the
  -- Verification owner policy. Plain btrim would accept tab-only references.
  SELECT U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF' AS chars
)
SELECT coalesce(
  actor IS NOT NULL AND instant IS NOT NULL AND isfinite(instant)
  AND EXISTS (
    SELECT 1 FROM whaleu_identity.accounts account
    WHERE account.id=actor AND account.status='active'
  )
  AND EXISTS (
    SELECT 1
    FROM whaleu_verification.account_heads head
    JOIN whaleu_verification.snapshots snapshot
      ON (snapshot.id,snapshot.account_id,snapshot.revision)
       = (head.snapshot_id,head.account_id,head.revision)
    JOIN whaleu_verification.assertions assertion
      ON assertion.id=snapshot.phone_assertion_id
     AND assertion.account_id=head.account_id
     AND assertion.fact_kind='phone'
    CROSS JOIN whitespace
    WHERE head.account_id=actor
      AND assertion.assertion_state='verified'
      AND assertion.coverage_state='complete'
      AND assertion.provenance_state='accepted'
      AND assertion.source_account_id=actor
      AND length(btrim(assertion.source_reference,whitespace.chars))>0
      AND length(btrim(assertion.policy_reference,whitespace.chars))>0
      AND assertion.method IN ('phone_provider','reconciled_import')
      -- Phone facts have no institution/origin; this also explicitly enforces
      -- the owner's issuer equality and the existing phone-table invariant.
      AND assertion.issuer_institution_id IS NULL
      AND assertion.source_issuer_institution_id IS NULL
      AND assertion.origin_region_id IS NULL
      AND assertion.phone_binding_reference IS NOT NULL
      AND assertion.verified_at IS NOT NULL
      AND isfinite(assertion.verified_at)
      AND assertion.verified_at<=instant
      AND (
        (assertion.expiry_kind='policy_exempt' AND assertion.expires_at IS NULL)
        OR (assertion.expiry_kind='at'
          AND assertion.expires_at IS NOT NULL
          AND isfinite(assertion.expires_at)
          AND assertion.expires_at>assertion.verified_at
          AND assertion.expires_at>instant)
      )
  )
  AND EXISTS (
    SELECT 1 FROM whaleu_safety.account_heads safety
    WHERE safety.account_id=actor
      AND safety.block_coverage='complete'
      AND safety.restriction_coverage='complete'
      -- This is the only known positive value in the real Safety schema.
      -- There is no Safety 'accepted' provenance value or source_reference.
      AND safety.provenance='native_account_creation'
      AND safety.actions_allowed IS TRUE
      AND whaleu_safety.account_punishment_allows(actor,'content_management')
      AND (safety.valid_until IS NULL
        OR (isfinite(safety.valid_until) AND safety.valid_until>instant))
  ),false);
$$;

-- Owner restoration distributes content; hiding remains separate protective cleanup.
CREATE OR REPLACE FUNCTION whaleu_community.require_post_owner_restore_safety(actor uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE head whaleu_safety.account_heads;
BEGIN
 PERFORM whaleu_safety.require_account_punishment_allowed(actor,'interaction');
 SELECT * INTO head FROM whaleu_safety.account_heads WHERE account_id=actor FOR SHARE;
 IF head.account_id IS NULL OR head.block_coverage<>'complete' OR head.restriction_coverage<>'complete'
  OR head.provenance='unknown' OR head.actions_allowed IS DISTINCT FROM true
  OR (head.valid_until IS NOT NULL AND head.valid_until<=clock_timestamp())
 THEN RAISE EXCEPTION 'Current allowed Safety owner required for restoration' USING ERRCODE='23514',CONSTRAINT='post_owner_visibility_causal';END IF;
END$$;

-- Viewer suspension check precedes self bypass; target baseline and named-block rules are unchanged, with no author-wide overlay suppression.
CREATE OR REPLACE FUNCTION whaleu_safety.window_discussion_named(viewer uuid,author uuid,instant timestamptz) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN viewer IS NOT NULL AND NOT whaleu_safety.account_punishment_allows(viewer,'browse') THEN 'deny' WHEN EXISTS(SELECT 1 FROM whaleu_safety.account_heads WHERE account_id IN(viewer,author) AND (restriction_coverage<>'complete' OR block_coverage<>'complete' OR provenance='unknown' OR (valid_until IS NOT NULL AND valid_until<=instant))) OR (SELECT count(*) FROM whaleu_safety.account_heads WHERE account_id IN(viewer,author))<>CASE WHEN viewer=author THEN 1 ELSE 2 END THEN 'unavailable'
 WHEN EXISTS(SELECT 1 FROM whaleu_safety.account_heads WHERE account_id=author AND NOT actions_allowed) OR EXISTS(SELECT 1 FROM whaleu_safety.blocks WHERE active AND ((blocker_id=viewer AND blocked_id=author) OR(blocker_id=author AND blocked_id=viewer))) THEN 'deny' ELSE 'allow' END
$$;

-- Viewer suspension check precedes self bypass; target baseline and named-block rules are unchanged, with no author-wide overlay suppression.
CREATE OR REPLACE FUNCTION whaleu_safety.major_discussion_named(viewer uuid,author uuid,instant timestamptz) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN viewer IS NOT NULL AND NOT whaleu_safety.account_punishment_allows(viewer,'browse') THEN 'deny' WHEN EXISTS(SELECT 1 FROM whaleu_safety.account_heads WHERE account_id IN(viewer,author) AND (restriction_coverage<>'complete' OR block_coverage<>'complete' OR provenance='unknown' OR (valid_until IS NOT NULL AND valid_until<=instant))) OR (SELECT count(*) FROM whaleu_safety.account_heads WHERE account_id IN(viewer,author))<>CASE WHEN viewer=author THEN 1 ELSE 2 END THEN 'unavailable'
 WHEN EXISTS(SELECT 1 FROM whaleu_safety.account_heads WHERE account_id=author AND NOT actions_allowed) OR EXISTS(SELECT 1 FROM whaleu_safety.blocks WHERE active AND ((blocker_id=viewer AND blocked_id=author) OR(blocker_id=author AND blocked_id=viewer))) THEN 'deny' ELSE 'allow' END
$$;

-- Actor-only immutable proof sidecars. No historical row is backfilled or
-- rewritten and no session/token/grant FK adds a retention dependency.
CREATE TABLE whaleu_safety.account_policy_consumer_proofs (
 source_relation text NOT NULL,actor_id uuid NOT NULL,
 source_request_id text NOT NULL CHECK(length(source_request_id) BETWEEN 36 AND 73),action text NOT NULL,
 source_fingerprint text NOT NULL CHECK(source_fingerprint ~ '^[a-f0-9]{64}$'),
 punishment_fingerprint text NOT NULL CHECK(punishment_fingerprint ~ '^[a-f0-9]{64}$'),
 allowed boolean NOT NULL,suspended boolean NOT NULL,
 observed_until timestamptz,
 creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 PRIMARY KEY(source_relation,actor_id,source_request_id),
 CHECK(action IN('browse','interaction','private_self_service','protective_cleanup','passive_bookkeeping','privileged_read','noncontent_management','content_management'))
);
CREATE INDEX account_policy_consumer_current_actor ON whaleu_safety.account_policy_consumer_proofs(creation_transaction,actor_id);

CREATE FUNCTION whaleu_safety.account_policy_consumer_fingerprint(value jsonb)
RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT whaleu_profile.moderation_hash(value)
$$;

CREATE FUNCTION whaleu_safety.account_policy_consumer_keys(relation text) RETURNS text[] LANGUAGE plpgsql IMMUTABLE STRICT AS $$BEGIN
 CASE relation
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

CREATE FUNCTION whaleu_safety.account_policy_consumer_action(relation text,value jsonb) RETURNS text LANGUAGE plpgsql VOLATILE STRICT AS $$BEGIN
 CASE relation
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
   WHEN 'profile-avatar-image','verification-evidence-image' THEN RETURN 'private_self_service';
   WHEN 'school-configuration-qr-image' THEN RETURN 'noncontent_management';
   WHEN 'ratings-category-icon-image','organization-image','activity-image','announcement-image' THEN RETURN 'content_management';
   ELSE RAISE EXCEPTION 'Unknown Media purpose' USING ERRCODE='23514',CONSTRAINT='account_policy_consumer_causal';END CASE;
 WHEN 'whaleu_profile.self_edit_causes' THEN RETURN 'private_self_service';
 ELSE RAISE EXCEPTION 'Unregistered consumer source' USING ERRCODE='23514',CONSTRAINT='account_policy_consumer_causal';
 END CASE;
END$$;

CREATE FUNCTION whaleu_safety.account_policy_consumer_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 RAISE EXCEPTION 'Consumer policy evidence and original commands are immutable' USING ERRCODE='23514',CONSTRAINT='account_policy_consumer_causal';
END$$;
CREATE TRIGGER account_policy_consumer_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_safety.account_policy_consumer_proofs FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_immutable();

CREATE FUNCTION whaleu_safety.account_policy_consumer_admit()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE observed record;BEGIN
 SELECT * INTO observed FROM whaleu_safety.account_punishment_policy_observation(NEW.actor_id,NEW.action);
 -- Only the fixed source-table AFTER INSERT capture may add evidence. The
 -- original source's existing identity, intent and effect guards still apply.
 IF pg_trigger_depth()<>2 OR current_setting('transaction_isolation')<>'read committed'
 OR NEW.creation_transaction<>pg_current_xact_id()
 OR NEW.punishment_fingerprint IS DISTINCT FROM observed.fingerprint
 OR NEW.allowed IS DISTINCT FROM observed.allowed
 OR NEW.suspended IS DISTINCT FROM observed.suspended
 OR NEW.observed_until IS DISTINCT FROM observed.until::timestamptz
 THEN RAISE EXCEPTION 'Exact source-trigger policy proof required' USING ERRCODE='23514',CONSTRAINT='account_policy_consumer_causal';END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER account_policy_consumer_admit BEFORE INSERT ON whaleu_safety.account_policy_consumer_proofs FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_admit();

CREATE FUNCTION whaleu_safety.account_policy_consumer_source(relation text,actor uuid,request text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
DECLARE keys text[];result jsonb;BEGIN
 keys:=whaleu_safety.account_policy_consumer_keys(relation);
 IF relation='whaleu_media.publication_batch_commands' THEN
  SELECT to_jsonb(q)||jsonb_build_object('actor_id',b.actor_id) INTO result
  FROM whaleu_media.publication_batch_commands q JOIN whaleu_media.publication_batches b ON b.id=q.batch_id
  WHERE b.actor_id=actor AND q.batch_id=split_part(request,'/',1)::uuid AND q.command_id=split_part(request,'/',2)::uuid;
  RETURN result;
 END IF;
 EXECUTE format('SELECT to_jsonb(source) FROM %I.%I source WHERE %I=$1 AND %I=$2::uuid',
 split_part(relation,'.',1),split_part(relation,'.',2),keys[1],keys[2]) INTO result USING actor,request;
 RETURN result;
END$$;
CREATE FUNCTION whaleu_safety.account_policy_consumer_assert(p whaleu_safety.account_policy_consumer_proofs)
RETURNS void LANGUAGE plpgsql VOLATILE AS $$
DECLARE source jsonb;action text;receipt jsonb;observed record;BEGIN
 IF current_setting('transaction_isolation')<>'read committed' OR p.creation_transaction<>pg_current_xact_id() THEN
 RAISE EXCEPTION 'Original read committed actor proof required' USING ERRCODE='23514',CONSTRAINT='account_policy_consumer_causal';END IF;
 LOCK TABLE whaleu_safety.account_punishments,whaleu_safety.account_punishment_heads,whaleu_safety.account_punishment_terminals IN SHARE MODE NOWAIT;
 SELECT * INTO observed FROM whaleu_safety.account_punishment_policy_observation(p.actor_id,p.action);
 source:=whaleu_safety.account_policy_consumer_source(p.source_relation,p.actor_id,p.source_request_id);
 action:=whaleu_safety.account_policy_consumer_action(p.source_relation,source);
 IF source IS NULL OR action IS DISTINCT FROM p.action
 OR whaleu_safety.account_policy_consumer_fingerprint(source) IS DISTINCT FROM p.source_fingerprint
 OR observed.fingerprint IS DISTINCT FROM p.punishment_fingerprint
 OR observed.allowed IS DISTINCT FROM p.allowed
 OR observed.suspended IS DISTINCT FROM p.suspended
 OR (NOT p.allowed AND p.observed_until IS NOT NULL AND observed.checked_at>=p.observed_until)
 THEN RAISE EXCEPTION 'Original exact actor policy changed' USING ERRCODE='23514',CONSTRAINT='account_policy_consumer_causal';END IF;
 receipt:=coalesce(source->'receipt',source);
 IF NOT p.allowed AND (
 receipt->>'outcome'='rejected' AND
 ((p.suspended AND receipt->>'code'='SAFETY_ACCESS_SUSPENDED') OR
 (NOT p.suspended AND receipt->>'code' IN('SAFETY_ACTION_RESTRICTED','COMMUNITY_ACTION_RESTRICTED')))) IS DISTINCT FROM true THEN
 RAISE EXCEPTION 'Denied actor cannot mint a fresh command result' USING ERRCODE='23514',CONSTRAINT='account_policy_consumer_causal';END IF;
END$$;
CREATE FUNCTION whaleu_safety.account_policy_consumer_capture()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE value jsonb:=to_jsonb(NEW);relation text:=TG_TABLE_SCHEMA||'.'||TG_TABLE_NAME;keys text[];action text;actor uuid;request text;BEGIN
 IF relation IN('whaleu_community.publication_requests','whaleu_community.poll_ballot_requests','whaleu_community.discussion_requests','whaleu_community.trading_requests','whaleu_community.formation_requests','whaleu_community.saved_requests','whaleu_community.post_like_requests','whaleu_ratings.requests','whaleu_errands.requests','whaleu_messaging.requests','whaleu_safety.errand_restriction_requests','whaleu_safety.requests','whaleu_safety.report_requests') AND (value->'receipt' IS NULL OR value->'receipt'='null'::jsonb) THEN RETURN NULL;END IF;
 action:=whaleu_safety.account_policy_consumer_action(relation,value);
 -- This branch never reads the punishment tables. Cold cancellation remains
 -- session-only even while fresh-authority/source relations are locked.
 IF action IS NULL THEN RETURN NULL;END IF;
 keys:=whaleu_safety.account_policy_consumer_keys(relation);
 IF relation='whaleu_media.publication_batch_commands' THEN
  SELECT b.actor_id INTO actor FROM whaleu_media.publication_batches b WHERE b.id=(value->>'batch_id')::uuid;
  request:=(value->>'batch_id')||'/'||(value->>'command_id');
  value:=value||jsonb_build_object('actor_id',actor);
 ELSE actor:=(value->>keys[1])::uuid;request:=value->>keys[2];END IF;
 INSERT INTO whaleu_safety.account_policy_consumer_proofs(source_relation,actor_id,source_request_id,action,source_fingerprint,punishment_fingerprint,allowed,suspended,observed_until)
 SELECT relation,actor,request,action,whaleu_safety.account_policy_consumer_fingerprint(value),
 observed.fingerprint,observed.allowed,observed.suspended,observed.until::timestamptz
 FROM whaleu_safety.account_punishment_policy_observation(actor,action) observed;
 RETURN NULL;
END$$;
CREATE FUNCTION whaleu_safety.account_policy_consumer_final()
RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 PERFORM whaleu_safety.account_policy_consumer_assert(NEW);RETURN NULL;
END$$;
CREATE CONSTRAINT TRIGGER account_policy_consumer_final AFTER INSERT ON whaleu_safety.account_policy_consumer_proofs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_final();

CREATE FUNCTION whaleu_safety.account_policy_consumer_recheck_actor(actor uuid)
RETURNS void LANGUAGE plpgsql VOLATILE AS $$
DECLARE p whaleu_safety.account_policy_consumer_proofs;total integer:=0;until_time timestamptz:=clock_timestamp()+interval '500 milliseconds';BEGIN
 -- Indexed exact actor/current-transaction evidence, not an unbounded history
 -- or new 128-slot owner scan per handler. Retain caller's stricter SQL budget.
 FOR p IN SELECT * FROM whaleu_safety.account_policy_consumer_proofs
 WHERE creation_transaction=pg_current_xact_id() AND actor_id=actor LIMIT 257 LOOP
  total:=total+1;
  IF total>256 OR clock_timestamp()>=until_time THEN
   RAISE EXCEPTION 'Bounded consumer proof exceeded' USING ERRCODE='23514',CONSTRAINT='account_policy_consumer_causal';END IF;
  PERFORM whaleu_safety.account_policy_consumer_assert(p);
 END LOOP;
 IF clock_timestamp()>=until_time THEN RAISE EXCEPTION 'Bounded consumer proof exceeded' USING ERRCODE='23514',CONSTRAINT='account_policy_consumer_causal';END IF;
END$$;
CREATE FUNCTION whaleu_safety.account_policy_consumer_ledger_recheck()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor uuid;value jsonb;BEGIN
 value:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 IF TG_TABLE_NAME='account_punishment_terminals' THEN
  SELECT subject_id INTO actor FROM whaleu_safety.account_punishments WHERE id=(value->>'punishment_id')::uuid;
 ELSE actor:=(value->>'subject_id')::uuid;END IF;
 IF actor IS NULL THEN RAISE EXCEPTION 'Exact punishment subject required' USING ERRCODE='23514',CONSTRAINT='account_policy_consumer_causal';END IF;
 PERFORM whaleu_safety.account_policy_consumer_recheck_actor(actor);RETURN NULL;
END$$;
DO $$DECLARE relation text;BEGIN
 FOREACH relation IN ARRAY ARRAY['account_punishments','account_punishment_heads','account_punishment_terminals'] LOOP
 EXECUTE format('CREATE CONSTRAINT TRIGGER account_policy_consumer_ledger_recheck AFTER INSERT OR UPDATE OR DELETE ON whaleu_safety.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_ledger_recheck()',relation);
 END LOOP;
END$$;

CREATE FUNCTION whaleu_safety.account_policy_consumer_insert_statement()
RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM inserted) THEN
 RAISE EXCEPTION 'Zero-row raw command writer is not a policy proof' USING ERRCODE='23514',CONSTRAINT='account_policy_consumer_causal';END IF;
 RETURN NULL;
END$$;

-- Exact existing owner whaleu_ratings.course_commands; triggers cannot grant source authority.
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT ON whaleu_ratings.course_commands FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_source_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_ratings.course_commands FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_immutable();
CREATE TRIGGER account_policy_consumer_insert_statement AFTER INSERT ON whaleu_ratings.course_commands REFERENCING NEW TABLE AS inserted FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_insert_statement();

-- Exact existing owner whaleu_ratings.course_comment_commands; triggers cannot grant source authority.
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT ON whaleu_ratings.course_comment_commands FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_source_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_ratings.course_comment_commands FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_immutable();
CREATE TRIGGER account_policy_consumer_insert_statement AFTER INSERT ON whaleu_ratings.course_comment_commands REFERENCING NEW TABLE AS inserted FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_insert_statement();

-- Exact existing owner whaleu_ratings.window_commands; triggers cannot grant source authority.
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT ON whaleu_ratings.window_commands FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_source_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_ratings.window_commands FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_immutable();
CREATE TRIGGER account_policy_consumer_insert_statement AFTER INSERT ON whaleu_ratings.window_commands REFERENCING NEW TABLE AS inserted FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_insert_statement();

-- Exact existing owner whaleu_ratings.dish_commands; triggers cannot grant source authority.
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT ON whaleu_ratings.dish_commands FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_source_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_ratings.dish_commands FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_immutable();
CREATE TRIGGER account_policy_consumer_insert_statement AFTER INSERT ON whaleu_ratings.dish_commands REFERENCING NEW TABLE AS inserted FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_insert_statement();

-- Exact existing owner whaleu_ratings.floor_commands; triggers cannot grant source authority.
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT ON whaleu_ratings.floor_commands FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_source_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_ratings.floor_commands FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_immutable();
CREATE TRIGGER account_policy_consumer_insert_statement AFTER INSERT ON whaleu_ratings.floor_commands REFERENCING NEW TABLE AS inserted FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_insert_statement();

-- Exact existing owner whaleu_ratings.window_discussion_commands; triggers cannot grant source authority.
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT ON whaleu_ratings.window_discussion_commands FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_source_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_ratings.window_discussion_commands FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_immutable();
CREATE TRIGGER account_policy_consumer_insert_statement AFTER INSERT ON whaleu_ratings.window_discussion_commands REFERENCING NEW TABLE AS inserted FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_insert_statement();

-- Exact existing owner whaleu_majors.major_discussion_commands; triggers cannot grant source authority.
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT ON whaleu_majors.major_discussion_commands FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_source_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_majors.major_discussion_commands FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_immutable();
CREATE TRIGGER account_policy_consumer_insert_statement AFTER INSERT ON whaleu_majors.major_discussion_commands REFERENCING NEW TABLE AS inserted FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_insert_statement();

-- Exact existing owner whaleu_majors.major_discussion_delete_commands; triggers cannot grant source authority.
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT ON whaleu_majors.major_discussion_delete_commands FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_source_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_majors.major_discussion_delete_commands FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_immutable();
CREATE TRIGGER account_policy_consumer_insert_statement AFTER INSERT ON whaleu_majors.major_discussion_delete_commands REFERENCING NEW TABLE AS inserted FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_insert_statement();

-- Exact existing owner whaleu_community.post_pin_commands; triggers cannot grant source authority.
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT ON whaleu_community.post_pin_commands FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_source_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_community.post_pin_commands FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_immutable();
CREATE TRIGGER account_policy_consumer_insert_statement AFTER INSERT ON whaleu_community.post_pin_commands REFERENCING NEW TABLE AS inserted FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_insert_statement();

-- Exact existing owner whaleu_community.post_owner_visibility_commands; triggers cannot grant source authority.
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT ON whaleu_community.post_owner_visibility_commands FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_source_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_community.post_owner_visibility_commands FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_immutable();
CREATE TRIGGER account_policy_consumer_insert_statement AFTER INSERT ON whaleu_community.post_owner_visibility_commands REFERENCING NEW TABLE AS inserted FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_insert_statement();

-- Exact existing owner whaleu_community.post_category_commands; triggers cannot grant source authority.
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT ON whaleu_community.post_category_commands FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_source_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_community.post_category_commands FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_immutable();
CREATE TRIGGER account_policy_consumer_insert_statement AFTER INSERT ON whaleu_community.post_category_commands REFERENCING NEW TABLE AS inserted FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_insert_statement();

-- Exact existing owner whaleu_profile.moderation_commands; triggers cannot grant source authority.
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT ON whaleu_profile.moderation_commands FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_source_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_profile.moderation_commands FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_immutable();
CREATE TRIGGER account_policy_consumer_insert_statement AFTER INSERT ON whaleu_profile.moderation_commands REFERENCING NEW TABLE AS inserted FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_insert_statement();

-- Exact existing owner whaleu_profile.avatar_moderation_commands; triggers cannot grant source authority.
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT ON whaleu_profile.avatar_moderation_commands FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_source_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_profile.avatar_moderation_commands FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_immutable();
CREATE TRIGGER account_policy_consumer_insert_statement AFTER INSERT ON whaleu_profile.avatar_moderation_commands REFERENCING NEW TABLE AS inserted FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_insert_statement();

-- Exact existing owner whaleu_community.admin_post_removal_commands; triggers cannot grant source authority.
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT ON whaleu_community.admin_post_removal_commands FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_source_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_community.admin_post_removal_commands FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_immutable();
CREATE TRIGGER account_policy_consumer_insert_statement AFTER INSERT ON whaleu_community.admin_post_removal_commands REFERENCING NEW TABLE AS inserted FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_insert_statement();

-- Exact existing owner whaleu_community.admin_discussion_removal_commands; triggers cannot grant source authority.
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT ON whaleu_community.admin_discussion_removal_commands FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_source_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_community.admin_discussion_removal_commands FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_immutable();
CREATE TRIGGER account_policy_consumer_insert_statement AFTER INSERT ON whaleu_community.admin_discussion_removal_commands REFERENCING NEW TABLE AS inserted FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_insert_statement();

-- Exact existing owner whaleu_authorization.school_admin_management_commands; triggers cannot grant source authority.
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT ON whaleu_authorization.school_admin_management_commands FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_source_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_authorization.school_admin_management_commands FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_immutable();
CREATE TRIGGER account_policy_consumer_insert_statement AFTER INSERT ON whaleu_authorization.school_admin_management_commands REFERENCING NEW TABLE AS inserted FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_insert_statement();

-- Exact existing owner whaleu_community.region_policy_commands; triggers cannot grant source authority.
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT ON whaleu_community.region_policy_commands FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_source_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_community.region_policy_commands FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_immutable();
CREATE TRIGGER account_policy_consumer_insert_statement AFTER INSERT ON whaleu_community.region_policy_commands REFERENCING NEW TABLE AS inserted FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_insert_statement();

-- Exact existing owner whaleu_experience.requests; triggers cannot grant source authority.
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT ON whaleu_experience.requests FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_source_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_experience.requests FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_immutable();
CREATE TRIGGER account_policy_consumer_insert_statement AFTER INSERT ON whaleu_experience.requests REFERENCING NEW TABLE AS inserted FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_insert_statement();

-- Exact existing owner whaleu_experience.maintenance_requests; triggers cannot grant source authority.
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT ON whaleu_experience.maintenance_requests FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_source_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_experience.maintenance_requests FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_immutable();
CREATE TRIGGER account_policy_consumer_insert_statement AFTER INSERT ON whaleu_experience.maintenance_requests REFERENCING NEW TABLE AS inserted FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_insert_statement();

-- Exact existing owner whaleu_ratings.scoped_command_preparations; triggers cannot grant source authority.
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT ON whaleu_ratings.scoped_command_preparations FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_source_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_ratings.scoped_command_preparations FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_immutable();
CREATE TRIGGER account_policy_consumer_insert_statement AFTER INSERT ON whaleu_ratings.scoped_command_preparations REFERENCING NEW TABLE AS inserted FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_insert_statement();

-- Exact existing owner whaleu_ratings.scoped_command_outcomes; triggers cannot grant source authority.
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT ON whaleu_ratings.scoped_command_outcomes FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_source_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_ratings.scoped_command_outcomes FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_immutable();
CREATE TRIGGER account_policy_consumer_insert_statement AFTER INSERT ON whaleu_ratings.scoped_command_outcomes REFERENCING NEW TABLE AS inserted FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_insert_statement();

-- Earlier pending-to-terminal request owners. Existing receipt mutability and
-- effect validators remain authoritative; pending review and replay are unchanged.
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT OR UPDATE ON whaleu_community.publication_requests FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_no_truncate BEFORE TRUNCATE ON whaleu_community.publication_requests FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_immutable();
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT OR UPDATE ON whaleu_community.poll_ballot_requests FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_no_truncate BEFORE TRUNCATE ON whaleu_community.poll_ballot_requests FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_immutable();
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT OR UPDATE ON whaleu_community.discussion_requests FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_no_truncate BEFORE TRUNCATE ON whaleu_community.discussion_requests FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_immutable();
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT OR UPDATE ON whaleu_community.trading_requests FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_no_truncate BEFORE TRUNCATE ON whaleu_community.trading_requests FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_immutable();
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT OR UPDATE ON whaleu_community.formation_requests FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_no_truncate BEFORE TRUNCATE ON whaleu_community.formation_requests FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_immutable();
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT OR UPDATE ON whaleu_community.saved_requests FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_no_truncate BEFORE TRUNCATE ON whaleu_community.saved_requests FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_immutable();
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT OR UPDATE ON whaleu_community.post_like_requests FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_no_truncate BEFORE TRUNCATE ON whaleu_community.post_like_requests FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_immutable();
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT OR UPDATE ON whaleu_ratings.requests FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_no_truncate BEFORE TRUNCATE ON whaleu_ratings.requests FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_immutable();
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT OR UPDATE ON whaleu_errands.requests FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_no_truncate BEFORE TRUNCATE ON whaleu_errands.requests FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_immutable();
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT OR UPDATE ON whaleu_messaging.requests FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_no_truncate BEFORE TRUNCATE ON whaleu_messaging.requests FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_immutable();
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT OR UPDATE ON whaleu_safety.errand_restriction_requests FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_no_truncate BEFORE TRUNCATE ON whaleu_safety.errand_restriction_requests FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_immutable();
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT OR UPDATE ON whaleu_safety.requests FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_no_truncate BEFORE TRUNCATE ON whaleu_safety.requests FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_immutable();
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT OR UPDATE ON whaleu_safety.report_requests FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_no_truncate BEFORE TRUNCATE ON whaleu_safety.report_requests FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_immutable();
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT ON whaleu_campus.identity_selection_requests FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT ON whaleu_profile.avatar_command_receipts FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT ON whaleu_verification.student_requests FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT ON whaleu_organizations.organization_requests FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT ON whaleu_school_configuration.requests FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT ON whaleu_activities.publication_receipts FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT ON whaleu_announcements.native_requests FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();

-- Exact caller-owned media preparation and final phone proof. No blanket
-- policy on stored asset authors, worker lifecycle, detach or backend cleanup.
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT ON whaleu_profile.avatar_edits FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT ON whaleu_ratings.target_cover_upload_scopes FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT ON whaleu_ratings.category_icon_upload_scopes FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT ON whaleu_school_configuration.qr_upload_scopes FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT ON whaleu_organizations.media_upload_scopes FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT ON whaleu_activities.media_upload_scopes FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT ON whaleu_announcements.media_upload_scopes FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT ON whaleu_media.verification_evidence_scopes FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT ON whaleu_media.errand_scopes FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT ON whaleu_media.private_message_scopes FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT ON whaleu_media.window_discussion_scopes FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT ON whaleu_media.major_discussion_scopes FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT ON whaleu_verification.phone_proofs FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT ON whaleu_verification.phone_requests FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT ON whaleu_media.upload_intents FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT ON whaleu_media.publication_batch_commands FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();

-- Internal authenticated Profile CAS cause and exact consumer registration.
-- Authenticated own Profile edits only. Raw bootstrap/source writers remain
-- independent inputs, never authenticated self-service or invented import APIs.
-- No retention FK to live accounts/sessions/tokens or mutable Profile rows.
CREATE TABLE whaleu_profile.self_edit_causes (
 id uuid PRIMARY KEY, actor_id uuid NOT NULL, session_id uuid NOT NULL,
 token_hash text NOT NULL CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 expected_revision integer NOT NULL CHECK(expected_revision BETWEEN 0 AND 2147483646),
 patch jsonb NOT NULL, before_row jsonb NOT NULL, before_fingerprint text NOT NULL,
 identity_hash text NOT NULL, campus_fingerprint text, before_epoch_sum numeric NOT NULL, mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 UNIQUE(actor_id,id), UNIQUE(actor_id,mutation_transaction)
);
CREATE INDEX self_edit_current_transaction ON whaleu_profile.self_edit_causes(mutation_transaction);
CREATE TABLE whaleu_profile.self_edit_transitions (
 cause_id uuid PRIMARY KEY REFERENCES whaleu_profile.self_edit_causes(id),
 after_fingerprint text NOT NULL, profile_epochs text NOT NULL,
 mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE FUNCTION whaleu_profile.self_edit_unavailable() RETURNS void LANGUAGE plpgsql AS $$BEGIN
 RAISE EXCEPTION 'Exact current own Profile cause required' USING ERRCODE='23514',CONSTRAINT='profile_self_edit_causal';
END$$;
CREATE FUNCTION whaleu_profile.self_edit_epoch_hash() RETURNS text LANGUAGE sql STABLE AS $$
 SELECT whaleu_profile.moderation_hash(jsonb_agg(jsonb_build_array(slot,version,epoch::text) ORDER BY slot)) FROM whaleu_profile.admin_count_epochs
$$;
CREATE FUNCTION whaleu_profile.self_edit_identity_current(actor uuid,session uuid,token text) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_identity.accounts a JOIN whaleu_identity.sessions s ON s.account_id=a.id JOIN whaleu_identity.access_tokens t ON t.session_id=s.id
 WHERE a.id=actor AND a.status='active' AND s.id=session AND s.revoked_at IS NULL AND s.access_expires_at>clock_timestamp() AND s.absolute_expires_at>clock_timestamp() AND t.token_hash=token AND t.expires_at>clock_timestamp())
$$;
CREATE FUNCTION whaleu_profile.self_edit_admit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p whaleu_profile.profiles;original_profile text;original_epochs text;original_epoch_sum numeric;original_identity text;BEGIN
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
 SELECT whaleu_profile.self_edit_epoch_hash(),sum(epoch) INTO original_epochs,original_epoch_sum FROM whaleu_profile.admin_count_epochs;
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
 OR original_epochs IS DISTINCT FROM whaleu_profile.self_edit_epoch_hash()
 OR NEW.identity_hash IS DISTINCT FROM whaleu_profile.moderation_hash(whaleu_profile.moderation_identity_facts(NEW.actor_id,NEW.session_id,NEW.token_hash))
 THEN PERFORM whaleu_profile.self_edit_unavailable();END IF;
 IF current_setting('max_connections')::integer+current_setting('max_prepared_transactions')::integer+current_setting('max_worker_processes')::integer+current_setting('max_wal_senders')::integer>=128
 OR NOT (SELECT count(*)=128 AND min(slot)=0 AND max(slot)=127 AND bool_and(version=1) FROM whaleu_profile.admin_count_epochs)
 THEN PERFORM whaleu_profile.self_edit_unavailable();END IF;
 IF NEW.patch ? 'selectedCampusId' THEN
  PERFORM c.id FROM whaleu_campus.campuses c JOIN whaleu_campus.institutions i ON i.id=c.institution_id WHERE c.id=(NEW.patch->>'selectedCampusId')::uuid AND c.is_active FOR SHARE OF c,i NOWAIT;
  IF NOT FOUND THEN PERFORM whaleu_profile.self_edit_unavailable();END IF;
  SELECT whaleu_profile.moderation_hash(jsonb_build_array(to_jsonb(c),c.xmin::text,c.ctid::text)) INTO NEW.campus_fingerprint FROM whaleu_campus.campuses c WHERE c.id=(NEW.patch->>'selectedCampusId')::uuid;
 ELSE NEW.campus_fingerprint:=NULL;END IF;
 NEW.before_epoch_sum:=original_epoch_sum;
 RETURN NEW;
END$$;
CREATE TRIGGER self_edit_admit BEFORE INSERT ON whaleu_profile.self_edit_causes FOR EACH ROW EXECUTE FUNCTION whaleu_profile.self_edit_admit();
CREATE TRIGGER self_edit_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_profile.self_edit_causes FOR EACH STATEMENT EXECUTE FUNCTION whaleu_profile.moderation_immutable();
CREATE TRIGGER self_edit_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_profile.self_edit_transitions FOR EACH STATEMENT EXECUTE FUNCTION whaleu_profile.moderation_immutable();
CREATE FUNCTION whaleu_profile.self_edit_transition_admit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF pg_trigger_depth()<>2 OR NEW.mutation_transaction<>pg_current_xact_id() THEN PERFORM whaleu_profile.self_edit_unavailable();END IF;RETURN NEW;
END$$;
CREATE TRIGGER self_edit_transition_admit BEFORE INSERT ON whaleu_profile.self_edit_transitions FOR EACH ROW EXECUTE FUNCTION whaleu_profile.self_edit_transition_admit();
CREATE FUNCTION whaleu_profile.self_edit_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_profile.self_edit_causes;fingerprint text;BEGIN
 SELECT * INTO q FROM whaleu_profile.self_edit_causes WHERE mutation_transaction=pg_current_xact_id() ORDER BY id LIMIT 1;
 IF q.id IS NULL THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF TG_OP<>'UPDATE' THEN PERFORM whaleu_profile.self_edit_unavailable();END IF;
 IF OLD.account_id IS DISTINCT FROM q.actor_id OR NEW.account_id IS DISTINCT FROM q.actor_id
 THEN PERFORM whaleu_profile.self_edit_unavailable();END IF;
 SELECT whaleu_profile.moderation_hash(jsonb_build_array(to_jsonb(p),p.xmin::text,p.ctid::text)) INTO fingerprint FROM whaleu_profile.profiles p WHERE account_id=q.actor_id;
 IF fingerprint IS DISTINCT FROM q.before_fingerprint
 OR (SELECT sum(epoch) FROM whaleu_profile.admin_count_epochs) IS DISTINCT FROM q.before_epoch_sum+1
 THEN PERFORM whaleu_profile.self_edit_unavailable();END IF;RETURN NEW;
END$$;
CREATE TRIGGER self_edit_before_update BEFORE INSERT OR UPDATE OR DELETE ON whaleu_profile.profiles FOR EACH ROW EXECUTE FUNCTION whaleu_profile.self_edit_before_update();
CREATE FUNCTION whaleu_profile.self_edit_capture() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_profile.self_edit_causes;expected jsonb;fingerprint text;BEGIN
 SELECT * INTO q FROM whaleu_profile.self_edit_causes WHERE actor_id=NEW.account_id AND mutation_transaction=pg_current_xact_id();
 IF q.id IS NULL THEN RETURN NULL;END IF;
 expected:=q.before_row || jsonb_build_object('revision',q.expected_revision+1);
 IF q.patch ? 'nickname' THEN expected:=expected||jsonb_build_object('nickname',q.patch->'nickname');END IF;
 IF q.patch ? 'bio' THEN expected:=expected||jsonb_build_object('bio',q.patch->'bio');END IF;
 IF q.patch ? 'preferences' THEN expected:=expected||jsonb_build_object('preferences',q.patch->'preferences');END IF;
 IF q.patch ? 'selectedCampusId' THEN expected:=expected||jsonb_build_object('selected_campus_id',q.patch->'selectedCampusId');END IF;
 IF (SELECT sum(epoch) FROM whaleu_profile.admin_count_epochs) IS DISTINCT FROM q.before_epoch_sum+1
 OR to_jsonb(OLD) IS DISTINCT FROM q.before_row
 OR to_jsonb(NEW)-'updated_at' IS DISTINCT FROM expected-'updated_at'
 OR NOT isfinite(NEW.updated_at) OR NEW.updated_at<OLD.updated_at
 THEN PERFORM whaleu_profile.self_edit_unavailable();END IF;
 SELECT whaleu_profile.moderation_hash(jsonb_build_array(to_jsonb(p),p.xmin::text,p.ctid::text)) INTO fingerprint FROM whaleu_profile.profiles p WHERE account_id=q.actor_id;
 INSERT INTO whaleu_profile.self_edit_transitions(cause_id,after_fingerprint,profile_epochs) VALUES(q.id,fingerprint,whaleu_profile.self_edit_epoch_hash());
 RETURN NULL;
END$$;
CREATE TRIGGER self_edit_capture AFTER UPDATE ON whaleu_profile.profiles FOR EACH ROW EXECUTE FUNCTION whaleu_profile.self_edit_capture();
CREATE FUNCTION whaleu_profile.self_edit_assert(q whaleu_profile.self_edit_causes) RETURNS void LANGUAGE plpgsql AS $$
DECLARE t whaleu_profile.self_edit_transitions;fingerprint text;BEGIN
 IF q.mutation_transaction<>pg_current_xact_id() THEN PERFORM whaleu_profile.self_edit_unavailable();END IF;
 LOCK TABLE whaleu_profile.admin_count_epochs,whaleu_identity.accounts,whaleu_identity.sessions,whaleu_identity.access_tokens IN SHARE MODE NOWAIT;
 SELECT * INTO t FROM whaleu_profile.self_edit_transitions WHERE cause_id=q.id;
 SELECT whaleu_profile.moderation_hash(jsonb_build_array(to_jsonb(p),p.xmin::text,p.ctid::text)) INTO fingerprint FROM whaleu_profile.profiles p WHERE account_id=q.actor_id;
 IF t.cause_id IS NULL OR t.mutation_transaction<>pg_current_xact_id()
 OR (SELECT sum(epoch) FROM whaleu_profile.admin_count_epochs) IS DISTINCT FROM q.before_epoch_sum+1
 OR t.after_fingerprint IS DISTINCT FROM fingerprint
 OR t.profile_epochs IS DISTINCT FROM whaleu_profile.self_edit_epoch_hash()
 OR NOT whaleu_profile.self_edit_identity_current(q.actor_id,q.session_id,q.token_hash)
 OR q.identity_hash IS DISTINCT FROM whaleu_profile.moderation_hash(whaleu_profile.moderation_identity_facts(q.actor_id,q.session_id,q.token_hash))
 OR (q.patch ? 'selectedCampusId' AND q.campus_fingerprint IS DISTINCT FROM (SELECT whaleu_profile.moderation_hash(jsonb_build_array(to_jsonb(c),c.xmin::text,c.ctid::text)) FROM whaleu_campus.campuses c WHERE c.id=(q.patch->>'selectedCampusId')::uuid AND c.is_active))
 THEN PERFORM whaleu_profile.self_edit_unavailable();END IF;
 PERFORM whaleu_safety.require_account_punishment_allowed(q.actor_id,'private_self_service');
END$$;
CREATE FUNCTION whaleu_profile.self_edit_complete() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 PERFORM whaleu_profile.self_edit_assert(NEW);RETURN NULL;
END$$;
CREATE CONSTRAINT TRIGGER self_edit_complete AFTER INSERT ON whaleu_profile.self_edit_causes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_profile.self_edit_complete();
-- Even zero-row source statements after SET CONSTRAINTS IMMEDIATE must not
-- silently erase the original proof. No restrictions when no own cause exists.
CREATE FUNCTION whaleu_profile.self_edit_source_writer() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF EXISTS(SELECT 1 FROM whaleu_profile.self_edit_causes q WHERE q.mutation_transaction=pg_current_xact_id()
 AND (TG_TABLE_SCHEMA<>'whaleu_profile' OR EXISTS(SELECT 1 FROM whaleu_profile.self_edit_transitions t WHERE t.cause_id=q.id)))
 THEN PERFORM whaleu_profile.self_edit_unavailable();END IF;RETURN NULL;
END$$;
DO $$DECLARE relation text;BEGIN
 FOREACH relation IN ARRAY ARRAY['whaleu_profile.profiles','whaleu_identity.accounts','whaleu_identity.sessions','whaleu_identity.access_tokens','whaleu_campus.campuses','whaleu_campus.institutions'] LOOP
 EXECUTE format('CREATE TRIGGER a00_self_edit_source_writer BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION whaleu_profile.self_edit_source_writer()',relation);
 END LOOP;
END$$;

-- Append after profile-self-edit-causal.sql; 0136 registers exact keys/action.
CREATE TRIGGER account_policy_consumer_capture AFTER INSERT ON whaleu_profile.self_edit_causes
 FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();
CREATE TRIGGER account_policy_consumer_insert_statement AFTER INSERT ON whaleu_profile.self_edit_causes
 REFERENCING NEW TABLE AS inserted FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_policy_consumer_insert_statement();
