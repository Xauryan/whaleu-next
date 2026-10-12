-- Independent append-only logical withdrawal. No old protocol/row rewrite,
-- restoration, physical deletion, media policy or retention TTL.
SET LOCAL lock_timeout='5s';
CREATE TABLE whaleu_majors.major_delete_authority_epoch(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),revision bigint NOT NULL DEFAULT 1 CHECK(revision>0));
INSERT INTO whaleu_majors.major_delete_authority_epoch(singleton) VALUES(true);
CREATE FUNCTION whaleu_majors.major_delete_authority_advance() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN UPDATE whaleu_majors.major_delete_authority_epoch SET revision=revision+1 WHERE singleton;RETURN NULL;END$$;
DO $$DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['whaleu_authorization.role_grants','whaleu_majors.major_catalog_head','whaleu_majors.major_catalogs','whaleu_majors.major_catalog_acceptances','whaleu_majors.major_identities','whaleu_majors.major_entries','whaleu_campus.campuses','whaleu_campus.institutions','whaleu_campus.campus_region_assignments','whaleu_campus.operating_regions'] LOOP
 EXECUTE format('CREATE TRIGGER major_delete_authority_epoch AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION whaleu_majors.major_delete_authority_advance()',t);END LOOP;
END$$;
CREATE TABLE whaleu_majors.major_discussion_delete_commands(
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,session_id uuid NOT NULL REFERENCES whaleu_identity.sessions(id),
 major_id uuid NOT NULL,comment_id uuid NOT NULL,command jsonb NOT NULL,receipt jsonb NOT NULL,
 intent_hash text NOT NULL CHECK(intent_hash~'^[a-f0-9]{64}$'),authority jsonb,transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),PRIMARY KEY(actor_id,request_id),
 CHECK(octet_length(command::text)<=2048 AND octet_length(receipt::text)<=2048 AND octet_length(authority::text)<=50000),
 CHECK(whaleu_majors.major_exact_keys(command,ARRAY['clientRequestId','rootId']) AND whaleu_majors.major_exact_ids(command,ARRAY['clientRequestId']) AND (command->'rootId'='null'::jsonb OR whaleu_majors.major_exact_ids(command,ARRAY['rootId']))),
 CHECK(command->>'clientRequestId' IS NOT DISTINCT FROM request_id::text),
 CHECK(intent_hash=encode(sha256(convert_to('whaleu:major-discussion-delete-command:v1'||chr(10)||whaleu_community.content_canonical_json(jsonb_build_object('actorId',actor_id::text,'majorId',major_id::text,'commentId',comment_id::text,'operation','major.discussion.delete.v1','command',command)),'UTF8')),'hex')),
 CHECK(receipt->>'requestId' IS NOT DISTINCT FROM request_id::text AND receipt->>'majorId' IS NOT DISTINCT FROM major_id::text AND receipt->>'commentId' IS NOT DISTINCT FROM comment_id::text AND receipt->>'operation' IS NOT DISTINCT FROM 'major.discussion.delete.v1' AND receipt->'rootId' IS NOT DISTINCT FROM command->'rootId')
);
CREATE TABLE whaleu_majors.major_discussion_tombstones(
 id uuid PRIMARY KEY,major_id uuid NOT NULL,comment_id uuid NOT NULL UNIQUE,actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',transaction_timestamp()),transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
 UNIQUE(actor_id,request_id),FOREIGN KEY(comment_id,major_id) REFERENCES whaleu_majors.major_discussion_comments(id,major_id),
 FOREIGN KEY(actor_id,request_id) REFERENCES whaleu_majors.major_discussion_delete_commands(actor_id,request_id) DEFERRABLE INITIALLY DEFERRED
);
DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['major_discussion_delete_commands','major_discussion_tombstones'] LOOP
 EXECUTE format('CREATE TRIGGER major_discussion_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_majors.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_majors.major_discussion_immutable()',t);
 EXECUTE format('CREATE TRIGGER major_discussion_epoch AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_majors.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_majors.major_discussion_epoch_advance()',t);
 END LOOP;END$$;
-- Author proof deliberately reads no catalog/history/Review/grant. Admin proof
-- uses the accepted target campus and its current region, never selected campus.
CREATE FUNCTION whaleu_majors.major_delete_authority(actor uuid,mid uuid,cid uuid,root uuid,instant timestamptz) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE c whaleu_majors.major_discussion_comments;s jsonb;region uuid;grants jsonb;BEGIN
 SELECT * INTO c FROM whaleu_majors.major_discussion_comments WHERE id=cid AND major_id=mid AND root_id IS NOT DISTINCT FROM root;
 IF c.id IS NULL THEN RETURN NULL;END IF;
 IF c.actor_id=actor THEN RETURN jsonb_build_object('kind','author','actor',actor,'comment',cid,'major',mid,'root',root);END IF;
 s:=whaleu_majors.major_source(mid,instant);
 IF s IS NULL THEN RETURN NULL;END IF;
 SELECT a.operating_region_id INTO region FROM whaleu_majors.major_entries e JOIN whaleu_campus.campus_region_assignments a ON a.campus_id=e.campus_id WHERE e.major_id=mid AND e.catalog_id=(s->>'catalog')::uuid AND e.is_active;
 IF region IS NULL OR NOT EXISTS(SELECT 1 FROM whaleu_majors.major_delete_authority_epoch WHERE singleton) THEN RETURN NULL;END IF;
 SELECT jsonb_agg(to_jsonb(g) ORDER BY g.id) INTO grants FROM whaleu_authorization.role_grants g WHERE g.account_id=actor AND g.revoked_at IS NULL AND g.valid_from<=instant AND(g.expires_at IS NULL OR g.expires_at>instant) AND((g.role='super_admin' AND g.operating_region_id IS NULL) OR(g.role='school_admin' AND g.operating_region_id=region));
 IF grants IS NULL THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('kind','administrator','source',s,'region',region,'grants',grants,'epoch',(SELECT revision::text FROM whaleu_majors.major_delete_authority_epoch WHERE singleton));
END$$;
CREATE FUNCTION whaleu_majors.major_delete_fence(administrator boolean) RETURNS void LANGUAGE plpgsql VOLATILE AS $$BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Delete requires read committed' USING ERRCODE='23514',CONSTRAINT='major_discussion_causal';END IF;
 LOCK TABLE whaleu_majors.major_discussion_comments,whaleu_majors.major_discussion_delete_commands,whaleu_majors.major_discussion_tombstones,whaleu_majors.major_discussion_epoch,whaleu_identity.accounts,whaleu_identity.sessions,whaleu_verification.account_heads,whaleu_verification.snapshots,whaleu_verification.assertions,whaleu_safety.account_heads IN SHARE MODE NOWAIT;
 IF NOT EXISTS(SELECT 1 FROM whaleu_majors.major_discussion_epoch WHERE singleton) THEN RAISE EXCEPTION 'Delete content epoch unavailable' USING ERRCODE='23514',CONSTRAINT='major_discussion_causal';END IF;
 IF administrator THEN PERFORM whaleu_majors.major_fence();LOCK TABLE whaleu_majors.major_delete_authority_epoch IN SHARE MODE NOWAIT;IF NOT EXISTS(SELECT 1 FROM whaleu_majors.major_delete_authority_epoch WHERE singleton) THEN RAISE EXCEPTION 'Delete authority epoch unavailable' USING ERRCODE='23514',CONSTRAINT='major_discussion_causal';END IF;END IF;
END$$;
-- Preserve the old policy behind a tombstone short circuit. Ancestor policy
-- already invokes this function, so a root withdraws every descendant at once.
ALTER FUNCTION whaleu_majors.major_discussion_visibility_base(uuid,uuid,timestamptz) RENAME TO major_discussion_visibility_without_tombstone;
CREATE FUNCTION whaleu_majors.major_discussion_visibility_base(cid uuid,viewer uuid,instant timestamptz) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN EXISTS(SELECT 1 FROM whaleu_majors.major_discussion_tombstones WHERE comment_id=cid) THEN 'deny' ELSE whaleu_majors.major_discussion_visibility_without_tombstone(cid,viewer,instant) END
$$;
-- SQL functions retain parsed dependencies in some server versions; replace
-- this body explicitly so ancestors always use the newly named wrapper.
CREATE OR REPLACE FUNCTION whaleu_majors.major_discussion_visibility(cid uuid,viewer uuid,instant timestamptz) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT CASE WHEN own.status='deny' OR parent.status='deny' THEN 'deny' WHEN own.status='allow' AND parent.status='allow' THEN 'allow' ELSE 'unavailable' END FROM whaleu_majors.major_discussion_comments c CROSS JOIN LATERAL(SELECT whaleu_majors.major_discussion_visibility_base(c.id,viewer,instant) status) own CROSS JOIN LATERAL(SELECT CASE WHEN c.root_id IS NULL THEN 'allow' ELSE whaleu_majors.major_discussion_visibility_base(c.root_id,viewer,instant) END status) parent WHERE c.id=cid),'unavailable')
$$;
ALTER FUNCTION whaleu_majors.major_discussion_fence() RENAME TO major_discussion_fence_before_delete;
CREATE FUNCTION whaleu_majors.major_discussion_fence() RETURNS void LANGUAGE plpgsql VOLATILE AS $$BEGIN
 PERFORM whaleu_majors.major_discussion_fence_before_delete();
 LOCK TABLE whaleu_majors.major_discussion_tombstones,whaleu_majors.major_discussion_delete_commands IN SHARE MODE NOWAIT;
END$$;
CREATE FUNCTION whaleu_majors.major_delete_lock(actor uuid,rid uuid,cid uuid) RETURNS void LANGUAGE plpgsql VOLATILE AS $$BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:major-delete-command:v1:'||actor::text||':'||rid::text,0));
 IF cid IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:major-delete-subject:v1:'||cid::text,0));END IF;
END$$;
CREATE FUNCTION whaleu_majors.major_delete_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM whaleu_majors.major_delete_lock(NEW.actor_id,NEW.request_id,NEW.comment_id);RETURN NEW;END$$;
CREATE TRIGGER major_delete_lock BEFORE INSERT ON whaleu_majors.major_discussion_delete_commands FOR EACH ROW EXECUTE FUNCTION whaleu_majors.major_delete_insert_guard();
CREATE TRIGGER major_delete_lock BEFORE INSERT ON whaleu_majors.major_discussion_tombstones FOR EACH ROW EXECUTE FUNCTION whaleu_majors.major_delete_insert_guard();
CREATE FUNCTION whaleu_majors.major_delete_complete(actor uuid,rid uuid) RETURNS void LANGUAGE plpgsql VOLATILE AS $$
DECLARE q whaleu_majors.major_discussion_delete_commands;t whaleu_majors.major_discussion_tombstones;instant timestamptz;expected jsonb;BEGIN
 SELECT * INTO q FROM whaleu_majors.major_discussion_delete_commands WHERE actor_id=actor AND request_id=rid;
 IF q.receipt->>'outcome'='rejected' THEN
  LOCK TABLE whaleu_identity.accounts,whaleu_identity.sessions,whaleu_majors.major_discussion_delete_commands IN SHARE MODE NOWAIT;
 ELSE PERFORM whaleu_majors.major_delete_fence(coalesce(q.authority->>'kind'='administrator',false));END IF;instant:=clock_timestamp();
 IF q.request_id IS NULL OR q.transaction_id<>pg_current_xact_id() OR NOT whaleu_identity.major_rating_session(actor,q.session_id,instant) THEN RAISE EXCEPTION 'Exact actor session and delete command required' USING ERRCODE='23514',CONSTRAINT='major_discussion_causal';END IF;
 SELECT * INTO t FROM whaleu_majors.major_discussion_tombstones WHERE comment_id=q.comment_id;
 IF q.receipt->>'outcome'='rejected' THEN
  IF NOT whaleu_majors.major_exact_keys(q.receipt,ARRAY['requestId','operation','majorId','commentId','rootId','outcome','code']) OR q.receipt->>'code' IS DISTINCT FROM 'MAJOR_DISCUSSION_CANCELLED' OR q.authority IS NOT NULL OR EXISTS(SELECT 1 FROM whaleu_majors.major_discussion_tombstones WHERE actor_id=actor AND request_id=rid) THEN RAISE EXCEPTION 'Cancel cannot delete' USING ERRCODE='23514',CONSTRAINT='major_discussion_causal';END IF;RETURN;
 END IF;
 IF NOT whaleu_majors.major_access(actor,q.session_id,instant) THEN RAISE EXCEPTION 'New withdrawal needs phone and Safety' USING ERRCODE='23514',CONSTRAINT='major_discussion_causal';END IF;
 expected:=whaleu_majors.major_delete_authority(actor,q.major_id,q.comment_id,(q.command->>'rootId')::uuid,instant);
 IF expected IS NULL OR q.authority IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Exact independent current withdrawal authority required' USING ERRCODE='23514',CONSTRAINT='major_discussion_causal';END IF;
 IF NOT whaleu_majors.major_exact_keys(q.receipt,ARRAY['requestId','operation','majorId','commentId','rootId','outcome','tombstoneId','recordedAt']) OR t.id IS NULL OR t.major_id<>q.major_id OR q.receipt->>'tombstoneId' IS DISTINCT FROM t.id::text OR q.receipt->>'recordedAt' IS DISTINCT FROM to_char(t.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') THEN RAISE EXCEPTION 'Exact durable tombstone receipt required' USING ERRCODE='23514',CONSTRAINT='major_discussion_causal';END IF;
 IF q.receipt->>'outcome'='applied' THEN
  IF(t.actor_id,t.request_id,t.transaction_id,t.recorded_at) IS DISTINCT FROM(actor,rid,pg_current_xact_id(),date_trunc('milliseconds',transaction_timestamp())) THEN RAISE EXCEPTION 'Applied delete needs atomic tombstone' USING ERRCODE='23514',CONSTRAINT='major_discussion_causal';END IF;
 ELSIF q.receipt->>'outcome'='noop' THEN
  IF(t.actor_id,t.request_id) IS NOT DISTINCT FROM(actor,rid) THEN RAISE EXCEPTION 'Noop cannot create tombstone' USING ERRCODE='23514',CONSTRAINT='major_discussion_causal';END IF;
 ELSE RAISE EXCEPTION 'Invalid delete outcome' USING ERRCODE='23514',CONSTRAINT='major_discussion_causal';END IF;
END$$;
CREATE FUNCTION whaleu_majors.major_delete_final() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM whaleu_majors.major_delete_complete(NEW.actor_id,NEW.request_id);RETURN NULL;END$$;
CREATE CONSTRAINT TRIGGER major_delete_final AFTER INSERT ON whaleu_majors.major_discussion_delete_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_majors.major_delete_final();
CREATE CONSTRAINT TRIGGER major_delete_final AFTER INSERT ON whaleu_majors.major_discussion_tombstones DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_majors.major_delete_final();
