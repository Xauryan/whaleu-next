-- W3 named text roots, flat replies, reversible likes and local notices.
-- Empty owner storage only. No production source/history, Review or creator mapping.
SET LOCAL lock_timeout='5s';
CREATE FUNCTION whaleu_ratings.window_discussion_body_valid(value text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT coalesce(octet_length(value) BETWEEN 1 AND 8000 AND length(btrim(value,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'))>0,false)
$$;
CREATE TABLE whaleu_ratings.window_discussion_history_assertions(
 id uuid PRIMARY KEY,window_id uuid NOT NULL REFERENCES whaleu_ratings.window_identities(id),kind text NOT NULL CHECK(kind IN('population','likes')),
 coverage text NOT NULL CHECK(coverage IN('accepted_empty','unknown')),source_reference text NOT NULL CHECK(length(btrim(source_reference)) BETWEEN 1 AND 2000),policy_reference text NOT NULL CHECK(length(btrim(policy_reference)) BETWEEN 1 AND 2000),
 accepted_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(accepted_at)),valid_until timestamptz NOT NULL CHECK(isfinite(valid_until) AND valid_until>accepted_at),UNIQUE(id,window_id,kind)
);
CREATE TABLE whaleu_ratings.window_discussion_history_heads(window_id uuid NOT NULL,kind text NOT NULL,assertion_id uuid NOT NULL,PRIMARY KEY(window_id,kind),FOREIGN KEY(assertion_id,window_id,kind) REFERENCES whaleu_ratings.window_discussion_history_assertions(id,window_id,kind));
CREATE TABLE whaleu_ratings.window_discussion_epoch(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),revision bigint NOT NULL DEFAULT 1 CHECK(revision>0));
INSERT INTO whaleu_ratings.window_discussion_epoch(singleton) VALUES(true);
CREATE TABLE whaleu_community.window_discussion_review_policies(
 id uuid PRIMARY KEY,issuer text NOT NULL CHECK(length(btrim(issuer)) BETWEEN 1 AND 200),source_reference text NOT NULL CHECK(length(btrim(source_reference)) BETWEEN 1 AND 2000),coverage text NOT NULL CHECK(coverage IN('complete','unknown')),
 valid_from timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(valid_from)),valid_until timestamptz NOT NULL CHECK(isfinite(valid_until) AND valid_until>valid_from)
);
CREATE TABLE whaleu_community.window_discussion_review_decisions(
 id uuid PRIMARY KEY,actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,window_id uuid NOT NULL REFERENCES whaleu_ratings.window_identities(id),catalog_id uuid NOT NULL,window_revision uuid NOT NULL,
 purpose text NOT NULL CHECK(purpose IN('window.discussion.root.v1','window.discussion.reply.v1')),root_id uuid,reply_to_reply_id uuid,reply_to_actor_id uuid REFERENCES whaleu_identity.accounts(id),body text NOT NULL CHECK(whaleu_ratings.window_discussion_body_valid(body)),
 policy_id uuid NOT NULL REFERENCES whaleu_community.window_discussion_review_policies(id),verdict text NOT NULL CHECK(verdict IN('allow','reject')),digest text NOT NULL,
 issued_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(issued_at)),consume_until timestamptz NOT NULL CHECK(isfinite(consume_until) AND consume_until>issued_at),visibility_until timestamptz NOT NULL CHECK(isfinite(visibility_until) AND visibility_until>issued_at),
 FOREIGN KEY(catalog_id,window_id,window_revision) REFERENCES whaleu_ratings.window_entries(catalog_id,window_id,revision),UNIQUE(id,actor_id,request_id),
 CHECK((purpose='window.discussion.reply.v1')=(root_id IS NOT NULL)),CHECK((reply_to_reply_id IS NULL)=(reply_to_actor_id IS NULL)),CHECK(root_id IS NOT NULL OR reply_to_reply_id IS NULL),
 CHECK(digest=encode(sha256(convert_to('whaleu:window-discussion-review:v1'||chr(10)||whaleu_community.content_canonical_json(jsonb_build_object('version',1,'purpose',purpose,'actorId',actor_id::text,'requestId',request_id::text,'windowId',window_id::text,'catalogRevision',catalog_id::text,'windowRevision',window_revision::text,'body',body,'rootId',root_id::text,'replyToReplyId',reply_to_reply_id::text,'replyToActorId',reply_to_actor_id::text)),'UTF8')),'hex'))
);
CREATE TABLE whaleu_community.window_discussion_review_heads(actor_id uuid NOT NULL,request_id uuid NOT NULL,decision_id uuid NOT NULL,state text NOT NULL CHECK(state IN('active','revoked')),PRIMARY KEY(actor_id,request_id),FOREIGN KEY(decision_id,actor_id,request_id) REFERENCES whaleu_community.window_discussion_review_decisions(id,actor_id,request_id));
CREATE TABLE whaleu_community.window_discussion_review_epoch(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),revision bigint NOT NULL DEFAULT 1 CHECK(revision>0));
INSERT INTO whaleu_community.window_discussion_review_epoch(singleton) VALUES(true);
CREATE TABLE whaleu_ratings.window_discussion_commands(
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,session_id uuid NOT NULL REFERENCES whaleu_identity.sessions(id),window_id uuid NOT NULL REFERENCES whaleu_ratings.window_identities(id),subject_id uuid,
 operation text NOT NULL CHECK(operation IN('window.discussion.root.v1','window.discussion.reply.v1','window.discussion.like.v1')),
 command jsonb NOT NULL CHECK(jsonb_typeof(command)='object' AND octet_length(command::text)<=50000),intent_hash text NOT NULL CHECK(intent_hash~'^[a-f0-9]{64}$'),receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt)='object' AND octet_length(receipt::text)<=2048),transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),PRIMARY KEY(actor_id,request_id),
 CHECK((operation='window.discussion.root.v1')=(subject_id IS NULL)),
 CHECK(intent_hash=encode(sha256(convert_to('whaleu:window-discussion-command:v1'||chr(10)||whaleu_community.content_canonical_json(jsonb_build_object('actorId',actor_id::text,'windowId',window_id::text,'subjectId',subject_id::text,'operation',operation,'command',command)),'UTF8')),'hex')),
 CHECK((command->>'clientRequestId') IS NOT DISTINCT FROM request_id::text),CHECK((receipt->>'requestId') IS NOT DISTINCT FROM request_id::text AND (receipt->>'windowId') IS NOT DISTINCT FROM window_id::text AND (receipt->>'operation') IS NOT DISTINCT FROM operation)
);
CREATE TABLE whaleu_ratings.window_discussion_comments(
 id uuid PRIMARY KEY,window_id uuid NOT NULL REFERENCES whaleu_ratings.window_identities(id),root_id uuid,reply_to_reply_id uuid,reply_to_actor_id uuid REFERENCES whaleu_identity.accounts(id),actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,
 catalog_id uuid NOT NULL,window_revision uuid NOT NULL,population_assertion_id uuid NOT NULL REFERENCES whaleu_ratings.window_discussion_history_assertions(id),review_decision_id uuid NOT NULL UNIQUE REFERENCES whaleu_community.window_discussion_review_decisions(id),
 body text NOT NULL CHECK(whaleu_ratings.window_discussion_body_valid(body)),created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',transaction_timestamp()),transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
 UNIQUE(actor_id,request_id),UNIQUE(id,window_id),UNIQUE(id,window_id,root_id),FOREIGN KEY(root_id,window_id) REFERENCES whaleu_ratings.window_discussion_comments(id,window_id),FOREIGN KEY(reply_to_reply_id,window_id,root_id) REFERENCES whaleu_ratings.window_discussion_comments(id,window_id,root_id),
 FOREIGN KEY(actor_id,request_id) REFERENCES whaleu_ratings.window_discussion_commands(actor_id,request_id) DEFERRABLE INITIALLY DEFERRED,FOREIGN KEY(catalog_id,window_id,window_revision) REFERENCES whaleu_ratings.window_entries(catalog_id,window_id,revision),
 CHECK(root_id IS DISTINCT FROM id AND reply_to_reply_id IS DISTINCT FROM id),CHECK((reply_to_reply_id IS NULL)=(reply_to_actor_id IS NULL)),CHECK(root_id IS NOT NULL OR reply_to_reply_id IS NULL)
);
CREATE TABLE whaleu_ratings.window_discussion_like_events(
 id uuid PRIMARY KEY,window_id uuid NOT NULL,comment_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,previous_revision uuid,active boolean NOT NULL,
 catalog_id uuid,window_revision uuid,population_assertion_id uuid REFERENCES whaleu_ratings.window_discussion_history_assertions(id),likes_assertion_id uuid REFERENCES whaleu_ratings.window_discussion_history_assertions(id),
 recorded_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',transaction_timestamp()),transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
 UNIQUE(actor_id,request_id),UNIQUE(window_id,comment_id,actor_id,id),UNIQUE(window_id,comment_id,actor_id,transaction_id),
 FOREIGN KEY(comment_id,window_id) REFERENCES whaleu_ratings.window_discussion_comments(id,window_id),FOREIGN KEY(window_id,comment_id,actor_id,previous_revision) REFERENCES whaleu_ratings.window_discussion_like_events(window_id,comment_id,actor_id,id),
 FOREIGN KEY(actor_id,request_id) REFERENCES whaleu_ratings.window_discussion_commands(actor_id,request_id) DEFERRABLE INITIALLY DEFERRED,FOREIGN KEY(catalog_id,window_id,window_revision) REFERENCES whaleu_ratings.window_entries(catalog_id,window_id,revision),
 CHECK((active AND catalog_id IS NOT NULL AND window_revision IS NOT NULL AND population_assertion_id IS NOT NULL AND likes_assertion_id IS NOT NULL) OR (NOT active AND previous_revision IS NOT NULL AND catalog_id IS NULL AND window_revision IS NULL AND population_assertion_id IS NULL AND likes_assertion_id IS NULL))
);
CREATE TABLE whaleu_ratings.window_discussion_like_heads(window_id uuid NOT NULL,comment_id uuid NOT NULL,actor_id uuid NOT NULL,revision uuid NOT NULL,PRIMARY KEY(window_id,comment_id,actor_id),FOREIGN KEY(window_id,comment_id,actor_id,revision) REFERENCES whaleu_ratings.window_discussion_like_events(window_id,comment_id,actor_id,id));
CREATE TABLE whaleu_notifications.window_discussion_notices(
 id uuid PRIMARY KEY,recipient_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN('reply','like')),event_id uuid NOT NULL,window_id uuid NOT NULL,comment_id uuid NOT NULL,root_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',transaction_timestamp()),transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),UNIQUE(kind,event_id,recipient_id),UNIQUE(id,recipient_id),CHECK(recipient_id<>actor_id),
 FOREIGN KEY(actor_id,request_id) REFERENCES whaleu_ratings.window_discussion_commands(actor_id,request_id) DEFERRABLE INITIALLY DEFERRED,FOREIGN KEY(comment_id,window_id) REFERENCES whaleu_ratings.window_discussion_comments(id,window_id),FOREIGN KEY(root_id,window_id) REFERENCES whaleu_ratings.window_discussion_comments(id,window_id)
);
CREATE TABLE whaleu_notifications.window_discussion_reads(notice_id uuid PRIMARY KEY,recipient_id uuid NOT NULL,session_id uuid NOT NULL REFERENCES whaleu_identity.sessions(id),read_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',transaction_timestamp()),FOREIGN KEY(notice_id,recipient_id) REFERENCES whaleu_notifications.window_discussion_notices(id,recipient_id));
CREATE INDEX window_discussion_order ON whaleu_ratings.window_discussion_comments(window_id,root_id,created_at,id);
CREATE INDEX window_discussion_notice_order ON whaleu_notifications.window_discussion_notices(recipient_id,created_at DESC,id DESC);
CREATE FUNCTION whaleu_ratings.window_discussion_immutable() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'Window discussion accepted evidence, events and receipts are immutable' USING ERRCODE='23514',CONSTRAINT='window_discussion_causal';END$$;
CREATE FUNCTION whaleu_ratings.window_discussion_epoch_advance() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN UPDATE whaleu_ratings.window_discussion_epoch SET revision=revision+1 WHERE singleton;RETURN NULL;END$$;
CREATE FUNCTION whaleu_community.window_discussion_review_epoch_advance() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN UPDATE whaleu_community.window_discussion_review_epoch SET revision=revision+1 WHERE singleton;RETURN NULL;END$$;
DO $$DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['window_discussion_history_assertions','window_discussion_history_heads','window_discussion_comments','window_discussion_like_heads'] LOOP EXECUTE format('CREATE TRIGGER window_discussion_epoch AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_ratings.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.window_discussion_epoch_advance()',t);END LOOP;
 FOREACH t IN ARRAY ARRAY['window_discussion_history_assertions','window_discussion_comments','window_discussion_like_events','window_discussion_commands'] LOOP EXECUTE format('CREATE TRIGGER window_discussion_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_ratings.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.window_discussion_immutable()',t);END LOOP;
 FOREACH t IN ARRAY ARRAY['window_discussion_review_policies','window_discussion_review_decisions','window_discussion_review_heads'] LOOP EXECUTE format('CREATE TRIGGER window_discussion_review_epoch AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.window_discussion_review_epoch_advance()',t);END LOOP;
 FOREACH t IN ARRAY ARRAY['window_discussion_review_policies','window_discussion_review_decisions'] LOOP EXECUTE format('CREATE TRIGGER window_discussion_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_community.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.window_discussion_immutable()',t);END LOOP;
 FOREACH t IN ARRAY ARRAY['window_discussion_notices','window_discussion_reads'] LOOP EXECUTE format('CREATE TRIGGER window_discussion_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_notifications.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.window_discussion_immutable()',t);END LOOP;
END$$;
CREATE TRIGGER window_discussion_head_no_delete BEFORE DELETE OR TRUNCATE ON whaleu_ratings.window_discussion_like_heads FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.window_discussion_immutable();
CREATE FUNCTION whaleu_community.window_discussion_review_status(did uuid,consume boolean,instant timestamptz) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT CASE WHEN h.state='revoked' THEN 'deny' WHEN p.coverage<>'complete' OR p.valid_from>d.issued_at OR d.issued_at>instant OR p.valid_until<=instant OR d.visibility_until<=instant OR (consume AND d.consume_until<=instant) THEN 'unavailable' ELSE d.verdict END FROM whaleu_community.window_discussion_review_decisions d JOIN whaleu_community.window_discussion_review_policies p ON p.id=d.policy_id JOIN whaleu_community.window_discussion_review_heads h ON h.decision_id=d.id AND h.actor_id=d.actor_id AND h.request_id=d.request_id WHERE d.id=did),'unavailable')
$$;
-- Named Window direct policy: both block directions suppress identity and text.
CREATE FUNCTION whaleu_safety.window_discussion_named(viewer uuid,author uuid,instant timestamptz) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN EXISTS(SELECT 1 FROM whaleu_safety.account_heads WHERE account_id IN(viewer,author) AND (restriction_coverage<>'complete' OR block_coverage<>'complete' OR provenance='unknown' OR (valid_until IS NOT NULL AND valid_until<=instant))) OR (SELECT count(*) FROM whaleu_safety.account_heads WHERE account_id IN(viewer,author))<>CASE WHEN viewer=author THEN 1 ELSE 2 END THEN 'unavailable'
 WHEN EXISTS(SELECT 1 FROM whaleu_safety.account_heads WHERE account_id=author AND NOT actions_allowed) OR EXISTS(SELECT 1 FROM whaleu_safety.blocks WHERE active AND ((blocker_id=viewer AND blocked_id=author) OR(blocker_id=author AND blocked_id=viewer))) THEN 'deny' ELSE 'allow' END
$$;
CREATE FUNCTION whaleu_profile.window_discussion_display_known(actor uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT EXISTS(SELECT 1 FROM whaleu_profile.profiles WHERE account_id=actor)$$;
CREATE FUNCTION whaleu_ratings.window_discussion_visibility_base(cid uuid,viewer uuid,instant timestamptz) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT CASE WHEN r.status IN('deny','reject') OR s.status='deny' THEN 'deny' WHEN r.status='allow' AND s.status='allow' AND whaleu_profile.window_discussion_display_known(c.actor_id) THEN 'allow' ELSE 'unavailable' END FROM whaleu_ratings.window_discussion_comments c CROSS JOIN LATERAL(SELECT whaleu_community.window_discussion_review_status(c.review_decision_id,false,instant) status) r CROSS JOIN LATERAL(SELECT whaleu_safety.window_discussion_named(viewer,c.actor_id,instant) status) s WHERE c.id=cid),'unavailable')
$$;
CREATE FUNCTION whaleu_ratings.window_discussion_visibility(cid uuid,viewer uuid,instant timestamptz) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT CASE WHEN own.status='deny' OR parent.status='deny' THEN 'deny' WHEN own.status='allow' AND parent.status='allow' THEN 'allow' ELSE 'unavailable' END FROM whaleu_ratings.window_discussion_comments c CROSS JOIN LATERAL(SELECT whaleu_ratings.window_discussion_visibility_base(c.id,viewer,instant) status) own CROSS JOIN LATERAL(SELECT CASE WHEN c.root_id IS NULL THEN 'allow' ELSE whaleu_ratings.window_discussion_visibility_base(c.root_id,viewer,instant) END status) parent WHERE c.id=cid),'unavailable')
$$;
CREATE FUNCTION whaleu_ratings.window_discussion_history(wid uuid,hkind text,instant timestamptz) RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT a.id FROM whaleu_ratings.window_discussion_history_heads h JOIN whaleu_ratings.window_discussion_history_assertions a ON a.id=h.assertion_id AND a.window_id=h.window_id AND a.kind=h.kind WHERE h.window_id=wid AND h.kind=hkind AND a.coverage='accepted_empty' AND a.accepted_at<=instant AND a.valid_until>instant
$$;
CREATE FUNCTION whaleu_ratings.window_discussion_source(wid uuid,instant timestamptz) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN s IS NOT NULL THEN jsonb_build_object('catalog',s->>'catalog','revision',s->>'revision','population',whaleu_ratings.window_discussion_history(wid,'population',instant),'likes',whaleu_ratings.window_discussion_history(wid,'likes',instant)) END FROM(SELECT whaleu_ratings.window_source(wid,instant) s) source
$$;
CREATE FUNCTION whaleu_ratings.window_discussion_deadline(wid uuid,instant timestamptz) RETURNS timestamptz LANGUAGE sql STABLE AS $$
 SELECT min(value) FROM(
 SELECT boundary.value FROM whaleu_ratings.window_discussion_history_heads h JOIN whaleu_ratings.window_discussion_history_assertions a ON a.id=h.assertion_id CROSS JOIN LATERAL(VALUES(a.accepted_at),(a.valid_until)) boundary(value) WHERE h.window_id=wid AND boundary.value>instant
 UNION ALL SELECT boundary.value FROM whaleu_ratings.window_discussion_comments c JOIN whaleu_community.window_discussion_review_decisions d ON d.id=c.review_decision_id JOIN whaleu_community.window_discussion_review_policies p ON p.id=d.policy_id LEFT JOIN whaleu_safety.account_heads s ON s.account_id=c.actor_id CROSS JOIN LATERAL(VALUES(d.issued_at),(d.visibility_until),(p.valid_from),(p.valid_until),(s.valid_until)) boundary(value) WHERE c.window_id=wid AND boundary.value>instant
 ) boundaries
$$;
CREATE FUNCTION whaleu_ratings.window_discussion_fence() RETURNS void LANGUAGE plpgsql VOLATILE AS $$BEGIN
 PERFORM whaleu_ratings.window_fence();
 LOCK TABLE whaleu_ratings.window_discussion_history_assertions,whaleu_ratings.window_discussion_history_heads,whaleu_ratings.window_discussion_comments,whaleu_ratings.window_discussion_like_events,whaleu_ratings.window_discussion_like_heads,whaleu_ratings.window_discussion_commands,whaleu_ratings.window_discussion_epoch,whaleu_community.window_discussion_review_policies,whaleu_community.window_discussion_review_decisions,whaleu_community.window_discussion_review_heads,whaleu_community.window_discussion_review_epoch,whaleu_safety.blocks,whaleu_profile.profiles,whaleu_notifications.window_discussion_notices IN SHARE MODE NOWAIT;
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.window_discussion_epoch WHERE singleton) OR NOT EXISTS(SELECT 1 FROM whaleu_community.window_discussion_review_epoch WHERE singleton) THEN RAISE EXCEPTION 'Window discussion epochs unavailable' USING ERRCODE='23514',CONSTRAINT='window_discussion_causal';END IF;
END$$;
CREATE FUNCTION whaleu_ratings.window_discussion_lock(actor uuid,rid uuid,subject uuid) RETURNS void LANGUAGE plpgsql AS $$BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Window discussion needs read committed' USING ERRCODE='23514',CONSTRAINT='window_discussion_causal';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:window-discussion-request:v1:'||actor::text||':'||rid::text,0));
 IF subject IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:window-discussion-like:v1:'||actor::text||':'||subject::text,0));END IF;
END$$;
CREATE FUNCTION whaleu_ratings.window_discussion_command_lock() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM whaleu_ratings.window_discussion_lock(NEW.actor_id,NEW.request_id,CASE WHEN NEW.operation='window.discussion.like.v1' THEN NEW.subject_id END);RETURN NEW;END$$;
CREATE TRIGGER window_discussion_command_lock BEFORE INSERT ON whaleu_ratings.window_discussion_commands FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.window_discussion_command_lock();
CREATE FUNCTION whaleu_ratings.window_discussion_like_guard() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE own whaleu_ratings.window_discussion_like_events;BEGIN
 PERFORM whaleu_ratings.window_discussion_lock(NEW.actor_id,NEW.request_id,NEW.comment_id);
 SELECT e.* INTO own FROM whaleu_ratings.window_discussion_like_heads h JOIN whaleu_ratings.window_discussion_like_events e ON e.id=h.revision WHERE h.window_id=NEW.window_id AND h.comment_id=NEW.comment_id AND h.actor_id=NEW.actor_id;
 IF NEW.transaction_id<>pg_current_xact_id() OR NEW.recorded_at<>date_trunc('milliseconds',transaction_timestamp()) OR NEW.previous_revision IS DISTINCT FROM own.id OR NEW.active=coalesce(own.active,false) THEN RAISE EXCEPTION 'Like event needs exact changing predecessor' USING ERRCODE='23514',CONSTRAINT='window_discussion_causal';END IF;RETURN NEW;
END$$;
CREATE TRIGGER window_discussion_like_guard BEFORE INSERT ON whaleu_ratings.window_discussion_like_events FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.window_discussion_like_guard();
CREATE FUNCTION whaleu_ratings.window_discussion_head_guard() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE e whaleu_ratings.window_discussion_like_events;previous uuid;BEGIN
 SELECT * INTO e FROM whaleu_ratings.window_discussion_like_events WHERE id=NEW.revision AND window_id=NEW.window_id AND comment_id=NEW.comment_id AND actor_id=NEW.actor_id;
 IF e.id IS NULL THEN RAISE EXCEPTION 'Like head needs exact event' USING ERRCODE='23514',CONSTRAINT='window_discussion_causal';END IF;
 PERFORM whaleu_ratings.window_discussion_lock(e.actor_id,e.request_id,e.comment_id);
 IF TG_OP='UPDATE' THEN previous:=OLD.revision;IF(NEW.window_id,NEW.comment_id,NEW.actor_id) IS DISTINCT FROM(OLD.window_id,OLD.comment_id,OLD.actor_id) THEN RAISE EXCEPTION 'Like identity immutable' USING ERRCODE='23514',CONSTRAINT='window_discussion_causal';END IF;END IF;
 IF e.transaction_id<>pg_current_xact_id() OR e.previous_revision IS DISTINCT FROM previous THEN RAISE EXCEPTION 'Like head needs new atomic predecessor event' USING ERRCODE='23514',CONSTRAINT='window_discussion_causal';END IF;RETURN NEW;
END$$;
CREATE TRIGGER window_discussion_head_guard BEFORE INSERT OR UPDATE ON whaleu_ratings.window_discussion_like_heads FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.window_discussion_head_guard();
-- Exact local notice obligation. Relikes use distinct transition IDs, never a
-- lifetime actor/subject dedupe. Creator notices remain explicitly gated.
CREATE FUNCTION whaleu_notifications.window_discussion_expected(actor uuid,rid uuid) RETURNS TABLE(recipient_id uuid,kind text,event_id uuid,window_id uuid,comment_id uuid,root_id uuid) LANGUAGE sql STABLE AS $$
 SELECT recipient,'reply',c.id,c.window_id,c.id,c.root_id FROM whaleu_ratings.window_discussion_comments c JOIN whaleu_ratings.window_discussion_comments root ON root.id=c.root_id CROSS JOIN LATERAL(SELECT root.actor_id recipient UNION SELECT c.reply_to_actor_id) recipients WHERE c.actor_id=actor AND c.request_id=rid AND recipient IS NOT NULL AND recipient<>actor
 UNION ALL SELECT c.actor_id,'like',e.id,e.window_id,e.comment_id,coalesce(c.root_id,c.id) FROM whaleu_ratings.window_discussion_like_events e JOIN whaleu_ratings.window_discussion_comments c ON c.id=e.comment_id WHERE e.actor_id=actor AND e.request_id=rid AND e.active AND c.actor_id<>actor
$$;
CREATE FUNCTION whaleu_ratings.window_discussion_complete(actor uuid,rid uuid) RETURNS void LANGUAGE plpgsql VOLATILE AS $$
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
CREATE FUNCTION whaleu_ratings.window_discussion_final() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM whaleu_ratings.window_discussion_complete(NEW.actor_id,NEW.request_id);RETURN NULL;END$$;
DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['window_discussion_commands','window_discussion_comments','window_discussion_like_events'] LOOP EXECUTE format('CREATE CONSTRAINT TRIGGER window_discussion_final AFTER INSERT ON whaleu_ratings.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.window_discussion_final()',t);END LOOP;END$$;
CREATE CONSTRAINT TRIGGER window_discussion_notice_final AFTER INSERT ON whaleu_notifications.window_discussion_notices DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.window_discussion_final();
CREATE FUNCTION whaleu_ratings.window_discussion_head_final() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE e whaleu_ratings.window_discussion_like_events;BEGIN SELECT * INTO e FROM whaleu_ratings.window_discussion_like_events WHERE id=NEW.revision;PERFORM whaleu_ratings.window_discussion_complete(e.actor_id,e.request_id);RETURN NULL;END$$;
CREATE CONSTRAINT TRIGGER window_discussion_head_final AFTER INSERT OR UPDATE ON whaleu_ratings.window_discussion_like_heads DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.window_discussion_head_final();
CREATE FUNCTION whaleu_ratings.window_discussion_statement_final() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE q record;BEGIN FOR q IN SELECT actor_id,request_id FROM inserted LOOP PERFORM whaleu_ratings.window_discussion_complete(q.actor_id,q.request_id);END LOOP;RETURN NULL;END$$;
CREATE TRIGGER window_discussion_statement_final AFTER INSERT ON whaleu_ratings.window_discussion_commands REFERENCING NEW TABLE AS inserted FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.window_discussion_statement_final();
CREATE FUNCTION whaleu_notifications.window_discussion_read_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.read_at<>date_trunc('milliseconds',transaction_timestamp()) OR NOT whaleu_identity.window_rating_session(NEW.recipient_id,NEW.session_id,clock_timestamp()) THEN RAISE EXCEPTION 'Current notice owner required' USING ERRCODE='23514',CONSTRAINT='window_discussion_causal';END IF;RETURN NEW;END$$;
CREATE TRIGGER window_discussion_read_guard BEFORE INSERT ON whaleu_notifications.window_discussion_reads FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.window_discussion_read_guard();
CREATE TABLE whaleu_notifications.window_discussion_epoch(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),revision bigint NOT NULL DEFAULT 1 CHECK(revision>0));
INSERT INTO whaleu_notifications.window_discussion_epoch(singleton) VALUES(true);
CREATE FUNCTION whaleu_notifications.window_discussion_epoch_advance() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN UPDATE whaleu_notifications.window_discussion_epoch SET revision=revision+1 WHERE singleton;RETURN NULL;END$$;
CREATE TRIGGER window_discussion_notice_epoch AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_notifications.window_discussion_notices FOR EACH STATEMENT EXECUTE FUNCTION whaleu_notifications.window_discussion_epoch_advance();
CREATE TRIGGER window_discussion_read_epoch AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_notifications.window_discussion_reads FOR EACH STATEMENT EXECUTE FUNCTION whaleu_notifications.window_discussion_epoch_advance();
-- Current reader access is separate from source availability. An already-expired
-- catalog cannot veto a private unavailable notice shell or owner-only closure.
CREATE FUNCTION whaleu_ratings.window_discussion_access_deadline(actor uuid,sid uuid,instant timestamptz) RETURNS timestamptz LANGUAGE sql STABLE AS $$
 SELECT min(deadline) FROM(
 SELECT least(s.access_expires_at,s.absolute_expires_at) deadline FROM whaleu_identity.sessions s WHERE s.id=sid AND s.account_id=actor
 UNION ALL SELECT a.expires_at FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id JOIN whaleu_verification.assertions a ON a.id=s.phone_assertion_id WHERE h.account_id=actor AND a.assertion_state='verified' AND a.expires_at>instant
 UNION ALL SELECT valid_until FROM whaleu_safety.account_heads WHERE account_id=actor
 ) boundaries
$$;
CREATE FUNCTION whaleu_ratings.window_discussion_source_boundary(instant timestamptz) RETURNS timestamptz LANGUAGE sql STABLE AS $$
 SELECT min(boundary.value) FROM whaleu_ratings.window_catalog_head h JOIN whaleu_ratings.window_catalogs c ON c.id=h.catalog_id JOIN whaleu_ratings.window_catalog_acceptances a ON a.catalog_id=c.id CROSS JOIN LATERAL(VALUES(c.accepted_at),(c.valid_until),(a.accepted_at)) boundary(value) WHERE boundary.value>instant
$$;
