-- Separate, recoverable Safety overlays. Identity lifecycle and imported base
-- coverage are never rewritten. No role, account or source is seeded here.
CREATE TABLE whaleu_safety.account_punishments (
 id uuid PRIMARY KEY,subject_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 kind text NOT NULL CHECK(kind IN('interaction_mute','access_suspension')),
 revision bigint NOT NULL CHECK(revision>0),expected_revision bigint NOT NULL CHECK(expected_revision>=0),
 reason text NOT NULL CHECK(char_length(reason) BETWEEN 1 AND 255 AND reason=whaleu_profile.moderation_trim(reason)),
 duration jsonb NOT NULL,starts_at timestamptz NOT NULL,ends_at timestamptz,recorded_at timestamptz NOT NULL,
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),session_id uuid NOT NULL,token_hash text NOT NULL,
 grant_id uuid NOT NULL REFERENCES whaleu_authorization.role_grants(id),request_id uuid NOT NULL,
 source_kind text NOT NULL CHECK(source_kind IN('post','comment','reply')),source_id uuid NOT NULL,source_event_id uuid NOT NULL,
 identity_hash text NOT NULL,authority_hash text NOT NULL,protection_hash text NOT NULL,
 mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 UNIQUE(subject_id,kind,revision),UNIQUE(actor_id,request_id,source_kind),UNIQUE(source_event_id),
 CHECK(revision=expected_revision+1),
 CHECK(isfinite(starts_at) AND starts_at=date_trunc('milliseconds',starts_at) AND recorded_at=starts_at),
 CHECK(ends_at IS NULL OR (isfinite(ends_at) AND ends_at>starts_at AND ends_at=date_trunc('milliseconds',ends_at)))
);
CREATE INDEX account_punishments_owner_page ON whaleu_safety.account_punishments(subject_id,recorded_at DESC,id DESC);
CREATE INDEX account_punishments_page ON whaleu_safety.account_punishments(recorded_at DESC,id DESC);
CREATE TABLE whaleu_safety.account_punishment_heads (
 subject_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),kind text NOT NULL,
 punishment_id uuid NOT NULL UNIQUE REFERENCES whaleu_safety.account_punishments(id),revision bigint NOT NULL,
 PRIMARY KEY(subject_id,kind),FOREIGN KEY(subject_id,kind,revision) REFERENCES whaleu_safety.account_punishments(subject_id,kind,revision)
);
CREATE TABLE whaleu_safety.account_punishment_terminals (
 punishment_id uuid PRIMARY KEY REFERENCES whaleu_safety.account_punishments(id),
 cause text NOT NULL CHECK(cause IN('superseded','manually_released','appeal_released')),
 effective_at timestamptz NOT NULL,recorded_at timestamptz NOT NULL,reason text,
 replacement_id uuid REFERENCES whaleu_safety.account_punishments(id),
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),session_id uuid NOT NULL,token_hash text NOT NULL,
 grant_id uuid NOT NULL REFERENCES whaleu_authorization.role_grants(id),source_request_id uuid NOT NULL,cause_id uuid NOT NULL,event_id uuid NOT NULL UNIQUE,
 identity_hash text NOT NULL,authority_hash text NOT NULL,
 mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 CHECK(isfinite(effective_at) AND effective_at=date_trunc('milliseconds',effective_at) AND recorded_at=effective_at),
 CHECK((cause='superseded')=(replacement_id IS NOT NULL)),
 CHECK((cause='superseded' AND reason IS NULL) OR (cause<>'superseded' AND char_length(reason) BETWEEN 1 AND 255 AND reason=whaleu_profile.moderation_trim(reason)))
);
CREATE TABLE whaleu_safety.account_punishment_release_commands (
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,
 session_id uuid NOT NULL,token_hash text NOT NULL,grant_id uuid,
 command jsonb NOT NULL,receipt jsonb NOT NULL,intent_hash text NOT NULL,
 identity_hash text NOT NULL DEFAULT '',authority_hash text,source_hash text,
 mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),PRIMARY KEY(actor_id,request_id),
 CHECK(octet_length(command::text)<4096 AND octet_length(receipt::text)<4096),
 CHECK(request_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 CHECK(intent_hash=encode(sha256(convert_to('whaleu:account-punishment-release:v1'||chr(10)||whaleu_community.content_canonical_json(jsonb_build_object('actor',actor_id::text,'command',command)),'UTF8')),'hex'))
);
CREATE INDEX account_punishment_release_commands_transaction ON whaleu_safety.account_punishment_release_commands(mutation_transaction);
CREATE TABLE whaleu_notifications.account_punishment_notices (
 id uuid PRIMARY KEY,event_id uuid NOT NULL UNIQUE,punishment_id uuid NOT NULL REFERENCES whaleu_safety.account_punishments(id),
 recipient_account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 kind text NOT NULL CHECK(kind IN('account_punishment_issued','account_punishment_released')),
 created_at timestamptz NOT NULL,read_at timestamptz,
 CHECK(isfinite(created_at) AND created_at=date_trunc('milliseconds',created_at)),
 CHECK(read_at IS NULL OR (isfinite(read_at) AND read_at>=created_at AND read_at=date_trunc('milliseconds',read_at)))
);
CREATE INDEX account_punishment_notices_owner_page ON whaleu_notifications.account_punishment_notices(recipient_account_id,created_at DESC,id DESC);
CREATE INDEX account_punishment_notices_unread ON whaleu_notifications.account_punishment_notices(recipient_account_id) WHERE read_at IS NULL;

-- New authoritative negative-proof epoch: unlike historical diagnostic epochs,
-- its singleton cannot be deleted, reset, replaced or directly advanced.
CREATE TABLE whaleu_authorization.account_punishment_authority_epoch (
 singleton boolean PRIMARY KEY CHECK(singleton),revision bigint NOT NULL CHECK(revision>=0)
);
INSERT INTO whaleu_authorization.account_punishment_authority_epoch VALUES(true,0);
CREATE FUNCTION whaleu_authorization.account_punishment_epoch_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF TG_OP<>'UPDATE' OR pg_trigger_depth()<2 THEN RAISE EXCEPTION 'Retained owner epoch required' USING ERRCODE='23514',CONSTRAINT='account_punishment_causal';END IF;
 IF TG_LEVEL='ROW' THEN
 IF NEW.singleton IS DISTINCT FROM OLD.singleton OR NEW.revision IS DISTINCT FROM OLD.revision+1 THEN
 RAISE EXCEPTION 'Monotone owner epoch required' USING ERRCODE='23514',CONSTRAINT='account_punishment_causal';END IF;RETURN NEW;END IF;RETURN NULL;
END$$;
CREATE TRIGGER account_punishment_epoch_statement_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_authorization.account_punishment_authority_epoch FOR EACH STATEMENT EXECUTE FUNCTION whaleu_authorization.account_punishment_epoch_guard();
CREATE TRIGGER account_punishment_epoch_row_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_authorization.account_punishment_authority_epoch FOR EACH ROW EXECUTE FUNCTION whaleu_authorization.account_punishment_epoch_guard();
CREATE FUNCTION whaleu_authorization.advance_account_punishment_authority_epoch() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 UPDATE whaleu_authorization.account_punishment_authority_epoch SET revision=revision+1 WHERE singleton;
 IF NOT FOUND THEN RAISE EXCEPTION 'Missing authoritative owner epoch' USING ERRCODE='23514',CONSTRAINT='account_punishment_causal';END IF;RETURN NULL;
END$$;
CREATE TRIGGER a_account_punishment_authority_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_authorization.role_grants FOR EACH STATEMENT EXECUTE FUNCTION whaleu_authorization.advance_account_punishment_authority_epoch();
CREATE FUNCTION whaleu_safety.account_punishment_authority_epoch() RETURNS text LANGUAGE plpgsql STABLE AS $$DECLARE value text;BEGIN
 IF (SELECT count(*) FROM whaleu_authorization.account_punishment_authority_epoch)<>1 THEN
 RAISE EXCEPTION 'Complete authoritative owner epoch required' USING ERRCODE='23514',CONSTRAINT='account_punishment_causal';END IF;
 SELECT revision::text INTO value FROM whaleu_authorization.account_punishment_authority_epoch WHERE singleton AND revision>=0;
 IF value IS NULL THEN RAISE EXCEPTION 'Valid authoritative owner epoch required' USING ERRCODE='23514',CONSTRAINT='account_punishment_causal';END IF;RETURN value;
END$$;
CREATE FUNCTION whaleu_safety.account_punishment_identity_current(actor uuid,session uuid,token text)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT whaleu_profile.moderation_identity_current(actor,session,token)
 AND EXISTS(SELECT 1 FROM whaleu_identity.sessions s WHERE s.id=session AND s.account_id=actor AND s.access_expires_at>clock_timestamp())
$$;
CREATE FUNCTION whaleu_safety.account_punishment_effective(subject uuid,selected_kind text)
RETURNS boolean LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_safety.account_punishment_heads h
 JOIN whaleu_safety.account_punishments p ON (p.id,p.subject_id,p.kind,p.revision)=(h.punishment_id,h.subject_id,h.kind,h.revision)
 WHERE h.subject_id=subject AND h.kind=selected_kind AND p.starts_at<=clock_timestamp()
 AND (p.ends_at IS NULL OR p.ends_at>clock_timestamp())
 AND NOT EXISTS(SELECT 1 FROM whaleu_safety.account_punishment_terminals t WHERE t.punishment_id=p.id))
$$;
CREATE FUNCTION whaleu_safety.account_punishment_allows(subject uuid,action text)
RETURNS boolean LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 SELECT CASE
 WHEN action IN('guest','restricted_self_service') THEN true
 WHEN action NOT IN('browse','interaction','private_self_service','protective_cleanup','passive_bookkeeping','privileged_read','noncontent_management','content_management') THEN false
 WHEN whaleu_safety.account_punishment_effective(subject,'access_suspension') THEN false
 WHEN action IN('interaction','content_management') AND whaleu_safety.account_punishment_effective(subject,'interaction_mute') THEN false
 ELSE true END
$$;
CREATE FUNCTION whaleu_safety.account_punishment_fingerprint(subject uuid)
RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT whaleu_profile.moderation_hash(coalesce(jsonb_agg(jsonb_build_array(to_jsonb(h),h.xmin::text,h.ctid::text,to_jsonb(p),p.xmin::text,p.ctid::text,to_jsonb(t),t.xmin::text,t.ctid::text) ORDER BY h.kind),'[]'::jsonb))
 FROM whaleu_safety.account_punishment_heads h JOIN whaleu_safety.account_punishments p ON p.id=h.punishment_id
 LEFT JOIN whaleu_safety.account_punishment_terminals t ON t.punishment_id=p.id WHERE h.subject_id=subject
$$;
CREATE FUNCTION whaleu_safety.account_punishment_version(target uuid)
RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT whaleu_profile.moderation_hash(jsonb_build_array(to_jsonb(p),p.xmin::text,p.ctid::text,to_jsonb(h),h.xmin::text,h.ctid::text,to_jsonb(t),t.xmin::text,t.ctid::text))
 FROM whaleu_safety.account_punishments p LEFT JOIN whaleu_safety.account_punishment_heads h ON (h.subject_id,h.kind)=(p.subject_id,p.kind)
 LEFT JOIN whaleu_safety.account_punishment_terminals t ON t.punishment_id=p.id WHERE p.id=target
$$;
CREATE FUNCTION whaleu_safety.account_punishment_super_admin(actor uuid,selected uuid)
RETURNS boolean LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_authorization.role_grants g WHERE g.id=selected AND g.account_id=actor
 AND g.role='super_admin' AND g.operating_region_id IS NULL AND g.revoked_at IS NULL
 AND g.valid_from<=clock_timestamp() AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp()))
$$;
CREATE FUNCTION whaleu_safety.account_punishment_authority_hash(selected uuid)
RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT whaleu_profile.moderation_hash(jsonb_build_array(to_jsonb(g),g.xmin::text,g.ctid::text)) FROM whaleu_authorization.role_grants g WHERE g.id=selected
$$;
CREATE FUNCTION whaleu_safety.account_punishment_protection_hash(subject uuid)
RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT whaleu_profile.moderation_hash(jsonb_build_array(
 (SELECT coalesce(jsonb_agg(jsonb_build_array(to_jsonb(g),g.xmin::text,g.ctid::text) ORDER BY g.id),'[]'::jsonb)
 FROM whaleu_authorization.role_grants g WHERE g.account_id=subject AND g.revoked_at IS NULL),
 whaleu_safety.account_punishment_authority_epoch()))
$$;
CREATE FUNCTION whaleu_safety.account_punishment_unprotected(subject uuid)
RETURNS boolean LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 SELECT NOT EXISTS(SELECT 1 FROM whaleu_authorization.role_grants g WHERE g.account_id=subject AND g.revoked_at IS NULL
 AND g.role IN('school_admin','super_admin','developer') AND g.valid_from<=clock_timestamp()
 AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp()))
$$;
CREATE FUNCTION whaleu_safety.account_punishment_duration_end(starts timestamptz,duration jsonb,source_kind text)
RETURNS timestamptz LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE result timestamptz;amount bigint;BEGIN
 IF duration=jsonb_build_object('kind','permanent') THEN RETURN NULL;END IF;
 IF whaleu_community.post_owner_visibility_keys(duration,ARRAY['kind','unit','value']) IS DISTINCT FROM true
 OR duration->>'kind' IS DISTINCT FROM 'finite' OR jsonb_typeof(duration->'value') IS DISTINCT FROM 'number'
 OR coalesce(duration->>'value' ~ '^[1-9][0-9]{0,9}$',false)=false
 OR coalesce(duration->>'unit' IN('minutes','hours','days'),false)=false
 OR (source_kind='post' AND duration->>'unit'='minutes') THEN
 RAISE EXCEPTION 'Invalid account punishment duration' USING ERRCODE='23514',CONSTRAINT='account_punishment_duration';END IF;
 amount:=(duration->>'value')::bigint;
 IF amount>2147483647 THEN RAISE EXCEPTION 'Duration overflow' USING ERRCODE='23514',CONSTRAINT='account_punishment_duration';END IF;
 result:=starts+(amount * CASE duration->>'unit' WHEN 'minutes' THEN interval '1 minute' WHEN 'hours' THEN interval '1 hour' ELSE interval '24 hours' END);
 IF NOT isfinite(result) OR result<=starts OR result>'9999-12-31T23:59:59.999Z'::timestamptz THEN
 RAISE EXCEPTION 'Duration overflow' USING ERRCODE='23514',CONSTRAINT='account_punishment_duration';END IF;
 RETURN result;
END$$;

-- The causal Community owner replaces these closed adapters later in this same
-- migration. They can never grant arbitrary-account issuance on their own.
CREATE FUNCTION whaleu_safety.account_punishment_issue_context(actor uuid,request uuid,source_kind text,source_id uuid)
RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT NULL::jsonb $$;
CREATE FUNCTION whaleu_safety.account_punishment_issue_cause_current(punishment_id uuid)
RETURNS boolean LANGUAGE sql VOLATILE AS $$ SELECT false $$;
CREATE FUNCTION whaleu_safety.validate_account_appeal_release(cause_id uuid,punishment_id uuid,event_id uuid,actor_id uuid,request_id uuid)
RETURNS boolean LANGUAGE sql VOLATILE AS $$ SELECT false $$;

CREATE FUNCTION whaleu_safety.account_punishment_immutable() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 RAISE EXCEPTION 'Account punishment history is immutable' USING ERRCODE='23514',CONSTRAINT='account_punishment_causal';END$$;
CREATE FUNCTION whaleu_safety.account_punishment_nested_writer() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF pg_trigger_depth()<2 THEN RAISE EXCEPTION 'Only causal owner triggers may write punishment state' USING ERRCODE='23514',CONSTRAINT='account_punishment_causal';END IF;RETURN NULL;
END$$;
DO $$DECLARE relation text;BEGIN
 FOREACH relation IN ARRAY ARRAY['account_punishments','account_punishment_terminals','account_punishment_release_commands'] LOOP
 EXECUTE format('CREATE TRIGGER account_punishment_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_safety.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_punishment_immutable()',relation);
 END LOOP;
 FOREACH relation IN ARRAY ARRAY['account_punishments','account_punishment_terminals','account_punishment_heads'] LOOP
 EXECUTE format('CREATE TRIGGER account_punishment_nested_writer BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_safety.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_punishment_nested_writer()',relation);
 END LOOP;
END$$;

CREATE FUNCTION whaleu_safety.issue_account_punishment(actor uuid,request uuid,source_kind text,source_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE c jsonb;s jsonb;prior whaleu_safety.account_punishments;head whaleu_safety.account_punishment_heads;
 subject uuid;selected_kind text;selected_id uuid;at timestamptz;next_id uuid;next_revision bigint;BEGIN
 IF pg_trigger_depth()<1 THEN RAISE EXCEPTION 'Causal removal trigger required' USING ERRCODE='23514',CONSTRAINT='account_punishment_causal';END IF;
 c:=whaleu_safety.account_punishment_issue_context(actor,request,source_kind,source_id);s:=c->'selection';
 IF c IS NULL OR whaleu_community.post_owner_visibility_keys(s,ARRAY['kind','duration','reason','expectedRevision']) IS DISTINCT FROM true
 OR coalesce(s->>'kind' IN('interaction_mute','access_suspension'),false)=false
 OR jsonb_typeof(s->'reason') IS DISTINCT FROM 'string' OR char_length(s->>'reason') NOT BETWEEN 1 AND 255
 OR s->>'reason'<>whaleu_profile.moderation_trim(s->>'reason')
 OR coalesce(s->>'expectedRevision' ~ '^(0|[1-9][0-9]{0,18})$',false)=false
 THEN RAISE EXCEPTION 'Exact causal punishment selection required' USING ERRCODE='23514',CONSTRAINT='account_punishment_causal';END IF;
 next_id:=(c->>'punishmentId')::uuid;
 IF next_id IS NULL THEN RAISE EXCEPTION 'Frozen receipt punishment ID required' USING ERRCODE='23514',CONSTRAINT='account_punishment_causal';END IF;
 subject:=(c->>'subjectId')::uuid;selected_id:=(c->>'grantId')::uuid;selected_kind:=s->>'kind';at:=(c->>'recordedAt')::timestamptz;
 IF subject=actor OR at<date_trunc('milliseconds',transaction_timestamp()) OR at<clock_timestamp()-interval '15 seconds' OR at>clock_timestamp() OR NOT whaleu_safety.account_punishment_identity_current(actor,(c->>'sessionId')::uuid,c->>'tokenHash')
 OR NOT whaleu_safety.account_punishment_unprotected(subject) THEN
 RAISE EXCEPTION 'Current unprotected other author required' USING ERRCODE='23514',CONSTRAINT='account_punishment_causal';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:account-punishment:'||subject::text||':'||selected_kind,0));
 SELECT * INTO head FROM whaleu_safety.account_punishment_heads h WHERE (h.subject_id,h.kind)=(subject,selected_kind) FOR UPDATE;
 IF coalesce(head.revision,0)<>(s->>'expectedRevision')::bigint THEN RAISE EXCEPTION 'Punishment revision changed' USING ERRCODE='23514',CONSTRAINT='account_punishment_stale';END IF;
 SELECT * INTO prior FROM whaleu_safety.account_punishments p WHERE p.id=head.punishment_id;
 IF prior.id IS NOT NULL AND prior.ends_at IS NULL AND s->'duration'->>'kind'='finite'
 AND NOT EXISTS(SELECT 1 FROM whaleu_safety.account_punishment_terminals t WHERE t.punishment_id=prior.id)
 THEN RAISE EXCEPTION 'Permanent punishment requires release first' USING ERRCODE='23514',CONSTRAINT='account_punishment_permanent';END IF;
 next_revision:=coalesce(head.revision,0)+1;
 INSERT INTO whaleu_safety.account_punishments(id,subject_id,kind,revision,expected_revision,reason,duration,starts_at,ends_at,recorded_at,actor_id,session_id,token_hash,grant_id,request_id,source_kind,source_id,source_event_id,identity_hash,authority_hash,protection_hash)
 VALUES(next_id,subject,selected_kind,next_revision,next_revision-1,s->>'reason',s->'duration',at,
 whaleu_safety.account_punishment_duration_end(at,s->'duration',source_kind),at,actor,(c->>'sessionId')::uuid,c->>'tokenHash',selected_id,request,source_kind,source_id,(c->>'sourceEventId')::uuid,
 whaleu_profile.moderation_hash(whaleu_profile.moderation_identity_facts(actor,(c->>'sessionId')::uuid,c->>'tokenHash')),
 whaleu_safety.account_punishment_authority_hash(selected_id),whaleu_safety.account_punishment_protection_hash(subject));
 IF prior.id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM whaleu_safety.account_punishment_terminals t WHERE t.punishment_id=prior.id) THEN
 INSERT INTO whaleu_safety.account_punishment_terminals(punishment_id,cause,effective_at,recorded_at,reason,replacement_id,actor_id,session_id,token_hash,grant_id,source_request_id,cause_id,event_id,identity_hash,authority_hash)
 SELECT prior.id,'superseded',at,at,NULL,next_id,actor,session_id,token_hash,grant_id,request_id,next_id,gen_random_uuid(),identity_hash,authority_hash
 FROM whaleu_safety.account_punishments WHERE id=next_id;
 END IF;
 INSERT INTO whaleu_safety.account_punishment_heads(subject_id,kind,punishment_id,revision) VALUES(subject,selected_kind,next_id,next_revision)
 ON CONFLICT(subject_id,kind) DO UPDATE SET punishment_id=excluded.punishment_id,revision=excluded.revision;
 PERFORM whaleu_safety.append_account_punishment_notice(next_id,next_id,'account_punishment_issued',at);
END$$;

CREATE FUNCTION whaleu_safety.append_account_punishment_notice(target uuid,event uuid,notice_kind text,at timestamptz)
RETURNS void LANGUAGE plpgsql AS $$DECLARE subject uuid;BEGIN
 IF pg_trigger_depth()<1 THEN RAISE EXCEPTION 'Causal notice required' USING ERRCODE='23514',CONSTRAINT='account_punishment_causal';END IF;
 SELECT subject_id INTO STRICT subject FROM whaleu_safety.account_punishments WHERE id=target;
 INSERT INTO whaleu_notifications.system_notice_owners(account_id) VALUES(subject) ON CONFLICT DO NOTHING;
 PERFORM account_id FROM whaleu_notifications.system_notice_owners WHERE account_id=subject FOR UPDATE;
 INSERT INTO whaleu_notifications.account_punishment_notices(id,event_id,punishment_id,recipient_account_id,kind,created_at)
 VALUES(gen_random_uuid(),event,target,subject,notice_kind,at);
END$$;
CREATE FUNCTION whaleu_safety.release_account_punishment(actor uuid,session uuid,token text,selected uuid,request uuid,target uuid,selected_kind text,selected_revision bigint,reason text,cause text,cause_id uuid,event uuid,at timestamptz)
RETURNS void LANGUAGE plpgsql AS $$DECLARE p whaleu_safety.account_punishments;BEGIN
 IF pg_trigger_depth()<1 OR cause NOT IN('manually_released','appeal_released')
 OR NOT whaleu_safety.account_punishment_identity_current(actor,session,token)
 OR NOT whaleu_safety.account_punishment_super_admin(actor,selected)
 OR NOT whaleu_safety.account_punishment_allows(actor,'noncontent_management')
 OR at<date_trunc('milliseconds',transaction_timestamp()) OR at<clock_timestamp()-interval '15 seconds' OR at>clock_timestamp() THEN
 RAISE EXCEPTION 'Current super-admin release cause required' USING ERRCODE='23514',CONSTRAINT='account_punishment_causal';END IF;
 SELECT * INTO STRICT p FROM whaleu_safety.account_punishments WHERE id=target;
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:account-punishment:'||p.subject_id::text||':'||p.kind,0));
 PERFORM 1 FROM whaleu_safety.account_punishment_heads WHERE subject_id=p.subject_id AND kind=p.kind FOR UPDATE;
 IF (p.kind,p.revision) IS DISTINCT FROM (selected_kind,selected_revision)
 OR NOT EXISTS(SELECT 1 FROM whaleu_safety.account_punishment_heads WHERE punishment_id=target)
 OR (p.ends_at IS NOT NULL AND p.ends_at<=clock_timestamp())
 OR EXISTS(SELECT 1 FROM whaleu_safety.account_punishment_terminals WHERE punishment_id=target)
 THEN RAISE EXCEPTION 'Exact effective punishment required' USING ERRCODE='23514',CONSTRAINT='account_punishment_stale';END IF;
 INSERT INTO whaleu_safety.account_punishment_terminals(punishment_id,cause,effective_at,recorded_at,reason,replacement_id,actor_id,session_id,token_hash,grant_id,source_request_id,cause_id,event_id,identity_hash,authority_hash)
 VALUES(target,cause,at,at,reason,NULL,actor,session,token,selected,request,cause_id,event,
 whaleu_profile.moderation_hash(whaleu_profile.moderation_identity_facts(actor,session,token)),whaleu_safety.account_punishment_authority_hash(selected));
 PERFORM whaleu_safety.append_account_punishment_notice(target,event,'account_punishment_released',at);
END$$;
CREATE FUNCTION whaleu_safety.require_account_punishment_allowed(actor uuid,action text)
RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$BEGIN
 LOCK TABLE whaleu_safety.account_punishments,whaleu_safety.account_punishment_heads,whaleu_safety.account_punishment_terminals IN SHARE MODE NOWAIT;
 IF NOT whaleu_safety.account_punishment_allows(actor,action) THEN
 RAISE EXCEPTION 'Current account punishment denies this operation' USING ERRCODE='23514',CONSTRAINT='account_punishment_policy';END IF;
 RETURN true;
END$$;
CREATE FUNCTION whaleu_safety.account_punishment_open_appeal(target uuid)
RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
CREATE FUNCTION whaleu_safety.account_punishment_view(target uuid)
RETURNS jsonb LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 WITH source AS MATERIALIZED (
 SELECT p.*,t.cause,t.effective_at,t.reason terminal_reason,
 CASE WHEN p.ends_at IS NOT NULL AND p.ends_at<=clock_timestamp() AND (t.effective_at IS NULL OR p.ends_at<=t.effective_at) THEN 'expired'
 WHEN t.cause='superseded' THEN 'superseded' WHEN t.cause IN('manually_released','appeal_released') THEN 'released' ELSE 'active' END state
 FROM whaleu_safety.account_punishments p LEFT JOIN whaleu_safety.account_punishment_terminals t ON t.punishment_id=p.id WHERE p.id=target)
 SELECT jsonb_build_object('punishmentId',id,'kind',kind,'revision',revision::text,'reason',reason,
 'startsAt',to_char(starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'endsAt',CASE WHEN ends_at IS NULL THEN NULL ELSE to_char(ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
 'recordedAt',to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'state',state,
 'terminal',CASE WHEN state='active' THEN NULL ELSE jsonb_build_object(
 'cause',CASE WHEN state='expired' THEN 'expired' ELSE cause END,
 'effectiveAt',to_char((CASE WHEN state='expired' THEN ends_at ELSE effective_at END) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'reason',CASE WHEN state='expired' THEN NULL ELSE terminal_reason END) END,
 'canAppeal',state='active','openAppealId',whaleu_safety.account_punishment_open_appeal(id)) FROM source
$$;
CREATE FUNCTION whaleu_safety.account_punishment_admin_current(actor uuid,selected uuid)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT whaleu_safety.account_punishment_super_admin(actor,selected)
 AND whaleu_safety.account_punishment_allows(actor,'noncontent_management')
 AND EXISTS(SELECT 1 FROM whaleu_safety.account_heads h WHERE h.account_id=actor
 AND h.restriction_coverage='complete' AND h.block_coverage='complete' AND h.provenance<>'unknown' AND h.actions_allowed
 AND (h.valid_until IS NULL OR h.valid_until>clock_timestamp()))
$$;
CREATE FUNCTION whaleu_safety.account_punishment_release_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p whaleu_safety.account_punishments;ref jsonb;cancelled boolean;identity_observed text;authority_observed text;source_observed text;BEGIN
 identity_observed:=whaleu_profile.moderation_hash(whaleu_profile.moderation_identity_facts(NEW.actor_id,NEW.session_id,NEW.token_hash));
 IF current_setting('transaction_isolation')<>'read committed' OR NEW.mutation_transaction<>pg_current_xact_id()
 OR whaleu_community.post_owner_visibility_keys(NEW.command,ARRAY['clientRequestId','action','punishment','expectedStateVersion','reason']) IS DISTINCT FROM true
 OR whaleu_community.post_owner_visibility_keys(NEW.command->'punishment',ARRAY['punishmentId','kind','revision']) IS DISTINCT FROM true
 OR NEW.command->>'clientRequestId' IS DISTINCT FROM NEW.request_id::text OR NEW.command->>'action' IS DISTINCT FROM 'release'
 OR jsonb_typeof(NEW.command->'reason') IS DISTINCT FROM 'string' OR char_length(NEW.command->>'reason') NOT BETWEEN 1 AND 255
 OR NEW.command->>'reason'<>whaleu_profile.moderation_trim(NEW.command->>'reason')
 OR coalesce(NEW.command->>'expectedStateVersion' ~ '^[a-f0-9]{64}$',false)=false
 OR NOT whaleu_profile.moderation_uuid_valid(NEW.command->'punishment'->>'punishmentId')
 OR coalesce(NEW.command->'punishment'->>'kind' IN('interaction_mute','access_suspension'),false)=false
 OR coalesce(NEW.command->'punishment'->>'revision' ~ '^[1-9][0-9]{0,18}$',false)=false
 OR NEW.receipt->>'requestId' IS DISTINCT FROM NEW.request_id::text OR NEW.receipt->>'action' IS DISTINCT FROM 'release'
 OR NEW.receipt->'punishment' IS DISTINCT FROM NEW.command->'punishment'
 OR whaleu_community.post_owner_visibility_keys(NEW.receipt,CASE WHEN NEW.receipt->>'outcome'='applied' THEN ARRAY['requestId','action','punishment','outcome','eventId','recordedAt'] ELSE ARRAY['requestId','action','punishment','outcome','code'] END) IS DISTINCT FROM true
 OR coalesce(NEW.receipt->>'outcome' IN('applied','rejected'),false)=false
 OR (NEW.receipt->>'outcome'='rejected' AND coalesce(NEW.receipt->>'code' IN('SAFETY_MODERATION_STALE','SAFETY_MODERATION_CANCELLED'),false)=false)
 THEN RAISE EXCEPTION 'Exact release command required' USING ERRCODE='23514',CONSTRAINT='account_punishment_causal';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:account-punishment-release:v1:'||NEW.actor_id::text||':'||NEW.request_id::text,0));
 IF identity_observed IS DISTINCT FROM whaleu_profile.moderation_hash(whaleu_profile.moderation_identity_facts(NEW.actor_id,NEW.session_id,NEW.token_hash))
 OR NOT whaleu_safety.account_punishment_identity_current(NEW.actor_id,NEW.session_id,NEW.token_hash) THEN
 RAISE EXCEPTION 'Current authenticated account required' USING ERRCODE='23514',CONSTRAINT='account_punishment_causal';END IF;
 NEW.identity_hash:=whaleu_profile.moderation_hash(whaleu_profile.moderation_identity_facts(NEW.actor_id,NEW.session_id,NEW.token_hash));
 cancelled:=NEW.receipt->>'code'='SAFETY_MODERATION_CANCELLED';
 IF cancelled THEN
 IF NEW.grant_id IS NOT NULL THEN RAISE EXCEPTION 'Cancellation has no grant' USING ERRCODE='23514',CONSTRAINT='account_punishment_causal';END IF;
 NEW.authority_hash:=NULL;NEW.source_hash:=NULL;RETURN NEW;END IF;
 IF NOT whaleu_safety.account_punishment_admin_current(NEW.actor_id,NEW.grant_id) THEN
 RAISE EXCEPTION 'Current super-admin required' USING ERRCODE='23514',CONSTRAINT='account_punishment_causal';END IF;
 ref:=NEW.command->'punishment';SELECT * INTO p FROM whaleu_safety.account_punishments WHERE id=(ref->>'punishmentId')::uuid;
 IF p.id IS NULL OR p.kind<>ref->>'kind' OR p.revision::text<>ref->>'revision' THEN
 RAISE EXCEPTION 'Exact existing punishment required' USING ERRCODE='23514',CONSTRAINT='account_punishment_causal';END IF;
 authority_observed:=whaleu_safety.account_punishment_authority_hash(NEW.grant_id);
 source_observed:=whaleu_safety.account_punishment_version(p.id);
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:account-punishment:'||p.subject_id::text||':'||p.kind,0));
 IF authority_observed IS DISTINCT FROM whaleu_safety.account_punishment_authority_hash(NEW.grant_id)
 OR source_observed IS DISTINCT FROM whaleu_safety.account_punishment_version(p.id) THEN
 RAISE EXCEPTION 'Release inputs changed while waiting' USING ERRCODE='23514',CONSTRAINT='account_punishment_causal';END IF;
 NEW.authority_hash:=whaleu_safety.account_punishment_authority_hash(NEW.grant_id);
 NEW.source_hash:=whaleu_safety.account_punishment_version(p.id);
 IF NEW.receipt->>'outcome'='applied' THEN
 IF NEW.source_hash IS DISTINCT FROM NEW.command->>'expectedStateVersion'
 OR NOT EXISTS(SELECT 1 FROM whaleu_safety.account_punishment_heads WHERE punishment_id=p.id)
 OR EXISTS(SELECT 1 FROM whaleu_safety.account_punishment_terminals WHERE punishment_id=p.id)
 OR (p.ends_at IS NOT NULL AND p.ends_at<=clock_timestamp())
 OR NOT whaleu_profile.moderation_uuid_valid(NEW.receipt->>'eventId')
 OR coalesce(NEW.receipt->>'recordedAt' ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9][.][0-9]{3}Z$',false)=false
 OR (NEW.receipt->>'recordedAt')::timestamptz<date_trunc('milliseconds',transaction_timestamp())
 OR (NEW.receipt->>'recordedAt')::timestamptz<clock_timestamp()-interval '15 seconds'
 OR (NEW.receipt->>'recordedAt')::timestamptz>clock_timestamp()
 THEN RAISE EXCEPTION 'Effective current release CAS required' USING ERRCODE='23514',CONSTRAINT='account_punishment_stale';END IF;
 ELSIF NEW.source_hash=NEW.command->>'expectedStateVersion' AND NOT EXISTS(SELECT 1 FROM whaleu_safety.account_punishment_terminals WHERE punishment_id=p.id)
 AND (p.ends_at IS NULL OR p.ends_at>clock_timestamp()) THEN
 RAISE EXCEPTION 'A current punishment is not stale' USING ERRCODE='23514',CONSTRAINT='account_punishment_causal';END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER account_punishment_release_guard BEFORE INSERT ON whaleu_safety.account_punishment_release_commands FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_punishment_release_guard();
CREATE FUNCTION whaleu_safety.account_punishment_release_apply() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.receipt->>'outcome'='applied' THEN
 PERFORM whaleu_safety.release_account_punishment(NEW.actor_id,NEW.session_id,NEW.token_hash,NEW.grant_id,NEW.request_id,
 (NEW.command->'punishment'->>'punishmentId')::uuid,NEW.command->'punishment'->>'kind',(NEW.command->'punishment'->>'revision')::bigint,
 NEW.command->>'reason','manually_released',NEW.request_id,(NEW.receipt->>'eventId')::uuid,(NEW.receipt->>'recordedAt')::timestamptz);
 END IF;RETURN NULL;
END$$;
CREATE TRIGGER account_punishment_release_apply AFTER INSERT ON whaleu_safety.account_punishment_release_commands FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_punishment_release_apply();

CREATE FUNCTION whaleu_safety.account_punishment_release_complete(q whaleu_safety.account_punishment_release_commands)
RETURNS void LANGUAGE plpgsql AS $$DECLARE t whaleu_safety.account_punishment_terminals;BEGIN
 LOCK TABLE whaleu_identity.accounts,whaleu_identity.sessions,whaleu_identity.access_tokens IN SHARE MODE NOWAIT;
 IF NOT whaleu_safety.account_punishment_identity_current(q.actor_id,q.session_id,q.token_hash)
 OR q.identity_hash IS DISTINCT FROM whaleu_profile.moderation_hash(whaleu_profile.moderation_identity_facts(q.actor_id,q.session_id,q.token_hash)) THEN
 RAISE EXCEPTION 'Original release identity changed' USING ERRCODE='23514',CONSTRAINT='account_punishment_causal';END IF;
 IF q.receipt->>'code'='SAFETY_MODERATION_CANCELLED' THEN
 IF EXISTS(SELECT 1 FROM whaleu_safety.account_punishment_terminals WHERE (actor_id,source_request_id,cause)=(q.actor_id,q.request_id,'manually_released')) THEN
 RAISE EXCEPTION 'Cancelled release cannot mutate punishment' USING ERRCODE='23514',CONSTRAINT='account_punishment_causal';END IF;RETURN;END IF;
 LOCK TABLE whaleu_authorization.role_grants,whaleu_safety.account_heads,whaleu_safety.account_punishments,whaleu_safety.account_punishment_heads,whaleu_safety.account_punishment_terminals IN SHARE MODE NOWAIT;
 IF NOT whaleu_safety.account_punishment_admin_current(q.actor_id,q.grant_id)
 OR q.authority_hash IS DISTINCT FROM whaleu_safety.account_punishment_authority_hash(q.grant_id) THEN
 RAISE EXCEPTION 'Original release authority changed' USING ERRCODE='23514',CONSTRAINT='account_punishment_causal';END IF;
 SELECT * INTO t FROM whaleu_safety.account_punishment_terminals WHERE punishment_id=(q.command->'punishment'->>'punishmentId')::uuid;
 IF q.receipt->>'outcome'='applied' THEN
 IF t.punishment_id IS NULL OR t.mutation_transaction<>pg_current_xact_id()
 OR (t.actor_id,t.source_request_id,t.event_id,t.cause,t.reason,t.effective_at) IS DISTINCT FROM
 (q.actor_id,q.request_id,(q.receipt->>'eventId')::uuid,'manually_released',q.command->>'reason',(q.receipt->>'recordedAt')::timestamptz) THEN
 RAISE EXCEPTION 'Exact release transition required' USING ERRCODE='23514',CONSTRAINT='account_punishment_causal';END IF;
 PERFORM whaleu_safety.account_punishment_assert_complete(t.punishment_id);
 ELSIF q.source_hash IS DISTINCT FROM whaleu_safety.account_punishment_version((q.command->'punishment'->>'punishmentId')::uuid) THEN
 RAISE EXCEPTION 'Stale release observation changed' USING ERRCODE='23514',CONSTRAINT='account_punishment_causal';END IF;
END$$;
CREATE FUNCTION whaleu_safety.account_punishment_assert_complete(target uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE p whaleu_safety.account_punishments;t whaleu_safety.account_punishment_terminals;c jsonb;BEGIN
 SELECT * INTO p FROM whaleu_safety.account_punishments WHERE id=target;
 IF p.id IS NULL THEN RAISE EXCEPTION 'Punishment missing' USING ERRCODE='23514',CONSTRAINT='account_punishment_causal';END IF;
 LOCK TABLE whaleu_identity.accounts,whaleu_identity.sessions,whaleu_identity.access_tokens,whaleu_authorization.role_grants,whaleu_authorization.account_punishment_authority_epoch,
 whaleu_safety.account_punishments,whaleu_safety.account_punishment_heads,whaleu_safety.account_punishment_terminals IN SHARE MODE NOWAIT;
 IF p.mutation_transaction=pg_current_xact_id() THEN
 IF NOT whaleu_safety.account_punishment_identity_current(p.actor_id,p.session_id,p.token_hash)
 OR p.identity_hash IS DISTINCT FROM whaleu_profile.moderation_hash(whaleu_profile.moderation_identity_facts(p.actor_id,p.session_id,p.token_hash))
 OR p.authority_hash IS DISTINCT FROM whaleu_safety.account_punishment_authority_hash(p.grant_id)
 OR p.protection_hash IS DISTINCT FROM whaleu_safety.account_punishment_protection_hash(p.subject_id)
 OR NOT whaleu_safety.account_punishment_unprotected(p.subject_id)
 OR NOT whaleu_safety.account_punishment_issue_cause_current(p.id)
 OR NOT EXISTS(SELECT 1 FROM whaleu_safety.account_punishment_heads h WHERE (h.subject_id,h.kind,h.punishment_id,h.revision)=(p.subject_id,p.kind,p.id,p.revision))
 OR NOT EXISTS(SELECT 1 FROM whaleu_notifications.account_punishment_notices n WHERE n.event_id=p.id AND n.punishment_id=p.id AND n.kind='account_punishment_issued' AND n.recipient_account_id=p.subject_id AND n.created_at=p.recorded_at AND n.read_at IS NULL)
 THEN RAISE EXCEPTION 'Punishment requires original current removal, subject protection, head and notice' USING ERRCODE='23514',CONSTRAINT='account_punishment_causal';END IF;
 END IF;
 SELECT * INTO t FROM whaleu_safety.account_punishment_terminals WHERE punishment_id=p.id;
 IF t.punishment_id IS NOT NULL AND t.mutation_transaction=pg_current_xact_id() THEN
 IF t.effective_at<p.starts_at OR NOT whaleu_safety.account_punishment_identity_current(t.actor_id,t.session_id,t.token_hash)
 OR t.identity_hash IS DISTINCT FROM whaleu_profile.moderation_hash(whaleu_profile.moderation_identity_facts(t.actor_id,t.session_id,t.token_hash))
 OR t.authority_hash IS DISTINCT FROM whaleu_safety.account_punishment_authority_hash(t.grant_id) THEN
 RAISE EXCEPTION 'Terminal actor evidence changed' USING ERRCODE='23514',CONSTRAINT='account_punishment_causal';END IF;
 IF t.cause='superseded' THEN
 IF NOT EXISTS(SELECT 1 FROM whaleu_safety.account_punishments n WHERE n.id=t.replacement_id AND n.subject_id=p.subject_id AND n.kind=p.kind AND n.revision=p.revision+1 AND n.starts_at=t.effective_at AND n.mutation_transaction=pg_current_xact_id()) THEN
 RAISE EXCEPTION 'Exact same-kind successor required' USING ERRCODE='23514',CONSTRAINT='account_punishment_causal';END IF;
 ELSE
 IF NOT whaleu_safety.account_punishment_admin_current(t.actor_id,t.grant_id)
 OR (p.ends_at IS NOT NULL AND (t.effective_at>=p.ends_at OR clock_timestamp()>=p.ends_at))
 OR NOT EXISTS(SELECT 1 FROM whaleu_safety.account_punishment_heads WHERE punishment_id=p.id)
 OR NOT EXISTS(SELECT 1 FROM whaleu_notifications.account_punishment_notices n WHERE n.event_id=t.event_id AND n.punishment_id=p.id AND n.kind='account_punishment_released' AND n.recipient_account_id=p.subject_id AND n.created_at=t.recorded_at AND n.read_at IS NULL)
 THEN RAISE EXCEPTION 'Exact effective release and private notice required' USING ERRCODE='23514',CONSTRAINT='account_punishment_causal';END IF;
 IF t.cause='manually_released' THEN
 SELECT to_jsonb(q) INTO c FROM whaleu_safety.account_punishment_release_commands q WHERE q.actor_id=t.actor_id AND q.request_id=t.source_request_id AND q.receipt->>'outcome'='applied' AND q.receipt->>'eventId'=t.event_id::text;
 IF c IS NULL THEN RAISE EXCEPTION 'Exact release command required' USING ERRCODE='23514',CONSTRAINT='account_punishment_causal';END IF;
 ELSE
 IF NOT whaleu_safety.validate_account_appeal_release(t.cause_id,p.id,t.event_id,t.actor_id,t.source_request_id) THEN
 RAISE EXCEPTION 'Exact appeal decision required' USING ERRCODE='23514',CONSTRAINT='account_punishment_causal';END IF;
 END IF;END IF;END IF;
END$$;
CREATE FUNCTION whaleu_safety.account_punishment_recheck() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE p record;q whaleu_safety.account_punishment_release_commands;BEGIN
 FOR p IN SELECT id FROM whaleu_safety.account_punishments WHERE mutation_transaction=pg_current_xact_id()
 UNION SELECT punishment_id FROM whaleu_safety.account_punishment_terminals WHERE mutation_transaction=pg_current_xact_id() LOOP
 PERFORM whaleu_safety.account_punishment_assert_complete(p.id);END LOOP;
 FOR q IN SELECT * FROM whaleu_safety.account_punishment_release_commands WHERE mutation_transaction=pg_current_xact_id() LOOP
 PERFORM whaleu_safety.account_punishment_release_complete(q);END LOOP;
 RETURN NULL;
END$$;
DO $$DECLARE relation text;BEGIN
 FOREACH relation IN ARRAY ARRAY['whaleu_safety.account_punishments','whaleu_safety.account_punishment_heads','whaleu_safety.account_punishment_terminals','whaleu_safety.account_punishment_release_commands',
 'whaleu_identity.accounts','whaleu_identity.sessions','whaleu_identity.access_tokens','whaleu_authorization.role_grants','whaleu_safety.account_heads','whaleu_notifications.account_punishment_notices','whaleu_notifications.system_notice_ids'] LOOP
 EXECUTE format('CREATE CONSTRAINT TRIGGER account_punishment_recheck AFTER INSERT OR UPDATE OR DELETE ON %s DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_punishment_recheck()',relation);
 END LOOP;
END$$;
CREATE FUNCTION whaleu_notifications.account_punishment_notice_guard() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE p whaleu_safety.account_punishments;t whaleu_safety.account_punishment_terminals;BEGIN
 IF TG_OP IN('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Punishment notices retained' USING ERRCODE='23514',CONSTRAINT='account_punishment_causal';END IF;
 SELECT * INTO p FROM whaleu_safety.account_punishments WHERE id=NEW.punishment_id;
 SELECT * INTO t FROM whaleu_safety.account_punishment_terminals WHERE punishment_id=NEW.punishment_id;
 IF TG_OP='UPDATE' THEN
 IF p.mutation_transaction=pg_current_xact_id() OR t.mutation_transaction=pg_current_xact_id()
 OR (to_jsonb(NEW)-'read_at') IS DISTINCT FROM (to_jsonb(OLD)-'read_at') OR NEW.read_at IS NULL
 OR (OLD.read_at IS NOT NULL AND OLD.read_at<>NEW.read_at) OR NEW.read_at>clock_timestamp() THEN
 RAISE EXCEPTION 'Only first read of committed notice may change' USING ERRCODE='23514',CONSTRAINT='account_punishment_causal';END IF;
 ELSE
 IF pg_trigger_depth()<2 OR NEW.read_at IS NOT NULL OR p.subject_id IS DISTINCT FROM NEW.recipient_account_id
 OR (NEW.kind='account_punishment_issued' AND (p.id,p.recorded_at,p.mutation_transaction) IS DISTINCT FROM (NEW.event_id,NEW.created_at,pg_current_xact_id()))
 OR (NEW.kind='account_punishment_released' AND (t.event_id,t.recorded_at,t.mutation_transaction) IS DISTINCT FROM (NEW.event_id,NEW.created_at,pg_current_xact_id())) THEN
 RAISE EXCEPTION 'Exact causal notice required' USING ERRCODE='23514',CONSTRAINT='account_punishment_causal';END IF;
 END IF;
 INSERT INTO whaleu_notifications.system_notice_owners(account_id) VALUES(NEW.recipient_account_id) ON CONFLICT DO NOTHING;
 PERFORM account_id FROM whaleu_notifications.system_notice_owners WHERE account_id=NEW.recipient_account_id FOR UPDATE;
 RETURN NEW;
END$$;
CREATE TRIGGER account_punishment_notice_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_notifications.account_punishment_notices FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.account_punishment_notice_guard();
CREATE TRIGGER account_punishment_notice_retain BEFORE TRUNCATE ON whaleu_notifications.account_punishment_notices FOR EACH STATEMENT EXECUTE FUNCTION whaleu_notifications.account_punishment_notice_guard();
CREATE TRIGGER register_system_notice_id AFTER INSERT ON whaleu_notifications.account_punishment_notices FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.register_system_notice_id();
ALTER TABLE whaleu_notifications.account_punishment_notices ADD CONSTRAINT account_punishment_notice_exact_id FOREIGN KEY(id,kind,recipient_account_id) REFERENCES whaleu_notifications.system_notice_ids(id,kind,recipient_account_id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE whaleu_safety.account_moderation_epochs (
  slot integer PRIMARY KEY CHECK (slot BETWEEN 0 AND 127),
  version integer NOT NULL CHECK (version=1),
  epoch bigint NOT NULL CHECK (epoch>=0)
);
INSERT INTO whaleu_safety.account_moderation_epochs(slot,version,epoch)
  SELECT slot,1,0 FROM generate_series(0,127) AS slot;

CREATE FUNCTION whaleu_safety.guard_account_moderation_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Only nested source statement triggers can advance this fixed metadata.
  -- Never trust a caller-controlled custom setting as a transaction claim.
  IF TG_OP<>'UPDATE' THEN
    RAISE EXCEPTION 'Count epoch metadata is retained' USING ERRCODE='23514';
  END IF;
  IF pg_trigger_depth()<2 OR NEW.slot IS DISTINCT FROM OLD.slot OR
     NEW.version IS DISTINCT FROM OLD.version OR NEW.epoch IS DISTINCT FROM OLD.epoch+1 THEN
    RAISE EXCEPTION 'Count epochs only advance through source mutations' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_account_moderation_epoch BEFORE INSERT OR UPDATE OR DELETE ON whaleu_safety.account_moderation_epochs
  FOR EACH ROW EXECUTE FUNCTION whaleu_safety.guard_account_moderation_epoch();
CREATE TRIGGER retain_account_moderation_epochs BEFORE TRUNCATE ON whaleu_safety.account_moderation_epochs
  FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.guard_account_moderation_epoch();

CREATE FUNCTION whaleu_safety.advance_account_moderation_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE chosen integer; first_slot integer; candidate integer; step integer;
BEGIN
  -- These are postmaster settings, so an in-flight transaction cannot cross a
  -- capacity change. On larger servers only optional counts are unavailable;
  -- core mutations retain their existing behavior without epoch admission.
  IF current_setting('max_connections')::integer +
     current_setting('max_prepared_transactions')::integer +
     current_setting('max_worker_processes')::integer +
     current_setting('max_wal_senders')::integer >= 128 THEN
    RETURN NULL;
  END IF;
  -- pg_locks, not a GUC or application cache, proves ownership. Advisory locks
  -- and changes below both participate in savepoint rollback.
  SELECT objid::integer INTO chosen FROM pg_locks
    WHERE locktype='advisory' AND pid=pg_backend_pid() AND granted
      AND mode='ExclusiveLock' AND classid=1464356112::oid AND objsubid=2
      AND objid BETWEEN 0::oid AND 127::oid
    ORDER BY objid LIMIT 1;
  IF chosen IS NULL THEN
    first_slot := mod(pg_current_xact_id()::text::numeric,128)::integer;
    FOR step IN 0..127 LOOP
      candidate := mod(first_slot+step,128);
      IF pg_try_advisory_xact_lock(1464356112,candidate) THEN
        chosen := candidate;
        EXIT;
      END IF;
    END LOOP;
  END IF;
  IF chosen IS NOT NULL THEN
    -- pg_locks also reports session-owned locks. Always acquire xact ownership
    -- so pg_advisory_unlock cannot release a mutation's transaction fence.
    IF NOT pg_try_advisory_xact_lock(1464356112,chosen) THEN chosen := NULL; END IF;
  END IF;
  IF chosen IS NULL THEN
    -- Fewer than128 possible writers each own at most one slot. Exhaustion can
    -- therefore only come from final readers' shared slots. The notification
    -- gate waits for those readers, never serializes source writers, and stops
    -- another finalizer from fencing the slots before this writer's retry.
    PERFORM pg_advisory_xact_lock_shared(1464356112,128);
    FOR step IN 0..127 LOOP
      candidate := mod(first_slot+step,128);
      IF pg_try_advisory_xact_lock(1464356112,candidate) THEN
        chosen := candidate;
        EXIT;
      END IF;
    END LOOP;
    IF chosen IS NULL THEN
      -- Unreachable for protocol writers under the checked server bound. This
      -- is reserved-fence misuse/corruption, not a core writer concurrency cap.
      RAISE EXCEPTION 'Reserved count fences are inconsistent' USING ERRCODE='55P03';
    END IF;
  END IF;
  -- Even an unexpected direct metadata row locker cannot add a writer wait.
  PERFORM 1 FROM whaleu_safety.account_moderation_epochs WHERE slot=chosen FOR UPDATE NOWAIT;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Count epoch metadata is incomplete' USING ERRCODE='23514';
  END IF;
  UPDATE whaleu_safety.account_moderation_epochs SET epoch=epoch+1 WHERE slot=chosen;
  RETURN NULL;
END $$;


DO $$DECLARE relation text;BEGIN
 FOREACH relation IN ARRAY ARRAY['account_punishments','account_punishment_heads','account_punishment_terminals'] LOOP
 EXECUTE format('CREATE TRIGGER a_account_moderation_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_safety.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.advance_account_moderation_epoch()',relation);
 END LOOP;
END$$;
CREATE FUNCTION whaleu_safety.account_punishment_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF EXISTS(SELECT 1 FROM whaleu_safety.account_punishments WHERE mutation_transaction=pg_current_xact_id())
 OR EXISTS(SELECT 1 FROM whaleu_safety.account_punishment_terminals WHERE mutation_transaction=pg_current_xact_id())
 OR EXISTS(SELECT 1 FROM whaleu_safety.account_punishment_release_commands WHERE mutation_transaction=pg_current_xact_id()) THEN
 RAISE EXCEPTION 'Original punishment sources cannot be rewritten after command admission' USING ERRCODE='23514',CONSTRAINT='account_punishment_causal';END IF;RETURN NULL;
END$$;
DO $$DECLARE relation text;BEGIN
 FOREACH relation IN ARRAY ARRAY['whaleu_identity.accounts','whaleu_identity.sessions','whaleu_identity.access_tokens','whaleu_authorization.role_grants','whaleu_safety.account_heads'] LOOP
 EXECUTE format('CREATE TRIGGER a00_account_punishment_source_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.account_punishment_source_guard()',relation);
 END LOOP;
END$$;
CREATE UNIQUE INDEX account_punishment_one_issue_transaction ON whaleu_safety.account_punishments(mutation_transaction);
CREATE INDEX account_punishment_terminals_transaction ON whaleu_safety.account_punishment_terminals(mutation_transaction);
CREATE UNIQUE INDEX account_punishment_one_release_transaction ON whaleu_safety.account_punishment_release_commands(mutation_transaction);
-- One observation clock for composite policy/status. A finite interval is half
-- open and every retained negative/status snapshot carries its exact boundary.
CREATE FUNCTION whaleu_safety.account_punishment_effective_at(subject uuid,selected_kind text,at timestamptz)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_safety.account_punishment_heads h
 JOIN whaleu_safety.account_punishments p ON (p.id,p.subject_id,p.kind,p.revision)=(h.punishment_id,h.subject_id,h.kind,h.revision)
 WHERE h.subject_id=subject AND h.kind=selected_kind AND p.starts_at<=at AND (p.ends_at IS NULL OR p.ends_at>at)
 AND NOT EXISTS(SELECT 1 FROM whaleu_safety.account_punishment_terminals t WHERE t.punishment_id=p.id))
$$;
CREATE OR REPLACE FUNCTION whaleu_safety.account_punishment_effective(subject uuid,selected_kind text)
RETURNS boolean LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 SELECT whaleu_safety.account_punishment_effective_at(subject,selected_kind,clock_timestamp())
$$;
CREATE FUNCTION whaleu_safety.account_punishment_policy_observation(subject uuid,action text)
RETURNS TABLE(fingerprint text,allowed boolean,suspended boolean,until text,checked_at timestamptz)
LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 WITH instant AS MATERIALIZED(SELECT clock_timestamp() at),state AS MATERIALIZED(
 SELECT instant.at,whaleu_safety.account_punishment_effective_at(subject,'access_suspension',instant.at) suspended,
 whaleu_safety.account_punishment_effective_at(subject,'interaction_mute',instant.at) muted FROM instant)
 SELECT whaleu_safety.account_punishment_fingerprint(subject),
 CASE WHEN action IN('guest','restricted_self_service') THEN true
 WHEN action NOT IN('browse','interaction','private_self_service','protective_cleanup','passive_bookkeeping','privileged_read','noncontent_management','content_management') THEN false
 WHEN state.suspended THEN false WHEN action IN('interaction','content_management') AND state.muted THEN false ELSE true END,
 state.suspended,(SELECT min(p.ends_at)::text FROM whaleu_safety.account_punishment_heads h JOIN whaleu_safety.account_punishments p ON p.id=h.punishment_id
 WHERE h.subject_id=subject AND p.starts_at<=state.at AND p.ends_at>state.at
 AND NOT EXISTS(SELECT 1 FROM whaleu_safety.account_punishment_terminals t WHERE t.punishment_id=p.id)),state.at FROM state
$$;


-- Forward-only v2 causal adapter. Historical v1 bytes and removal engine remain unchanged.
CREATE FUNCTION whaleu_community.removal_punishment_envelope_valid(command jsonb,receipt jsonb,source_kind text)
RETURNS boolean LANGUAGE plpgsql AS $$DECLARE s jsonb;r jsonb;BEGIN
 IF NOT command ? 'version' THEN RETURN NOT (receipt ? 'version' OR receipt ? 'selection' OR receipt ? 'punishment'); END IF;
 s:=command->'punishment';r:=receipt->'punishment';
 IF command->'version' IS DISTINCT FROM '2'::jsonb OR receipt->'version' IS DISTINCT FROM '2'::jsonb OR receipt->'selection' IS DISTINCT FROM s
 OR whaleu_community.post_owner_visibility_keys(s,ARRAY['kind','duration','reason','expectedRevision']) IS DISTINCT FROM true
 OR coalesce(s->>'kind' IN('interaction_mute','access_suspension'),false)=false
 OR jsonb_typeof(s->'reason') IS DISTINCT FROM 'string' OR char_length(s->>'reason') NOT BETWEEN 1 AND 255
 OR s->>'reason' IS DISTINCT FROM whaleu_profile.moderation_trim(s->>'reason')
 OR coalesce(s->>'expectedRevision' ~ '^(0|[1-9][0-9]{0,18})$',false)=false
 OR (s->>'expectedRevision')::numeric>=9223372036854775807 THEN RETURN false;END IF;
 PERFORM whaleu_safety.account_punishment_duration_end(date_trunc('milliseconds',clock_timestamp()),s->'duration',source_kind);
 IF receipt->>'outcome'='applied' THEN
  IF (receipt->>'recordedAt')::timestamptz<date_trunc('milliseconds',transaction_timestamp()) OR (receipt->>'recordedAt')::timestamptz<clock_timestamp()-interval '15 seconds' OR (receipt->>'recordedAt')::timestamptz>clock_timestamp() THEN RETURN false;END IF;
  RETURN whaleu_community.post_owner_visibility_keys(r,ARRAY['punishmentId','kind','revision'])
   AND whaleu_profile.moderation_uuid_valid(r->>'punishmentId')
   AND r->>'kind'=s->>'kind' AND r->>'revision'=((s->>'expectedRevision')::bigint+1)::text;
 END IF;
 RETURN NOT receipt ? 'punishment';
END$$;

ALTER TABLE whaleu_community.admin_post_removal_commands ADD COLUMN punishment_protection_before text;
CREATE OR REPLACE FUNCTION whaleu_community.admin_post_removal_command_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_row record;p record;identity_observed jsonb;input_observed jsonb;BEGIN
 -- V2 retains its first identity observation before request/account/content waits.
 -- V1 keeps the historical admission behavior and stored receipt bytes.
 IF NEW.command->'version'='2'::jsonb THEN
  identity_observed:=whaleu_profile.moderation_identity_facts(NEW.actor_id,NEW.session_id,NEW.token_hash);
 END IF;
 IF whaleu_community.removal_punishment_envelope_valid(NEW.command,NEW.receipt,'post') IS DISTINCT FROM true
 OR current_setting('transaction_isolation')<>'read committed' OR NEW.mutation_transaction<>pg_current_xact_id()
 OR whaleu_community.post_owner_visibility_keys(NEW.command,ARRAY['clientRequestId','target','expectedTargetVersion','action'] || CASE WHEN NEW.command ? 'version' THEN ARRAY['version','punishment'] ELSE ARRAY[]::text[] END) IS DISTINCT FROM true
 OR whaleu_community.post_owner_visibility_keys(NEW.command->'target',ARRAY['kind','id']) IS DISTINCT FROM true
 OR NOT whaleu_profile.moderation_uuid_valid(NEW.target_id::text)
 OR NEW.command->>'clientRequestId' IS DISTINCT FROM NEW.request_id::text
 OR NEW.command->'target'->>'kind' IS DISTINCT FROM 'post' OR NEW.command->'target'->>'id' IS DISTINCT FROM NEW.target_id::text
 OR NEW.command->>'action' IS DISTINCT FROM 'remove_post'
 OR (jsonb_typeof(NEW.command->'expectedTargetVersion')='string' AND NEW.command->>'expectedTargetVersion' ~ '^[a-f0-9]{64}$') IS DISTINCT FROM true
 OR NEW.receipt->>'requestId' IS DISTINCT FROM NEW.request_id::text OR NEW.receipt->'target' IS DISTINCT FROM NEW.command->'target'
 OR NEW.receipt->>'action' IS DISTINCT FROM 'remove_post' OR NEW.receipt->'expectedTargetVersion' IS DISTINCT FROM NEW.command->'expectedTargetVersion'
 OR whaleu_community.post_owner_visibility_keys(NEW.receipt,CASE WHEN NEW.receipt->>'outcome'='rejected' THEN ARRAY['requestId','target','expectedTargetVersion','action','outcome','code'] ELSE ARRAY['requestId','target','expectedTargetVersion','action','outcome','eventId','recordedAt'] END || CASE WHEN NEW.command ? 'version' THEN CASE WHEN NEW.receipt->>'outcome'='applied' THEN ARRAY['version','selection','punishment'] ELSE ARRAY['version','selection'] END ELSE ARRAY[]::text[] END) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'Strict exact administrative post-removal command required' USING ERRCODE='23514',CONSTRAINT='admin_post_removal_causal';END IF;
 IF NEW.receipt->>'outcome'='rejected' THEN
  IF coalesce(NEW.receipt->>'code' IN('ADMIN_POST_REMOVAL_STALE','ADMIN_POST_REMOVAL_CANCELLED'),false)=false THEN
   RAISE EXCEPTION 'Exact terminal administrative rejection required' USING ERRCODE='23514',CONSTRAINT='admin_post_removal_causal';END IF;
 ELSE
  IF NEW.receipt->>'outcome' IS DISTINCT FROM 'applied'
  OR (jsonb_typeof(NEW.receipt->'eventId')='string' AND whaleu_profile.moderation_uuid_valid(NEW.receipt->>'eventId')) IS DISTINCT FROM true
  OR (jsonb_typeof(NEW.receipt->'recordedAt')='string' AND (NEW.receipt->>'recordedAt')~'^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9][.][0-9]{3}Z$') IS DISTINCT FROM true
  OR (NEW.receipt->>'recordedAt')::timestamptz>clock_timestamp()
  THEN RAISE EXCEPTION 'Exact applied administrative receipt required' USING ERRCODE='23514',CONSTRAINT='admin_post_removal_causal';END IF;
 END IF;
 IF NEW.command->'version'='2'::jsonb AND NEW.receipt->>'code' IS DISTINCT FROM 'ADMIN_POST_REMOVAL_CANCELLED' THEN
  input_observed:=whaleu_community.admin_post_removal_input_facts(NEW.actor_id,NEW.grant_id,NEW.target_id);
  SELECT whaleu_safety.account_punishment_protection_hash(t.subject_id) INTO NEW.punishment_protection_before FROM whaleu_community.admin_post_removal_target(NEW.target_id) t;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:admin-post-removal-request:v1:'||NEW.actor_id::text||':'||NEW.request_id::text,0));
 PERFORM id FROM whaleu_identity.accounts WHERE id=NEW.actor_id FOR SHARE;
 PERFORM id FROM whaleu_identity.sessions WHERE id=NEW.session_id AND account_id=NEW.actor_id FOR SHARE;
 PERFORM token_hash FROM whaleu_identity.access_tokens WHERE token_hash=NEW.token_hash AND session_id=NEW.session_id FOR SHARE;
 IF NOT whaleu_profile.moderation_identity_current(NEW.actor_id,NEW.session_id,NEW.token_hash)
 OR (NEW.command->'version'='2'::jsonb AND identity_observed IS DISTINCT FROM whaleu_profile.moderation_identity_facts(NEW.actor_id,NEW.session_id,NEW.token_hash)) THEN
  RAISE EXCEPTION 'Current actor required' USING ERRCODE='23514',CONSTRAINT='admin_post_removal_causal';END IF;
 NEW.identity_hash:=whaleu_profile.moderation_hash(whaleu_profile.moderation_identity_facts(NEW.actor_id,NEW.session_id,NEW.token_hash));
 IF NEW.receipt->>'code'='ADMIN_POST_REMOVAL_CANCELLED' THEN
  IF NEW.grant_id IS NOT NULL THEN RAISE EXCEPTION 'Cancellation contains original key only' USING ERRCODE='23514',CONSTRAINT='admin_post_removal_causal';END IF;
  NEW.subject_id:=NULL;NEW.original_region_id:=NULL;NEW.input_hash:=NULL;NEW.input_before:=NULL;
  NEW.before_hash:=NULL;NEW.before_fingerprint:=NULL;NEW.unchanged_hash:=NULL;NEW.before_target_version:=NULL;
  RETURN NEW;
 END IF;
 IF current_setting('max_connections')::integer+current_setting('max_prepared_transactions')::integer+current_setting('max_worker_processes')::integer+current_setting('max_wal_senders')::integer>=128
 OR NOT (SELECT count(*)=128 AND min(slot)=0 AND max(slot)=127 AND bool_and(version=1) FROM whaleu_community.discovery_count_epochs)
 OR NOT (SELECT count(*)=128 AND min(slot)=0 AND max(slot)=127 AND bool_and(version=1) FROM whaleu_safety.discovery_count_epochs)
 OR NOT (SELECT count(*)=128 AND min(slot)=0 AND max(slot)=127 AND bool_and(version=1) FROM whaleu_campus.discovery_count_epochs)
 OR NOT whaleu_community.admin_post_removal_inventory_current()
 THEN RAISE EXCEPTION 'Complete bounded administrative input inventory required' USING ERRCODE='23514',CONSTRAINT='admin_post_removal_causal';END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('whaleu:named-block-policy:v1',0));
 PERFORM id FROM whaleu_community.posts WHERE id=NEW.target_id FOR UPDATE;
 SELECT * INTO target_row FROM whaleu_community.admin_post_removal_target(NEW.target_id);
 IF target_row.subject_id IS NULL OR target_row.subject_id=NEW.actor_id THEN
  RAISE EXCEPTION 'Another author original regional post required' USING ERRCODE='23514',CONSTRAINT='admin_post_removal_causal';END IF;
 PERFORM id FROM whaleu_authorization.role_grants WHERE id=NEW.grant_id FOR SHARE;
 IF NOT whaleu_profile.moderation_grant_allowed(NEW.actor_id,NEW.grant_id,target_row.region_id)
 OR NOT whaleu_community.admin_post_removal_supported(NEW.actor_id,NEW.target_id,false)
 OR NOT whaleu_profile.moderation_actor_current(NEW.actor_id,clock_timestamp())
 THEN RAISE EXCEPTION 'Current scoped administrative authority required' USING ERRCODE='23514',CONSTRAINT='admin_post_removal_causal';END IF;
 SELECT * INTO p FROM whaleu_community.posts WHERE id=NEW.target_id;
 NEW.subject_id:=target_row.subject_id;NEW.original_region_id:=target_row.region_id;
 NEW.before_target_version:=whaleu_community.admin_post_removal_target_version(NEW.target_id);
 IF (NEW.receipt->>'outcome'='applied' AND NEW.before_target_version IS DISTINCT FROM NEW.command->>'expectedTargetVersion')
 OR (NEW.receipt->>'code'='ADMIN_POST_REMOVAL_STALE' AND NEW.before_target_version IS NOT DISTINCT FROM NEW.command->>'expectedTargetVersion')
 THEN RAISE EXCEPTION 'Exact post source CAS required' USING ERRCODE='23514',CONSTRAINT='admin_post_removal_causal';END IF;
 NEW.before_hash:=whaleu_profile.moderation_hash(to_jsonb(p));
 NEW.before_fingerprint:=whaleu_community.admin_post_removal_post_fingerprint(NEW.target_id);
 NEW.unchanged_hash:=whaleu_profile.moderation_hash(to_jsonb(p)-ARRAY['deleted_at','local_deletion_transaction']);
 NEW.input_before:=whaleu_community.admin_post_removal_input_facts(NEW.actor_id,NEW.grant_id,NEW.target_id);
 IF NEW.command->'version'='2'::jsonb AND NEW.input_before IS DISTINCT FROM input_observed THEN
  RAISE EXCEPTION 'Original pre-wait post inputs required' USING ERRCODE='23514',CONSTRAINT='admin_post_removal_causal';END IF;
 NEW.input_hash:=whaleu_profile.moderation_hash(NEW.input_before);
 IF NEW.command->'version'='2'::jsonb AND (NEW.punishment_protection_before IS DISTINCT FROM whaleu_safety.account_punishment_protection_hash(NEW.subject_id)
 OR NOT whaleu_safety.account_punishment_unprotected(NEW.subject_id)) THEN
 RAISE EXCEPTION 'Original unprotected source author required' USING ERRCODE='23514',CONSTRAINT='account_punishment_causal';END IF;
 RETURN NEW;
END$$;
DO $$DECLARE c record;BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='whaleu_community.admin_post_removal_commands'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%intent_hash%' LOOP
 EXECUTE format('ALTER TABLE whaleu_community.admin_post_removal_commands DROP CONSTRAINT %I',c.conname);END LOOP;
END$$;
ALTER TABLE whaleu_community.admin_post_removal_commands ADD CONSTRAINT admin_post_removal_versioned_intent CHECK(
 intent_hash=encode(sha256(convert_to('whaleu:admin-post-removal-command:v'||CASE WHEN command ? 'version' THEN '2' ELSE '1' END||chr(10)||whaleu_community.content_canonical_json(jsonb_build_object('actor',actor_id::text,'command',command)),'UTF8')),'hex'));
CREATE FUNCTION whaleu_community.admin_post_removal_issue_punishment() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.command->'version'='2'::jsonb AND NEW.receipt->>'outcome'='applied' THEN
  PERFORM whaleu_safety.issue_account_punishment(NEW.actor_id,NEW.request_id,'post',NEW.target_id);
 END IF;RETURN NULL;
END$$;
CREATE TRIGGER admin_post_removal_issue_punishment AFTER INSERT ON whaleu_community.admin_post_removal_commands FOR EACH ROW EXECUTE FUNCTION whaleu_community.admin_post_removal_issue_punishment();

ALTER TABLE whaleu_community.admin_discussion_removal_commands ADD COLUMN punishment_protection_before text;
CREATE OR REPLACE FUNCTION whaleu_community.admin_discussion_removal_command_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_row record;p record;identity_observed jsonb;input_observed jsonb;BEGIN
 identity_observed:=whaleu_profile.moderation_identity_facts(NEW.actor_id,NEW.session_id,NEW.token_hash);
 IF whaleu_community.removal_punishment_envelope_valid(NEW.command,NEW.receipt,NEW.target_kind) IS DISTINCT FROM true
 OR current_setting('transaction_isolation')<>'read committed' OR NEW.mutation_transaction<>pg_current_xact_id()
 OR whaleu_community.post_owner_visibility_keys(NEW.command,ARRAY['clientRequestId','target','expectedTargetVersion','action'] || CASE WHEN NEW.command ? 'version' THEN ARRAY['version','punishment'] ELSE ARRAY[]::text[] END) IS DISTINCT FROM true
 OR whaleu_community.post_owner_visibility_keys(NEW.command->'target',ARRAY['kind','id']) IS DISTINCT FROM true
 OR NOT whaleu_profile.moderation_uuid_valid(NEW.target_id::text)
 OR NEW.command->>'clientRequestId' IS DISTINCT FROM NEW.request_id::text
 OR NEW.command->'target'->>'kind' IS DISTINCT FROM NEW.target_kind OR NEW.command->'target'->>'id' IS DISTINCT FROM NEW.target_id::text
 OR NEW.command->>'action' IS DISTINCT FROM 'remove_discussion'
 OR (jsonb_typeof(NEW.command->'expectedTargetVersion')='string' AND NEW.command->>'expectedTargetVersion' ~ '^[a-f0-9]{64}$') IS DISTINCT FROM true
 OR NEW.receipt->>'requestId' IS DISTINCT FROM NEW.request_id::text OR NEW.receipt->'target' IS DISTINCT FROM NEW.command->'target'
 OR NEW.receipt->>'action' IS DISTINCT FROM 'remove_discussion' OR NEW.receipt->'expectedTargetVersion' IS DISTINCT FROM NEW.command->'expectedTargetVersion'
 OR whaleu_community.post_owner_visibility_keys(NEW.receipt,CASE WHEN NEW.receipt->>'outcome'='rejected' THEN ARRAY['requestId','target','expectedTargetVersion','action','outcome','code'] ELSE ARRAY['requestId','target','expectedTargetVersion','action','outcome','eventId','recordedAt'] END || CASE WHEN NEW.command ? 'version' THEN CASE WHEN NEW.receipt->>'outcome'='applied' THEN ARRAY['version','selection','punishment'] ELSE ARRAY['version','selection'] END ELSE ARRAY[]::text[] END) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'Strict exact administrative discussion-removal command required' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
 IF NEW.receipt->>'outcome'='rejected' THEN
  IF coalesce(NEW.receipt->>'code' IN('ADMIN_DISCUSSION_REMOVAL_STALE','ADMIN_DISCUSSION_REMOVAL_CANCELLED'),false)=false THEN
   RAISE EXCEPTION 'Exact terminal administrative rejection required' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
 ELSE
  IF NEW.receipt->>'outcome' IS DISTINCT FROM 'applied'
  OR (jsonb_typeof(NEW.receipt->'eventId')='string' AND whaleu_profile.moderation_uuid_valid(NEW.receipt->>'eventId')) IS DISTINCT FROM true
  OR (jsonb_typeof(NEW.receipt->'recordedAt')='string' AND (NEW.receipt->>'recordedAt')~'^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9][.][0-9]{3}Z$') IS DISTINCT FROM true
  OR (NEW.receipt->>'recordedAt')::timestamptz>clock_timestamp()
  THEN RAISE EXCEPTION 'Exact applied administrative receipt required' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
 END IF;
 IF NEW.receipt->>'code' IS DISTINCT FROM 'ADMIN_DISCUSSION_REMOVAL_CANCELLED' THEN
  input_observed:=whaleu_community.admin_discussion_removal_input_facts(NEW.actor_id,NEW.grant_id,NEW.target_kind,NEW.target_id);
 END IF;
 IF NEW.command->'version'='2'::jsonb AND NEW.receipt->>'code' IS DISTINCT FROM 'ADMIN_DISCUSSION_REMOVAL_CANCELLED' THEN
  SELECT whaleu_safety.account_punishment_protection_hash(t.subject_id) INTO NEW.punishment_protection_before FROM whaleu_community.admin_discussion_removal_target(NEW.target_kind,NEW.target_id) t;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:admin-discussion-removal-request:v1:'||NEW.actor_id::text||':'||NEW.request_id::text,0));
 PERFORM id FROM whaleu_identity.accounts WHERE id=NEW.actor_id FOR SHARE;
 PERFORM id FROM whaleu_identity.sessions WHERE id=NEW.session_id AND account_id=NEW.actor_id FOR SHARE;
 PERFORM token_hash FROM whaleu_identity.access_tokens WHERE token_hash=NEW.token_hash AND session_id=NEW.session_id FOR SHARE;
 IF NOT whaleu_profile.moderation_identity_current(NEW.actor_id,NEW.session_id,NEW.token_hash)
 OR identity_observed IS DISTINCT FROM whaleu_profile.moderation_identity_facts(NEW.actor_id,NEW.session_id,NEW.token_hash) THEN
  RAISE EXCEPTION 'Current actor required' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
 NEW.identity_hash:=whaleu_profile.moderation_hash(whaleu_profile.moderation_identity_facts(NEW.actor_id,NEW.session_id,NEW.token_hash));
 IF NEW.receipt->>'code'='ADMIN_DISCUSSION_REMOVAL_CANCELLED' THEN
  IF NEW.grant_id IS NOT NULL THEN RAISE EXCEPTION 'Cancellation contains original key only' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
  NEW.subject_id:=NULL;NEW.post_id:=NULL;NEW.root_id:=NULL;NEW.original_region_id:=NULL;NEW.pin_before:=NULL;NEW.input_hash:=NULL;NEW.input_before:=NULL;
  NEW.before_hash:=NULL;NEW.before_fingerprint:=NULL;NEW.unchanged_hash:=NULL;NEW.before_target_version:=NULL;
  RETURN NEW;
 END IF;
 IF current_setting('max_connections')::integer+current_setting('max_prepared_transactions')::integer+current_setting('max_worker_processes')::integer+current_setting('max_wal_senders')::integer>=128
 OR NOT (SELECT count(*)=128 AND min(slot)=0 AND max(slot)=127 AND bool_and(version=1) FROM whaleu_community.discovery_count_epochs)
 OR NOT (SELECT count(*)=128 AND min(slot)=0 AND max(slot)=127 AND bool_and(version=1) FROM whaleu_safety.discovery_count_epochs)
 OR NOT (SELECT count(*)=128 AND min(slot)=0 AND max(slot)=127 AND bool_and(version=1) FROM whaleu_campus.discovery_count_epochs)
 OR NOT whaleu_community.admin_discussion_removal_inventory_current()
 THEN RAISE EXCEPTION 'Complete bounded administrative input inventory required' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('whaleu:named-block-policy:v1',0));
 SELECT * INTO target_row FROM whaleu_community.admin_discussion_removal_target(NEW.target_kind,NEW.target_id);
 PERFORM id FROM whaleu_community.posts WHERE id=target_row.post_id FOR UPDATE;
 PERFORM id FROM whaleu_community.root_comments WHERE id=target_row.root_id AND post_id=target_row.post_id FOR UPDATE;
 IF NEW.target_kind='reply' THEN
  PERFORM id FROM whaleu_community.replies WHERE id=NEW.target_id AND post_id=target_row.post_id AND root_comment_id=target_row.root_id FOR UPDATE;
 END IF;
 SELECT * INTO target_row FROM whaleu_community.admin_discussion_removal_target(NEW.target_kind,NEW.target_id);
 IF target_row.subject_id IS NULL OR target_row.subject_id=NEW.actor_id THEN
  RAISE EXCEPTION 'Another author original regional discussion required' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
 PERFORM id FROM whaleu_authorization.role_grants WHERE id=NEW.grant_id FOR SHARE;
 IF NOT whaleu_profile.moderation_grant_allowed(NEW.actor_id,NEW.grant_id,target_row.region_id)
 OR NOT whaleu_community.admin_discussion_removal_supported(NEW.actor_id,NEW.target_kind,NEW.target_id,false)
 OR NOT whaleu_profile.moderation_actor_current(NEW.actor_id,clock_timestamp())
 THEN RAISE EXCEPTION 'Current scoped administrative authority required' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
 SELECT payload INTO p FROM whaleu_community.profile_moderation_nodes(NEW.target_kind,NEW.target_id) WHERE kind=NEW.target_kind AND id=NEW.target_id;
 NEW.subject_id:=target_row.subject_id;NEW.post_id:=target_row.post_id;NEW.root_id:=target_row.root_id;NEW.original_region_id:=target_row.region_id;
 NEW.before_target_version:=whaleu_community.admin_discussion_removal_target_version(NEW.target_kind,NEW.target_id);
 IF (NEW.receipt->>'outcome'='applied' AND NEW.before_target_version IS DISTINCT FROM NEW.command->>'expectedTargetVersion')
 OR (NEW.receipt->>'code'='ADMIN_DISCUSSION_REMOVAL_STALE' AND NEW.before_target_version IS NOT DISTINCT FROM NEW.command->>'expectedTargetVersion')
 THEN RAISE EXCEPTION 'Exact discussion source CAS required' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
 NEW.before_hash:=whaleu_profile.moderation_hash(p.payload);
 NEW.before_fingerprint:=whaleu_community.admin_discussion_removal_node_fingerprint(NEW.target_kind,NEW.target_id);
 NEW.unchanged_hash:=whaleu_profile.moderation_hash(p.payload-ARRAY['deleted_at','local_deletion_transaction']);
 NEW.input_before:=whaleu_community.admin_discussion_removal_input_facts(NEW.actor_id,NEW.grant_id,NEW.target_kind,NEW.target_id);
 IF NEW.input_before IS DISTINCT FROM input_observed THEN
  RAISE EXCEPTION 'Original pre-wait discussion inputs required' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
 IF NEW.target_kind='comment' THEN
  SELECT jsonb_build_array(to_jsonb(pin),pin.xmin::text,pin.ctid::text) INTO NEW.pin_before
  FROM whaleu_community.comment_pins pin WHERE pin.post_id=NEW.post_id AND pin.comment_id=NEW.target_id;
 END IF;
 NEW.input_hash:=whaleu_profile.moderation_hash(NEW.input_before);
 IF NEW.command->'version'='2'::jsonb AND (NEW.punishment_protection_before IS DISTINCT FROM whaleu_safety.account_punishment_protection_hash(NEW.subject_id)
 OR NOT whaleu_safety.account_punishment_unprotected(NEW.subject_id)) THEN
 RAISE EXCEPTION 'Original unprotected source author required' USING ERRCODE='23514',CONSTRAINT='account_punishment_causal';END IF;
 RETURN NEW;
END$$;
DO $$DECLARE c record;BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='whaleu_community.admin_discussion_removal_commands'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%intent_hash%' LOOP
 EXECUTE format('ALTER TABLE whaleu_community.admin_discussion_removal_commands DROP CONSTRAINT %I',c.conname);END LOOP;
END$$;
ALTER TABLE whaleu_community.admin_discussion_removal_commands ADD CONSTRAINT admin_discussion_removal_versioned_intent CHECK(
 intent_hash=encode(sha256(convert_to('whaleu:admin-discussion-removal-command:v'||CASE WHEN command ? 'version' THEN '2' ELSE '1' END||chr(10)||whaleu_community.content_canonical_json(jsonb_build_object('actor',actor_id::text,'command',command)),'UTF8')),'hex'));
CREATE FUNCTION whaleu_community.admin_discussion_removal_issue_punishment() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.command->'version'='2'::jsonb AND NEW.receipt->>'outcome'='applied' THEN
  PERFORM whaleu_safety.issue_account_punishment(NEW.actor_id,NEW.request_id,NEW.target_kind,NEW.target_id);
 END IF;RETURN NULL;
END$$;
CREATE TRIGGER admin_discussion_removal_issue_punishment AFTER INSERT ON whaleu_community.admin_discussion_removal_commands FOR EACH ROW EXECUTE FUNCTION whaleu_community.admin_discussion_removal_issue_punishment();

CREATE OR REPLACE FUNCTION whaleu_safety.account_punishment_issue_context(actor uuid,request uuid,source_kind text,source_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$DECLARE q record;BEGIN
 IF source_kind='post' THEN
  SELECT * INTO q FROM whaleu_community.admin_post_removal_commands c WHERE c.actor_id=actor AND c.request_id=request AND c.target_id=source_id;
 ELSIF source_kind IN('comment','reply') THEN
  SELECT * INTO q FROM whaleu_community.admin_discussion_removal_commands c WHERE c.actor_id=actor AND c.request_id=request AND c.target_kind=source_kind AND c.target_id=source_id;
 ELSE RETURN NULL;END IF;
 IF q.request_id IS NULL OR q.mutation_transaction<>pg_current_xact_id() OR q.command->'version' IS DISTINCT FROM '2'::jsonb
 OR q.receipt->>'outcome' IS DISTINCT FROM 'applied'
 OR q.punishment_protection_before IS DISTINCT FROM whaleu_safety.account_punishment_protection_hash(q.subject_id)
 OR whaleu_community.removal_punishment_envelope_valid(q.command,q.receipt,source_kind) IS DISTINCT FROM true THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('punishmentId',q.receipt->'punishment'->>'punishmentId','subjectId',q.subject_id,'grantId',q.grant_id,
 'sessionId',q.session_id,'tokenHash',q.token_hash,'recordedAt',q.receipt->>'recordedAt','sourceEventId',q.receipt->>'eventId','selection',q.command->'punishment');
END$$;

CREATE TABLE whaleu_notifications.admin_discussion_removal_notices (
 id uuid PRIMARY KEY,event_id uuid NOT NULL UNIQUE REFERENCES whaleu_community.admin_discussion_removal_events(id),
 recipient_account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 kind text NOT NULL DEFAULT 'admin_discussion_removed' CHECK(kind='admin_discussion_removed'),
 created_at timestamptz NOT NULL CHECK(isfinite(created_at) AND created_at=date_trunc('milliseconds',created_at)),read_at timestamptz,
 CHECK(read_at IS NULL OR (isfinite(read_at) AND read_at>=created_at AND read_at=date_trunc('milliseconds',read_at)))
);
CREATE INDEX admin_discussion_removal_notice_page ON whaleu_notifications.admin_discussion_removal_notices(recipient_account_id,created_at DESC,id DESC);
CREATE INDEX admin_discussion_removal_notice_unread ON whaleu_notifications.admin_discussion_removal_notices(recipient_account_id) WHERE read_at IS NULL;

CREATE FUNCTION whaleu_notifications.admin_discussion_removal_notice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e record;BEGIN
 IF TG_OP IN('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Administrative discussion-removal notice retained' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
 IF TG_OP='UPDATE' THEN
  SELECT * INTO e FROM whaleu_community.admin_discussion_removal_events WHERE id=OLD.event_id;
  IF e.mutation_transaction=pg_current_xact_id() THEN RAISE EXCEPTION 'New administrative notice must commit unread' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
  IF (to_jsonb(NEW)-'read_at') IS DISTINCT FROM (to_jsonb(OLD)-'read_at') OR NEW.read_at IS NULL OR (OLD.read_at IS NOT NULL AND NEW.read_at<>OLD.read_at) OR NEW.read_at>clock_timestamp()
  THEN RAISE EXCEPTION 'Only the first owner read timestamp can change' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
 ELSE
  SELECT * INTO e FROM whaleu_community.admin_discussion_removal_events WHERE id=NEW.event_id;
  IF NOT EXISTS(SELECT 1 FROM whaleu_community.admin_discussion_removal_commands c WHERE (c.actor_id,c.request_id)=(e.actor_id,e.request_id) AND c.command->'version'='2'::jsonb AND c.receipt->>'outcome'='applied') OR e.id IS NULL OR e.mutation_transaction<>pg_current_xact_id() OR (NEW.recipient_account_id,NEW.created_at) IS DISTINCT FROM (e.subject_id,e.recorded_at) OR NEW.read_at IS NOT NULL
  THEN RAISE EXCEPTION 'Administrative notice requires same-transaction exact event' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
 END IF;
 INSERT INTO whaleu_notifications.system_notice_owners(account_id) VALUES(NEW.recipient_account_id) ON CONFLICT DO NOTHING;
 PERFORM account_id FROM whaleu_notifications.system_notice_owners WHERE account_id=NEW.recipient_account_id FOR UPDATE;
 RETURN NEW;
END$$;
CREATE TRIGGER admin_discussion_removal_notice_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_notifications.admin_discussion_removal_notices FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.admin_discussion_removal_notice_guard();
CREATE TRIGGER admin_discussion_removal_notice_retain BEFORE TRUNCATE ON whaleu_notifications.admin_discussion_removal_notices FOR EACH STATEMENT EXECUTE FUNCTION whaleu_notifications.admin_discussion_removal_notice_guard();

CREATE TRIGGER register_system_notice_id AFTER INSERT ON whaleu_notifications.admin_discussion_removal_notices FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.register_system_notice_id();
ALTER TABLE whaleu_notifications.admin_discussion_removal_notices ADD CONSTRAINT admin_discussion_removal_notice_exact_id FOREIGN KEY(id,kind,recipient_account_id) REFERENCES whaleu_notifications.system_notice_ids(id,kind,recipient_account_id) DEFERRABLE INITIALLY DEFERRED;
CREATE OR REPLACE FUNCTION whaleu_safety.account_punishment_issue_cause_current(punishment_id uuid)
RETURNS boolean LANGUAGE plpgsql AS $$DECLARE p whaleu_safety.account_punishments;c jsonb;qp whaleu_community.admin_post_removal_commands;qd whaleu_community.admin_discussion_removal_commands;BEGIN
 SELECT * INTO p FROM whaleu_safety.account_punishments WHERE id=punishment_id;
 IF p.id IS NULL OR p.mutation_transaction<>pg_current_xact_id() THEN RETURN false;END IF;
 c:=whaleu_safety.account_punishment_issue_context(p.actor_id,p.request_id,p.source_kind,p.source_id);
 IF c IS NULL OR c->>'punishmentId' IS DISTINCT FROM p.id::text OR c->>'subjectId' IS DISTINCT FROM p.subject_id::text
 OR c->>'grantId' IS DISTINCT FROM p.grant_id::text OR c->>'sessionId' IS DISTINCT FROM p.session_id::text OR c->>'tokenHash' IS DISTINCT FROM p.token_hash
 OR c->>'sourceEventId' IS DISTINCT FROM p.source_event_id::text OR (c->>'recordedAt')::timestamptz IS DISTINCT FROM p.recorded_at
 OR c->'selection' IS DISTINCT FROM jsonb_build_object('kind',p.kind,'duration',p.duration,'reason',p.reason,'expectedRevision',p.expected_revision::text) THEN RETURN false;END IF;
 IF p.source_kind='post' THEN
  SELECT * INTO qp FROM whaleu_community.admin_post_removal_commands WHERE actor_id=p.actor_id AND request_id=p.request_id;
  PERFORM whaleu_community.admin_post_removal_assert_complete(qp);
 ELSE
  SELECT * INTO qd FROM whaleu_community.admin_discussion_removal_commands WHERE actor_id=p.actor_id AND request_id=p.request_id;
  PERFORM whaleu_community.admin_discussion_removal_assert_complete(qd);
  IF NOT EXISTS(SELECT 1 FROM whaleu_notifications.admin_discussion_removal_notices n
   JOIN whaleu_notifications.system_notice_ids i ON (i.id,i.kind,i.recipient_account_id)=(n.id,n.kind,n.recipient_account_id)
   WHERE n.event_id=p.source_event_id AND n.recipient_account_id=p.subject_id AND n.created_at=p.recorded_at AND n.read_at IS NULL) THEN RETURN false;END IF;
 END IF;
 RETURN true;
END$$;

-- A v2 command may append only its two private notices through their genuine
-- trigger chains. No generic notification/owner-table exemption is admitted.
CREATE FUNCTION whaleu_community.admin_discussion_removal_notice_window(q whaleu_community.admin_discussion_removal_commands,relation_name text)
RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$DECLARE p whaleu_safety.account_punishments;event_ready boolean;issue_pending boolean;deletion_pending boolean;BEGIN
 IF q.mutation_transaction<>pg_current_xact_id() OR q.command->'version' IS DISTINCT FROM '2'::jsonb OR q.receipt->>'outcome' IS DISTINCT FROM 'applied' THEN RETURN false;END IF;
 SELECT * INTO p FROM whaleu_safety.account_punishments WHERE id=(q.receipt->'punishment'->>'punishmentId')::uuid;
 IF p.id IS NULL OR (p.actor_id,p.request_id,p.subject_id,p.source_kind,p.source_id,p.source_event_id,p.mutation_transaction,p.recorded_at)
 IS DISTINCT FROM (q.actor_id,q.request_id,q.subject_id,q.target_kind,q.target_id,(q.receipt->>'eventId')::uuid,pg_current_xact_id(),(q.receipt->>'recordedAt')::timestamptz)
 OR q.command->'punishment' IS DISTINCT FROM jsonb_build_object('kind',p.kind,'duration',p.duration,'reason',p.reason,'expectedRevision',p.expected_revision::text)
 THEN RETURN false;END IF;
 SELECT EXISTS(SELECT 1 FROM whaleu_community.admin_discussion_removal_events e WHERE (e.id,e.actor_id,e.request_id,e.subject_id,e.target_kind,e.target_id,e.recorded_at,e.mutation_transaction)
 = (p.source_event_id,q.actor_id,q.request_id,q.subject_id,q.target_kind,q.target_id,p.recorded_at,pg_current_xact_id())) INTO event_ready;
 issue_pending:=NOT EXISTS(SELECT 1 FROM whaleu_notifications.account_punishment_notices n WHERE n.event_id=p.id);
 deletion_pending:=event_ready AND NOT EXISTS(SELECT 1 FROM whaleu_notifications.admin_discussion_removal_notices n WHERE n.event_id=p.source_event_id);
 IF relation_name='system_notice_owners' THEN RETURN issue_pending OR deletion_pending;END IF;
 IF relation_name='account_punishment_notices' THEN RETURN issue_pending;END IF;
 IF relation_name='admin_discussion_removal_notices' THEN RETURN deletion_pending;END IF;
 IF relation_name='system_notice_ids' THEN RETURN EXISTS(
  SELECT 1 FROM whaleu_notifications.account_punishment_notices n WHERE (n.event_id,n.punishment_id,n.recipient_account_id,n.kind,n.created_at)=(p.id,p.id,q.subject_id,'account_punishment_issued'::text,p.recorded_at)
   AND n.read_at IS NULL AND NOT EXISTS(SELECT 1 FROM whaleu_notifications.system_notice_ids i WHERE i.id=n.id)
  UNION ALL
  SELECT 1 FROM whaleu_notifications.admin_discussion_removal_notices n WHERE event_ready AND (n.event_id,n.recipient_account_id,n.created_at)=(p.source_event_id,q.subject_id,p.recorded_at)
   AND n.read_at IS NULL AND NOT EXISTS(SELECT 1 FROM whaleu_notifications.system_notice_ids i WHERE i.id=n.id));END IF;
 RETURN false;
END$$;

CREATE OR REPLACE FUNCTION whaleu_community.admin_discussion_removal_source_statement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_community.admin_discussion_removal_commands;BEGIN
 FOR q IN SELECT * FROM whaleu_community.admin_discussion_removal_commands WHERE mutation_transaction=pg_current_xact_id() LOOP
  IF q.receipt->>'outcome' IS DISTINCT FROM 'applied' THEN
   RAISE EXCEPTION 'Rejected discussion removal is read-only' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';
  ELSIF TG_TABLE_SCHEMA='whaleu_community' AND TG_TABLE_NAME=(CASE q.target_kind WHEN 'comment' THEN 'root_comments' ELSE 'replies' END) AND TG_OP='UPDATE' THEN
   INSERT INTO whaleu_community.admin_discussion_removal_statements(actor_id,request_id) VALUES(q.actor_id,q.request_id);
  ELSIF TG_TABLE_SCHEMA='whaleu_post_hotness' AND TG_TABLE_NAME='comment_sources' AND TG_OP='INSERT' AND pg_trigger_depth()=2
   AND EXISTS(SELECT 1 FROM whaleu_community.admin_discussion_removal_transitions t WHERE (t.actor_id,t.request_id)=(q.actor_id,q.request_id))
   AND NOT EXISTS(SELECT 1 FROM whaleu_community.admin_discussion_removal_components c WHERE (c.actor_id,c.request_id)=(q.actor_id,q.request_id)) THEN
   NULL;
  ELSIF TG_TABLE_SCHEMA='whaleu_notifications' AND TG_OP='INSERT' AND pg_trigger_depth()>=2
   AND whaleu_community.admin_discussion_removal_notice_window(q,TG_TABLE_NAME) IS TRUE THEN
   NULL;
  ELSE RAISE EXCEPTION 'Only selected child, canonical component and exact nested v2 notices allowed' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
 END LOOP;RETURN NULL;
END$$;
-- Row-level checks bind the statement window to the actual recipient and cause,
-- including INSERT ON CONFLICT attempts on an already existing notice owner.
CREATE FUNCTION whaleu_community.admin_discussion_removal_notice_row_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_community.admin_discussion_removal_commands;payload jsonb;exact_row boolean;BEGIN
 payload:=to_jsonb(NEW);
 FOR q IN SELECT * FROM whaleu_community.admin_discussion_removal_commands WHERE mutation_transaction=pg_current_xact_id() LOOP
  IF TG_OP<>'INSERT' OR pg_trigger_depth()<2 OR whaleu_community.admin_discussion_removal_notice_window(q,TG_TABLE_NAME) IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'Only exact nested v2 notice rows allowed' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
  exact_row:=false;
  IF TG_TABLE_NAME='system_notice_owners' THEN exact_row:=payload->>'account_id'=q.subject_id::text;
  ELSIF TG_TABLE_NAME='account_punishment_notices' THEN
   exact_row:=payload->>'recipient_account_id'=q.subject_id::text AND payload->>'kind'='account_punishment_issued'
    AND payload->>'event_id'=q.receipt->'punishment'->>'punishmentId' AND payload->>'punishment_id'=q.receipt->'punishment'->>'punishmentId'
    AND (payload->>'created_at')::timestamptz=(q.receipt->>'recordedAt')::timestamptz AND payload->>'read_at' IS NULL;
  ELSIF TG_TABLE_NAME='admin_discussion_removal_notices' THEN
   exact_row:=payload->>'recipient_account_id'=q.subject_id::text AND payload->>'kind'='admin_discussion_removed'
    AND payload->>'event_id'=q.receipt->>'eventId' AND (payload->>'created_at')::timestamptz=(q.receipt->>'recordedAt')::timestamptz AND payload->>'read_at' IS NULL;
  ELSIF TG_TABLE_NAME='system_notice_ids' THEN
   exact_row:=payload->>'recipient_account_id'=q.subject_id::text AND (
    (payload->>'kind'='account_punishment_issued' AND EXISTS(SELECT 1 FROM whaleu_notifications.account_punishment_notices n
      WHERE n.id::text=payload->>'id' AND n.event_id::text=q.receipt->'punishment'->>'punishmentId' AND n.punishment_id=n.event_id AND n.recipient_account_id=q.subject_id AND n.kind='account_punishment_issued' AND n.read_at IS NULL))
    OR (payload->>'kind'='admin_discussion_removed' AND EXISTS(SELECT 1 FROM whaleu_notifications.admin_discussion_removal_notices n
      WHERE n.id::text=payload->>'id' AND n.event_id::text=q.receipt->>'eventId' AND n.recipient_account_id=q.subject_id AND n.read_at IS NULL)));
  END IF;
  IF exact_row IS DISTINCT FROM true THEN RAISE EXCEPTION 'Notice recipient and cause must match original selected discussion command' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;
 RETURN NEW;
END$$;
DO $$DECLARE relation_name text;BEGIN
 FOREACH relation_name IN ARRAY ARRAY['system_notice_owners','system_notice_ids','account_punishment_notices','admin_discussion_removal_notices'] LOOP
  EXECUTE format('CREATE TRIGGER a00_admin_discussion_removal_notice_row BEFORE INSERT OR UPDATE OR DELETE ON whaleu_notifications.%I FOR EACH ROW EXECUTE FUNCTION whaleu_community.admin_discussion_removal_notice_row_guard()',relation_name);
 END LOOP;
 -- These tables postdate the original source inventory. The two preexisting
 -- shared notification relations already carry the unchanged statement trigger.
 FOREACH relation_name IN ARRAY ARRAY['account_punishment_notices','admin_discussion_removal_notices'] LOOP
  EXECUTE format('CREATE TRIGGER a00_admin_discussion_removal_source_statement BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_notifications.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.admin_discussion_removal_source_statement_guard()',relation_name);
 END LOOP;
END$$;
CREATE FUNCTION whaleu_community.admin_discussion_removal_append_notice() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_community.admin_discussion_removal_commands;BEGIN
 SELECT * INTO q FROM whaleu_community.admin_discussion_removal_commands WHERE actor_id=NEW.actor_id AND request_id=NEW.request_id;
 IF q.command->'version'='2'::jsonb THEN
  IF q.receipt->>'outcome' IS DISTINCT FROM 'applied' OR q.receipt->>'eventId' IS DISTINCT FROM NEW.id::text
   OR q.subject_id IS DISTINCT FROM NEW.subject_id OR q.mutation_transaction<>pg_current_xact_id() OR NEW.mutation_transaction<>pg_current_xact_id()
   THEN RAISE EXCEPTION 'Exact v2 removal event required for author notice' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
  INSERT INTO whaleu_notifications.admin_discussion_removal_notices(id,event_id,recipient_account_id,created_at)
   VALUES(gen_random_uuid(),NEW.id,NEW.subject_id,NEW.recorded_at);
 END IF;RETURN NULL;
END$$;
CREATE TRIGGER admin_discussion_removal_append_notice AFTER INSERT ON whaleu_community.admin_discussion_removal_events FOR EACH ROW EXECUTE FUNCTION whaleu_community.admin_discussion_removal_append_notice();


-- Private, punishment-bound appeals. No public feedback, publication eligibility,
-- provider, campus, anonymous identity, or contact-data dependency.
CREATE TABLE whaleu_safety.account_appeal_commands (
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,
 session_id uuid NOT NULL,token_hash text NOT NULL,action text NOT NULL CHECK(action IN('submit_appeal','decide_appeal')),
 intent jsonb NOT NULL,intent_hash text NOT NULL,receipt jsonb NOT NULL,grant_id uuid,appeal_id uuid,
 identity_fingerprint text NOT NULL,grant_fingerprint text,source_fingerprint text,policy_fingerprint text,
 mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),PRIMARY KEY(actor_id,request_id),
 CHECK(octet_length(intent::text)<=32768 AND octet_length(receipt::text)<=4096),
 CHECK(request_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 CHECK(intent_hash=encode(sha256(convert_to('whaleu:account-appeal-command:v1'||chr(10)||whaleu_community.content_canonical_json(jsonb_build_object('actor',actor_id::text,'command',intent)),'UTF8')),'hex'))
);
CREATE INDEX account_appeal_commands_transaction ON whaleu_safety.account_appeal_commands(mutation_transaction);
CREATE TABLE whaleu_safety.account_appeals (
 id uuid PRIMARY KEY,subject_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 punishment_id uuid NOT NULL REFERENCES whaleu_safety.account_punishments(id),
 kind text NOT NULL CHECK(kind IN('interaction_mute','access_suspension')),revision bigint NOT NULL CHECK(revision>0),
 text text NOT NULL,submitted_at timestamptz NOT NULL,source_request_id uuid NOT NULL,
 mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 UNIQUE(subject_id,source_request_id),UNIQUE(id,punishment_id),
 FOREIGN KEY(subject_id,source_request_id) REFERENCES whaleu_safety.account_appeal_commands(actor_id,request_id),
 CHECK(char_length(text) BETWEEN 1 AND 4000 AND text=whaleu_profile.moderation_trim(text)),
 CHECK(isfinite(submitted_at) AND submitted_at=date_trunc('milliseconds',submitted_at))
);
CREATE INDEX account_appeals_owner_page ON whaleu_safety.account_appeals(subject_id,submitted_at DESC,id DESC);
CREATE INDEX account_appeals_queue_page ON whaleu_safety.account_appeals(submitted_at DESC,id DESC);
CREATE TABLE whaleu_safety.account_appeal_open_cases (
 punishment_id uuid PRIMARY KEY REFERENCES whaleu_safety.account_punishments(id),appeal_id uuid NOT NULL UNIQUE,
 FOREIGN KEY(appeal_id,punishment_id) REFERENCES whaleu_safety.account_appeals(id,punishment_id)
);
CREATE TABLE whaleu_safety.account_appeal_decisions (
 id uuid PRIMARY KEY,appeal_id uuid NOT NULL UNIQUE REFERENCES whaleu_safety.account_appeals(id),
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),session_id uuid NOT NULL,grant_id uuid NOT NULL REFERENCES whaleu_authorization.role_grants(id),
 source_request_id uuid NOT NULL,outcome text NOT NULL CHECK(outcome IN('upheld','released','closed_no_longer_effective')),
 reason text NOT NULL CHECK(char_length(reason) BETWEEN 1 AND 255 AND reason=whaleu_profile.moderation_trim(reason)),
 recorded_at timestamptz NOT NULL,expected_state_version text NOT NULL CHECK(expected_state_version ~ '^[a-f0-9]{64}$'),
 release_event_id uuid UNIQUE,mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 FOREIGN KEY(actor_id,source_request_id) REFERENCES whaleu_safety.account_appeal_commands(actor_id,request_id),
 CHECK((outcome='released')=(release_event_id IS NOT NULL)),
 CHECK(isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at))
);
CREATE TABLE whaleu_safety.account_appeal_rate_buckets (
 account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),action text NOT NULL CHECK(action IN('submit','decide','read')),
 window_start timestamptz NOT NULL,hits integer NOT NULL CHECK(hits BETWEEN 1 AND 1000000),PRIMARY KEY(account_id,action)
);
CREATE TABLE whaleu_notifications.account_appeal_notices (
 id uuid PRIMARY KEY,decision_id uuid NOT NULL UNIQUE REFERENCES whaleu_safety.account_appeal_decisions(id),
 appeal_id uuid NOT NULL REFERENCES whaleu_safety.account_appeals(id),recipient_account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 kind text NOT NULL CHECK(kind='account_appeal_decided'),outcome text NOT NULL CHECK(outcome IN('upheld','released','closed_no_longer_effective')),
 reason text NOT NULL,created_at timestamptz NOT NULL,read_at timestamptz,
 CHECK(id=decision_id),CHECK(char_length(reason) BETWEEN 1 AND 255),
 CHECK(isfinite(created_at) AND created_at=date_trunc('milliseconds',created_at)),
 CHECK(read_at IS NULL OR (isfinite(read_at) AND read_at>=created_at AND read_at=date_trunc('milliseconds',read_at)))
);
CREATE INDEX account_appeal_notices_owner_page ON whaleu_notifications.account_appeal_notices(recipient_account_id,created_at DESC,id DESC);
CREATE INDEX account_appeal_notices_unread ON whaleu_notifications.account_appeal_notices(recipient_account_id) WHERE read_at IS NULL;

CREATE FUNCTION whaleu_safety.account_appeal_safe_text(value text,maximum integer)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT value IS NOT NULL AND char_length(value) BETWEEN 1 AND maximum AND value=whaleu_profile.moderation_trim(value)
 AND char_length(value)+char_length(regexp_replace(value,U&'[^\+010000-\+10FFFF]','','g'))<=maximum
 AND value !~ U&'[\0001-\0008\000B\000C\000E-\001F\007F-\009F\202A-\202E\2066-\2069]'
$$;
CREATE FUNCTION whaleu_safety.account_appeal_reference_effective(target uuid,selected_kind text,selected_revision bigint,excluded_event uuid DEFAULT NULL)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_safety.account_punishments p JOIN whaleu_safety.account_punishment_heads h
 ON(p.id,p.subject_id,p.kind,p.revision)=(h.punishment_id,h.subject_id,h.kind,h.revision)
 WHERE p.id=target AND p.kind=selected_kind AND p.revision=selected_revision AND p.starts_at<=clock_timestamp()
 AND (p.ends_at IS NULL OR p.ends_at>clock_timestamp())
 AND NOT EXISTS(SELECT 1 FROM whaleu_safety.account_punishment_terminals t WHERE t.punishment_id=p.id AND (excluded_event IS NULL OR t.event_id<>excluded_event)))
$$;
CREATE FUNCTION whaleu_safety.account_appeal_grant_fingerprint(actor uuid,selected uuid)
RETURNS text LANGUAGE sql STABLE AS $$
 SELECT whaleu_profile.moderation_hash(jsonb_build_array(
 (SELECT jsonb_build_array(to_jsonb(g),g.xmin::text,g.ctid::text) FROM whaleu_authorization.role_grants g WHERE g.id=selected AND g.account_id=actor),
 whaleu_safety.account_punishment_authority_epoch()))
$$;
CREATE FUNCTION whaleu_safety.account_appeal_policy_fingerprint(actor uuid)
RETURNS text LANGUAGE sql STABLE AS $$
 SELECT whaleu_profile.moderation_hash(jsonb_build_array(
 (SELECT jsonb_build_array(to_jsonb(h),h.xmin::text,h.ctid::text) FROM whaleu_safety.account_heads h WHERE h.account_id=actor),
 whaleu_safety.account_punishment_fingerprint(actor)))
$$;
CREATE FUNCTION whaleu_safety.account_appeal_admin_current(actor uuid,selected uuid)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT whaleu_safety.account_punishment_super_admin(actor,selected)
 AND EXISTS(SELECT 1 FROM whaleu_safety.account_heads h WHERE h.account_id=actor AND h.block_coverage='complete'
 AND h.restriction_coverage='complete' AND h.provenance<>'unknown' AND h.actions_allowed
 AND (h.valid_until IS NULL OR h.valid_until>clock_timestamp()))
 AND whaleu_safety.account_punishment_allows(actor,'noncontent_management')
$$;
-- Exclusion is only used to reconstruct the exact pre-decision version. The
-- final validator separately proves the sole excluded decision/release cause.
CREATE FUNCTION whaleu_safety.account_appeal_state_before(target uuid,excluded_decision uuid DEFAULT NULL,excluded_event uuid DEFAULT NULL)
RETURNS text LANGUAGE sql VOLATILE AS $$
 SELECT whaleu_profile.moderation_hash(jsonb_build_array(to_jsonb(c),c.xmin::text,c.ctid::text,
 to_jsonb(p),p.xmin::text,p.ctid::text,to_jsonb(h),h.xmin::text,h.ctid::text,
 to_jsonb(t),t.xmin::text,t.ctid::text,to_jsonb(d),d.xmin::text,d.ctid::text,
 whaleu_safety.account_appeal_reference_effective(c.punishment_id,c.kind,c.revision,excluded_event)))
 FROM whaleu_safety.account_appeals c JOIN whaleu_safety.account_punishments p ON p.id=c.punishment_id
 LEFT JOIN whaleu_safety.account_punishment_heads h ON(h.subject_id,h.kind)=(p.subject_id,p.kind)
 LEFT JOIN whaleu_safety.account_punishment_terminals t ON t.punishment_id=p.id AND (excluded_event IS NULL OR t.event_id<>excluded_event)
 LEFT JOIN whaleu_safety.account_appeal_decisions d ON d.appeal_id=c.id AND (excluded_decision IS NULL OR d.id<>excluded_decision)
 WHERE c.id=target
$$;
CREATE FUNCTION whaleu_safety.account_appeal_state_version(target uuid)
RETURNS text LANGUAGE sql VOLATILE AS $$SELECT whaleu_safety.account_appeal_state_before(target)$$;
CREATE FUNCTION whaleu_safety.account_appeal_read_fingerprint(scope text,actor uuid,selected uuid)
RETURNS text LANGUAGE sql STABLE AS $$
 SELECT whaleu_profile.moderation_hash(jsonb_build_array(scope,
 (SELECT jsonb_agg(jsonb_build_array(slot,version,epoch::text) ORDER BY slot) FROM whaleu_safety.discovery_count_epochs),
 (SELECT jsonb_agg(jsonb_build_array(slot,version,epoch::text) ORDER BY slot) FROM whaleu_safety.account_moderation_epochs),
 CASE WHEN selected IS NULL THEN NULL ELSE whaleu_safety.account_appeal_grant_fingerprint(actor,selected) END,
 CASE WHEN selected IS NULL THEN NULL ELSE whaleu_safety.account_appeal_policy_fingerprint(actor) END))
$$;
CREATE FUNCTION whaleu_safety.account_appeal_identity_current(actor uuid,session uuid,token text)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT whaleu_profile.moderation_identity_current(actor,session,token)
 AND EXISTS(SELECT 1 FROM whaleu_identity.sessions s WHERE s.id=session AND s.account_id=actor AND s.access_expires_at>clock_timestamp())
$$;
CREATE FUNCTION whaleu_safety.guard_account_appeal_command() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p whaleu_safety.account_punishments;c whaleu_safety.account_appeals;open_id uuid;cancelled boolean;effective boolean;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Immutable private appeal command' USING ERRCODE='23514',CONSTRAINT='account_appeal_immutable';END IF;
 IF current_setting('transaction_isolation')<>'read committed' OR NEW.mutation_transaction IS DISTINCT FROM pg_current_xact_id()
 OR NOT whaleu_safety.account_appeal_identity_current(NEW.actor_id,NEW.session_id,NEW.token_hash)
 OR NEW.intent->>'clientRequestId' IS DISTINCT FROM NEW.request_id::text OR NEW.intent->>'action' IS DISTINCT FROM NEW.action
 OR NEW.receipt->>'requestId' IS DISTINCT FROM NEW.request_id::text OR NEW.receipt->>'action' IS DISTINCT FROM NEW.action
 OR coalesce(NEW.receipt->>'outcome' IN('applied','rejected'),false)=false
 THEN RAISE EXCEPTION 'Invalid private appeal command' USING ERRCODE='23514',CONSTRAINT='account_appeal_invalid';END IF;
 NEW.identity_fingerprint:=whaleu_profile.moderation_hash(whaleu_profile.moderation_identity_facts(NEW.actor_id,NEW.session_id,NEW.token_hash));
 cancelled:=NEW.receipt->>'outcome'='rejected' AND NEW.receipt->>'code'='SAFETY_MODERATION_CANCELLED';
 IF NEW.receipt->>'outcome'='rejected' THEN
  IF whaleu_community.post_owner_visibility_keys(NEW.receipt,CASE WHEN NEW.action='submit_appeal'
   THEN ARRAY['requestId','action','punishment','outcome','code'] ELSE ARRAY['requestId','action','appealId','outcome','code'] END) IS DISTINCT FROM true
  OR coalesce(NEW.receipt->>'code' IN('SAFETY_MODERATION_STALE','SAFETY_MODERATION_CANCELLED'),false)=false
  THEN RAISE EXCEPTION 'Invalid private receipt' USING ERRCODE='23514',CONSTRAINT='account_appeal_invalid';END IF;
 ELSE
  IF whaleu_community.post_owner_visibility_keys(NEW.receipt,CASE WHEN NEW.action='submit_appeal'
   THEN ARRAY['requestId','action','punishment','outcome','appealId','recordedAt','reusedOpenCase']
   ELSE ARRAY['requestId','action','appealId','outcome','decision','eventId','recordedAt'] END) IS DISTINCT FROM true
  OR coalesce(NEW.receipt->>'recordedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$',false)=false
  OR whaleu_profile.moderation_uuid_valid(NEW.receipt->>'appealId') IS DISTINCT FROM true
  OR (NEW.action='submit_appeal' AND jsonb_typeof(NEW.receipt->'reusedOpenCase') IS DISTINCT FROM 'boolean')
  OR (NEW.action='decide_appeal' AND whaleu_profile.moderation_uuid_valid(NEW.receipt->>'eventId') IS DISTINCT FROM true)
  THEN RAISE EXCEPTION 'Invalid private receipt' USING ERRCODE='23514',CONSTRAINT='account_appeal_invalid';END IF;
 END IF;
 IF NEW.action='submit_appeal' THEN
  IF whaleu_community.post_owner_visibility_keys(NEW.intent,ARRAY['clientRequestId','action','punishment','text']) IS DISTINCT FROM true
  OR whaleu_community.post_owner_visibility_keys(NEW.intent->'punishment',ARRAY['punishmentId','kind','revision']) IS DISTINCT FROM true
  OR jsonb_typeof(NEW.intent->'text') IS DISTINCT FROM 'string'
  OR NOT whaleu_safety.account_appeal_safe_text(NEW.intent->>'text',4000)
  OR NEW.receipt->'punishment' IS DISTINCT FROM NEW.intent->'punishment'
  OR coalesce(NEW.intent->'punishment'->>'kind' IN('interaction_mute','access_suspension'),false)=false
  OR jsonb_typeof(NEW.intent->'punishment'->'revision') IS DISTINCT FROM 'string'
  OR coalesce(NEW.intent->'punishment'->>'revision' ~ '^(0|[1-9][0-9]{0,18})$',false)=false
  OR whaleu_profile.moderation_uuid_valid(NEW.intent->'punishment'->>'punishmentId') IS DISTINCT FROM true
  OR NEW.grant_id IS NOT NULL THEN RAISE EXCEPTION 'Invalid appeal intent' USING ERRCODE='23514',CONSTRAINT='account_appeal_invalid';END IF;
 ELSE
  IF whaleu_community.post_owner_visibility_keys(NEW.intent,ARRAY['clientRequestId','action','appealId','expectedStateVersion','decision','reason']) IS DISTINCT FROM true
  OR jsonb_typeof(NEW.intent->'reason') IS DISTINCT FROM 'string'
  OR NOT whaleu_safety.account_appeal_safe_text(NEW.intent->>'reason',255)
  OR NEW.receipt->>'appealId' IS DISTINCT FROM NEW.intent->>'appealId'
  OR whaleu_profile.moderation_uuid_valid(NEW.intent->>'appealId') IS DISTINCT FROM true
  OR coalesce(NEW.intent->>'expectedStateVersion' ~ '^[a-f0-9]{64}$',false)=false
  OR coalesce(NEW.intent->>'decision' IN('upheld','released','closed_no_longer_effective'),false)=false
  THEN RAISE EXCEPTION 'Invalid appeal decision intent' USING ERRCODE='23514',CONSTRAINT='account_appeal_invalid';END IF;
 END IF;
 IF cancelled THEN
  IF NEW.grant_id IS NOT NULL OR NEW.appeal_id IS NOT NULL THEN RAISE EXCEPTION 'Cancellation has no case authority' USING ERRCODE='23514',CONSTRAINT='account_appeal_invalid';END IF;
  NEW.grant_fingerprint:=NULL;NEW.source_fingerprint:=NULL;NEW.policy_fingerprint:=NULL;RETURN NEW;
 END IF;
 IF NEW.action='submit_appeal' THEN
  SELECT * INTO p FROM whaleu_safety.account_punishments WHERE id=(NEW.intent->'punishment'->>'punishmentId')::uuid AND subject_id=NEW.actor_id;
  IF p.id IS NULL OR (p.kind,p.revision::text) IS DISTINCT FROM(NEW.intent->'punishment'->>'kind',NEW.intent->'punishment'->>'revision')
  THEN RAISE EXCEPTION 'Owned punishment required' USING ERRCODE='23514',CONSTRAINT='account_appeal_invalid';END IF;
  SELECT appeal_id INTO open_id FROM whaleu_safety.account_appeal_open_cases WHERE punishment_id=p.id;
  effective:=whaleu_safety.account_appeal_reference_effective(p.id,p.kind,p.revision);
  IF NEW.receipt->>'outcome'='applied' THEN
   IF NEW.appeal_id IS DISTINCT FROM (NEW.receipt->>'appealId')::uuid
   OR (open_id IS NOT NULL AND (NEW.appeal_id<>open_id OR NEW.receipt->'reusedOpenCase'<>'true'::jsonb))
   OR (open_id IS NULL AND (NOT effective OR NEW.receipt->'reusedOpenCase'<>'false'::jsonb))
   THEN RAISE EXCEPTION 'Exact current appeal required' USING ERRCODE='23514',CONSTRAINT='account_appeal_invalid';END IF;
  ELSIF NEW.receipt->>'code' IS DISTINCT FROM 'SAFETY_MODERATION_STALE' OR effective OR open_id IS NOT NULL OR NEW.appeal_id IS NOT NULL THEN
   RAISE EXCEPTION 'Invalid stale appeal' USING ERRCODE='23514',CONSTRAINT='account_appeal_invalid';
  END IF;
  NEW.source_fingerprint:=whaleu_safety.account_punishment_version(p.id);
 ELSE
  IF NEW.grant_id IS NULL OR NOT whaleu_safety.account_appeal_admin_current(NEW.actor_id,NEW.grant_id) THEN
   RAISE EXCEPTION 'Current super-admin required' USING ERRCODE='23514',CONSTRAINT='account_appeal_authority';END IF;
  SELECT * INTO c FROM whaleu_safety.account_appeals WHERE id=(NEW.intent->>'appealId')::uuid;
  IF c.id IS NULL OR NEW.appeal_id IS DISTINCT FROM c.id THEN RAISE EXCEPTION 'Exact private appeal required' USING ERRCODE='23514',CONSTRAINT='account_appeal_invalid';END IF;
  NEW.source_fingerprint:=whaleu_safety.account_appeal_state_version(c.id);
  NEW.grant_fingerprint:=whaleu_safety.account_appeal_grant_fingerprint(NEW.actor_id,NEW.grant_id);
  NEW.policy_fingerprint:=whaleu_safety.account_appeal_policy_fingerprint(NEW.actor_id);
  effective:=whaleu_safety.account_appeal_reference_effective(c.punishment_id,c.kind,c.revision);
  IF NEW.receipt->>'outcome'='applied' THEN
   IF NEW.source_fingerprint IS DISTINCT FROM NEW.intent->>'expectedStateVersion'
   OR EXISTS(SELECT 1 FROM whaleu_safety.account_appeal_decisions WHERE appeal_id=c.id)
   OR (NEW.intent->>'decision'='closed_no_longer_effective')=effective
   OR NEW.receipt->>'decision' IS DISTINCT FROM NEW.intent->>'decision'
   THEN RAISE EXCEPTION 'Stale appeal decision' USING ERRCODE='23514',CONSTRAINT='account_appeal_stale';END IF;
  ELSIF NEW.receipt->>'code' IS DISTINCT FROM 'SAFETY_MODERATION_STALE'
   OR (NEW.source_fingerprint=NEW.intent->>'expectedStateVersion' AND NOT EXISTS(SELECT 1 FROM whaleu_safety.account_appeal_decisions WHERE appeal_id=c.id)
   AND (NEW.intent->>'decision'='closed_no_longer_effective')<>effective) THEN
   RAISE EXCEPTION 'Invalid stale decision' USING ERRCODE='23514',CONSTRAINT='account_appeal_invalid';
  END IF;
 END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER account_appeal_command_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_safety.account_appeal_commands FOR EACH ROW EXECUTE FUNCTION whaleu_safety.guard_account_appeal_command();
CREATE FUNCTION whaleu_safety.guard_account_appeal_case() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_safety.account_appeal_commands;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Immutable private appeal' USING ERRCODE='23514',CONSTRAINT='account_appeal_immutable';END IF;
 SELECT * INTO q FROM whaleu_safety.account_appeal_commands WHERE actor_id=NEW.subject_id AND request_id=NEW.source_request_id;
 IF q.mutation_transaction IS DISTINCT FROM pg_current_xact_id() OR NEW.mutation_transaction IS DISTINCT FROM pg_current_xact_id()
 OR q.action IS DISTINCT FROM 'submit_appeal' OR q.receipt->>'outcome' IS DISTINCT FROM 'applied'
 OR q.receipt->'reusedOpenCase' IS DISTINCT FROM 'false'::jsonb OR q.appeal_id IS DISTINCT FROM NEW.id
 OR q.intent->>'text' IS DISTINCT FROM NEW.text OR NEW.submitted_at IS DISTINCT FROM (q.receipt->>'recordedAt')::timestamptz
 OR NEW.submitted_at>clock_timestamp() OR NEW.submitted_at<date_trunc('milliseconds',transaction_timestamp())
 OR (NEW.punishment_id::text,NEW.kind,NEW.revision::text) IS DISTINCT FROM(q.intent->'punishment'->>'punishmentId',q.intent->'punishment'->>'kind',q.intent->'punishment'->>'revision')
 THEN RAISE EXCEPTION 'Exact causal appeal required' USING ERRCODE='23514',CONSTRAINT='account_appeal_causal';END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER account_appeal_case_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_safety.account_appeals FOR EACH ROW EXECUTE FUNCTION whaleu_safety.guard_account_appeal_case();
CREATE FUNCTION whaleu_safety.guard_account_appeal_decision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_safety.account_appeal_commands;c whaleu_safety.account_appeals;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Immutable private appeal decision' USING ERRCODE='23514',CONSTRAINT='account_appeal_immutable';END IF;
 SELECT * INTO q FROM whaleu_safety.account_appeal_commands WHERE actor_id=NEW.actor_id AND request_id=NEW.source_request_id;
 SELECT * INTO c FROM whaleu_safety.account_appeals WHERE id=NEW.appeal_id;
 IF q.mutation_transaction IS DISTINCT FROM pg_current_xact_id() OR NEW.mutation_transaction IS DISTINCT FROM pg_current_xact_id()
 OR q.action IS DISTINCT FROM 'decide_appeal' OR q.receipt->>'outcome' IS DISTINCT FROM 'applied'
 OR q.appeal_id IS DISTINCT FROM NEW.appeal_id OR q.session_id IS DISTINCT FROM NEW.session_id OR q.grant_id IS DISTINCT FROM NEW.grant_id
 OR q.intent->>'reason' IS DISTINCT FROM NEW.reason OR q.intent->>'decision' IS DISTINCT FROM NEW.outcome
 OR q.intent->>'expectedStateVersion' IS DISTINCT FROM NEW.expected_state_version
 OR q.receipt->>'eventId' IS DISTINCT FROM NEW.id::text OR NEW.recorded_at IS DISTINCT FROM(q.receipt->>'recordedAt')::timestamptz
 OR NEW.recorded_at>clock_timestamp() OR NEW.recorded_at<date_trunc('milliseconds',transaction_timestamp())
 OR whaleu_safety.account_appeal_state_version(NEW.appeal_id) IS DISTINCT FROM NEW.expected_state_version
 OR NOT EXISTS(SELECT 1 FROM whaleu_safety.account_appeal_open_cases WHERE appeal_id=c.id AND punishment_id=c.punishment_id)
 OR NOT whaleu_safety.account_appeal_admin_current(NEW.actor_id,NEW.grant_id)
 OR (NEW.outcome='closed_no_longer_effective')=whaleu_safety.account_appeal_reference_effective(c.punishment_id,c.kind,c.revision)
 THEN RAISE EXCEPTION 'Exact current decision required' USING ERRCODE='23514',CONSTRAINT='account_appeal_causal';END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER account_appeal_decision_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_safety.account_appeal_decisions FOR EACH ROW EXECUTE FUNCTION whaleu_safety.guard_account_appeal_decision();
CREATE FUNCTION whaleu_safety.apply_account_appeal_decision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c whaleu_safety.account_appeals;q whaleu_safety.account_appeal_commands;BEGIN
 SELECT * INTO STRICT c FROM whaleu_safety.account_appeals WHERE id=NEW.appeal_id;
 SELECT * INTO STRICT q FROM whaleu_safety.account_appeal_commands WHERE actor_id=NEW.actor_id AND request_id=NEW.source_request_id;
 IF NEW.outcome='released' THEN
  PERFORM whaleu_safety.release_account_punishment(NEW.actor_id,NEW.session_id,q.token_hash,NEW.grant_id,NEW.source_request_id,
   c.punishment_id,c.kind,c.revision,NEW.reason,'appeal_released',c.id,NEW.release_event_id,NEW.recorded_at);
 END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER account_appeal_decision_apply AFTER INSERT ON whaleu_safety.account_appeal_decisions FOR EACH ROW EXECUTE FUNCTION whaleu_safety.apply_account_appeal_decision();
CREATE FUNCTION whaleu_safety.account_appeal_assert_complete(q whaleu_safety.account_appeal_commands)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE c whaleu_safety.account_appeals;d whaleu_safety.account_appeal_decisions;p whaleu_safety.account_punishments;BEGIN
 IF q.mutation_transaction<>pg_current_xact_id() OR current_setting('transaction_isolation')<>'read committed' THEN
 RAISE EXCEPTION 'Original read-committed appeal transaction required' USING ERRCODE='23514',CONSTRAINT='account_appeal_causal';END IF;
 LOCK TABLE whaleu_identity.accounts,whaleu_identity.sessions,whaleu_identity.access_tokens IN SHARE MODE NOWAIT;
 IF NOT whaleu_safety.account_appeal_identity_current(q.actor_id,q.session_id,q.token_hash)
 OR q.identity_fingerprint IS DISTINCT FROM whaleu_profile.moderation_hash(whaleu_profile.moderation_identity_facts(q.actor_id,q.session_id,q.token_hash))
 THEN RAISE EXCEPTION 'Appeal session changed' USING ERRCODE='23514',CONSTRAINT='account_appeal_unavailable';END IF;
 IF q.receipt->>'outcome'='rejected' AND q.receipt->>'code'='SAFETY_MODERATION_CANCELLED' THEN RETURN;END IF;
 -- Identity-only cancellation above never locks independent source owners.
 LOCK TABLE whaleu_safety.account_punishments,whaleu_safety.account_punishment_heads,
 whaleu_safety.account_punishment_terminals,whaleu_safety.account_appeals,whaleu_safety.account_appeal_decisions,
 whaleu_safety.account_appeal_open_cases IN SHARE MODE NOWAIT;
 IF q.action='decide_appeal' THEN
  LOCK TABLE whaleu_authorization.role_grants,whaleu_authorization.account_punishment_authority_epoch,
  whaleu_safety.account_heads,whaleu_notifications.account_appeal_notices IN SHARE MODE NOWAIT;
 END IF;
 IF q.action='submit_appeal' THEN
  SELECT * INTO p FROM whaleu_safety.account_punishments WHERE id=(q.intent->'punishment'->>'punishmentId')::uuid AND subject_id=q.actor_id;
  IF p.id IS NULL OR q.source_fingerprint IS DISTINCT FROM whaleu_safety.account_punishment_version(p.id)
  THEN RAISE EXCEPTION 'Appealed punishment changed' USING ERRCODE='23514',CONSTRAINT='account_appeal_unavailable';END IF;
  IF q.receipt->>'outcome'='applied' THEN
   SELECT * INTO c FROM whaleu_safety.account_appeals WHERE id=q.appeal_id AND subject_id=q.actor_id;
   IF c.id IS NULL OR (c.punishment_id,c.kind,c.revision) IS DISTINCT FROM(p.id,p.kind,p.revision)
   OR c.submitted_at IS DISTINCT FROM(q.receipt->>'recordedAt')::timestamptz
   OR NOT EXISTS(SELECT 1 FROM whaleu_safety.account_appeal_open_cases WHERE punishment_id=p.id AND appeal_id=c.id)
   OR EXISTS(SELECT 1 FROM whaleu_safety.account_appeal_decisions WHERE appeal_id=c.id)
   THEN RAISE EXCEPTION 'Pending appeal closure missing' USING ERRCODE='23514',CONSTRAINT='account_appeal_causal';END IF;
   IF q.receipt->'reusedOpenCase'='false'::jsonb AND
   (c.source_request_id<>q.request_id OR c.mutation_transaction<>pg_current_xact_id() OR c.text<>q.intent->>'text'
    OR NOT whaleu_safety.account_appeal_reference_effective(p.id,p.kind,p.revision)) THEN
    RAISE EXCEPTION 'New appeal must bind exact effective punishment' USING ERRCODE='23514',CONSTRAINT='account_appeal_causal';END IF;
  ELSIF whaleu_safety.account_appeal_reference_effective(p.id,p.kind,p.revision)
   OR EXISTS(SELECT 1 FROM whaleu_safety.account_appeal_open_cases WHERE punishment_id=p.id) THEN
   RAISE EXCEPTION 'Stale appeal denial changed' USING ERRCODE='23514',CONSTRAINT='account_appeal_unavailable';
  END IF;
 ELSE
  IF NOT whaleu_safety.account_appeal_admin_current(q.actor_id,q.grant_id)
  OR q.grant_fingerprint IS DISTINCT FROM whaleu_safety.account_appeal_grant_fingerprint(q.actor_id,q.grant_id)
  OR q.policy_fingerprint IS DISTINCT FROM whaleu_safety.account_appeal_policy_fingerprint(q.actor_id)
  THEN RAISE EXCEPTION 'Appeal reviewer changed' USING ERRCODE='23514',CONSTRAINT='account_appeal_unavailable';END IF;
  SELECT * INTO c FROM whaleu_safety.account_appeals WHERE id=q.appeal_id;
  IF c.id IS NULL THEN RAISE EXCEPTION 'Appeal absent' USING ERRCODE='23514',CONSTRAINT='account_appeal_causal';END IF;
  IF q.receipt->>'outcome'='applied' THEN
   SELECT * INTO d FROM whaleu_safety.account_appeal_decisions WHERE appeal_id=c.id;
   IF d.id IS NULL OR d.id::text IS DISTINCT FROM q.receipt->>'eventId'
   OR (d.actor_id,d.session_id,d.grant_id,d.source_request_id) IS DISTINCT FROM(q.actor_id,q.session_id,q.grant_id,q.request_id)
   OR d.mutation_transaction<>pg_current_xact_id() OR d.outcome IS DISTINCT FROM q.intent->>'decision'
   OR d.reason IS DISTINCT FROM q.intent->>'reason' OR d.recorded_at IS DISTINCT FROM(q.receipt->>'recordedAt')::timestamptz
   OR EXISTS(SELECT 1 FROM whaleu_safety.account_appeal_open_cases WHERE appeal_id=c.id)
   OR q.source_fingerprint IS DISTINCT FROM whaleu_safety.account_appeal_state_before(c.id,d.id,d.release_event_id)
   OR NOT EXISTS(SELECT 1 FROM whaleu_notifications.account_appeal_notices n JOIN whaleu_notifications.system_notice_ids i
    ON(i.id,i.kind,i.recipient_account_id)=(n.id,n.kind,n.recipient_account_id)
    WHERE n.id=d.id AND n.decision_id=d.id AND n.appeal_id=c.id AND n.recipient_account_id=c.subject_id
    AND n.outcome=d.outcome AND n.reason=d.reason AND n.created_at=d.recorded_at AND n.read_at IS NULL)
   THEN RAISE EXCEPTION 'Decision closure missing' USING ERRCODE='23514',CONSTRAINT='account_appeal_causal';END IF;
   IF d.outcome='released' AND NOT EXISTS(SELECT 1 FROM whaleu_safety.account_punishment_terminals t
    WHERE t.punishment_id=c.punishment_id AND t.event_id=d.release_event_id AND t.cause='appeal_released' AND t.cause_id=c.id
    AND t.actor_id=q.actor_id AND t.session_id=q.session_id AND t.token_hash=q.token_hash AND t.grant_id=q.grant_id
    AND t.source_request_id=q.request_id AND t.effective_at=d.recorded_at AND t.reason=d.reason AND t.mutation_transaction=pg_current_xact_id())
   THEN RAISE EXCEPTION 'Exact appeal release missing' USING ERRCODE='23514',CONSTRAINT='account_appeal_causal';END IF;
  ELSIF q.source_fingerprint IS DISTINCT FROM whaleu_safety.account_appeal_state_version(c.id) THEN
   RAISE EXCEPTION 'Stale decision denial changed' USING ERRCODE='23514',CONSTRAINT='account_appeal_unavailable';
  END IF;
 END IF;
END$$;
-- Called by the ledger's terminal validator; no recursive ledger validation.
CREATE OR REPLACE FUNCTION whaleu_safety.validate_account_appeal_release(cause_id uuid,punishment_id uuid,event_id uuid,actor_id uuid,request_id uuid)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE q whaleu_safety.account_appeal_commands;BEGIN
 SELECT * INTO q FROM whaleu_safety.account_appeal_commands command WHERE command.actor_id=$4 AND command.request_id=$5;
 IF q.actor_id IS NULL OR q.action<>'decide_appeal' OR q.appeal_id<>$1 OR q.receipt->>'outcome'<>'applied'
 OR q.mutation_transaction<>pg_current_xact_id() OR NOT EXISTS(SELECT 1 FROM whaleu_safety.account_appeal_decisions d
 JOIN whaleu_safety.account_appeals c ON c.id=d.appeal_id WHERE c.id=$1 AND c.punishment_id=$2
 AND d.release_event_id=$3 AND d.actor_id=$4 AND d.source_request_id=$5 AND d.outcome='released'
 AND d.session_id=q.session_id AND d.grant_id=q.grant_id AND d.id::text=q.receipt->>'eventId'
 AND d.mutation_transaction=pg_current_xact_id()) THEN RETURN false;END IF;
 PERFORM whaleu_safety.account_appeal_assert_complete(q);RETURN true;
END$$;
CREATE FUNCTION whaleu_safety.account_appeal_complete_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_safety.account_appeal_commands;BEGIN
 FOR q IN SELECT * FROM whaleu_safety.account_appeal_commands WHERE mutation_transaction=pg_current_xact_id() LOOP
  PERFORM whaleu_safety.account_appeal_assert_complete(q);
 END LOOP;RETURN NULL;
END$$;
CREATE CONSTRAINT TRIGGER account_appeal_complete AFTER INSERT ON whaleu_safety.account_appeal_commands
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_appeal_complete_trigger();
CREATE FUNCTION whaleu_safety.account_appeal_open_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' OR (TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM whaleu_safety.account_appeals c
  JOIN whaleu_safety.account_appeal_commands q ON(q.actor_id,q.request_id)=(c.subject_id,c.source_request_id)
  WHERE c.id=NEW.appeal_id AND c.punishment_id=NEW.punishment_id AND c.mutation_transaction=pg_current_xact_id()
  AND q.receipt->'reusedOpenCase'='false'::jsonb))
 OR (TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM whaleu_safety.account_appeal_decisions d WHERE d.appeal_id=OLD.appeal_id AND d.mutation_transaction=pg_current_xact_id()))
 THEN RAISE EXCEPTION 'Exact appeal transition required' USING ERRCODE='23514',CONSTRAINT='account_appeal_causal';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END$$;
CREATE TRIGGER account_appeal_open_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_safety.account_appeal_open_cases FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_appeal_open_guard();
CREATE FUNCTION whaleu_notifications.account_appeal_notice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Retain appeal result notice' USING ERRCODE='23514',CONSTRAINT='account_appeal_immutable';END IF;
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-'read_at') IS DISTINCT FROM(to_jsonb(OLD)-'read_at')
  OR (OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at) OR NEW.read_at IS NULL OR NEW.read_at>clock_timestamp()
  THEN RAISE EXCEPTION 'Immutable appeal result notice' USING ERRCODE='23514',CONSTRAINT='account_appeal_immutable';END IF;
 ELSE
  IF NEW.read_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM whaleu_safety.account_appeal_decisions d
   JOIN whaleu_safety.account_appeals c ON c.id=d.appeal_id WHERE d.id=NEW.decision_id AND d.id=NEW.id AND c.id=NEW.appeal_id
   AND c.subject_id=NEW.recipient_account_id AND d.outcome=NEW.outcome AND d.reason=NEW.reason
   AND d.recorded_at=NEW.created_at AND d.mutation_transaction=pg_current_xact_id())
  THEN RAISE EXCEPTION 'Exact private result required' USING ERRCODE='23514',CONSTRAINT='account_appeal_causal';END IF;
  INSERT INTO whaleu_notifications.system_notice_owners(account_id) VALUES(NEW.recipient_account_id) ON CONFLICT DO NOTHING;
  PERFORM account_id FROM whaleu_notifications.system_notice_owners WHERE account_id=NEW.recipient_account_id FOR UPDATE;
 END IF;RETURN NEW;
END$$;
CREATE TRIGGER account_appeal_notice_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_notifications.account_appeal_notices FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.account_appeal_notice_guard();
CREATE TRIGGER register_system_notice_id AFTER INSERT ON whaleu_notifications.account_appeal_notices FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.register_system_notice_id();
ALTER TABLE whaleu_notifications.account_appeal_notices ADD CONSTRAINT account_appeal_notice_exact_id
 FOREIGN KEY(id,kind,recipient_account_id) REFERENCES whaleu_notifications.system_notice_ids(id,kind,recipient_account_id) DEFERRABLE INITIALLY DEFERRED;
-- Every appeal writer, including zero-row and same-value statements, advances
-- the existing fixed Safety vector. Rate buckets deliberately do not.
DO $$DECLARE relation text;BEGIN
 FOREACH relation IN ARRAY ARRAY['whaleu_safety.account_appeals','whaleu_safety.account_appeal_open_cases','whaleu_safety.account_appeal_decisions'] LOOP
  EXECUTE format('CREATE TRIGGER a_discovery_count_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.advance_discovery_count_epoch()',relation);
 END LOOP;
 FOREACH relation IN ARRAY ARRAY['whaleu_safety.account_appeal_commands','whaleu_safety.account_appeals','whaleu_safety.account_appeal_decisions','whaleu_safety.account_appeal_open_cases','whaleu_notifications.account_appeal_notices'] LOOP
  EXECUTE format('CREATE TRIGGER account_appeal_no_truncate BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION whaleu_profile.moderation_immutable()',relation);
 END LOOP;
 -- Source writes after SET CONSTRAINTS ALL IMMEDIATE must re-prove the active
 -- immutable command too; historical recovery never enrolls these sources.
 FOREACH relation IN ARRAY ARRAY['whaleu_identity.accounts','whaleu_identity.sessions','whaleu_identity.access_tokens',
  'whaleu_authorization.role_grants','whaleu_safety.account_heads','whaleu_safety.account_punishments',
  'whaleu_safety.account_punishment_heads','whaleu_safety.account_punishment_terminals',
  'whaleu_safety.account_appeals','whaleu_safety.account_appeal_decisions','whaleu_safety.account_appeal_open_cases',
  'whaleu_notifications.account_appeal_notices'] LOOP
  EXECUTE format('CREATE CONSTRAINT TRIGGER account_appeal_source_complete AFTER INSERT OR UPDATE OR DELETE ON %s DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_appeal_complete_trigger()',relation);
 END LOOP;
END$$;
-- A single transaction-local identity is retained as an immutable audit wake;
-- successive source statements update only its monotone ordinal. Deferred row
-- triggers then cover zero-row DML and TRUNCATE as well as ordinary row changes.
CREATE TABLE whaleu_safety.account_appeal_validation_wakes (
 mutation_transaction xid8 PRIMARY KEY DEFAULT pg_current_xact_id(),ordinal bigint NOT NULL CHECK(ordinal>0)
);
CREATE FUNCTION whaleu_safety.guard_account_appeal_validation_wake() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF pg_trigger_depth()<2 OR TG_OP='DELETE' OR NEW.mutation_transaction<>pg_current_xact_id()
 OR (TG_OP='INSERT' AND NEW.ordinal<>1)
 OR (TG_OP='UPDATE' AND ((NEW.mutation_transaction,NEW.ordinal) IS DISTINCT FROM(OLD.mutation_transaction,OLD.ordinal+1))) THEN
 RAISE EXCEPTION 'Causal appeal validation wake required' USING ERRCODE='23514',CONSTRAINT='account_appeal_causal';END IF;RETURN NEW;
END$$;
CREATE TRIGGER account_appeal_validation_wake_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_safety.account_appeal_validation_wakes
 FOR EACH ROW EXECUTE FUNCTION whaleu_safety.guard_account_appeal_validation_wake();
CREATE TRIGGER account_appeal_validation_wake_no_truncate BEFORE TRUNCATE ON whaleu_safety.account_appeal_validation_wakes
 FOR EACH STATEMENT EXECUTE FUNCTION whaleu_profile.moderation_immutable();
CREATE CONSTRAINT TRIGGER account_appeal_validation_wake_complete AFTER INSERT OR UPDATE ON whaleu_safety.account_appeal_validation_wakes
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_appeal_complete_trigger();
CREATE FUNCTION whaleu_safety.wake_account_appeal_validation() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF EXISTS(SELECT 1 FROM whaleu_safety.account_appeal_commands WHERE mutation_transaction=pg_current_xact_id()) THEN
  INSERT INTO whaleu_safety.account_appeal_validation_wakes(mutation_transaction,ordinal) VALUES(pg_current_xact_id(),1)
  ON CONFLICT(mutation_transaction) DO UPDATE SET ordinal=whaleu_safety.account_appeal_validation_wakes.ordinal+1;
 END IF;RETURN NULL;
END$$;
DO $$DECLARE relation text;BEGIN
 FOREACH relation IN ARRAY ARRAY['whaleu_identity.accounts','whaleu_identity.sessions','whaleu_identity.access_tokens',
  'whaleu_authorization.role_grants','whaleu_safety.account_heads','whaleu_safety.account_punishments',
  'whaleu_safety.account_punishment_heads','whaleu_safety.account_punishment_terminals',
  'whaleu_safety.account_appeals','whaleu_safety.account_appeal_decisions','whaleu_safety.account_appeal_open_cases',
  'whaleu_notifications.account_appeal_notices','whaleu_notifications.system_notice_ids'] LOOP
  EXECUTE format('CREATE TRIGGER z_account_appeal_source_wake AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.wake_account_appeal_validation()',relation);
 END LOOP;
 FOREACH relation IN ARRAY ARRAY['whaleu_safety.account_appeal_commands','whaleu_safety.account_appeals','whaleu_safety.account_appeal_decisions'] LOOP
  EXECUTE format('CREATE TRIGGER account_appeal_immutable_statement BEFORE UPDATE OR DELETE ON %s FOR EACH STATEMENT EXECUTE FUNCTION whaleu_profile.moderation_immutable()',relation);
 END LOOP;
END$$;
CREATE OR REPLACE FUNCTION whaleu_safety.account_punishment_open_appeal(target uuid)
RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT o.appeal_id FROM whaleu_safety.account_appeal_open_cases o
 JOIN whaleu_safety.account_appeals c ON(c.id,c.punishment_id)=(o.appeal_id,o.punishment_id)
 WHERE o.punishment_id=target AND NOT EXISTS(SELECT 1 FROM whaleu_safety.account_appeal_decisions d WHERE d.appeal_id=c.id)
$$;


ALTER TABLE whaleu_notifications.system_notice_ids DROP CONSTRAINT system_notice_ids_kind_check;
ALTER TABLE whaleu_notifications.system_notice_ids ADD CONSTRAINT system_notice_ids_kind_check CHECK(kind IN(
 'post_jury_removed','profile_nickname_reset','profile_custom_avatar_cleared','admin_post_removed',
 'account_punishment_issued','account_punishment_released','account_appeal_decided','admin_discussion_removed'));
CREATE OR REPLACE FUNCTION whaleu_notifications.system_notice_id_complete() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF (NEW.kind='post_jury_removed' AND NOT EXISTS(SELECT 1 FROM whaleu_notifications.system_notices n WHERE (n.id,n.kind,n.recipient_account_id)=(NEW.id,NEW.kind,NEW.recipient_account_id)))
 OR (NEW.kind='profile_nickname_reset' AND NOT EXISTS(SELECT 1 FROM whaleu_notifications.profile_moderation_notices n WHERE (n.id,n.kind,n.recipient_account_id)=(NEW.id,NEW.kind,NEW.recipient_account_id)))
 OR (NEW.kind='profile_custom_avatar_cleared' AND NOT EXISTS(SELECT 1 FROM whaleu_notifications.profile_avatar_moderation_notices n WHERE (n.id,n.kind,n.recipient_account_id)=(NEW.id,NEW.kind,NEW.recipient_account_id)))
 OR (NEW.kind='admin_post_removed' AND NOT EXISTS(SELECT 1 FROM whaleu_notifications.admin_post_removal_notices n WHERE (n.id,n.kind,n.recipient_account_id)=(NEW.id,NEW.kind,NEW.recipient_account_id)))
 OR (NEW.kind IN('account_punishment_issued','account_punishment_released') AND NOT EXISTS(SELECT 1 FROM whaleu_notifications.account_punishment_notices n WHERE (n.id,n.kind,n.recipient_account_id)=(NEW.id,NEW.kind,NEW.recipient_account_id)))
 OR (NEW.kind='admin_discussion_removed' AND NOT EXISTS(SELECT 1 FROM whaleu_notifications.admin_discussion_removal_notices n WHERE (n.id,n.kind,n.recipient_account_id)=(NEW.id,NEW.kind,NEW.recipient_account_id)))
 OR (NEW.kind='account_appeal_decided' AND NOT EXISTS(SELECT 1 FROM whaleu_notifications.account_appeal_notices n WHERE (n.id,n.kind,n.recipient_account_id)=(NEW.id,NEW.kind,NEW.recipient_account_id)))
 THEN RAISE EXCEPTION 'System notice registry requires exact source' USING ERRCODE='23514',CONSTRAINT='account_punishment_causal';END IF;RETURN NULL;
END$$;


-- Preserve existing exact removal inventories for every newly introduced base
-- Safety epoch source. Do not weaken catalog inventory admission checks.
DO $$DECLARE relation text;BEGIN
 FOREACH relation IN ARRAY ARRAY['account_appeals','account_appeal_open_cases','account_appeal_decisions'] LOOP
 EXECUTE format('CREATE TRIGGER a00_admin_post_removal_source_statement BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_safety.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.admin_post_removal_source_statement_guard()',relation);
 EXECUTE format('CREATE TRIGGER a00_admin_discussion_removal_source_statement BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_safety.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.admin_discussion_removal_source_statement_guard()',relation);
 EXECUTE format('CREATE TRIGGER a_account_moderation_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_safety.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.advance_account_moderation_epoch()',relation);
 END LOOP;
 IF NOT whaleu_community.admin_post_removal_inventory_current() OR NOT whaleu_community.admin_discussion_removal_inventory_current() THEN
 RAISE EXCEPTION 'Account moderation must preserve original complete source inventory' USING ERRCODE='23514';END IF;
END$$;
