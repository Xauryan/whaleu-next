-- Empty administrative command infrastructure. Existing E1 digests and receipt
-- JSON are untouched; no role, baseline, sanction or deletion is seeded.
ALTER TABLE whaleu_errands.orders ADD deletion_reason text CHECK(deletion_reason IS NULL OR length(deletion_reason)<=500);
ALTER TABLE whaleu_errands.orders ADD admin_delete_event_id uuid;
ALTER TABLE whaleu_errands.orders ADD CHECK((deletion_reason IS NULL)=(admin_delete_event_id IS NULL));
ALTER TABLE whaleu_errands.orders ADD CHECK(admin_delete_event_id IS NULL OR deleted_at IS NOT NULL);
ALTER TABLE whaleu_errands.requests DROP CONSTRAINT requests_operation_check;
ALTER TABLE whaleu_errands.requests ADD CHECK(operation IN ('publish','accept','cancel','complete','delete','admin_delete','restrict_accepter'));
ALTER TABLE whaleu_errands.requests ADD admin_creation_transaction xid8;
ALTER TABLE whaleu_errands.requests ADD CHECK((operation IN ('admin_delete','restrict_accepter'))=(admin_creation_transaction IS NOT NULL));
ALTER TABLE whaleu_errands.transitions DROP CONSTRAINT transitions_operation_check;
ALTER TABLE whaleu_errands.transitions ADD CHECK(operation IN ('publish','accept','cancel','complete','delete','admin_delete'));
CREATE TABLE whaleu_errands.admin_request_contexts (
 actor_id uuid NOT NULL,request_id uuid NOT NULL,
 order_id uuid NOT NULL REFERENCES whaleu_errands.orders(id),
 target_region_id uuid NOT NULL REFERENCES whaleu_campus.operating_regions(id),
 grant_id uuid NOT NULL REFERENCES whaleu_authorization.role_grants(id),session_id uuid NOT NULL,
 operation text NOT NULL CHECK(operation IN ('admin_delete','restrict_accepter')),
 expected_revision uuid NOT NULL,intent jsonb NOT NULL CHECK(jsonb_typeof(intent)='object'),
 restriction_requested boolean NOT NULL,
 creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 PRIMARY KEY(actor_id,request_id),
 FOREIGN KEY(actor_id,request_id) REFERENCES whaleu_errands.requests(account_id,request_id)
);
CREATE TABLE whaleu_errands.admin_events (
 id uuid PRIMARY KEY,actor_id uuid NOT NULL,request_id uuid NOT NULL,
 order_id uuid NOT NULL REFERENCES whaleu_errands.orders(id),
 operation text NOT NULL CHECK(operation IN ('admin_delete','restrict_accepter')),
 subject_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 observed_revision uuid NOT NULL,result_revision uuid NOT NULL,
 observed_state text NOT NULL CHECK(observed_state IN ('pending','accepted','completed','cancelled')),
 observed_accepter_id uuid REFERENCES whaleu_identity.accounts(id),
 delete_reason text CHECK(delete_reason IS NULL OR length(delete_reason)<=500),
 safety_event_id uuid REFERENCES whaleu_safety.errand_restriction_events(id),
 occurred_at timestamptz NOT NULL CHECK(isfinite(occurred_at)),
 creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 UNIQUE(actor_id,request_id),
 FOREIGN KEY(actor_id,request_id) REFERENCES whaleu_errands.admin_request_contexts(actor_id,request_id),
 CHECK((operation='admin_delete')=(delete_reason IS NOT NULL)),
 CHECK((operation='admin_delete')=(observed_revision<>result_revision)),
 CHECK(operation<>'restrict_accepter' OR safety_event_id IS NOT NULL)
);
ALTER TABLE whaleu_errands.orders ADD FOREIGN KEY(admin_delete_event_id) REFERENCES whaleu_errands.admin_events(id) DEFERRABLE INITIALLY DEFERRED;
CREATE TRIGGER errand_admin_context_immutable BEFORE UPDATE OR DELETE ON whaleu_errands.admin_request_contexts FOR EACH ROW EXECUTE FUNCTION whaleu_errands.immutable_row();
CREATE TRIGGER errand_admin_event_immutable BEFORE UPDATE OR DELETE ON whaleu_errands.admin_events FOR EACH ROW EXECUTE FUNCTION whaleu_errands.immutable_row();
CREATE FUNCTION whaleu_errands.validate_admin_context() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request whaleu_errands.requests; target uuid; body jsonb;
BEGIN
 SELECT * INTO request FROM whaleu_errands.requests WHERE account_id=NEW.actor_id AND request_id=NEW.request_id;
 SELECT target_region_id INTO target FROM whaleu_errands.orders WHERE id=NEW.order_id;
 body:=NEW.intent->'command';
 IF NOT (NEW.intent ?& ARRAY['orderId','command']) OR (SELECT count(*) FROM jsonb_object_keys(NEW.intent))<>2 OR jsonb_typeof(body) IS DISTINCT FROM 'object' OR
  (NEW.operation='admin_delete' AND (NOT (body ?& ARRAY['clientRequestId','expectedRevision','deleteReason','publisherRestriction']) OR (SELECT count(*) FROM jsonb_object_keys(body))<>4 OR jsonb_typeof(body->'deleteReason') IS DISTINCT FROM 'string')) OR
  (NEW.operation='restrict_accepter' AND (NOT (body ?& ARRAY['clientRequestId','expectedRevision','reason','duration']) OR (SELECT count(*) FROM jsonb_object_keys(body))<>4 OR jsonb_typeof(body->'reason') IS DISTINCT FROM 'string')) THEN
  RAISE EXCEPTION 'Administrative intent shape is invalid' USING ERRCODE='23514'; END IF;
 IF request.operation IS DISTINCT FROM NEW.operation OR target IS DISTINCT FROM NEW.target_region_id OR
   NEW.creation_transaction<>pg_current_xact_id() OR request.admin_creation_transaction IS DISTINCT FROM NEW.creation_transaction OR
   NEW.intent->>'orderId' IS DISTINCT FROM NEW.order_id::text OR body->>'clientRequestId' IS DISTINCT FROM NEW.request_id::text OR
   body->>'expectedRevision' IS DISTINCT FROM NEW.expected_revision::text OR
   NEW.restriction_requested IS DISTINCT FROM (NEW.operation='restrict_accepter' OR body->'publisherRestriction' IS DISTINCT FROM 'null'::jsonb) OR
   request.intent_hash IS DISTINCT FROM encode(sha256(convert_to('whaleu:errand-admin-command:v1'||chr(10)||whaleu_community.content_canonical_json(jsonb_build_object('operation',NEW.operation,'intent',NEW.intent)),'UTF8')),'hex') THEN
   RAISE EXCEPTION 'Administrative request context lacks exact command cause' USING ERRCODE='23514';
 END IF;
 PERFORM whaleu_authorization.require_errand_management_authority(NEW.actor_id,NEW.session_id,NEW.grant_id,NEW.target_region_id);
 RETURN NEW;
END $$;
CREATE TRIGGER errand_admin_context_causal BEFORE INSERT ON whaleu_errands.admin_request_contexts FOR EACH ROW EXECUTE FUNCTION whaleu_errands.validate_admin_context();
CREATE FUNCTION whaleu_errands.validate_admin_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE context whaleu_errands.admin_request_contexts; target whaleu_errands.orders;
BEGIN
 SELECT * INTO context FROM whaleu_errands.admin_request_contexts WHERE actor_id=NEW.actor_id AND request_id=NEW.request_id;
 SELECT * INTO target FROM whaleu_errands.orders WHERE id=NEW.order_id FOR UPDATE;
 IF context.order_id IS DISTINCT FROM NEW.order_id OR context.operation IS DISTINCT FROM NEW.operation OR
   context.creation_transaction IS DISTINCT FROM pg_current_xact_id() OR NEW.creation_transaction<>pg_current_xact_id() OR
   target.id IS NULL OR target.deleted_at IS NOT NULL OR target.revision<>context.expected_revision OR
   ROW(target.revision,target.state,target.accepter_id) IS DISTINCT FROM ROW(NEW.observed_revision,NEW.observed_state,NEW.observed_accepter_id) OR
   context.restriction_requested IS DISTINCT FROM (NEW.safety_event_id IS NOT NULL) OR
   NEW.occurred_at<transaction_timestamp() OR NEW.occurred_at>clock_timestamp() THEN
   RAISE EXCEPTION 'Administrative event lacks exact locked order cause' USING ERRCODE='23514';
 END IF;
 PERFORM whaleu_authorization.require_errand_management_authority(NEW.actor_id,context.session_id,context.grant_id,context.target_region_id);
 IF NEW.operation='admin_delete' THEN
   IF NEW.actor_id=target.publisher_id OR NEW.subject_id<>target.publisher_id OR
     NEW.delete_reason IS DISTINCT FROM context.intent->'command'->>'deleteReason' OR
     (NEW.safety_event_id IS NOT NULL AND length(btrim(NEW.delete_reason)) NOT BETWEEN 1 AND 255) THEN
     RAISE EXCEPTION 'Invalid administrative publisher deletion' USING ERRCODE='23514'; END IF;
 ELSE
   IF target.state NOT IN ('accepted','completed') OR target.accepter_id IS NULL OR NEW.subject_id<>target.accepter_id THEN
     RAISE EXCEPTION 'Invalid administrative accepter restriction' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER errand_admin_event_causal BEFORE INSERT ON whaleu_errands.admin_events FOR EACH ROW EXECUTE FUNCTION whaleu_errands.validate_admin_event();
CREATE FUNCTION whaleu_errands.require_admin_effects() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target whaleu_errands.orders; context whaleu_errands.admin_request_contexts; request whaleu_errands.requests;
BEGIN
 SELECT * INTO target FROM whaleu_errands.orders WHERE id=NEW.order_id;
 SELECT * INTO context FROM whaleu_errands.admin_request_contexts WHERE actor_id=NEW.actor_id AND request_id=NEW.request_id;
 SELECT * INTO request FROM whaleu_errands.requests WHERE account_id=NEW.actor_id AND request_id=NEW.request_id;
 IF request.receipt->>'outcome' IS DISTINCT FROM 'applied' OR target.revision<>NEW.result_revision OR
   ROW(target.state,target.accepter_id) IS DISTINCT FROM ROW(NEW.observed_state,NEW.observed_accepter_id) THEN
   RAISE EXCEPTION 'Administrative effects must match terminal receipt and order' USING ERRCODE='23514'; END IF;
 IF NEW.operation='admin_delete' THEN
   IF target.admin_delete_event_id IS DISTINCT FROM NEW.id OR target.deleted_by IS DISTINCT FROM NEW.actor_id OR
     target.deleted_at IS DISTINCT FROM NEW.occurred_at OR target.deletion_reason IS DISTINCT FROM NEW.delete_reason OR
     NOT EXISTS(SELECT 1 FROM whaleu_errands.transitions t WHERE t.order_id=NEW.order_id AND t.actor_id=NEW.actor_id AND t.request_id=NEW.request_id AND t.operation='admin_delete' AND t.revision=NEW.result_revision AND t.occurred_at=NEW.occurred_at) THEN
     RAISE EXCEPTION 'Administrative deletion effects are incomplete' USING ERRCODE='23514'; END IF;
 ELSE
   IF target.deleted_at IS NOT NULL OR EXISTS(SELECT 1 FROM whaleu_errands.transitions t WHERE t.actor_id=NEW.actor_id AND t.request_id=NEW.request_id) THEN
     RAISE EXCEPTION 'Accepter restriction must not change lifecycle' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.safety_event_id IS NOT NULL AND NOT EXISTS(
   SELECT 1 FROM whaleu_safety.errand_restriction_events e
   JOIN whaleu_safety.errand_restriction_definitions d ON d.id=e.restriction_id
   JOIN whaleu_safety.errand_restriction_commands c ON c.id=e.command_id
   WHERE e.id=NEW.safety_event_id AND e.kind='issued' AND d.subject_id=NEW.subject_id AND d.action='all'
     AND d.reason=CASE NEW.operation WHEN 'admin_delete' THEN NEW.delete_reason ELSE context.intent->'command'->>'reason' END
     AND d.ends_at IS NOT DISTINCT FROM whaleu_safety.errand_restriction_end(d.starts_at,CASE NEW.operation WHEN 'admin_delete' THEN context.intent->'command'->'publisherRestriction' ELSE context.intent->'command'->'duration' END)
     AND c.actor_id=NEW.actor_id AND c.request_id=NEW.request_id AND c.kind='order' AND c.operation=NEW.operation
     AND c.order_id=NEW.order_id AND c.target_region_id=context.target_region_id
     AND c.grant_id=context.grant_id AND c.session_id=context.session_id
 ) THEN RAISE EXCEPTION 'Administrative restriction lacks exact Safety cause' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER errand_admin_effects_required AFTER INSERT ON whaleu_errands.admin_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_errands.require_admin_effects();
CREATE OR REPLACE FUNCTION whaleu_errands.legal_order_edge() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Errand orders require soft deletion'; END IF;
 IF NEW.publication_transaction<>OLD.publication_transaction OR NEW.revision=OLD.revision THEN RAISE EXCEPTION 'Invalid errand revision'; END IF;
 IF NEW.deleted_at IS NOT NULL THEN
  IF ROW(NEW.state,NEW.accepter_id,NEW.accepted_at,NEW.completed_at,NEW.cancelled_at) IS DISTINCT FROM ROW(OLD.state,OLD.accepter_id,OLD.accepted_at,OLD.completed_at,OLD.cancelled_at)  THEN RAISE EXCEPTION 'Invalid tombstone lifecycle'; END IF;
  IF NEW.deleted_by=OLD.publisher_id THEN
   IF NEW.deletion_reason IS NOT NULL OR NEW.admin_delete_event_id IS NOT NULL THEN RAISE EXCEPTION 'Owner deletion cannot carry administrative metadata'; END IF;
  ELSIF NOT EXISTS(SELECT 1 FROM whaleu_errands.admin_events e WHERE e.id=NEW.admin_delete_event_id AND e.creation_transaction=pg_current_xact_id() AND e.operation='admin_delete' AND e.order_id=OLD.id AND e.actor_id=NEW.deleted_by AND e.subject_id=OLD.publisher_id AND e.observed_revision=OLD.revision AND e.result_revision=NEW.revision AND e.delete_reason=NEW.deletion_reason AND e.occurred_at=NEW.deleted_at) THEN RAISE EXCEPTION 'Exact administrative deletion cause required'; END IF;
 ELSIF NEW.deletion_reason IS NOT NULL OR NEW.admin_delete_event_id IS NOT NULL THEN RAISE EXCEPTION 'Lifecycle cannot carry administrative deletion metadata';
 ELSIF OLD.state='pending' AND NEW.state='accepted' THEN
  IF NEW.accepter_id IS NULL OR NEW.accepted_at IS NULL THEN RAISE EXCEPTION 'Invalid acceptance'; END IF;
 ELSIF (OLD.state IN ('pending','accepted') AND NEW.state='cancelled') OR (OLD.state='accepted' AND NEW.state='completed') THEN
  IF ROW(NEW.accepter_id,NEW.accepted_at) IS DISTINCT FROM ROW(OLD.accepter_id,OLD.accepted_at) THEN RAISE EXCEPTION 'Participant relationship is immutable'; END IF;
 ELSE RAISE EXCEPTION 'Illegal errand transition';
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION whaleu_errands.require_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event whaleu_errands.transitions; expected_operation text; expected_actor uuid; definition jsonb; binding jsonb;
BEGIN
 expected_operation:=CASE WHEN TG_OP='INSERT' THEN 'publish' WHEN NEW.admin_delete_event_id IS NOT NULL THEN 'admin_delete' WHEN NEW.deleted_at IS NOT NULL THEN 'delete' WHEN NEW.state='accepted' THEN 'accept' WHEN NEW.state='completed' THEN 'complete' ELSE 'cancel' END;
 expected_actor:=CASE WHEN expected_operation='accept' THEN NEW.accepter_id WHEN expected_operation='admin_delete' THEN NEW.deleted_by ELSE NEW.publisher_id END;
 SELECT * INTO event FROM whaleu_errands.transitions WHERE order_id=NEW.id AND revision=NEW.revision;
 IF NOT FOUND OR event.operation<>expected_operation OR event.actor_id<>expected_actor OR event.next_state<>NEW.state OR (TG_OP='INSERT' AND (event.prior_state IS NOT NULL OR NEW.state<>'pending')) OR (TG_OP='UPDATE' AND event.prior_state IS DISTINCT FROM OLD.state) THEN RAISE EXCEPTION 'Errand transition evidence required'; END IF;
 IF TG_OP='INSERT' THEN
  SELECT jsonb_build_object('version',1,'accountId',NEW.publisher_id::text,'purpose','publish_errand','title',NEW.title,'publicText',NEW.public_text,'privateText',p.private_text,'expectedTimeText',NEW.expected_time_text,'reward',NEW.reward::text,'publisherContacts',p.publisher_contacts,'publicAssetIds','[]'::jsonb,'privateAssetIds','[]'::jsonb,'scope',NEW.scope) INTO definition FROM whaleu_errands.private_details p WHERE p.order_id=NEW.id;
  SELECT envelope INTO binding FROM whaleu_community.errand_approval_bindings WHERE order_id=NEW.id;
  IF definition IS NULL OR binding IS DISTINCT FROM definition OR NEW.publication_transaction<>pg_current_xact_id() THEN RAISE EXCEPTION 'Exact errand publication binding required'; END IF;
 END IF;
 RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION whaleu_errands.freeze_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Errand receipts are immutable'; END IF;
 IF ROW(NEW.account_id,NEW.request_id,NEW.operation,NEW.intent_hash,NEW.admin_creation_transaction) IS DISTINCT FROM ROW(OLD.account_id,OLD.request_id,OLD.operation,OLD.intent_hash,OLD.admin_creation_transaction) OR OLD.receipt IS NOT NULL OR NEW.receipt IS NULL THEN RAISE EXCEPTION 'Errand terminal receipt is immutable'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION whaleu_errands.validate_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_order whaleu_errands.orders;
BEGIN
 SELECT * INTO current_order FROM whaleu_errands.orders WHERE id=NEW.order_id FOR SHARE;
 IF current_order.id IS NULL OR current_order.revision<>NEW.revision OR current_order.state<>NEW.next_state THEN RAISE EXCEPTION 'Errand transition must match current order revision and state'; END IF;
 IF NEW.operation='publish' THEN
  IF NEW.actor_id<>current_order.publisher_id OR NEW.prior_state IS NOT NULL OR NEW.next_state<>'pending' OR current_order.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'Invalid publish transition'; END IF;
 ELSIF NEW.operation='accept' THEN
  IF NEW.actor_id IS DISTINCT FROM current_order.accepter_id OR NEW.prior_state IS DISTINCT FROM 'pending' OR NEW.next_state<>'accepted' OR current_order.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'Invalid accept transition'; END IF;
 ELSIF NEW.operation='complete' THEN
  IF NEW.actor_id<>current_order.publisher_id OR NEW.prior_state IS DISTINCT FROM 'accepted' OR NEW.next_state<>'completed' OR current_order.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'Invalid complete transition'; END IF;
 ELSIF NEW.operation='cancel' THEN
  IF NEW.actor_id<>current_order.publisher_id OR coalesce(NEW.prior_state,'') NOT IN ('pending','accepted') OR NEW.next_state<>'cancelled' OR current_order.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'Invalid cancel transition'; END IF;
 ELSIF NEW.operation='admin_delete' THEN
  IF NEW.actor_id IS DISTINCT FROM current_order.deleted_by OR NEW.prior_state IS DISTINCT FROM NEW.next_state OR NOT EXISTS(SELECT 1 FROM whaleu_errands.admin_events e WHERE e.id=current_order.admin_delete_event_id AND e.actor_id=NEW.actor_id AND e.request_id=NEW.request_id AND e.result_revision=NEW.revision AND e.occurred_at=NEW.occurred_at AND e.creation_transaction=pg_current_xact_id()) THEN RAISE EXCEPTION 'Invalid administrative delete transition'; END IF;
 ELSE
  IF NEW.actor_id<>current_order.publisher_id OR NEW.prior_state IS DISTINCT FROM NEW.next_state OR current_order.deleted_at IS NULL THEN RAISE EXCEPTION 'Invalid delete transition'; END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION whaleu_errands.require_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE receipt jsonb; key_count integer;
BEGIN
 SELECT r.receipt INTO receipt FROM whaleu_errands.requests r WHERE r.account_id=NEW.account_id AND r.request_id=NEW.request_id;
 IF receipt IS NULL OR receipt->>'requestId' IS DISTINCT FROM NEW.request_id::text OR receipt->>'operation' IS DISTINCT FROM NEW.operation OR coalesce(receipt->>'outcome','') NOT IN ('applied','rejected') THEN RAISE EXCEPTION 'Terminal errand receipt required'; END IF;
 SELECT count(*) INTO key_count FROM jsonb_object_keys(receipt);
 IF NEW.operation IN ('admin_delete','restrict_accepter') THEN
  IF NOT EXISTS(SELECT 1 FROM whaleu_errands.admin_request_contexts c WHERE c.actor_id=NEW.account_id AND c.request_id=NEW.request_id AND c.operation=NEW.operation AND c.creation_transaction=NEW.admin_creation_transaction) THEN RAISE EXCEPTION 'Administrative receipt context required'; END IF;
  IF receipt->>'outcome'='applied' THEN
   IF key_count<>6 OR NOT EXISTS(SELECT 1 FROM whaleu_errands.admin_events e WHERE e.actor_id=NEW.account_id AND e.request_id=NEW.request_id AND e.operation=NEW.operation AND e.order_id=(receipt->>'orderId')::uuid AND e.result_revision=(receipt->>'revision')::uuid AND e.occurred_at=(receipt->>'occurredAt')::timestamptz) THEN RAISE EXCEPTION 'Applied administrative receipt requires exact event'; END IF;
  ELSE
   IF key_count<>4 OR coalesce(receipt->>'code','') NOT IN ('ERRAND_REVISION_CONFLICT','ERRAND_STATE_CONFLICT','ERRAND_USE_OWNER_COMMAND','ERRAND_RESTRICTION_TARGET_PROTECTED') OR EXISTS(SELECT 1 FROM whaleu_errands.admin_events e WHERE e.actor_id=NEW.account_id AND e.request_id=NEW.request_id) OR EXISTS(SELECT 1 FROM whaleu_safety.errand_restriction_commands c WHERE c.kind='order' AND c.actor_id=NEW.account_id AND c.request_id=NEW.request_id) THEN RAISE EXCEPTION 'Rejected administrative request must have no effects'; END IF;
  END IF;
  RETURN NULL;
 END IF;
 IF receipt->>'outcome'='applied' THEN
  IF key_count<>6 OR NOT EXISTS(SELECT 1 FROM whaleu_errands.transitions t WHERE t.actor_id=NEW.account_id AND t.request_id=NEW.request_id AND t.operation=NEW.operation AND t.order_id=(receipt->>'orderId')::uuid AND t.revision=(receipt->>'revision')::uuid AND t.occurred_at=(receipt->>'occurredAt')::timestamptz) THEN RAISE EXCEPTION 'Applied errand receipt requires exact transition'; END IF;
 ELSE
  IF key_count<>4 OR coalesce(receipt->>'code','') NOT IN ('ERRAND_NOT_FOUND','ERRAND_REVISION_CONFLICT','ERRAND_STATE_CONFLICT','ERRAND_ACTION_RESTRICTED','ERRAND_SELF_ACCEPT','PHONE_VERIFICATION_REQUIRED','AFFILIATION_VERIFICATION_REQUIRED','IDENTITY_CAMPUS_REQUIRED','SAFETY_ACTION_RESTRICTED','CONTENT_REJECTED') OR EXISTS(SELECT 1 FROM whaleu_errands.transitions t WHERE t.actor_id=NEW.account_id AND t.request_id=NEW.request_id) THEN RAISE EXCEPTION 'Invalid rejected errand receipt'; END IF;
 END IF;
 RETURN NULL;
END $$;
-- Row immutability does not cover TRUNCATE, including a cascading caller.
CREATE TRIGGER errand_admin_context_no_truncate BEFORE TRUNCATE ON whaleu_errands.admin_request_contexts FOR EACH STATEMENT EXECUTE FUNCTION whaleu_errands.immutable_row();
CREATE TRIGGER errand_admin_event_no_truncate BEFORE TRUNCATE ON whaleu_errands.admin_events FOR EACH STATEMENT EXECUTE FUNCTION whaleu_errands.immutable_row();
-- A Safety command is not permitted to reuse a retained rejected scoped request
-- in a later transaction; this trigger runs for the new command itself.
CREATE FUNCTION whaleu_errands.require_scoped_restriction_cause() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.kind='order' AND NOT EXISTS(
  SELECT 1 FROM whaleu_errands.admin_request_contexts c
  JOIN whaleu_errands.admin_events a ON a.actor_id=c.actor_id AND a.request_id=c.request_id
  JOIN whaleu_errands.requests r ON r.account_id=c.actor_id AND r.request_id=c.request_id
  JOIN whaleu_safety.errand_restriction_events e ON e.id=a.safety_event_id
  WHERE c.actor_id=NEW.actor_id AND c.request_id=NEW.request_id AND c.operation=NEW.operation
   AND c.creation_transaction=pg_current_xact_id() AND a.creation_transaction=pg_current_xact_id()
   AND e.command_id=NEW.id AND e.kind='issued' AND a.subject_id=NEW.subject_id
   AND c.order_id=NEW.order_id AND c.target_region_id=NEW.target_region_id
   AND c.grant_id=NEW.grant_id AND c.session_id=NEW.session_id AND r.receipt->>'outcome'='applied'
 ) THEN RAISE EXCEPTION 'Scoped Safety effect requires same-transaction applied administrative cause' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER errand_scoped_restriction_cause AFTER INSERT ON whaleu_safety.errand_restriction_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_errands.require_scoped_restriction_cause();
