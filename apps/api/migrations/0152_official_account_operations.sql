CREATE TABLE whaleu_official.capabilities (
 id uuid PRIMARY KEY, account_ref uuid NOT NULL REFERENCES whaleu_official.accounts(id), program_id uuid NOT NULL REFERENCES whaleu_official.programs(id),
 principal_kind text NOT NULL CHECK(principal_kind IN('account','service')), principal_ref uuid NOT NULL,
 action text NOT NULL CHECK(action IN('manage','preview','test','manual_create','publish','daily_draft','city_source')),
 revision text NOT NULL CHECK(revision ~ '^[a-f0-9]{64}$'), region_ids uuid[] NOT NULL CHECK(cardinality(region_ids) BETWEEN 1 AND 8),
 valid_from timestamptz NOT NULL, expires_at timestamptz NOT NULL CHECK(expires_at>valid_from), revoked_at timestamptz,
 CHECK(principal_kind<>'service' OR action IN('daily_draft','city_source'))
);
CREATE TABLE whaleu_official.configs (
 program_id uuid PRIMARY KEY REFERENCES whaleu_official.programs(id), revision text NOT NULL CHECK(revision ~ '^[a-f0-9]{64}$'),
 author text NOT NULL CHECK(char_length(author)<=64), cover_appearance_id uuid, title_appearance_id uuid
);
CREATE TABLE whaleu_official.slots (
 id uuid PRIMARY KEY, account_ref uuid NOT NULL REFERENCES whaleu_official.accounts(id),program_id uuid NOT NULL REFERENCES whaleu_official.programs(id),
 ordinal bigint GENERATED ALWAYS AS IDENTITY, local_date date NOT NULL, zone text NOT NULL CHECK(zone='Etc/UTC'),
 due_at timestamptz NOT NULL CHECK(due_at=date_trunc('day',due_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'), policy_revision text NOT NULL,
 state text NOT NULL CHECK(state IN('pending_selection','source_unavailable','no_eligible_content','expired_unavailable','admitted','draft_confirmed','unknown','suppressed')),
 selection_attempts integer NOT NULL DEFAULT 0 CHECK(selection_attempts BETWEEN 0 AND 3), next_attempt_at timestamptz NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(account_ref,program_id,ordinal),UNIQUE(account_ref,program_id,local_date)
);
CREATE TABLE whaleu_official.commands (
 id uuid PRIMARY KEY, actor_ref uuid, service_principal_ref uuid, service_authority_digest text CHECK(service_authority_digest ~ '^[a-f0-9]{64}$'), request_id uuid, slot_id uuid UNIQUE REFERENCES whaleu_official.slots(id),
 account_ref uuid NOT NULL REFERENCES whaleu_official.accounts(id),program_id uuid NOT NULL REFERENCES whaleu_official.programs(id),
 operation text NOT NULL CHECK(operation IN('config_save','test_draft','daily_draft','manual_draft','manual_publish')),
 intent_hash text NOT NULL CHECK(intent_hash ~ '^[a-f0-9]{64}$'), intent jsonb NOT NULL CHECK(octet_length(intent::text)<=262144),
 manifest_hash text CHECK(manifest_hash ~ '^[a-f0-9]{64}$'), rendered_hash text CHECK(rendered_hash ~ '^[a-f0-9]{64}$'),
 accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(), fresh_until timestamptz NOT NULL, receipt jsonb NOT NULL,
 UNIQUE(actor_ref,request_id), CHECK((operation='daily_draft' AND service_authority_digest IS NOT NULL AND service_principal_ref IS NOT NULL AND actor_ref IS NULL AND request_id IS NULL AND slot_id IS NOT NULL) OR (operation<>'daily_draft' AND service_authority_digest IS NULL AND service_principal_ref IS NULL AND actor_ref IS NOT NULL AND request_id IS NOT NULL AND slot_id IS NULL))
);
CREATE TABLE whaleu_official.command_sources (
 command_id uuid NOT NULL REFERENCES whaleu_official.commands(id),post_id uuid NOT NULL,space_id uuid NOT NULL,
 PRIMARY KEY(command_id,post_id)
);
CREATE INDEX official_command_source_lookup ON whaleu_official.command_sources(post_id,command_id);
CREATE TRIGGER official_command_source_identity BEFORE UPDATE OR DELETE ON whaleu_official.command_sources FOR EACH ROW EXECUTE FUNCTION whaleu_media.immutable_record();
CREATE TRIGGER official_command_source_retain BEFORE TRUNCATE ON whaleu_official.command_sources FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.immutable_record();
CREATE INDEX official_intake ON whaleu_official.commands(account_ref,accepted_at,operation);
CREATE TABLE whaleu_official.command_states (
 command_id uuid PRIMARY KEY REFERENCES whaleu_official.commands(id),state text NOT NULL DEFAULT 'pending',
 cancel_requested boolean NOT NULL DEFAULT false,withdrawal text NOT NULL DEFAULT 'none' CHECK(withdrawal IN('none','local_withdrawn_remote_unverified','retraction_needed')),
 draft_ref uuid UNIQUE, updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE whaleu_official.execution_sessions (
 id uuid PRIMARY KEY,command_id uuid NOT NULL REFERENCES whaleu_official.commands(id),session_ref uuid NOT NULL,
 attached_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE whaleu_official.cancel_fences (
 actor_ref uuid NOT NULL,request_id uuid NOT NULL,intent_hash text NOT NULL CHECK(intent_hash ~ '^[a-f0-9]{64}$'),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(actor_ref,request_id)
);
CREATE TABLE whaleu_official.previews (
 id uuid PRIMARY KEY,actor_ref uuid NOT NULL,program_id uuid NOT NULL REFERENCES whaleu_official.programs(id),
 kind text NOT NULL CHECK(kind IN('daily_hot','test','manual_newest')),manifest_hash text NOT NULL,rendered_hash text NOT NULL,
 config_revision text NOT NULL,selection_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,
 reconstruction jsonb NOT NULL CHECK(octet_length(reconstruction::text)<=16384),
 CHECK(expires_at=selection_at+interval '300 seconds')
);
-- Payload encryption is supplied by explicit synthetic DI; no key is generated or persisted here.
CREATE TABLE whaleu_official.payloads (
 id uuid PRIMARY KEY,preview_id uuid REFERENCES whaleu_official.previews(id),command_id uuid REFERENCES whaleu_official.commands(id),
 ciphertext bytea,nonce bytea,tag bytea,expires_at timestamptz NOT NULL,purged_at timestamptz,
 CHECK((ciphertext IS NOT NULL AND nonce IS NOT NULL AND tag IS NOT NULL AND purged_at IS NULL) OR (ciphertext IS NULL AND nonce IS NULL AND tag IS NULL AND purged_at IS NOT NULL))
);
CREATE INDEX official_payload_expiry ON whaleu_official.payloads(expires_at,id) WHERE purged_at IS NULL;
CREATE TABLE whaleu_official.effects (
 id uuid PRIMARY KEY,command_id uuid NOT NULL REFERENCES whaleu_official.commands(id),account_ref uuid NOT NULL REFERENCES whaleu_official.accounts(id),
 destination_ref uuid NOT NULL,stage text NOT NULL CHECK(stage IN('material','draft_create','publish_submit')),purpose text NOT NULL,
 manifest_hash text NOT NULL,rendered_hash text NOT NULL,asset_appearance_id uuid,asset_revision text,variant_hash text,
 logical_key text NOT NULL UNIQUE CHECK(logical_key ~ '^[a-f0-9]{64}$'),
 CHECK((stage='material' AND asset_appearance_id IS NOT NULL AND asset_revision IS NOT NULL AND variant_hash IS NOT NULL) OR (stage<>'material' AND asset_appearance_id IS NULL AND asset_revision IS NULL AND variant_hash IS NULL))
);
CREATE TABLE whaleu_official.effect_states (
 effect_id uuid PRIMARY KEY REFERENCES whaleu_official.effects(id),state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','preparing','dispatch_unknown','retry_wait','material_confirmed','draft_confirmed','publish_submitted','published_confirmed','publication_rejected','parked_unknown','suppressed_unsent')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3), reconciliations integer NOT NULL DEFAULT 0 CHECK(reconciliations BETWEEN 0 AND 30),
 claims integer NOT NULL DEFAULT 0 CHECK(claims BETWEEN 0 AND 33),execution_blocked boolean NOT NULL DEFAULT false,fence uuid,lease_until timestamptz,next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE whaleu_official.attempts (
 id uuid PRIMARY KEY,effect_id uuid NOT NULL REFERENCES whaleu_official.effects(id),ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 3),
 fence uuid NOT NULL,claimed_at timestamptz NOT NULL,lease_until timestamptz NOT NULL,authority_digest text NOT NULL,
 prepared_hash text NOT NULL,dispatch_boundary_at timestamptz NOT NULL,logical_key text NOT NULL,
 UNIQUE(effect_id,ordinal),CHECK(lease_until>dispatch_boundary_at+interval '1 second')
);
CREATE TABLE whaleu_official.evidence (
 id uuid PRIMARY KEY,effect_id uuid NOT NULL REFERENCES whaleu_official.effects(id),attempt_id uuid NOT NULL REFERENCES whaleu_official.attempts(id),
 logical_key text NOT NULL,account_ref uuid NOT NULL,destination_ref uuid NOT NULL,stage text NOT NULL,
 manifest_hash text NOT NULL,rendered_hash text NOT NULL,asset_appearance_id uuid,asset_revision text,variant_hash text,
 kind text NOT NULL CHECK(kind IN('not_sent','not_accepted','material_accepted','draft_created','publish_submitted','published','publication_rejected','unknown')),
 provider_receipt_ref text,accepted_at timestamptz,observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 verifier_profile text NOT NULL CHECK(verifier_profile='synthetic-official-v1'),proof_hash text NOT NULL,
 UNIQUE(account_ref,provider_receipt_ref,kind)
);
CREATE TABLE whaleu_official.synthetic_acceptances (
 logical_key text PRIMARY KEY REFERENCES whaleu_official.effects(logical_key),attempt_id uuid NOT NULL REFERENCES whaleu_official.attempts(id),
 fence uuid NOT NULL,receipt_ref uuid NOT NULL UNIQUE,kind text NOT NULL,content_hash text NOT NULL,accepted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE whaleu_official.publish_confirmations (
 id uuid PRIMARY KEY,actor_ref uuid NOT NULL,draft_ref uuid NOT NULL,revision text NOT NULL,manifest_hash text NOT NULL,
 expires_at timestamptz NOT NULL,consumed_request_id uuid
);
CREATE FUNCTION whaleu_official.effect_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c whaleu_official.commands; e whaleu_official.effects; a whaleu_official.attempts;
BEGIN
 IF TG_TABLE_NAME='effects' THEN
  SELECT * INTO STRICT c FROM whaleu_official.commands WHERE id=NEW.command_id;
  IF NEW.account_ref<>c.account_ref OR NEW.manifest_hash<>c.manifest_hash OR NEW.rendered_hash<>c.rendered_hash
   OR (NEW.stage='publish_submit')<>(c.operation='manual_publish') OR c.operation='config_save'
   OR NEW.destination_ref IS DISTINCT FROM (SELECT destination_ref FROM whaleu_official.accounts WHERE id=c.account_ref)
   OR (NEW.stage<>'material' AND NEW.purpose<>c.operation)
   OR (NEW.stage='material' AND NEW.purpose NOT IN('inline','cover','title'))
   OR NEW.logical_key IS DISTINCT FROM encode(sha256(convert_to(whaleu_community.content_canonical_json(jsonb_build_array('synthetic-official-v1',NEW.command_id::text,NEW.stage,NEW.purpose,NEW.account_ref::text,NEW.destination_ref::text,NEW.manifest_hash,NEW.asset_appearance_id::text,NEW.asset_revision,NEW.variant_hash)),'UTF8')),'hex')
  THEN RAISE EXCEPTION 'Official effect identity mismatch' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO STRICT e FROM whaleu_official.effects WHERE id=NEW.effect_id;
  SELECT * INTO STRICT a FROM whaleu_official.attempts WHERE id=NEW.attempt_id;
  IF a.effect_id<>e.id OR a.logical_key<>e.logical_key OR NEW.logical_key<>e.logical_key OR NEW.account_ref<>e.account_ref OR NEW.destination_ref<>e.destination_ref
   OR NEW.stage<>e.stage OR NEW.manifest_hash<>e.manifest_hash OR NEW.rendered_hash<>e.rendered_hash
   OR NEW.asset_appearance_id IS DISTINCT FROM e.asset_appearance_id OR NEW.asset_revision IS DISTINCT FROM e.asset_revision OR NEW.variant_hash IS DISTINCT FROM e.variant_hash
   OR (NEW.kind='material_accepted' AND e.stage<>'material') OR (NEW.kind='draft_created' AND e.stage<>'draft_create')
   OR (NEW.kind IN('publish_submitted','published','publication_rejected') AND e.stage<>'publish_submit')
  THEN RAISE EXCEPTION 'Official evidence identity mismatch' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER official_effect_guard BEFORE INSERT ON whaleu_official.effects FOR EACH ROW EXECUTE FUNCTION whaleu_official.effect_guard();
CREATE TRIGGER official_evidence_guard BEFORE INSERT ON whaleu_official.evidence FOR EACH ROW EXECUTE FUNCTION whaleu_official.effect_guard();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['commands','execution_sessions','cancel_fences','effects','attempts','evidence','synthetic_acceptances'] LOOP
 EXECUTE format('CREATE TRIGGER official_immutable BEFORE UPDATE OR DELETE ON whaleu_official.%I FOR EACH ROW EXECUTE FUNCTION whaleu_media.immutable_record()',t);
 EXECUTE format('CREATE TRIGGER official_retain BEFORE TRUNCATE ON whaleu_official.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.immutable_record()',t);
 END LOOP;
END $$;

ALTER TABLE whaleu_official.payloads ADD COLUMN confirmation_id uuid REFERENCES whaleu_official.publish_confirmations(id);

-- Explicit synthetic purpose admission for artwork re-use. It does not grant
-- permission to the underlying post or copy/change its Media retention.
CREATE TABLE whaleu_official.artwork (
 id uuid PRIMARY KEY,program_id uuid NOT NULL REFERENCES whaleu_official.programs(id),
 post_id uuid NOT NULL REFERENCES whaleu_community.posts(id),binding_id uuid NOT NULL REFERENCES whaleu_media.bindings(id),
 purpose text NOT NULL CHECK(purpose IN('cover','title')),revision text NOT NULL CHECK(revision ~ '^[a-f0-9]{64}$'),
 profile text NOT NULL CHECK(profile='synthetic-official-v1'),revoked_at timestamptz
);
CREATE TRIGGER official_artwork_identity BEFORE UPDATE OR DELETE ON whaleu_official.artwork FOR EACH ROW EXECUTE FUNCTION whaleu_media.guard_mutable_record('revoked_at');

CREATE TRIGGER official_slot_identity BEFORE UPDATE OR DELETE ON whaleu_official.slots FOR EACH ROW EXECUTE FUNCTION whaleu_media.guard_mutable_record('state,selection_attempts,next_attempt_at');
CREATE TRIGGER official_slot_retain BEFORE TRUNCATE ON whaleu_official.slots FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.immutable_record();
CREATE TRIGGER official_preview_identity BEFORE UPDATE OR DELETE ON whaleu_official.previews FOR EACH ROW EXECUTE FUNCTION whaleu_media.immutable_record();
CREATE TABLE whaleu_official.fixture_epoch(singleton boolean PRIMARY KEY CHECK(singleton),epoch uuid NOT NULL UNIQUE);
CREATE TRIGGER official_fixture_epoch_identity BEFORE UPDATE OR DELETE ON whaleu_official.fixture_epoch FOR EACH ROW EXECUTE FUNCTION whaleu_media.immutable_record();
CREATE TRIGGER official_fixture_epoch_retain BEFORE TRUNCATE ON whaleu_official.fixture_epoch FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.immutable_record();

CREATE UNIQUE INDEX official_single_nonmaterial_stage ON whaleu_official.effects(command_id,stage) WHERE stage<>'material';
CREATE FUNCTION whaleu_official.attempt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e whaleu_official.effects;s whaleu_official.effect_states;c whaleu_official.command_states;
BEGIN
 SELECT * INTO STRICT e FROM whaleu_official.effects WHERE id=NEW.effect_id;
 SELECT * INTO STRICT s FROM whaleu_official.effect_states WHERE effect_id=e.id FOR UPDATE;
 SELECT * INTO STRICT c FROM whaleu_official.command_states WHERE command_id=e.command_id FOR UPDATE;
 IF s.state<>'preparing' OR s.execution_blocked OR s.fence IS DISTINCT FROM NEW.fence
  OR NEW.ordinal<>s.attempts+1 OR NEW.logical_key<>e.logical_key
  OR NEW.lease_until IS DISTINCT FROM date_trunc('milliseconds',s.lease_until)
  OR s.lease_until<=clock_timestamp()+interval '1 second' OR c.cancel_requested OR c.withdrawal<>'none'
  OR NEW.authority_digest !~ '^[a-f0-9]{64}$' OR NEW.prepared_hash IS DISTINCT FROM (CASE WHEN e.stage='material' THEN e.variant_hash ELSE e.rendered_hash END)
  OR (e.stage='draft_create' AND EXISTS(SELECT 1 FROM whaleu_official.effects x JOIN whaleu_official.effect_states y ON y.effect_id=x.id WHERE x.command_id=e.command_id AND x.stage='material' AND y.state<>'material_confirmed'))
 THEN RAISE EXCEPTION 'Official attempt is not admitted' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER official_attempt_guard BEFORE INSERT ON whaleu_official.attempts FOR EACH ROW EXECUTE FUNCTION whaleu_official.attempt_guard();
CREATE FUNCTION whaleu_official.effect_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.effect_id<>OLD.effect_id OR NEW.claims<OLD.claims OR NEW.claims>OLD.claims+1
  OR NEW.attempts<OLD.attempts OR NEW.attempts>OLD.attempts+1
  OR NEW.reconciliations<OLD.reconciliations OR NEW.reconciliations>OLD.reconciliations+1
  OR (NEW.fence IS NOT DISTINCT FROM OLD.fence AND OLD.lease_until IS NOT NULL AND NEW.lease_until>OLD.lease_until)
  OR (NEW.fence IS DISTINCT FROM OLD.fence AND (NEW.claims<>OLD.claims+1 OR OLD.lease_until>clock_timestamp()))
  OR (NEW.attempts>OLD.attempts AND NOT EXISTS(SELECT 1 FROM whaleu_official.attempts a WHERE a.effect_id=NEW.effect_id AND a.ordinal=NEW.attempts AND a.fence=NEW.fence))
  OR (NEW.state<>OLD.state AND NOT (
    (OLD.state IN('pending','retry_wait') AND NEW.state IN('preparing','suppressed_unsent')) OR
    (OLD.state='preparing' AND NEW.state IN('pending','dispatch_unknown','suppressed_unsent')) OR
    (OLD.state IN('dispatch_unknown','parked_unknown') AND NEW.state IN('dispatch_unknown','parked_unknown','retry_wait','material_confirmed','draft_confirmed','publish_submitted','published_confirmed','publication_rejected','suppressed_unsent')) OR
    (OLD.state='publish_submitted' AND NEW.state IN('published_confirmed','publication_rejected'))
  ))
 THEN RAISE EXCEPTION 'Official effect transition rejected' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER official_effect_transition BEFORE UPDATE ON whaleu_official.effect_states FOR EACH ROW EXECUTE FUNCTION whaleu_official.effect_transition_guard();
CREATE TRIGGER official_effect_state_retain BEFORE DELETE ON whaleu_official.effect_states FOR EACH ROW EXECUTE FUNCTION whaleu_media.immutable_record();
CREATE TRIGGER official_effect_state_no_reset BEFORE TRUNCATE ON whaleu_official.effect_states FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.immutable_record();
CREATE TABLE whaleu_official.command_assets (
 command_id uuid NOT NULL REFERENCES whaleu_official.commands(id),appearance_id uuid NOT NULL,
 purpose text NOT NULL CHECK(purpose IN('inline','cover','title')),binding_id uuid NOT NULL,post_id uuid NOT NULL,
 PRIMARY KEY(command_id,appearance_id,purpose)
);
CREATE TRIGGER official_command_asset_identity BEFORE UPDATE OR DELETE ON whaleu_official.command_assets FOR EACH ROW EXECUTE FUNCTION whaleu_media.immutable_record();
CREATE TRIGGER official_command_asset_retain BEFORE TRUNCATE ON whaleu_official.command_assets FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.immutable_record();
