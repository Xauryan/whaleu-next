-- Native activities. Accepted 0036 catalogs remain untouched and read-only.
-- No fixture, provider, role grant or default review approval is installed.
SET LOCAL lock_timeout='5s';
CREATE TABLE whaleu_activities.publication_drafts(
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 organization_id uuid NOT NULL REFERENCES whaleu_organizations.organizations(id), organization_revision bigint NOT NULL CHECK(organization_revision>0),
 authority_version text NOT NULL, region_id uuid NOT NULL REFERENCES whaleu_campus.operating_regions(id),
 revision bigint NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740990),state text NOT NULL CHECK(state IN('draft','published','cancelled')),
 content jsonb NOT NULL CHECK(jsonb_typeof(content)='object' AND octet_length(content::text)<=16384),media_bindings jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(media_bindings)='object'),
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),updated_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
CREATE TABLE whaleu_activities.publication_requests(
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),client_request_id uuid NOT NULL,activity_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),command jsonb NOT NULL CHECK(octet_length(command::text)<=32768),created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 PRIMARY KEY(actor_id,client_request_id),
 CHECK(command->>'clientRequestId'=client_request_id::text),
 CHECK(request_hash=encode(sha256(convert_to('whaleu-activity-command:v1'||chr(10)||whaleu_community.content_canonical_json(jsonb_build_object('actorId',actor_id::text,'activityId',activity_id::text,'command',command)),'UTF8')),'hex'))
);
CREATE TABLE whaleu_activities.publication_events(
 id uuid PRIMARY KEY,activity_id uuid NOT NULL REFERENCES whaleu_activities.publication_drafts(id),actor_id uuid NOT NULL,client_request_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN('create','save','publish','cancel_draft')),revision bigint NOT NULL,content jsonb NOT NULL,media_bindings jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),UNIQUE(actor_id,client_request_id),UNIQUE(activity_id,revision,action),
 FOREIGN KEY(actor_id,client_request_id) REFERENCES whaleu_activities.publication_requests(actor_id,client_request_id)
);
CREATE TABLE whaleu_activities.publication_receipts(
 actor_id uuid NOT NULL,client_request_id uuid NOT NULL,request_hash text NOT NULL,activity_id uuid NOT NULL,event_id uuid NOT NULL UNIQUE REFERENCES whaleu_activities.publication_events(id),receipt jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),PRIMARY KEY(actor_id,client_request_id),FOREIGN KEY(actor_id,client_request_id) REFERENCES whaleu_activities.publication_requests(actor_id,client_request_id)
);
CREATE TABLE whaleu_activities.publication_cancel_fences(
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),client_request_id uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),PRIMARY KEY(actor_id,client_request_id)
);
CREATE TABLE whaleu_activities.review_jobs(
 id uuid PRIMARY KEY,actor_id uuid NOT NULL,client_request_id uuid NOT NULL,activity_id uuid NOT NULL REFERENCES whaleu_activities.publication_drafts(id),
 digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),envelope jsonb NOT NULL CHECK(octet_length(envelope::text)<=32768),created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 UNIQUE(actor_id,client_request_id),FOREIGN KEY(actor_id,client_request_id) REFERENCES whaleu_activities.publication_requests(actor_id,client_request_id),
 CHECK(envelope->>'purpose'='publish_activity' AND envelope->>'version'='1' AND envelope->>'accountId'=actor_id::text AND envelope->>'activityId'=activity_id::text),
 CHECK(digest=encode(sha256(convert_to('whaleu-activity-review:v1'||chr(10)||whaleu_community.content_canonical_json(envelope),'UTF8')),'hex'))
);
-- Controlled, explicitly injected local simulation issuer only. Production has
-- no issuance runtime, no policies, and cannot silently allow content.
CREATE TABLE whaleu_activities.review_policies(
 id uuid PRIMARY KEY,policy_key text NOT NULL CHECK(policy_key='activity-simulation-v1'),issuer text NOT NULL CHECK(length(btrim(issuer))>0),
 provenance text NOT NULL CHECK(provenance='simulation'),valid_from timestamptz NOT NULL,valid_until timestamptz NOT NULL CHECK(valid_until>valid_from)
);
CREATE TABLE whaleu_activities.review_decisions(
 id uuid PRIMARY KEY,job_id uuid NOT NULL UNIQUE REFERENCES whaleu_activities.review_jobs(id),policy_id uuid NOT NULL REFERENCES whaleu_activities.review_policies(id),
 digest text NOT NULL,result text NOT NULL CHECK(result IN('allow','reject','failed')),coverage text NOT NULL CHECK(coverage='complete'),provenance_ref text NOT NULL CHECK(length(btrim(provenance_ref))>0),
 evaluated_at timestamptz NOT NULL DEFAULT clock_timestamp(),consume_until timestamptz NOT NULL, CHECK(consume_until>evaluated_at AND consume_until<=evaluated_at+interval '30 minutes')
);
CREATE TABLE whaleu_activities.review_heads(decision_id uuid PRIMARY KEY REFERENCES whaleu_activities.review_decisions(id),state text NOT NULL CHECK(state IN('allow','held','revoked')),revision bigint NOT NULL DEFAULT 1 CHECK(revision>0));
CREATE TABLE whaleu_activities.native_activities(
 id uuid PRIMARY KEY REFERENCES whaleu_activities.publication_drafts(id),original_publisher_account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),organization_id uuid NOT NULL REFERENCES whaleu_organizations.organizations(id),organization_revision bigint NOT NULL,
 revision bigint NOT NULL,region_id uuid NOT NULL REFERENCES whaleu_campus.operating_regions(id),organizer_label text NOT NULL,
 content jsonb NOT NULL,media_bindings jsonb NOT NULL,organizer_qr jsonb,review_decision_id uuid NOT NULL UNIQUE REFERENCES whaleu_activities.review_decisions(id),
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),ordinal bigint GENERATED ALWAYS AS IDENTITY UNIQUE
);
CREATE INDEX native_activity_region ON whaleu_activities.native_activities(region_id,ordinal DESC);
CREATE INDEX native_activity_publisher ON whaleu_activities.native_activities(original_publisher_account_id,ordinal DESC);
CREATE TABLE whaleu_activities.native_directory_epoch(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),revision bigint NOT NULL DEFAULT 1 CHECK(revision>0));
INSERT INTO whaleu_activities.native_directory_epoch(singleton) VALUES(true);
CREATE FUNCTION whaleu_activities.publication_lock(id uuid) RETURNS void LANGUAGE sql AS $$SELECT pg_advisory_xact_lock(hashtextextended('whaleu:activity-publication:v1:'||id::text,0))$$;
CREATE FUNCTION whaleu_activities.organizer_actor_current(actor uuid,organization uuid,organization_revision bigint,authority text) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_organizations.organizations o JOIN whaleu_organizations.organization_grants g ON g.organization_id=o.id JOIN whaleu_identity.accounts a ON a.id=actor AND a.status='active' JOIN whaleu_campus.operating_regions r ON r.id=o.region_id AND r.is_active
 WHERE o.id=organization AND o.state='approved' AND o.revision=organization_revision AND g.account_id=actor AND g.role IN('organization_owner','organization_admin') AND g.revoked_at IS NULL AND g.valid_from<=clock_timestamp() AND(g.expires_at IS NULL OR g.expires_at>clock_timestamp()) AND authority=o.authority_version::text||':'||g.id::text)
$$;
CREATE FUNCTION whaleu_activities.media_actor_current(actor uuid,activity uuid,draft_revision bigint,authority text) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_activities.publication_drafts d WHERE d.id=activity AND d.account_id=actor AND d.state='draft' AND d.revision=draft_revision AND d.authority_version=authority AND whaleu_activities.organizer_actor_current(actor,d.organization_id,d.organization_revision,authority))
$$;
CREATE FUNCTION whaleu_activities.media_content_writer(activity uuid,content_revision bigint) RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT e.actor_id FROM whaleu_activities.publication_events e JOIN whaleu_activities.publication_drafts d ON d.id=e.activity_id WHERE e.activity_id=activity AND e.revision=content_revision AND e.action IN('create','save','cancel_draft') AND e.created_at=transaction_timestamp() AND e.content=d.content AND e.media_bindings=d.media_bindings LIMIT 1
$$;
CREATE FUNCTION whaleu_activities.publication_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d whaleu_activities.publication_drafts;e whaleu_activities.publication_events;q whaleu_activities.publication_requests;
BEGIN
 IF TG_TABLE_NAME='publication_drafts' THEN
 PERFORM whaleu_activities.publication_lock(NEW.id);
 IF jsonb_typeof(NEW.content)<>'object' OR NOT whaleu_community.rating_scoped_keys(NEW.content,ARRAY['title','description','types','activityTime','activityLocation','endAt','showOrganizerQr']) OR length(NEW.content->>'title')>50 OR length(NEW.content->>'description')>1000 OR length(NEW.content->>'activityTime')>200 OR length(NEW.content->>'activityLocation')>200 OR jsonb_typeof(NEW.content->'types')<>'array' OR jsonb_array_length(NEW.content->'types')>3 OR NOT(NEW.content->'types'<@'["reward","online","offline"]'::jsonb) OR jsonb_typeof(NEW.content->'showOrganizerQr')<>'boolean' THEN RAISE EXCEPTION 'Invalid activity content' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN
 IF NEW.state<>'draft' OR NEW.revision<>1 OR NOT whaleu_activities.organizer_actor_current(NEW.account_id,NEW.organization_id,NEW.organization_revision,NEW.authority_version) THEN RAISE EXCEPTION 'Activity draft needs current target authority' USING ERRCODE='23514';END IF;
 ELSE
 IF (NEW.id,NEW.account_id,NEW.organization_id,NEW.organization_revision,NEW.authority_version,NEW.region_id,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.account_id,OLD.organization_id,OLD.organization_revision,OLD.authority_version,OLD.region_id,OLD.created_at) OR OLD.state<>'draft' THEN RAISE EXCEPTION 'Activity origin is immutable' USING ERRCODE='23514';END IF;
 SELECT * INTO e FROM whaleu_activities.publication_events WHERE activity_id=NEW.id AND revision=NEW.revision AND created_at=transaction_timestamp() AND action=CASE WHEN NEW.state='published' THEN 'publish' WHEN NEW.state='cancelled' THEN 'cancel_draft' ELSE 'save' END;
 IF e.id IS NULL OR (e.content,e.media_bindings) IS DISTINCT FROM (NEW.content,NEW.media_bindings) OR NEW.revision<>OLD.revision+(CASE WHEN NEW.state='draft' THEN 1 ELSE 0 END) THEN RAISE EXCEPTION 'Activity mutation needs exact atomic event' USING ERRCODE='23514';END IF;
 END IF;
 ELSIF TG_TABLE_NAME='publication_events' THEN
 SELECT * INTO d FROM whaleu_activities.publication_drafts WHERE id=NEW.activity_id;
 SELECT * INTO q FROM whaleu_activities.publication_requests WHERE actor_id=NEW.actor_id AND client_request_id=NEW.client_request_id;
 IF d.id IS NULL OR q.actor_id IS NULL OR d.account_id<>NEW.actor_id OR d.state<>'draft' OR q.activity_id<>d.id OR q.command->>'action'<>NEW.action OR (q.command->>'expectedRevision')::bigint<>(CASE WHEN NEW.action='create' THEN 0 ELSE d.revision END) OR (NEW.action IN('create','save') AND NEW.content IS DISTINCT FROM q.command->'content') OR (NEW.action='create' AND (q.command->'organization' IS DISTINCT FROM jsonb_build_object('source','managed','organizationId',d.organization_id::text) OR(q.command->>'organizationRevision')::bigint<>d.organization_revision)) OR NEW.revision<>d.revision+(CASE WHEN NEW.action='save' THEN 1 ELSE 0 END) OR(NEW.action<>'cancel_draft' AND NOT whaleu_activities.organizer_actor_current(NEW.actor_id,d.organization_id,d.organization_revision,d.authority_version)) OR (NEW.action='cancel_draft' AND (NEW.content IS DISTINCT FROM d.content OR EXISTS(SELECT 1 FROM jsonb_each(NEW.media_bindings) item WHERE item.value<>'null'::jsonb) OR EXISTS(SELECT 1 FROM whaleu_activities.review_jobs j WHERE j.activity_id=d.id AND NOT EXISTS(SELECT 1 FROM whaleu_activities.publication_cancel_fences c WHERE(c.actor_id,c.client_request_id)=(j.actor_id,j.client_request_id))))) OR NEW.created_at<>transaction_timestamp() THEN RAISE EXCEPTION 'Activity event needs exact original request and current actor' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END$$;
CREATE TRIGGER activity_draft_guard BEFORE INSERT OR UPDATE ON whaleu_activities.publication_drafts FOR EACH ROW EXECUTE FUNCTION whaleu_activities.publication_guard();
CREATE TRIGGER activity_event_guard BEFORE INSERT ON whaleu_activities.publication_events FOR EACH ROW EXECUTE FUNCTION whaleu_activities.publication_guard();
CREATE FUNCTION whaleu_activities.publication_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_activities.publication_requests;e whaleu_activities.publication_events;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:activity-request:v1:'||NEW.actor_id::text||':'||NEW.client_request_id::text,0));
 IF TG_TABLE_NAME='publication_cancel_fences' THEN
 IF EXISTS(SELECT 1 FROM whaleu_activities.publication_receipts WHERE actor_id=NEW.actor_id AND client_request_id=NEW.client_request_id) OR EXISTS(SELECT 1 FROM whaleu_activities.publication_requests WHERE actor_id=NEW.actor_id AND client_request_id=NEW.client_request_id AND request_hash<>NEW.request_hash) THEN RAISE EXCEPTION 'Activity cancellation conflicts with original request' USING ERRCODE='23514';END IF;
 ELSE
 IF EXISTS(SELECT 1 FROM whaleu_activities.publication_cancel_fences WHERE actor_id=NEW.actor_id AND client_request_id=NEW.client_request_id) THEN RAISE EXCEPTION 'Activity request cancelled' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='publication_receipts' THEN
 SELECT * INTO q FROM whaleu_activities.publication_requests WHERE actor_id=NEW.actor_id AND client_request_id=NEW.client_request_id;
 SELECT * INTO e FROM whaleu_activities.publication_events WHERE id=NEW.event_id;
 IF q.request_hash<>NEW.request_hash OR(q.activity_id,q.actor_id,q.client_request_id) IS DISTINCT FROM(e.activity_id,e.actor_id,e.client_request_id) OR NEW.receipt->>'requestId'<>NEW.client_request_id::text OR NEW.receipt->>'requestHash'<>NEW.request_hash OR NEW.receipt->>'activityId'<>NEW.activity_id::text OR(NEW.receipt->>'revision')::bigint<>e.revision THEN RAISE EXCEPTION 'Activity receipt needs exact event' USING ERRCODE='23514';END IF;
 END IF;END IF;RETURN NEW;
END$$;
DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['publication_requests','publication_receipts','publication_cancel_fences'] LOOP EXECUTE format('CREATE TRIGGER activity_request_guard BEFORE INSERT ON whaleu_activities.%I FOR EACH ROW EXECUTE FUNCTION whaleu_activities.publication_request_guard()',t);END LOOP;END$$;
CREATE FUNCTION whaleu_activities.publication_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_activities.publication_events e JOIN whaleu_activities.publication_receipts r ON r.event_id=e.id WHERE e.activity_id=NEW.id AND e.revision=NEW.revision AND e.content=NEW.content AND e.media_bindings=NEW.media_bindings AND e.action=CASE WHEN NEW.state='published' THEN 'publish' WHEN NEW.state='cancelled' THEN 'cancel_draft' WHEN NEW.revision=1 THEN 'create' ELSE 'save' END) THEN RAISE EXCEPTION 'Activity draft requires atomic event and receipt' USING ERRCODE='23514';END IF;
 IF NEW.state='published' AND NOT EXISTS(SELECT 1 FROM whaleu_activities.native_activities WHERE id=NEW.id) THEN RAISE EXCEPTION 'Published draft needs immutable native activity' USING ERRCODE='23514';END IF;RETURN NULL;
END$$;
CREATE CONSTRAINT TRIGGER activity_publication_complete AFTER INSERT OR UPDATE ON whaleu_activities.publication_drafts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_activities.publication_complete();
CREATE FUNCTION whaleu_activities.native_publication_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d whaleu_activities.publication_drafts;j whaleu_activities.review_jobs;v whaleu_activities.review_decisions;
BEGIN
 SELECT * INTO d FROM whaleu_activities.publication_drafts WHERE id=NEW.id;
 SELECT * INTO v FROM whaleu_activities.review_decisions WHERE id=NEW.review_decision_id;
 SELECT * INTO j FROM whaleu_activities.review_jobs WHERE id=v.job_id;
 IF d.id IS NULL OR v.id IS NULL OR j.id IS NULL OR (NEW.id,NEW.original_publisher_account_id,NEW.organization_id,NEW.organization_revision,NEW.revision,NEW.region_id,NEW.content,NEW.media_bindings) IS DISTINCT FROM(d.id,d.account_id,d.organization_id,d.organization_revision,d.revision,d.region_id,d.content,d.media_bindings) OR length(btrim(NEW.content->>'title'))=0 OR jsonb_array_length(NEW.content->'types')=0 OR(NEW.content->'types'?'offline' AND(length(btrim(NEW.content->>'activityTime'))=0 OR length(btrim(NEW.content->>'activityLocation'))=0)) OR NEW.media_bindings->>'cover' IS NULL OR j.activity_id<>NEW.id OR j.actor_id<>NEW.original_publisher_account_id OR v.digest<>j.digest OR j.envelope->'content'<>NEW.content OR(j.envelope->>'draftRevision')::bigint<>NEW.revision OR(j.envelope->>'organizationRevision')::bigint<>NEW.organization_revision OR j.envelope->>'organizerLabel'<>NEW.organizer_label OR j.envelope->'organizerQr' IS DISTINCT FROM coalesce(NEW.organizer_qr,'null'::jsonb) OR v.result<>'allow' OR v.consume_until<=clock_timestamp() OR v.evaluated_at>clock_timestamp() OR NOT EXISTS(SELECT 1 FROM whaleu_activities.review_heads h JOIN whaleu_activities.review_policies p ON p.id=v.policy_id WHERE h.decision_id=v.id AND h.state='allow' AND p.valid_from<=v.evaluated_at AND p.valid_until>clock_timestamp()) THEN RAISE EXCEPTION 'Native activity requires exact current independent review and media' USING ERRCODE='23514';END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER native_activity_guard BEFORE INSERT ON whaleu_activities.native_activities FOR EACH ROW EXECUTE FUNCTION whaleu_activities.native_publication_guard();
CREATE FUNCTION whaleu_activities.advance_native_epoch() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN UPDATE whaleu_activities.native_directory_epoch SET revision=revision+1 WHERE singleton;RETURN NULL;END$$;
CREATE TRIGGER activity_native_epoch AFTER INSERT ON whaleu_activities.native_activities FOR EACH STATEMENT EXECUTE FUNCTION whaleu_activities.advance_native_epoch();
CREATE FUNCTION whaleu_activities.retain_publication() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'Activity publication history is immutable' USING ERRCODE='23514';END$$;
DO $$DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['publication_requests','publication_events','publication_receipts','publication_cancel_fences','review_jobs','review_policies','review_decisions','native_activities'] LOOP
 EXECUTE format('CREATE TRIGGER activity_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_activities.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_activities.retain_publication()',t);END LOOP;
 EXECUTE 'CREATE TRIGGER activity_draft_retain BEFORE DELETE OR TRUNCATE ON whaleu_activities.publication_drafts FOR EACH STATEMENT EXECUTE FUNCTION whaleu_activities.retain_publication()';
END$$;
-- One unresolved original publication per draft, including alternate raw writers.
CREATE FUNCTION whaleu_activities.review_job_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d whaleu_activities.publication_drafts;q whaleu_activities.publication_requests;
BEGIN
 PERFORM whaleu_activities.publication_lock(NEW.activity_id);
 SELECT * INTO d FROM whaleu_activities.publication_drafts WHERE id=NEW.activity_id;
 SELECT * INTO q FROM whaleu_activities.publication_requests WHERE actor_id=NEW.actor_id AND client_request_id=NEW.client_request_id;
 IF d.id IS NULL OR q.actor_id IS NULL OR q.activity_id<>d.id OR q.command->>'action'<>'publish' OR(q.command->>'expectedRevision')::bigint<>d.revision OR d.state<>'draft' OR d.account_id<>NEW.actor_id OR(NEW.envelope->>'draftRevision')::bigint<>d.revision OR NEW.envelope->'content'<>d.content OR NEW.envelope->'organization'<>jsonb_build_object('source','managed','organizationId',d.organization_id::text) OR(NEW.envelope->>'organizationRevision')::bigint<>d.organization_revision OR NEW.envelope->>'authorityVersion'<>d.authority_version OR NEW.envelope->>'regionId'<>d.region_id::text OR NOT whaleu_activities.media_actor_current(NEW.actor_id,d.id,d.revision,d.authority_version) OR EXISTS(SELECT 1 FROM whaleu_activities.review_jobs j WHERE j.activity_id=d.id AND NOT EXISTS(SELECT 1 FROM whaleu_activities.publication_receipts r WHERE(r.actor_id,r.client_request_id)=(j.actor_id,j.client_request_id)) AND NOT EXISTS(SELECT 1 FROM whaleu_activities.publication_cancel_fences c WHERE(c.actor_id,c.client_request_id)=(j.actor_id,j.client_request_id))) THEN RAISE EXCEPTION 'Activity review requires the unique frozen original publication' USING ERRCODE='23514';END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER activity_review_job_guard BEFORE INSERT ON whaleu_activities.review_jobs FOR EACH ROW EXECUTE FUNCTION whaleu_activities.review_job_guard();

-- Publishing consumes the exact original review request, never another key's
-- cancelled or unrelated accepted decision. Checked after owner event/receipt.
CREATE FUNCTION whaleu_activities.native_request_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_activities.review_decisions v JOIN whaleu_activities.review_jobs j ON j.id=v.job_id JOIN whaleu_activities.publication_events e ON(e.actor_id,e.client_request_id,e.activity_id)=(j.actor_id,j.client_request_id,j.activity_id) AND e.action='publish' JOIN whaleu_activities.publication_receipts r ON r.event_id=e.id WHERE v.id=NEW.review_decision_id AND j.activity_id=NEW.id AND e.revision=NEW.revision AND e.content=NEW.content AND e.media_bindings=NEW.media_bindings AND e.created_at=transaction_timestamp() AND NOT EXISTS(SELECT 1 FROM whaleu_activities.publication_cancel_fences c WHERE(c.actor_id,c.client_request_id)=(j.actor_id,j.client_request_id))) THEN RAISE EXCEPTION 'Activity must consume its uncancelled exact original review request' USING ERRCODE='23514';END IF;
 RETURN NULL;
END$$;
CREATE CONSTRAINT TRIGGER activity_native_request_complete AFTER INSERT ON whaleu_activities.native_activities DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_activities.native_request_complete();
CREATE FUNCTION whaleu_activities.native_qr_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE qr jsonb;
BEGIN
 qr:=NEW.organizer_qr;
 IF NEW.content->'showOrganizerQr'='false'::jsonb THEN IF qr IS NOT NULL THEN RAISE EXCEPTION 'Disabled activity QR must not disclose a binding' USING ERRCODE='23514';END IF;RETURN NEW;END IF;
 IF qr IS NULL OR NOT EXISTS(SELECT 1 FROM whaleu_organizations.organizations o JOIN whaleu_organizations.media_appearances p ON p.organization_id=o.id AND p.slot='mainQr' AND p.binding_id::text=o.media_bindings->>'mainQr'
 JOIN whaleu_media.bindings b ON b.id=p.binding_id AND b.asset_id=p.asset_id AND b.manifest_digest=p.manifest_digest AND b.resource_id=p.id AND b.owner_kind='organizations' AND b.resource_kind='organization_image' AND b.slot='mainQr' AND b.detached_at IS NULL
 JOIN whaleu_media.assets a ON a.id=b.asset_id AND a.manifest_digest=b.manifest_digest
 JOIN whaleu_media.asset_safety_heads h ON h.asset_id=a.id JOIN whaleu_media.asset_safety_events e ON(e.id,e.asset_id,e.revision)=(h.event_id,h.asset_id,h.revision)
 WHERE o.id=NEW.organization_id AND o.state='approved' AND o.revision=NEW.organization_revision AND qr=jsonb_build_object('organizationId',o.id::text,'applicationRevision',o.revision,'slot','mainQr','bindingId',p.binding_id::text,'assetId',p.asset_id::text,'manifestDigest',p.manifest_digest) AND e.state='allow' AND e.manifest_digest=a.manifest_digest AND e.policy_revision=a.policy_revision AND e.effective_at<=clock_timestamp() AND e.valid_until>clock_timestamp()) THEN RAISE EXCEPTION 'Activity QR needs current exact public organizer main QR and reviewed bytes' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE TRIGGER activity_native_qr_guard BEFORE INSERT ON whaleu_activities.native_activities FOR EACH ROW EXECUTE FUNCTION whaleu_activities.native_qr_guard();
-- Review heads are causal projections of append-only explicit state events.
CREATE TABLE whaleu_activities.review_events(
 id uuid PRIMARY KEY,decision_id uuid NOT NULL REFERENCES whaleu_activities.review_decisions(id),revision bigint NOT NULL CHECK(revision>0),
 state text NOT NULL CHECK(state IN('allow','held','revoked')),occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 provenance_ref text NOT NULL CHECK(length(btrim(provenance_ref))>0),UNIQUE(decision_id,revision),UNIQUE(id,decision_id,revision,state)
);
ALTER TABLE whaleu_activities.review_heads ADD COLUMN event_id uuid NOT NULL;
ALTER TABLE whaleu_activities.review_heads ADD CONSTRAINT activity_review_head_event FOREIGN KEY(event_id,decision_id,revision,state) REFERENCES whaleu_activities.review_events(id,decision_id,revision,state);
CREATE FUNCTION whaleu_activities.review_state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d whaleu_activities.review_decisions;h whaleu_activities.review_heads;e whaleu_activities.review_events;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:activity-review-decision:v1:'||NEW.decision_id::text,0));
 SELECT * INTO d FROM whaleu_activities.review_decisions WHERE id=NEW.decision_id;
 SELECT * INTO h FROM whaleu_activities.review_heads WHERE decision_id=NEW.decision_id;
 IF TG_TABLE_NAME='review_events' THEN
 IF d.id IS NULL OR NEW.revision<>coalesce(h.revision,0)+1 OR NEW.occurred_at<d.evaluated_at OR NEW.occurred_at>clock_timestamp() OR(NEW.state='allow' AND d.result<>'allow') THEN RAISE EXCEPTION 'Activity review state needs exact ordered decision event' USING ERRCODE='23514';END IF;
 ELSE
 SELECT * INTO e FROM whaleu_activities.review_events WHERE id=NEW.event_id;
 IF e.id IS NULL OR(NEW.decision_id,NEW.revision,NEW.state) IS DISTINCT FROM(e.decision_id,e.revision,e.state) OR NEW.revision<>coalesce(h.revision,0)+1 THEN RAISE EXCEPTION 'Activity review head needs its exact next event' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END$$;
CREATE TRIGGER activity_review_event_guard BEFORE INSERT ON whaleu_activities.review_events FOR EACH ROW EXECUTE FUNCTION whaleu_activities.review_state_guard();
CREATE TRIGGER activity_review_head_guard BEFORE INSERT OR UPDATE ON whaleu_activities.review_heads FOR EACH ROW EXECUTE FUNCTION whaleu_activities.review_state_guard();
CREATE TRIGGER activity_review_events_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_activities.review_events FOR EACH STATEMENT EXECUTE FUNCTION whaleu_activities.retain_publication();
CREATE TRIGGER activity_review_heads_retain BEFORE DELETE OR TRUNCATE ON whaleu_activities.review_heads FOR EACH STATEMENT EXECUTE FUNCTION whaleu_activities.retain_publication();
