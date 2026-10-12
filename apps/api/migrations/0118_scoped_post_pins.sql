-- Bounded original-region/global-topic post pins. No source, history, role or
-- account is seeded. Related-campus distribution is not inferred.
CREATE TABLE whaleu_community.post_pin_scopes (
 id uuid PRIMARY KEY,
 space_id uuid NOT NULL UNIQUE REFERENCES whaleu_community.spaces(id),
 kind text NOT NULL CHECK(kind IN('regional','university_city','feedback')),
 operating_region_id uuid REFERENCES whaleu_campus.operating_regions(id),
 source_reference text NOT NULL CHECK(length(btrim(source_reference)) BETWEEN 1 AND 2048),
 provenance text NOT NULL CHECK(provenance='accepted'),
 accepted_at timestamptz NOT NULL,
 valid_until timestamptz NOT NULL CHECK(isfinite(valid_until) AND valid_until>accepted_at),
 CHECK((kind='regional')=(operating_region_id IS NOT NULL)),
 UNIQUE(id,space_id)
);
CREATE UNIQUE INDEX post_pin_regional_slot ON whaleu_community.post_pin_scopes(operating_region_id) WHERE kind='regional';
CREATE UNIQUE INDEX post_pin_global_slot ON whaleu_community.post_pin_scopes(kind) WHERE kind<>'regional';
CREATE TABLE whaleu_community.post_pin_history (
 scope_id uuid PRIMARY KEY REFERENCES whaleu_community.post_pin_scopes(id),
 coverage text NOT NULL CHECK(coverage IN('accepted_empty','unavailable')),
 source_reference text NOT NULL CHECK(length(btrim(source_reference)) BETWEEN 1 AND 2048),
 accepted_at timestamptz NOT NULL,
 valid_until timestamptz NOT NULL CHECK(isfinite(valid_until) AND valid_until>accepted_at)
);
CREATE TABLE whaleu_community.post_pin_commands (
 session_id uuid NOT NULL REFERENCES whaleu_identity.sessions(id),
 scope_id uuid REFERENCES whaleu_community.post_pin_scopes(id),
 grant_id uuid REFERENCES whaleu_authorization.role_grants(id),
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 request_id uuid NOT NULL,
 intent_hash text NOT NULL CHECK(intent_hash~'^[a-f0-9]{64}$'),
 command jsonb NOT NULL CHECK(jsonb_typeof(command)='object' AND octet_length(command::text)<4096),
 receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt)='object' AND octet_length(receipt::text)<4096),
 transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
 PRIMARY KEY(actor_id,request_id),
 CHECK(intent_hash=encode(sha256(convert_to('whaleu:post-pin:v1'||chr(10)||whaleu_community.content_canonical_json(jsonb_build_object('actor',actor_id::text,'command',command)),'UTF8')),'hex')),
 CHECK((command->>'clientRequestId') IS NOT DISTINCT FROM request_id::text),
 CHECK((receipt->>'requestId') IS NOT DISTINCT FROM request_id::text),
 CHECK((receipt->>'postId') IS NOT DISTINCT FROM(command->>'postId')),
 CHECK((receipt->>'operation') IS NOT DISTINCT FROM(command->>'operation'))
);
CREATE TABLE whaleu_community.post_pins (
 id uuid PRIMARY KEY,
 scope_id uuid NOT NULL REFERENCES whaleu_community.post_pin_scopes(id),
 post_id uuid NOT NULL REFERENCES whaleu_community.posts(id),
 actor_id uuid NOT NULL,
 request_id uuid NOT NULL,
 level smallint NOT NULL CHECK(level IN(1,2)),
 duration_hours smallint NOT NULL CHECK(duration_hours BETWEEN 1 AND 168),
 pinned_at timestamptz NOT NULL,
 pinned_until timestamptz NOT NULL CHECK(isfinite(pinned_until) AND pinned_until=pinned_at+duration_hours*interval '1 hour'),
 provenance text NOT NULL CHECK(provenance='native'),
 transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
 UNIQUE(actor_id,request_id),UNIQUE(scope_id,id),
 FOREIGN KEY(actor_id,request_id) REFERENCES whaleu_community.post_pin_commands(actor_id,request_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE whaleu_community.post_pin_heads (
 scope_id uuid PRIMARY KEY REFERENCES whaleu_community.post_pin_scopes(id),
 pin_id uuid NOT NULL,
 FOREIGN KEY(scope_id,pin_id) REFERENCES whaleu_community.post_pins(scope_id,id)
);
CREATE TABLE whaleu_community.post_pin_closures (
 actor_id uuid,request_id uuid,
 FOREIGN KEY(actor_id,request_id) REFERENCES whaleu_community.post_pin_commands(actor_id,request_id) DEFERRABLE INITIALLY DEFERRED,
 CHECK((reason='deleted' AND actor_id IS NULL AND request_id IS NULL) OR (reason<>'deleted' AND actor_id IS NOT NULL AND request_id IS NOT NULL)),
 pin_id uuid PRIMARY KEY REFERENCES whaleu_community.post_pins(id),
 reason text NOT NULL CHECK(reason IN('renewed','unpin','deleted')),
 closed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE whaleu_community.post_pin_reads (
 request_id uuid NOT NULL,
 FOREIGN KEY(actor_id,request_id) REFERENCES whaleu_community.post_pin_commands(actor_id,request_id) DEFERRABLE INITIALLY DEFERRED,
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 pin_id uuid NOT NULL REFERENCES whaleu_community.post_pins(id),
 read_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(actor_id,pin_id)
);
CREATE FUNCTION whaleu_community.post_pin_immutable() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'Post pin evidence is immutable' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END$$;
DO $$DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['post_pin_scopes','post_pin_history','post_pin_commands','post_pins','post_pin_closures','post_pin_reads'] LOOP
 EXECUTE format('CREATE TRIGGER post_pin_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_community.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.post_pin_immutable()',t);
 END LOOP;
END$$;
CREATE FUNCTION whaleu_community.post_pin_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE s whaleu_community.spaces;BEGIN
 SELECT * INTO s FROM whaleu_community.spaces WHERE id=NEW.space_id FOR SHARE;
 IF s.id IS NULL OR (NEW.kind='regional' AND (s.kind<>'regional' OR s.operating_region_id IS DISTINCT FROM NEW.operating_region_id)) OR (NEW.kind<>'regional' AND (s.kind<>'global' OR s.operating_region_id IS NOT NULL)) THEN RAISE EXCEPTION 'Pin scope needs explicit canonical topology' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 IF NEW.kind='feedback' AND NOT EXISTS(SELECT 1 FROM whaleu_community.feedback_topic WHERE space_id=NEW.space_id AND topic='feedback' AND provenance='accepted') THEN RAISE EXCEPTION 'Feedback pin scope needs accepted feedback topic' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER post_pin_scope_guard BEFORE INSERT ON whaleu_community.post_pin_scopes FOR EACH ROW EXECUTE FUNCTION whaleu_community.post_pin_scope_guard();
CREATE FUNCTION whaleu_community.post_pin_lock(sid uuid) RETURNS void LANGUAGE sql VOLATILE AS $$SELECT pg_advisory_xact_lock(hashtextextended('whaleu:post-pin-slot:v1:'||sid::text,0))$$;
CREATE FUNCTION whaleu_community.post_pin_guard() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE s whaleu_community.post_pin_scopes;p whaleu_community.posts;current_pin whaleu_community.post_pins;BEGIN
 PERFORM whaleu_community.post_pin_lock(NEW.scope_id);
 SELECT * INTO s FROM whaleu_community.post_pin_scopes WHERE id=NEW.scope_id;
 SELECT * INTO p FROM whaleu_community.posts WHERE id=NEW.post_id FOR SHARE;
 IF NOT EXISTS(SELECT 1 FROM whaleu_community.post_pin_history WHERE scope_id=NEW.scope_id AND coverage='accepted_empty' AND accepted_at<=clock_timestamp() AND valid_until>clock_timestamp()) OR s.accepted_at>clock_timestamp() OR s.valid_until<=clock_timestamp() OR NEW.transaction_id<>pg_current_xact_id() OR p.id IS NULL OR p.space_id<>s.space_id OR p.deleted_at IS NOT NULL OR p.visibility<>'approved' OR NEW.pinned_at>clock_timestamp() OR NEW.pinned_until<=clock_timestamp() OR (s.kind='university_city' AND p.category<>'discussion') OR (s.kind='feedback' AND p.category<>'feedback') OR (s.kind='regional' AND p.category='feedback') THEN RAISE EXCEPTION 'Exact current pin post and scope required' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 SELECT pins.* INTO current_pin FROM whaleu_community.post_pin_heads h JOIN whaleu_community.post_pins pins ON pins.id=h.pin_id JOIN whaleu_community.posts posts ON posts.id=pins.post_id WHERE h.scope_id=NEW.scope_id AND pins.pinned_until>clock_timestamp() AND posts.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM whaleu_community.post_pin_closures c WHERE c.pin_id=pins.id);
 IF current_pin.id IS NOT NULL THEN RAISE EXCEPTION 'Previous live pin must be explicitly closed' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER post_pin_guard BEFORE INSERT ON whaleu_community.post_pins FOR EACH ROW EXECUTE FUNCTION whaleu_community.post_pin_guard();
CREATE FUNCTION whaleu_community.post_pin_head_guard() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE p whaleu_community.post_pins;BEGIN
 PERFORM whaleu_community.post_pin_lock(NEW.scope_id);
 SELECT * INTO p FROM whaleu_community.post_pins WHERE id=NEW.pin_id AND scope_id=NEW.scope_id;
 IF p.id IS NULL OR p.transaction_id<>pg_current_xact_id() OR (TG_OP='UPDATE' AND NEW.scope_id<>OLD.scope_id) THEN RAISE EXCEPTION 'Pin head needs new atomic pin' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER post_pin_head_guard BEFORE INSERT OR UPDATE ON whaleu_community.post_pin_heads FOR EACH ROW EXECUTE FUNCTION whaleu_community.post_pin_head_guard();
CREATE TRIGGER post_pin_head_no_delete BEFORE DELETE OR TRUNCATE ON whaleu_community.post_pin_heads FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.post_pin_immutable();
-- Deletion holds only the post row. It never takes a slot lock, so concurrent
-- scope->post pin commands cannot form a post->scope lock-order cycle.
CREATE FUNCTION whaleu_community.post_pin_deleted() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
 INSERT INTO whaleu_community.post_pin_closures(pin_id,reason) SELECT id,'deleted' FROM whaleu_community.post_pins WHERE post_id=NEW.id ON CONFLICT(pin_id) DO NOTHING;
 END IF;RETURN NEW;
END$$;
CREATE TRIGGER post_pin_deleted AFTER UPDATE OF deleted_at ON whaleu_community.posts FOR EACH ROW EXECUTE FUNCTION whaleu_community.post_pin_deleted();
CREATE FUNCTION whaleu_community.post_pin_complete() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE q whaleu_community.post_pin_commands;BEGIN
 SELECT * INTO q FROM whaleu_community.post_pin_commands WHERE actor_id=NEW.actor_id AND request_id=NEW.request_id;
 IF q.request_id IS NULL OR q.transaction_id<>pg_current_xact_id() OR q.command->>'operation'<>'pin' OR q.command->>'postId'<>NEW.post_id::text OR q.receipt->>'outcome'<>'applied' OR q.receipt->>'pinId'<>NEW.id::text OR (q.command->>'durationHours')::integer<>NEW.duration_hours OR (q.command->>'level')::integer<>NEW.level THEN RAISE EXCEPTION 'Pin needs original exact command and receipt' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;RETURN NULL;
END$$;
CREATE CONSTRAINT TRIGGER post_pin_complete AFTER INSERT ON whaleu_community.post_pins DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.post_pin_complete();
CREATE FUNCTION whaleu_community.post_pin_keys(value jsonb,keys text[]) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$SELECT jsonb_typeof(value)='object' AND (SELECT count(*) FROM jsonb_object_keys(value))=cardinality(keys) AND value?&keys$$;
CREATE FUNCTION whaleu_community.post_pin_command_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE instant timestamptz:=clock_timestamp();scope whaleu_community.post_pin_scopes;target whaleu_community.posts;pin whaleu_community.post_pins;operation text:=NEW.command->>'operation';applied boolean:=NEW.receipt->>'outcome'='applied';current_pin uuid;
BEGIN
 IF NEW.transaction_id<>pg_current_xact_id() OR NOT EXISTS(SELECT 1 FROM whaleu_identity.sessions s JOIN whaleu_identity.accounts a ON a.id=s.account_id WHERE s.id=NEW.session_id AND s.account_id=NEW.actor_id AND a.status='active' AND s.revoked_at IS NULL AND s.absolute_expires_at>instant) THEN RAISE EXCEPTION 'Current actor session required for pin command' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 IF operation IS NULL OR operation NOT IN('pin','unpin','read') OR NOT whaleu_community.post_pin_keys(NEW.command,CASE WHEN operation='pin' THEN ARRAY['clientRequestId','operation','postId','durationHours','level'] ELSE ARRAY['clientRequestId','operation','postId','pinId'] END) OR NOT whaleu_community.post_pin_keys(NEW.receipt,CASE WHEN applied THEN ARRAY['requestId','operation','postId','outcome','pinId','recordedAt'] ELSE ARRAY['requestId','operation','postId','outcome','code'] END) THEN RAISE EXCEPTION 'Exact pin intent and receipt required' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 IF NEW.receipt->>'outcome'='rejected' AND NEW.receipt->>'code'='POST_PIN_CANCELLED' AND NOT applied THEN
  IF NEW.scope_id IS NOT NULL OR NEW.grant_id IS NOT NULL OR EXISTS(SELECT 1 FROM whaleu_community.post_pins WHERE actor_id=NEW.actor_id AND request_id=NEW.request_id) OR EXISTS(SELECT 1 FROM whaleu_community.post_pin_closures WHERE actor_id=NEW.actor_id AND request_id=NEW.request_id) OR EXISTS(SELECT 1 FROM whaleu_community.post_pin_reads WHERE actor_id=NEW.actor_id AND request_id=NEW.request_id) THEN RAISE EXCEPTION 'Cancelled pin request cannot mutate' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
  RETURN NULL;
 END IF;
 SELECT * INTO scope FROM whaleu_community.post_pin_scopes WHERE id=NEW.scope_id;
 IF scope.id IS NULL OR scope.accepted_at>instant OR scope.valid_until<=instant OR NOT EXISTS(SELECT 1 FROM whaleu_community.post_pin_history h WHERE h.scope_id=scope.id AND h.coverage='accepted_empty' AND h.accepted_at<=instant AND h.valid_until>instant) OR NOT EXISTS(SELECT 1 FROM whaleu_community.spaces s WHERE s.id=scope.space_id AND s.is_active AND ((scope.kind='regional' AND s.kind='regional' AND s.operating_region_id=scope.operating_region_id AND EXISTS(SELECT 1 FROM whaleu_campus.operating_regions r WHERE r.id=scope.operating_region_id AND r.is_active)) OR(scope.kind<>'regional' AND s.kind='global' AND s.operating_region_id IS NULL))) THEN RAISE EXCEPTION 'Current accepted pin scope and independent history required' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 IF operation<>'read' AND NOT EXISTS(SELECT 1 FROM whaleu_authorization.role_grants g WHERE g.id=NEW.grant_id AND g.account_id=NEW.actor_id AND g.revoked_at IS NULL AND g.valid_from<=instant AND (g.expires_at IS NULL OR g.expires_at>instant) AND ((g.role IN('developer','super_admin') AND g.operating_region_id IS NULL) OR(g.role='school_admin' AND scope.kind='regional' AND g.operating_region_id=scope.operating_region_id))) THEN RAISE EXCEPTION 'Exact current scoped pin grant required' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 SELECT * INTO target FROM whaleu_community.posts WHERE id=(NEW.command->>'postId')::uuid;
 IF target.id IS NULL THEN RAISE EXCEPTION 'Pin command target required' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 SELECT p.id INTO current_pin FROM whaleu_community.post_pin_heads h JOIN whaleu_community.post_pins p ON p.id=h.pin_id JOIN whaleu_community.posts post ON post.id=p.post_id WHERE h.scope_id=scope.id AND p.pinned_until>instant AND post.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM whaleu_community.post_pin_closures c WHERE c.pin_id=p.id);
 IF NOT applied THEN
  IF EXISTS(SELECT 1 FROM whaleu_community.post_pins WHERE actor_id=NEW.actor_id AND request_id=NEW.request_id) OR EXISTS(SELECT 1 FROM whaleu_community.post_pin_closures WHERE actor_id=NEW.actor_id AND request_id=NEW.request_id) OR EXISTS(SELECT 1 FROM whaleu_community.post_pin_reads WHERE actor_id=NEW.actor_id AND request_id=NEW.request_id) THEN RAISE EXCEPTION 'Rejected pin command cannot mutate' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
  IF NEW.receipt->>'code'='POST_PIN_CONFLICT' AND operation='pin' AND EXISTS(SELECT 1 FROM whaleu_community.post_pins WHERE id=current_pin AND post_id<>target.id) THEN RETURN NULL;END IF;
  IF NEW.receipt->>'code'='POST_PIN_STALE' AND operation IN('read','unpin') AND NOT EXISTS(SELECT 1 FROM whaleu_community.post_pins WHERE id=current_pin AND id=(NEW.command->>'pinId')::uuid AND post_id=target.id) THEN RETURN NULL;END IF;
  RAISE EXCEPTION 'Pin rejection must be causal' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';
 END IF;
 SELECT * INTO pin FROM whaleu_community.post_pins WHERE id=(NEW.receipt->>'pinId')::uuid;
 IF pin.id IS NULL OR pin.scope_id<>scope.id OR pin.post_id<>target.id THEN RAISE EXCEPTION 'Exact pin receipt target required' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 IF operation='pin' THEN
  IF (NEW.receipt->>'recordedAt')::timestamptz IS DISTINCT FROM date_trunc('milliseconds',pin.pinned_at) OR pin.actor_id<>NEW.actor_id OR pin.request_id<>NEW.request_id OR pin.id IS DISTINCT FROM current_pin THEN RAISE EXCEPTION 'Pin receipt needs atomic current identity' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 ELSIF pin.id::text IS DISTINCT FROM NEW.command->>'pinId' THEN RAISE EXCEPTION 'Exact original pin required' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';
 ELSIF operation='unpin' THEN
  IF NOT EXISTS(SELECT 1 FROM whaleu_community.post_pin_closures WHERE pin_id=pin.id AND reason='unpin' AND actor_id=NEW.actor_id AND request_id=NEW.request_id AND date_trunc('milliseconds',closed_at)=(NEW.receipt->>'recordedAt')::timestamptz) THEN RAISE EXCEPTION 'Unpin receipt needs exact atomic closure' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 ELSE
  IF pin.id IS DISTINCT FROM current_pin OR target.visibility<>'approved' OR target.deleted_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM whaleu_community.post_pin_reads WHERE actor_id=NEW.actor_id AND pin_id=pin.id AND date_trunc('milliseconds',read_at)=(NEW.receipt->>'recordedAt')::timestamptz) THEN RAISE EXCEPTION 'Read receipt needs visible current exact pin marker' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 END IF;
 RETURN NULL;
END$$;
CREATE CONSTRAINT TRIGGER post_pin_command_complete AFTER INSERT ON whaleu_community.post_pin_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.post_pin_command_complete();
CREATE FUNCTION whaleu_community.post_pin_close_guard() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE sid uuid;BEGIN
 IF NEW.reason='deleted' THEN
  IF NOT EXISTS(SELECT 1 FROM whaleu_community.post_pins p JOIN whaleu_community.posts post ON post.id=p.post_id WHERE p.id=NEW.pin_id AND post.deleted_at IS NOT NULL) THEN RAISE EXCEPTION 'Deletion closure requires canonical tombstone' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 ELSE
  SELECT scope_id INTO sid FROM whaleu_community.post_pins WHERE id=NEW.pin_id;PERFORM whaleu_community.post_pin_lock(sid);
  IF NOT EXISTS(SELECT 1 FROM whaleu_community.post_pins p JOIN whaleu_community.post_pin_heads h ON h.pin_id=p.id AND h.scope_id=p.scope_id JOIN whaleu_community.posts post ON post.id=p.post_id WHERE p.id=NEW.pin_id AND NEW.closed_at>=p.pinned_at AND NEW.closed_at<=clock_timestamp() AND p.pinned_until>clock_timestamp() AND post.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM whaleu_community.post_pin_closures c WHERE c.pin_id=p.id) FOR SHARE OF post) THEN RAISE EXCEPTION 'Closure requires the exact active scope head' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 END IF;RETURN NEW;
END$$;
CREATE TRIGGER post_pin_close_guard BEFORE INSERT ON whaleu_community.post_pin_closures FOR EACH ROW EXECUTE FUNCTION whaleu_community.post_pin_close_guard();
CREATE FUNCTION whaleu_community.post_pin_marker_complete() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE q whaleu_community.post_pin_commands;p whaleu_community.post_pins;BEGIN
 IF TG_TABLE_NAME='post_pin_closures' AND NEW.actor_id IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO q FROM whaleu_community.post_pin_commands WHERE actor_id=NEW.actor_id AND request_id=NEW.request_id;
 SELECT * INTO p FROM whaleu_community.post_pins WHERE id=NEW.pin_id;
 IF q.request_id IS NULL OR q.transaction_id<>pg_current_xact_id() OR p.id IS NULL OR p.post_id::text IS DISTINCT FROM q.command->>'postId' OR q.scope_id IS DISTINCT FROM p.scope_id OR q.receipt->>'outcome'<>'applied' THEN RAISE EXCEPTION 'Pin marker needs same-transaction exact owner command' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 IF TG_TABLE_NAME='post_pin_reads' THEN
  IF q.command->>'operation'<>'read' OR q.command->>'pinId' IS DISTINCT FROM NEW.pin_id::text OR q.receipt->>'pinId' IS DISTINCT FROM NEW.pin_id::text THEN RAISE EXCEPTION 'Read marker needs exact pin read command' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 ELSE
  IF (NEW.reason='unpin' AND(q.command->>'operation'<>'unpin' OR q.command->>'pinId' IS DISTINCT FROM NEW.pin_id::text OR q.receipt->>'pinId' IS DISTINCT FROM NEW.pin_id::text)) OR (NEW.reason='renewed' AND(q.command->>'operation'<>'pin' OR NOT EXISTS(SELECT 1 FROM whaleu_community.post_pins WHERE id=(q.receipt->>'pinId')::uuid AND actor_id=NEW.actor_id AND request_id=NEW.request_id AND scope_id=p.scope_id AND post_id=p.post_id))) THEN RAISE EXCEPTION 'Closure needs exact unpin or same-post renewal' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 END IF;RETURN NULL;
END$$;
CREATE CONSTRAINT TRIGGER post_pin_read_complete AFTER INSERT ON whaleu_community.post_pin_reads DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.post_pin_marker_complete();
CREATE CONSTRAINT TRIGGER post_pin_close_complete AFTER INSERT ON whaleu_community.post_pin_closures DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.post_pin_marker_complete();
ALTER TABLE whaleu_community.post_pin_commands ADD CONSTRAINT post_pin_json_types CHECK(
 jsonb_typeof(command->'clientRequestId')='string' AND jsonb_typeof(command->'postId')='string'
 AND jsonb_typeof(command->'operation')='string' AND command->>'operation' IN('pin','unpin','read')
 AND ((command->>'operation'='pin' AND jsonb_typeof(command->'durationHours')='number' AND (command->>'durationHours')::numeric BETWEEN 1 AND 168 AND (command->>'durationHours')::numeric=trunc((command->>'durationHours')::numeric) AND jsonb_typeof(command->'level')='number' AND (command->>'level')::numeric IN(1,2)) OR (command->>'operation' IN('read','unpin') AND jsonb_typeof(command->'pinId')='string'))
 AND jsonb_typeof(receipt->'requestId')='string' AND jsonb_typeof(receipt->'postId')='string' AND jsonb_typeof(receipt->'operation')='string'
 AND ((receipt->>'outcome'='applied' AND jsonb_typeof(receipt->'pinId')='string' AND jsonb_typeof(receipt->'recordedAt')='string') OR(receipt->>'outcome'='rejected' AND receipt->>'code' IN('POST_PIN_CONFLICT','POST_PIN_STALE','POST_PIN_CANCELLED')))
);
-- Raw sanctioned marker writes use the same scope->post serialization as HTTP.
-- Deletion is the sole exception: it already owns the post and never takes scope.
CREATE FUNCTION whaleu_community.post_pin_read_guard() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE sid uuid;BEGIN
 SELECT scope_id INTO sid FROM whaleu_community.post_pins WHERE id=NEW.pin_id;PERFORM whaleu_community.post_pin_lock(sid);
 IF NOT EXISTS(SELECT 1 FROM whaleu_community.post_pins p JOIN whaleu_community.post_pin_heads h ON h.pin_id=p.id AND h.scope_id=p.scope_id JOIN whaleu_community.posts post ON post.id=p.post_id WHERE p.id=NEW.pin_id AND NEW.read_at>=p.pinned_at AND NEW.read_at<=clock_timestamp() AND NEW.read_at<p.pinned_until AND p.pinned_until>clock_timestamp() AND post.deleted_at IS NULL AND post.visibility='approved' AND NOT EXISTS(SELECT 1 FROM whaleu_community.post_pin_closures c WHERE c.pin_id=p.id) FOR SHARE OF post) THEN RAISE EXCEPTION 'Read marker requires exact visible active pin' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER post_pin_read_guard BEFORE INSERT ON whaleu_community.post_pin_reads FOR EACH ROW EXECUTE FUNCTION whaleu_community.post_pin_read_guard();
