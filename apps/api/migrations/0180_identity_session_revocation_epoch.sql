-- Production-capable epoch consumption foundation. No request authority, epoch
-- advance, credential grant or real account deletion is enabled here.
DO $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_meta.schema_migrations WHERE name='0179_identity_registration_guard.sql') THEN
  RAISE EXCEPTION 'Session epochs require exact registration guard predecessor' USING ERRCODE='23514';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='whaleu_identity'::regnamespace AND proname LIKE 'session_epoch_%') THEN
  RAISE EXCEPTION 'Unknown session epoch namespace' USING ERRCODE='23514';
 END IF;
END$$;
ALTER TABLE whaleu_identity.accounts ADD COLUMN session_revocation_epoch bigint NOT NULL DEFAULT 0
 CONSTRAINT session_epoch_account_nonnegative CHECK(session_revocation_epoch>=0);
ALTER TABLE whaleu_identity.sessions ADD COLUMN issued_revocation_epoch bigint NOT NULL DEFAULT 0
 CONSTRAINT session_epoch_issued_nonnegative CHECK(issued_revocation_epoch>=0);
CREATE FUNCTION whaleu_identity.session_epoch_account_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $epoch$BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.session_revocation_epoch IS DISTINCT FROM 0::bigint THEN
   RAISE EXCEPTION 'New accounts require the initial session epoch' USING ERRCODE='23514',CONSTRAINT='session_epoch_account';
  END IF;
 ELSIF NEW.session_revocation_epoch IS DISTINCT FROM OLD.session_revocation_epoch THEN
  RAISE EXCEPTION 'Real accepted deletion authority is not installed' USING ERRCODE='23514',CONSTRAINT='session_epoch_account';
 END IF;
 RETURN NEW;
END$epoch$;
CREATE FUNCTION whaleu_identity.session_epoch_issued_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $epoch$DECLARE current_epoch bigint;BEGIN
 IF TG_OP='UPDATE' THEN
  IF (NEW.id,NEW.account_id,NEW.issued_revocation_epoch) IS DISTINCT FROM (OLD.id,OLD.account_id,OLD.issued_revocation_epoch) THEN
   RAISE EXCEPTION 'Session identity and issued epoch are immutable' USING ERRCODE='23514',CONSTRAINT='session_epoch_issued';
  END IF;
 ELSE
  SELECT session_revocation_epoch INTO current_epoch FROM whaleu_identity.accounts WHERE id=NEW.account_id FOR SHARE NOWAIT;
  IF current_epoch IS NULL OR NEW.issued_revocation_epoch IS DISTINCT FROM current_epoch THEN
   RAISE EXCEPTION 'Session requires the exact current account epoch' USING ERRCODE='23514',CONSTRAINT='session_epoch_issued';
  END IF;
 END IF;
 RETURN NEW;
END$epoch$;
CREATE FUNCTION whaleu_identity.session_epoch_protocol() RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $epoch$SELECT '{"version":1,"protocol":"identity-session-revocation-epoch-v1","bumpAuthority":"unavailable"}'::jsonb$epoch$;
CREATE TRIGGER session_epoch_account BEFORE INSERT OR UPDATE ON whaleu_identity.accounts
 FOR EACH ROW EXECUTE FUNCTION whaleu_identity.session_epoch_account_guard();
CREATE TRIGGER session_epoch_issued BEFORE INSERT OR UPDATE ON whaleu_identity.sessions
 FOR EACH ROW EXECUTE FUNCTION whaleu_identity.session_epoch_issued_guard();
REVOKE ALL ON FUNCTION whaleu_identity.session_epoch_account_guard(), whaleu_identity.session_epoch_issued_guard(), whaleu_identity.session_epoch_protocol() FROM PUBLIC;
-- No old statement is edited in place. Every current authority body is pinned
-- before adding epoch equality; unknown predecessor drift rolls back everything.

-- Last prior definition: 0057_rating_target_definition_editing.sql:346.
DO $qualify$BEGIN
 IF (SELECT count(*) FROM pg_proc WHERE pronamespace='whaleu_ratings'::regnamespace AND proname='target_edit_session_current')<>1
 OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='whaleu_ratings'::regnamespace AND p.proname='target_edit_session_current' AND p.oid=to_regprocedure('whaleu_ratings.target_edit_session_current(uuid,uuid,timestamptz)') AND p.prokind='f' AND NOT p.prosecdef AND NOT p.proisstrict AND NOT p.proleakproof AND NOT p.proretset AND p.proparallel='u' AND p.proargmodes IS NULL AND p.proallargtypes IS NULL AND p.prosqlbody IS NULL AND p.prosupport=0 AND p.proargdefaults IS NULL AND p.provariadic=0 AND p.pronargs=3 AND p.pronargdefaults=0 AND p.proargnames IS NOT DISTINCT FROM ARRAY['actor','session','instant']::text[] AND p.prorettype='boolean'::regtype AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='sql') AND p.provolatile='s' AND p.proconfig IS NULL AND p.prosrc=$prior$
 SELECT EXISTS(SELECT 1 FROM whaleu_identity.sessions s JOIN whaleu_identity.accounts a ON a.id=s.account_id
  WHERE s.id=session AND s.account_id=actor AND a.status='active' AND s.revoked_at IS NULL
   AND s.created_at<=instant AND s.access_expires_at>instant AND s.refresh_expires_at>instant AND s.absolute_expires_at>instant)
$prior$) THEN
  RAISE EXCEPTION 'Session epoch predecessor function mismatch: whaleu_ratings.target_edit_session_current' USING ERRCODE='23514';
 END IF;
END$qualify$;
CREATE OR REPLACE FUNCTION whaleu_ratings.target_edit_session_current(actor uuid,session uuid,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_identity.sessions s JOIN whaleu_identity.accounts a ON a.id=s.account_id
  WHERE s.id=session AND s.account_id=actor AND a.status='active' AND s.issued_revocation_epoch=a.session_revocation_epoch AND s.revoked_at IS NULL
   AND s.created_at<=instant AND s.access_expires_at>instant AND s.refresh_expires_at>instant AND s.absolute_expires_at>instant)
$$;

-- Last prior definition: 0113_course_comments.sql:99.
DO $qualify$BEGIN
 IF (SELECT count(*) FROM pg_proc WHERE pronamespace='whaleu_identity'::regnamespace AND proname='course_comment_session')<>1
 OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='whaleu_identity'::regnamespace AND p.proname='course_comment_session' AND p.oid=to_regprocedure('whaleu_identity.course_comment_session(uuid,uuid,timestamptz)') AND p.prokind='f' AND NOT p.prosecdef AND NOT p.proisstrict AND NOT p.proleakproof AND NOT p.proretset AND p.proparallel='u' AND p.proargmodes IS NULL AND p.proallargtypes IS NULL AND p.prosqlbody IS NULL AND p.prosupport=0 AND p.proargdefaults IS NULL AND p.provariadic=0 AND p.pronargs=3 AND p.pronargdefaults=0 AND p.proargnames IS NOT DISTINCT FROM ARRAY['actor','sid','instant']::text[] AND p.prorettype='boolean'::regtype AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='sql') AND p.provolatile='s' AND p.proconfig IS NULL AND p.prosrc=$prior$
 SELECT EXISTS(SELECT 1 FROM whaleu_identity.sessions s JOIN whaleu_identity.accounts a ON a.id=s.account_id WHERE s.id=sid AND s.account_id=actor AND a.status='active' AND s.revoked_at IS NULL AND s.access_expires_at>instant AND s.absolute_expires_at>instant)
$prior$) THEN
  RAISE EXCEPTION 'Session epoch predecessor function mismatch: whaleu_identity.course_comment_session' USING ERRCODE='23514';
 END IF;
END$qualify$;
CREATE OR REPLACE FUNCTION whaleu_identity.course_comment_session(actor uuid,sid uuid,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_identity.sessions s JOIN whaleu_identity.accounts a ON a.id=s.account_id WHERE s.id=sid AND s.account_id=actor AND a.status='active' AND s.issued_revocation_epoch=a.session_revocation_epoch AND s.revoked_at IS NULL AND s.access_expires_at>instant AND s.absolute_expires_at>instant)
$$;

-- Last prior definition: 0114_window_ratings.sql:84.
DO $qualify$BEGIN
 IF (SELECT count(*) FROM pg_proc WHERE pronamespace='whaleu_identity'::regnamespace AND proname='window_rating_session')<>1
 OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='whaleu_identity'::regnamespace AND p.proname='window_rating_session' AND p.oid=to_regprocedure('whaleu_identity.window_rating_session(uuid,uuid,timestamptz)') AND p.prokind='f' AND NOT p.prosecdef AND NOT p.proisstrict AND NOT p.proleakproof AND NOT p.proretset AND p.proparallel='u' AND p.proargmodes IS NULL AND p.proallargtypes IS NULL AND p.prosqlbody IS NULL AND p.prosupport=0 AND p.proargdefaults IS NULL AND p.provariadic=0 AND p.pronargs=3 AND p.pronargdefaults=0 AND p.proargnames IS NOT DISTINCT FROM ARRAY['actor','sid','instant']::text[] AND p.prorettype='boolean'::regtype AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='sql') AND p.provolatile='s' AND p.proconfig IS NULL AND p.prosrc=$prior$
 SELECT EXISTS(SELECT 1 FROM whaleu_identity.sessions s JOIN whaleu_identity.accounts a ON a.id=s.account_id WHERE s.id=sid AND s.account_id=actor AND a.status='active' AND s.revoked_at IS NULL AND s.access_expires_at>instant AND s.absolute_expires_at>instant)
$prior$) THEN
  RAISE EXCEPTION 'Session epoch predecessor function mismatch: whaleu_identity.window_rating_session' USING ERRCODE='23514';
 END IF;
END$qualify$;
CREATE OR REPLACE FUNCTION whaleu_identity.window_rating_session(actor uuid,sid uuid,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_identity.sessions s JOIN whaleu_identity.accounts a ON a.id=s.account_id WHERE s.id=sid AND s.account_id=actor AND a.status='active' AND s.issued_revocation_epoch=a.session_revocation_epoch AND s.revoked_at IS NULL AND s.access_expires_at>instant AND s.absolute_expires_at>instant)
$$;

-- Last prior definition: 0121_major_discussion.sql:59.
DO $qualify$BEGIN
 IF (SELECT count(*) FROM pg_proc WHERE pronamespace='whaleu_identity'::regnamespace AND proname='major_rating_session')<>1
 OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='whaleu_identity'::regnamespace AND p.proname='major_rating_session' AND p.oid=to_regprocedure('whaleu_identity.major_rating_session(uuid,uuid,timestamptz)') AND p.prokind='f' AND NOT p.prosecdef AND NOT p.proisstrict AND NOT p.proleakproof AND NOT p.proretset AND p.proparallel='u' AND p.proargmodes IS NULL AND p.proallargtypes IS NULL AND p.prosqlbody IS NULL AND p.prosupport=0 AND p.proargdefaults IS NULL AND p.provariadic=0 AND p.pronargs=3 AND p.pronargdefaults=0 AND p.proargnames IS NOT DISTINCT FROM ARRAY['actor','sid','instant']::text[] AND p.prorettype='boolean'::regtype AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='sql') AND p.provolatile='s' AND p.proconfig IS NULL AND p.prosrc=$prior$
 SELECT EXISTS(SELECT 1 FROM whaleu_identity.sessions s JOIN whaleu_identity.accounts a ON a.id=s.account_id WHERE s.id=sid AND s.account_id=actor AND a.status='active' AND s.revoked_at IS NULL AND s.access_expires_at>instant AND s.absolute_expires_at>instant)
$prior$) THEN
  RAISE EXCEPTION 'Session epoch predecessor function mismatch: whaleu_identity.major_rating_session' USING ERRCODE='23514';
 END IF;
END$qualify$;
CREATE OR REPLACE FUNCTION whaleu_identity.major_rating_session(actor uuid,sid uuid,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_identity.sessions s JOIN whaleu_identity.accounts a ON a.id=s.account_id WHERE s.id=sid AND s.account_id=actor AND a.status='active' AND s.issued_revocation_epoch=a.session_revocation_epoch AND s.revoked_at IS NULL AND s.access_expires_at>instant AND s.absolute_expires_at>instant)
$$;

-- Last prior definition: 0126_owner_post_visibility.sql:101.
DO $qualify$BEGIN
 IF (SELECT count(*) FROM pg_proc WHERE pronamespace='whaleu_community'::regnamespace AND proname='post_owner_visibility_complete')<>1
 OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='whaleu_community'::regnamespace AND p.proname='post_owner_visibility_complete' AND p.oid=to_regprocedure('whaleu_community.post_owner_visibility_complete()') AND p.prokind='f' AND NOT p.prosecdef AND NOT p.proisstrict AND NOT p.proleakproof AND NOT p.proretset AND p.proparallel='u' AND p.proargmodes IS NULL AND p.proallargtypes IS NULL AND p.prosqlbody IS NULL AND p.prosupport=0 AND p.proargdefaults IS NULL AND p.provariadic=0 AND p.pronargs=0 AND p.pronargdefaults=0 AND p.proargnames IS NOT DISTINCT FROM NULL::text[] AND p.prorettype='trigger'::regtype AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql') AND p.provolatile='v' AND p.proconfig IS NULL AND p.prosrc=$prior$
DECLARE target whaleu_community.posts;state whaleu_community.post_owner_visibility;instant timestamptz:=clock_timestamp();
BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_identity.sessions s JOIN whaleu_identity.accounts a ON a.id=s.account_id WHERE s.id=NEW.session_id AND s.account_id=NEW.actor_id AND a.status='active' AND s.revoked_at IS NULL AND s.absolute_expires_at>instant) THEN RAISE EXCEPTION 'Current authenticated actor session required' USING ERRCODE='23514',CONSTRAINT='post_owner_visibility_causal';END IF;
 SELECT * INTO target FROM whaleu_community.posts WHERE id=NEW.post_id;
 SELECT * INTO state FROM whaleu_community.post_owner_visibility WHERE post_id=NEW.post_id;
 IF target.id IS NULL OR target.account_id<>NEW.actor_id THEN RAISE EXCEPTION 'Exact owner required' USING ERRCODE='23514',CONSTRAINT='post_owner_visibility_causal';END IF;
 IF NEW.receipt->>'outcome'='applied' THEN
  IF (NEW.command->>'ownerHidden')::boolean=false THEN PERFORM whaleu_community.require_post_owner_restore_safety(NEW.actor_id);END IF;
  IF target.deleted_at IS NOT NULL OR state.post_id IS NULL
    OR (state.actor_id,state.request_id,state.mutation_transaction) IS DISTINCT FROM (NEW.actor_id,NEW.request_id,pg_current_xact_id())
    OR state.owner_hidden IS DISTINCT FROM (NEW.command->>'ownerHidden')::boolean
    OR state.version<>(NEW.command->>'expectedVersion')::integer+1
    OR state.updated_at IS DISTINCT FROM (NEW.receipt->>'recordedAt')::timestamptz
  THEN RAISE EXCEPTION 'Applied receipt requires exact atomic surviving state' USING ERRCODE='23514',CONSTRAINT='post_owner_visibility_causal';END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM whaleu_community.post_owner_visibility WHERE actor_id=NEW.actor_id AND request_id=NEW.request_id) THEN RAISE EXCEPTION 'Rejected owner request cannot change state' USING ERRCODE='23514',CONSTRAINT='post_owner_visibility_causal';END IF;
  IF NEW.receipt->>'code'='POST_OWNER_VISIBILITY_CANCELLED' THEN RETURN NULL;END IF;
  IF NEW.receipt->>'code'='POST_OWNER_VISIBILITY_UNAVAILABLE' AND target.deleted_at IS NOT NULL THEN RETURN NULL;END IF;
  IF NEW.receipt->>'code'='POST_OWNER_VISIBILITY_STALE' AND target.deleted_at IS NULL AND coalesce(state.version,0)<>(NEW.command->>'expectedVersion')::integer THEN RETURN NULL;END IF;
  RAISE EXCEPTION 'Owner visibility rejection must be causal' USING ERRCODE='23514',CONSTRAINT='post_owner_visibility_causal';
 END IF;
 RETURN NULL;
END$prior$) THEN
  RAISE EXCEPTION 'Session epoch predecessor function mismatch: whaleu_community.post_owner_visibility_complete' USING ERRCODE='23514';
 END IF;
END$qualify$;
CREATE OR REPLACE FUNCTION whaleu_community.post_owner_visibility_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target whaleu_community.posts;state whaleu_community.post_owner_visibility;instant timestamptz:=clock_timestamp();
BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_identity.sessions s JOIN whaleu_identity.accounts a ON a.id=s.account_id WHERE s.id=NEW.session_id AND s.account_id=NEW.actor_id AND a.status='active' AND s.issued_revocation_epoch=a.session_revocation_epoch AND s.revoked_at IS NULL AND s.absolute_expires_at>instant) THEN RAISE EXCEPTION 'Current authenticated actor session required' USING ERRCODE='23514',CONSTRAINT='post_owner_visibility_causal';END IF;
 SELECT * INTO target FROM whaleu_community.posts WHERE id=NEW.post_id;
 SELECT * INTO state FROM whaleu_community.post_owner_visibility WHERE post_id=NEW.post_id;
 IF target.id IS NULL OR target.account_id<>NEW.actor_id THEN RAISE EXCEPTION 'Exact owner required' USING ERRCODE='23514',CONSTRAINT='post_owner_visibility_causal';END IF;
 IF NEW.receipt->>'outcome'='applied' THEN
  IF (NEW.command->>'ownerHidden')::boolean=false THEN PERFORM whaleu_community.require_post_owner_restore_safety(NEW.actor_id);END IF;
  IF target.deleted_at IS NOT NULL OR state.post_id IS NULL
    OR (state.actor_id,state.request_id,state.mutation_transaction) IS DISTINCT FROM (NEW.actor_id,NEW.request_id,pg_current_xact_id())
    OR state.owner_hidden IS DISTINCT FROM (NEW.command->>'ownerHidden')::boolean
    OR state.version<>(NEW.command->>'expectedVersion')::integer+1
    OR state.updated_at IS DISTINCT FROM (NEW.receipt->>'recordedAt')::timestamptz
  THEN RAISE EXCEPTION 'Applied receipt requires exact atomic surviving state' USING ERRCODE='23514',CONSTRAINT='post_owner_visibility_causal';END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM whaleu_community.post_owner_visibility WHERE actor_id=NEW.actor_id AND request_id=NEW.request_id) THEN RAISE EXCEPTION 'Rejected owner request cannot change state' USING ERRCODE='23514',CONSTRAINT='post_owner_visibility_causal';END IF;
  IF NEW.receipt->>'code'='POST_OWNER_VISIBILITY_CANCELLED' THEN RETURN NULL;END IF;
  IF NEW.receipt->>'code'='POST_OWNER_VISIBILITY_UNAVAILABLE' AND target.deleted_at IS NOT NULL THEN RETURN NULL;END IF;
  IF NEW.receipt->>'code'='POST_OWNER_VISIBILITY_STALE' AND target.deleted_at IS NULL AND coalesce(state.version,0)<>(NEW.command->>'expectedVersion')::integer THEN RETURN NULL;END IF;
  RAISE EXCEPTION 'Owner visibility rejection must be causal' USING ERRCODE='23514',CONSTRAINT='post_owner_visibility_causal';
 END IF;
 RETURN NULL;
END$$;

-- Last prior definition: 0127_scoped_category_reclassification.sql:402.
DO $qualify$BEGIN
 IF (SELECT count(*) FROM pg_proc WHERE pronamespace='whaleu_community'::regnamespace AND proname='post_category_complete')<>1
 OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='whaleu_community'::regnamespace AND p.proname='post_category_complete' AND p.oid=to_regprocedure('whaleu_community.post_category_complete()') AND p.prokind='f' AND NOT p.prosecdef AND NOT p.proisstrict AND NOT p.proleakproof AND NOT p.proretset AND p.proparallel='u' AND p.proargmodes IS NULL AND p.proallargtypes IS NULL AND p.prosqlbody IS NULL AND p.prosupport=0 AND p.proargdefaults IS NULL AND p.provariadic=0 AND p.pronargs=0 AND p.pronargdefaults=0 AND p.proargnames IS NOT DISTINCT FROM NULL::text[] AND p.prorettype='trigger'::regtype AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql') AND p.provolatile='v' AND p.proconfig IS NULL AND p.prosrc=$prior$
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
 RETURN NULL;END$prior$) THEN
  RAISE EXCEPTION 'Session epoch predecessor function mismatch: whaleu_community.post_category_complete' USING ERRCODE='23514';
 END IF;
END$qualify$;
CREATE OR REPLACE FUNCTION whaleu_community.post_category_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h whaleu_community.post_category_heads;e whaleu_community.post_category_events;p whaleu_community.posts;selected_token text;BEGIN
 -- Raw writers receive the same retained identity fences as ordinary callers.
 -- The command records a session, not its bearer token: preserve the existing
 -- one-live-token-in-session SQL contract; API separately proves its exact token.
 PERFORM id FROM whaleu_identity.accounts WHERE id=NEW.actor_id FOR SHARE NOWAIT;
 PERFORM id FROM whaleu_identity.sessions WHERE id=NEW.session_id AND account_id=NEW.actor_id FOR SHARE NOWAIT;
 SELECT token.token_hash INTO selected_token FROM whaleu_identity.access_tokens token
 WHERE token.session_id=NEW.session_id AND token.expires_at>clock_timestamp()
 ORDER BY token.expires_at DESC,token.token_hash LIMIT 1 FOR SHARE NOWAIT;
 IF NOT EXISTS(SELECT 1 FROM whaleu_identity.sessions s JOIN whaleu_identity.accounts a ON a.id=s.account_id WHERE s.id=NEW.session_id AND s.account_id=NEW.actor_id AND a.status='active' AND s.issued_revocation_epoch=a.session_revocation_epoch AND s.revoked_at IS NULL AND s.absolute_expires_at>clock_timestamp()
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

-- Last prior definition: 0128_scoped_profile_nickname_moderation.sql:39.
DO $qualify$BEGIN
 IF (SELECT count(*) FROM pg_proc WHERE pronamespace='whaleu_profile'::regnamespace AND proname='moderation_identity_current')<>1
 OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='whaleu_profile'::regnamespace AND p.proname='moderation_identity_current' AND p.oid=to_regprocedure('whaleu_profile.moderation_identity_current(uuid,uuid,text)') AND p.prokind='f' AND NOT p.prosecdef AND NOT p.proisstrict AND NOT p.proleakproof AND NOT p.proretset AND p.proparallel='u' AND p.proargmodes IS NULL AND p.proallargtypes IS NULL AND p.prosqlbody IS NULL AND p.prosupport=0 AND p.proargdefaults IS NULL AND p.provariadic=0 AND p.pronargs=3 AND p.pronargdefaults=0 AND p.proargnames IS NOT DISTINCT FROM ARRAY['actor','session','token']::text[] AND p.prorettype='boolean'::regtype AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='sql') AND p.provolatile='s' AND p.proconfig IS NULL AND p.prosrc=$prior$
 SELECT EXISTS(SELECT 1 FROM whaleu_identity.accounts a JOIN whaleu_identity.sessions s ON s.account_id=a.id JOIN whaleu_identity.access_tokens t ON t.session_id=s.id
 WHERE a.id=actor AND a.status='active' AND s.id=session AND s.revoked_at IS NULL AND s.absolute_expires_at>clock_timestamp() AND t.token_hash=token AND t.expires_at>clock_timestamp())
$prior$) THEN
  RAISE EXCEPTION 'Session epoch predecessor function mismatch: whaleu_profile.moderation_identity_current' USING ERRCODE='23514';
 END IF;
END$qualify$;
CREATE OR REPLACE FUNCTION whaleu_profile.moderation_identity_current(actor uuid,session uuid,token text) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_identity.accounts a JOIN whaleu_identity.sessions s ON s.account_id=a.id JOIN whaleu_identity.access_tokens t ON t.session_id=s.id
 WHERE a.id=actor AND a.status='active' AND s.issued_revocation_epoch=a.session_revocation_epoch AND s.id=session AND s.revoked_at IS NULL AND s.absolute_expires_at>clock_timestamp() AND t.token_hash=token AND t.expires_at>clock_timestamp())
$$;

-- Last prior definition: 0136_account_policy_consumers.sql:727.
DO $qualify$BEGIN
 IF (SELECT count(*) FROM pg_proc WHERE pronamespace='whaleu_profile'::regnamespace AND proname='self_edit_identity_current')<>1
 OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='whaleu_profile'::regnamespace AND p.proname='self_edit_identity_current' AND p.oid=to_regprocedure('whaleu_profile.self_edit_identity_current(uuid,uuid,text)') AND p.prokind='f' AND NOT p.prosecdef AND NOT p.proisstrict AND NOT p.proleakproof AND NOT p.proretset AND p.proparallel='u' AND p.proargmodes IS NULL AND p.proallargtypes IS NULL AND p.prosqlbody IS NULL AND p.prosupport=0 AND p.proargdefaults IS NULL AND p.provariadic=0 AND p.pronargs=3 AND p.pronargdefaults=0 AND p.proargnames IS NOT DISTINCT FROM ARRAY['actor','session','token']::text[] AND p.prorettype='boolean'::regtype AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='sql') AND p.provolatile='v' AND p.proconfig IS NULL AND p.prosrc=$prior$
 SELECT EXISTS(SELECT 1 FROM whaleu_identity.accounts a JOIN whaleu_identity.sessions s ON s.account_id=a.id JOIN whaleu_identity.access_tokens t ON t.session_id=s.id
 WHERE a.id=actor AND a.status='active' AND s.id=session AND s.revoked_at IS NULL AND s.access_expires_at>clock_timestamp() AND s.absolute_expires_at>clock_timestamp() AND t.token_hash=token AND t.expires_at>clock_timestamp())
$prior$) THEN
  RAISE EXCEPTION 'Session epoch predecessor function mismatch: whaleu_profile.self_edit_identity_current' USING ERRCODE='23514';
 END IF;
END$qualify$;
CREATE OR REPLACE FUNCTION whaleu_profile.self_edit_identity_current(actor uuid,session uuid,token text) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_identity.accounts a JOIN whaleu_identity.sessions s ON s.account_id=a.id JOIN whaleu_identity.access_tokens t ON t.session_id=s.id
 WHERE a.id=actor AND a.status='active' AND s.issued_revocation_epoch=a.session_revocation_epoch AND s.id=session AND s.revoked_at IS NULL AND s.access_expires_at>clock_timestamp() AND s.absolute_expires_at>clock_timestamp() AND t.token_hash=token AND t.expires_at>clock_timestamp())
$$;

-- Last prior definition: 0140_related_campus_scoped_management.sql:684.
DO $qualify$BEGIN
 IF (SELECT count(*) FROM pg_proc WHERE pronamespace='whaleu_community'::regnamespace AND proname='post_pin_assert_complete')<>1
 OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='whaleu_community'::regnamespace AND p.proname='post_pin_assert_complete' AND p.oid=to_regprocedure('whaleu_community.post_pin_assert_complete(whaleu_community.post_pin_commands)') AND p.prokind='f' AND NOT p.prosecdef AND NOT p.proisstrict AND NOT p.proleakproof AND NOT p.proretset AND p.proparallel='u' AND p.proargmodes IS NULL AND p.proallargtypes IS NULL AND p.prosqlbody IS NULL AND p.prosupport=0 AND p.proargdefaults IS NULL AND p.provariadic=0 AND p.pronargs=1 AND p.pronargdefaults=0 AND p.proargnames IS NOT DISTINCT FROM ARRAY['q']::text[] AND p.prorettype='void'::regtype AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql') AND p.provolatile='v' AND p.proconfig IS NULL AND p.prosrc=$prior$
DECLARE instant timestamptz:=clock_timestamp();scope whaleu_community.post_pin_scopes;target whaleu_community.posts;pin whaleu_community.post_pins;operation text:=q.command->>'operation';applied boolean:=q.receipt->>'outcome'='applied';current_pin uuid;
BEGIN
 IF q.transaction_id<>pg_current_xact_id() OR NOT EXISTS(SELECT 1 FROM whaleu_identity.sessions s JOIN whaleu_identity.accounts a ON a.id=s.account_id WHERE s.id=q.session_id AND s.account_id=q.actor_id AND a.status='active' AND s.revoked_at IS NULL AND s.absolute_expires_at>instant) THEN RAISE EXCEPTION 'Current actor session required for pin command' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 IF operation IS NULL OR operation NOT IN('pin','unpin','read') OR NOT whaleu_community.post_pin_keys(q.command,CASE WHEN operation='pin' THEN ARRAY['clientRequestId','operation','postId','durationHours','level'] ELSE ARRAY['clientRequestId','operation','postId','pinId'] END || CASE WHEN q.command->'version'='2'::jsonb THEN ARRAY['version','spaceId'] ELSE ARRAY[]::text[] END) OR NOT whaleu_community.post_pin_keys(q.receipt,CASE WHEN applied THEN ARRAY['requestId','operation','postId','outcome','pinId','recordedAt'] ELSE ARRAY['requestId','operation','postId','outcome','code'] END) THEN RAISE EXCEPTION 'Exact pin intent and receipt required' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 IF q.receipt->>'outcome'='rejected' AND q.receipt->>'code'='POST_PIN_CANCELLED' AND NOT applied THEN
  IF q.scope_id IS NOT NULL OR q.grant_id IS NOT NULL OR EXISTS(SELECT 1 FROM whaleu_community.post_pins WHERE actor_id=q.actor_id AND request_id=q.request_id) OR EXISTS(SELECT 1 FROM whaleu_community.post_pin_closures WHERE actor_id=q.actor_id AND request_id=q.request_id) OR EXISTS(SELECT 1 FROM whaleu_community.post_pin_reads WHERE actor_id=q.actor_id AND request_id=q.request_id) THEN RAISE EXCEPTION 'Cancelled pin request cannot mutate' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
  RETURN;
 END IF;
 SELECT * INTO scope FROM whaleu_community.post_pin_scopes WHERE id=q.scope_id;
 IF scope.id IS NULL OR scope.accepted_at>instant OR scope.valid_until<=instant OR NOT EXISTS(SELECT 1 FROM whaleu_community.post_pin_history h WHERE h.scope_id=scope.id AND h.coverage='accepted_empty' AND h.accepted_at<=instant AND h.valid_until>instant) OR NOT EXISTS(SELECT 1 FROM whaleu_community.spaces s WHERE s.id=scope.space_id AND s.is_active AND ((scope.kind='regional' AND s.kind='regional' AND s.operating_region_id=scope.operating_region_id AND EXISTS(SELECT 1 FROM whaleu_campus.operating_regions r WHERE r.id=scope.operating_region_id AND r.is_active)) OR(scope.kind<>'regional' AND s.kind='global' AND s.operating_region_id IS NULL))) THEN RAISE EXCEPTION 'Current accepted pin scope and independent history required' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 IF operation<>'read' AND NOT EXISTS(SELECT 1 FROM whaleu_authorization.role_grants g WHERE g.id=q.grant_id AND g.account_id=q.actor_id AND g.revoked_at IS NULL AND g.valid_from<=instant AND (g.expires_at IS NULL OR g.expires_at>instant) AND (((g.role='super_admin' OR (g.role='developer' AND NOT EXISTS(SELECT 1 FROM whaleu_community.posts p WHERE p.id=(q.command->>'postId')::uuid AND p.space_id<>scope.space_id))) AND g.operating_region_id IS NULL) OR(g.role='school_admin' AND scope.kind='regional' AND g.operating_region_id=scope.operating_region_id))) THEN RAISE EXCEPTION 'Exact current scoped pin grant required' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 SELECT * INTO target FROM whaleu_community.posts WHERE id=(q.command->>'postId')::uuid;
 IF target.id IS NULL THEN RAISE EXCEPTION 'Pin command target required' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 IF q.command->'version'='2'::jsonb THEN
  IF operation='unpin' THEN
   -- Cleanup keeps only the exact current destination grant. It does not reopen
   -- topology, Review, Media or distribution owners for a withdrawn projection.
   LOCK TABLE whaleu_authorization.role_grants,whaleu_authorization.account_punishment_authority_epoch IN SHARE MODE NOWAIT;
  ELSE PERFORM whaleu_community.related_content_grant_fence();END IF;
  IF scope.space_id::text IS DISTINCT FROM q.command->>'spaceId' OR q.distribution_before IS NULL THEN RAISE EXCEPTION 'Exact destination command required' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
  IF operation='unpin' THEN
   IF q.distribution_before IS DISTINCT FROM jsonb_build_object('grant',(SELECT jsonb_build_array(to_jsonb(g),g.xmin::text,g.ctid::text) FROM whaleu_authorization.role_grants g WHERE g.id=q.grant_id),'authorityGeneration',whaleu_safety.account_punishment_authority_epoch()) THEN RAISE EXCEPTION 'Exact original cleanup grant required' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
  ELSIF NOT whaleu_community.related_pin_visible(q.actor_id,target.id,scope.space_id)
   OR q.distribution_before IS DISTINCT FROM whaleu_community.related_pin_facts(q.actor_id,target.id,scope.space_id)
   OR EXISTS(SELECT 1 FROM whaleu_community.post_pins p WHERE p.actor_id=q.actor_id AND p.request_id=q.request_id AND p.distribution_before IS DISTINCT FROM q.distribution_before)
   OR EXISTS(SELECT 1 FROM whaleu_community.post_pin_reads r WHERE r.actor_id=q.actor_id AND r.request_id=q.request_id AND r.distribution_before IS DISTINCT FROM q.distribution_before)
   THEN RAISE EXCEPTION 'Original current pin projection required' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 ELSIF target.space_id<>scope.space_id THEN RAISE EXCEPTION 'Legacy pin command cannot select remote destination' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 SELECT p.id INTO current_pin FROM whaleu_community.post_pin_heads h JOIN whaleu_community.post_pins p ON p.id=h.pin_id JOIN whaleu_community.posts post ON post.id=p.post_id WHERE h.scope_id=scope.id AND p.pinned_until>instant AND post.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM whaleu_community.post_pin_closures c WHERE c.pin_id=p.id);
 IF NOT applied THEN
  IF EXISTS(SELECT 1 FROM whaleu_community.post_pins WHERE actor_id=q.actor_id AND request_id=q.request_id) OR EXISTS(SELECT 1 FROM whaleu_community.post_pin_closures WHERE actor_id=q.actor_id AND request_id=q.request_id) OR EXISTS(SELECT 1 FROM whaleu_community.post_pin_reads WHERE actor_id=q.actor_id AND request_id=q.request_id) THEN RAISE EXCEPTION 'Rejected pin command cannot mutate' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
  IF q.receipt->>'code'='POST_PIN_CONFLICT' AND operation='pin' AND EXISTS(SELECT 1 FROM whaleu_community.post_pins WHERE id=current_pin AND post_id<>target.id) THEN RETURN;END IF;
  IF q.receipt->>'code'='POST_PIN_STALE' AND operation IN('read','unpin') AND NOT EXISTS(SELECT 1 FROM whaleu_community.post_pins WHERE id=current_pin AND id=(q.command->>'pinId')::uuid AND post_id=target.id) THEN RETURN;END IF;
  RAISE EXCEPTION 'Pin rejection must be causal' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';
 END IF;
 SELECT * INTO pin FROM whaleu_community.post_pins WHERE id=(q.receipt->>'pinId')::uuid;
 IF pin.id IS NULL OR pin.scope_id<>scope.id OR pin.post_id<>target.id THEN RAISE EXCEPTION 'Exact pin receipt target required' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 IF operation='pin' THEN
  IF (q.receipt->>'recordedAt')::timestamptz IS DISTINCT FROM date_trunc('milliseconds',pin.pinned_at) OR pin.actor_id<>q.actor_id OR pin.request_id<>q.request_id OR pin.id IS DISTINCT FROM current_pin THEN RAISE EXCEPTION 'Pin receipt needs atomic current identity' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 ELSIF pin.id::text IS DISTINCT FROM q.command->>'pinId' THEN RAISE EXCEPTION 'Exact original pin required' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';
 ELSIF operation='unpin' THEN
  IF NOT EXISTS(SELECT 1 FROM whaleu_community.post_pin_closures WHERE pin_id=pin.id AND reason='unpin' AND actor_id=q.actor_id AND request_id=q.request_id AND date_trunc('milliseconds',closed_at)=(q.receipt->>'recordedAt')::timestamptz) THEN RAISE EXCEPTION 'Unpin receipt needs exact atomic closure' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 ELSE
  IF pin.id IS DISTINCT FROM current_pin OR target.visibility<>'approved' OR target.deleted_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM whaleu_community.post_pin_reads WHERE actor_id=q.actor_id AND pin_id=pin.id AND date_trunc('milliseconds',read_at)=(q.receipt->>'recordedAt')::timestamptz) THEN RAISE EXCEPTION 'Read receipt needs visible current exact pin marker' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 END IF;
 RETURN;
END$prior$) THEN
  RAISE EXCEPTION 'Session epoch predecessor function mismatch: whaleu_community.post_pin_assert_complete' USING ERRCODE='23514';
 END IF;
END$qualify$;
CREATE OR REPLACE FUNCTION whaleu_community.post_pin_assert_complete(q whaleu_community.post_pin_commands) RETURNS void LANGUAGE plpgsql AS $$
DECLARE instant timestamptz:=clock_timestamp();scope whaleu_community.post_pin_scopes;target whaleu_community.posts;pin whaleu_community.post_pins;operation text:=q.command->>'operation';applied boolean:=q.receipt->>'outcome'='applied';current_pin uuid;
BEGIN
 IF q.transaction_id<>pg_current_xact_id() OR NOT EXISTS(SELECT 1 FROM whaleu_identity.sessions s JOIN whaleu_identity.accounts a ON a.id=s.account_id WHERE s.id=q.session_id AND s.account_id=q.actor_id AND a.status='active' AND s.issued_revocation_epoch=a.session_revocation_epoch AND s.revoked_at IS NULL AND s.absolute_expires_at>instant) THEN RAISE EXCEPTION 'Current actor session required for pin command' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 IF operation IS NULL OR operation NOT IN('pin','unpin','read') OR NOT whaleu_community.post_pin_keys(q.command,CASE WHEN operation='pin' THEN ARRAY['clientRequestId','operation','postId','durationHours','level'] ELSE ARRAY['clientRequestId','operation','postId','pinId'] END || CASE WHEN q.command->'version'='2'::jsonb THEN ARRAY['version','spaceId'] ELSE ARRAY[]::text[] END) OR NOT whaleu_community.post_pin_keys(q.receipt,CASE WHEN applied THEN ARRAY['requestId','operation','postId','outcome','pinId','recordedAt'] ELSE ARRAY['requestId','operation','postId','outcome','code'] END) THEN RAISE EXCEPTION 'Exact pin intent and receipt required' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 IF q.receipt->>'outcome'='rejected' AND q.receipt->>'code'='POST_PIN_CANCELLED' AND NOT applied THEN
  IF q.scope_id IS NOT NULL OR q.grant_id IS NOT NULL OR EXISTS(SELECT 1 FROM whaleu_community.post_pins WHERE actor_id=q.actor_id AND request_id=q.request_id) OR EXISTS(SELECT 1 FROM whaleu_community.post_pin_closures WHERE actor_id=q.actor_id AND request_id=q.request_id) OR EXISTS(SELECT 1 FROM whaleu_community.post_pin_reads WHERE actor_id=q.actor_id AND request_id=q.request_id) THEN RAISE EXCEPTION 'Cancelled pin request cannot mutate' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
  RETURN;
 END IF;
 SELECT * INTO scope FROM whaleu_community.post_pin_scopes WHERE id=q.scope_id;
 IF scope.id IS NULL OR scope.accepted_at>instant OR scope.valid_until<=instant OR NOT EXISTS(SELECT 1 FROM whaleu_community.post_pin_history h WHERE h.scope_id=scope.id AND h.coverage='accepted_empty' AND h.accepted_at<=instant AND h.valid_until>instant) OR NOT EXISTS(SELECT 1 FROM whaleu_community.spaces s WHERE s.id=scope.space_id AND s.is_active AND ((scope.kind='regional' AND s.kind='regional' AND s.operating_region_id=scope.operating_region_id AND EXISTS(SELECT 1 FROM whaleu_campus.operating_regions r WHERE r.id=scope.operating_region_id AND r.is_active)) OR(scope.kind<>'regional' AND s.kind='global' AND s.operating_region_id IS NULL))) THEN RAISE EXCEPTION 'Current accepted pin scope and independent history required' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 IF operation<>'read' AND NOT EXISTS(SELECT 1 FROM whaleu_authorization.role_grants g WHERE g.id=q.grant_id AND g.account_id=q.actor_id AND g.revoked_at IS NULL AND g.valid_from<=instant AND (g.expires_at IS NULL OR g.expires_at>instant) AND (((g.role='super_admin' OR (g.role='developer' AND NOT EXISTS(SELECT 1 FROM whaleu_community.posts p WHERE p.id=(q.command->>'postId')::uuid AND p.space_id<>scope.space_id))) AND g.operating_region_id IS NULL) OR(g.role='school_admin' AND scope.kind='regional' AND g.operating_region_id=scope.operating_region_id))) THEN RAISE EXCEPTION 'Exact current scoped pin grant required' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 SELECT * INTO target FROM whaleu_community.posts WHERE id=(q.command->>'postId')::uuid;
 IF target.id IS NULL THEN RAISE EXCEPTION 'Pin command target required' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 IF q.command->'version'='2'::jsonb THEN
  IF operation='unpin' THEN
   -- Cleanup keeps only the exact current destination grant. It does not reopen
   -- topology, Review, Media or distribution owners for a withdrawn projection.
   LOCK TABLE whaleu_authorization.role_grants,whaleu_authorization.account_punishment_authority_epoch IN SHARE MODE NOWAIT;
  ELSE PERFORM whaleu_community.related_content_grant_fence();END IF;
  IF scope.space_id::text IS DISTINCT FROM q.command->>'spaceId' OR q.distribution_before IS NULL THEN RAISE EXCEPTION 'Exact destination command required' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
  IF operation='unpin' THEN
   IF q.distribution_before IS DISTINCT FROM jsonb_build_object('grant',(SELECT jsonb_build_array(to_jsonb(g),g.xmin::text,g.ctid::text) FROM whaleu_authorization.role_grants g WHERE g.id=q.grant_id),'authorityGeneration',whaleu_safety.account_punishment_authority_epoch()) THEN RAISE EXCEPTION 'Exact original cleanup grant required' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
  ELSIF NOT whaleu_community.related_pin_visible(q.actor_id,target.id,scope.space_id)
   OR q.distribution_before IS DISTINCT FROM whaleu_community.related_pin_facts(q.actor_id,target.id,scope.space_id)
   OR EXISTS(SELECT 1 FROM whaleu_community.post_pins p WHERE p.actor_id=q.actor_id AND p.request_id=q.request_id AND p.distribution_before IS DISTINCT FROM q.distribution_before)
   OR EXISTS(SELECT 1 FROM whaleu_community.post_pin_reads r WHERE r.actor_id=q.actor_id AND r.request_id=q.request_id AND r.distribution_before IS DISTINCT FROM q.distribution_before)
   THEN RAISE EXCEPTION 'Original current pin projection required' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 ELSIF target.space_id<>scope.space_id THEN RAISE EXCEPTION 'Legacy pin command cannot select remote destination' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 SELECT p.id INTO current_pin FROM whaleu_community.post_pin_heads h JOIN whaleu_community.post_pins p ON p.id=h.pin_id JOIN whaleu_community.posts post ON post.id=p.post_id WHERE h.scope_id=scope.id AND p.pinned_until>instant AND post.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM whaleu_community.post_pin_closures c WHERE c.pin_id=p.id);
 IF NOT applied THEN
  IF EXISTS(SELECT 1 FROM whaleu_community.post_pins WHERE actor_id=q.actor_id AND request_id=q.request_id) OR EXISTS(SELECT 1 FROM whaleu_community.post_pin_closures WHERE actor_id=q.actor_id AND request_id=q.request_id) OR EXISTS(SELECT 1 FROM whaleu_community.post_pin_reads WHERE actor_id=q.actor_id AND request_id=q.request_id) THEN RAISE EXCEPTION 'Rejected pin command cannot mutate' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
  IF q.receipt->>'code'='POST_PIN_CONFLICT' AND operation='pin' AND EXISTS(SELECT 1 FROM whaleu_community.post_pins WHERE id=current_pin AND post_id<>target.id) THEN RETURN;END IF;
  IF q.receipt->>'code'='POST_PIN_STALE' AND operation IN('read','unpin') AND NOT EXISTS(SELECT 1 FROM whaleu_community.post_pins WHERE id=current_pin AND id=(q.command->>'pinId')::uuid AND post_id=target.id) THEN RETURN;END IF;
  RAISE EXCEPTION 'Pin rejection must be causal' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';
 END IF;
 SELECT * INTO pin FROM whaleu_community.post_pins WHERE id=(q.receipt->>'pinId')::uuid;
 IF pin.id IS NULL OR pin.scope_id<>scope.id OR pin.post_id<>target.id THEN RAISE EXCEPTION 'Exact pin receipt target required' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 IF operation='pin' THEN
  IF (q.receipt->>'recordedAt')::timestamptz IS DISTINCT FROM date_trunc('milliseconds',pin.pinned_at) OR pin.actor_id<>q.actor_id OR pin.request_id<>q.request_id OR pin.id IS DISTINCT FROM current_pin THEN RAISE EXCEPTION 'Pin receipt needs atomic current identity' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 ELSIF pin.id::text IS DISTINCT FROM q.command->>'pinId' THEN RAISE EXCEPTION 'Exact original pin required' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';
 ELSIF operation='unpin' THEN
  IF NOT EXISTS(SELECT 1 FROM whaleu_community.post_pin_closures WHERE pin_id=pin.id AND reason='unpin' AND actor_id=q.actor_id AND request_id=q.request_id AND date_trunc('milliseconds',closed_at)=(q.receipt->>'recordedAt')::timestamptz) THEN RAISE EXCEPTION 'Unpin receipt needs exact atomic closure' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 ELSE
  IF pin.id IS DISTINCT FROM current_pin OR target.visibility<>'approved' OR target.deleted_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM whaleu_community.post_pin_reads WHERE actor_id=q.actor_id AND pin_id=pin.id AND date_trunc('milliseconds',read_at)=(q.receipt->>'recordedAt')::timestamptz) THEN RAISE EXCEPTION 'Read receipt needs visible current exact pin marker' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 END IF;
 RETURN;
END$$;

-- Last prior definition: 0145_institutional_sso.sql:187.
DO $qualify$BEGIN
 IF (SELECT count(*) FROM pg_proc WHERE pronamespace='whaleu_verification'::regnamespace AND proname='institutional_session_current')<>1
 OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='whaleu_verification'::regnamespace AND p.proname='institutional_session_current' AND p.oid=to_regprocedure('whaleu_verification.institutional_session_current(uuid,uuid)') AND p.prokind='f' AND NOT p.prosecdef AND NOT p.proisstrict AND NOT p.proleakproof AND NOT p.proretset AND p.proparallel='u' AND p.proargmodes IS NULL AND p.proallargtypes IS NULL AND p.prosqlbody IS NULL AND p.prosupport=0 AND p.proargdefaults IS NULL AND p.provariadic=0 AND p.pronargs=2 AND p.pronargdefaults=0 AND p.proargnames IS NOT DISTINCT FROM ARRAY['subject','session']::text[] AND p.prorettype='boolean'::regtype AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='sql') AND p.provolatile='v' AND p.proconfig IS NULL AND p.prosrc=$prior$
 SELECT EXISTS(SELECT 1 FROM whaleu_identity.sessions s JOIN whaleu_identity.accounts a ON a.id=s.account_id
 WHERE s.id=session AND s.account_id=subject AND a.status='active' AND s.revoked_at IS NULL
 AND s.access_expires_at>clock_timestamp() AND s.refresh_expires_at>clock_timestamp() AND s.absolute_expires_at>clock_timestamp())
 AND NOT whaleu_safety.account_punishment_effective(subject,'access_suspension')
$prior$) THEN
  RAISE EXCEPTION 'Session epoch predecessor function mismatch: whaleu_verification.institutional_session_current' USING ERRCODE='23514';
 END IF;
END$qualify$;
CREATE OR REPLACE FUNCTION whaleu_verification.institutional_session_current(subject uuid,session uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_identity.sessions s JOIN whaleu_identity.accounts a ON a.id=s.account_id
 WHERE s.id=session AND s.account_id=subject AND a.status='active' AND s.issued_revocation_epoch=a.session_revocation_epoch AND s.revoked_at IS NULL
 AND s.access_expires_at>clock_timestamp() AND s.refresh_expires_at>clock_timestamp() AND s.absolute_expires_at>clock_timestamp())
 AND NOT whaleu_safety.account_punishment_effective(subject,'access_suspension')
$$;

-- Last prior definition: 0025_title_maintenance.sql:88.
DO $qualify$BEGIN
 IF (SELECT count(*) FROM pg_proc WHERE pronamespace='whaleu_experience'::regnamespace AND proname='require_maintenance_authority')<>1
 OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='whaleu_experience'::regnamespace AND p.proname='require_maintenance_authority' AND p.oid=to_regprocedure('whaleu_experience.require_maintenance_authority(uuid,uuid,uuid)') AND p.prokind='f' AND NOT p.prosecdef AND NOT p.proisstrict AND NOT p.proleakproof AND NOT p.proretset AND p.proparallel='u' AND p.proargmodes IS NULL AND p.proallargtypes IS NULL AND p.prosqlbody IS NULL AND p.prosupport=0 AND p.proargdefaults IS NULL AND p.provariadic=0 AND p.pronargs=3 AND p.pronargdefaults=0 AND p.proargnames IS NOT DISTINCT FROM ARRAY['actor','session_ref','grant_ref']::text[] AND p.prorettype='void'::regtype AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql') AND p.provolatile='v' AND p.proconfig IS NULL AND p.prosrc=$prior$
DECLARE account_status text; session_row whaleu_identity.sessions; grant_row whaleu_authorization.role_grants; checked_at timestamptz;
BEGIN
  SELECT status INTO account_status FROM whaleu_identity.accounts WHERE id=actor FOR SHARE;
  SELECT * INTO session_row FROM whaleu_identity.sessions WHERE id=session_ref AND account_id=actor FOR SHARE;
  SELECT * INTO grant_row FROM whaleu_authorization.role_grants WHERE id=grant_ref AND account_id=actor FOR SHARE;
  checked_at:=clock_timestamp();
  IF account_status IS DISTINCT FROM 'active' OR session_row.id IS NULL OR session_row.revoked_at IS NOT NULL OR
    grant_row.id IS NULL OR grant_row.role NOT IN ('developer','super_admin') OR grant_row.operating_region_id IS NOT NULL OR
    grant_row.revoked_at IS NOT NULL OR grant_row.valid_from>checked_at THEN
    RAISE EXCEPTION 'Maintenance lacks live global actor authority' USING ERRCODE='23514';
  END IF;
  -- Stable diagnostics let only these deadline failures use the same public
  -- semantics as transaction finalization, without exposing SQL proof details.
  IF session_row.access_expires_at<=checked_at OR session_row.absolute_expires_at<=checked_at THEN
    RAISE EXCEPTION 'Maintenance session expired' USING ERRCODE='23514',CONSTRAINT='maintenance_session_expired';
  END IF;
  IF grant_row.expires_at IS NOT NULL AND grant_row.expires_at<=checked_at THEN
    RAISE EXCEPTION 'Maintenance authority expired' USING ERRCODE='23514',CONSTRAINT='maintenance_authorization_expired';
  END IF;
END $prior$) THEN
  RAISE EXCEPTION 'Session epoch predecessor function mismatch: whaleu_experience.require_maintenance_authority' USING ERRCODE='23514';
 END IF;
END$qualify$;
CREATE OR REPLACE FUNCTION whaleu_experience.require_maintenance_authority(actor uuid,session_ref uuid,grant_ref uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE account_status text; session_row whaleu_identity.sessions; grant_row whaleu_authorization.role_grants; checked_at timestamptz;
BEGIN
  SELECT status INTO account_status FROM whaleu_identity.accounts WHERE id=actor FOR SHARE;
  SELECT * INTO session_row FROM whaleu_identity.sessions WHERE id=session_ref AND account_id=actor FOR SHARE;
  SELECT * INTO grant_row FROM whaleu_authorization.role_grants WHERE id=grant_ref AND account_id=actor FOR SHARE;
  checked_at:=clock_timestamp();
  IF account_status IS DISTINCT FROM 'active' OR session_row.id IS NULL OR session_row.issued_revocation_epoch IS DISTINCT FROM (SELECT session_revocation_epoch FROM whaleu_identity.accounts WHERE id=actor) OR session_row.revoked_at IS NOT NULL OR
    grant_row.id IS NULL OR grant_row.role NOT IN ('developer','super_admin') OR grant_row.operating_region_id IS NOT NULL OR
    grant_row.revoked_at IS NOT NULL OR grant_row.valid_from>checked_at THEN
    RAISE EXCEPTION 'Maintenance lacks live global actor authority' USING ERRCODE='23514';
  END IF;
  -- Stable diagnostics let only these deadline failures use the same public
  -- semantics as transaction finalization, without exposing SQL proof details.
  IF session_row.access_expires_at<=checked_at OR session_row.absolute_expires_at<=checked_at THEN
    RAISE EXCEPTION 'Maintenance session expired' USING ERRCODE='23514',CONSTRAINT='maintenance_session_expired';
  END IF;
  IF grant_row.expires_at IS NOT NULL AND grant_row.expires_at<=checked_at THEN
    RAISE EXCEPTION 'Maintenance authority expired' USING ERRCODE='23514',CONSTRAINT='maintenance_authorization_expired';
  END IF;
END $$;

-- Last prior definition: 0039_errand_restriction_ledger.sql:7.
DO $qualify$BEGIN
 IF (SELECT count(*) FROM pg_proc WHERE pronamespace='whaleu_authorization'::regnamespace AND proname='require_errand_management_authority')<>1
 OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='whaleu_authorization'::regnamespace AND p.proname='require_errand_management_authority' AND p.oid=to_regprocedure('whaleu_authorization.require_errand_management_authority(uuid,uuid,uuid,uuid)') AND p.prokind='f' AND NOT p.prosecdef AND NOT p.proisstrict AND NOT p.proleakproof AND NOT p.proretset AND p.proparallel='u' AND p.proargmodes IS NULL AND p.proallargtypes IS NULL AND p.prosqlbody IS NULL AND p.prosupport=0 AND CASE WHEN octet_length(p.proargdefaults::text)<=1024 THEN pg_get_expr(p.proargdefaults,0)='NULL::uuid' ELSE false END AND p.provariadic=0 AND p.pronargs=4 AND p.pronargdefaults=1 AND p.proargnames IS NOT DISTINCT FROM ARRAY['actor','session_ref','grant_ref','target_region']::text[] AND p.prorettype='void'::regtype AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql') AND p.provolatile='v' AND p.proconfig IS NULL AND p.prosrc=$prior$
DECLARE
  account_status text;
  session_row whaleu_identity.sessions;
  grant_row whaleu_authorization.role_grants;
  region_active boolean;
  checked_at timestamptz;
BEGIN
  SELECT status INTO account_status
    FROM whaleu_identity.accounts WHERE id=actor FOR SHARE;
  SELECT * INTO session_row
    FROM whaleu_identity.sessions
    WHERE id=session_ref AND account_id=actor FOR SHARE;
  SELECT * INTO grant_row
    FROM whaleu_authorization.role_grants
    WHERE id=grant_ref AND account_id=actor FOR SHARE;
  -- A target school role protects regardless of region activity. Here we are
  -- instead corroborating a positively selected actor school grant, whose exact
  -- target region must still be active. Global authority needs no Campus read.
  IF grant_row.role='school_admin' AND target_region IS NOT NULL AND
      grant_row.operating_region_id=target_region THEN
    SELECT is_active INTO region_active
      FROM whaleu_campus.operating_regions WHERE id=target_region FOR SHARE;
  END IF;
  -- Evaluate all temporal predicates only after every ordinary row/scope wait.
  checked_at:=clock_timestamp();
  IF account_status IS DISTINCT FROM 'active' OR
      session_row.id IS NULL OR session_row.revoked_at IS NOT NULL OR
      grant_row.id IS NULL OR grant_row.revoked_at IS NOT NULL OR
      (
        (grant_row.role IN ('developer','super_admin') AND
          grant_row.operating_region_id IS NULL) OR
        (grant_row.role='school_admin' AND target_region IS NOT NULL AND
          grant_row.operating_region_id=target_region AND region_active IS TRUE)
      ) IS NOT TRUE THEN
    RAISE EXCEPTION 'Errand management lacks live exact actor authority'
      USING ERRCODE='23514',CONSTRAINT='errand_management_authority_invalid';
  END IF;
  IF NOT isfinite(checked_at) OR
      NOT isfinite(session_row.access_expires_at) OR
      NOT isfinite(session_row.refresh_expires_at) OR
      NOT isfinite(session_row.absolute_expires_at) OR
      session_row.access_expires_at>session_row.refresh_expires_at OR
      session_row.refresh_expires_at>session_row.absolute_expires_at OR
      NOT isfinite(grant_row.valid_from) OR
      (grant_row.expires_at IS NOT NULL AND
        (NOT isfinite(grant_row.expires_at) OR
          grant_row.expires_at<=grant_row.valid_from)) OR
      grant_row.valid_from>checked_at THEN
    RAISE EXCEPTION 'Errand management authority evidence is invalid'
      USING ERRCODE='23514',CONSTRAINT='errand_management_authority_invalid';
  END IF;
  -- These stable diagnostic names alone map to normal runtime deadline failures.
  -- All timestamps retain PostgreSQL precision; no millisecond conversion here.
  IF session_row.access_expires_at<=checked_at OR
      session_row.absolute_expires_at<=checked_at THEN
    RAISE EXCEPTION 'Errand management session expired'
      USING ERRCODE='23514',CONSTRAINT='errand_management_session_expired';
  END IF;
  IF grant_row.expires_at IS NOT NULL AND grant_row.expires_at<=checked_at THEN
    RAISE EXCEPTION 'Errand management authority expired'
      USING ERRCODE='23514',CONSTRAINT='errand_management_authorization_expired';
  END IF;
END $prior$) THEN
  RAISE EXCEPTION 'Session epoch predecessor function mismatch: whaleu_authorization.require_errand_management_authority' USING ERRCODE='23514';
 END IF;
END$qualify$;
CREATE OR REPLACE FUNCTION whaleu_authorization.require_errand_management_authority(
  actor uuid,
  session_ref uuid,
  grant_ref uuid,
  target_region uuid DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  account_status text;
  session_row whaleu_identity.sessions;
  grant_row whaleu_authorization.role_grants;
  region_active boolean;
  checked_at timestamptz;
BEGIN
  SELECT status INTO account_status
    FROM whaleu_identity.accounts WHERE id=actor FOR SHARE;
  SELECT * INTO session_row
    FROM whaleu_identity.sessions
    WHERE id=session_ref AND account_id=actor FOR SHARE;
  SELECT * INTO grant_row
    FROM whaleu_authorization.role_grants
    WHERE id=grant_ref AND account_id=actor FOR SHARE;
  -- A target school role protects regardless of region activity. Here we are
  -- instead corroborating a positively selected actor school grant, whose exact
  -- target region must still be active. Global authority needs no Campus read.
  IF grant_row.role='school_admin' AND target_region IS NOT NULL AND
      grant_row.operating_region_id=target_region THEN
    SELECT is_active INTO region_active
      FROM whaleu_campus.operating_regions WHERE id=target_region FOR SHARE;
  END IF;
  -- Evaluate all temporal predicates only after every ordinary row/scope wait.
  checked_at:=clock_timestamp();
  IF account_status IS DISTINCT FROM 'active' OR
      session_row.id IS NULL OR session_row.issued_revocation_epoch IS DISTINCT FROM (SELECT session_revocation_epoch FROM whaleu_identity.accounts WHERE id=actor) OR session_row.revoked_at IS NOT NULL OR
      grant_row.id IS NULL OR grant_row.revoked_at IS NOT NULL OR
      (
        (grant_row.role IN ('developer','super_admin') AND
          grant_row.operating_region_id IS NULL) OR
        (grant_row.role='school_admin' AND target_region IS NOT NULL AND
          grant_row.operating_region_id=target_region AND region_active IS TRUE)
      ) IS NOT TRUE THEN
    RAISE EXCEPTION 'Errand management lacks live exact actor authority'
      USING ERRCODE='23514',CONSTRAINT='errand_management_authority_invalid';
  END IF;
  IF NOT isfinite(checked_at) OR
      NOT isfinite(session_row.access_expires_at) OR
      NOT isfinite(session_row.refresh_expires_at) OR
      NOT isfinite(session_row.absolute_expires_at) OR
      session_row.access_expires_at>session_row.refresh_expires_at OR
      session_row.refresh_expires_at>session_row.absolute_expires_at OR
      NOT isfinite(grant_row.valid_from) OR
      (grant_row.expires_at IS NOT NULL AND
        (NOT isfinite(grant_row.expires_at) OR
          grant_row.expires_at<=grant_row.valid_from)) OR
      grant_row.valid_from>checked_at THEN
    RAISE EXCEPTION 'Errand management authority evidence is invalid'
      USING ERRCODE='23514',CONSTRAINT='errand_management_authority_invalid';
  END IF;
  -- These stable diagnostic names alone map to normal runtime deadline failures.
  -- All timestamps retain PostgreSQL precision; no millisecond conversion here.
  IF session_row.access_expires_at<=checked_at OR
      session_row.absolute_expires_at<=checked_at THEN
    RAISE EXCEPTION 'Errand management session expired'
      USING ERRCODE='23514',CONSTRAINT='errand_management_session_expired';
  END IF;
  IF grant_row.expires_at IS NOT NULL AND grant_row.expires_at<=checked_at THEN
    RAISE EXCEPTION 'Errand management authority expired'
      USING ERRCODE='23514',CONSTRAINT='errand_management_authorization_expired';
  END IF;
END $$;

-- Last prior definition: 0053_rating_deletion_authority.sql:171.
DO $qualify$BEGIN
 IF (SELECT count(*) FROM pg_proc WHERE pronamespace='whaleu_ratings'::regnamespace AND proname='admin_delete_audit_guard')<>1
 OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='whaleu_ratings'::regnamespace AND p.proname='admin_delete_audit_guard' AND p.oid=to_regprocedure('whaleu_ratings.admin_delete_audit_guard()') AND p.prokind='f' AND NOT p.prosecdef AND NOT p.proisstrict AND NOT p.proleakproof AND NOT p.proretset AND p.proparallel='u' AND p.proargmodes IS NULL AND p.proallargtypes IS NULL AND p.prosqlbody IS NULL AND p.prosupport=0 AND p.proargdefaults IS NULL AND p.provariadic=0 AND p.pronargs=0 AND p.pronargdefaults=0 AND p.proargnames IS NOT DISTINCT FROM NULL::text[] AND p.prorettype='trigger'::regtype AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql') AND p.provolatile='v' AND p.proconfig IS NULL AND p.prosrc=$prior$
DECLARE q whaleu_ratings.requests;s whaleu_identity.sessions;g whaleu_authorization.role_grants;
 t whaleu_ratings.targets;c whaleu_ratings.comments;r whaleu_ratings.replies;
 o whaleu_ratings.target_origin_sources;h whaleu_ratings.target_origin_heads;
 topology whaleu_campus.community_topology_snapshots;ct whaleu_ratings.comment_transitions;rt whaleu_ratings.reply_transitions;
 actor uuid;revision uuid;deleted timestamptz;created timestamptz;instant timestamptz;
BEGIN
 SELECT * INTO s FROM whaleu_identity.sessions WHERE id=NEW.session_id FOR SHARE NOWAIT;
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=NEW.actor_account_id AND request_id=NEW.request_id FOR UPDATE NOWAIT;
 SELECT * INTO g FROM whaleu_authorization.role_grants WHERE id=NEW.grant_id FOR SHARE NOWAIT;
 SELECT * INTO h FROM whaleu_ratings.target_origin_heads WHERE target_id=NEW.target_id FOR SHARE NOWAIT;
 SELECT * INTO o FROM whaleu_ratings.target_origin_sources WHERE id=h.source_id;
 IF NEW.topology_snapshot_id IS NOT NULL THEN
  PERFORM scope_key FROM whaleu_campus.community_topology_heads WHERE scope_key='community' FOR SHARE NOWAIT;
  SELECT snapshot.* INTO topology FROM whaleu_campus.community_topology_snapshots snapshot
   JOIN whaleu_campus.community_topology_heads head ON head.snapshot_id=snapshot.id AND head.revision=snapshot.revision
   WHERE head.scope_key='community' AND snapshot.id=NEW.topology_snapshot_id;
 END IF;
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=NEW.target_id FOR UPDATE NOWAIT;
 SELECT * INTO c FROM whaleu_ratings.comments WHERE id=NEW.root_id AND target_id=NEW.target_id FOR UPDATE NOWAIT;
 IF NEW.subject_kind='reply' THEN
  SELECT * INTO r FROM whaleu_ratings.replies WHERE id=NEW.subject_id AND root_id=NEW.root_id AND target_id=NEW.target_id FOR UPDATE NOWAIT;
  actor:=r.account_id;revision:=r.revision;deleted:=r.deleted_at;created:=r.created_at;
 ELSE actor:=c.account_id;revision:=c.revision;deleted:=c.deleted_at;created:=c.created_at;END IF;
 instant:=clock_timestamp();NEW.authorized_at:=instant;
 -- Applied lifecycle time is database-owned, just like owner tombstones.
 -- A caller cannot backdate a fresh deletion by supplying an older audit time.
 IF NEW.outcome='applied' THEN NEW.occurred_at:=instant;END IF;
 IF s.account_id IS DISTINCT FROM NEW.actor_account_id OR s.revoked_at IS NOT NULL OR s.access_expires_at<=instant OR s.absolute_expires_at<=instant
  OR NOT EXISTS(SELECT 1 FROM whaleu_identity.accounts WHERE id=NEW.actor_account_id AND status='active')
  OR q.operation IS DISTINCT FROM 'admin_delete_'||NEW.subject_kind OR q.receipt IS NOT NULL OR q.intent_hash IS DISTINCT FROM NEW.intent_hash
  OR NEW.mutation_transaction IS DISTINCT FROM pg_current_xact_id()
  OR (t.revision,c.revision,actor,revision) IS DISTINCT FROM (NEW.target_revision,NEW.root_revision,NEW.author_account_id,NEW.before_revision)
  OR NEW.occurred_at>instant OR NEW.occurred_at<created THEN
  RAISE EXCEPTION 'Invalid administrator deletion actor, request or subject' USING ERRCODE='23514';END IF;
 IF g.account_id IS DISTINCT FROM NEW.actor_account_id OR g.revoked_at IS NOT NULL OR g.valid_from>instant OR (g.expires_at IS NOT NULL AND g.expires_at<=instant)
  OR (NEW.scope_kind='global' AND (g.role NOT IN ('developer','super_admin') OR g.operating_region_id IS NOT NULL))
  OR (NEW.scope_kind='fixed' AND (g.role<>'school_admin' OR g.operating_region_id IS DISTINCT FROM NEW.operating_region_id)) THEN
  RAISE EXCEPTION 'Invalid administrator deletion grant' USING ERRCODE='23514';END IF;
 IF (h.source_id,h.revision) IS DISTINCT FROM (NEW.origin_source_id,NEW.origin_revision)
  OR (h.source_id IS NULL AND NEW.origin_state<>'absent')
  OR (h.source_id IS NOT NULL AND (CASE WHEN NOT o.revoked AND o.coverage_state='complete' AND o.provenance_state='accepted' AND o.effective_at<=instant AND (o.valid_until IS NULL OR o.valid_until>instant) THEN o.state ELSE 'unknown' END,
    CASE WHEN NOT o.revoked AND o.coverage_state='complete' AND o.provenance_state='accepted' AND o.effective_at<=instant AND (o.valid_until IS NULL OR o.valid_until>instant) THEN o.origin_campus_id END) IS DISTINCT FROM (NEW.origin_state,NEW.origin_campus_id)) THEN
  RAISE EXCEPTION 'Administrator deletion origin changed' USING ERRCODE='23514';END IF;
 IF NEW.scope_kind='fixed' THEN
  IF o.id IS NULL OR o.state<>'known_school' OR o.revoked OR o.coverage_state<>'complete' OR o.provenance_state<>'accepted'
   OR o.effective_at>instant OR (o.valid_until IS NOT NULL AND o.valid_until<=instant)
   OR topology.id IS NULL OR topology.revision<>NEW.topology_revision OR topology.coverage_state<>'complete' OR topology.provenance_state<>'accepted'
   OR NOT whaleu_ratings.origin_topology_shape(topology.topology)
   OR coalesce(length(btrim(topology.source_reference)),0)=0 OR coalesce(length(btrim(topology.policy_reference)),0)=0
   OR topology.effective_at>instant OR topology.expiry_kind NOT IN ('at','policy_exempt') OR (topology.valid_until IS NOT NULL AND topology.valid_until<=instant)
   OR (SELECT count(*) FROM jsonb_array_elements(topology.topology->'assignments') a WHERE a->>'campusId'=NEW.origin_campus_id::text)<>1
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(topology.topology->'assignments') a
    JOIN LATERAL jsonb_array_elements(topology.topology->'regions') region ON region->>'regionId'=a->>'regionId'
    JOIN LATERAL jsonb_array_elements(topology.topology->'groups') community_group ON community_group->>'groupId'=region->>'groupId'
    WHERE a->>'campusId'=NEW.origin_campus_id::text AND a->>'regionId'=NEW.operating_region_id::text
     AND a->>'institutionId'=region->>'institutionId'
     AND a->>'coverage'='complete' AND region->>'coverage'='complete' AND community_group->>'coverage'='complete'
     AND (SELECT count(*) FROM jsonb_array_elements(topology.topology->'regions') candidate WHERE candidate->>'regionId'=region->>'regionId')=1
     AND (SELECT count(*) FROM jsonb_array_elements(topology.topology->'groups') candidate WHERE candidate->>'groupId'=community_group->>'groupId')=1) THEN
   RAISE EXCEPTION 'Fixed administrator origin mapping unavailable' USING ERRCODE='23514';END IF;
 END IF;
 IF NEW.outcome='applied' THEN
  IF deleted IS NOT NULL THEN RAISE EXCEPTION 'Administrator applied deletion requires a live subject' USING ERRCODE='23514';END IF;
 ELSE
  IF deleted IS NULL OR deleted IS DISTINCT FROM NEW.occurred_at THEN RAISE EXCEPTION 'Administrator noop requires the exact tombstone' USING ERRCODE='23514';END IF;
  IF NEW.subject_kind='comment' THEN
   SELECT * INTO ct FROM whaleu_ratings.comment_transitions WHERE id=NEW.effective_comment_transition_id;
   IF ct.operation IS DISTINCT FROM 'delete_comment' OR (ct.comment_id,ct.target_id,ct.account_id,ct.revision,ct.occurred_at) IS DISTINCT FROM
    (NEW.subject_id,NEW.target_id,NEW.author_account_id,NEW.after_revision,NEW.occurred_at) THEN RAISE EXCEPTION 'Administrator root noop source mismatch' USING ERRCODE='23514';END IF;
  ELSE
   SELECT * INTO rt FROM whaleu_ratings.reply_transitions WHERE id=NEW.effective_reply_transition_id;
   IF rt.operation IS DISTINCT FROM 'delete_reply' OR (rt.reply_id,rt.root_id,rt.target_id,rt.account_id,rt.revision,rt.occurred_at) IS DISTINCT FROM
    (NEW.subject_id,NEW.root_id,NEW.target_id,NEW.author_account_id,NEW.after_revision,NEW.occurred_at) THEN RAISE EXCEPTION 'Administrator reply noop source mismatch' USING ERRCODE='23514';END IF;
  END IF;
 END IF;RETURN NEW;
END $prior$) THEN
  RAISE EXCEPTION 'Session epoch predecessor function mismatch: whaleu_ratings.admin_delete_audit_guard' USING ERRCODE='23514';
 END IF;
END$qualify$;
CREATE OR REPLACE FUNCTION whaleu_ratings.admin_delete_audit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_ratings.requests;s whaleu_identity.sessions;g whaleu_authorization.role_grants;
 t whaleu_ratings.targets;c whaleu_ratings.comments;r whaleu_ratings.replies;
 o whaleu_ratings.target_origin_sources;h whaleu_ratings.target_origin_heads;
 topology whaleu_campus.community_topology_snapshots;ct whaleu_ratings.comment_transitions;rt whaleu_ratings.reply_transitions;
 actor uuid;revision uuid;deleted timestamptz;created timestamptz;instant timestamptz;
BEGIN
 SELECT * INTO s FROM whaleu_identity.sessions WHERE id=NEW.session_id FOR SHARE NOWAIT;
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=NEW.actor_account_id AND request_id=NEW.request_id FOR UPDATE NOWAIT;
 SELECT * INTO g FROM whaleu_authorization.role_grants WHERE id=NEW.grant_id FOR SHARE NOWAIT;
 SELECT * INTO h FROM whaleu_ratings.target_origin_heads WHERE target_id=NEW.target_id FOR SHARE NOWAIT;
 SELECT * INTO o FROM whaleu_ratings.target_origin_sources WHERE id=h.source_id;
 IF NEW.topology_snapshot_id IS NOT NULL THEN
  PERFORM scope_key FROM whaleu_campus.community_topology_heads WHERE scope_key='community' FOR SHARE NOWAIT;
  SELECT snapshot.* INTO topology FROM whaleu_campus.community_topology_snapshots snapshot
   JOIN whaleu_campus.community_topology_heads head ON head.snapshot_id=snapshot.id AND head.revision=snapshot.revision
   WHERE head.scope_key='community' AND snapshot.id=NEW.topology_snapshot_id;
 END IF;
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=NEW.target_id FOR UPDATE NOWAIT;
 SELECT * INTO c FROM whaleu_ratings.comments WHERE id=NEW.root_id AND target_id=NEW.target_id FOR UPDATE NOWAIT;
 IF NEW.subject_kind='reply' THEN
  SELECT * INTO r FROM whaleu_ratings.replies WHERE id=NEW.subject_id AND root_id=NEW.root_id AND target_id=NEW.target_id FOR UPDATE NOWAIT;
  actor:=r.account_id;revision:=r.revision;deleted:=r.deleted_at;created:=r.created_at;
 ELSE actor:=c.account_id;revision:=c.revision;deleted:=c.deleted_at;created:=c.created_at;END IF;
 instant:=clock_timestamp();NEW.authorized_at:=instant;
 -- Applied lifecycle time is database-owned, just like owner tombstones.
 -- A caller cannot backdate a fresh deletion by supplying an older audit time.
 IF NEW.outcome='applied' THEN NEW.occurred_at:=instant;END IF;
 IF s.account_id IS DISTINCT FROM NEW.actor_account_id OR s.revoked_at IS NOT NULL OR s.access_expires_at<=instant OR s.absolute_expires_at<=instant
  OR NOT EXISTS(SELECT 1 FROM whaleu_identity.accounts WHERE id=NEW.actor_account_id AND status='active' AND session_revocation_epoch=s.issued_revocation_epoch)
  OR q.operation IS DISTINCT FROM 'admin_delete_'||NEW.subject_kind OR q.receipt IS NOT NULL OR q.intent_hash IS DISTINCT FROM NEW.intent_hash
  OR NEW.mutation_transaction IS DISTINCT FROM pg_current_xact_id()
  OR (t.revision,c.revision,actor,revision) IS DISTINCT FROM (NEW.target_revision,NEW.root_revision,NEW.author_account_id,NEW.before_revision)
  OR NEW.occurred_at>instant OR NEW.occurred_at<created THEN
  RAISE EXCEPTION 'Invalid administrator deletion actor, request or subject' USING ERRCODE='23514';END IF;
 IF g.account_id IS DISTINCT FROM NEW.actor_account_id OR g.revoked_at IS NOT NULL OR g.valid_from>instant OR (g.expires_at IS NOT NULL AND g.expires_at<=instant)
  OR (NEW.scope_kind='global' AND (g.role NOT IN ('developer','super_admin') OR g.operating_region_id IS NOT NULL))
  OR (NEW.scope_kind='fixed' AND (g.role<>'school_admin' OR g.operating_region_id IS DISTINCT FROM NEW.operating_region_id)) THEN
  RAISE EXCEPTION 'Invalid administrator deletion grant' USING ERRCODE='23514';END IF;
 IF (h.source_id,h.revision) IS DISTINCT FROM (NEW.origin_source_id,NEW.origin_revision)
  OR (h.source_id IS NULL AND NEW.origin_state<>'absent')
  OR (h.source_id IS NOT NULL AND (CASE WHEN NOT o.revoked AND o.coverage_state='complete' AND o.provenance_state='accepted' AND o.effective_at<=instant AND (o.valid_until IS NULL OR o.valid_until>instant) THEN o.state ELSE 'unknown' END,
    CASE WHEN NOT o.revoked AND o.coverage_state='complete' AND o.provenance_state='accepted' AND o.effective_at<=instant AND (o.valid_until IS NULL OR o.valid_until>instant) THEN o.origin_campus_id END) IS DISTINCT FROM (NEW.origin_state,NEW.origin_campus_id)) THEN
  RAISE EXCEPTION 'Administrator deletion origin changed' USING ERRCODE='23514';END IF;
 IF NEW.scope_kind='fixed' THEN
  IF o.id IS NULL OR o.state<>'known_school' OR o.revoked OR o.coverage_state<>'complete' OR o.provenance_state<>'accepted'
   OR o.effective_at>instant OR (o.valid_until IS NOT NULL AND o.valid_until<=instant)
   OR topology.id IS NULL OR topology.revision<>NEW.topology_revision OR topology.coverage_state<>'complete' OR topology.provenance_state<>'accepted'
   OR NOT whaleu_ratings.origin_topology_shape(topology.topology)
   OR coalesce(length(btrim(topology.source_reference)),0)=0 OR coalesce(length(btrim(topology.policy_reference)),0)=0
   OR topology.effective_at>instant OR topology.expiry_kind NOT IN ('at','policy_exempt') OR (topology.valid_until IS NOT NULL AND topology.valid_until<=instant)
   OR (SELECT count(*) FROM jsonb_array_elements(topology.topology->'assignments') a WHERE a->>'campusId'=NEW.origin_campus_id::text)<>1
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(topology.topology->'assignments') a
    JOIN LATERAL jsonb_array_elements(topology.topology->'regions') region ON region->>'regionId'=a->>'regionId'
    JOIN LATERAL jsonb_array_elements(topology.topology->'groups') community_group ON community_group->>'groupId'=region->>'groupId'
    WHERE a->>'campusId'=NEW.origin_campus_id::text AND a->>'regionId'=NEW.operating_region_id::text
     AND a->>'institutionId'=region->>'institutionId'
     AND a->>'coverage'='complete' AND region->>'coverage'='complete' AND community_group->>'coverage'='complete'
     AND (SELECT count(*) FROM jsonb_array_elements(topology.topology->'regions') candidate WHERE candidate->>'regionId'=region->>'regionId')=1
     AND (SELECT count(*) FROM jsonb_array_elements(topology.topology->'groups') candidate WHERE candidate->>'groupId'=community_group->>'groupId')=1) THEN
   RAISE EXCEPTION 'Fixed administrator origin mapping unavailable' USING ERRCODE='23514';END IF;
 END IF;
 IF NEW.outcome='applied' THEN
  IF deleted IS NOT NULL THEN RAISE EXCEPTION 'Administrator applied deletion requires a live subject' USING ERRCODE='23514';END IF;
 ELSE
  IF deleted IS NULL OR deleted IS DISTINCT FROM NEW.occurred_at THEN RAISE EXCEPTION 'Administrator noop requires the exact tombstone' USING ERRCODE='23514';END IF;
  IF NEW.subject_kind='comment' THEN
   SELECT * INTO ct FROM whaleu_ratings.comment_transitions WHERE id=NEW.effective_comment_transition_id;
   IF ct.operation IS DISTINCT FROM 'delete_comment' OR (ct.comment_id,ct.target_id,ct.account_id,ct.revision,ct.occurred_at) IS DISTINCT FROM
    (NEW.subject_id,NEW.target_id,NEW.author_account_id,NEW.after_revision,NEW.occurred_at) THEN RAISE EXCEPTION 'Administrator root noop source mismatch' USING ERRCODE='23514';END IF;
  ELSE
   SELECT * INTO rt FROM whaleu_ratings.reply_transitions WHERE id=NEW.effective_reply_transition_id;
   IF rt.operation IS DISTINCT FROM 'delete_reply' OR (rt.reply_id,rt.root_id,rt.target_id,rt.account_id,rt.revision,rt.occurred_at) IS DISTINCT FROM
    (NEW.subject_id,NEW.root_id,NEW.target_id,NEW.author_account_id,NEW.after_revision,NEW.occurred_at) THEN RAISE EXCEPTION 'Administrator reply noop source mismatch' USING ERRCODE='23514';END IF;
  END IF;
 END IF;RETURN NEW;
END $$;

-- Last prior definition: 0094_native_verification_enrollment.sql:134.
DO $qualify$BEGIN
 IF (SELECT count(*) FROM pg_proc WHERE pronamespace='whaleu_verification'::regnamespace AND proname='phone_request_guard')<>1
 OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='whaleu_verification'::regnamespace AND p.proname='phone_request_guard' AND p.oid=to_regprocedure('whaleu_verification.phone_request_guard()') AND p.prokind='f' AND NOT p.prosecdef AND NOT p.proisstrict AND NOT p.proleakproof AND NOT p.proretset AND p.proparallel='u' AND p.proargmodes IS NULL AND p.proallargtypes IS NULL AND p.prosqlbody IS NULL AND p.prosupport=0 AND p.proargdefaults IS NULL AND p.provariadic=0 AND p.pronargs=0 AND p.pronargdefaults=0 AND p.proargnames IS NOT DISTINCT FROM NULL::text[] AND p.prorettype='trigger'::regtype AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql') AND p.provolatile='v' AND p.proconfig IS NULL AND p.prosrc=$prior$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Phone requests cannot be deleted' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'reserved' OR NEW.claimed_at IS NOT NULL OR
   NOT EXISTS(SELECT 1 FROM whaleu_identity.provider_identities WHERE account_id=NEW.account_id AND provider='wechat' AND app_id=NEW.app_id)
   OR (NEW.replaces_request_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM whaleu_verification.phone_requests WHERE account_id=NEW.account_id AND request_id=NEW.replaces_request_id AND state='closed'))
  THEN RAISE EXCEPTION 'Phone request requires current app identity and explicit new consent' USING ERRCODE='23514'; END IF;
  NEW.created_at:=clock_timestamp(); RETURN NEW;
 END IF;
 IF (NEW.account_id,NEW.request_id,NEW.app_id,NEW.consent,NEW.replaces_request_id,NEW.created_at)
 IS DISTINCT FROM (OLD.account_id,OLD.request_id,OLD.app_id,OLD.consent,OLD.replaces_request_id,OLD.created_at)
 OR OLD.state IN ('verified','closed') THEN RAISE EXCEPTION 'Phone request origin and terminal outcome are immutable' USING ERRCODE='23514'; END IF;
 IF OLD.state='reserved' AND NEW.state='claimed' THEN
  IF clock_timestamp()>=OLD.created_at+interval '5 minutes' OR NEW.base_revision IS NULL
   OR NOT EXISTS(SELECT 1 FROM whaleu_identity.sessions WHERE id=NEW.claimed_session_id AND account_id=NEW.account_id AND revoked_at IS NULL)
  THEN RAISE EXCEPTION 'Phone claim is unavailable' USING ERRCODE='23514'; END IF;
  NEW.claimed_at:=clock_timestamp(); NEW.claim_deadline:=NEW.claimed_at+interval '30 seconds'; RETURN NEW;
 END IF;
 IF (NEW.claimed_at,NEW.claim_deadline,NEW.claimed_session_id,NEW.base_revision)
 IS DISTINCT FROM (OLD.claimed_at,OLD.claim_deadline,OLD.claimed_session_id,OLD.base_revision)
 THEN RAISE EXCEPTION 'Phone claim cannot be replaced' USING ERRCODE='23514'; END IF;
 IF OLD.state='claimed' AND NEW.state='verified' AND clock_timestamp()<OLD.claim_deadline
 AND EXISTS(SELECT 1 FROM whaleu_verification.phone_proofs WHERE account_id=NEW.account_id AND request_id=NEW.request_id AND creation_transaction=pg_current_xact_id()) THEN RETURN NEW; END IF;
 IF OLD.state='claimed' AND NEW.state='unknown' THEN RETURN NEW; END IF;
 IF NEW.state='closed' AND (OLD.state IN ('reserved','unknown') OR (OLD.state='claimed' AND clock_timestamp()>=OLD.claim_deadline)) THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'Phone requests cannot replay a consumed authorization' USING ERRCODE='23514';
END $prior$) THEN
  RAISE EXCEPTION 'Session epoch predecessor function mismatch: whaleu_verification.phone_request_guard' USING ERRCODE='23514';
 END IF;
END$qualify$;
CREATE OR REPLACE FUNCTION whaleu_verification.phone_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Phone requests cannot be deleted' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'reserved' OR NEW.claimed_at IS NOT NULL OR
   NOT EXISTS(SELECT 1 FROM whaleu_identity.provider_identities WHERE account_id=NEW.account_id AND provider='wechat' AND app_id=NEW.app_id)
   OR (NEW.replaces_request_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM whaleu_verification.phone_requests WHERE account_id=NEW.account_id AND request_id=NEW.replaces_request_id AND state='closed'))
  THEN RAISE EXCEPTION 'Phone request requires current app identity and explicit new consent' USING ERRCODE='23514'; END IF;
  NEW.created_at:=clock_timestamp(); RETURN NEW;
 END IF;
 IF (NEW.account_id,NEW.request_id,NEW.app_id,NEW.consent,NEW.replaces_request_id,NEW.created_at)
 IS DISTINCT FROM (OLD.account_id,OLD.request_id,OLD.app_id,OLD.consent,OLD.replaces_request_id,OLD.created_at)
 OR OLD.state IN ('verified','closed') THEN RAISE EXCEPTION 'Phone request origin and terminal outcome are immutable' USING ERRCODE='23514'; END IF;
 IF OLD.state='reserved' AND NEW.state='claimed' THEN
  IF clock_timestamp()>=OLD.created_at+interval '5 minutes' OR NEW.base_revision IS NULL
   OR NOT EXISTS(SELECT 1 FROM whaleu_identity.sessions WHERE id=NEW.claimed_session_id AND account_id=NEW.account_id AND revoked_at IS NULL AND issued_revocation_epoch=(SELECT session_revocation_epoch FROM whaleu_identity.accounts WHERE id=NEW.account_id))
  THEN RAISE EXCEPTION 'Phone claim is unavailable' USING ERRCODE='23514'; END IF;
  NEW.claimed_at:=clock_timestamp(); NEW.claim_deadline:=NEW.claimed_at+interval '30 seconds'; RETURN NEW;
 END IF;
 IF (NEW.claimed_at,NEW.claim_deadline,NEW.claimed_session_id,NEW.base_revision)
 IS DISTINCT FROM (OLD.claimed_at,OLD.claim_deadline,OLD.claimed_session_id,OLD.base_revision)
 THEN RAISE EXCEPTION 'Phone claim cannot be replaced' USING ERRCODE='23514'; END IF;
 IF OLD.state='claimed' AND NEW.state='verified' AND clock_timestamp()<OLD.claim_deadline
 AND EXISTS(SELECT 1 FROM whaleu_verification.phone_proofs WHERE account_id=NEW.account_id AND request_id=NEW.request_id AND creation_transaction=pg_current_xact_id()) THEN RETURN NEW; END IF;
 IF OLD.state='claimed' AND NEW.state='unknown' THEN RETURN NEW; END IF;
 IF NEW.state='closed' AND (OLD.state IN ('reserved','unknown') OR (OLD.state='claimed' AND clock_timestamp()>=OLD.claim_deadline)) THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'Phone requests cannot replay a consumed authorization' USING ERRCODE='23514';
END $$;

-- Last prior definition: 0116_private_message_media.sql:164.
DO $qualify$BEGIN
 IF (SELECT count(*) FROM pg_proc WHERE pronamespace='whaleu_media'::regnamespace AND proname='private_message_delivery_hold_guard')<>1
 OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='whaleu_media'::regnamespace AND p.proname='private_message_delivery_hold_guard' AND p.oid=to_regprocedure('whaleu_media.private_message_delivery_hold_guard()') AND p.prokind='f' AND NOT p.prosecdef AND NOT p.proisstrict AND NOT p.proleakproof AND NOT p.proretset AND p.proparallel='u' AND p.proargmodes IS NULL AND p.proallargtypes IS NULL AND p.prosqlbody IS NULL AND p.prosupport=0 AND p.proargdefaults IS NULL AND p.provariadic=0 AND p.pronargs=0 AND p.pronargdefaults=0 AND p.proargnames IS NOT DISTINCT FROM NULL::text[] AND p.prorettype='trigger'::regtype AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql') AND p.provolatile='v' AND p.proconfig IS NULL AND p.prosrc=$prior$BEGIN
 IF TG_OP='INSERT' THEN
 IF NEW.closed_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM whaleu_media.private_message_appearances p JOIN whaleu_media.bindings b ON b.id=p.binding_id JOIN whaleu_messaging.messages msg ON msg.id=p.message_id JOIN whaleu_messaging.participants member ON member.conversation_id=p.conversation_id JOIN whaleu_identity.sessions session ON session.account_id=member.account_id
 WHERE p.binding_id=NEW.binding_id AND member.account_id=NEW.account_id AND session.id=NEW.session_id AND b.detached_at IS NULL AND msg.recalled_at IS NULL)
 THEN RAISE EXCEPTION 'Private delivery hold requires exact active participant binding' USING ERRCODE='23514';END IF;
 ELSE IF OLD.closed_at IS NOT NULL OR NEW.closed_at IS NULL OR(to_jsonb(NEW)-'closed_at') IS DISTINCT FROM(to_jsonb(OLD)-'closed_at') THEN RAISE EXCEPTION 'Private delivery closure is one way' USING ERRCODE='23514';END IF;END IF;RETURN NEW;
END$prior$) THEN
  RAISE EXCEPTION 'Session epoch predecessor function mismatch: whaleu_media.private_message_delivery_hold_guard' USING ERRCODE='23514';
 END IF;
END$qualify$;
CREATE OR REPLACE FUNCTION whaleu_media.private_message_delivery_hold_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF TG_OP='INSERT' THEN
 IF NEW.closed_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM whaleu_media.private_message_appearances p JOIN whaleu_media.bindings b ON b.id=p.binding_id JOIN whaleu_messaging.messages msg ON msg.id=p.message_id JOIN whaleu_messaging.participants member ON member.conversation_id=p.conversation_id JOIN whaleu_identity.sessions session ON session.account_id=member.account_id
 WHERE p.binding_id=NEW.binding_id AND member.account_id=NEW.account_id AND session.id=NEW.session_id AND session.issued_revocation_epoch=(SELECT session_revocation_epoch FROM whaleu_identity.accounts WHERE id=member.account_id) AND b.detached_at IS NULL AND msg.recalled_at IS NULL)
 THEN RAISE EXCEPTION 'Private delivery hold requires exact active participant binding' USING ERRCODE='23514';END IF;
 ELSE IF OLD.closed_at IS NOT NULL OR NEW.closed_at IS NULL OR(to_jsonb(NEW)-'closed_at') IS DISTINCT FROM(to_jsonb(OLD)-'closed_at') THEN RAISE EXCEPTION 'Private delivery closure is one way' USING ERRCODE='23514';END IF;END IF;RETURN NEW;
END$$;

-- Last prior definition: 0133_school_admin_management.sql:163.
DO $qualify$BEGIN
 IF (SELECT count(*) FROM pg_proc WHERE pronamespace='whaleu_authorization'::regnamespace AND proname='school_admin_management_identity')<>1
 OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='whaleu_authorization'::regnamespace AND p.proname='school_admin_management_identity' AND p.oid=to_regprocedure('whaleu_authorization.school_admin_management_identity(uuid,uuid,text)') AND p.prokind='f' AND NOT p.prosecdef AND NOT p.proisstrict AND NOT p.proleakproof AND NOT p.proretset AND p.proparallel='u' AND p.proargmodes IS NULL AND p.proallargtypes IS NULL AND p.prosqlbody IS NULL AND p.prosupport=0 AND p.proargdefaults IS NULL AND p.provariadic=0 AND p.pronargs=3 AND p.pronargdefaults=0 AND p.proargnames IS NOT DISTINCT FROM ARRAY['actor','session','token']::text[] AND p.prorettype='boolean'::regtype AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='sql') AND p.provolatile='s' AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND p.prosrc=$prior$
 SELECT whaleu_profile.moderation_identity_current(actor,session,token)
 AND EXISTS(SELECT 1 FROM whaleu_identity.sessions s WHERE s.id=session AND s.account_id=actor AND s.access_expires_at>clock_timestamp())
$prior$) THEN
  RAISE EXCEPTION 'Session epoch predecessor function mismatch: whaleu_authorization.school_admin_management_identity' USING ERRCODE='23514';
 END IF;
END$qualify$;
CREATE OR REPLACE FUNCTION whaleu_authorization.school_admin_management_identity(actor uuid,session uuid,token text)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT whaleu_profile.moderation_identity_current(actor,session,token)
 AND EXISTS(SELECT 1 FROM whaleu_identity.sessions s WHERE s.id=session AND s.account_id=actor AND s.issued_revocation_epoch=(SELECT session_revocation_epoch FROM whaleu_identity.accounts WHERE id=actor) AND s.access_expires_at>clock_timestamp())
$$;

-- Last prior definition: 0135_account_moderation.sql:86.
DO $qualify$BEGIN
 IF (SELECT count(*) FROM pg_proc WHERE pronamespace='whaleu_safety'::regnamespace AND proname='account_punishment_identity_current')<>1
 OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='whaleu_safety'::regnamespace AND p.proname='account_punishment_identity_current' AND p.oid=to_regprocedure('whaleu_safety.account_punishment_identity_current(uuid,uuid,text)') AND p.prokind='f' AND NOT p.prosecdef AND NOT p.proisstrict AND NOT p.proleakproof AND NOT p.proretset AND p.proparallel='u' AND p.proargmodes IS NULL AND p.proallargtypes IS NULL AND p.prosqlbody IS NULL AND p.prosupport=0 AND p.proargdefaults IS NULL AND p.provariadic=0 AND p.pronargs=3 AND p.pronargdefaults=0 AND p.proargnames IS NOT DISTINCT FROM ARRAY['actor','session','token']::text[] AND p.prorettype='boolean'::regtype AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='sql') AND p.provolatile='v' AND p.proconfig IS NULL AND p.prosrc=$prior$
 SELECT whaleu_profile.moderation_identity_current(actor,session,token)
 AND EXISTS(SELECT 1 FROM whaleu_identity.sessions s WHERE s.id=session AND s.account_id=actor AND s.access_expires_at>clock_timestamp())
$prior$) THEN
  RAISE EXCEPTION 'Session epoch predecessor function mismatch: whaleu_safety.account_punishment_identity_current' USING ERRCODE='23514';
 END IF;
END$qualify$;
CREATE OR REPLACE FUNCTION whaleu_safety.account_punishment_identity_current(actor uuid,session uuid,token text)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT whaleu_profile.moderation_identity_current(actor,session,token)
 AND EXISTS(SELECT 1 FROM whaleu_identity.sessions s WHERE s.id=session AND s.account_id=actor AND s.issued_revocation_epoch=(SELECT session_revocation_epoch FROM whaleu_identity.accounts WHERE id=actor) AND s.access_expires_at>clock_timestamp())
$$;

-- Last prior definition: 0135_account_moderation.sql:1095.
DO $qualify$BEGIN
 IF (SELECT count(*) FROM pg_proc WHERE pronamespace='whaleu_safety'::regnamespace AND proname='account_appeal_identity_current')<>1
 OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='whaleu_safety'::regnamespace AND p.proname='account_appeal_identity_current' AND p.oid=to_regprocedure('whaleu_safety.account_appeal_identity_current(uuid,uuid,text)') AND p.prokind='f' AND NOT p.prosecdef AND NOT p.proisstrict AND NOT p.proleakproof AND NOT p.proretset AND p.proparallel='u' AND p.proargmodes IS NULL AND p.proallargtypes IS NULL AND p.prosqlbody IS NULL AND p.prosupport=0 AND p.proargdefaults IS NULL AND p.provariadic=0 AND p.pronargs=3 AND p.pronargdefaults=0 AND p.proargnames IS NOT DISTINCT FROM ARRAY['actor','session','token']::text[] AND p.prorettype='boolean'::regtype AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='sql') AND p.provolatile='v' AND p.proconfig IS NULL AND p.prosrc=$prior$
 SELECT whaleu_profile.moderation_identity_current(actor,session,token)
 AND EXISTS(SELECT 1 FROM whaleu_identity.sessions s WHERE s.id=session AND s.account_id=actor AND s.access_expires_at>clock_timestamp())
$prior$) THEN
  RAISE EXCEPTION 'Session epoch predecessor function mismatch: whaleu_safety.account_appeal_identity_current' USING ERRCODE='23514';
 END IF;
END$qualify$;
CREATE OR REPLACE FUNCTION whaleu_safety.account_appeal_identity_current(actor uuid,session uuid,token text)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT whaleu_profile.moderation_identity_current(actor,session,token)
 AND EXISTS(SELECT 1 FROM whaleu_identity.sessions s WHERE s.id=session AND s.account_id=actor AND s.issued_revocation_epoch=(SELECT session_revocation_epoch FROM whaleu_identity.accounts WHERE id=actor) AND s.access_expires_at>clock_timestamp())
$$;

-- Last prior definition: 0113_course_comments.sql:139.
DO $qualify$BEGIN
 IF (SELECT count(*) FROM pg_proc WHERE pronamespace='whaleu_ratings'::regnamespace AND proname='course_comment_deadline')<>1
 OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='whaleu_ratings'::regnamespace AND p.proname='course_comment_deadline' AND p.oid=to_regprocedure('whaleu_ratings.course_comment_deadline(uuid,uuid,uuid,boolean,timestamptz)') AND p.prokind='f' AND NOT p.prosecdef AND NOT p.proisstrict AND NOT p.proleakproof AND NOT p.proretset AND p.proparallel='u' AND p.proargmodes IS NULL AND p.proallargtypes IS NULL AND p.prosqlbody IS NULL AND p.prosupport=0 AND p.proargdefaults IS NULL AND p.provariadic=0 AND p.pronargs=5 AND p.pronargdefaults=0 AND p.proargnames IS NOT DISTINCT FROM ARRAY['actor','sid','cid','publish','instant']::text[] AND p.prorettype='timestamptz'::regtype AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='sql') AND p.provolatile='s' AND p.proconfig IS NULL AND p.prosrc=$prior$
 SELECT min(deadline) FROM (
 SELECT least(s.access_expires_at,s.absolute_expires_at) deadline FROM whaleu_identity.sessions s WHERE s.id=sid AND s.account_id=actor
 UNION ALL SELECT a.expires_at FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id JOIN whaleu_verification.assertions a ON a.id=s.phone_assertion_id OR (publish AND a.id=s.affiliation_assertion_id) WHERE h.account_id=actor AND a.assertion_state='verified' AND a.expires_at>instant
 UNION ALL SELECT a.valid_until FROM whaleu_verification.rating_base_heads h JOIN whaleu_verification.rating_base_assertions a ON a.id=h.assertion_id WHERE h.account_id=actor AND publish AND a.state='verified' AND a.valid_until>instant
 UNION ALL SELECT least(CASE WHEN g.valid_from>instant THEN g.valid_from END,g.expires_at) FROM whaleu_authorization.role_grants g WHERE g.account_id=actor AND publish AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>instant)
 UNION ALL SELECT valid_until FROM whaleu_safety.account_heads WHERE account_id=actor
 UNION ALL SELECT c.valid_until FROM whaleu_ratings.course_catalog_head h JOIN whaleu_ratings.course_catalogs c ON c.id=h.catalog_id
 UNION ALL SELECT a.valid_until FROM whaleu_ratings.course_comment_history_heads h JOIN whaleu_ratings.course_comment_history_assertions a ON a.id=h.assertion_id WHERE h.course_id=cid
 ) deadlines
$prior$) THEN
  RAISE EXCEPTION 'Session epoch predecessor function mismatch: whaleu_ratings.course_comment_deadline' USING ERRCODE='23514';
 END IF;
END$qualify$;
CREATE OR REPLACE FUNCTION whaleu_ratings.course_comment_deadline(actor uuid,sid uuid,cid uuid,publish boolean,instant timestamptz) RETURNS timestamptz LANGUAGE sql STABLE AS $$
 SELECT min(deadline) FROM (
 SELECT least(s.access_expires_at,s.absolute_expires_at) deadline FROM whaleu_identity.sessions s WHERE s.id=sid AND s.account_id=actor AND s.issued_revocation_epoch=(SELECT session_revocation_epoch FROM whaleu_identity.accounts WHERE id=actor)
 UNION ALL SELECT a.expires_at FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id JOIN whaleu_verification.assertions a ON a.id=s.phone_assertion_id OR (publish AND a.id=s.affiliation_assertion_id) WHERE h.account_id=actor AND a.assertion_state='verified' AND a.expires_at>instant
 UNION ALL SELECT a.valid_until FROM whaleu_verification.rating_base_heads h JOIN whaleu_verification.rating_base_assertions a ON a.id=h.assertion_id WHERE h.account_id=actor AND publish AND a.state='verified' AND a.valid_until>instant
 UNION ALL SELECT least(CASE WHEN g.valid_from>instant THEN g.valid_from END,g.expires_at) FROM whaleu_authorization.role_grants g WHERE g.account_id=actor AND publish AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>instant)
 UNION ALL SELECT valid_until FROM whaleu_safety.account_heads WHERE account_id=actor
 UNION ALL SELECT c.valid_until FROM whaleu_ratings.course_catalog_head h JOIN whaleu_ratings.course_catalogs c ON c.id=h.catalog_id
 UNION ALL SELECT a.valid_until FROM whaleu_ratings.course_comment_history_heads h JOIN whaleu_ratings.course_comment_history_assertions a ON a.id=h.assertion_id WHERE h.course_id=cid
 ) deadlines
$$;

-- Last prior definition: 0114_window_ratings.sql:114.
DO $qualify$BEGIN
 IF (SELECT count(*) FROM pg_proc WHERE pronamespace='whaleu_ratings'::regnamespace AND proname='window_deadline')<>1
 OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='whaleu_ratings'::regnamespace AND p.proname='window_deadline' AND p.oid=to_regprocedure('whaleu_ratings.window_deadline(uuid,uuid,timestamptz)') AND p.prokind='f' AND NOT p.prosecdef AND NOT p.proisstrict AND NOT p.proleakproof AND NOT p.proretset AND p.proparallel='u' AND p.proargmodes IS NULL AND p.proallargtypes IS NULL AND p.prosqlbody IS NULL AND p.prosupport=0 AND p.proargdefaults IS NULL AND p.provariadic=0 AND p.pronargs=3 AND p.pronargdefaults=0 AND p.proargnames IS NOT DISTINCT FROM ARRAY['actor','sid','instant']::text[] AND p.prorettype='timestamptz'::regtype AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='sql') AND p.provolatile='s' AND p.proconfig IS NULL AND p.prosrc=$prior$
 SELECT min(deadline) FROM (
 SELECT least(s.access_expires_at,s.absolute_expires_at) deadline FROM whaleu_identity.sessions s WHERE s.id=sid AND s.account_id=actor
 UNION ALL SELECT a.expires_at FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id JOIN whaleu_verification.assertions a ON a.id=s.phone_assertion_id WHERE h.account_id=actor AND a.assertion_state='verified' AND a.expires_at>instant
 UNION ALL SELECT valid_until FROM whaleu_safety.account_heads WHERE account_id=actor
 UNION ALL SELECT c.valid_until FROM whaleu_ratings.window_catalog_head h JOIN whaleu_ratings.window_catalogs c ON c.id=h.catalog_id
 ) deadlines
$prior$) THEN
  RAISE EXCEPTION 'Session epoch predecessor function mismatch: whaleu_ratings.window_deadline' USING ERRCODE='23514';
 END IF;
END$qualify$;
CREATE OR REPLACE FUNCTION whaleu_ratings.window_deadline(actor uuid,sid uuid,instant timestamptz) RETURNS timestamptz LANGUAGE sql STABLE AS $$
 SELECT min(deadline) FROM (
 SELECT least(s.access_expires_at,s.absolute_expires_at) deadline FROM whaleu_identity.sessions s WHERE s.id=sid AND s.account_id=actor AND s.issued_revocation_epoch=(SELECT session_revocation_epoch FROM whaleu_identity.accounts WHERE id=actor)
 UNION ALL SELECT a.expires_at FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id JOIN whaleu_verification.assertions a ON a.id=s.phone_assertion_id WHERE h.account_id=actor AND a.assertion_state='verified' AND a.expires_at>instant
 UNION ALL SELECT valid_until FROM whaleu_safety.account_heads WHERE account_id=actor
 UNION ALL SELECT c.valid_until FROM whaleu_ratings.window_catalog_head h JOIN whaleu_ratings.window_catalogs c ON c.id=h.catalog_id
 ) deadlines
$$;

-- Last prior definition: 0119_window_discussion.sql:208.
DO $qualify$BEGIN
 IF (SELECT count(*) FROM pg_proc WHERE pronamespace='whaleu_ratings'::regnamespace AND proname='window_discussion_access_deadline')<>1
 OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='whaleu_ratings'::regnamespace AND p.proname='window_discussion_access_deadline' AND p.oid=to_regprocedure('whaleu_ratings.window_discussion_access_deadline(uuid,uuid,timestamptz)') AND p.prokind='f' AND NOT p.prosecdef AND NOT p.proisstrict AND NOT p.proleakproof AND NOT p.proretset AND p.proparallel='u' AND p.proargmodes IS NULL AND p.proallargtypes IS NULL AND p.prosqlbody IS NULL AND p.prosupport=0 AND p.proargdefaults IS NULL AND p.provariadic=0 AND p.pronargs=3 AND p.pronargdefaults=0 AND p.proargnames IS NOT DISTINCT FROM ARRAY['actor','sid','instant']::text[] AND p.prorettype='timestamptz'::regtype AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='sql') AND p.provolatile='s' AND p.proconfig IS NULL AND p.prosrc=$prior$
 SELECT min(deadline) FROM(
 SELECT least(s.access_expires_at,s.absolute_expires_at) deadline FROM whaleu_identity.sessions s WHERE s.id=sid AND s.account_id=actor
 UNION ALL SELECT a.expires_at FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id JOIN whaleu_verification.assertions a ON a.id=s.phone_assertion_id WHERE h.account_id=actor AND a.assertion_state='verified' AND a.expires_at>instant
 UNION ALL SELECT valid_until FROM whaleu_safety.account_heads WHERE account_id=actor
 ) boundaries
$prior$) THEN
  RAISE EXCEPTION 'Session epoch predecessor function mismatch: whaleu_ratings.window_discussion_access_deadline' USING ERRCODE='23514';
 END IF;
END$qualify$;
CREATE OR REPLACE FUNCTION whaleu_ratings.window_discussion_access_deadline(actor uuid,sid uuid,instant timestamptz) RETURNS timestamptz LANGUAGE sql STABLE AS $$
 SELECT min(deadline) FROM(
 SELECT least(s.access_expires_at,s.absolute_expires_at) deadline FROM whaleu_identity.sessions s WHERE s.id=sid AND s.account_id=actor AND s.issued_revocation_epoch=(SELECT session_revocation_epoch FROM whaleu_identity.accounts WHERE id=actor)
 UNION ALL SELECT a.expires_at FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id JOIN whaleu_verification.assertions a ON a.id=s.phone_assertion_id WHERE h.account_id=actor AND a.assertion_state='verified' AND a.expires_at>instant
 UNION ALL SELECT valid_until FROM whaleu_safety.account_heads WHERE account_id=actor
 ) boundaries
$$;

-- Last prior definition: 0121_major_discussion.sql:296.
DO $qualify$BEGIN
 IF (SELECT count(*) FROM pg_proc WHERE pronamespace='whaleu_majors'::regnamespace AND proname='major_discussion_access_deadline')<>1
 OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='whaleu_majors'::regnamespace AND p.proname='major_discussion_access_deadline' AND p.oid=to_regprocedure('whaleu_majors.major_discussion_access_deadline(uuid,uuid,timestamptz)') AND p.prokind='f' AND NOT p.prosecdef AND NOT p.proisstrict AND NOT p.proleakproof AND NOT p.proretset AND p.proparallel='u' AND p.proargmodes IS NULL AND p.proallargtypes IS NULL AND p.prosqlbody IS NULL AND p.prosupport=0 AND p.proargdefaults IS NULL AND p.provariadic=0 AND p.pronargs=3 AND p.pronargdefaults=0 AND p.proargnames IS NOT DISTINCT FROM ARRAY['actor','sid','instant']::text[] AND p.prorettype='timestamptz'::regtype AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='sql') AND p.provolatile='s' AND p.proconfig IS NULL AND p.prosrc=$prior$
 SELECT min(deadline) FROM(
 SELECT least(s.access_expires_at,s.absolute_expires_at) deadline FROM whaleu_identity.sessions s WHERE s.id=sid AND s.account_id=actor
 UNION ALL SELECT a.expires_at FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id JOIN whaleu_verification.assertions a ON a.id=s.phone_assertion_id WHERE h.account_id=actor AND a.assertion_state='verified' AND a.expires_at>instant
 UNION ALL SELECT valid_until FROM whaleu_safety.account_heads WHERE account_id=actor
 ) boundaries
$prior$) THEN
  RAISE EXCEPTION 'Session epoch predecessor function mismatch: whaleu_majors.major_discussion_access_deadline' USING ERRCODE='23514';
 END IF;
END$qualify$;
CREATE OR REPLACE FUNCTION whaleu_majors.major_discussion_access_deadline(actor uuid,sid uuid,instant timestamptz) RETURNS timestamptz LANGUAGE sql STABLE AS $$
 SELECT min(deadline) FROM(
 SELECT least(s.access_expires_at,s.absolute_expires_at) deadline FROM whaleu_identity.sessions s WHERE s.id=sid AND s.account_id=actor AND s.issued_revocation_epoch=(SELECT session_revocation_epoch FROM whaleu_identity.accounts WHERE id=actor)
 UNION ALL SELECT a.expires_at FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id JOIN whaleu_verification.assertions a ON a.id=s.phone_assertion_id WHERE h.account_id=actor AND a.assertion_state='verified' AND a.expires_at>instant
 UNION ALL SELECT valid_until FROM whaleu_safety.account_heads WHERE account_id=actor
 ) boundaries
$$;
