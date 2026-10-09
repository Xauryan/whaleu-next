-- PM0–PM2 local text state. No issuer, approval, coverage or production allowance seed.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
CREATE SCHEMA whaleu_messaging;
-- One exact owner predicate for ordinary recall and its mandatory final proof.
-- The caller supplies a single PostgreSQL timestamp sample, never JS milliseconds.
CREATE FUNCTION whaleu_messaging.recall_allowed(created timestamptz,instant timestamptz) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT isfinite(created) AND isfinite(instant) AND instant>=created AND instant<=created+interval '120 seconds'
$$;
CREATE TABLE whaleu_messaging.coverage_heads (
 account_id uuid PRIMARY KEY REFERENCES whaleu_identity.accounts(id),
 coverage text NOT NULL CHECK(coverage IN ('local','complete','missing','conflicting')),
 provenance text NOT NULL CHECK(provenance IN ('accepted','unknown','conflicting')),
 issuer text NOT NULL CHECK(length(btrim(issuer)) BETWEEN 1 AND 200),
 source_reference text NOT NULL CHECK(length(btrim(source_reference)) BETWEEN 1 AND 500),
 policy_reference text NOT NULL CHECK(length(btrim(policy_reference)) BETWEEN 1 AND 500),
 effective_at timestamptz NOT NULL CHECK(isfinite(effective_at)),valid_until timestamptz NOT NULL CHECK(isfinite(valid_until) AND valid_until>effective_at),
 revision uuid NOT NULL
);
CREATE TABLE whaleu_messaging.owner_states (
 account_id uuid PRIMARY KEY REFERENCES whaleu_identity.accounts(id),inbox_epoch bigint NOT NULL DEFAULT 0 CHECK(inbox_epoch>=0)
);
CREATE TABLE whaleu_messaging.requests (
 account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,
 operation text NOT NULL CHECK(operation IN ('open','send','read','hide','reopen','recall','block')),
 intent_hash text NOT NULL CHECK(intent_hash ~ '^[a-f0-9]{64}$'),receipt jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),
 PRIMARY KEY(account_id,request_id)
);
CREATE TABLE whaleu_messaging.conversations (
 id uuid PRIMARY KEY,account0 uuid NOT NULL REFERENCES whaleu_identity.accounts(id),account1 uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 mode0 text NOT NULL CHECK(mode0 IN ('named','anonymous')),mode1 text NOT NULL CHECK(mode1 IN ('named','anonymous')),
 source_key text NOT NULL,source_post_id uuid,context jsonb NOT NULL,context_digest text NOT NULL CHECK(context_digest ~ '^[a-f0-9]{64}$'),
 next_message_seq bigint NOT NULL DEFAULT 0 CHECK(next_message_seq>=0),next_event_seq bigint NOT NULL DEFAULT 0 CHECK(next_event_seq>=0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),updated_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(updated_at)),
 CHECK(account0<account1),CHECK(source_key=coalesce(source_post_id::text,'profile-direct')),
 CHECK(source_post_id IS NOT NULL OR (mode0='named' AND mode1='named')),
 CHECK(coalesce(context->'version'='1'::jsonb AND context->'accounts'=jsonb_build_array(account0,account1) AND context->'modes'=jsonb_build_array(mode0,mode1) AND context->'sourcePostId'=coalesce(to_jsonb(source_post_id),'null'::jsonb),false)),
 CHECK(context_digest=encode(sha256(convert_to('whaleu:dm:v1'||chr(10)||whaleu_community.content_canonical_json(context),'UTF8')),'hex')),
 UNIQUE(account0,account1,source_key,mode0,mode1)
);
CREATE TABLE whaleu_messaging.participants (
 conversation_id uuid NOT NULL REFERENCES whaleu_messaging.conversations(id),slot smallint NOT NULL CHECK(slot IN (0,1)),account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 mode text NOT NULL CHECK(mode IN ('named','anonymous')),display jsonb NOT NULL,
 read_through_seq bigint NOT NULL DEFAULT 0 CHECK(read_through_seq>=0),hidden_through_seq bigint NOT NULL DEFAULT 0 CHECK(hidden_through_seq>=0),
 unread_count bigint NOT NULL DEFAULT 0 CHECK(unread_count>=0),hidden_at timestamptz CHECK(hidden_at IS NULL OR isfinite(hidden_at)),
 blocked_at timestamptz CHECK(blocked_at IS NULL OR isfinite(blocked_at)),blocked_request_id uuid,lifetime_sent bigint NOT NULL DEFAULT 0 CHECK(lifetime_sent>=0),
 PRIMARY KEY(conversation_id,slot),UNIQUE(conversation_id,account_id),
 CHECK((blocked_at IS NULL)=(blocked_request_id IS NULL)),
 FOREIGN KEY(account_id,blocked_request_id) REFERENCES whaleu_messaging.requests(account_id,request_id)
);
CREATE INDEX dm_owner_conversations ON whaleu_messaging.participants(account_id,conversation_id);
CREATE TABLE whaleu_messaging.entry_provenance (
 account_id uuid NOT NULL,request_id uuid NOT NULL,conversation_id uuid NOT NULL REFERENCES whaleu_messaging.conversations(id),
 provenance jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(account_id,request_id),FOREIGN KEY(account_id,request_id) REFERENCES whaleu_messaging.requests(account_id,request_id)
);
CREATE TABLE whaleu_messaging.messages (
 id uuid PRIMARY KEY,conversation_id uuid NOT NULL REFERENCES whaleu_messaging.conversations(id),message_seq bigint NOT NULL CHECK(message_seq>0),sender_slot smallint NOT NULL,
 sender_id uuid NOT NULL,request_id uuid NOT NULL,body text NOT NULL CHECK(length(body) BETWEEN 1 AND 500 AND octet_length(body)<=2000 AND length(btrim(body))>0),
 envelope jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),recalled_at timestamptz CHECK(recalled_at IS NULL OR (isfinite(recalled_at) AND recalled_at>=created_at)),
 UNIQUE(conversation_id,message_seq),UNIQUE(sender_id,request_id),UNIQUE(id,conversation_id),
 FOREIGN KEY(conversation_id,sender_slot) REFERENCES whaleu_messaging.participants(conversation_id,slot),
 FOREIGN KEY(sender_id,request_id) REFERENCES whaleu_messaging.requests(account_id,request_id)
);
CREATE TABLE whaleu_messaging.events (
 conversation_id uuid NOT NULL,event_seq bigint NOT NULL CHECK(event_seq>0),kind text NOT NULL CHECK(kind IN ('sent','recalled')),message_id uuid NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(occurred_at)),PRIMARY KEY(conversation_id,event_seq),UNIQUE(message_id,kind),
 FOREIGN KEY(message_id,conversation_id) REFERENCES whaleu_messaging.messages(id,conversation_id)
);
CREATE TABLE whaleu_messaging.observations (
 id uuid PRIMARY KEY,account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),conversation_id uuid NOT NULL REFERENCES whaleu_messaging.conversations(id),
 through_seq bigint NOT NULL CHECK(through_seq>=0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),valid_until timestamptz NOT NULL,
 CHECK(isfinite(created_at) AND isfinite(valid_until) AND valid_until>created_at)
);
CREATE INDEX dm_observation_owner ON whaleu_messaging.observations(account_id,conversation_id,created_at DESC);
CREATE TABLE whaleu_messaging.rate_budgets (
 scope text NOT NULL,kind text NOT NULL CHECK(kind IN ('send_actor','send_conversation','open','first_contact')),
 window_start timestamptz NOT NULL CHECK(isfinite(window_start)),used integer NOT NULL CHECK(used>0),PRIMARY KEY(scope,kind,window_start)
);
CREATE TABLE whaleu_messaging.outbox (
 id uuid PRIMARY KEY,message_id uuid NOT NULL REFERENCES whaleu_messaging.messages(id),recipient_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 state text NOT NULL DEFAULT 'not_configured' CHECK(state IN ('not_configured','pending','suppressed')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(message_id,recipient_id)
);
CREATE TABLE whaleu_messaging.transitions (
 account_id uuid NOT NULL,request_id uuid NOT NULL,conversation_id uuid REFERENCES whaleu_messaging.conversations(id),message_id uuid REFERENCES whaleu_messaging.messages(id),
 receipt jsonb NOT NULL,mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 PRIMARY KEY(account_id,request_id),FOREIGN KEY(account_id,request_id) REFERENCES whaleu_messaging.requests(account_id,request_id)
);
CREATE FUNCTION whaleu_messaging.immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Private history is immutable' USING ERRCODE='23514';END $$;
CREATE TRIGGER dm_provenance_immutable BEFORE UPDATE OR DELETE ON whaleu_messaging.entry_provenance FOR EACH ROW EXECUTE FUNCTION whaleu_messaging.immutable();
CREATE TRIGGER dm_events_immutable BEFORE UPDATE OR DELETE ON whaleu_messaging.events FOR EACH ROW EXECUTE FUNCTION whaleu_messaging.immutable();
CREATE TRIGGER dm_transitions_immutable BEFORE UPDATE OR DELETE ON whaleu_messaging.transitions FOR EACH ROW EXECUTE FUNCTION whaleu_messaging.immutable();
CREATE FUNCTION whaleu_messaging.conversation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Conversation cannot be purged' USING ERRCODE='23514';END IF;
 IF ROW(NEW.id,NEW.account0,NEW.account1,NEW.mode0,NEW.mode1,NEW.source_key,NEW.source_post_id,NEW.context,NEW.context_digest,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.account0,OLD.account1,OLD.mode0,OLD.mode1,OLD.source_key,OLD.source_post_id,OLD.context,OLD.context_digest,OLD.created_at)
 OR NEW.next_message_seq<OLD.next_message_seq OR NEW.next_event_seq<OLD.next_event_seq THEN RAISE EXCEPTION 'Conversation identity changed' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER dm_conversation_guard BEFORE UPDATE OR DELETE ON whaleu_messaging.conversations FOR EACH ROW EXECUTE FUNCTION whaleu_messaging.conversation_guard();
CREATE FUNCTION whaleu_messaging.participant_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c whaleu_messaging.conversations;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Membership is durable' USING ERRCODE='23514';END IF;
 SELECT * INTO c FROM whaleu_messaging.conversations WHERE id=NEW.conversation_id;
 IF NEW.display IS DISTINCT FROM c.context->'displays'->NEW.slot THEN RAISE EXCEPTION 'Participant display context mismatch' USING ERRCODE='23514';END IF;
 IF NOT coalesce(NEW.display->>'mode'=NEW.mode AND jsonb_typeof(NEW.display->'displayName')='string' AND length(NEW.display->>'displayName') BETWEEN 1 AND 200 AND (NEW.mode='named' OR NEW.display->'profileId'='null'::jsonb),false) THEN RAISE EXCEPTION 'Invalid participant display' USING ERRCODE='23514';END IF;
 IF ROW(NEW.account_id,NEW.mode) IS DISTINCT FROM ROW(CASE WHEN NEW.slot=0 THEN c.account0 ELSE c.account1 END,CASE WHEN NEW.slot=0 THEN c.mode0 ELSE c.mode1 END)
 OR NEW.read_through_seq>c.next_message_seq OR NEW.hidden_through_seq>c.next_message_seq THEN RAISE EXCEPTION 'Invalid participant' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' AND (ROW(NEW.conversation_id,NEW.slot,NEW.account_id,NEW.mode,NEW.display) IS DISTINCT FROM ROW(OLD.conversation_id,OLD.slot,OLD.account_id,OLD.mode,OLD.display)
 OR NEW.read_through_seq<OLD.read_through_seq OR NEW.hidden_through_seq<OLD.hidden_through_seq OR NEW.lifetime_sent<OLD.lifetime_sent
 OR (OLD.blocked_at IS NOT NULL AND ROW(NEW.blocked_at,NEW.blocked_request_id) IS DISTINCT FROM ROW(OLD.blocked_at,OLD.blocked_request_id))) THEN RAISE EXCEPTION 'Participant history changed' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER dm_participant_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_messaging.participants FOR EACH ROW EXECUTE FUNCTION whaleu_messaging.participant_guard();
CREATE FUNCTION whaleu_messaging.complete_membership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF (SELECT count(*) FROM whaleu_messaging.participants WHERE conversation_id=NEW.id)<>2 THEN RAISE EXCEPTION 'Exactly two participants required' USING ERRCODE='23514';END IF;RETURN NULL;END $$;
CREATE CONSTRAINT TRIGGER dm_complete_membership AFTER INSERT ON whaleu_messaging.conversations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_messaging.complete_membership();
CREATE FUNCTION whaleu_messaging.message_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p whaleu_messaging.participants;c whaleu_messaging.conversations;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Message cannot be purged' USING ERRCODE='23514';END IF;
 SELECT * INTO p FROM whaleu_messaging.participants WHERE conversation_id=NEW.conversation_id AND slot=NEW.sender_slot;
 SELECT * INTO c FROM whaleu_messaging.conversations WHERE id=NEW.conversation_id;
 IF p.account_id IS DISTINCT FROM NEW.sender_id OR NEW.message_seq>c.next_message_seq OR NOT coalesce(
 NEW.envelope->>'accountId'=NEW.sender_id::text AND NEW.envelope->>'clientRequestId'=NEW.request_id::text AND NEW.envelope->>'conversationId'=c.id::text
 AND NEW.envelope->>'contextDigest'=c.context_digest AND NEW.envelope->>'text'=NEW.body AND NEW.envelope->>'senderSlot'=NEW.sender_slot::text
 AND NEW.envelope->'participantModes'=jsonb_build_array(c.mode0,c.mode1) AND NEW.envelope->'assetIds'='[]'::jsonb AND NEW.envelope->>'purpose'='send_private_message' AND NEW.envelope->>'version'='1',false)
 THEN RAISE EXCEPTION 'Message identity mismatch' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' AND (ROW(NEW.id,NEW.conversation_id,NEW.message_seq,NEW.sender_slot,NEW.sender_id,NEW.request_id,NEW.body,NEW.envelope,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.conversation_id,OLD.message_seq,OLD.sender_slot,OLD.sender_id,OLD.request_id,OLD.body,OLD.envelope,OLD.created_at)
 OR OLD.recalled_at IS NOT NULL OR NEW.recalled_at IS NULL OR NOT whaleu_messaging.recall_allowed(NEW.created_at,NEW.recalled_at)) THEN RAISE EXCEPTION 'Invalid recall' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER dm_message_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_messaging.messages FOR EACH ROW EXECUTE FUNCTION whaleu_messaging.message_guard();
CREATE FUNCTION whaleu_messaging.request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Command receipt is durable' USING ERRCODE='23514';END IF;
 IF ROW(NEW.account_id,NEW.request_id,NEW.operation,NEW.intent_hash,NEW.created_at) IS DISTINCT FROM ROW(OLD.account_id,OLD.request_id,OLD.operation,OLD.intent_hash,OLD.created_at)
 OR OLD.receipt IS NOT NULL THEN RAISE EXCEPTION 'Command is immutable' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER dm_request_guard BEFORE UPDATE OR DELETE ON whaleu_messaging.requests FOR EACH ROW EXECUTE FUNCTION whaleu_messaging.request_guard();
CREATE FUNCTION whaleu_messaging.request_causal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_messaging.requests;t whaleu_messaging.transitions;keys text[];sent_message whaleu_messaging.messages;
BEGIN
 SELECT * INTO q FROM whaleu_messaging.requests WHERE account_id=NEW.account_id AND request_id=NEW.request_id;
 SELECT * INTO t FROM whaleu_messaging.transitions WHERE account_id=NEW.account_id AND request_id=NEW.request_id;
 IF q.receipt IS NULL OR q.receipt IS DISTINCT FROM t.receipt OR t.mutation_transaction IS DISTINCT FROM pg_current_xact_id()
 OR q.receipt->>'requestId' IS DISTINCT FROM q.request_id::text OR q.receipt->>'operation' IS DISTINCT FROM q.operation THEN RAISE EXCEPTION 'Command has no exact transition' USING ERRCODE='23514';END IF;
 SELECT array_agg(k ORDER BY k) INTO keys FROM jsonb_object_keys(q.receipt) k;
 IF q.receipt->>'outcome'='rejected' THEN
  IF keys IS DISTINCT FROM ARRAY['code','operation','outcome','requestId'] OR NOT coalesce(q.receipt->>'code'=ANY(ARRAY['DM_COMMAND_CANCELLED','DM_NOT_FOUND','DM_ENTRY_UNAVAILABLE','DM_SEND_UNAVAILABLE','DM_FIRST_CONTACT_LIMIT','DM_RECALL_EXPIRED','DM_OBSERVATION_UNAVAILABLE','CONTENT_REJECTED','PHONE_VERIFICATION_REQUIRED','AFFILIATION_VERIFICATION_REQUIRED','SAFETY_ACTION_RESTRICTED']),false) OR t.conversation_id IS NOT NULL OR t.message_id IS NOT NULL THEN RAISE EXCEPTION 'Invalid rejection receipt' USING ERRCODE='23514';END IF;
 ELSE
  IF NOT coalesce(q.receipt->>'outcome' IN ('applied','noop') AND keys=ARRAY['conversationId','messageId','occurredAt','operation','outcome','requestId'] AND q.receipt->>'conversationId'=t.conversation_id::text AND q.receipt->'messageId'=coalesce(to_jsonb(t.message_id),'null'::jsonb) AND isfinite((q.receipt->>'occurredAt')::timestamptz),false)
  OR NOT EXISTS(SELECT 1 FROM whaleu_messaging.participants WHERE conversation_id=t.conversation_id AND account_id=q.account_id) THEN RAISE EXCEPTION 'Invalid private transition receipt' USING ERRCODE='23514';END IF;
  IF q.operation='open' AND NOT EXISTS(SELECT 1 FROM whaleu_messaging.entry_provenance WHERE account_id=q.account_id AND request_id=q.request_id AND conversation_id=t.conversation_id) THEN RAISE EXCEPTION 'Open lacks exact entry provenance' USING ERRCODE='23514';END IF;
  IF q.operation='send' THEN
   SELECT * INTO sent_message FROM whaleu_messaging.messages WHERE id=t.message_id AND sender_id=q.account_id AND request_id=q.request_id;
   IF sent_message.id IS NULL OR q.intent_hash IS DISTINCT FROM encode(sha256(convert_to('whaleu:dm:v1'||chr(10)||whaleu_community.content_canonical_json(jsonb_build_object('operation','send','intent',jsonb_build_object('conversationId',t.conversation_id,'clientRequestId',q.request_id,'text',sent_message.body))),'UTF8')),'hex') THEN RAISE EXCEPTION 'Send original intent mismatch' USING ERRCODE='23514';END IF;
  END IF;
  IF q.operation='recall' AND NOT EXISTS(SELECT 1 FROM whaleu_messaging.messages WHERE id=t.message_id AND conversation_id=t.conversation_id AND sender_id=q.account_id AND recalled_at IS NOT NULL) THEN RAISE EXCEPTION 'Recall lacks own tombstone' USING ERRCODE='23514';END IF;
  IF q.operation='hide' AND NOT EXISTS(SELECT 1 FROM whaleu_messaging.participants WHERE conversation_id=t.conversation_id AND account_id=q.account_id AND hidden_at IS NOT NULL AND unread_count=0) THEN RAISE EXCEPTION 'Hide state absent' USING ERRCODE='23514';END IF;
  IF q.operation='reopen' AND NOT EXISTS(SELECT 1 FROM whaleu_messaging.participants WHERE conversation_id=t.conversation_id AND account_id=q.account_id AND hidden_at IS NULL) THEN RAISE EXCEPTION 'Reopen state absent' USING ERRCODE='23514';END IF;
 END IF;
 IF q.operation='send' AND q.receipt->>'outcome'='applied' AND NOT EXISTS(SELECT 1 FROM whaleu_messaging.messages m JOIN whaleu_messaging.events e ON e.message_id=m.id AND e.kind='sent' JOIN whaleu_messaging.outbox o ON o.message_id=m.id WHERE m.id=t.message_id AND m.sender_id=q.account_id AND m.request_id=q.request_id AND m.conversation_id=t.conversation_id) THEN RAISE EXCEPTION 'Send chain incomplete' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER dm_request_causal AFTER INSERT OR UPDATE ON whaleu_messaging.requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_messaging.request_causal();
CREATE FUNCTION whaleu_messaging.state_consistent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cid uuid;c whaleu_messaging.conversations;p whaleu_messaging.participants;expected bigint;
BEGIN
 IF TG_TABLE_NAME='conversations' THEN cid:=NEW.id;ELSIF TG_TABLE_NAME='outbox' THEN SELECT conversation_id INTO cid FROM whaleu_messaging.messages WHERE id=NEW.message_id;ELSE cid:=NEW.conversation_id;END IF;
 SELECT * INTO c FROM whaleu_messaging.conversations WHERE id=cid;
 IF c.id IS NULL THEN RAISE EXCEPTION 'Conversation state absent' USING ERRCODE='23514';END IF;
 IF (SELECT count(*) FROM whaleu_messaging.messages WHERE conversation_id=cid)<>c.next_message_seq
 OR (SELECT count(*) FROM whaleu_messaging.events WHERE conversation_id=cid)<>c.next_event_seq
 OR (SELECT coalesce(max(message_seq),0) FROM whaleu_messaging.messages WHERE conversation_id=cid)<>c.next_message_seq
 OR (SELECT coalesce(max(event_seq),0) FROM whaleu_messaging.events WHERE conversation_id=cid)<>c.next_event_seq
 THEN RAISE EXCEPTION 'Private sequence chain incomplete' USING ERRCODE='23514';END IF;
 FOR p IN SELECT * FROM whaleu_messaging.participants WHERE conversation_id=cid LOOP
 SELECT count(*) INTO expected FROM whaleu_messaging.messages WHERE conversation_id=cid AND sender_slot<>p.slot AND message_seq>greatest(p.read_through_seq,p.hidden_through_seq) AND recalled_at IS NULL;
 IF p.unread_count<>expected OR p.lifetime_sent<>(SELECT count(*) FROM whaleu_messaging.messages WHERE conversation_id=cid AND sender_slot=p.slot)
 THEN RAISE EXCEPTION 'Private message counters inconsistent' USING ERRCODE='23514';END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM whaleu_messaging.messages m WHERE m.conversation_id=cid AND (
 NOT EXISTS(SELECT 1 FROM whaleu_messaging.requests q JOIN whaleu_messaging.transitions t ON t.account_id=q.account_id AND t.request_id=q.request_id WHERE q.account_id=m.sender_id AND q.request_id=m.request_id AND q.operation='send' AND q.receipt->>'outcome'='applied' AND t.message_id=m.id AND t.conversation_id=m.conversation_id AND q.receipt->>'messageId'=m.id::text AND q.receipt->>'conversationId'=m.conversation_id::text)
 OR NOT EXISTS(SELECT 1 FROM whaleu_messaging.events e WHERE e.message_id=m.id AND e.kind='sent')
 OR (m.recalled_at IS NOT NULL) IS DISTINCT FROM EXISTS(SELECT 1 FROM whaleu_messaging.events e WHERE e.message_id=m.id AND e.kind='recalled')
 OR (SELECT count(*) FROM whaleu_messaging.outbox o WHERE o.message_id=m.id)<>1
 OR NOT EXISTS(SELECT 1 FROM whaleu_messaging.outbox o JOIN whaleu_messaging.participants recipient ON recipient.account_id=o.recipient_id AND recipient.conversation_id=cid AND recipient.slot<>m.sender_slot WHERE o.message_id=m.id)))
 THEN RAISE EXCEPTION 'Private event or delivery obligation incomplete' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER dm_conversation_consistent AFTER INSERT OR UPDATE ON whaleu_messaging.conversations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_messaging.state_consistent();
CREATE CONSTRAINT TRIGGER dm_participants_consistent AFTER INSERT OR UPDATE ON whaleu_messaging.participants DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_messaging.state_consistent();
CREATE CONSTRAINT TRIGGER dm_messages_consistent AFTER INSERT OR UPDATE ON whaleu_messaging.messages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_messaging.state_consistent();
CREATE CONSTRAINT TRIGGER dm_events_consistent AFTER INSERT ON whaleu_messaging.events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_messaging.state_consistent();
CREATE TRIGGER dm_conversations_retain BEFORE TRUNCATE ON whaleu_messaging.conversations FOR EACH STATEMENT EXECUTE FUNCTION whaleu_messaging.immutable();
CREATE TRIGGER dm_membership_retain BEFORE TRUNCATE ON whaleu_messaging.participants FOR EACH STATEMENT EXECUTE FUNCTION whaleu_messaging.immutable();
CREATE TRIGGER dm_messages_retain BEFORE TRUNCATE ON whaleu_messaging.messages FOR EACH STATEMENT EXECUTE FUNCTION whaleu_messaging.immutable();
CREATE TRIGGER dm_requests_retain BEFORE TRUNCATE ON whaleu_messaging.requests FOR EACH STATEMENT EXECUTE FUNCTION whaleu_messaging.immutable();
CREATE TRIGGER dm_events_retain BEFORE TRUNCATE ON whaleu_messaging.events FOR EACH STATEMENT EXECUTE FUNCTION whaleu_messaging.immutable();
CREATE TRIGGER dm_transitions_retain BEFORE TRUNCATE ON whaleu_messaging.transitions FOR EACH STATEMENT EXECUTE FUNCTION whaleu_messaging.immutable();
CREATE TRIGGER dm_provenance_retain BEFORE TRUNCATE ON whaleu_messaging.entry_provenance FOR EACH STATEMENT EXECUTE FUNCTION whaleu_messaging.immutable();
CREATE FUNCTION whaleu_messaging.outbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Private delivery obligation retained' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' AND (ROW(NEW.id,NEW.message_id,NEW.recipient_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.message_id,OLD.recipient_id,OLD.created_at) OR (OLD.state='suppressed' AND NEW.state<>'suppressed')) THEN RAISE EXCEPTION 'Private delivery identity immutable' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER dm_outbox_guard BEFORE UPDATE OR DELETE ON whaleu_messaging.outbox FOR EACH ROW EXECUTE FUNCTION whaleu_messaging.outbox_guard();
CREATE TRIGGER dm_outbox_retain BEFORE TRUNCATE ON whaleu_messaging.outbox FOR EACH STATEMENT EXECUTE FUNCTION whaleu_messaging.immutable();
CREATE CONSTRAINT TRIGGER dm_outbox_consistent AFTER INSERT OR UPDATE ON whaleu_messaging.outbox DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_messaging.state_consistent();
