-- Independent, content-bound removal of the current custom Profile avatar.
-- No replacement bytes, catalog acceptance, Review grant or provider is seeded.
-- 0128 remains nickname-only, including its avatar-unchanged final proof.
CREATE FUNCTION whaleu_profile.avatar_moderation_appearance_id(actor uuid,request uuid,subject uuid)
RETURNS uuid LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE bytes bytea; value text;BEGIN
 bytes:=substring(sha256(convert_to('whaleu:profile-avatar-moderation-appearance:v1'||chr(10)||actor::text||chr(10)||request::text||chr(10)||subject::text,'UTF8')) FROM 1 FOR 16);
 bytes:=set_byte(bytes,6,(get_byte(bytes,6)&15)|80);bytes:=set_byte(bytes,8,(get_byte(bytes,8)&63)|128);
 value:=encode(bytes,'hex');RETURN (substring(value,1,8)||'-'||substring(value,9,4)||'-'||substring(value,13,4)||'-'||substring(value,17,4)||'-'||substring(value,21,12))::uuid;
END$$;

-- The input is still the full original regional target/ancestor proof. Only
-- the global Media epoch is replaced: these exact Community image rows cannot
-- change while this owner retires a different, Profile-owned binding.
CREATE FUNCTION whaleu_profile.avatar_moderation_media_facts(target_kind text,target uuid)
RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_array(n.kind,n.id,
  (SELECT coalesce(jsonb_agg(jsonb_build_array(to_jsonb(b),b.xmin::text,b.ctid::text,
   to_jsonb(a),a.xmin::text,a.ctid::text,to_jsonb(i),i.xmin::text,i.ctid::text,
   to_jsonb(h),h.xmin::text,h.ctid::text,to_jsonb(e),e.xmin::text,e.ctid::text,
   to_jsonb(o),o.xmin::text,o.ctid::text,
   (SELECT coalesce(jsonb_agg(jsonb_build_array(to_jsonb(v),v.xmin::text,v.ctid::text) ORDER BY v.variant_name),'[]'::jsonb) FROM whaleu_media.variants v WHERE v.asset_id=a.id)
  ) ORDER BY b.id),'[]'::jsonb)
  FROM whaleu_media.bindings b
  LEFT JOIN whaleu_media.assets a ON a.id=b.asset_id
  LEFT JOIN whaleu_media.upload_intents i ON i.id=a.intent_id
  LEFT JOIN whaleu_media.asset_safety_heads h ON h.asset_id=a.id
  LEFT JOIN whaleu_media.asset_safety_events e ON (e.asset_id,e.revision,e.id)=(h.asset_id,h.revision,h.event_id)
  LEFT JOIN whaleu_media.object_attempts o ON o.id=a.object_attempt_id
  WHERE b.owner_kind='community' AND b.resource_kind=n.kind AND b.resource_id=n.id)
 ) ORDER BY n.kind,n.id),'[]'::jsonb)
 FROM whaleu_community.profile_moderation_nodes(target_kind,target) n
$$;
CREATE FUNCTION whaleu_profile.avatar_moderation_input_facts(actor uuid,selected uuid,target_kind text,target uuid)
RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT (whaleu_profile.moderation_input_facts(actor,selected,target_kind,target)-'media')
 ||jsonb_build_object('targetMedia',whaleu_profile.avatar_moderation_media_facts(target_kind,target))
$$;
CREATE FUNCTION whaleu_profile.avatar_moderation_retirement_facts(intent uuid)
RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object(
 'intent',(SELECT jsonb_build_array(to_jsonb(i),i.xmin::text,i.ctid::text) FROM whaleu_media.upload_intents i WHERE i.id=intent),
 'assets',(SELECT coalesce(jsonb_agg(jsonb_build_array(to_jsonb(a),a.xmin::text,a.ctid::text) ORDER BY a.id),'[]'::jsonb) FROM whaleu_media.assets a WHERE a.intent_id=intent),
 'bindings',(SELECT coalesce(jsonb_agg(jsonb_build_array(to_jsonb(b),b.xmin::text,b.ctid::text) ORDER BY b.id),'[]'::jsonb) FROM whaleu_media.bindings b JOIN whaleu_media.assets a ON a.id=b.asset_id WHERE a.intent_id=intent),
 'quota',(SELECT jsonb_build_array(to_jsonb(q),q.xmin::text,q.ctid::text) FROM whaleu_media.quota_reservations q WHERE q.intent_id=intent),
 'attempts',(SELECT coalesce(jsonb_agg(jsonb_build_array(to_jsonb(o),o.xmin::text,o.ctid::text) ORDER BY o.id),'[]'::jsonb) FROM whaleu_media.object_attempts o WHERE o.intent_id=intent),
 'derived',(SELECT coalesce(jsonb_agg(jsonb_build_array(to_jsonb(d),d.xmin::text,d.ctid::text) ORDER BY d.id),'[]'::jsonb) FROM whaleu_media.derived_object_attempts d WHERE d.intent_id=intent),
 'variants',(SELECT coalesce(jsonb_agg(jsonb_build_array(to_jsonb(v),v.xmin::text,v.ctid::text) ORDER BY v.asset_id,v.variant_name),'[]'::jsonb) FROM whaleu_media.variants v JOIN whaleu_media.assets a ON a.id=v.asset_id WHERE a.intent_id=intent),
 'ingress',(SELECT coalesce(jsonb_agg(jsonb_build_array(to_jsonb(g),g.xmin::text,g.ctid::text) ORDER BY g.object_attempt_id),'[]'::jsonb) FROM whaleu_media.upload_ingress g WHERE g.intent_id=intent))
$$;

-- Preserve 0128's exact ancestry body and every fact while preventing repeated
-- SQL-function inlining into canonical-definition/target proof trees. Each
-- mutually exclusive target branch yields at most its post, root and reply.
-- The function-local pg_catalog path changes neither invoker authority nor rows;
-- it is a planning barrier, not a wider statement/proof deadline.
ALTER FUNCTION whaleu_community.profile_moderation_nodes(text,uuid) SET search_path=pg_catalog;
ALTER FUNCTION whaleu_community.profile_moderation_nodes(text,uuid) ROWS 3;

ALTER TABLE whaleu_profile.avatar_definitions ADD COLUMN authority text NOT NULL DEFAULT 'self_selection'
 CHECK(authority IN('self_selection','scoped_moderation_clear'));
-- Replace only the original digest-domain CHECK. All ownership, source and
-- immutable-history constraints remain, and the self-selection domain is exact.
DO $$DECLARE c record;BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='whaleu_profile.avatar_definitions'::regclass AND contype='c'
 AND pg_get_constraintdef(oid) LIKE '%whaleu-profile-avatar-review:v1%' LOOP
  EXECUTE format('ALTER TABLE whaleu_profile.avatar_definitions DROP CONSTRAINT %I',c.conname);
 END LOOP;
END$$;
ALTER TABLE whaleu_profile.avatar_definitions ADD CONSTRAINT avatar_definition_authority_digest CHECK(
 (authority='self_selection' AND digest=encode(sha256(convert_to('whaleu-profile-avatar-review:v1'||chr(10)||whaleu_community.content_canonical_json(envelope),'UTF8')),'hex'))
 OR (authority='scoped_moderation_clear' AND source='{"kind":"clear"}'::jsonb AND binding_id IS NULL
 AND digest=encode(sha256(convert_to('whaleu-profile-avatar-moderation:v1'||chr(10)||whaleu_community.content_canonical_json(envelope),'UTF8')),'hex')));

CREATE TABLE whaleu_profile.avatar_moderation_commands (
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,
 session_id uuid NOT NULL REFERENCES whaleu_identity.sessions(id),token_hash text NOT NULL,
 target_kind text NOT NULL CHECK(target_kind IN('post','comment','reply')),target_id uuid NOT NULL,
 intent_hash text NOT NULL,command jsonb NOT NULL,receipt jsonb NOT NULL,
 -- These are deliberately FK-free. Cancellation acquires no grant, content,
 -- subject Profile or Media relation lock, including nullable-FK lookup locks.
 grant_id uuid,subject_id uuid,post_id uuid,root_id uuid,original_region_id uuid,
 identity_hash text NOT NULL,input_hash text,media_before_hash text,before_revision integer,
 before_hash text,before_fingerprint text,unchanged_hash text,avatar_hash text,
 previous_appearance_id uuid,appearance_id uuid,old_binding_id uuid,old_asset_id uuid,old_intent_id uuid,retirement_before jsonb,
 mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 PRIMARY KEY(actor_id,request_id),
 CHECK(request_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 CHECK(octet_length(command::text)<4096 AND octet_length(receipt::text)<4096),
 CHECK(intent_hash=encode(sha256(convert_to('whaleu:profile-avatar-moderation-command:v1'||chr(10)||whaleu_community.content_canonical_json(jsonb_build_object('actor',actor_id::text,'command',command)),'UTF8')),'hex'))
);
CREATE INDEX avatar_moderation_commands_transaction ON whaleu_profile.avatar_moderation_commands(mutation_transaction,subject_id);
CREATE UNIQUE INDEX avatar_moderation_one_subject_transaction ON whaleu_profile.avatar_moderation_commands(mutation_transaction,subject_id) WHERE receipt->>'outcome'='applied';
CREATE TABLE whaleu_profile.avatar_moderation_transitions (
 actor_id uuid NOT NULL,request_id uuid NOT NULL,subject_id uuid NOT NULL REFERENCES whaleu_profile.profiles(account_id),
 before_revision integer NOT NULL,after_revision integer NOT NULL,
 before_hash text NOT NULL,after_hash text NOT NULL,after_fingerprint text NOT NULL,unchanged_hash text NOT NULL,
 mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),PRIMARY KEY(actor_id,request_id),
 FOREIGN KEY(actor_id,request_id) REFERENCES whaleu_profile.avatar_moderation_commands(actor_id,request_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE whaleu_profile.avatar_moderation_pointer_transitions (
 actor_id uuid NOT NULL,request_id uuid NOT NULL,subject_id uuid NOT NULL REFERENCES whaleu_profile.profiles(account_id),
 previous_appearance_id uuid NOT NULL,appearance_id uuid NOT NULL,before_hash text NOT NULL,after_hash text NOT NULL,
 mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),PRIMARY KEY(actor_id,request_id),
 FOREIGN KEY(actor_id,request_id) REFERENCES whaleu_profile.avatar_moderation_commands(actor_id,request_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE whaleu_profile.avatar_moderation_events (
 id uuid PRIMARY KEY,actor_id uuid NOT NULL,request_id uuid NOT NULL,subject_id uuid NOT NULL REFERENCES whaleu_profile.profiles(account_id),
 target_kind text NOT NULL,target_id uuid NOT NULL,post_id uuid NOT NULL,root_id uuid,original_region_id uuid NOT NULL,
 grant_id uuid NOT NULL REFERENCES whaleu_authorization.role_grants(id),selected_authority jsonb NOT NULL,
 before_revision integer NOT NULL,revision integer NOT NULL,
 previous_appearance_id uuid NOT NULL REFERENCES whaleu_profile.avatar_definitions(id),appearance_id uuid NOT NULL UNIQUE REFERENCES whaleu_profile.avatar_definitions(id),
 old_binding_id uuid NOT NULL REFERENCES whaleu_media.bindings(id),
 recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
 mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),UNIQUE(actor_id,request_id),UNIQUE(subject_id,revision),
 FOREIGN KEY(actor_id,request_id) REFERENCES whaleu_profile.avatar_moderation_commands(actor_id,request_id) DEFERRABLE INITIALLY DEFERRED,
 CHECK(before_revision BETWEEN 0 AND 2147483646 AND revision=before_revision+1)
);
CREATE TABLE whaleu_notifications.profile_avatar_moderation_notices (
 id uuid PRIMARY KEY,event_id uuid NOT NULL UNIQUE REFERENCES whaleu_profile.avatar_moderation_events(id),
 recipient_account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 kind text NOT NULL DEFAULT 'profile_custom_avatar_cleared' CHECK(kind='profile_custom_avatar_cleared'),
 created_at timestamptz NOT NULL CHECK(isfinite(created_at) AND created_at=date_trunc('milliseconds',created_at)),read_at timestamptz,
 CHECK(read_at IS NULL OR (isfinite(read_at) AND read_at>=created_at AND read_at=date_trunc('milliseconds',read_at)))
);
CREATE INDEX profile_avatar_moderation_notice_page ON whaleu_notifications.profile_avatar_moderation_notices(recipient_account_id,created_at DESC,id DESC);
CREATE INDEX profile_avatar_moderation_notice_unread ON whaleu_notifications.profile_avatar_moderation_notices(recipient_account_id) WHERE read_at IS NULL;
DO $$DECLARE name text;BEGIN
 FOREACH name IN ARRAY ARRAY['avatar_moderation_commands','avatar_moderation_events','avatar_moderation_transitions','avatar_moderation_pointer_transitions'] LOOP
  EXECUTE format('CREATE TRIGGER avatar_moderation_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_profile.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_profile.moderation_immutable()',name);
 END LOOP;
END$$;

CREATE FUNCTION whaleu_profile.avatar_moderation_command_guard() RETURNS trigger LANGUAGE plpgsql AS $$
-- Unused source rowtype declarations themselves open relations on a cold backend.
-- Records acquire their exact row shape only after the session-only early exits.
DECLARE target_row record;p record;d record;b record;a record;i record;
 expected integer;applicable boolean;captured_media_hash text;BEGIN
 IF current_setting('transaction_isolation')<>'read committed' OR NEW.mutation_transaction<>pg_current_xact_id()
 OR whaleu_community.post_owner_visibility_keys(NEW.command,ARRAY['clientRequestId','target','expectedProfileRevision','expectedAppearanceId','action']) IS DISTINCT FROM true
 OR whaleu_community.post_owner_visibility_keys(NEW.command->'target',ARRAY['kind','id']) IS DISTINCT FROM true
 OR NOT whaleu_profile.moderation_uuid_valid(NEW.target_id::text)
 OR NEW.command->>'clientRequestId' IS DISTINCT FROM NEW.request_id::text
 OR NEW.command->'target'->>'kind' IS DISTINCT FROM NEW.target_kind OR NEW.command->'target'->>'id' IS DISTINCT FROM NEW.target_id::text
 OR NEW.command->>'action' IS DISTINCT FROM 'clear_custom_avatar'
 OR (jsonb_typeof(NEW.command->'expectedAppearanceId')='string' AND whaleu_profile.moderation_uuid_valid(NEW.command->>'expectedAppearanceId')) IS DISTINCT FROM true
 OR (jsonb_typeof(NEW.command->'expectedProfileRevision')='number' AND (NEW.command->>'expectedProfileRevision')~'^(0|[1-9][0-9]{0,9})$' AND (NEW.command->>'expectedProfileRevision')::numeric BETWEEN 0 AND 2147483646) IS DISTINCT FROM true
 OR NEW.receipt->>'requestId' IS DISTINCT FROM NEW.request_id::text OR NEW.receipt->'target' IS DISTINCT FROM NEW.command->'target'
 OR NEW.receipt->>'action' IS DISTINCT FROM 'clear_custom_avatar'
 OR NEW.receipt->'expectedProfileRevision' IS DISTINCT FROM NEW.command->'expectedProfileRevision'
 OR NEW.receipt->'expectedAppearanceId' IS DISTINCT FROM NEW.command->'expectedAppearanceId'
 OR whaleu_community.post_owner_visibility_keys(NEW.receipt,CASE WHEN NEW.receipt->>'outcome'='rejected' THEN ARRAY['requestId','target','expectedProfileRevision','expectedAppearanceId','action','outcome','code'] ELSE ARRAY['requestId','target','expectedProfileRevision','expectedAppearanceId','action','outcome','revision','eventId','recordedAt'] END) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'Strict exact avatar moderation command required' USING ERRCODE='23514',CONSTRAINT='profile_avatar_moderation_causal';END IF;
 expected:=(NEW.command->>'expectedProfileRevision')::integer;
 IF NEW.receipt->>'outcome'='rejected' THEN
  IF coalesce(NEW.receipt->>'code' IN('PROFILE_AVATAR_MODERATION_STALE','PROFILE_AVATAR_MODERATION_NOT_APPLICABLE','PROFILE_AVATAR_MODERATION_CANCELLED'),false)=false
  THEN RAISE EXCEPTION 'Exact terminal avatar rejection required' USING ERRCODE='23514',CONSTRAINT='profile_avatar_moderation_causal';END IF;
 ELSE
  IF NEW.receipt->>'outcome' IS DISTINCT FROM 'applied' OR NEW.receipt->'revision' IS DISTINCT FROM to_jsonb(expected+1)
  OR (jsonb_typeof(NEW.receipt->'eventId')='string' AND whaleu_profile.moderation_uuid_valid(NEW.receipt->>'eventId')) IS DISTINCT FROM true
  OR (jsonb_typeof(NEW.receipt->'recordedAt')='string' AND (NEW.receipt->>'recordedAt')~'^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]{1,3})?Z$') IS DISTINCT FROM true
  OR (NEW.receipt->>'recordedAt')::timestamptz>clock_timestamp()
  THEN RAISE EXCEPTION 'Exact applied avatar receipt required' USING ERRCODE='23514',CONSTRAINT='profile_avatar_moderation_causal';END IF;
 END IF;
 PERFORM id FROM whaleu_identity.accounts WHERE id=NEW.actor_id FOR SHARE NOWAIT;
 PERFORM id FROM whaleu_identity.sessions WHERE id=NEW.session_id AND account_id=NEW.actor_id FOR SHARE NOWAIT;
 PERFORM token_hash FROM whaleu_identity.access_tokens WHERE token_hash=NEW.token_hash AND session_id=NEW.session_id FOR SHARE NOWAIT;
 IF NOT whaleu_profile.moderation_identity_current(NEW.actor_id,NEW.session_id,NEW.token_hash)
 THEN RAISE EXCEPTION 'Current actor required' USING ERRCODE='23514',CONSTRAINT='profile_avatar_moderation_causal';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:profile-avatar-moderation-request:v1:'||NEW.actor_id::text||':'||NEW.request_id::text,0));
 -- Raw duplicate insertion is never new authority. The primary-key rejection
 -- must precede every source gate, just like the API's terminal receipt read.
 IF EXISTS(SELECT 1 FROM whaleu_profile.avatar_moderation_commands existing WHERE existing.actor_id=NEW.actor_id AND existing.request_id=NEW.request_id) THEN
  RAISE EXCEPTION 'Avatar moderation original key already recorded' USING ERRCODE='23505',CONSTRAINT='avatar_moderation_commands_pkey';
 END IF;
 NEW.identity_hash:=whaleu_profile.moderation_hash(whaleu_profile.moderation_identity_facts(NEW.actor_id,NEW.session_id,NEW.token_hash));
 -- Never trust caller-supplied captured facts, including on rejection/cancel.
 NEW.subject_id:=NULL;NEW.post_id:=NULL;NEW.root_id:=NULL;NEW.original_region_id:=NULL;NEW.input_hash:=NULL;NEW.before_revision:=NULL;
 NEW.before_hash:=NULL;NEW.before_fingerprint:=NULL;NEW.unchanged_hash:=NULL;NEW.avatar_hash:=NULL;
 NEW.previous_appearance_id:=NULL;NEW.appearance_id:=NULL;NEW.old_binding_id:=NULL;NEW.old_asset_id:=NULL;NEW.old_intent_id:=NULL;NEW.retirement_before:=NULL;
 IF NEW.receipt->>'code'='PROFILE_AVATAR_MODERATION_CANCELLED' THEN
  NEW.media_before_hash:=NULL;
  IF NEW.grant_id IS NOT NULL THEN RAISE EXCEPTION 'Cancellation is session-only original-key metadata' USING ERRCODE='23514',CONSTRAINT='profile_avatar_moderation_causal';END IF;
  RETURN NEW;
 END IF;
 -- Match the existing self-selection/Media writer order before observing any
 -- owner epoch, source or subject; cancellation returned above without this gate.
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
 IF NOT whaleu_profile.avatar_moderation_media_inventory_current() THEN
  RAISE EXCEPTION 'Every installed Media epoch source must retain its avatar moderation gate' USING ERRCODE='23514',CONSTRAINT='profile_avatar_moderation_causal';
 END IF;
 IF current_setting('max_connections')::integer+current_setting('max_prepared_transactions')::integer+current_setting('max_worker_processes')::integer+current_setting('max_wal_senders')::integer>=128
 OR NOT (SELECT count(*)=128 AND min(slot)=0 AND max(slot)=127 AND bool_and(version=1) FROM whaleu_community.discovery_count_epochs)
 OR NOT (SELECT count(*)=128 AND min(slot)=0 AND max(slot)=127 AND bool_and(version=1) FROM whaleu_safety.discovery_count_epochs)
 OR NOT (SELECT count(*)=128 AND min(slot)=0 AND max(slot)=127 AND bool_and(version=1) FROM whaleu_campus.discovery_count_epochs)
 OR NOT (SELECT count(*)=128 AND min(slot)=0 AND max(slot)=127 AND bool_and(version=1) FROM whaleu_media.media_owner_states)
 THEN RAISE EXCEPTION 'Existing bounded owner epoch admission required' USING ERRCODE='23514',CONSTRAINT='profile_avatar_moderation_causal';END IF;
 SELECT * INTO target_row FROM whaleu_community.profile_moderation_target(NEW.target_kind,NEW.target_id);
 IF target_row.subject_id IS NULL THEN RAISE EXCEPTION 'Named original regional target required' USING ERRCODE='23514',CONSTRAINT='profile_avatar_moderation_causal';END IF;
 PERFORM id FROM whaleu_community.posts WHERE id=target_row.post_id FOR UPDATE NOWAIT;
 IF target_row.root_id IS NOT NULL THEN PERFORM id FROM whaleu_community.root_comments WHERE id=target_row.root_id FOR SHARE NOWAIT;END IF;
 IF NEW.target_kind='reply' THEN PERFORM id FROM whaleu_community.replies WHERE id=NEW.target_id FOR SHARE NOWAIT;END IF;
 PERFORM id FROM whaleu_authorization.role_grants WHERE id=NEW.grant_id FOR SHARE NOWAIT;
 IF NOT whaleu_profile.moderation_grant_allowed(NEW.actor_id,NEW.grant_id,target_row.region_id)
 OR NOT whaleu_community.profile_moderation_supported(NEW.actor_id,NEW.target_kind,NEW.target_id)
 OR NOT whaleu_profile.moderation_actor_current(NEW.actor_id,clock_timestamp())
 THEN RAISE EXCEPTION 'Current scoped avatar authority required' USING ERRCODE='23514',CONSTRAINT='profile_avatar_moderation_causal';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('whaleu:profile-avatar:actor:v1:'||target_row.subject_id::text,0))
 THEN RAISE EXCEPTION 'Subject avatar writer busy' USING ERRCODE='55P03';END IF;
 SELECT * INTO p FROM whaleu_profile.profiles WHERE account_id=target_row.subject_id FOR UPDATE NOWAIT;
 IF p.account_id IS NULL OR p.public_id IS NULL THEN RAISE EXCEPTION 'Existing subject Profile required' USING ERRCODE='23514',CONSTRAINT='profile_avatar_moderation_causal';END IF;
 SELECT definition.* INTO d FROM whaleu_profile.avatar_current c JOIN whaleu_profile.avatar_definitions definition ON (definition.id,definition.actor_id)=(c.appearance_id,c.actor_id) WHERE c.actor_id=p.account_id;
 applicable:=coalesce(d.id::text=NEW.command->>'expectedAppearanceId' AND d.source->>'kind'='custom',false);
 IF (NEW.receipt->>'outcome'='applied' AND (p.revision<>expected OR NOT applicable))
 OR (NEW.receipt->>'code'='PROFILE_AVATAR_MODERATION_STALE' AND p.revision=expected)
 OR (NEW.receipt->>'code'='PROFILE_AVATAR_MODERATION_NOT_APPLICABLE' AND (p.revision<>expected OR applicable))
 THEN RAISE EXCEPTION 'Exact shared Profile CAS and current custom appearance required' USING ERRCODE='23514',CONSTRAINT='profile_avatar_moderation_causal';END IF;
 NEW.subject_id:=target_row.subject_id;NEW.post_id:=target_row.post_id;NEW.root_id:=target_row.root_id;NEW.original_region_id:=target_row.region_id;
 NEW.before_revision:=p.revision;NEW.before_hash:=whaleu_profile.moderation_hash(to_jsonb(p));
 SELECT whaleu_profile.moderation_hash(jsonb_build_array(to_jsonb(current),current.xmin::text,current.ctid::text)) INTO NEW.before_fingerprint FROM whaleu_profile.profiles current WHERE current.account_id=p.account_id;
 NEW.unchanged_hash:=whaleu_profile.moderation_hash(to_jsonb(p)-ARRAY['revision','updated_at']);
 NEW.avatar_hash:=whaleu_profile.moderation_hash(whaleu_profile.moderation_avatar_facts(p.account_id));
 NEW.input_hash:=whaleu_profile.moderation_hash(whaleu_profile.avatar_moderation_input_facts(NEW.actor_id,NEW.grant_id,NEW.target_kind,NEW.target_id));
 NEW.previous_appearance_id:=d.id;
 IF NEW.receipt->>'outcome'='applied' THEN
  NEW.appearance_id:=whaleu_profile.avatar_moderation_appearance_id(NEW.actor_id,NEW.request_id,p.account_id);
  SELECT * INTO b FROM whaleu_media.bindings WHERE id=d.binding_id;
  SELECT * INTO a FROM whaleu_media.assets WHERE id=b.asset_id;
  PERFORM id FROM whaleu_media.upload_intents WHERE id=a.intent_id FOR UPDATE NOWAIT;
  PERFORM id FROM whaleu_media.assets WHERE id=a.id FOR UPDATE NOWAIT;
  PERFORM id FROM whaleu_media.bindings WHERE id=b.id FOR UPDATE NOWAIT;
  -- These are the only other mutable old rows retirement may change. Retain
  -- their original physical tuples as well as payloads across the transition.
  PERFORM intent_id FROM whaleu_media.quota_reservations WHERE intent_id=a.intent_id FOR UPDATE NOWAIT;
  PERFORM object_attempt_id FROM whaleu_media.upload_ingress WHERE intent_id=a.intent_id ORDER BY object_attempt_id FOR UPDATE NOWAIT;
  SELECT * INTO i FROM whaleu_media.upload_intents WHERE id=a.intent_id;
  IF b.id IS NULL OR a.id IS NULL OR i.id IS NULL OR b.detached_at IS NOT NULL
  OR (b.owner_kind,b.resource_kind,b.resource_id,b.content_version,b.slot,b.ordinal) IS DISTINCT FROM ('profile','avatar',d.id,1::bigint,'avatar',0)
  OR (a.actor_id,a.owner_kind,a.resource_kind,a.slot,a.resource_id::text,a.id::text,a.manifest_digest) IS DISTINCT FROM (p.account_id,'profile','avatar','avatar',d.source->>'editId',d.source->>'assetId',d.source->>'manifestDigest')
  OR i.actor_id<>p.account_id OR i.owner_kind<>'profile' OR i.resource_kind<>'avatar' OR i.protocol_version<>5
  OR (SELECT count(*) FROM whaleu_media.bindings WHERE asset_id=a.id)<>1
  OR NOT EXISTS(SELECT 1 FROM whaleu_profile.avatar_edits edit WHERE edit.id=a.resource_id AND edit.actor_id=p.account_id AND edit.expected_revision=(d.envelope->>'expectedRevision')::integer)
  THEN RAISE EXCEPTION 'Exact subject-owned live custom binding required' USING ERRCODE='23514',CONSTRAINT='profile_avatar_moderation_causal';END IF;
  NEW.old_binding_id:=b.id;NEW.old_asset_id:=a.id;NEW.old_intent_id:=i.id;
  NEW.retirement_before:=whaleu_profile.avatar_moderation_retirement_facts(i.id);
 END IF;
 -- A managed caller may retain this epoch before its first target read. Compare
 -- inside admission after every preceding lock, never replace its initial fact.
 SELECT whaleu_profile.moderation_hash(jsonb_agg(jsonb_build_array(slot,version,epoch::text) ORDER BY slot)) INTO captured_media_hash FROM whaleu_media.media_owner_states;
 IF NEW.media_before_hash IS NOT NULL AND NEW.media_before_hash IS DISTINCT FROM captured_media_hash THEN
  RAISE EXCEPTION 'Initial avatar moderation Media facts changed before admission' USING ERRCODE='23514',CONSTRAINT='profile_avatar_moderation_causal';
 END IF;
 NEW.media_before_hash:=captured_media_hash;
 RETURN NEW;
END$$;
CREATE TRIGGER avatar_moderation_command_guard BEFORE INSERT ON whaleu_profile.avatar_moderation_commands FOR EACH ROW EXECUTE FUNCTION whaleu_profile.avatar_moderation_command_guard();

CREATE FUNCTION whaleu_profile.avatar_moderation_capture_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_profile.avatar_moderation_commands;fingerprint text;BEGIN
 FOR q IN SELECT * FROM whaleu_profile.avatar_moderation_commands WHERE mutation_transaction=pg_current_xact_id() AND subject_id=OLD.account_id LOOP
  IF q.receipt->>'outcome'<>'applied' OR OLD.account_id<>NEW.account_id OR OLD.revision<>q.before_revision
  OR whaleu_profile.moderation_hash(to_jsonb(OLD))<>q.before_hash
  OR whaleu_profile.moderation_hash(to_jsonb(NEW)-ARRAY['revision','updated_at'])<>q.unchanged_hash
  OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at OR NEW.updated_at>clock_timestamp()
  THEN RAISE EXCEPTION 'Avatar moderation changes only shared revision and update time' USING ERRCODE='23514',CONSTRAINT='profile_avatar_moderation_causal';END IF;
  SELECT whaleu_profile.moderation_hash(jsonb_build_array(to_jsonb(p),p.xmin::text,p.ctid::text)) INTO fingerprint FROM whaleu_profile.profiles p WHERE p.account_id=NEW.account_id;
  INSERT INTO whaleu_profile.avatar_moderation_transitions(actor_id,request_id,subject_id,before_revision,after_revision,before_hash,after_hash,after_fingerprint,unchanged_hash)
  VALUES(q.actor_id,q.request_id,q.subject_id,OLD.revision,NEW.revision,q.before_hash,whaleu_profile.moderation_hash(to_jsonb(NEW)),fingerprint,q.unchanged_hash);
 END LOOP;RETURN NULL;
END$$;
CREATE TRIGGER avatar_moderation_capture_transition AFTER UPDATE ON whaleu_profile.profiles FOR EACH ROW EXECUTE FUNCTION whaleu_profile.avatar_moderation_capture_transition();
CREATE FUNCTION whaleu_profile.avatar_moderation_capture_pointer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_profile.avatar_moderation_commands;BEGIN
 FOR q IN SELECT * FROM whaleu_profile.avatar_moderation_commands WHERE mutation_transaction=pg_current_xact_id() AND subject_id=OLD.actor_id LOOP
  IF q.receipt->>'outcome'<>'applied' OR (OLD.actor_id,OLD.appearance_id,NEW.actor_id,NEW.appearance_id) IS DISTINCT FROM (q.subject_id,q.previous_appearance_id,q.subject_id,q.appearance_id)
  OR NOT EXISTS(SELECT 1 FROM whaleu_profile.avatar_moderation_transitions t WHERE (t.actor_id,t.request_id)=(q.actor_id,q.request_id) AND t.mutation_transaction=pg_current_xact_id())
  THEN RAISE EXCEPTION 'Exact original custom to system-clear pointer transition required' USING ERRCODE='23514',CONSTRAINT='profile_avatar_moderation_causal';END IF;
  INSERT INTO whaleu_profile.avatar_moderation_pointer_transitions(actor_id,request_id,subject_id,previous_appearance_id,appearance_id,before_hash,after_hash)
  VALUES(q.actor_id,q.request_id,q.subject_id,OLD.appearance_id,NEW.appearance_id,q.avatar_hash,whaleu_profile.moderation_hash(whaleu_profile.moderation_avatar_facts(q.subject_id)));
 END LOOP;RETURN NULL;
END$$;
CREATE TRIGGER avatar_moderation_capture_pointer AFTER UPDATE ON whaleu_profile.avatar_current FOR EACH ROW EXECUTE FUNCTION whaleu_profile.avatar_moderation_capture_pointer();
CREATE FUNCTION whaleu_profile.avatar_moderation_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF pg_trigger_depth()<2 OR NEW.mutation_transaction<>pg_current_xact_id()
 THEN RAISE EXCEPTION 'Only actual owner transitions produce avatar moderation causes' USING ERRCODE='23514',CONSTRAINT='profile_avatar_moderation_causal';END IF;RETURN NEW;
END$$;
CREATE TRIGGER avatar_moderation_transition_guard BEFORE INSERT ON whaleu_profile.avatar_moderation_transitions FOR EACH ROW EXECUTE FUNCTION whaleu_profile.avatar_moderation_transition_guard();
CREATE TRIGGER avatar_moderation_transition_guard BEFORE INSERT ON whaleu_profile.avatar_moderation_pointer_transitions FOR EACH ROW EXECUTE FUNCTION whaleu_profile.avatar_moderation_transition_guard();

CREATE FUNCTION whaleu_profile.avatar_moderation_envelope(q whaleu_profile.avatar_moderation_commands) RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT jsonb_build_object('version',1,'purpose','moderate_profile_avatar_clear','accountId',q.subject_id,
 'moderatorAccountId',q.actor_id,'clientRequestId',q.request_id,'eventId',q.receipt->>'eventId',
 'target',q.command->'target','originalRegionId',q.original_region_id,'expectedRevision',q.before_revision,
 'appearanceId',q.appearance_id,'previousAppearanceId',q.previous_appearance_id,'slot','avatar','source',jsonb_build_object('kind','clear'))
$$;
CREATE FUNCTION whaleu_profile.avatar_moderation_definition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_profile.avatar_moderation_commands;BEGIN
 IF NEW.authority='scoped_moderation_clear' THEN
  SELECT * INTO q FROM whaleu_profile.avatar_moderation_commands WHERE appearance_id=NEW.id AND mutation_transaction=pg_current_xact_id();
  IF q.request_id IS NULL OR q.receipt->>'outcome' IS DISTINCT FROM 'applied' OR NEW.actor_id<>q.subject_id
  OR NEW.envelope IS DISTINCT FROM whaleu_profile.avatar_moderation_envelope(q)
  OR NEW.source<>'{"kind":"clear"}'::jsonb OR NEW.binding_id IS NOT NULL
  THEN RAISE EXCEPTION 'System clear definition requires its original scoped command' USING ERRCODE='23514',CONSTRAINT='profile_avatar_moderation_causal';END IF;
 ELSIF EXISTS(SELECT 1 FROM whaleu_profile.avatar_moderation_commands WHERE mutation_transaction=pg_current_xact_id() AND subject_id=NEW.actor_id) THEN
  RAISE EXCEPTION 'Moderation cannot manufacture a self-selected appearance' USING ERRCODE='23514',CONSTRAINT='profile_avatar_moderation_causal';
 END IF;RETURN NEW;
END$$;
CREATE TRIGGER avatar_moderation_definition_guard BEFORE INSERT ON whaleu_profile.avatar_definitions FOR EACH ROW EXECUTE FUNCTION whaleu_profile.avatar_moderation_definition_guard();
CREATE FUNCTION whaleu_profile.avatar_moderation_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_profile.avatar_moderation_commands;t whaleu_profile.avatar_moderation_transitions;v whaleu_profile.avatar_moderation_pointer_transitions;authority jsonb;BEGIN
 SELECT * INTO q FROM whaleu_profile.avatar_moderation_commands WHERE actor_id=NEW.actor_id AND request_id=NEW.request_id;
 SELECT * INTO t FROM whaleu_profile.avatar_moderation_transitions WHERE actor_id=NEW.actor_id AND request_id=NEW.request_id;
 SELECT * INTO v FROM whaleu_profile.avatar_moderation_pointer_transitions WHERE actor_id=NEW.actor_id AND request_id=NEW.request_id;
 SELECT jsonb_build_object('id',g.id,'accountId',g.account_id,'role',g.role,'operatingRegionId',g.operating_region_id,'validFrom',g.valid_from,'expiresAt',g.expires_at) INTO authority FROM whaleu_authorization.role_grants g WHERE id=q.grant_id;
 IF NEW.selected_authority IS NULL THEN NEW.selected_authority:=authority;END IF;
 IF q.request_id IS NULL OR t.request_id IS NULL OR v.request_id IS NULL
 OR q.mutation_transaction<>pg_current_xact_id() OR t.mutation_transaction<>pg_current_xact_id() OR v.mutation_transaction<>pg_current_xact_id() OR NEW.mutation_transaction<>pg_current_xact_id()
 OR (NEW.subject_id,NEW.target_kind,NEW.target_id,NEW.post_id,NEW.root_id,NEW.original_region_id,NEW.grant_id) IS DISTINCT FROM (q.subject_id,q.target_kind,q.target_id,q.post_id,q.root_id,q.original_region_id,q.grant_id)
 OR (NEW.before_revision,NEW.revision,NEW.previous_appearance_id,NEW.appearance_id,NEW.old_binding_id) IS DISTINCT FROM (t.before_revision,t.after_revision,q.previous_appearance_id,q.appearance_id,q.old_binding_id)
 OR (v.subject_id,v.previous_appearance_id,v.appearance_id) IS DISTINCT FROM (q.subject_id,q.previous_appearance_id,q.appearance_id)
 OR q.receipt->>'outcome' IS DISTINCT FROM 'applied' OR q.receipt->>'eventId' IS DISTINCT FROM NEW.id::text OR q.receipt->>'revision' IS DISTINCT FROM NEW.revision::text
 OR (q.receipt->>'recordedAt')::timestamptz IS DISTINCT FROM NEW.recorded_at OR NEW.recorded_at>clock_timestamp() OR NEW.selected_authority IS DISTINCT FROM authority
 THEN RAISE EXCEPTION 'Exact scoped avatar event and real dual transition required' USING ERRCODE='23514',CONSTRAINT='profile_avatar_moderation_causal';END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER avatar_moderation_event_guard BEFORE INSERT ON whaleu_profile.avatar_moderation_events FOR EACH ROW EXECUTE FUNCTION whaleu_profile.avatar_moderation_event_guard();

-- Historical system authority is immutable. It deliberately does not query a
-- current grant, source publication, phone, Review or Media Safety head.
CREATE FUNCTION whaleu_profile.avatar_moderation_definition_authorized(appearance uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_profile.avatar_definitions d
 JOIN whaleu_profile.avatar_moderation_events e ON e.appearance_id=d.id AND e.subject_id=d.actor_id
 JOIN whaleu_profile.avatar_moderation_commands q ON (q.actor_id,q.request_id)=(e.actor_id,e.request_id)
 JOIN whaleu_profile.avatar_moderation_transitions t ON (t.actor_id,t.request_id)=(e.actor_id,e.request_id)
 JOIN whaleu_profile.avatar_moderation_pointer_transitions v ON (v.actor_id,v.request_id)=(e.actor_id,e.request_id)
 WHERE d.id=appearance AND d.authority='scoped_moderation_clear' AND d.source='{"kind":"clear"}'::jsonb AND d.binding_id IS NULL
 AND d.envelope=whaleu_profile.avatar_moderation_envelope(q)
 AND q.receipt->>'outcome'='applied' AND q.receipt->>'eventId'=e.id::text AND q.receipt->>'revision'=e.revision::text
 AND (q.subject_id,q.previous_appearance_id,q.appearance_id,q.old_binding_id,q.before_revision)=(e.subject_id,e.previous_appearance_id,e.appearance_id,e.old_binding_id,e.before_revision)
 AND (t.subject_id,t.before_revision,t.after_revision)=(e.subject_id,e.before_revision,e.revision)
 AND (v.subject_id,v.previous_appearance_id,v.appearance_id)=(e.subject_id,e.previous_appearance_id,e.appearance_id)
 AND (q.mutation_transaction,t.mutation_transaction,v.mutation_transaction)=(e.mutation_transaction,e.mutation_transaction,e.mutation_transaction)
 AND NOT EXISTS(SELECT 1 FROM whaleu_profile.avatar_command_receipts self WHERE self.appearance_id=d.id)
 AND NOT EXISTS(SELECT 1 FROM whaleu_community.profile_avatar_approval_bindings self WHERE self.appearance_id=d.id))
$$;

CREATE OR REPLACE FUNCTION whaleu_profile.avatar_definition_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE definition whaleu_profile.avatar_definitions; receipt whaleu_profile.avatar_command_receipts; media whaleu_media.bindings; selected uuid; expected_id uuid; candidate uuid; current_revision integer;
BEGIN
 -- A deferred check evaluates the final owner graph after all replacements,
 -- bindings and receipts, never the temporary order of those writes.
 IF TG_TABLE_SCHEMA='whaleu_media' THEN
  IF NEW.owner_kind<>'profile' THEN RETURN NULL; END IF;
  candidate:=NEW.resource_id;
 ELSIF TG_TABLE_NAME='avatar_definitions' THEN candidate:=NEW.id;
 ELSIF TG_TABLE_NAME='avatar_command_receipts' THEN candidate:=NEW.appearance_id;
 ELSE candidate:=NEW.appearance_id;
 END IF;
 SELECT * INTO definition FROM whaleu_profile.avatar_definitions WHERE id=candidate;
 IF NOT FOUND THEN RAISE EXCEPTION 'Profile appearance definition absent' USING ERRCODE='23514'; END IF;
 SELECT appearance_id INTO selected FROM whaleu_profile.avatar_current WHERE actor_id=definition.actor_id;
 -- The historical self-selection body below is unchanged. Only this explicit
 -- system-clear authority branch substitutes immutable scoped causality.
 IF definition.authority='scoped_moderation_clear' THEN
  IF NOT whaleu_profile.avatar_moderation_definition_authorized(definition.id) THEN
   RAISE EXCEPTION 'System-clear appearance cause absent' USING ERRCODE='23514',CONSTRAINT='profile_avatar_moderation_causal';
  END IF;
  IF TG_TABLE_SCHEMA='whaleu_profile' AND TG_TABLE_NAME='avatar_current' THEN
   IF TG_OP<>'UPDATE' OR NOT EXISTS(SELECT 1 FROM whaleu_profile.avatar_moderation_pointer_transitions t
    JOIN whaleu_profile.avatar_moderation_commands q USING(actor_id,request_id)
    WHERE t.subject_id=definition.actor_id AND t.appearance_id=definition.id AND t.previous_appearance_id=OLD.appearance_id
    AND t.mutation_transaction=pg_current_xact_id() AND q.mutation_transaction=pg_current_xact_id() AND q.receipt->>'outcome'='applied') THEN
    RAISE EXCEPTION 'A historical system clear cannot be replayed into the current pointer' USING ERRCODE='23514',CONSTRAINT='profile_avatar_moderation_causal';
   END IF;
   SELECT revision INTO current_revision FROM whaleu_profile.profiles WHERE account_id=definition.actor_id;
   IF current_revision IS DISTINCT FROM (definition.envelope->>'expectedRevision')::integer+1 THEN
    RAISE EXCEPTION 'System-clear pointer must use shared Profile CAS' USING ERRCODE='23514',CONSTRAINT='profile_avatar_moderation_causal';
   END IF;
   IF TG_OP='UPDATE' AND OLD.appearance_id<>NEW.appearance_id AND EXISTS(SELECT 1 FROM whaleu_profile.avatar_definitions d JOIN whaleu_media.bindings b ON b.id=d.binding_id WHERE d.id=OLD.appearance_id AND b.detached_at IS NULL) THEN
    RAISE EXCEPTION 'Old avatar must detach atomically' USING ERRCODE='23514';
   END IF;
  END IF;
  RETURN NULL;
 END IF;
 SELECT * INTO receipt FROM whaleu_profile.avatar_command_receipts WHERE actor_id=definition.actor_id AND appearance_id=definition.id;
 IF NOT FOUND OR receipt.client_request_id::text IS DISTINCT FROM definition.envelope->>'clientRequestId' OR
 receipt.resulting_revision IS DISTINCT FROM (definition.envelope->>'expectedRevision')::integer+1 OR
 NOT EXISTS(SELECT 1 FROM whaleu_community.profile_avatar_approval_bindings r WHERE r.appearance_id=definition.id AND r.account_id=definition.actor_id AND r.digest=definition.digest AND r.envelope=definition.envelope) THEN
  RAISE EXCEPTION 'Profile appearance receipt or Review absent' USING ERRCODE='23514';
 END IF;
 IF definition.source->>'kind'='custom' THEN
  SELECT * INTO media FROM whaleu_media.bindings WHERE id=definition.binding_id;
  IF NOT FOUND OR media.owner_kind<>'profile' OR media.resource_kind<>'avatar' OR media.resource_id<>definition.id OR media.content_version<>1 OR media.slot<>'avatar' OR media.ordinal<>0 OR
    media.asset_id::text IS DISTINCT FROM definition.source->>'assetId' OR media.manifest_digest IS DISTINCT FROM definition.source->>'manifestDigest' OR
    (selected=definition.id) IS DISTINCT FROM (media.detached_at IS NULL) OR
    NOT EXISTS(SELECT 1 FROM whaleu_media.assets a JOIN whaleu_profile.avatar_edits e ON e.id=a.resource_id AND e.actor_id=a.actor_id WHERE a.id=media.asset_id AND a.actor_id=definition.actor_id AND e.id::text=definition.source->>'editId' AND e.expected_revision=(definition.envelope->>'expectedRevision')::integer) THEN
   RAISE EXCEPTION 'Profile appearance Media graph mismatch' USING ERRCODE='23514';
  END IF;
 END IF;
 IF TG_TABLE_SCHEMA='whaleu_profile' AND TG_TABLE_NAME='avatar_current' THEN
  SELECT revision INTO current_revision FROM whaleu_profile.profiles WHERE account_id=definition.actor_id;
  IF current_revision IS DISTINCT FROM receipt.resulting_revision THEN RAISE EXCEPTION 'Avatar pointer must use shared Profile CAS' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' AND OLD.appearance_id<>NEW.appearance_id AND EXISTS(SELECT 1 FROM whaleu_profile.avatar_definitions d JOIN whaleu_media.bindings b ON b.id=d.binding_id WHERE d.id=OLD.appearance_id AND b.detached_at IS NULL) THEN
   RAISE EXCEPTION 'Old avatar must detach atomically' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NULL;
END $$;

-- Bounded statement receipts prevent late/zero-row Media writes from being
-- hidden by the allowed retirement's epoch advance. The real lifecycle issues
-- one detach, three exact cleanup INSERTs, one ingress retirement, one quota
-- release, and (only from ready) one intent transition. Nothing else is allowed.
CREATE FUNCTION whaleu_profile.avatar_moderation_media_epoch_hash() RETURNS text LANGUAGE sql STABLE AS $$
 SELECT whaleu_profile.moderation_hash(jsonb_agg(jsonb_build_array(slot,version,epoch::text) ORDER BY slot)) FROM whaleu_media.media_owner_states
$$;
CREATE TABLE whaleu_profile.avatar_moderation_media_statements (
 actor_id uuid NOT NULL,request_id uuid NOT NULL,relation_name text NOT NULL,operation text NOT NULL,ordinal integer NOT NULL,
 sequence integer NOT NULL CHECK(sequence>0),epoch_before_hash text NOT NULL,
 mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),PRIMARY KEY(actor_id,request_id,relation_name,operation,ordinal),
 UNIQUE(actor_id,request_id,sequence),
 FOREIGN KEY(actor_id,request_id) REFERENCES whaleu_profile.avatar_moderation_commands(actor_id,request_id)
);
CREATE TABLE whaleu_profile.avatar_moderation_media_epochs (
 actor_id uuid NOT NULL,request_id uuid NOT NULL,statement_sequence integer NOT NULL,
 slot integer NOT NULL,version integer NOT NULL CHECK(version=1),before_epoch bigint NOT NULL,after_epoch bigint NOT NULL,
 before_hash text NOT NULL,after_hash text NOT NULL,mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 PRIMARY KEY(actor_id,request_id,statement_sequence),CHECK(after_epoch=before_epoch+1),
 FOREIGN KEY(actor_id,request_id,statement_sequence) REFERENCES whaleu_profile.avatar_moderation_media_statements(actor_id,request_id,sequence)
);
CREATE TRIGGER avatar_moderation_media_statement_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_profile.avatar_moderation_media_statements FOR EACH STATEMENT EXECUTE FUNCTION whaleu_profile.moderation_immutable();
CREATE TRIGGER avatar_moderation_media_statement_guard BEFORE INSERT ON whaleu_profile.avatar_moderation_media_statements FOR EACH ROW EXECUTE FUNCTION whaleu_profile.avatar_moderation_transition_guard();
CREATE TRIGGER avatar_moderation_media_epoch_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_profile.avatar_moderation_media_epochs FOR EACH STATEMENT EXECUTE FUNCTION whaleu_profile.moderation_immutable();
CREATE TRIGGER avatar_moderation_media_epoch_guard BEFORE INSERT ON whaleu_profile.avatar_moderation_media_epochs FOR EACH ROW EXECUTE FUNCTION whaleu_profile.avatar_moderation_transition_guard();
CREATE FUNCTION whaleu_profile.avatar_moderation_media_statement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_profile.avatar_moderation_commands;s whaleu_profile.avatar_moderation_media_statements;
 limit_count integer;next_ordinal integer;next_sequence integer;relation text;BEGIN
 relation:=TG_TABLE_SCHEMA||'.'||TG_TABLE_NAME;
 FOR q IN SELECT * FROM whaleu_profile.avatar_moderation_commands WHERE mutation_transaction=pg_current_xact_id() LOOP
  IF relation='whaleu_media.media_owner_states' THEN
   SELECT * INTO s FROM whaleu_profile.avatar_moderation_media_statements WHERE actor_id=q.actor_id AND request_id=q.request_id ORDER BY sequence DESC LIMIT 1;
   IF q.receipt->>'outcome' IS DISTINCT FROM 'applied' OR TG_OP<>'UPDATE' OR pg_trigger_depth()<2 OR s.sequence IS NULL
   OR s.sequence<>(SELECT count(*)+1 FROM whaleu_profile.avatar_moderation_media_epochs WHERE actor_id=q.actor_id AND request_id=q.request_id)
   OR s.epoch_before_hash IS DISTINCT FROM whaleu_profile.avatar_moderation_media_epoch_hash()
   THEN RAISE EXCEPTION 'An epoch advance requires one unconsumed exact retirement statement' USING ERRCODE='23514',CONSTRAINT='profile_avatar_moderation_causal';END IF;
   CONTINUE;
  END IF;
  limit_count:=CASE WHEN relation='whaleu_media.cleanup_obligations' AND TG_OP='INSERT' THEN 3
   WHEN relation IN('whaleu_media.bindings','whaleu_media.quota_reservations','whaleu_media.upload_ingress') AND TG_OP='UPDATE' THEN 1
   WHEN relation='whaleu_media.upload_intents' AND TG_OP='UPDATE' AND q.retirement_before->'intent'->0->>'state'='ready' THEN 1 ELSE 0 END;
  IF q.receipt->>'outcome'<>'applied' OR limit_count=0 THEN
   RAISE EXCEPTION 'Only the exact avatar retirement may mutate Media' USING ERRCODE='23514',CONSTRAINT='profile_avatar_moderation_causal';
  END IF;
  SELECT count(*)+1 INTO next_ordinal FROM whaleu_profile.avatar_moderation_media_statements WHERE actor_id=q.actor_id AND request_id=q.request_id AND relation_name=relation AND operation=TG_OP;
  SELECT count(*)+1 INTO next_sequence FROM whaleu_profile.avatar_moderation_media_statements WHERE actor_id=q.actor_id AND request_id=q.request_id;
  IF next_ordinal>limit_count THEN RAISE EXCEPTION 'Unexpected or late avatar Media statement' USING ERRCODE='23514',CONSTRAINT='profile_avatar_moderation_causal';END IF;
  INSERT INTO whaleu_profile.avatar_moderation_media_statements(actor_id,request_id,relation_name,operation,ordinal,sequence,epoch_before_hash)
   VALUES(q.actor_id,q.request_id,relation,TG_OP,next_ordinal,next_sequence,whaleu_profile.avatar_moderation_media_epoch_hash());
 END LOOP;RETURN NULL;
END$$;
-- This is an actual AFTER UPDATE cause, not a caller assertion or a blanket
-- exemption for nested triggers. Exactly one epoch row consumes each statement.
CREATE FUNCTION whaleu_profile.avatar_moderation_capture_media_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_profile.avatar_moderation_commands;s whaleu_profile.avatar_moderation_media_statements;BEGIN
 FOR q IN SELECT * FROM whaleu_profile.avatar_moderation_commands WHERE mutation_transaction=pg_current_xact_id() LOOP
  SELECT * INTO s FROM whaleu_profile.avatar_moderation_media_statements WHERE actor_id=q.actor_id AND request_id=q.request_id ORDER BY sequence DESC LIMIT 1;
  IF q.receipt->>'outcome' IS DISTINCT FROM 'applied' OR s.sequence IS NULL OR pg_trigger_depth()<2
  OR NEW.slot IS DISTINCT FROM OLD.slot OR NEW.version IS DISTINCT FROM OLD.version OR NEW.epoch IS DISTINCT FROM OLD.epoch+1
  THEN RAISE EXCEPTION 'Actual exact retirement epoch transition required' USING ERRCODE='23514',CONSTRAINT='profile_avatar_moderation_causal';END IF;
  INSERT INTO whaleu_profile.avatar_moderation_media_epochs(actor_id,request_id,statement_sequence,slot,version,before_epoch,after_epoch,before_hash,after_hash)
   VALUES(q.actor_id,q.request_id,s.sequence,NEW.slot,NEW.version,OLD.epoch,NEW.epoch,s.epoch_before_hash,whaleu_profile.avatar_moderation_media_epoch_hash());
 END LOOP;RETURN NULL;
END$$;
CREATE TRIGGER avatar_moderation_capture_media_epoch AFTER UPDATE ON whaleu_media.media_owner_states FOR EACH ROW EXECUTE FUNCTION whaleu_profile.avatar_moderation_capture_media_epoch();
CREATE FUNCTION whaleu_profile.avatar_moderation_media_epoch_complete(q whaleu_profile.avatar_moderation_commands) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE s record;previous_hash text:=q.media_before_hash;expected_sequence integer:=1;BEGIN
 FOR s IN SELECT statement.*,epoch.before_hash,epoch.after_hash,epoch.mutation_transaction epoch_transaction
  FROM whaleu_profile.avatar_moderation_media_statements statement
  LEFT JOIN whaleu_profile.avatar_moderation_media_epochs epoch ON (epoch.actor_id,epoch.request_id,epoch.statement_sequence)=(statement.actor_id,statement.request_id,statement.sequence)
  WHERE statement.actor_id=q.actor_id AND statement.request_id=q.request_id ORDER BY statement.sequence LOOP
  IF s.sequence<>expected_sequence OR s.mutation_transaction<>q.mutation_transaction OR s.epoch_transaction IS DISTINCT FROM q.mutation_transaction
  OR s.epoch_before_hash IS DISTINCT FROM previous_hash OR s.before_hash IS DISTINCT FROM previous_hash OR s.after_hash IS NULL THEN RETURN false;END IF;
  previous_hash:=s.after_hash;expected_sequence:=expected_sequence+1;
 END LOOP;
 RETURN previous_hash IS NOT DISTINCT FROM whaleu_profile.avatar_moderation_media_epoch_hash();
END$$;
CREATE FUNCTION whaleu_profile.avatar_moderation_media_inventory_current() RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT NOT EXISTS(SELECT 1 FROM pg_trigger source WHERE source.tgfoid='whaleu_media.advance_owner_epoch()'::regprocedure AND NOT source.tgisinternal AND source.tgenabled<>'D'
  AND ((source.tgtype&1)<>0 OR (source.tgtype&2)<>2 OR NOT EXISTS(
   SELECT 1 FROM pg_trigger guard WHERE guard.tgrelid=source.tgrelid
   AND guard.tgfoid='whaleu_profile.avatar_moderation_media_statement_guard()'::regprocedure
   AND guard.tgtype=62 AND guard.tgenabled IN('O','A') AND guard.tgqual IS NULL AND guard.tgnargs=0 AND NOT guard.tgisinternal)))
$$;
CREATE FUNCTION whaleu_profile.avatar_moderation_media_row_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_profile.avatar_moderation_commands;before_row jsonb;expected_row jsonb;exact boolean;BEGIN
 FOR q IN SELECT * FROM whaleu_profile.avatar_moderation_commands WHERE mutation_transaction=pg_current_xact_id() LOOP
  IF q.receipt->>'outcome'<>'applied' THEN RAISE EXCEPTION 'Rejected avatar command cannot retire Media' USING ERRCODE='23514',CONSTRAINT='profile_avatar_moderation_causal';END IF;
  before_row:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END;exact:=false;
  IF TG_TABLE_NAME='bindings' AND TG_OP='UPDATE' THEN
   SELECT value->0 INTO expected_row FROM jsonb_array_elements(q.retirement_before->'bindings') WHERE value->0->>'id'=OLD.id::text;
   exact:=OLD.id=q.old_binding_id AND before_row=expected_row AND OLD.detached_at IS NULL AND NEW.detached_at IS NOT NULL
    AND NEW.detached_at<=clock_timestamp() AND NEW.detach_reason='profile-avatar-replaced'
    AND (to_jsonb(NEW)-ARRAY['detached_at','detach_reason'])=(before_row-ARRAY['detached_at','detach_reason']);
  ELSIF TG_TABLE_NAME='upload_intents' AND TG_OP='UPDATE' THEN
   expected_row:=q.retirement_before->'intent'->0;
   exact:=OLD.id=q.old_intent_id AND before_row=expected_row AND OLD.state='ready' AND NEW.state='cleanup_pending'
    AND NEW.generation=OLD.generation+1 AND NEW.updated_at>=OLD.updated_at AND NEW.updated_at<=clock_timestamp()
    AND (to_jsonb(NEW)-ARRAY['state','generation','updated_at'])=(before_row-ARRAY['state','generation','updated_at']);
  ELSIF TG_TABLE_NAME='quota_reservations' AND TG_OP='UPDATE' THEN
   expected_row:=q.retirement_before->'quota'->0;
   exact:=OLD.intent_id=q.old_intent_id AND before_row=expected_row AND OLD.released_at IS NULL AND NEW.released_at IS NOT NULL
    AND NEW.released_at<=clock_timestamp() AND (to_jsonb(NEW)-'released_at')=(before_row-'released_at');
  ELSIF TG_TABLE_NAME='upload_ingress' AND TG_OP='UPDATE' THEN
   SELECT value->0 INTO expected_row FROM jsonb_array_elements(q.retirement_before->'ingress') WHERE value->0->>'object_attempt_id'=OLD.object_attempt_id::text;
   exact:=OLD.intent_id=q.old_intent_id AND before_row=expected_row AND OLD.writer_state='writing' AND NEW.writer_state='retiring'
    AND (to_jsonb(NEW)-'writer_state')=(before_row-'writer_state');
  ELSIF TG_TABLE_NAME='cleanup_obligations' AND TG_OP='INSERT' THEN
   exact:=NEW.state='pending' AND NEW.attempt=0 AND NEW.lease_token IS NULL AND NEW.lease_until IS NULL AND NEW.confirmed_deleted_at IS NULL
    AND NEW.ingress_writer_id IS NULL AND NEW.not_before>=statement_timestamp()+interval '2 minutes'
    AND NEW.not_before<=clock_timestamp()+interval '2 minutes 1 second'
    AND ((NEW.object_attempt_id IS NOT NULL AND NEW.reason='intent-cancelled' AND EXISTS(SELECT 1 FROM whaleu_media.object_attempts a
       CROSS JOIN LATERAL (VALUES('staging',a.staging_bucket,a.staging_key,a.source_version),('sealed',a.sealed_bucket,a.sealed_key,a.sealed_version)) o(kind,bucket,key,version)
       WHERE a.id=NEW.object_attempt_id AND a.intent_id=q.old_intent_id AND NEW.effect_key='cleanup:'||a.id::text||':'||o.kind
       AND (NEW.provider,NEW.environment,NEW.bucket,NEW.object_key,NEW.object_version)=(a.provider,a.environment,o.bucket,o.key,o.version)))
     OR (NEW.derived_attempt_id IS NOT NULL AND NEW.reason='intent-terminal' AND EXISTS(SELECT 1 FROM whaleu_media.derived_object_attempts d
       WHERE d.id=NEW.derived_attempt_id AND d.intent_id=q.old_intent_id AND NEW.effect_key='cleanup:derived:'||d.id::text
       AND (NEW.provider,NEW.environment,NEW.bucket,NEW.object_key,NEW.object_version)=(d.provider,d.environment,d.bucket,d.object_key,d.object_version)))
     OR (NEW.asset_id=q.old_asset_id AND NEW.reason='intent-cancelled' AND EXISTS(SELECT 1 FROM whaleu_media.variants v
       WHERE v.asset_id=NEW.asset_id AND v.variant_name=NEW.variant_name AND NEW.effect_key='cleanup:'||v.asset_id::text||':'||v.variant_name
       AND (NEW.provider,NEW.environment,NEW.bucket,NEW.object_key,NEW.object_version)=(v.provider,v.environment,v.bucket,v.object_key,v.object_version))));
  END IF;
  IF exact IS DISTINCT FROM true THEN RAISE EXCEPTION 'Avatar retirement may touch only its original exact rows' USING ERRCODE='23514',CONSTRAINT='profile_avatar_moderation_causal';END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END$$;
DO $$DECLARE relation record;name text;BEGIN
 -- All installed source owners participate, regardless of schema. This includes
 -- School Configuration, Organizations, Activities and Announcements as well as
 -- the shared Media tables. Later uncovered sources make admission fail closed.
 FOR relation IN SELECT DISTINCT n.nspname schema_name,c.relname relation_name
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE c.relkind IN('r','p') AND (n.nspname='whaleu_media' OR EXISTS(SELECT 1 FROM pg_trigger source
   WHERE source.tgrelid=c.oid AND source.tgfoid='whaleu_media.advance_owner_epoch()'::regprocedure AND NOT source.tgisinternal))
  ORDER BY n.nspname,c.relname LOOP
  EXECUTE format('CREATE TRIGGER a00_avatar_moderation_media_statement BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON %I.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_profile.avatar_moderation_media_statement_guard()',relation.schema_name,relation.relation_name);
 END LOOP;
 FOREACH name IN ARRAY ARRAY['bindings','upload_intents','quota_reservations','upload_ingress','cleanup_obligations'] LOOP
  EXECUTE format('CREATE TRIGGER a00_avatar_moderation_media_row BEFORE INSERT OR UPDATE OR DELETE ON whaleu_media.%I FOR EACH ROW EXECUTE FUNCTION whaleu_profile.avatar_moderation_media_row_guard()',name);
 END LOOP;
 IF NOT whaleu_profile.avatar_moderation_media_inventory_current() THEN RAISE EXCEPTION 'Incomplete avatar moderation Media source inventory' USING ERRCODE='23514';END IF;
END$$;

CREATE FUNCTION whaleu_profile.avatar_moderation_retirement_complete(q whaleu_profile.avatar_moderation_commands) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE facts jsonb;before_row jsonb;after_row jsonb;entry jsonb;BEGIN
 facts:=whaleu_profile.avatar_moderation_retirement_facts(q.old_intent_id);
 IF (facts-ARRAY['intent','bindings','quota','ingress']) IS DISTINCT FROM (q.retirement_before-ARRAY['intent','bindings','quota','ingress']) THEN RETURN false;END IF;
 IF jsonb_array_length(facts->'bindings')<>1 THEN RETURN false;END IF;
 before_row:=q.retirement_before->'bindings'->0->0;after_row:=facts->'bindings'->0->0;
 IF (after_row-ARRAY['detached_at','detach_reason']) IS DISTINCT FROM (before_row-ARRAY['detached_at','detach_reason'])
 OR after_row->>'id' IS DISTINCT FROM q.old_binding_id::text OR after_row->>'detached_at' IS NULL OR after_row->>'detach_reason' IS DISTINCT FROM 'profile-avatar-replaced' THEN RETURN false;END IF;
 before_row:=q.retirement_before->'intent'->0;after_row:=facts->'intent'->0;
 IF before_row->>'state'='ready' THEN
  IF (after_row-ARRAY['state','generation','updated_at']) IS DISTINCT FROM (before_row-ARRAY['state','generation','updated_at'])
  OR after_row->>'state' IS DISTINCT FROM 'cleanup_pending' OR (after_row->>'generation')::bigint IS DISTINCT FROM (before_row->>'generation')::bigint+1 THEN RETURN false;END IF;
 ELSE
  IF facts->'intent' IS DISTINCT FROM q.retirement_before->'intent' OR after_row->>'state' NOT IN('cancelled','expired','rejected','cleanup_pending','deleting','deleted') THEN RETURN false;END IF;
 END IF;
 before_row:=q.retirement_before->'quota'->0;after_row:=facts->'quota'->0;
 IF before_row IS NULL OR after_row IS NULL OR (after_row-'released_at') IS DISTINCT FROM (before_row-'released_at') OR after_row->>'released_at' IS NULL
 OR (before_row->>'released_at' IS NOT NULL AND facts->'quota' IS DISTINCT FROM q.retirement_before->'quota') THEN RETURN false;END IF;
 IF jsonb_array_length(facts->'ingress')<>jsonb_array_length(q.retirement_before->'ingress') THEN RETURN false;END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(q.retirement_before->'ingress') LOOP
  before_row:=entry->0;
  SELECT value->0 INTO after_row FROM jsonb_array_elements(facts->'ingress') WHERE value->0->>'object_attempt_id'=before_row->>'object_attempt_id';
  IF after_row IS NULL OR (after_row-'writer_state') IS DISTINCT FROM (before_row-'writer_state')
  OR after_row->>'writer_state' IS DISTINCT FROM (CASE WHEN before_row->>'writer_state'='writing' THEN 'retiring' ELSE before_row->>'writer_state' END) THEN RETURN false;END IF;
 END LOOP;
 -- Every known immutable locator receives a durable obligation. Existing exact
 -- collisions remain retained; this command does not claim physical deletion.
 IF EXISTS(SELECT 1 FROM (
   SELECT a.provider,a.environment,o.bucket,o.key,o.version FROM whaleu_media.object_attempts a CROSS JOIN LATERAL (VALUES(a.staging_bucket,a.staging_key,a.source_version),(a.sealed_bucket,a.sealed_key,a.sealed_version)) o(bucket,key,version) WHERE a.intent_id=q.old_intent_id AND o.version IS NOT NULL
   UNION ALL SELECT d.provider,d.environment,d.bucket,d.object_key,d.object_version FROM whaleu_media.derived_object_attempts d WHERE d.intent_id=q.old_intent_id
   UNION ALL SELECT v.provider,v.environment,v.bucket,v.object_key,v.object_version FROM whaleu_media.variants v WHERE v.asset_id=q.old_asset_id
  ) objects WHERE NOT EXISTS(SELECT 1 FROM whaleu_media.cleanup_obligations c WHERE (c.provider,c.environment,c.bucket,c.object_key,c.object_version)=(objects.provider,objects.environment,objects.bucket,objects.key,objects.version)))
 OR EXISTS(SELECT 1 FROM whaleu_media.bindings b JOIN whaleu_media.assets a ON a.id=b.asset_id WHERE a.intent_id=q.old_intent_id AND b.detached_at IS NULL) THEN RETURN false;END IF;
 RETURN true;
END$$;

CREATE FUNCTION whaleu_notifications.profile_avatar_moderation_notice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e whaleu_profile.avatar_moderation_events;BEGIN
 IF TG_OP IN('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Avatar notice retained' USING ERRCODE='23514',CONSTRAINT='profile_avatar_moderation_causal';END IF;
 IF TG_OP='UPDATE' THEN
  SELECT * INTO e FROM whaleu_profile.avatar_moderation_events WHERE id=OLD.event_id;
  IF e.mutation_transaction=pg_current_xact_id() THEN RAISE EXCEPTION 'New avatar notice must commit unread' USING ERRCODE='23514',CONSTRAINT='profile_avatar_moderation_causal';END IF;
  IF (to_jsonb(NEW)-'read_at') IS DISTINCT FROM (to_jsonb(OLD)-'read_at') OR NEW.read_at IS NULL OR (OLD.read_at IS NOT NULL AND NEW.read_at<>OLD.read_at) OR NEW.read_at>clock_timestamp()
  THEN RAISE EXCEPTION 'Only first owner read timestamp can change' USING ERRCODE='23514',CONSTRAINT='profile_avatar_moderation_causal';END IF;
 ELSE
  SELECT * INTO e FROM whaleu_profile.avatar_moderation_events WHERE id=NEW.event_id;
  IF e.id IS NULL OR e.mutation_transaction<>pg_current_xact_id() OR (NEW.recipient_account_id,NEW.created_at) IS DISTINCT FROM (e.subject_id,e.recorded_at) OR NEW.read_at IS NOT NULL
  THEN RAISE EXCEPTION 'Avatar notice requires same-transaction event' USING ERRCODE='23514',CONSTRAINT='profile_avatar_moderation_causal';END IF;
 END IF;
 INSERT INTO whaleu_notifications.system_notice_owners(account_id) VALUES(NEW.recipient_account_id) ON CONFLICT DO NOTHING;
 PERFORM account_id FROM whaleu_notifications.system_notice_owners WHERE account_id=NEW.recipient_account_id FOR UPDATE;
 RETURN NEW;
END$$;
CREATE TRIGGER profile_avatar_moderation_notice_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_notifications.profile_avatar_moderation_notices FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.profile_avatar_moderation_notice_guard();
CREATE TRIGGER profile_avatar_moderation_notice_retain BEFORE TRUNCATE ON whaleu_notifications.profile_avatar_moderation_notices FOR EACH STATEMENT EXECUTE FUNCTION whaleu_notifications.profile_avatar_moderation_notice_guard();
ALTER TABLE whaleu_notifications.system_notice_ids DROP CONSTRAINT system_notice_ids_kind_check;
ALTER TABLE whaleu_notifications.system_notice_ids ADD CONSTRAINT system_notice_ids_kind_check CHECK(kind IN('post_jury_removed','profile_nickname_reset','profile_custom_avatar_cleared'));
CREATE TRIGGER register_system_notice_id AFTER INSERT ON whaleu_notifications.profile_avatar_moderation_notices FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.register_system_notice_id();
ALTER TABLE whaleu_notifications.profile_avatar_moderation_notices ADD CONSTRAINT profile_avatar_notice_exact_id FOREIGN KEY(id,kind,recipient_account_id) REFERENCES whaleu_notifications.system_notice_ids(id,kind,recipient_account_id) DEFERRABLE INITIALLY DEFERRED;
CREATE OR REPLACE FUNCTION whaleu_notifications.system_notice_id_complete() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF (NEW.kind='post_jury_removed' AND NOT EXISTS(SELECT 1 FROM whaleu_notifications.system_notices n WHERE (n.id,n.kind,n.recipient_account_id)=(NEW.id,NEW.kind,NEW.recipient_account_id)))
 OR (NEW.kind='profile_nickname_reset' AND NOT EXISTS(SELECT 1 FROM whaleu_notifications.profile_moderation_notices n WHERE (n.id,n.kind,n.recipient_account_id)=(NEW.id,NEW.kind,NEW.recipient_account_id)))
 OR (NEW.kind='profile_custom_avatar_cleared' AND NOT EXISTS(SELECT 1 FROM whaleu_notifications.profile_avatar_moderation_notices n WHERE (n.id,n.kind,n.recipient_account_id)=(NEW.id,NEW.kind,NEW.recipient_account_id)))
 THEN RAISE EXCEPTION 'System notice registry requires exact source' USING ERRCODE='23514',CONSTRAINT='profile_moderation_causal';END IF;RETURN NULL;
END$$;

CREATE FUNCTION whaleu_profile.avatar_moderation_assert_complete(q whaleu_profile.avatar_moderation_commands) RETURNS void LANGUAGE plpgsql AS $$
DECLARE p record;t whaleu_profile.avatar_moderation_transitions;v whaleu_profile.avatar_moderation_pointer_transitions;e whaleu_profile.avatar_moderation_events;
 current_fingerprint text;BEGIN
 -- NOWAIT relation fences include queued revocation writers, even when the
 -- original command already holds a SHARE row lock. Existing budgets stay put.
 LOCK TABLE whaleu_identity.accounts,whaleu_identity.sessions,whaleu_identity.access_tokens IN SHARE MODE NOWAIT;
 IF NOT whaleu_profile.moderation_identity_current(q.actor_id,q.session_id,q.token_hash)
 OR q.identity_hash IS DISTINCT FROM whaleu_profile.moderation_hash(whaleu_profile.moderation_identity_facts(q.actor_id,q.session_id,q.token_hash))
 THEN RAISE EXCEPTION 'Original current avatar moderator identity required' USING ERRCODE='23514',CONSTRAINT='profile_avatar_moderation_causal';END IF;
 SELECT * INTO t FROM whaleu_profile.avatar_moderation_transitions WHERE actor_id=q.actor_id AND request_id=q.request_id;
 SELECT * INTO v FROM whaleu_profile.avatar_moderation_pointer_transitions WHERE actor_id=q.actor_id AND request_id=q.request_id;
 SELECT * INTO e FROM whaleu_profile.avatar_moderation_events WHERE actor_id=q.actor_id AND request_id=q.request_id;
 IF q.receipt->>'code'='PROFILE_AVATAR_MODERATION_CANCELLED' THEN
  IF t.request_id IS NOT NULL OR v.request_id IS NOT NULL OR e.id IS NOT NULL OR q.subject_id IS NOT NULL OR q.grant_id IS NOT NULL
  OR EXISTS(SELECT 1 FROM whaleu_profile.avatar_moderation_media_statements s WHERE (s.actor_id,s.request_id)=(q.actor_id,q.request_id))
  OR EXISTS(SELECT 1 FROM whaleu_profile.avatar_moderation_media_epochs epoch_receipt WHERE (epoch_receipt.actor_id,epoch_receipt.request_id)=(q.actor_id,q.request_id))
  THEN RAISE EXCEPTION 'Avatar cancellation cannot produce side effects' USING ERRCODE='23514',CONSTRAINT='profile_avatar_moderation_causal';END IF;RETURN;
 END IF;
 LOCK TABLE whaleu_authorization.role_grants,whaleu_verification.account_heads,whaleu_verification.snapshots,whaleu_verification.assertions,
 whaleu_community.discovery_count_epochs,whaleu_safety.discovery_count_epochs,whaleu_campus.discovery_count_epochs IN SHARE MODE NOWAIT;
 -- Unlike 0128, comparison below is exact target Media facts, not the global
 -- Media epoch changed by this command's separately constrained retirement.
 LOCK TABLE whaleu_media.media_owner_states,whaleu_media.upload_intents,whaleu_media.assets,whaleu_media.bindings,
 whaleu_media.asset_safety_heads,whaleu_media.asset_safety_events,whaleu_media.variants,whaleu_media.object_attempts,
 whaleu_media.derived_object_attempts,whaleu_media.quota_reservations,whaleu_media.upload_ingress,whaleu_media.cleanup_obligations IN SHARE MODE NOWAIT;
 IF NOT whaleu_profile.avatar_moderation_media_inventory_current() OR NOT whaleu_profile.avatar_moderation_media_epoch_complete(q)
 OR NOT whaleu_profile.moderation_grant_allowed(q.actor_id,q.grant_id,q.original_region_id)
 OR NOT whaleu_community.profile_moderation_supported(q.actor_id,q.target_kind,q.target_id)
 OR NOT whaleu_profile.moderation_actor_current(q.actor_id,clock_timestamp())
 OR q.input_hash IS DISTINCT FROM whaleu_profile.moderation_hash(whaleu_profile.avatar_moderation_input_facts(q.actor_id,q.grant_id,q.target_kind,q.target_id))
 THEN RAISE EXCEPTION 'Original current scoped avatar inputs required' USING ERRCODE='23514',CONSTRAINT='profile_avatar_moderation_causal';END IF;
 SELECT * INTO p FROM whaleu_profile.profiles WHERE account_id=q.subject_id;
 SELECT whaleu_profile.moderation_hash(jsonb_build_array(to_jsonb(current),current.xmin::text,current.ctid::text)) INTO current_fingerprint FROM whaleu_profile.profiles current WHERE current.account_id=q.subject_id;
 IF q.receipt->>'outcome'='rejected' THEN
  IF p.account_id IS NULL OR t.request_id IS NOT NULL OR v.request_id IS NOT NULL OR e.id IS NOT NULL
  OR q.before_hash IS DISTINCT FROM whaleu_profile.moderation_hash(to_jsonb(p)) OR q.before_fingerprint IS DISTINCT FROM current_fingerprint
  OR q.avatar_hash IS DISTINCT FROM whaleu_profile.moderation_hash(whaleu_profile.moderation_avatar_facts(q.subject_id))
  OR EXISTS(SELECT 1 FROM whaleu_profile.avatar_moderation_media_statements s WHERE (s.actor_id,s.request_id)=(q.actor_id,q.request_id))
  THEN RAISE EXCEPTION 'Rejected avatar command must remain read-only' USING ERRCODE='23514',CONSTRAINT='profile_avatar_moderation_causal';END IF;RETURN;
 END IF;
 IF p.account_id IS NULL OR e.id IS NULL OR t.request_id IS NULL OR v.request_id IS NULL
 OR e.mutation_transaction<>pg_current_xact_id() OR t.mutation_transaction<>pg_current_xact_id() OR v.mutation_transaction<>pg_current_xact_id()
 OR t.before_hash IS DISTINCT FROM q.before_hash OR t.unchanged_hash IS DISTINCT FROM q.unchanged_hash
 OR t.after_hash IS DISTINCT FROM whaleu_profile.moderation_hash(to_jsonb(p)) OR t.after_fingerprint IS DISTINCT FROM current_fingerprint
 OR v.before_hash IS DISTINCT FROM q.avatar_hash OR v.after_hash IS DISTINCT FROM whaleu_profile.moderation_hash(whaleu_profile.moderation_avatar_facts(q.subject_id))
 OR p.revision IS DISTINCT FROM e.revision OR t.after_revision IS DISTINCT FROM e.revision
 OR NOT whaleu_profile.avatar_moderation_definition_authorized(q.appearance_id)
 OR NOT whaleu_profile.avatar_moderation_retirement_complete(q)
 OR NOT EXISTS(SELECT 1 FROM whaleu_notifications.profile_avatar_moderation_notices n JOIN whaleu_notifications.system_notice_ids i ON (i.id,i.kind,i.recipient_account_id)=(n.id,n.kind,n.recipient_account_id)
  WHERE n.event_id=e.id AND n.recipient_account_id=e.subject_id AND n.created_at=e.recorded_at AND n.read_at IS NULL)
 THEN RAISE EXCEPTION 'Avatar command, dual transition, event, retirement and unread notice must commit together' USING ERRCODE='23514',CONSTRAINT='profile_avatar_moderation_causal';END IF;
END$$;
CREATE FUNCTION whaleu_profile.avatar_moderation_complete() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM whaleu_profile.avatar_moderation_assert_complete(NEW);RETURN NULL;END$$;
CREATE CONSTRAINT TRIGGER avatar_moderation_complete AFTER INSERT ON whaleu_profile.avatar_moderation_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_profile.avatar_moderation_complete();
CREATE FUNCTION whaleu_profile.avatar_moderation_recheck_active() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_profile.avatar_moderation_commands;BEGIN
 FOR q IN SELECT * FROM whaleu_profile.avatar_moderation_commands WHERE mutation_transaction=pg_current_xact_id() LOOP
  PERFORM whaleu_profile.avatar_moderation_assert_complete(q);
 END LOOP;RETURN NULL;
END$$;
DO $$DECLARE relation text;BEGIN
 FOREACH relation IN ARRAY ARRAY['whaleu_community.discovery_count_epochs','whaleu_safety.discovery_count_epochs','whaleu_campus.discovery_count_epochs','whaleu_media.media_owner_states',
 'whaleu_identity.accounts','whaleu_identity.sessions','whaleu_identity.access_tokens','whaleu_authorization.role_grants','whaleu_verification.account_heads','whaleu_verification.snapshots','whaleu_verification.assertions',
 'whaleu_profile.profiles','whaleu_profile.avatar_current','whaleu_profile.avatar_definitions','whaleu_profile.avatar_command_receipts','whaleu_community.profile_avatar_approval_bindings',
 'whaleu_profile.avatar_moderation_transitions','whaleu_profile.avatar_moderation_pointer_transitions','whaleu_profile.avatar_moderation_media_statements','whaleu_profile.avatar_moderation_media_epochs','whaleu_profile.avatar_moderation_events','whaleu_notifications.profile_avatar_moderation_notices','whaleu_notifications.system_notice_ids'] LOOP
  EXECUTE format('CREATE CONSTRAINT TRIGGER avatar_moderation_recheck_active AFTER INSERT OR UPDATE OR DELETE ON %s DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_profile.avatar_moderation_recheck_active()',relation);
 END LOOP;
END$$;
