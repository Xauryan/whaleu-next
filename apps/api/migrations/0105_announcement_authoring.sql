-- Independent native source. Never asserts complete or empty legacy coverage.
SET LOCAL lock_timeout='5s';
CREATE TABLE whaleu_announcements.native_announcements (
 id uuid PRIMARY KEY REFERENCES whaleu_announcements.identities(id),
 creator_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 ordinal bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 revision bigint NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740990),
 revision_id uuid NOT NULL UNIQUE,
 state text NOT NULL CHECK(state IN('draft','active','inactive','cancelled')),
 content jsonb NOT NULL CHECK(jsonb_typeof(content)='object'),
 audience jsonb NOT NULL CHECK(jsonb_typeof(audience)='object'),
 media_bindings jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(media_bindings)='object'),
 publication_hash text NOT NULL CHECK(publication_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
CREATE INDEX native_announcement_order ON whaleu_announcements.native_announcements(ordinal DESC);
CREATE INDEX native_announcement_creator ON whaleu_announcements.native_announcements(creator_id,ordinal DESC);
CREATE TABLE whaleu_announcements.native_publications (
 announcement_id uuid NOT NULL REFERENCES whaleu_announcements.identities(id),
 revision bigint NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740990),
 revision_id uuid NOT NULL UNIQUE,
 operation text NOT NULL CHECK(operation IN('create','save','publish','update','set_enabled','cancel_draft')),
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 grant_id uuid REFERENCES whaleu_authorization.role_grants(id),
 state text NOT NULL CHECK(state IN('draft','active','inactive','cancelled')),
 content jsonb NOT NULL, audience jsonb NOT NULL, media_bindings jsonb NOT NULL,
 media_facts jsonb NOT NULL CHECK(jsonb_typeof(media_facts)='array' AND jsonb_array_length(media_facts)<=9),
 publication_hash text NOT NULL,
 source text NOT NULL DEFAULT 'admin_operation' CHECK(source='admin_operation'),
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 PRIMARY KEY(announcement_id,revision),
 CHECK(publication_hash=encode(sha256(convert_to('whaleu-announcement-snapshot:v1'||chr(10)||whaleu_community.content_canonical_json(jsonb_build_object('announcementId',announcement_id::text,'revision',revision,'revisionId',revision_id::text,'operation',operation,'actorId',actor_id::text,'grantId',grant_id::text,'state',state,'content',content,'audience',audience,'mediaBindings',media_bindings,'mediaFacts',media_facts)),'UTF8')),'hex'))
);
CREATE TABLE whaleu_announcements.native_requests (
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 client_request_id uuid NOT NULL,
 announcement_id uuid NOT NULL,
 command jsonb NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 receipt jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 PRIMARY KEY(actor_id,client_request_id),
 CHECK(request_hash=encode(sha256(convert_to('whaleu-announcement-command:v1'||chr(10)||whaleu_community.content_canonical_json(jsonb_build_object('actorId',actor_id::text,'announcementId',announcement_id::text,'command',command)),'UTF8')),'hex')),
 CHECK(coalesce(receipt=jsonb_build_object('requestId',client_request_id::text,'requestHash',request_hash,'announcementId',announcement_id::text,'revision',(command->>'expectedRevision')::bigint+1,'outcome',command->>'action'),false)),
 CHECK(octet_length(whaleu_community.content_canonical_json(command))<=60000)
);
CREATE TABLE whaleu_announcements.native_cancel_fences (
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),client_request_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),PRIMARY KEY(actor_id,client_request_id)
);
CREATE TABLE whaleu_announcements.native_directory_epoch(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),revision bigint NOT NULL DEFAULT 1 CHECK(revision>0));
INSERT INTO whaleu_announcements.native_directory_epoch(singleton) VALUES(true);
CREATE FUNCTION whaleu_announcements.native_authority(actor uuid,grant_id uuid,target jsonb) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_authorization.role_grants g JOIN whaleu_identity.accounts a ON a.id=g.account_id AND a.status='active' WHERE g.id=grant_id AND g.account_id=actor AND g.revoked_at IS NULL AND g.valid_from<=clock_timestamp() AND(g.expires_at IS NULL OR g.expires_at>clock_timestamp()) AND (
 (g.role='super_admin' AND g.operating_region_id IS NULL) OR
 (g.role='school_admin' AND g.operating_region_id IS NOT NULL AND target->>'kind'='regions' AND target->'regionIds'=jsonb_build_array(g.operating_region_id::text) AND (SELECT count(*) FROM whaleu_authorization.role_grants x WHERE x.account_id=actor AND x.role='school_admin' AND x.revoked_at IS NULL AND x.valid_from<=clock_timestamp() AND(x.expires_at IS NULL OR x.expires_at>clock_timestamp()))=1)))
$$;
CREATE FUNCTION whaleu_announcements.media_actor_current(actor uuid,announcement uuid,content_revision bigint,authority text) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_announcements.native_announcements d WHERE d.id=announcement AND d.revision=content_revision AND d.state IN('draft','active','inactive') AND(d.state<>'draft' OR d.creator_id=actor) AND whaleu_announcements.native_authority(actor,authority::uuid,d.audience) AND (d.creator_id=actor OR EXISTS(SELECT 1 FROM whaleu_authorization.role_grants g WHERE g.id=authority::uuid AND g.role='super_admin' AND g.operating_region_id IS NULL)))
$$;
CREATE FUNCTION whaleu_announcements.media_content_writer(announcement uuid,content_revision bigint) RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT p.actor_id FROM whaleu_announcements.native_publications p JOIN whaleu_announcements.native_announcements d ON d.id=p.announcement_id WHERE p.announcement_id=announcement AND p.revision=content_revision AND p.created_at=transaction_timestamp() AND p.content=d.content AND p.media_bindings=d.media_bindings LIMIT 1
$$;
CREATE FUNCTION whaleu_announcements.native_content_valid(c jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT jsonb_typeof(c)='object' AND c-ARRAY['title','type','versionLabel','bodyText','announcementDate','popupEnabled','highlight','popupTitle','popupBodyText']='{}'::jsonb
 AND c ?& ARRAY['title','type','versionLabel','bodyText','announcementDate','popupEnabled','highlight','popupTitle','popupBodyText']
 AND c->>'type'='minor' AND jsonb_typeof(c->'title')='string' AND length(c->>'title')<=200
 AND jsonb_typeof(c->'versionLabel')='string' AND length(c->>'versionLabel')<=100
 AND jsonb_typeof(c->'bodyText')='string' AND length(c->>'bodyText')<=10000
 AND jsonb_typeof(c->'popupEnabled')='boolean' AND jsonb_typeof(c->'highlight')='boolean'
 AND(c->'announcementDate'='null'::jsonb OR(jsonb_typeof(c->'announcementDate')='string' AND c->>'announcementDate' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'))
 AND(c->'popupTitle'='null'::jsonb OR(jsonb_typeof(c->'popupTitle')='string' AND length(c->>'popupTitle')<=200))
 AND(c->'popupBodyText'='null'::jsonb OR(jsonb_typeof(c->'popupBodyText')='string' AND length(c->>'popupBodyText')<=10000))
$$;
CREATE FUNCTION whaleu_announcements.native_publication_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior whaleu_announcements.native_announcements; mapped jsonb; region_count integer;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Native announcement history is immutable' USING ERRCODE='23514'; END IF;
 IF NOT coalesce(whaleu_announcements.native_content_valid(NEW.content),false) OR(NEW.state='active' AND(length(btrim(NEW.content->>'versionLabel'))=0 OR length(btrim(NEW.content->>'bodyText'))=0)) THEN RAISE EXCEPTION 'Invalid native announcement content' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:announcement-native:v1:'||NEW.announcement_id::text,0));
 SELECT * INTO prior FROM whaleu_announcements.native_announcements WHERE id=NEW.announcement_id FOR UPDATE;
 IF NEW.revision<>coalesce(prior.revision,0)+1 OR NEW.created_at<>transaction_timestamp() THEN RAISE EXCEPTION 'Announcement publication requires next revision' USING ERRCODE='23514'; END IF;
 IF NEW.operation='create' AND NEW.content->>'title' IS DISTINCT FROM '鲸语校园'||(NEW.content->>'versionLabel') THEN RAISE EXCEPTION 'Native title is generated at creation' USING ERRCODE='23514'; END IF;
 IF NEW.operation IN('publish','set_enabled') AND(NEW.content IS DISTINCT FROM prior.content OR NEW.media_bindings IS DISTINCT FROM prior.media_bindings) THEN RAISE EXCEPTION 'Lifecycle operation cannot rewrite content' USING ERRCODE='23514'; END IF;
 IF NEW.operation='cancel_draft' THEN
  IF prior.id IS NULL OR prior.creator_id<>NEW.actor_id OR prior.state<>'draft' OR NEW.state<>'cancelled' OR NEW.content<>prior.content OR NEW.audience<>prior.audience THEN RAISE EXCEPTION 'Only own unpublished draft can be cancelled' USING ERRCODE='23514'; END IF;
 ELSE
  IF NOT coalesce(whaleu_announcements.native_authority(NEW.actor_id,NEW.grant_id,NEW.audience),false) THEN RAISE EXCEPTION 'Announcement authority required' USING ERRCODE='23514'; END IF;
  IF prior.id IS NOT NULL AND (prior.state='cancelled' OR (prior.state='draft' AND prior.creator_id<>NEW.actor_id) OR (prior.creator_id<>NEW.actor_id AND NOT EXISTS(SELECT 1 FROM whaleu_authorization.role_grants WHERE id=NEW.grant_id AND role='super_admin' AND operating_region_id IS NULL)) OR NOT whaleu_announcements.native_authority(NEW.actor_id,NEW.grant_id,prior.audience) OR NEW.content->>'title' IS DISTINCT FROM prior.content->>'title') THEN RAISE EXCEPTION 'Announcement creator and authority must remain valid' USING ERRCODE='23514'; END IF;
  IF NOT coalesce(jsonb_typeof(NEW.audience->'regionIds')='array' AND jsonb_typeof(NEW.audience->'campusIds')='array' AND NEW.audience-ARRAY['kind','regionIds','campusIds']='{}'::jsonb,false) THEN RAISE EXCEPTION 'Invalid announcement audience' USING ERRCODE='23514'; END IF;
  IF NEW.audience->>'kind'='all' THEN
   IF NEW.audience->'regionIds'<>'[]'::jsonb OR NEW.audience->'campusIds'<>'[]'::jsonb THEN RAISE EXCEPTION 'Global audience contains no selected campuses' USING ERRCODE='23514'; END IF;
  ELSIF NEW.audience->>'kind'='regions' THEN
   SELECT count(*) INTO region_count FROM whaleu_campus.operating_regions r WHERE r.is_active AND NEW.audience->'regionIds' ? r.id::text;
   SELECT coalesce(jsonb_agg(c.id::text ORDER BY c.id),'[]'::jsonb) INTO mapped FROM whaleu_campus.campus_region_assignments a JOIN whaleu_campus.campuses c ON c.id=a.campus_id JOIN whaleu_campus.institutions i ON i.id=c.institution_id WHERE NEW.audience->'regionIds' ? a.operating_region_id::text AND c.is_active;
   IF region_count=0 OR region_count<>jsonb_array_length(NEW.audience->'regionIds') OR mapped='[]'::jsonb OR NEW.audience->'campusIds'<>mapped OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(NEW.audience->'regionIds') x WHERE NOT EXISTS(SELECT 1 FROM whaleu_campus.campus_region_assignments a JOIN whaleu_campus.campuses c ON c.id=a.campus_id JOIN whaleu_campus.institutions i ON i.id=c.institution_id WHERE a.operating_region_id=x::uuid AND c.is_active)) THEN RAISE EXCEPTION 'Announcement audience requires complete current physical campuses' USING ERRCODE='23514'; END IF;
  ELSE RAISE EXCEPTION 'Invalid audience kind' USING ERRCODE='23514'; END IF;
 END IF;
 IF (NEW.operation='create' AND (prior.id IS NOT NULL OR NEW.state<>'draft')) OR (NEW.operation='save' AND (prior.state IS DISTINCT FROM 'draft' OR NEW.state<>'draft')) OR (NEW.operation='publish' AND (prior.state IS DISTINCT FROM 'draft' OR NEW.state<>'active')) OR (NEW.operation IN('update','set_enabled') AND (prior.state NOT IN('active','inactive') OR NEW.state NOT IN('active','inactive'))) THEN RAISE EXCEPTION 'Invalid announcement state transition' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER native_publication_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_announcements.native_publications FOR EACH ROW EXECUTE FUNCTION whaleu_announcements.native_publication_guard();
CREATE FUNCTION whaleu_announcements.native_entry_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p whaleu_announcements.native_publications;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Disable announcements instead of deleting them' USING ERRCODE='23514'; END IF;
 SELECT * INTO p FROM whaleu_announcements.native_publications WHERE announcement_id=NEW.id AND revision=NEW.revision;
 IF p.announcement_id IS NULL OR (NEW.revision_id,NEW.state,NEW.content,NEW.audience,NEW.media_bindings,NEW.publication_hash,NEW.updated_at) IS DISTINCT FROM(p.revision_id,p.state,p.content,p.audience,p.media_bindings,p.publication_hash,p.created_at) OR NEW.revision<>(CASE WHEN TG_OP='INSERT' THEN 1 ELSE OLD.revision+1 END) OR (TG_OP='UPDATE' AND (NEW.id,NEW.creator_id,NEW.ordinal,NEW.created_at) IS DISTINCT FROM(OLD.id,OLD.creator_id,OLD.ordinal,OLD.created_at)) OR (TG_OP='INSERT' AND(NEW.creator_id<>p.actor_id OR NEW.created_at<>transaction_timestamp())) THEN RAISE EXCEPTION 'Native announcement must reference exact immutable source' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER native_entry_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_announcements.native_announcements FOR EACH ROW EXECUTE FUNCTION whaleu_announcements.native_entry_guard();
CREATE FUNCTION whaleu_announcements.native_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Native announcement receipts and cancellation fences are immutable' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:announcement-request:v1:'||NEW.actor_id::text||':'||NEW.client_request_id::text,0));
 IF TG_TABLE_NAME='native_requests' THEN
  IF EXISTS(SELECT 1 FROM whaleu_announcements.native_cancel_fences WHERE actor_id=NEW.actor_id AND client_request_id=NEW.client_request_id) OR NEW.command->>'clientRequestId' IS DISTINCT FROM NEW.client_request_id::text OR NOT EXISTS(SELECT 1 FROM whaleu_announcements.native_publications p WHERE p.announcement_id=NEW.announcement_id AND p.revision=(NEW.receipt->>'revision')::bigint AND p.actor_id=NEW.actor_id AND p.operation=NEW.command->>'action' AND p.created_at=transaction_timestamp() AND(p.operation NOT IN('create','save','update') OR p.content-ARRAY['title','type']=NEW.command->'content') AND(p.operation<>'set_enabled' OR(p.state='active')=(NEW.command->>'enabled')::boolean)) THEN RAISE EXCEPTION 'Announcement receipt lacks exact operation' USING ERRCODE='23514'; END IF;
 ELSIF EXISTS(SELECT 1 FROM whaleu_announcements.native_requests WHERE actor_id=NEW.actor_id AND client_request_id=NEW.client_request_id) THEN RAISE EXCEPTION 'Recorded operation cannot be cancelled' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER native_request_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_announcements.native_requests FOR EACH ROW EXECUTE FUNCTION whaleu_announcements.native_request_guard();
CREATE TRIGGER native_cancel_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_announcements.native_cancel_fences FOR EACH ROW EXECUTE FUNCTION whaleu_announcements.native_request_guard();
CREATE FUNCTION whaleu_announcements.native_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_announcements.native_announcements d WHERE d.id=NEW.announcement_id AND d.revision>=NEW.revision) OR NOT EXISTS(SELECT 1 FROM whaleu_announcements.native_requests r WHERE r.announcement_id=NEW.announcement_id AND(r.receipt->>'revision')::bigint=NEW.revision AND r.actor_id=NEW.actor_id) THEN RAISE EXCEPTION 'Announcement operation requires atomic pointer and receipt' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER native_complete AFTER INSERT ON whaleu_announcements.native_publications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_announcements.native_complete();
CREATE FUNCTION whaleu_announcements.native_epoch() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN UPDATE whaleu_announcements.native_directory_epoch SET revision=revision+1 WHERE singleton; RETURN NULL; END $$;
CREATE TRIGGER native_epoch AFTER INSERT OR UPDATE ON whaleu_announcements.native_announcements FOR EACH STATEMENT EXECUTE FUNCTION whaleu_announcements.native_epoch();
DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['native_announcements','native_publications','native_requests','native_cancel_fences','native_directory_epoch'] LOOP
 EXECUTE format('CREATE TRIGGER native_no_truncate BEFORE TRUNCATE ON whaleu_announcements.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_announcements.reject_truncate()',t);
 END LOOP;END $$;
