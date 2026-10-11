-- Errand publication v2. Old v1 digest/receipt namespaces and immutable original
-- publication bindings remain valid. No Review issuer, provider or policy is seeded.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
ALTER TABLE whaleu_errands.orders ADD COLUMN publication_version integer NOT NULL DEFAULT 1 CHECK(publication_version IN(1,2));
CREATE FUNCTION whaleu_errands.valid_image_set(value jsonb,audience text,bound boolean) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE item jsonb; prior text:='';seen uuid[]:='{}'; slots text[]:='{}'; BEGIN
 IF value IS NULL OR jsonb_typeof(value)<>'array' OR jsonb_array_length(value)>3 OR audience IS NULL OR bound IS NULL OR audience NOT IN('public','private') THEN RETURN false;END IF;
 FOR item IN SELECT * FROM jsonb_array_elements(value) LOOP
  IF NOT whaleu_community.rating_scoped_keys(item,CASE WHEN bound THEN ARRAY['slot','assetId','manifestDigest','bindingId'] ELSE ARRAY['slot','assetId','manifestDigest'] END)
   OR coalesce(jsonb_typeof(item->'slot'),'null')<>'string' OR coalesce(item->>'slot','') NOT IN(audience||'0',audience||'1',audience||'2') OR item->>'slot'<=prior
   OR coalesce(item->>'assetId','') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
   OR coalesce(item->>'manifestDigest','') !~ '^[a-f0-9]{64}$'
   OR(bound AND coalesce(item->>'bindingId','') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
   OR (item->>'assetId')::uuid=ANY(seen) THEN RETURN false;END IF;
  seen:=array_append(seen,(item->>'assetId')::uuid);prior:=item->>'slot';
 END LOOP;RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;END$$;
CREATE FUNCTION whaleu_errands.image_review_facts(value jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT coalesce(jsonb_agg(item-'bindingId' ORDER BY item->>'slot'),'[]'::jsonb) FROM jsonb_array_elements(value) item
$$;
CREATE TABLE whaleu_errands.media_drafts(
 id uuid PRIMARY KEY,actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 target_region_id uuid NOT NULL REFERENCES whaleu_campus.operating_regions(id),revision bigint NOT NULL DEFAULT 1 CHECK(revision=1),
 state text NOT NULL DEFAULT 'open' CHECK(state IN('open','published','cancelled')),
 scope jsonb NOT NULL,authority_version whaleu_media.digest NOT NULL,
 publication_request_id uuid,publication_request_hash whaleu_media.digest,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '30 minutes',
 CHECK((publication_request_id IS NULL)=(publication_request_hash IS NULL)),
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '31 minutes'),
 CHECK(coalesce(jsonb_typeof(scope)='object' AND scope->>'targetRegionId'=target_region_id::text,false))
);
-- Original actor/draft cancellation is durable even if the create response was
-- lost before a draft row existed. No target or publication eligibility is needed.
CREATE TABLE whaleu_errands.media_draft_cancellations(
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),draft_id uuid NOT NULL,
 draft_revision bigint NOT NULL DEFAULT 1 CHECK(draft_revision=1),
 publication_request_id uuid,publication_request_hash whaleu_media.digest,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(actor_id,draft_id),
 CHECK((publication_request_id IS NULL)=(publication_request_hash IS NULL)),
 FOREIGN KEY(actor_id,publication_request_id) REFERENCES whaleu_errands.requests(account_id,request_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE FUNCTION whaleu_errands.lock_media_draft(actor uuid,draft uuid) RETURNS void LANGUAGE plpgsql VOLATILE AS $$BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Errand draft identity requires current committed facts' USING ERRCODE='23514',CONSTRAINT='errand_media_draft_identity';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:errand-draft:v2'||chr(10)||actor::text||chr(10)||draft::text,0));
END$$;
CREATE FUNCTION whaleu_errands.media_draft_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor uuid;draft uuid;BEGIN
 actor:=NEW.actor_id;
 IF TG_TABLE_NAME='media_drafts' THEN draft:=NEW.id;ELSE draft:=NEW.draft_id;END IF;
 PERFORM whaleu_errands.lock_media_draft(actor,draft);
 IF(TG_TABLE_NAME='media_drafts' AND EXISTS(SELECT 1 FROM whaleu_errands.media_draft_cancellations c WHERE(c.actor_id,c.draft_id)=(actor,draft)))
 OR(TG_TABLE_NAME='media_draft_cancellations' AND EXISTS(SELECT 1 FROM whaleu_errands.media_drafts d WHERE d.id=draft))
 THEN RAISE EXCEPTION 'Errand draft identity is already created or cancelled' USING ERRCODE='23514',CONSTRAINT='errand_media_draft_identity';END IF;
 RETURN NEW;END$$;
CREATE TRIGGER errand_media_draft_identity BEFORE INSERT ON whaleu_errands.media_drafts FOR EACH ROW EXECUTE FUNCTION whaleu_errands.media_draft_identity_guard();
CREATE TRIGGER errand_media_draft_cancellation_identity BEFORE INSERT ON whaleu_errands.media_draft_cancellations FOR EACH ROW EXECUTE FUNCTION whaleu_errands.media_draft_identity_guard();
CREATE FUNCTION whaleu_errands.media_draft_cancellation_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF EXISTS(SELECT 1 FROM whaleu_errands.media_drafts d WHERE d.id=NEW.draft_id)
 OR(NEW.publication_request_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM whaleu_errands.requests r WHERE(r.account_id,r.request_id,r.intent_hash)=(NEW.actor_id,NEW.publication_request_id,NEW.publication_request_hash)
   AND r.operation='publish' AND r.receipt->>'outcome'='rejected'))
 THEN RAISE EXCEPTION 'Errand cancellation requires absent draft and exact terminal publication fence' USING ERRCODE='23514',CONSTRAINT='errand_media_draft_cancellation_final';END IF;
 RETURN NULL;END$$;
CREATE CONSTRAINT TRIGGER errand_media_draft_cancellation_final AFTER INSERT ON whaleu_errands.media_draft_cancellations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_errands.media_draft_cancellation_guard();
CREATE TABLE whaleu_errands.media_publication_intents(
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,
 draft_id uuid NOT NULL REFERENCES whaleu_errands.media_drafts(id),draft_revision bigint NOT NULL,
 request_hash whaleu_media.digest NOT NULL,command jsonb NOT NULL,review_digest whaleu_media.digest NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(actor_id,request_id),UNIQUE(draft_id),
 CONSTRAINT errand_publication_command_identity CHECK(coalesce(command->>'protocol'='errand-publication-v2' AND command->>'clientRequestId'=request_id::text AND command->>'draftId'=draft_id::text AND jsonb_typeof(command->'draftRevision')='number' AND command->'draftRevision'=to_jsonb(draft_revision),false)),
 CHECK(request_hash=encode(sha256(convert_to('whaleu:errand-command:v2'||chr(10)||whaleu_community.content_canonical_json(jsonb_build_object('operation','publish','intent',command-'clientRequestId')),'UTF8')),'hex'))
);
CREATE TABLE whaleu_errands.media_publications(
 order_id uuid PRIMARY KEY REFERENCES whaleu_errands.orders(id) DEFERRABLE INITIALLY DEFERRED,
 draft_id uuid NOT NULL UNIQUE REFERENCES whaleu_errands.media_drafts(id),draft_revision bigint NOT NULL,
 actor_id uuid NOT NULL,request_id uuid NOT NULL,command_hash whaleu_media.digest NOT NULL,
 publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 FOREIGN KEY(actor_id,request_id) REFERENCES whaleu_errands.media_publication_intents(actor_id,request_id)
);
CREATE TABLE whaleu_errands.media_sets(
 order_id uuid NOT NULL REFERENCES whaleu_errands.media_publications(order_id),revision bigint NOT NULL CHECK(revision>0),
 prior_revision bigint,cause text NOT NULL CHECK(cause IN('publication','audit_subtraction')),
 public_media jsonb NOT NULL,private_media jsonb NOT NULL,
 transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(order_id,revision),
 CHECK((revision=1 AND prior_revision IS NULL AND cause='publication') OR(revision>1 AND prior_revision=revision-1 AND cause='audit_subtraction')),
 CHECK(whaleu_errands.valid_image_set(public_media,'public',true) AND whaleu_errands.valid_image_set(private_media,'private',true))
);
CREATE TABLE whaleu_errands.media_heads(
 order_id uuid PRIMARY KEY REFERENCES whaleu_errands.media_publications(order_id),revision bigint NOT NULL,
 FOREIGN KEY(order_id,revision) REFERENCES whaleu_errands.media_sets(order_id,revision)
);
CREATE TABLE whaleu_errands.media_audits(
 id uuid PRIMARY KEY,order_id uuid NOT NULL REFERENCES whaleu_errands.media_publications(order_id),
 expected_revision bigint NOT NULL,next_revision bigint NOT NULL,
 removed jsonb NOT NULL CHECK(jsonb_typeof(removed)='array' AND jsonb_array_length(removed) BETWEEN 1 AND 6),
 issuer text NOT NULL CHECK(length(btrim(issuer))>0),provenance_ref text NOT NULL CHECK(length(btrim(provenance_ref))>0),
 transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
 UNIQUE(order_id,next_revision),CHECK(next_revision=expected_revision+1)
);
-- Preserve every original v1 CHECK as the v1 branch; extend only the exact new
-- discriminant. Unknown versions and mixed old/new fields remain closed.
DO $$DECLARE c record;BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='whaleu_community.errand_approval_decisions'::regclass AND contype='c'
 AND (pg_get_constraintdef(oid) LIKE '%envelope_version%' OR pg_get_constraintdef(oid) LIKE '%envelope ->%' OR pg_get_constraintdef(oid) LIKE '%content_canonical_json%')
 LOOP EXECUTE format('ALTER TABLE whaleu_community.errand_approval_decisions DROP CONSTRAINT %I',c.conname);END LOOP;
END$$;
ALTER TABLE whaleu_community.errand_approval_decisions ADD CONSTRAINT errand_review_version CHECK(envelope_version IN(1,2));
ALTER TABLE whaleu_community.errand_approval_decisions ADD CONSTRAINT errand_review_exact_definition CHECK(coalesce(
 jsonb_typeof(envelope)='object' AND envelope->>'version'=envelope_version::text AND envelope->>'accountId'=account_id::text AND envelope->>'purpose'=operation AND jsonb_typeof(envelope->'scope')='object' AND (
 (envelope_version=1 AND envelope->'publicAssetIds'='[]'::jsonb AND envelope->'privateAssetIds'='[]'::jsonb) OR
 (envelope_version=2 AND whaleu_community.rating_scoped_keys(envelope,ARRAY['version','accountId','purpose','title','publicText','privateText','expectedTimeText','reward','publisherContacts','scope','draftId','draftRevision','mediaRevision','publicMedia','privateMedia'])
  AND whaleu_errands.valid_image_set(envelope->'publicMedia','public',false) AND whaleu_errands.valid_image_set(envelope->'privateMedia','private',false)
  AND (envelope->>'draftRevision')::bigint>0 AND (envelope->>'mediaRevision')::bigint>0 AND (envelope->>'draftId')::uuid IS NOT NULL)),false));
ALTER TABLE whaleu_community.errand_approval_decisions ADD CONSTRAINT errand_review_exact_digest CHECK(digest=encode(sha256(convert_to('whaleu-errand-content-approval:v'||envelope_version::text||chr(10)||whaleu_community.content_canonical_json(envelope),'UTF8')),'hex'));
ALTER TABLE whaleu_community.errand_approval_bindings DROP CONSTRAINT errand_approval_bindings_envelope_version_check;
ALTER TABLE whaleu_community.errand_approval_bindings ADD CONSTRAINT errand_approval_bindings_envelope_version_check CHECK(envelope_version IN(1,2));
CREATE TABLE whaleu_community.errand_media_approval_bindings(
 order_id uuid NOT NULL REFERENCES whaleu_errands.orders(id),media_revision bigint NOT NULL CHECK(media_revision>1),
 decision_id uuid NOT NULL UNIQUE,account_id uuid NOT NULL,operation text NOT NULL CHECK(operation='publish_errand'),envelope_version integer NOT NULL CHECK(envelope_version=2),
 digest text NOT NULL,envelope jsonb NOT NULL,scope jsonb NOT NULL,publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 PRIMARY KEY(order_id,media_revision),
 FOREIGN KEY(decision_id,account_id,operation,envelope_version,digest) REFERENCES whaleu_community.errand_approval_decisions(id,account_id,operation,envelope_version,digest),
 FOREIGN KEY(order_id,media_revision) REFERENCES whaleu_errands.media_sets(order_id,revision),CHECK(scope=envelope->'scope' AND (envelope->>'mediaRevision')::bigint=media_revision)
);
CREATE TRIGGER errand_media_review_binding_immutable BEFORE UPDATE OR DELETE ON whaleu_community.errand_media_approval_bindings FOR EACH ROW EXECUTE FUNCTION whaleu_community.content_approval_immutable();
CREATE TRIGGER errand_media_review_binding_validate BEFORE INSERT ON whaleu_community.errand_media_approval_bindings FOR EACH ROW EXECUTE FUNCTION whaleu_community.errand_review_binding_validate();
CREATE TRIGGER errand_media_review_binding_gate BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.errand_media_approval_bindings FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_policy_writer_gate();
CREATE TRIGGER errand_media_review_binding_retain BEFORE TRUNCATE ON whaleu_community.errand_media_approval_bindings FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_approval_immutable();
CREATE FUNCTION whaleu_errands.media_definition(oid uuid,rev bigint) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('version',2,'accountId',o.publisher_id::text,'purpose','publish_errand','title',o.title,'publicText',o.public_text,'privateText',p.private_text,'expectedTimeText',o.expected_time_text,'reward',o.reward::text,'publisherContacts',p.publisher_contacts,'scope',o.scope,
 'draftId',m.draft_id::text,'draftRevision',m.draft_revision,'mediaRevision',s.revision,'publicMedia',whaleu_errands.image_review_facts(s.public_media),'privateMedia',whaleu_errands.image_review_facts(s.private_media))
 FROM whaleu_errands.orders o JOIN whaleu_errands.private_details p ON p.order_id=o.id
 JOIN whaleu_errands.media_publications m ON m.order_id=o.id JOIN whaleu_errands.media_sets s ON s.order_id=o.id AND s.revision=rev WHERE o.id=oid
$$;
CREATE FUNCTION whaleu_errands.media_draft_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF TG_OP='DELETE' OR ROW(NEW.id,NEW.actor_id,NEW.target_region_id,NEW.revision,NEW.scope,NEW.authority_version,NEW.created_at,NEW.expires_at) IS DISTINCT FROM ROW(OLD.id,OLD.actor_id,OLD.target_region_id,OLD.revision,OLD.scope,OLD.authority_version,OLD.created_at,OLD.expires_at)
  OR OLD.state<>'open' OR (OLD.publication_request_id IS NOT NULL AND ROW(NEW.publication_request_id,NEW.publication_request_hash) IS DISTINCT FROM ROW(OLD.publication_request_id,OLD.publication_request_hash))
 THEN RAISE EXCEPTION 'Errand draft identity and terminal state are immutable' USING ERRCODE='23514';END IF;RETURN NEW;END$$;
CREATE TRIGGER errand_media_draft_guard BEFORE UPDATE OR DELETE ON whaleu_errands.media_drafts FOR EACH ROW EXECUTE FUNCTION whaleu_errands.media_draft_guard();
CREATE FUNCTION whaleu_errands.media_head_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF TG_OP='DELETE' OR(TG_OP='INSERT' AND NEW.revision<>1) OR(TG_OP='UPDATE' AND(NEW.order_id<>OLD.order_id OR NEW.revision<>OLD.revision+1)) THEN RAISE EXCEPTION 'Errand media head must advance one exact revision' USING ERRCODE='23514';END IF;RETURN NEW;END$$;
CREATE TRIGGER errand_media_head_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_errands.media_heads FOR EACH ROW EXECUTE FUNCTION whaleu_errands.media_head_guard();
CREATE FUNCTION whaleu_errands.media_publication_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d whaleu_errands.media_drafts;i whaleu_errands.media_publication_intents;o whaleu_errands.orders;r whaleu_errands.requests;s whaleu_errands.media_sets;BEGIN
 SELECT * INTO d FROM whaleu_errands.media_drafts WHERE id=NEW.draft_id;
 SELECT * INTO i FROM whaleu_errands.media_publication_intents WHERE(actor_id,request_id)=(NEW.actor_id,NEW.request_id);
 SELECT * INTO o FROM whaleu_errands.orders WHERE id=NEW.order_id;
 SELECT * INTO r FROM whaleu_errands.requests WHERE(account_id,request_id)=(NEW.actor_id,NEW.request_id);
 SELECT * INTO s FROM whaleu_errands.media_sets WHERE order_id=NEW.order_id AND revision=1;
 IF NEW.publication_transaction<>pg_current_xact_id() OR d.id IS NULL OR i.request_id IS NULL OR o.id IS NULL OR s.order_id IS NULL OR r.receipt->>'outcome' IS DISTINCT FROM 'applied'
 OR d.state<>'published' OR(d.actor_id,d.revision,d.publication_request_id,d.publication_request_hash) IS DISTINCT FROM(NEW.actor_id,NEW.draft_revision,NEW.request_id,NEW.command_hash)
 OR(i.draft_id,i.draft_revision,i.request_hash) IS DISTINCT FROM(NEW.draft_id,NEW.draft_revision,NEW.command_hash)
 OR o.publication_version<>2 OR o.publisher_id<>NEW.actor_id OR o.scope<>d.scope OR o.target_region_id<>d.target_region_id OR o.publication_transaction<>NEW.publication_transaction
 OR r.intent_hash<>NEW.command_hash OR r.receipt->>'orderId'<>o.id::text
 OR whaleu_errands.image_review_facts(s.public_media) IS DISTINCT FROM i.command->'publicMedia' OR whaleu_errands.image_review_facts(s.private_media) IS DISTINCT FROM i.command->'privateMedia'
 OR whaleu_errands.media_definition(o.id,1)-ARRAY['version','accountId','purpose','scope','mediaRevision'] IS DISTINCT FROM i.command-ARRAY['protocol','clientRequestId','targetRegionId']
 THEN RAISE EXCEPTION 'Errand media publication requires exact original command, scope, receipt and complete set' USING ERRCODE='23514';END IF;RETURN NULL;END$$;
CREATE CONSTRAINT TRIGGER errand_media_publication_final AFTER INSERT ON whaleu_errands.media_publications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_errands.media_publication_guard();
CREATE FUNCTION whaleu_errands.media_set_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item jsonb; old whaleu_errands.media_sets;audit whaleu_errands.media_audits;binding jsonb;BEGIN
 IF NEW.transaction_id<>pg_current_xact_id() OR NOT EXISTS(SELECT 1 FROM whaleu_errands.media_heads h WHERE(h.order_id,h.revision)=(NEW.order_id,NEW.revision))
 OR EXISTS(SELECT 1 FROM whaleu_media.errand_appearances p JOIN whaleu_media.bindings b ON b.id=p.binding_id WHERE p.order_id=NEW.order_id AND b.detached_at IS NULL AND NOT((NEW.public_media||NEW.private_media) @> jsonb_build_array(jsonb_build_object('slot',p.slot,'assetId',p.asset_id::text,'manifestDigest',p.manifest_digest,'bindingId',p.binding_id::text))))
 OR(SELECT count(*) FROM jsonb_array_elements(NEW.public_media||NEW.private_media))<>(SELECT count(DISTINCT x->>'assetId') FROM jsonb_array_elements(NEW.public_media||NEW.private_media)x)
 THEN RAISE EXCEPTION 'Errand media requires exact new current set' USING ERRCODE='23514';END IF;
 FOR item IN SELECT * FROM jsonb_array_elements(NEW.public_media||NEW.private_media) LOOP
  IF NOT EXISTS(SELECT 1 FROM whaleu_media.errand_appearances p JOIN whaleu_media.bindings b ON b.id=p.binding_id
   WHERE p.order_id=NEW.order_id AND(p.slot,p.asset_id::text,p.manifest_digest,p.binding_id::text)=(item->>'slot',item->>'assetId',item->>'manifestDigest',item->>'bindingId') AND b.detached_at IS NULL)
  THEN RAISE EXCEPTION 'Errand media set requires exact active appearances' USING ERRCODE='23514';END IF;
 END LOOP;
 IF NEW.revision>1 THEN
  SELECT * INTO old FROM whaleu_errands.media_sets WHERE(order_id,revision)=(NEW.order_id,NEW.prior_revision);
  SELECT * INTO audit FROM whaleu_errands.media_audits WHERE(order_id,next_revision)=(NEW.order_id,NEW.revision);
  IF old.order_id IS NULL OR audit.id IS NULL OR audit.transaction_id<>pg_current_xact_id() OR audit.expected_revision<>old.revision
    OR jsonb_array_length(NEW.public_media||NEW.private_media)>=jsonb_array_length(old.public_media||old.private_media)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.public_media||NEW.private_media)x WHERE NOT((old.public_media||old.private_media) @> jsonb_build_array(x)))
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(old.public_media||old.private_media)x WHERE NOT((NEW.public_media||NEW.private_media) @> jsonb_build_array(x)) AND NOT(audit.removed @> jsonb_build_array(x)))
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(audit.removed)x WHERE NOT((old.public_media||old.private_media) @> jsonb_build_array(x)) OR (NEW.public_media||NEW.private_media) @> jsonb_build_array(x))
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(audit.removed)x WHERE NOT EXISTS(SELECT 1 FROM whaleu_media.errand_retirements r WHERE r.binding_id=(x->>'bindingId')::uuid AND r.order_id=NEW.order_id AND r.cause='audit_subtraction' AND r.transaction_id=pg_current_xact_id()))
  THEN RAISE EXCEPTION 'Audit can only subtract the exact captured image set' USING ERRCODE='23514';END IF;
  -- Missing replacement review is deliberate fail-closed state. If supplied it
  -- must approve this exact remaining definition, never an earlier image set.
  SELECT envelope INTO binding FROM whaleu_community.errand_media_approval_bindings WHERE(order_id,media_revision)=(NEW.order_id,NEW.revision);
  IF binding IS NOT NULL AND binding IS DISTINCT FROM whaleu_errands.media_definition(NEW.order_id,NEW.revision) THEN RAISE EXCEPTION 'Changed image set requires new exact Review';END IF;
 END IF;RETURN NULL;END$$;
CREATE CONSTRAINT TRIGGER errand_media_set_final AFTER INSERT ON whaleu_errands.media_sets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_errands.media_set_guard();
-- An immutable audit cannot reserve a future revision without committing its
-- exact subtraction. The reverse set guard validates removed facts/retirements.
CREATE FUNCTION whaleu_errands.media_audit_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.transaction_id<>pg_current_xact_id() OR NOT EXISTS(
  SELECT 1 FROM whaleu_errands.media_sets s JOIN whaleu_errands.media_heads h ON(h.order_id,h.revision)=(s.order_id,s.revision)
  WHERE(s.order_id,s.revision,s.prior_revision)=(NEW.order_id,NEW.next_revision,NEW.expected_revision)
   AND s.cause='audit_subtraction' AND s.transaction_id=NEW.transaction_id)
 THEN RAISE EXCEPTION 'Errand audit requires its exact current same-transaction subtraction' USING ERRCODE='23514',CONSTRAINT='errand_media_audit_final';END IF;
 RETURN NULL;END$$;
CREATE CONSTRAINT TRIGGER errand_media_audit_final AFTER INSERT ON whaleu_errands.media_audits DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_errands.media_audit_guard();
CREATE FUNCTION whaleu_errands.media_close_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF TG_OP='UPDATE' AND NEW.publication_version<>OLD.publication_version THEN RAISE EXCEPTION 'Errand publication protocol is immutable';END IF;
 IF NEW.publication_version=2 AND NOT EXISTS(SELECT 1 FROM whaleu_errands.media_publications WHERE order_id=NEW.id) THEN RAISE EXCEPTION 'Missing Errand media publication';END IF;
 IF NEW.deleted_at IS NOT NULL AND EXISTS(SELECT 1 FROM whaleu_media.errand_appearances p JOIN whaleu_media.bindings b ON b.id=p.binding_id WHERE p.order_id=NEW.id AND b.detached_at IS NULL) THEN RAISE EXCEPTION 'Deleted Errand requires retirement of every historical appearance';END IF;
 RETURN NULL;END$$;
CREATE CONSTRAINT TRIGGER errand_media_close_final AFTER INSERT OR UPDATE ON whaleu_errands.orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_errands.media_close_guard();
DO $$DECLARE table_name text;BEGIN
 FOREACH table_name IN ARRAY ARRAY['media_draft_cancellations','media_publication_intents','media_publications','media_sets','media_audits'] LOOP
 EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON whaleu_errands.%I FOR EACH ROW EXECUTE FUNCTION whaleu_community.content_approval_immutable()',table_name||'_immutable',table_name);
 END LOOP;
 FOREACH table_name IN ARRAY ARRAY['media_drafts','media_draft_cancellations','media_publication_intents','media_publications','media_sets','media_heads','media_audits'] LOOP
 EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON whaleu_errands.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_policy_writer_gate()',table_name||'_writer_gate',table_name);
 END LOOP;
END$$;

-- Preserve the current administrative deletion-aware transition guard.
CREATE OR REPLACE FUNCTION whaleu_errands.require_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event whaleu_errands.transitions; expected_operation text; expected_actor uuid; definition jsonb; binding jsonb;
BEGIN
 expected_operation:=CASE WHEN TG_OP='INSERT' THEN 'publish' WHEN NEW.admin_delete_event_id IS NOT NULL THEN 'admin_delete' WHEN NEW.deleted_at IS NOT NULL THEN 'delete' WHEN NEW.state='accepted' THEN 'accept' WHEN NEW.state='completed' THEN 'complete' ELSE 'cancel' END;
 expected_actor:=CASE WHEN expected_operation='accept' THEN NEW.accepter_id WHEN expected_operation='admin_delete' THEN NEW.deleted_by ELSE NEW.publisher_id END;
 SELECT * INTO event FROM whaleu_errands.transitions WHERE order_id=NEW.id AND revision=NEW.revision;
 IF NOT FOUND OR event.operation<>expected_operation OR event.actor_id<>expected_actor OR event.next_state<>NEW.state OR (TG_OP='INSERT' AND (event.prior_state IS NOT NULL OR NEW.state<>'pending')) OR (TG_OP='UPDATE' AND event.prior_state IS DISTINCT FROM OLD.state) THEN RAISE EXCEPTION 'Errand transition evidence required'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.publication_version=2 THEN
   definition:=whaleu_errands.media_definition(NEW.id,1);
  ELSE
  SELECT jsonb_build_object('version',1,'accountId',NEW.publisher_id::text,'purpose','publish_errand','title',NEW.title,'publicText',NEW.public_text,'privateText',p.private_text,'expectedTimeText',NEW.expected_time_text,'reward',NEW.reward::text,'publisherContacts',p.publisher_contacts,'publicAssetIds','[]'::jsonb,'privateAssetIds','[]'::jsonb,'scope',NEW.scope) INTO definition FROM whaleu_errands.private_details p WHERE p.order_id=NEW.id;
  END IF;
  SELECT envelope INTO binding FROM whaleu_community.errand_approval_bindings WHERE order_id=NEW.id;
  IF definition IS NULL OR binding IS DISTINCT FROM definition OR NEW.publication_transaction<>pg_current_xact_id() THEN RAISE EXCEPTION 'Exact errand publication binding required'; END IF;
 END IF;
 RETURN NULL;
END $$;
ALTER TABLE whaleu_media.errand_scopes ADD FOREIGN KEY(draft_id) REFERENCES whaleu_errands.media_drafts(id);
ALTER TABLE whaleu_media.errand_appearances ADD FOREIGN KEY(draft_id) REFERENCES whaleu_errands.media_drafts(id);
CREATE FUNCTION whaleu_errands.media_draft_final_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d whaleu_errands.media_drafts;r whaleu_errands.requests;BEGIN
 SELECT * INTO d FROM whaleu_errands.media_drafts WHERE id=NEW.id;
 IF d.publication_request_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM whaleu_errands.media_publication_intents i WHERE(i.actor_id,i.request_id,i.draft_id,i.draft_revision,i.request_hash)=(d.actor_id,d.publication_request_id,d.id,d.revision,d.publication_request_hash)) THEN RAISE EXCEPTION 'Reserved Errand draft requires exact immutable command';END IF;
 IF d.state='cancelled' AND d.publication_request_id IS NOT NULL THEN
  SELECT * INTO r FROM whaleu_errands.requests WHERE(account_id,request_id)=(d.actor_id,d.publication_request_id);
  IF r.request_id IS NULL OR r.intent_hash<>d.publication_request_hash OR r.operation<>'publish' OR r.receipt->>'outcome' IS DISTINCT FROM 'rejected' THEN RAISE EXCEPTION 'Draft cancellation requires original publication fence';END IF;
 END IF;
 IF d.state='published' AND NOT EXISTS(SELECT 1 FROM whaleu_errands.media_publications p WHERE(p.draft_id,p.actor_id,p.request_id,p.command_hash)=(d.id,d.actor_id,d.publication_request_id,d.publication_request_hash)) THEN RAISE EXCEPTION 'Published draft requires atomic original publication';END IF;
 RETURN NULL;END$$;
CREATE CONSTRAINT TRIGGER errand_media_draft_final AFTER INSERT OR UPDATE ON whaleu_errands.media_drafts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_errands.media_draft_final_guard();
CREATE FUNCTION whaleu_errands.media_intent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d whaleu_errands.media_drafts;definition jsonb;BEGIN
 SELECT * INTO d FROM whaleu_errands.media_drafts WHERE id=NEW.draft_id;
 definition:=(NEW.command-ARRAY['protocol','clientRequestId','targetRegionId'])||jsonb_build_object('version',2,'accountId',NEW.actor_id::text,'purpose','publish_errand','scope',d.scope,'mediaRevision',1);
 IF NOT whaleu_community.rating_scoped_keys(NEW.command,ARRAY['protocol','clientRequestId','targetRegionId','title','publicText','privateText','expectedTimeText','reward','publisherContacts','draftId','draftRevision','publicMedia','privateMedia']) OR d.id IS NULL OR(d.actor_id,d.revision,d.publication_request_id,d.publication_request_hash) IS DISTINCT FROM(NEW.actor_id,NEW.draft_revision,NEW.request_id,NEW.request_hash)
 OR d.target_region_id::text IS DISTINCT FROM NEW.command->>'targetRegionId'
 OR NEW.review_digest IS DISTINCT FROM encode(sha256(convert_to('whaleu-errand-content-approval:v2'||chr(10)||whaleu_community.content_canonical_json(definition),'UTF8')),'hex')
 OR NOT whaleu_errands.valid_image_set(NEW.command->'publicMedia','public',false) OR NOT whaleu_errands.valid_image_set(NEW.command->'privateMedia','private',false)
 THEN RAISE EXCEPTION 'Errand publication intent requires exact draft, authority and Review digest';END IF;RETURN NULL;END$$;
CREATE CONSTRAINT TRIGGER errand_media_intent_final AFTER INSERT ON whaleu_errands.media_publication_intents DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_errands.media_intent_guard();
CREATE FUNCTION whaleu_errands.media_review_revision_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.envelope IS DISTINCT FROM whaleu_errands.media_definition(NEW.order_id,NEW.media_revision)
 OR NOT EXISTS(SELECT 1 FROM whaleu_errands.media_heads WHERE(order_id,revision)=(NEW.order_id,NEW.media_revision))
 THEN RAISE EXCEPTION 'Errand re-review must match the exact current media set';END IF;RETURN NULL;END$$;
CREATE CONSTRAINT TRIGGER errand_media_review_revision_final AFTER INSERT ON whaleu_community.errand_media_approval_bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_errands.media_review_revision_guard();
-- Protect empty-set/zero-row writers as well as extant facts. Final readers take
-- NOWAIT SHARE fences on these tables; TRUNCATE never becomes a bypass.
DO $$DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['media_drafts','media_draft_cancellations','media_publication_intents','media_publications','media_sets','media_heads','media_audits'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON whaleu_errands.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_approval_immutable()',t||'_retain',t);
 END LOOP;
END$$;
