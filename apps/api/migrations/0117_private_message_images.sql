-- PM3 additive exact single-image commands. Text-v1 shapes/digests remain byte-identical.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
CREATE TABLE whaleu_messaging.image_command_reservations (
 account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,conversation_id uuid NOT NULL REFERENCES whaleu_messaging.conversations(id),context_digest text NOT NULL CHECK(context_digest ~ '^[a-f0-9]{64}$'),
 reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(account_id,request_id)
);
CREATE TRIGGER dm_image_reservation_immutable BEFORE UPDATE OR DELETE ON whaleu_messaging.image_command_reservations FOR EACH ROW EXECUTE FUNCTION whaleu_messaging.immutable();
CREATE TRIGGER dm_image_reservation_retain BEFORE TRUNCATE ON whaleu_messaging.image_command_reservations FOR EACH STATEMENT EXECUTE FUNCTION whaleu_messaging.immutable();
CREATE TABLE whaleu_messaging.image_command_fences (
 account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,conversation_id uuid NOT NULL,
 fenced_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(account_id,request_id)
);
CREATE TRIGGER dm_image_fence_immutable BEFORE UPDATE OR DELETE ON whaleu_messaging.image_command_fences FOR EACH ROW EXECUTE FUNCTION whaleu_messaging.immutable();
CREATE TRIGGER dm_image_fence_retain BEFORE TRUNCATE ON whaleu_messaging.image_command_fences FOR EACH STATEMENT EXECUTE FUNCTION whaleu_messaging.immutable();
CREATE FUNCTION whaleu_messaging.image_request_slot_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.operation<>'send_image' AND (EXISTS(SELECT 1 FROM whaleu_messaging.image_command_reservations WHERE account_id=NEW.account_id AND request_id=NEW.request_id) OR EXISTS(SELECT 1 FROM whaleu_messaging.image_command_fences WHERE account_id=NEW.account_id AND request_id=NEW.request_id)) THEN RAISE EXCEPTION 'Original image command key is reserved' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER dm_image_request_slot BEFORE INSERT ON whaleu_messaging.requests FOR EACH ROW EXECUTE FUNCTION whaleu_messaging.image_request_slot_guard();
ALTER TABLE whaleu_messaging.requests DROP CONSTRAINT requests_operation_check;
ALTER TABLE whaleu_messaging.requests ADD CONSTRAINT requests_operation_check CHECK(operation IN ('open','send','send_image','read','hide','reopen','recall','block'));
ALTER TABLE whaleu_messaging.messages ALTER COLUMN body DROP NOT NULL;
CREATE FUNCTION whaleu_community.dm_image_envelope_shape(e jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT coalesce(jsonb_typeof(e)='object' AND (e-ARRAY['version','purpose','accountId','clientRequestId','conversationId','contextDigest','senderSlot','participantModes','kind','image'])='{}'::jsonb
 AND e->'version'='2'::jsonb AND e->>'purpose'='send_private_message' AND e->>'kind'='image'
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['accountId','clientRequestId','conversationId']) k WHERE jsonb_typeof(e->k) IS DISTINCT FROM 'string' OR NOT coalesce(e->>k ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',false))
 AND e->>'clientRequestId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 AND jsonb_typeof(e->'contextDigest')='string' AND e->>'contextDigest' ~ '^[a-f0-9]{64}$'
 AND e->'senderSlot' IN ('0'::jsonb,'1'::jsonb) AND CASE WHEN jsonb_typeof(e->'participantModes')='array' THEN jsonb_array_length(e->'participantModes')=2 ELSE false END
 AND e->'participantModes'->>0 IN ('named','anonymous') AND e->'participantModes'->>1 IN ('named','anonymous')
 AND jsonb_typeof(e->'image')='object' AND ((e->'image')-ARRAY['assetId','manifestDigest'])='{}'::jsonb
 AND e->'image'->>'assetId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 AND e->'image'->>'manifestDigest' ~ '^[a-f0-9]{64}$',false)
$$;
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conrelid::regclass rel,conname FROM pg_constraint WHERE conrelid IN ('whaleu_community.dm_approval_decisions'::regclass,'whaleu_community.dm_approval_bindings'::regclass) AND contype='c' AND (pg_get_constraintdef(oid) LIKE '%dm_envelope_shape(%' OR pg_get_constraintdef(oid) LIKE '%envelope_version = 1%' OR pg_get_constraintdef(oid) LIKE '%whaleu-dm-content-approval:v1%') LOOP
 EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',c.rel,c.conname);END LOOP;
END $$;
ALTER TABLE whaleu_community.dm_approval_decisions ADD CONSTRAINT dm_approval_version CHECK(envelope_version IN (1,2)),ADD CONSTRAINT dm_approval_shape CHECK(whaleu_community.dm_envelope_shape(envelope) OR whaleu_community.dm_image_envelope_shape(envelope)),ADD CONSTRAINT dm_approval_versioned_digest CHECK(digest=encode(sha256(convert_to('whaleu-dm-content-approval:v'||envelope_version::text||chr(10)||whaleu_community.content_canonical_json(envelope),'UTF8')),'hex'));
ALTER TABLE whaleu_community.dm_approval_bindings ADD CONSTRAINT dm_binding_version CHECK(envelope_version IN (1,2)),ADD CONSTRAINT dm_binding_shape CHECK(whaleu_community.dm_envelope_shape(envelope) OR whaleu_community.dm_image_envelope_shape(envelope));
ALTER TABLE whaleu_messaging.messages ADD CONSTRAINT dm_message_typed_body CHECK((envelope->>'version'='1' AND body IS NOT NULL) OR (whaleu_community.dm_image_envelope_shape(envelope) AND body IS NULL));
CREATE OR REPLACE FUNCTION whaleu_messaging.message_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p whaleu_messaging.participants;c whaleu_messaging.conversations;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Message cannot be purged' USING ERRCODE='23514';END IF;
 SELECT * INTO p FROM whaleu_messaging.participants WHERE conversation_id=NEW.conversation_id AND slot=NEW.sender_slot;
 SELECT * INTO c FROM whaleu_messaging.conversations WHERE id=NEW.conversation_id;
 IF p.account_id IS DISTINCT FROM NEW.sender_id OR NEW.message_seq>c.next_message_seq OR NOT coalesce(
 NEW.envelope->>'accountId'=NEW.sender_id::text AND NEW.envelope->>'clientRequestId'=NEW.request_id::text AND NEW.envelope->>'conversationId'=c.id::text
 AND NEW.envelope->>'contextDigest'=c.context_digest AND NEW.envelope->>'senderSlot'=NEW.sender_slot::text
 AND NEW.envelope->'participantModes'=jsonb_build_array(c.mode0,c.mode1) AND ((whaleu_community.dm_envelope_shape(NEW.envelope) AND NEW.envelope->>'text'=NEW.body) OR (whaleu_community.dm_image_envelope_shape(NEW.envelope) AND NEW.body IS NULL)),false)
 THEN RAISE EXCEPTION 'Message identity mismatch' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' AND (ROW(NEW.id,NEW.conversation_id,NEW.message_seq,NEW.sender_slot,NEW.sender_id,NEW.request_id,NEW.body,NEW.envelope,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.conversation_id,OLD.message_seq,OLD.sender_slot,OLD.sender_id,OLD.request_id,OLD.body,OLD.envelope,OLD.created_at)
 OR OLD.recalled_at IS NOT NULL OR NEW.recalled_at IS NULL OR NOT whaleu_messaging.recall_allowed(NEW.created_at,NEW.recalled_at)) THEN RAISE EXCEPTION 'Invalid recall' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION whaleu_messaging.request_causal() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF q.operation IN ('send','send_image') THEN
   SELECT * INTO sent_message FROM whaleu_messaging.messages WHERE id=t.message_id AND sender_id=q.account_id AND request_id=q.request_id;
   IF sent_message.id IS NULL OR (q.operation='send_image') IS DISTINCT FROM (sent_message.envelope->>'version'='2') OR q.intent_hash IS DISTINCT FROM encode(sha256(convert_to('whaleu:dm:v1'||chr(10)||whaleu_community.content_canonical_json(jsonb_build_object('operation',q.operation,'intent',CASE WHEN q.operation='send' THEN jsonb_build_object('conversationId',t.conversation_id,'clientRequestId',q.request_id,'text',sent_message.body) ELSE jsonb_build_object('conversationId',t.conversation_id,'clientRequestId',q.request_id,'image',sent_message.envelope->'image') END)),'UTF8')),'hex') THEN RAISE EXCEPTION 'Send original intent mismatch' USING ERRCODE='23514';END IF;
  END IF;
  IF q.operation='recall' AND NOT EXISTS(SELECT 1 FROM whaleu_messaging.messages WHERE id=t.message_id AND conversation_id=t.conversation_id AND sender_id=q.account_id AND recalled_at IS NOT NULL) THEN RAISE EXCEPTION 'Recall lacks own tombstone' USING ERRCODE='23514';END IF;
  IF q.operation='hide' AND NOT EXISTS(SELECT 1 FROM whaleu_messaging.participants WHERE conversation_id=t.conversation_id AND account_id=q.account_id AND hidden_at IS NOT NULL AND unread_count=0) THEN RAISE EXCEPTION 'Hide state absent' USING ERRCODE='23514';END IF;
  IF q.operation='reopen' AND NOT EXISTS(SELECT 1 FROM whaleu_messaging.participants WHERE conversation_id=t.conversation_id AND account_id=q.account_id AND hidden_at IS NULL) THEN RAISE EXCEPTION 'Reopen state absent' USING ERRCODE='23514';END IF;
 END IF;
 IF q.operation IN ('send','send_image') AND q.receipt->>'outcome'='applied' AND NOT EXISTS(SELECT 1 FROM whaleu_messaging.messages m JOIN whaleu_messaging.events e ON e.message_id=m.id AND e.kind='sent' JOIN whaleu_messaging.outbox o ON o.message_id=m.id WHERE m.id=t.message_id AND m.sender_id=q.account_id AND m.request_id=q.request_id AND m.conversation_id=t.conversation_id) THEN RAISE EXCEPTION 'Send chain incomplete' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION whaleu_messaging.state_consistent() RETURNS trigger LANGUAGE plpgsql AS $$
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
 NOT EXISTS(SELECT 1 FROM whaleu_messaging.requests q JOIN whaleu_messaging.transitions t ON t.account_id=q.account_id AND t.request_id=q.request_id WHERE q.account_id=m.sender_id AND q.request_id=m.request_id AND q.operation=CASE WHEN m.envelope->>'version'='2' THEN 'send_image' ELSE 'send' END AND q.receipt->>'outcome'='applied' AND t.message_id=m.id AND t.conversation_id=m.conversation_id AND q.receipt->>'messageId'=m.id::text AND q.receipt->>'conversationId'=m.conversation_id::text)
 OR NOT EXISTS(SELECT 1 FROM whaleu_messaging.events e WHERE e.message_id=m.id AND e.kind='sent')
 OR (m.recalled_at IS NOT NULL) IS DISTINCT FROM EXISTS(SELECT 1 FROM whaleu_messaging.events e WHERE e.message_id=m.id AND e.kind='recalled')
 OR (SELECT count(*) FROM whaleu_messaging.outbox o WHERE o.message_id=m.id)<>1
 OR NOT EXISTS(SELECT 1 FROM whaleu_messaging.outbox o JOIN whaleu_messaging.participants recipient ON recipient.account_id=o.recipient_id AND recipient.conversation_id=cid AND recipient.slot<>m.sender_slot WHERE o.message_id=m.id)))
 THEN RAISE EXCEPTION 'Private event or delivery obligation incomplete' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION whaleu_community.dm_review_message_causal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m whaleu_messaging.messages;b whaleu_community.dm_approval_bindings;
BEGIN
 IF TG_TABLE_SCHEMA='whaleu_messaging' THEN SELECT * INTO m FROM whaleu_messaging.messages WHERE id=NEW.id;
 ELSE SELECT * INTO m FROM whaleu_messaging.messages WHERE id=NEW.message_id; END IF;
 SELECT * INTO b FROM whaleu_community.dm_approval_bindings WHERE message_id=m.id;
 IF m.id IS NULL OR b.message_id IS NULL OR b.publication_transaction IS DISTINCT FROM pg_current_xact_id() OR
 ROW(b.conversation_id,b.sender_slot,b.message_seq,b.account_id,b.envelope) IS DISTINCT FROM ROW(m.conversation_id,m.sender_slot,m.message_seq,m.sender_id,m.envelope)
 OR b.envelope->>'text' IS DISTINCT FROM m.body OR b.envelope->>'clientRequestId' IS DISTINCT FROM m.request_id::text
 THEN RAISE EXCEPTION 'DM message has no exact same-transaction Review binding' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
-- A Messaging image cannot exist without the exact same-transaction Media15
-- appearance, and a recalled image cannot retain an active binding.
CREATE FUNCTION whaleu_messaging.image_binding_causal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m whaleu_messaging.messages;p whaleu_media.private_message_appearances;b whaleu_media.bindings;c whaleu_messaging.conversations;
BEGIN
 IF TG_TABLE_SCHEMA='whaleu_messaging' THEN SELECT * INTO m FROM whaleu_messaging.messages WHERE id=NEW.id;
 ELSE SELECT * INTO m FROM whaleu_messaging.messages WHERE id=NEW.message_id;END IF;
 IF m.envelope->>'version'<>'2' THEN RETURN NULL;END IF;
 SELECT * INTO p FROM whaleu_media.private_message_appearances WHERE message_id=m.id;
 SELECT * INTO b FROM whaleu_media.bindings WHERE id=p.binding_id;
 SELECT * INTO c FROM whaleu_messaging.conversations WHERE id=m.conversation_id;
 IF p.message_id IS NULL OR b.id IS NULL OR ROW(p.conversation_id,p.actor_id,p.message_request_id,p.context_digest,p.asset_id::text,p.manifest_digest) IS DISTINCT FROM ROW(m.conversation_id,m.sender_id,m.request_id,c.context_digest,m.envelope->'image'->>'assetId',m.envelope->'image'->>'manifestDigest')
 OR (TG_OP='INSERT' AND p.publication_transaction IS DISTINCT FROM pg_current_xact_id())
 OR (m.recalled_at IS NULL AND b.detached_at IS NOT NULL)
 OR (m.recalled_at IS NOT NULL AND b.detached_at IS NULL)
 OR NOT EXISTS(SELECT 1 FROM whaleu_messaging.requests WHERE account_id=m.sender_id AND request_id=m.request_id AND operation='send_image')
 OR EXISTS(SELECT 1 FROM whaleu_messaging.image_command_fences WHERE account_id=m.sender_id AND request_id=m.request_id)
 THEN RAISE EXCEPTION 'Private image publication or retirement chain incomplete' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER dm_image_binding_causal AFTER INSERT OR UPDATE ON whaleu_messaging.messages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_messaging.image_binding_causal();
CREATE CONSTRAINT TRIGGER dm_image_appearance_causal AFTER INSERT ON whaleu_media.private_message_appearances DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_messaging.image_binding_causal();
CREATE FUNCTION whaleu_messaging.image_namespace_lock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor uuid;key uuid;
BEGIN
 -- Namespace checks must see the winner after waiting for this lock. A stale
 -- REPEATABLE READ/SERIALIZABLE snapshot cannot authorize cross-table keys.
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Private command namespace requires read committed' USING ERRCODE='23514';END IF;
 IF TG_TABLE_SCHEMA='whaleu_media' THEN actor:=NEW.actor_id;key:=NEW.message_request_id;ELSE actor:=NEW.account_id;key:=NEW.request_id;END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(whaleu_community.content_canonical_json(jsonb_build_array('whaleu:dm-image-command:v1',actor,key)),0));RETURN NEW;
END $$;
CREATE TRIGGER a0_image_namespace_lock BEFORE INSERT ON whaleu_messaging.image_command_reservations FOR EACH ROW EXECUTE FUNCTION whaleu_messaging.image_namespace_lock();
CREATE TRIGGER a0_image_namespace_lock BEFORE INSERT ON whaleu_messaging.image_command_fences FOR EACH ROW EXECUTE FUNCTION whaleu_messaging.image_namespace_lock();
CREATE TRIGGER a0_image_namespace_lock BEFORE INSERT ON whaleu_messaging.requests FOR EACH ROW EXECUTE FUNCTION whaleu_messaging.image_namespace_lock();
CREATE TRIGGER a0_image_namespace_lock BEFORE INSERT ON whaleu_media.private_message_scopes FOR EACH ROW EXECUTE FUNCTION whaleu_messaging.image_namespace_lock();
CREATE FUNCTION whaleu_messaging.image_namespace_causal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor uuid;key uuid;r whaleu_messaging.image_command_reservations;f whaleu_messaging.image_command_fences;q whaleu_messaging.requests;c whaleu_messaging.conversations;
BEGIN
 IF TG_TABLE_SCHEMA='whaleu_media' THEN actor:=NEW.actor_id;key:=NEW.message_request_id;ELSE actor:=NEW.account_id;key:=NEW.request_id;END IF;
 SELECT * INTO r FROM whaleu_messaging.image_command_reservations WHERE account_id=actor AND request_id=key;
 SELECT * INTO f FROM whaleu_messaging.image_command_fences WHERE account_id=actor AND request_id=key;
 SELECT * INTO q FROM whaleu_messaging.requests WHERE account_id=actor AND request_id=key;
 IF r.request_id IS NOT NULL THEN
  SELECT * INTO c FROM whaleu_messaging.conversations WHERE id=r.conversation_id;
  IF c.id IS NULL OR r.context_digest IS DISTINCT FROM c.context_digest OR actor NOT IN (c.account0,c.account1) OR NOT EXISTS(SELECT 1 FROM whaleu_messaging.participants WHERE conversation_id=c.id AND account_id=actor) THEN RAISE EXCEPTION 'Image reservation has no exact participant context' USING ERRCODE='23514';END IF;
 END IF;
 IF ((r.request_id IS NOT NULL OR f.request_id IS NOT NULL) AND q.request_id IS NOT NULL AND q.operation<>'send_image') OR (r.request_id IS NOT NULL AND f.request_id IS NOT NULL AND r.conversation_id<>f.conversation_id) OR (f.request_id IS NOT NULL AND q.receipt->>'outcome' IN ('applied','noop')) THEN RAISE EXCEPTION 'Image command namespace conflict' USING ERRCODE='23514';END IF;
 IF TG_TABLE_SCHEMA='whaleu_media' THEN
  IF r.request_id IS NULL OR ROW(r.conversation_id,r.context_digest) IS DISTINCT FROM ROW(NEW.conversation_id,NEW.context_digest) THEN RAISE EXCEPTION 'Private upload has no exact command reservation' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER dm_image_reservation_causal AFTER INSERT ON whaleu_messaging.image_command_reservations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_messaging.image_namespace_causal();
CREATE CONSTRAINT TRIGGER dm_image_fence_causal AFTER INSERT ON whaleu_messaging.image_command_fences DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_messaging.image_namespace_causal();
CREATE CONSTRAINT TRIGGER dm_image_request_namespace_causal AFTER INSERT OR UPDATE ON whaleu_messaging.requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_messaging.image_namespace_causal();
CREATE CONSTRAINT TRIGGER dm_image_scope_reservation_causal AFTER INSERT ON whaleu_media.private_message_scopes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_messaging.image_namespace_causal();
