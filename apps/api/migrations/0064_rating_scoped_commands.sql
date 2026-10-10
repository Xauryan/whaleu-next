-- Shared Ratings request namespace, independent scoped protocol and exact causes.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
CREATE FUNCTION whaleu_ratings.rating_scoped_operation_rule(op text,protocol integer) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN protocol=2 THEN CASE op
 WHEN 'set_score_scoped' THEN '{"domain":"set_score","purpose":null,"effect":null}'::jsonb
 WHEN 'create_comment_scoped' THEN '{"domain":"create_comment","purpose":"publish_rating_comment_scoped","effect":"root_created"}'::jsonb
 WHEN 'create_reply_scoped' THEN '{"domain":"create_reply","purpose":"publish_rating_reply_scoped","effect":"reply_created"}'::jsonb
 WHEN 'set_comment_like_scoped' THEN '{"domain":"set_comment_like","purpose":null,"effect":"content_liked"}'::jsonb
 WHEN 'set_reply_like_scoped' THEN '{"domain":"set_reply_like","purpose":null,"effect":"content_liked"}'::jsonb
 WHEN 'set_target_subscription_scoped' THEN '{"domain":"set_target_subscription","purpose":null,"effect":"target_subscribed"}'::jsonb
 WHEN 'create_target_scoped' THEN '{"domain":"create_target","purpose":"publish_rating_target_scoped","effect":null}'::jsonb
 WHEN 'edit_target_scoped' THEN '{"domain":"edit_target","purpose":"edit_rating_target_scoped","effect":null}'::jsonb
 ELSE NULL END ELSE NULL END
$$;
CREATE FUNCTION whaleu_ratings.scoped_intent_valid(i jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE op text;payload jsonb;context jsonb;keys text[];k text;BEGIN
 IF NOT whaleu_community.rating_scoped_keys(i,ARRAY['protocolVersion','operation','context','payload']) OR i->'protocolVersion'<>'2'::jsonb THEN RETURN false;END IF;
 op:=i->>'operation';IF whaleu_ratings.rating_scoped_operation_rule(op,2) IS NULL THEN RETURN false;END IF;
 context:=i->'context';payload:=i->'payload';
 IF NOT whaleu_community.rating_scoped_keys(context,ARRAY['id','tokenDigest','token','selector','scopeRevision','protocolGeneration','catalogRevision','headRevision','sourceDigest'])
 OR NOT whaleu_community.rating_scoped_ids(context,ARRAY['id','protocolGeneration','catalogRevision','headRevision'])
 OR NOT whaleu_community.rating_scoped_selector_shape(context->'selector') OR context->>'token' !~ '^[A-Za-z0-9_-]{43}$'
 OR context->>'tokenDigest'<>encode(sha256(convert_to(context->>'token','UTF8')),'hex')
 OR NOT coalesce(context->>'scopeRevision' ~ '^[a-f0-9]{64}$' AND context->>'sourceDigest' ~ '^[a-f0-9]{64}$',false) THEN RETURN false;END IF;
 keys:=ARRAY['clientRequestId','categoryId','expectedCategoryRevision'];
 IF op<>'create_target_scoped' THEN keys:=keys||ARRAY['targetId','expectedTargetRevision'];END IF;
 CASE op
 WHEN 'set_score_scoped' THEN keys:=keys||ARRAY['expectedRevision','score'];
 WHEN 'create_comment_scoped' THEN keys:=keys||ARRAY['authorMode','body','assetIds'];
 WHEN 'create_reply_scoped' THEN keys:=keys||ARRAY['rootId','expectedRootRevision','replyTo','authorMode','body','assetIds'];
 WHEN 'set_comment_like_scoped' THEN keys:=keys||ARRAY['rootId','expectedRevision','expectedLikeRevision','liked'];
 WHEN 'set_reply_like_scoped' THEN keys:=keys||ARRAY['rootId','replyId','expectedRootRevision','expectedRevision','expectedLikeRevision','liked'];
 WHEN 'set_target_subscription_scoped' THEN keys:=keys||ARRAY['expectedSubscriptionRevision','subscribed'];
 WHEN 'create_target_scoped' THEN keys:=keys||ARRAY['name','description','assetIds'];
 WHEN 'edit_target_scoped' THEN keys:=keys||ARRAY['name','description','assetIds','expectedDefinitionRevision','expectedContentVersion'];
 ELSE RETURN false;END CASE;
 IF NOT whaleu_community.rating_scoped_keys(payload,keys) THEN RETURN false;END IF;
 FOREACH k IN ARRAY keys LOOP
  IF k IN ('body','name','description') THEN
   IF NOT whaleu_community.rating_target_edit_text_valid(payload->>k,CASE WHEN k='name' THEN 100 ELSE 500 END,k<>'description') THEN RETURN false;END IF;
  ELSIF k='assetIds' THEN IF payload->k<>'[]'::jsonb THEN RETURN false;END IF;
  ELSIF k='authorMode' THEN IF payload->>k NOT IN ('named','anonymous') THEN RETURN false;END IF;
  ELSIF k='score' THEN IF NOT whaleu_community.rating_scoped_integer(payload->k,1) OR (payload->>k)::integer>5 THEN RETURN false;END IF;
  ELSIF k IN ('liked','subscribed') THEN IF jsonb_typeof(payload->k)<>'boolean' THEN RETURN false;END IF;
  ELSIF k='expectedContentVersion' THEN IF NOT whaleu_community.rating_scoped_integer(payload->k,1) OR (payload->>k)::integer>=2147483647 THEN RETURN false;END IF;
  ELSIF k='replyTo' THEN IF payload->k<>'null'::jsonb AND NOT (whaleu_community.rating_scoped_keys(payload->k,ARRAY['replyId','expectedRevision']) AND whaleu_community.rating_scoped_ids(payload->k,ARRAY['replyId','expectedRevision'])) THEN RETURN false;END IF;
  ELSIF k='expectedRevision' AND op='set_score_scoped' THEN IF NOT whaleu_community.rating_scoped_nullable_id(payload->k) THEN RETURN false;END IF;
  ELSIF NOT whaleu_community.rating_scoped_ids(payload,ARRAY[k]) THEN RETURN false;
  END IF;
 END LOOP;RETURN true;EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE FUNCTION whaleu_ratings.scoped_intent_hash(i jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT encode(sha256(convert_to('whaleu:rating-scoped-command:v1'||chr(10)||whaleu_ratings.creation_canonical_json(jsonb_build_object('protocolVersion',i->'protocolVersion','operation',i->'operation','intent',jsonb_build_object('context',i->'context','payload',i->'payload'))),'UTF8')),'hex')
$$;
CREATE FUNCTION whaleu_ratings.scoped_context_record_digest(context_body jsonb,authority_body jsonb,protocol_body jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT whaleu_ratings.scoped_digest('context-record',jsonb_build_object('context',context_body,'authority',authority_body,'protocolTuples',protocol_body))
$$;
CREATE TABLE whaleu_ratings.scoped_contexts(
 id uuid PRIMARY KEY,account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),session_id uuid NOT NULL REFERENCES whaleu_identity.sessions(id),token_digest text NOT NULL UNIQUE CHECK(token_digest ~ '^[a-f0-9]{64}$'),
 context jsonb NOT NULL CHECK(jsonb_typeof(context)='object'),authority jsonb NOT NULL CHECK(jsonb_typeof(authority)='object'),protocol_tuples jsonb NOT NULL CHECK(jsonb_typeof(protocol_tuples)='array'),
 record_digest text GENERATED ALWAYS AS (whaleu_ratings.scoped_context_record_digest(context,authority,protocol_tuples)) STORED,
 issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),valid_until timestamptz NOT NULL,issuance_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 CHECK(isfinite(issued_at) AND isfinite(valid_until) AND valid_until>issued_at AND valid_until<=issued_at+interval '5 minutes'),
 CHECK(context->>'id'=id::text AND context->>'actorId'=account_id::text AND context->>'tokenDigest'=token_digest AND context->'protocolVersion'='2'::jsonb)
);
CREATE TABLE whaleu_ratings.scoped_command_preparations(
 account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,operation text NOT NULL,intent_hash text NOT NULL,intent jsonb NOT NULL,
 context_id uuid NOT NULL REFERENCES whaleu_ratings.scoped_contexts(id),session_id uuid NOT NULL REFERENCES whaleu_identity.sessions(id),context_revision text NOT NULL UNIQUE CHECK(context_revision ~ '^[A-Za-z0-9_-]{43}$'),
 target_id uuid NOT NULL,subject_id uuid NOT NULL,target_revision uuid NOT NULL,subject_revision uuid NOT NULL,definition_revision uuid NOT NULL,content_version integer NOT NULL CHECK(content_version>0),
 before_state jsonb NOT NULL CHECK(jsonb_typeof(before_state)='object'),envelope jsonb,policy_source_id uuid,policy_source_revision uuid,
 prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(),valid_until timestamptz NOT NULL,preparation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 PRIMARY KEY(account_id,request_id),FOREIGN KEY(account_id,request_id) REFERENCES whaleu_ratings.command_claims(account_id,request_id),FOREIGN KEY(policy_source_id,policy_source_revision) REFERENCES whaleu_ratings.scoped_source_attestations(id,revision),
 CHECK(whaleu_ratings.scoped_intent_valid(intent)),CHECK(intent_hash=whaleu_ratings.scoped_intent_hash(intent)),CHECK(operation=intent->>'operation' AND request_id::text=intent->'payload'->>'clientRequestId' AND context_id::text=intent->'context'->>'id'),
 CHECK(isfinite(prepared_at) AND isfinite(valid_until) AND valid_until>prepared_at AND valid_until<=prepared_at+interval '5 minutes')
);
CREATE TABLE whaleu_ratings.scoped_command_outcomes(
 account_id uuid NOT NULL,request_id uuid NOT NULL,operation text NOT NULL,intent_hash text NOT NULL,intent jsonb NOT NULL CHECK(whaleu_ratings.scoped_intent_valid(intent)),outcome text NOT NULL CHECK(outcome IN ('applied','noop','closed')),result jsonb,code text,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 PRIMARY KEY(account_id,request_id),FOREIGN KEY(account_id,request_id) REFERENCES whaleu_ratings.requests(account_id,request_id),
 CHECK(intent_hash=whaleu_ratings.scoped_intent_hash(intent) AND operation=intent->>'operation' AND request_id::text=intent->'payload'->>'clientRequestId'),
 CHECK((outcome='closed' AND result IS NULL AND code IN ('RATING_SCOPED_CONTEXT_CHANGED','RATING_CREATION_CANCELLED','RATING_EDIT_CANCELLED','RATING_REVISION_CONFLICT','RATING_NOT_FOUND','CONTENT_REJECTED','PHONE_VERIFICATION_REQUIRED','AFFILIATION_VERIFICATION_REQUIRED','IDENTITY_CAMPUS_REQUIRED','SAFETY_ACTION_RESTRICTED')) OR (outcome IN ('applied','noop') AND code IS NULL AND jsonb_typeof(result)='object'))
);
CREATE TABLE whaleu_ratings.scoped_command_causes(
 account_id uuid NOT NULL,request_id uuid NOT NULL,cause_kind text NOT NULL CHECK(cause_kind IN ('execution','domain_transition','target_initial','target_edit','catalog_release','legacy_bridge')),
 artifact_id uuid NOT NULL,artifact_revision uuid NOT NULL,proof jsonb NOT NULL CHECK(jsonb_typeof(proof)='object'),mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 PRIMARY KEY(account_id,request_id,cause_kind,artifact_id),UNIQUE(cause_kind,artifact_id,artifact_revision),FOREIGN KEY(account_id,request_id) REFERENCES whaleu_ratings.requests(account_id,request_id)
);
ALTER TABLE whaleu_ratings.requests DROP CONSTRAINT requests_operation_check;
ALTER TABLE whaleu_ratings.requests ADD CONSTRAINT requests_operation_check CHECK(operation IN ('set_score','create_comment','delete_comment','create_reply','delete_reply','set_comment_like','set_reply_like','set_target_subscription','admin_delete_comment','admin_delete_reply','create_target','delete_target','edit_target','create_categories','set_score_scoped','create_comment_scoped','create_reply_scoped','set_comment_like_scoped','set_reply_like_scoped','set_target_subscription_scoped','create_target_scoped','edit_target_scoped'));
DROP TRIGGER rating_request_causal ON whaleu_ratings.requests;
CREATE CONSTRAINT TRIGGER rating_request_causal AFTER INSERT OR UPDATE ON whaleu_ratings.requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.operation IN ('set_score','create_comment','delete_comment','create_reply','delete_reply')) EXECUTE FUNCTION whaleu_ratings.request_causal();
CREATE TRIGGER scoped_preparation_claim BEFORE INSERT ON whaleu_ratings.scoped_command_preparations FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.claim_command();
CREATE FUNCTION whaleu_ratings.scoped_context_current(context_id uuid,actor uuid,session uuid,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT c.account_id=actor AND c.session_id=session AND c.issued_at<=instant AND c.valid_until>instant
 AND whaleu_ratings.target_edit_session_current(actor,session,instant)
 AND whaleu_ratings.category_topology_regions((c.authority->>'topologySnapshotId')::uuid,NULL) IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c.context->'heads') head LEFT JOIN whaleu_ratings.scoped_catalog_heads h ON h.scope_key=head->>'scopeKey'
  WHERE h.catalog_id IS NULL OR (h.catalog_id::text,h.head_revision::text) IS DISTINCT FROM (head->>'catalogRevision',head->>'headRevision') OR NOT whaleu_ratings.scoped_catalog_current(h.catalog_id,instant))
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c.protocol_tuples) p LEFT JOIN whaleu_ratings.scope_protocol_heads h ON h.logical_scope_key=p->>'scopeKey'
  LEFT JOIN whaleu_ratings.scope_protocol_versions v ON v.id=h.version_id WHERE v.id IS NULL OR v.phase<>'adopted' OR v.id::text<>p->>'versionId' OR v.generation::text<>p->>'generation')
 FROM whaleu_ratings.scoped_contexts c WHERE c.id=context_id),false)
$$;
CREATE FUNCTION whaleu_ratings.scoped_preparation_envelope(p whaleu_ratings.scoped_command_preparations) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE c whaleu_ratings.scoped_contexts;i jsonb:=p.intent;v jsonb:=i->'payload';s jsonb:=i->'context';e jsonb;purpose text;origin jsonb;
BEGIN
 purpose:=whaleu_ratings.rating_scoped_operation_rule(p.operation,2)->>'purpose';IF purpose IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO c FROM whaleu_ratings.scoped_contexts WHERE id=p.context_id;
 origin:=p.before_state->'origin';
 IF p.operation='create_target_scoped' THEN
  IF origin IS DISTINCT FROM jsonb_build_object('regionId',c.authority->'origin'->'regionId','originCampusId',c.context->'identityCampusId') THEN RETURN NULL;END IF;
 ELSE
  IF origin->'regionId' IS DISTINCT FROM p.before_state->'target'->'regionId' THEN RETURN NULL;END IF;
 END IF;
 e:=jsonb_build_object('version',5,'purpose',purpose,'accountId',p.account_id,'clientRequestId',p.request_id,
  'targetId',p.target_id,'targetRevision',p.target_revision,'categoryId',v->'categoryId','categoryRevision',v->'expectedCategoryRevision',
  'scope',jsonb_build_object('selector',s->'selector','scopeKey',CASE WHEN s->'selector'->>'kind'='global' THEN 'global' ELSE 'campus:'||(s->'selector'->>'campusId') END,
   'catalogRevision',s->'catalogRevision','headRevision',s->'headRevision','scopeRevision',s->'scopeRevision','contextId',p.context_id,'contextDigest',s->'tokenDigest',
   'protocolGeneration',s->'protocolGeneration','sourceDigest',s->'sourceDigest','topologySnapshotId',c.authority->'topologySnapshotId'),
  'targetOrigin',origin,'assetIds','[]'::jsonb);
 IF p.operation IN ('create_target_scoped','edit_target_scoped') THEN
  e:=e||jsonb_build_object('definitionRevision',p.definition_revision,'contentVersion',p.content_version,'name',v->'name','description',v->'description');
  IF p.operation='edit_target_scoped' THEN e:=e||jsonb_build_object('previousTargetRevision',v->'expectedTargetRevision','previousDefinitionRevision',v->'expectedDefinitionRevision');END IF;
 ELSE
  e:=e||jsonb_build_object('subjectId',p.subject_id,'subjectRevision',p.subject_revision,'targetDefinitionRevision',p.before_state->'target'->'definitionRevision',
   'targetContentVersion',p.before_state->'target'->'contentVersion','body',v->'body','authorMode',v->'authorMode');
  IF p.operation='create_reply_scoped' THEN e:=e||jsonb_build_object('rootId',v->'rootId','rootRevision',v->'expectedRootRevision',
   'replyTo',CASE WHEN v->'replyTo'='null'::jsonb THEN 'null'::jsonb ELSE jsonb_build_object('replyId',v->'replyTo'->'replyId','revision',v->'replyTo'->'expectedRevision') END);END IF;
 END IF;RETURN e;
END $$;
CREATE FUNCTION whaleu_ratings.scoped_preparation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c whaleu_ratings.scoped_contexts;leaf whaleu_ratings.scoped_categories;BEGIN
 SELECT * INTO c FROM whaleu_ratings.scoped_contexts WHERE id=NEW.context_id;
 SELECT * INTO leaf FROM whaleu_ratings.scoped_categories WHERE catalog_id=(NEW.intent->'context'->>'catalogRevision')::uuid AND category_id=(NEW.intent->'payload'->>'categoryId')::uuid;
 IF NEW.envelope IS DISTINCT FROM whaleu_ratings.scoped_preparation_envelope(NEW) THEN RAISE EXCEPTION 'Scoped envelope must exactly equal complete prepared intent' USING ERRCODE='23514';END IF;
 IF NOT coalesce(NEW.preparation_transaction=pg_current_xact_id() AND whaleu_ratings.scoped_context_current(c.id,NEW.account_id,NEW.session_id,clock_timestamp())
 AND c.context->>'mode'='public' AND c.context->>'purpose'=CASE NEW.operation WHEN 'create_target_scoped' THEN 'create_target' WHEN 'edit_target_scoped' THEN 'edit_target' ELSE 'interact' END
 AND c.token_digest=NEW.intent->'context'->>'tokenDigest' AND c.context->'selector'=NEW.intent->'context'->'selector'
 AND c.context->>'scopeRevision'=NEW.intent->'context'->>'scopeRevision' AND c.context->>'protocolGeneration'=NEW.intent->'context'->>'protocolGeneration'
 AND c.context->>'sourceDigest'=NEW.intent->'context'->>'sourceDigest' AND c.context->'heads'->0->>'catalogRevision'=NEW.intent->'context'->>'catalogRevision' AND c.context->'heads'->0->>'headRevision'=NEW.intent->'context'->>'headRevision'
 AND leaf.effective_revision::text=NEW.intent->'payload'->>'expectedCategoryRevision' AND whaleu_ratings.scoped_category_current(leaf.catalog_id,leaf.category_id),false)
 THEN RAISE EXCEPTION 'Scoped preparation requires exact current context/category' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER scoped_preparation_guard BEFORE INSERT ON whaleu_ratings.scoped_command_preparations FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.scoped_preparation_guard();
DO $$ DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['scoped_contexts','scoped_command_preparations','scoped_command_outcomes','scoped_command_causes'] LOOP
  EXECUTE format('CREATE TRIGGER scoped_immutable BEFORE UPDATE OR DELETE ON whaleu_ratings.%I FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.immutable()',tab);
  EXECUTE format('CREATE TRIGGER scoped_retain BEFORE TRUNCATE ON whaleu_ratings.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.immutable()',tab);
 END LOOP;
END $$;

-- This is an internal typed projection of one actual request, not a compatibility
-- view and not a second command ledger. Only registered operations are projected.
CREATE FUNCTION whaleu_ratings.scoped_domain_request(actor uuid,request uuid) RETURNS whaleu_ratings.requests LANGUAGE plpgsql STABLE AS $$
DECLARE q whaleu_ratings.requests;p whaleu_ratings.scoped_command_preparations;e whaleu_ratings.scoped_command_causes;c whaleu_ratings.scoped_contexts;rule jsonb;BEGIN
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=actor AND request_id=request;
 rule:=whaleu_ratings.rating_scoped_operation_rule(q.operation,2);IF rule IS NULL THEN RETURN q;END IF;
 SELECT * INTO p FROM whaleu_ratings.scoped_command_preparations WHERE account_id=actor AND request_id=request;
 SELECT * INTO c FROM whaleu_ratings.scoped_contexts WHERE id=p.context_id;
 SELECT * INTO e FROM whaleu_ratings.scoped_command_causes WHERE account_id=actor AND request_id=request AND cause_kind='execution';
 IF NOT coalesce(p.intent_hash=q.intent_hash AND p.operation=q.operation AND whaleu_ratings.scoped_intent_valid(p.intent)
 AND whaleu_ratings.scoped_intent_hash(p.intent)=q.intent_hash AND c.id=p.context_id AND c.account_id=actor AND c.session_id=p.session_id
 AND c.token_digest=p.intent->'context'->>'tokenDigest' AND c.context->>'scopeRevision'=p.intent->'context'->>'scopeRevision'
 AND c.context->'selector'=p.intent->'context'->'selector' AND c.context->>'protocolGeneration'=p.intent->'context'->>'protocolGeneration'
 AND c.context->>'sourceDigest'=p.intent->'context'->>'sourceDigest'
 AND c.context->'heads'->0->>'catalogRevision'=p.intent->'context'->>'catalogRevision' AND c.context->'heads'->0->>'headRevision'=p.intent->'context'->>'headRevision'
 AND e.mutation_transaction=pg_current_xact_id() AND e.artifact_id=c.id AND e.artifact_revision=p.target_revision
 AND e.proof=jsonb_build_object('intentHash',q.intent_hash,'operation',q.operation,'contextId',c.id,'contextRevision',p.context_revision),false)
 THEN RAISE EXCEPTION 'Scoped request has no exact typed preparation/execution cause' USING ERRCODE='23514';END IF;
 q.operation:=rule->>'domain';
 IF q.receipt IS NOT NULL THEN
  IF NOT coalesce(q.receipt->'protocolVersion'='2'::jsonb AND q.receipt->>'operation'=p.operation AND q.receipt->>'intentHash'=p.intent_hash
   AND q.receipt->>'requestId'=request::text AND q.receipt->>'outcome' IN ('applied','noop') AND jsonb_typeof(q.receipt->'result')='object',false)
  THEN RAISE EXCEPTION 'Scoped domain receipt is not an exact success' USING ERRCODE='23514';END IF;
  q.receipt:=(q.receipt->'result')||jsonb_build_object('requestId',request,'operation',q.operation,'outcome',q.receipt->>'outcome');
 END IF;RETURN q;
END $$;
CREATE FUNCTION whaleu_ratings.scoped_registered_request(actor uuid,request uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT whaleu_ratings.rating_scoped_operation_rule(operation,2) IS NOT NULL FROM whaleu_ratings.requests WHERE account_id=actor AND request_id=request),false)
$$;
CREATE FUNCTION whaleu_ratings.scoped_command_parents_current(prepared whaleu_ratings.scoped_command_preparations) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE target_row whaleu_ratings.targets;root_row whaleu_ratings.comments;reply_row whaleu_ratings.replies;payload jsonb:=prepared.intent->'payload';
BEGIN
 IF prepared.operation='create_target_scoped' THEN RETURN true;END IF;
 SELECT * INTO target_row FROM whaleu_ratings.targets WHERE id=prepared.target_id;
 IF NOT coalesce(target_row.active AND target_row.category_id::text=payload->>'categoryId'
  AND EXISTS(SELECT 1 FROM whaleu_ratings.target_definition_heads head_row JOIN whaleu_ratings.target_definition_versions definition_row
    ON (definition_row.target_id,definition_row.content_version,definition_row.definition_revision)=(head_row.target_id,head_row.content_version,head_row.definition_revision)
   JOIN whaleu_ratings.target_definition_lifecycles life_row ON life_row.target_id=head_row.target_id AND life_row.target_revision=target_row.revision
    AND (life_row.content_version,life_row.definition_revision)=(head_row.content_version,head_row.definition_revision)
   WHERE head_row.target_id=target_row.id AND whaleu_community.rating_target_definition_current(target_row.id,definition_row.content_version,definition_row.definition_revision,definition_row.applied_target_revision,definition_row.envelope))
  AND EXISTS(SELECT 1 FROM whaleu_ratings.scoped_target_memberships membership WHERE membership.catalog_id=(prepared.intent->'context'->>'catalogRevision')::uuid AND membership.target_id=target_row.id AND membership.category_id=target_row.category_id)
  AND whaleu_ratings.scoped_category_current((prepared.intent->'context'->>'catalogRevision')::uuid,target_row.category_id),false) THEN RETURN false;END IF;
 IF prepared.operation IN ('create_reply_scoped','set_comment_like_scoped','set_reply_like_scoped') THEN
  SELECT * INTO root_row FROM whaleu_ratings.comments WHERE id=(payload->>'rootId')::uuid;
  IF NOT coalesce(root_row.target_id=target_row.id AND root_row.deleted_at IS NULL
   AND root_row.revision::text=CASE WHEN prepared.operation='set_comment_like_scoped' THEN payload->>'expectedRevision' ELSE payload->>'expectedRootRevision' END
   AND whaleu_community.rating_scoped_parent_review_current('comment',root_row.id,root_row.revision),false) THEN RETURN false;END IF;
  IF prepared.operation='set_reply_like_scoped' OR (prepared.operation='create_reply_scoped' AND payload->'replyTo'<>'null'::jsonb) THEN
   SELECT * INTO reply_row FROM whaleu_ratings.replies WHERE id=coalesce((payload->>'replyId')::uuid,(payload->'replyTo'->>'replyId')::uuid);
   IF NOT coalesce(reply_row.target_id=target_row.id AND reply_row.root_id=root_row.id AND reply_row.deleted_at IS NULL
    AND reply_row.revision::text=CASE WHEN prepared.operation='set_reply_like_scoped' THEN payload->>'expectedRevision' ELSE payload->'replyTo'->>'expectedRevision' END
    AND whaleu_community.rating_scoped_parent_review_current('reply',reply_row.id,reply_row.revision),false) THEN RETURN false;END IF;
  END IF;
 END IF;RETURN true;
END $$;
CREATE OR REPLACE FUNCTION whaleu_ratings.scoped_execution_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p whaleu_ratings.scoped_command_preparations;q whaleu_ratings.requests;t whaleu_ratings.targets;h whaleu_ratings.target_definition_heads;BEGIN
 IF NEW.cause_kind='legacy_bridge' THEN PERFORM whaleu_ratings.legacy_bridge_guard(NEW);RETURN NEW;END IF;
 IF NEW.cause_kind='legacy_boundary' THEN PERFORM whaleu_ratings.legacy_boundary_guard(NEW);RETURN NEW;END IF;
 IF NEW.mutation_transaction<>pg_current_xact_id() THEN RAISE EXCEPTION 'Scoped cause is not fresh' USING ERRCODE='23514';END IF;
 SELECT * INTO p FROM whaleu_ratings.scoped_command_preparations WHERE account_id=NEW.account_id AND request_id=NEW.request_id;
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=NEW.account_id AND request_id=NEW.request_id FOR UPDATE NOWAIT;
 IF NOT coalesce(p.operation=q.operation AND p.intent_hash=q.intent_hash AND q.receipt IS NULL AND p.valid_until>clock_timestamp()
 AND (NEW.cause_kind<>'execution' OR whaleu_ratings.scoped_context_current(p.context_id,p.account_id,p.session_id,clock_timestamp())),false)
 THEN RAISE EXCEPTION 'Scoped cause needs fresh exact prepared request' USING ERRCODE='23514';END IF;
 IF NEW.cause_kind='execution' THEN
  IF NOT whaleu_ratings.scoped_command_parents_current(p) THEN RAISE EXCEPTION 'Scoped command requires exact current target and ancestor Review' USING ERRCODE='23514';END IF;
  IF NEW.proof<>jsonb_build_object('intentHash',p.intent_hash,'operation',p.operation,'contextId',p.context_id,'contextRevision',p.context_revision)
   OR (NEW.artifact_id,NEW.artifact_revision) IS DISTINCT FROM (p.context_id,p.target_revision)
  THEN RAISE EXCEPTION 'Scoped execution proof mismatch' USING ERRCODE='23514';END IF;
  IF p.operation<>'create_target_scoped' THEN
   SELECT * INTO t FROM whaleu_ratings.targets WHERE id=p.target_id FOR UPDATE NOWAIT;
   SELECT * INTO h FROM whaleu_ratings.target_definition_heads WHERE target_id=p.target_id;
   IF NOT coalesce(t.active AND t.revision::text=p.intent->'payload'->>'expectedTargetRevision'
    AND t.category_id::text=p.intent->'payload'->>'categoryId'
    AND p.before_state->'target'=jsonb_build_object('id',t.id,'revision',t.revision,'creatorId',t.creator_id,'regionId',t.region_id,'categoryId',t.category_id,'definitionRevision',h.definition_revision,'contentVersion',h.content_version)
    AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.target_owner_tombstones WHERE target_id=t.id),false)
   THEN RAISE EXCEPTION 'Scoped before-target tuple changed' USING ERRCODE='23514';END IF;
  END IF;
 ELSE PERFORM whaleu_ratings.scoped_domain_request(NEW.account_id,NEW.request_id);END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER scoped_execution_guard BEFORE INSERT ON whaleu_ratings.scoped_command_causes FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.scoped_execution_guard();

-- Same-OID typed dispatcher; the following ELSE retains the complete legacy body.
CREATE OR REPLACE FUNCTION whaleu_ratings.apply_score_transition() RETURNS trigger LANGUAGE plpgsql AS $dispatch$
BEGIN
 IF whaleu_ratings.scoped_registered_request(NEW.account_id,NEW.request_id) THEN

DECLARE prior whaleu_ratings.score_summaries;next_summary whaleu_ratings.score_summaries;previous smallint;prior_revision uuid;command whaleu_ratings.requests;active boolean;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Score withdrawal unsupported' USING ERRCODE='23514';END IF;
 SELECT t.active INTO active FROM whaleu_ratings.targets t WHERE id=NEW.target_id FOR UPDATE;
 IF active IS DISTINCT FROM true THEN RAISE EXCEPTION 'Inactive score target' USING ERRCODE='23514';END IF;
 SELECT * INTO prior FROM whaleu_ratings.score_summaries WHERE target_id=NEW.target_id FOR UPDATE;
 IF prior.target_id IS NULL THEN RAISE EXCEPTION 'Score coverage unavailable' USING ERRCODE='23514';END IF;
 SELECT * INTO command FROM whaleu_ratings.requests WHERE account_id=NEW.account_id AND request_id=NEW.request_id FOR UPDATE;
 command:=whaleu_ratings.scoped_domain_request(command.account_id,command.request_id);
 IF command.operation IS DISTINCT FROM 'set_score' OR command.receipt IS NOT NULL THEN RAISE EXCEPTION 'Invalid score command' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' THEN
 IF ROW(NEW.target_id,NEW.account_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.target_id,OLD.account_id,OLD.created_at) OR NEW.score=OLD.score OR NEW.revision=OLD.revision OR NEW.request_id=OLD.request_id THEN RAISE EXCEPTION 'Invalid score transition' USING ERRCODE='23514';END IF;
 previous:=OLD.score;prior_revision:=OLD.revision;END IF;
 NEW.updated_at:=clock_timestamp();IF TG_OP='INSERT' THEN NEW.created_at:=NEW.updated_at;END IF;
 UPDATE whaleu_ratings.score_summaries SET revision=gen_random_uuid(),count=count+CASE WHEN previous IS NULL THEN 1 ELSE 0 END,sum=sum+NEW.score-coalesce(previous,0),
 b1=b1+(NEW.score=1)::integer-coalesce((previous=1)::integer,0),b2=b2+(NEW.score=2)::integer-coalesce((previous=2)::integer,0),b3=b3+(NEW.score=3)::integer-coalesce((previous=3)::integer,0),b4=b4+(NEW.score=4)::integer-coalesce((previous=4)::integer,0),b5=b5+(NEW.score=5)::integer-coalesce((previous=5)::integer,0)
 WHERE target_id=NEW.target_id RETURNING * INTO next_summary;
 INSERT INTO whaleu_ratings.score_transitions(id,target_id,account_id,request_id,old_score,new_score,old_revision,new_revision,old_summary,new_summary,mutation_transaction,occurred_at)
 VALUES(gen_random_uuid(),NEW.target_id,NEW.account_id,NEW.request_id,previous,NEW.score,prior_revision,NEW.revision,to_jsonb(prior),to_jsonb(next_summary),pg_current_xact_id(),NEW.updated_at);RETURN NEW;
END;
 ELSE

DECLARE prior whaleu_ratings.score_summaries;next_summary whaleu_ratings.score_summaries;previous smallint;prior_revision uuid;command whaleu_ratings.requests;active boolean;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Score withdrawal unsupported' USING ERRCODE='23514';END IF;
 SELECT t.active INTO active FROM whaleu_ratings.targets t WHERE id=NEW.target_id FOR UPDATE;
 IF active IS DISTINCT FROM true THEN RAISE EXCEPTION 'Inactive score target' USING ERRCODE='23514';END IF;
 SELECT * INTO prior FROM whaleu_ratings.score_summaries WHERE target_id=NEW.target_id FOR UPDATE;
 IF prior.target_id IS NULL THEN RAISE EXCEPTION 'Score coverage unavailable' USING ERRCODE='23514';END IF;
 SELECT * INTO command FROM whaleu_ratings.requests WHERE account_id=NEW.account_id AND request_id=NEW.request_id FOR UPDATE;
 IF command.operation IS DISTINCT FROM 'set_score' OR command.receipt IS NOT NULL THEN RAISE EXCEPTION 'Invalid score command' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' THEN
 IF ROW(NEW.target_id,NEW.account_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.target_id,OLD.account_id,OLD.created_at) OR NEW.score=OLD.score OR NEW.revision=OLD.revision OR NEW.request_id=OLD.request_id THEN RAISE EXCEPTION 'Invalid score transition' USING ERRCODE='23514';END IF;
 previous:=OLD.score;prior_revision:=OLD.revision;END IF;
 NEW.updated_at:=clock_timestamp();IF TG_OP='INSERT' THEN NEW.created_at:=NEW.updated_at;END IF;
 UPDATE whaleu_ratings.score_summaries SET revision=gen_random_uuid(),count=count+CASE WHEN previous IS NULL THEN 1 ELSE 0 END,sum=sum+NEW.score-coalesce(previous,0),
 b1=b1+(NEW.score=1)::integer-coalesce((previous=1)::integer,0),b2=b2+(NEW.score=2)::integer-coalesce((previous=2)::integer,0),b3=b3+(NEW.score=3)::integer-coalesce((previous=3)::integer,0),b4=b4+(NEW.score=4)::integer-coalesce((previous=4)::integer,0),b5=b5+(NEW.score=5)::integer-coalesce((previous=5)::integer,0)
 WHERE target_id=NEW.target_id RETURNING * INTO next_summary;
 INSERT INTO whaleu_ratings.score_transitions(id,target_id,account_id,request_id,old_score,new_score,old_revision,new_revision,old_summary,new_summary,mutation_transaction,occurred_at)
 VALUES(gen_random_uuid(),NEW.target_id,NEW.account_id,NEW.request_id,previous,NEW.score,prior_revision,NEW.revision,to_jsonb(prior),to_jsonb(next_summary),pg_current_xact_id(),NEW.updated_at);RETURN NEW;
END;
 END IF;
END $dispatch$;

-- Same-OID typed dispatcher; the following ELSE retains the complete legacy body.
CREATE OR REPLACE FUNCTION whaleu_ratings.comment_change() RETURNS trigger LANGUAGE plpgsql AS $dispatch$
BEGIN
 IF whaleu_ratings.scoped_registered_request(NEW.account_id,NEW.request_id) THEN

DECLARE command whaleu_ratings.requests;op text;key uuid;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Comment tombstone is durable' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-ARRAY['deleted_at','delete_request_id','admin_delete_audit_id','revision']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['deleted_at','delete_request_id','admin_delete_audit_id','revision'])
   OR OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NULL OR NEW.revision=OLD.revision
   OR ((NEW.delete_request_id IS NULL)=(NEW.admin_delete_audit_id IS NULL)) THEN
   RAISE EXCEPTION 'Invalid comment deletion' USING ERRCODE='23514';END IF;
  IF NEW.admin_delete_audit_id IS NOT NULL THEN
   NEW.deleted_at:=whaleu_ratings.admin_delete_cause(NEW.admin_delete_audit_id,'comment',NEW.target_id,NEW.id,NEW.id,NEW.account_id,OLD.revision,NEW.revision);
   RETURN NEW;
  END IF;
  op:='delete_comment';key:=NEW.delete_request_id;
 ELSE
  IF NEW.deleted_at IS NOT NULL OR NEW.delete_request_id IS NOT NULL OR NEW.admin_delete_audit_id IS NOT NULL OR NEW.publication_transaction<>pg_current_xact_id() THEN
   RAISE EXCEPTION 'Invalid comment publication' USING ERRCODE='23514';END IF;
  op:='create_comment';key:=NEW.request_id;
 END IF;
 SELECT * INTO command FROM whaleu_ratings.requests WHERE account_id=NEW.account_id AND request_id=key FOR UPDATE NOWAIT;
 command:=whaleu_ratings.scoped_domain_request(command.account_id,command.request_id);
 IF command.operation IS DISTINCT FROM op OR command.receipt IS NOT NULL THEN RAISE EXCEPTION 'Invalid comment command' USING ERRCODE='23514';END IF;RETURN NEW;
END;
 ELSE

DECLARE command whaleu_ratings.requests;op text;key uuid;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Comment tombstone is durable' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-ARRAY['deleted_at','delete_request_id','admin_delete_audit_id','revision']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['deleted_at','delete_request_id','admin_delete_audit_id','revision'])
   OR OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NULL OR NEW.revision=OLD.revision
   OR ((NEW.delete_request_id IS NULL)=(NEW.admin_delete_audit_id IS NULL)) THEN
   RAISE EXCEPTION 'Invalid comment deletion' USING ERRCODE='23514';END IF;
  IF NEW.admin_delete_audit_id IS NOT NULL THEN
   NEW.deleted_at:=whaleu_ratings.admin_delete_cause(NEW.admin_delete_audit_id,'comment',NEW.target_id,NEW.id,NEW.id,NEW.account_id,OLD.revision,NEW.revision);
   RETURN NEW;
  END IF;
  op:='delete_comment';key:=NEW.delete_request_id;
 ELSE
  IF NEW.deleted_at IS NOT NULL OR NEW.delete_request_id IS NOT NULL OR NEW.admin_delete_audit_id IS NOT NULL OR NEW.publication_transaction<>pg_current_xact_id() THEN
   RAISE EXCEPTION 'Invalid comment publication' USING ERRCODE='23514';END IF;
  op:='create_comment';key:=NEW.request_id;
 END IF;
 SELECT * INTO command FROM whaleu_ratings.requests WHERE account_id=NEW.account_id AND request_id=key FOR UPDATE NOWAIT;
 IF command.operation IS DISTINCT FROM op OR command.receipt IS NOT NULL THEN RAISE EXCEPTION 'Invalid comment command' USING ERRCODE='23514';END IF;RETURN NEW;
END;
 END IF;
END $dispatch$;

-- Same-OID typed dispatcher; the following ELSE retains the complete legacy body.
CREATE OR REPLACE FUNCTION whaleu_ratings.reply_change() RETURNS trigger LANGUAGE plpgsql AS $dispatch$
BEGIN
 IF whaleu_ratings.scoped_registered_request(NEW.account_id,NEW.request_id) THEN

DECLARE command whaleu_ratings.requests;op text;key uuid;t whaleu_ratings.targets;r whaleu_ratings.comments;p whaleu_ratings.replies;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Reply tombstone is durable' USING ERRCODE='23514';END IF;
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=NEW.target_id FOR UPDATE NOWAIT;
 SELECT * INTO r FROM whaleu_ratings.comments WHERE id=NEW.root_id AND target_id=NEW.target_id FOR UPDATE NOWAIT;
 IF t.id IS NULL OR r.id IS NULL THEN RAISE EXCEPTION 'Reply parent unavailable' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-ARRAY['deleted_at','delete_request_id','admin_delete_audit_id','revision']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['deleted_at','delete_request_id','admin_delete_audit_id','revision'])
   OR OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NULL OR NEW.revision=OLD.revision
   OR ((NEW.delete_request_id IS NULL)=(NEW.admin_delete_audit_id IS NULL)) THEN
   RAISE EXCEPTION 'Invalid reply deletion' USING ERRCODE='23514';END IF;
  IF NEW.admin_delete_audit_id IS NOT NULL THEN
   NEW.deleted_at:=whaleu_ratings.admin_delete_cause(NEW.admin_delete_audit_id,'reply',NEW.target_id,NEW.root_id,NEW.id,NEW.account_id,OLD.revision,NEW.revision);
   RETURN NEW;
  END IF;
  NEW.deleted_at:=clock_timestamp();op:='delete_reply';key:=NEW.delete_request_id;
 ELSE
  IF t.active IS DISTINCT FROM true OR r.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'Reply parent unavailable' USING ERRCODE='23514';END IF;
  IF NEW.deleted_at IS NOT NULL OR NEW.delete_request_id IS NOT NULL OR NEW.admin_delete_audit_id IS NOT NULL OR NEW.publication_transaction<>pg_current_xact_id() THEN
   RAISE EXCEPTION 'Invalid reply publication' USING ERRCODE='23514';END IF;
  IF NEW.reply_to_id IS NOT NULL THEN
   SELECT * INTO p FROM whaleu_ratings.replies WHERE id=NEW.reply_to_id AND root_id=NEW.root_id AND target_id=NEW.target_id FOR SHARE NOWAIT;
   IF p.id IS NULL OR p.deleted_at IS NOT NULL OR p.ordinal>=NEW.ordinal THEN RAISE EXCEPTION 'Invalid direct reply ancestry' USING ERRCODE='23514';END IF;
  END IF;
  NEW.created_at:=clock_timestamp();op:='create_reply';key:=NEW.request_id;
 END IF;
 SELECT * INTO command FROM whaleu_ratings.requests WHERE account_id=NEW.account_id AND request_id=key FOR UPDATE NOWAIT;
 command:=whaleu_ratings.scoped_domain_request(command.account_id,command.request_id);
 IF command.operation IS DISTINCT FROM op OR command.receipt IS NOT NULL THEN RAISE EXCEPTION 'Invalid reply command' USING ERRCODE='23514';END IF;RETURN NEW;
END;
 ELSE

DECLARE command whaleu_ratings.requests;op text;key uuid;t whaleu_ratings.targets;r whaleu_ratings.comments;p whaleu_ratings.replies;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Reply tombstone is durable' USING ERRCODE='23514';END IF;
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=NEW.target_id FOR UPDATE NOWAIT;
 SELECT * INTO r FROM whaleu_ratings.comments WHERE id=NEW.root_id AND target_id=NEW.target_id FOR UPDATE NOWAIT;
 IF t.id IS NULL OR r.id IS NULL THEN RAISE EXCEPTION 'Reply parent unavailable' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-ARRAY['deleted_at','delete_request_id','admin_delete_audit_id','revision']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['deleted_at','delete_request_id','admin_delete_audit_id','revision'])
   OR OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NULL OR NEW.revision=OLD.revision
   OR ((NEW.delete_request_id IS NULL)=(NEW.admin_delete_audit_id IS NULL)) THEN
   RAISE EXCEPTION 'Invalid reply deletion' USING ERRCODE='23514';END IF;
  IF NEW.admin_delete_audit_id IS NOT NULL THEN
   NEW.deleted_at:=whaleu_ratings.admin_delete_cause(NEW.admin_delete_audit_id,'reply',NEW.target_id,NEW.root_id,NEW.id,NEW.account_id,OLD.revision,NEW.revision);
   RETURN NEW;
  END IF;
  NEW.deleted_at:=clock_timestamp();op:='delete_reply';key:=NEW.delete_request_id;
 ELSE
  IF t.active IS DISTINCT FROM true OR r.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'Reply parent unavailable' USING ERRCODE='23514';END IF;
  IF NEW.deleted_at IS NOT NULL OR NEW.delete_request_id IS NOT NULL OR NEW.admin_delete_audit_id IS NOT NULL OR NEW.publication_transaction<>pg_current_xact_id() THEN
   RAISE EXCEPTION 'Invalid reply publication' USING ERRCODE='23514';END IF;
  IF NEW.reply_to_id IS NOT NULL THEN
   SELECT * INTO p FROM whaleu_ratings.replies WHERE id=NEW.reply_to_id AND root_id=NEW.root_id AND target_id=NEW.target_id FOR SHARE NOWAIT;
   IF p.id IS NULL OR p.deleted_at IS NOT NULL OR p.ordinal>=NEW.ordinal THEN RAISE EXCEPTION 'Invalid direct reply ancestry' USING ERRCODE='23514';END IF;
  END IF;
  NEW.created_at:=clock_timestamp();op:='create_reply';key:=NEW.request_id;
 END IF;
 SELECT * INTO command FROM whaleu_ratings.requests WHERE account_id=NEW.account_id AND request_id=key FOR UPDATE NOWAIT;
 IF command.operation IS DISTINCT FROM op OR command.receipt IS NOT NULL THEN RAISE EXCEPTION 'Invalid reply command' USING ERRCODE='23514';END IF;RETURN NEW;
END;
 END IF;
END $dispatch$;

-- Same-OID typed dispatcher; the following ELSE retains the complete legacy body.
CREATE OR REPLACE FUNCTION whaleu_ratings.comment_transition_source() RETURNS trigger LANGUAGE plpgsql AS $dispatch$
BEGIN
 IF whaleu_ratings.scoped_registered_request(NEW.account_id,NEW.request_id) THEN

DECLARE r whaleu_ratings.comments;q whaleu_ratings.requests;a whaleu_ratings.admin_delete_audits;
BEGIN
 SELECT * INTO r FROM whaleu_ratings.comments WHERE id=NEW.comment_id;
 IF pg_trigger_depth()<2 OR r.id IS NULL OR NEW.mutation_transaction<>pg_current_xact_id()
  OR (NEW.comment_id,NEW.target_id,NEW.account_id,NEW.revision) IS DISTINCT FROM (r.id,r.target_id,r.account_id,r.revision) THEN
  RAISE EXCEPTION 'Comment transition source mismatch' USING ERRCODE='23514';END IF;
 IF NEW.admin_delete_audit_id IS NOT NULL THEN
  SELECT * INTO a FROM whaleu_ratings.admin_delete_audits WHERE id=NEW.admin_delete_audit_id;
  SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=a.actor_account_id AND request_id=a.request_id FOR UPDATE NOWAIT;
 q:=whaleu_ratings.scoped_domain_request(q.account_id,q.request_id);
  IF NEW.operation<>'delete_comment' OR NEW.request_id IS NOT NULL OR r.delete_request_id IS NOT NULL OR a.id IS NULL OR a.outcome<>'applied'
   OR a.mutation_transaction<>pg_current_xact_id() OR q.operation IS DISTINCT FROM 'admin_delete_comment' OR q.receipt IS NOT NULL OR q.intent_hash IS DISTINCT FROM a.intent_hash
   OR (a.subject_kind,a.target_id,a.root_id,a.subject_id,a.author_account_id,a.after_revision,a.occurred_at,a.id)
    IS DISTINCT FROM ('comment'::text,r.target_id,r.id,r.id,r.account_id,r.revision,r.deleted_at,r.admin_delete_audit_id)
   OR NEW.occurred_at IS DISTINCT FROM r.deleted_at THEN
   RAISE EXCEPTION 'Administrator comment transition source mismatch' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=NEW.account_id AND request_id=NEW.request_id FOR UPDATE NOWAIT;
 q:=whaleu_ratings.scoped_domain_request(q.account_id,q.request_id);
  IF q.operation IS DISTINCT FROM NEW.operation OR q.receipt IS NOT NULL OR r.admin_delete_audit_id IS NOT NULL
   OR (NEW.operation='create_comment' AND (r.publication_transaction<>pg_current_xact_id() OR r.deleted_at IS NOT NULL OR (NEW.request_id,NEW.occurred_at) IS DISTINCT FROM (r.request_id,r.created_at)))
   OR (NEW.operation='delete_comment' AND (r.deleted_at IS NULL OR (NEW.request_id,NEW.occurred_at) IS DISTINCT FROM (r.delete_request_id,r.deleted_at))) THEN
   RAISE EXCEPTION 'Comment transition source mismatch' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END;
 ELSE

DECLARE r whaleu_ratings.comments;q whaleu_ratings.requests;a whaleu_ratings.admin_delete_audits;
BEGIN
 SELECT * INTO r FROM whaleu_ratings.comments WHERE id=NEW.comment_id;
 IF pg_trigger_depth()<2 OR r.id IS NULL OR NEW.mutation_transaction<>pg_current_xact_id()
  OR (NEW.comment_id,NEW.target_id,NEW.account_id,NEW.revision) IS DISTINCT FROM (r.id,r.target_id,r.account_id,r.revision) THEN
  RAISE EXCEPTION 'Comment transition source mismatch' USING ERRCODE='23514';END IF;
 IF NEW.admin_delete_audit_id IS NOT NULL THEN
  SELECT * INTO a FROM whaleu_ratings.admin_delete_audits WHERE id=NEW.admin_delete_audit_id;
  SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=a.actor_account_id AND request_id=a.request_id FOR UPDATE NOWAIT;
  IF NEW.operation<>'delete_comment' OR NEW.request_id IS NOT NULL OR r.delete_request_id IS NOT NULL OR a.id IS NULL OR a.outcome<>'applied'
   OR a.mutation_transaction<>pg_current_xact_id() OR q.operation IS DISTINCT FROM 'admin_delete_comment' OR q.receipt IS NOT NULL OR q.intent_hash IS DISTINCT FROM a.intent_hash
   OR (a.subject_kind,a.target_id,a.root_id,a.subject_id,a.author_account_id,a.after_revision,a.occurred_at,a.id)
    IS DISTINCT FROM ('comment'::text,r.target_id,r.id,r.id,r.account_id,r.revision,r.deleted_at,r.admin_delete_audit_id)
   OR NEW.occurred_at IS DISTINCT FROM r.deleted_at THEN
   RAISE EXCEPTION 'Administrator comment transition source mismatch' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=NEW.account_id AND request_id=NEW.request_id FOR UPDATE NOWAIT;
  IF q.operation IS DISTINCT FROM NEW.operation OR q.receipt IS NOT NULL OR r.admin_delete_audit_id IS NOT NULL
   OR (NEW.operation='create_comment' AND (r.publication_transaction<>pg_current_xact_id() OR r.deleted_at IS NOT NULL OR (NEW.request_id,NEW.occurred_at) IS DISTINCT FROM (r.request_id,r.created_at)))
   OR (NEW.operation='delete_comment' AND (r.deleted_at IS NULL OR (NEW.request_id,NEW.occurred_at) IS DISTINCT FROM (r.delete_request_id,r.deleted_at))) THEN
   RAISE EXCEPTION 'Comment transition source mismatch' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END;
 END IF;
END $dispatch$;

-- Same-OID typed dispatcher; the following ELSE retains the complete legacy body.
CREATE OR REPLACE FUNCTION whaleu_ratings.reply_transition_source() RETURNS trigger LANGUAGE plpgsql AS $dispatch$
BEGIN
 IF whaleu_ratings.scoped_registered_request(NEW.account_id,NEW.request_id) THEN

DECLARE r whaleu_ratings.replies;q whaleu_ratings.requests;a whaleu_ratings.admin_delete_audits;
BEGIN
 SELECT * INTO r FROM whaleu_ratings.replies WHERE id=NEW.reply_id;
 IF pg_trigger_depth()<2 OR r.id IS NULL OR NEW.mutation_transaction<>pg_current_xact_id()
  OR (NEW.reply_id,NEW.root_id,NEW.target_id,NEW.account_id,NEW.revision) IS DISTINCT FROM (r.id,r.root_id,r.target_id,r.account_id,r.revision) THEN
  RAISE EXCEPTION 'Reply transition source mismatch' USING ERRCODE='23514';END IF;
 IF NEW.admin_delete_audit_id IS NOT NULL THEN
  SELECT * INTO a FROM whaleu_ratings.admin_delete_audits WHERE id=NEW.admin_delete_audit_id;
  SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=a.actor_account_id AND request_id=a.request_id FOR UPDATE NOWAIT;
 q:=whaleu_ratings.scoped_domain_request(q.account_id,q.request_id);
  IF NEW.operation<>'delete_reply' OR NEW.request_id IS NOT NULL OR r.delete_request_id IS NOT NULL OR a.id IS NULL OR a.outcome<>'applied'
   OR a.mutation_transaction<>pg_current_xact_id() OR q.operation IS DISTINCT FROM 'admin_delete_reply' OR q.receipt IS NOT NULL OR q.intent_hash IS DISTINCT FROM a.intent_hash
   OR (a.subject_kind,a.target_id,a.root_id,a.subject_id,a.author_account_id,a.after_revision,a.occurred_at,a.id)
    IS DISTINCT FROM ('reply'::text,r.target_id,r.root_id,r.id,r.account_id,r.revision,r.deleted_at,r.admin_delete_audit_id)
   OR NEW.occurred_at IS DISTINCT FROM r.deleted_at THEN
   RAISE EXCEPTION 'Administrator reply transition source mismatch' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=NEW.account_id AND request_id=NEW.request_id FOR UPDATE NOWAIT;
 q:=whaleu_ratings.scoped_domain_request(q.account_id,q.request_id);
  IF q.operation IS DISTINCT FROM NEW.operation OR q.receipt IS NOT NULL OR r.admin_delete_audit_id IS NOT NULL
   OR (NEW.operation='create_reply' AND (r.publication_transaction<>pg_current_xact_id() OR r.deleted_at IS NOT NULL OR (NEW.request_id,NEW.occurred_at) IS DISTINCT FROM (r.request_id,r.created_at)))
   OR (NEW.operation='delete_reply' AND (r.deleted_at IS NULL OR (NEW.request_id,NEW.occurred_at) IS DISTINCT FROM (r.delete_request_id,r.deleted_at))) THEN
   RAISE EXCEPTION 'Reply transition source mismatch' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END;
 ELSE

DECLARE r whaleu_ratings.replies;q whaleu_ratings.requests;a whaleu_ratings.admin_delete_audits;
BEGIN
 SELECT * INTO r FROM whaleu_ratings.replies WHERE id=NEW.reply_id;
 IF pg_trigger_depth()<2 OR r.id IS NULL OR NEW.mutation_transaction<>pg_current_xact_id()
  OR (NEW.reply_id,NEW.root_id,NEW.target_id,NEW.account_id,NEW.revision) IS DISTINCT FROM (r.id,r.root_id,r.target_id,r.account_id,r.revision) THEN
  RAISE EXCEPTION 'Reply transition source mismatch' USING ERRCODE='23514';END IF;
 IF NEW.admin_delete_audit_id IS NOT NULL THEN
  SELECT * INTO a FROM whaleu_ratings.admin_delete_audits WHERE id=NEW.admin_delete_audit_id;
  SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=a.actor_account_id AND request_id=a.request_id FOR UPDATE NOWAIT;
  IF NEW.operation<>'delete_reply' OR NEW.request_id IS NOT NULL OR r.delete_request_id IS NOT NULL OR a.id IS NULL OR a.outcome<>'applied'
   OR a.mutation_transaction<>pg_current_xact_id() OR q.operation IS DISTINCT FROM 'admin_delete_reply' OR q.receipt IS NOT NULL OR q.intent_hash IS DISTINCT FROM a.intent_hash
   OR (a.subject_kind,a.target_id,a.root_id,a.subject_id,a.author_account_id,a.after_revision,a.occurred_at,a.id)
    IS DISTINCT FROM ('reply'::text,r.target_id,r.root_id,r.id,r.account_id,r.revision,r.deleted_at,r.admin_delete_audit_id)
   OR NEW.occurred_at IS DISTINCT FROM r.deleted_at THEN
   RAISE EXCEPTION 'Administrator reply transition source mismatch' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=NEW.account_id AND request_id=NEW.request_id FOR UPDATE NOWAIT;
  IF q.operation IS DISTINCT FROM NEW.operation OR q.receipt IS NOT NULL OR r.admin_delete_audit_id IS NOT NULL
   OR (NEW.operation='create_reply' AND (r.publication_transaction<>pg_current_xact_id() OR r.deleted_at IS NOT NULL OR (NEW.request_id,NEW.occurred_at) IS DISTINCT FROM (r.request_id,r.created_at)))
   OR (NEW.operation='delete_reply' AND (r.deleted_at IS NULL OR (NEW.request_id,NEW.occurred_at) IS DISTINCT FROM (r.delete_request_id,r.deleted_at))) THEN
   RAISE EXCEPTION 'Reply transition source mismatch' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END;
 END IF;
END $dispatch$;

-- Same-OID typed dispatcher; the following ELSE retains the complete legacy body.
CREATE OR REPLACE FUNCTION whaleu_ratings.like_transition_complete() RETURNS trigger LANGUAGE plpgsql AS $dispatch$
BEGIN
 IF whaleu_ratings.scoped_registered_request(NEW.account_id,NEW.request_id) THEN

DECLARE m whaleu_ratings.like_memberships;state whaleu_ratings.like_states;head whaleu_ratings.like_transitions;actor_head whaleu_ratings.like_transitions;q whaleu_ratings.requests;
BEGIN SELECT * INTO m FROM whaleu_ratings.like_memberships WHERE subject_id=NEW.subject_id AND account_id=NEW.account_id;SELECT * INTO state FROM whaleu_ratings.like_states WHERE subject_id=NEW.subject_id;SELECT * INTO head FROM whaleu_ratings.like_transitions WHERE id=state.head_id;SELECT * INTO actor_head FROM whaleu_ratings.like_transitions WHERE id=m.last_transition_id;SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=NEW.account_id AND request_id=NEW.request_id;
 q:=whaleu_ratings.scoped_domain_request(q.account_id,q.request_id);
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.effect_events e WHERE e.like_transition_id=NEW.id AND e.source_version=2 AND (e.actor_account_id,e.request_id,e.target_id,e.root_id,e.reply_id,e.occurred_at,e.mutation_transaction) IS NOT DISTINCT FROM (NEW.account_id,NEW.request_id,NEW.target_id,NEW.root_id,NEW.reply_id,NEW.occurred_at,NEW.mutation_transaction)) OR q.receipt->>'outcome' IS DISTINCT FROM 'applied' OR q.receipt->>'revision' IS DISTINCT FROM NEW.new_revision::text OR actor_head.id IS NULL OR actor_head.sequence<NEW.sequence OR (actor_head.subject_id,actor_head.account_id,actor_head.new_revision,actor_head.new_active_like_id,actor_head.occurred_at) IS DISTINCT FROM (m.subject_id,m.account_id,m.revision,m.active_like_id,m.updated_at) OR (m.last_transition_id<>NEW.id AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.like_transitions next WHERE next.previous_actor_transition_id=NEW.id AND (next.subject_id,next.account_id,next.old_revision,next.old_active_like_id) IS NOT DISTINCT FROM (NEW.subject_id,NEW.account_id,NEW.new_revision,NEW.new_active_like_id))) OR (state.head_id<>NEW.id AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.like_transitions next WHERE next.previous_head_id=NEW.id AND (next.subject_id,next.previous_count)=(NEW.subject_id,NEW.new_count))) OR head.id IS NULL OR head.sequence<NEW.sequence OR (head.subject_id,head.new_count,head.sequence) IS DISTINCT FROM (state.subject_id,state.count,state.sequence) THEN RAISE EXCEPTION 'Like transition projection incomplete' USING ERRCODE='23514';END IF;RETURN NULL;
END;
 ELSE

DECLARE m whaleu_ratings.like_memberships;state whaleu_ratings.like_states;head whaleu_ratings.like_transitions;actor_head whaleu_ratings.like_transitions;q whaleu_ratings.requests;
BEGIN SELECT * INTO m FROM whaleu_ratings.like_memberships WHERE subject_id=NEW.subject_id AND account_id=NEW.account_id;SELECT * INTO state FROM whaleu_ratings.like_states WHERE subject_id=NEW.subject_id;SELECT * INTO head FROM whaleu_ratings.like_transitions WHERE id=state.head_id;SELECT * INTO actor_head FROM whaleu_ratings.like_transitions WHERE id=m.last_transition_id;SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=NEW.account_id AND request_id=NEW.request_id;
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.effect_events e WHERE e.like_transition_id=NEW.id AND e.source_version=2 AND (e.actor_account_id,e.request_id,e.target_id,e.root_id,e.reply_id,e.occurred_at,e.mutation_transaction) IS NOT DISTINCT FROM (NEW.account_id,NEW.request_id,NEW.target_id,NEW.root_id,NEW.reply_id,NEW.occurred_at,NEW.mutation_transaction)) OR q.receipt->>'outcome' IS DISTINCT FROM 'applied' OR q.receipt->>'revision' IS DISTINCT FROM NEW.new_revision::text OR actor_head.id IS NULL OR actor_head.sequence<NEW.sequence OR (actor_head.subject_id,actor_head.account_id,actor_head.new_revision,actor_head.new_active_like_id,actor_head.occurred_at) IS DISTINCT FROM (m.subject_id,m.account_id,m.revision,m.active_like_id,m.updated_at) OR (m.last_transition_id<>NEW.id AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.like_transitions next WHERE next.previous_actor_transition_id=NEW.id AND (next.subject_id,next.account_id,next.old_revision,next.old_active_like_id) IS NOT DISTINCT FROM (NEW.subject_id,NEW.account_id,NEW.new_revision,NEW.new_active_like_id))) OR (state.head_id<>NEW.id AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.like_transitions next WHERE next.previous_head_id=NEW.id AND (next.subject_id,next.previous_count)=(NEW.subject_id,NEW.new_count))) OR head.id IS NULL OR head.sequence<NEW.sequence OR (head.subject_id,head.new_count,head.sequence) IS DISTINCT FROM (state.subject_id,state.count,state.sequence) THEN RAISE EXCEPTION 'Like transition projection incomplete' USING ERRCODE='23514';END IF;RETURN NULL;
END;
 END IF;
END $dispatch$;

-- Same-OID typed dispatcher; the following ELSE retains the complete legacy body.
CREATE OR REPLACE FUNCTION whaleu_ratings.subscription_transition_complete() RETURNS trigger LANGUAGE plpgsql AS $dispatch$
BEGIN
 IF whaleu_ratings.scoped_registered_request(NEW.account_id,NEW.request_id) THEN

DECLARE m whaleu_ratings.subscription_memberships;s whaleu_ratings.subscription_states;h whaleu_ratings.subscription_transitions;a whaleu_ratings.subscription_transitions;q whaleu_ratings.requests;
BEGIN
 SELECT * INTO m FROM whaleu_ratings.subscription_memberships WHERE target_id=NEW.target_id AND account_id=NEW.account_id;SELECT * INTO s FROM whaleu_ratings.subscription_states WHERE target_id=NEW.target_id;SELECT * INTO h FROM whaleu_ratings.subscription_transitions WHERE id=s.head_transition_id;SELECT * INTO a FROM whaleu_ratings.subscription_transitions WHERE id=m.last_transition_id;SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=NEW.account_id AND request_id=NEW.request_id;
 q:=whaleu_ratings.scoped_domain_request(q.account_id,q.request_id);
 IF q.receipt->>'outcome' IS DISTINCT FROM 'applied' OR q.receipt->>'revision' IS DISTINCT FROM NEW.new_revision::text OR a.id IS NULL OR a.target_order<NEW.target_order OR (a.target_id,a.account_id,a.new_revision,a.new_epoch_id,a.occurred_at) IS DISTINCT FROM (m.target_id,m.account_id,m.revision,m.active_epoch_id,m.updated_at) OR (m.last_transition_id<>NEW.id AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.subscription_transitions WHERE previous_actor_transition_id=NEW.id AND (target_id,account_id,old_revision,old_epoch_id) IS NOT DISTINCT FROM (NEW.target_id,NEW.account_id,NEW.new_revision,NEW.new_epoch_id))) OR h.id IS NULL OR h.target_order<NEW.target_order OR (h.target_id,h.new_count,h.target_order) IS DISTINCT FROM (s.target_id,s.count,s.target_order) OR (s.head_transition_id<>NEW.id AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.subscription_transitions WHERE previous_target_transition_id=NEW.id AND (target_id,previous_count)=(NEW.target_id,NEW.new_count))) THEN RAISE EXCEPTION 'Subscription history projection incomplete' USING ERRCODE='23514';END IF;
 IF (NEW.delta=1 AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.subscription_epochs WHERE id=NEW.id AND (target_id,account_id,start_order)=(NEW.target_id,NEW.account_id,NEW.target_order))) OR (NEW.delta=-1 AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.subscription_epoch_closures WHERE transition_id=NEW.id AND (epoch_id,target_id,account_id,end_order)=(NEW.old_epoch_id,NEW.target_id,NEW.account_id,NEW.target_order))) THEN RAISE EXCEPTION 'Subscription epoch projection incomplete' USING ERRCODE='23514';END IF;RETURN NULL;
END;
 ELSE

DECLARE m whaleu_ratings.subscription_memberships;s whaleu_ratings.subscription_states;h whaleu_ratings.subscription_transitions;a whaleu_ratings.subscription_transitions;q whaleu_ratings.requests;
BEGIN
 SELECT * INTO m FROM whaleu_ratings.subscription_memberships WHERE target_id=NEW.target_id AND account_id=NEW.account_id;SELECT * INTO s FROM whaleu_ratings.subscription_states WHERE target_id=NEW.target_id;SELECT * INTO h FROM whaleu_ratings.subscription_transitions WHERE id=s.head_transition_id;SELECT * INTO a FROM whaleu_ratings.subscription_transitions WHERE id=m.last_transition_id;SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=NEW.account_id AND request_id=NEW.request_id;
 IF q.receipt->>'outcome' IS DISTINCT FROM 'applied' OR q.receipt->>'revision' IS DISTINCT FROM NEW.new_revision::text OR a.id IS NULL OR a.target_order<NEW.target_order OR (a.target_id,a.account_id,a.new_revision,a.new_epoch_id,a.occurred_at) IS DISTINCT FROM (m.target_id,m.account_id,m.revision,m.active_epoch_id,m.updated_at) OR (m.last_transition_id<>NEW.id AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.subscription_transitions WHERE previous_actor_transition_id=NEW.id AND (target_id,account_id,old_revision,old_epoch_id) IS NOT DISTINCT FROM (NEW.target_id,NEW.account_id,NEW.new_revision,NEW.new_epoch_id))) OR h.id IS NULL OR h.target_order<NEW.target_order OR (h.target_id,h.new_count,h.target_order) IS DISTINCT FROM (s.target_id,s.count,s.target_order) OR (s.head_transition_id<>NEW.id AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.subscription_transitions WHERE previous_target_transition_id=NEW.id AND (target_id,previous_count)=(NEW.target_id,NEW.new_count))) THEN RAISE EXCEPTION 'Subscription history projection incomplete' USING ERRCODE='23514';END IF;
 IF (NEW.delta=1 AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.subscription_epochs WHERE id=NEW.id AND (target_id,account_id,start_order)=(NEW.target_id,NEW.account_id,NEW.target_order))) OR (NEW.delta=-1 AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.subscription_epoch_closures WHERE transition_id=NEW.id AND (epoch_id,target_id,account_id,end_order)=(NEW.old_epoch_id,NEW.target_id,NEW.account_id,NEW.target_order))) THEN RAISE EXCEPTION 'Subscription epoch projection incomplete' USING ERRCODE='23514';END IF;RETURN NULL;
END;
 END IF;
END $dispatch$;

-- Same-OID typed dispatcher; the following ELSE retains the complete legacy body.
CREATE OR REPLACE FUNCTION whaleu_ratings.effect_guard() RETURNS trigger LANGUAGE plpgsql AS $dispatch$
BEGIN
 IF whaleu_ratings.scoped_registered_request(NEW.actor_account_id,NEW.request_id) THEN

DECLARE c whaleu_ratings.comment_transitions;r whaleu_ratings.reply_transitions;root whaleu_ratings.comments;reply whaleu_ratings.replies;direct whaleu_ratings.replies;t whaleu_ratings.targets;kind text;expected_actor uuid;expected_request uuid;occurred timestamptz;xid xid8;mode text;q whaleu_ratings.requests;
BEGIN
 IF pg_trigger_depth()<2 THEN RAISE EXCEPTION 'Effect requires a fresh content transition' USING ERRCODE='23514';END IF;
 SELECT * INTO root FROM whaleu_ratings.comments WHERE id=NEW.root_id AND target_id=NEW.target_id;
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=NEW.target_id;
 IF NEW.comment_transition_id IS NOT NULL THEN SELECT * INTO c FROM whaleu_ratings.comment_transitions WHERE id=NEW.comment_transition_id;
 kind:=CASE c.operation WHEN 'create_comment' THEN 'root_created' ELSE 'root_deleted' END;expected_actor:=c.account_id;expected_request:=c.request_id;occurred:=c.occurred_at;xid:=c.mutation_transaction;mode:=root.author_mode;
 IF (c.comment_id,c.target_id) IS DISTINCT FROM (NEW.root_id,NEW.target_id) THEN RAISE EXCEPTION 'Effect root mismatch' USING ERRCODE='23514';END IF;
 ELSE SELECT * INTO r FROM whaleu_ratings.reply_transitions WHERE id=NEW.reply_transition_id;
 SELECT * INTO reply FROM whaleu_ratings.replies WHERE id=r.reply_id;SELECT * INTO direct FROM whaleu_ratings.replies WHERE id=reply.reply_to_id;
 kind:=CASE r.operation WHEN 'create_reply' THEN 'reply_created' ELSE 'reply_deleted' END;expected_actor:=r.account_id;expected_request:=r.request_id;occurred:=r.occurred_at;xid:=r.mutation_transaction;mode:=reply.author_mode;
 IF (r.reply_id,r.root_id,r.target_id,reply.reply_to_id) IS DISTINCT FROM (NEW.reply_id,NEW.root_id,NEW.target_id,NEW.reply_to_id) THEN RAISE EXCEPTION 'Effect reply mismatch' USING ERRCODE='23514';END IF;END IF;
 IF xid IS DISTINCT FROM pg_current_xact_id() OR ROW(NEW.event_kind,NEW.actor_account_id,NEW.request_id,NEW.occurred_at,NEW.mutation_transaction,NEW.author_mode,NEW.root_author_id,NEW.direct_reply_author_id,NEW.region_id) IS DISTINCT FROM ROW(kind,expected_actor,expected_request,occurred,xid,mode,root.account_id,direct.account_id,t.region_id) THEN RAISE EXCEPTION 'Effect source mismatch' USING ERRCODE='23514';END IF;
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=expected_actor AND request_id=expected_request;
 q:=whaleu_ratings.scoped_domain_request(q.account_id,q.request_id);
 IF q.receipt IS NOT NULL OR q.operation IS DISTINCT FROM (CASE kind WHEN 'root_created' THEN 'create_comment' WHEN 'root_deleted' THEN 'delete_comment' WHEN 'reply_created' THEN 'create_reply' ELSE 'delete_reply' END) THEN RAISE EXCEPTION 'Effect command is not fresh' USING ERRCODE='23514';END IF;
 IF kind='root_created' AND (root.account_id IS DISTINCT FROM c.account_id OR root.publication_transaction<>pg_current_xact_id() OR root.deleted_at IS NOT NULL OR (root.request_id,root.created_at,root.revision) IS DISTINCT FROM (c.request_id,c.occurred_at,c.revision)) THEN RAISE EXCEPTION 'Effect root publication mismatch' USING ERRCODE='23514';END IF;
 IF kind='root_deleted' AND (root.account_id IS DISTINCT FROM c.account_id OR root.deleted_at IS NULL OR (root.delete_request_id,root.deleted_at,root.revision) IS DISTINCT FROM (c.request_id,c.occurred_at,c.revision)) THEN RAISE EXCEPTION 'Effect root deletion mismatch' USING ERRCODE='23514';END IF;
 NEW.expected_experience_units:=CASE WHEN kind LIKE '%_deleted' THEN 0 WHEN kind='root_created' OR coalesce(direct.account_id,root.account_id)=expected_actor THEN 1 ELSE 2 END;
 NEW.expected_direct_notice_obligations:=CASE WHEN kind<>'reply_created' THEN 0 ELSE (root.account_id<>expected_actor AND root.account_id IS DISTINCT FROM direct.account_id)::integer+coalesce((direct.account_id<>expected_actor)::integer,0) END;
 RETURN NEW;
END;
 ELSE

DECLARE c whaleu_ratings.comment_transitions;r whaleu_ratings.reply_transitions;root whaleu_ratings.comments;reply whaleu_ratings.replies;direct whaleu_ratings.replies;t whaleu_ratings.targets;kind text;expected_actor uuid;expected_request uuid;occurred timestamptz;xid xid8;mode text;q whaleu_ratings.requests;
BEGIN
 IF pg_trigger_depth()<2 THEN RAISE EXCEPTION 'Effect requires a fresh content transition' USING ERRCODE='23514';END IF;
 SELECT * INTO root FROM whaleu_ratings.comments WHERE id=NEW.root_id AND target_id=NEW.target_id;
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=NEW.target_id;
 IF NEW.comment_transition_id IS NOT NULL THEN SELECT * INTO c FROM whaleu_ratings.comment_transitions WHERE id=NEW.comment_transition_id;
 kind:=CASE c.operation WHEN 'create_comment' THEN 'root_created' ELSE 'root_deleted' END;expected_actor:=c.account_id;expected_request:=c.request_id;occurred:=c.occurred_at;xid:=c.mutation_transaction;mode:=root.author_mode;
 IF (c.comment_id,c.target_id) IS DISTINCT FROM (NEW.root_id,NEW.target_id) THEN RAISE EXCEPTION 'Effect root mismatch' USING ERRCODE='23514';END IF;
 ELSE SELECT * INTO r FROM whaleu_ratings.reply_transitions WHERE id=NEW.reply_transition_id;
 SELECT * INTO reply FROM whaleu_ratings.replies WHERE id=r.reply_id;SELECT * INTO direct FROM whaleu_ratings.replies WHERE id=reply.reply_to_id;
 kind:=CASE r.operation WHEN 'create_reply' THEN 'reply_created' ELSE 'reply_deleted' END;expected_actor:=r.account_id;expected_request:=r.request_id;occurred:=r.occurred_at;xid:=r.mutation_transaction;mode:=reply.author_mode;
 IF (r.reply_id,r.root_id,r.target_id,reply.reply_to_id) IS DISTINCT FROM (NEW.reply_id,NEW.root_id,NEW.target_id,NEW.reply_to_id) THEN RAISE EXCEPTION 'Effect reply mismatch' USING ERRCODE='23514';END IF;END IF;
 IF xid IS DISTINCT FROM pg_current_xact_id() OR ROW(NEW.event_kind,NEW.actor_account_id,NEW.request_id,NEW.occurred_at,NEW.mutation_transaction,NEW.author_mode,NEW.root_author_id,NEW.direct_reply_author_id,NEW.region_id) IS DISTINCT FROM ROW(kind,expected_actor,expected_request,occurred,xid,mode,root.account_id,direct.account_id,t.region_id) THEN RAISE EXCEPTION 'Effect source mismatch' USING ERRCODE='23514';END IF;
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=expected_actor AND request_id=expected_request;
 IF q.receipt IS NOT NULL OR q.operation IS DISTINCT FROM (CASE kind WHEN 'root_created' THEN 'create_comment' WHEN 'root_deleted' THEN 'delete_comment' WHEN 'reply_created' THEN 'create_reply' ELSE 'delete_reply' END) THEN RAISE EXCEPTION 'Effect command is not fresh' USING ERRCODE='23514';END IF;
 IF kind='root_created' AND (root.account_id IS DISTINCT FROM c.account_id OR root.publication_transaction<>pg_current_xact_id() OR root.deleted_at IS NOT NULL OR (root.request_id,root.created_at,root.revision) IS DISTINCT FROM (c.request_id,c.occurred_at,c.revision)) THEN RAISE EXCEPTION 'Effect root publication mismatch' USING ERRCODE='23514';END IF;
 IF kind='root_deleted' AND (root.account_id IS DISTINCT FROM c.account_id OR root.deleted_at IS NULL OR (root.delete_request_id,root.deleted_at,root.revision) IS DISTINCT FROM (c.request_id,c.occurred_at,c.revision)) THEN RAISE EXCEPTION 'Effect root deletion mismatch' USING ERRCODE='23514';END IF;
 NEW.expected_experience_units:=CASE WHEN kind LIKE '%_deleted' THEN 0 WHEN kind='root_created' OR coalesce(direct.account_id,root.account_id)=expected_actor THEN 1 ELSE 2 END;
 NEW.expected_direct_notice_obligations:=CASE WHEN kind<>'reply_created' THEN 0 ELSE (root.account_id<>expected_actor AND root.account_id IS DISTINCT FROM direct.account_id)::integer+coalesce((direct.account_id<>expected_actor)::integer,0) END;
 RETURN NEW;
END;
 END IF;
END $dispatch$;

-- Same-OID typed dispatcher; the following ELSE retains the complete legacy body.
CREATE OR REPLACE FUNCTION whaleu_ratings.like_effect_guard() RETURNS trigger LANGUAGE plpgsql AS $dispatch$
BEGIN
 IF whaleu_ratings.scoped_registered_request(NEW.actor_account_id,NEW.request_id) THEN

DECLARE t whaleu_ratings.like_transitions;s whaleu_ratings.like_subjects;c whaleu_ratings.comments;r whaleu_ratings.replies;target whaleu_ratings.targets;q whaleu_ratings.requests;author uuid;mode text;
BEGIN SELECT * INTO t FROM whaleu_ratings.like_transitions WHERE id=NEW.like_transition_id;SELECT * INTO s FROM whaleu_ratings.like_subjects WHERE id=t.subject_id;SELECT * INTO c FROM whaleu_ratings.comments WHERE id=t.root_id;SELECT * INTO r FROM whaleu_ratings.replies WHERE id=t.reply_id;SELECT * INTO target FROM whaleu_ratings.targets WHERE id=t.target_id;SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=t.account_id AND request_id=t.request_id;
 q:=whaleu_ratings.scoped_domain_request(q.account_id,q.request_id);author:=CASE s.kind WHEN 'comment' THEN c.account_id ELSE r.account_id END;mode:=CASE s.kind WHEN 'comment' THEN c.author_mode ELSE r.author_mode END;
 IF pg_trigger_depth()<2 OR t.id IS NULL OR t.mutation_transaction<>pg_current_xact_id() OR q.receipt IS NOT NULL OR q.operation IS DISTINCT FROM t.operation OR ROW(NEW.event_kind,NEW.target_id,NEW.root_id,NEW.reply_id,NEW.actor_account_id,NEW.root_author_id,NEW.subject_author_id,NEW.subject_author_mode,NEW.region_id,NEW.request_id,NEW.occurred_at,NEW.mutation_transaction) IS DISTINCT FROM ROW(CASE WHEN t.delta=1 THEN 'content_liked' ELSE 'content_unliked' END,t.target_id,t.root_id,t.reply_id,t.account_id,c.account_id,author,mode,target.region_id,t.request_id,t.occurred_at,t.mutation_transaction) THEN RAISE EXCEPTION 'Like effect exact source mismatch' USING ERRCODE='23514';END IF;
 NEW.expected_experience_units:=CASE WHEN t.delta=-1 THEN 0 WHEN author=t.account_id THEN 1 ELSE 2 END;NEW.expected_direct_notice_obligations:=CASE WHEN t.delta=1 AND author<>t.account_id THEN 1 ELSE 0 END;RETURN NEW;
END;
 ELSE

DECLARE t whaleu_ratings.like_transitions;s whaleu_ratings.like_subjects;c whaleu_ratings.comments;r whaleu_ratings.replies;target whaleu_ratings.targets;q whaleu_ratings.requests;author uuid;mode text;
BEGIN SELECT * INTO t FROM whaleu_ratings.like_transitions WHERE id=NEW.like_transition_id;SELECT * INTO s FROM whaleu_ratings.like_subjects WHERE id=t.subject_id;SELECT * INTO c FROM whaleu_ratings.comments WHERE id=t.root_id;SELECT * INTO r FROM whaleu_ratings.replies WHERE id=t.reply_id;SELECT * INTO target FROM whaleu_ratings.targets WHERE id=t.target_id;SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=t.account_id AND request_id=t.request_id;author:=CASE s.kind WHEN 'comment' THEN c.account_id ELSE r.account_id END;mode:=CASE s.kind WHEN 'comment' THEN c.author_mode ELSE r.author_mode END;
 IF pg_trigger_depth()<2 OR t.id IS NULL OR t.mutation_transaction<>pg_current_xact_id() OR q.receipt IS NOT NULL OR q.operation IS DISTINCT FROM t.operation OR ROW(NEW.event_kind,NEW.target_id,NEW.root_id,NEW.reply_id,NEW.actor_account_id,NEW.root_author_id,NEW.subject_author_id,NEW.subject_author_mode,NEW.region_id,NEW.request_id,NEW.occurred_at,NEW.mutation_transaction) IS DISTINCT FROM ROW(CASE WHEN t.delta=1 THEN 'content_liked' ELSE 'content_unliked' END,t.target_id,t.root_id,t.reply_id,t.account_id,c.account_id,author,mode,target.region_id,t.request_id,t.occurred_at,t.mutation_transaction) THEN RAISE EXCEPTION 'Like effect exact source mismatch' USING ERRCODE='23514';END IF;
 NEW.expected_experience_units:=CASE WHEN t.delta=-1 THEN 0 WHEN author=t.account_id THEN 1 ELSE 2 END;NEW.expected_direct_notice_obligations:=CASE WHEN t.delta=1 AND author<>t.account_id THEN 1 ELSE 0 END;RETURN NEW;
END;
 END IF;
END $dispatch$;

-- Same-OID typed dispatcher; the following ELSE retains the complete legacy body.
CREATE OR REPLACE FUNCTION whaleu_ratings.subscription_effect_guard() RETURNS trigger LANGUAGE plpgsql AS $dispatch$
BEGIN
 IF whaleu_ratings.scoped_registered_request(NEW.actor_account_id,NEW.request_id) THEN

DECLARE t whaleu_ratings.subscription_transitions;target whaleu_ratings.targets;q whaleu_ratings.requests;
BEGIN
 SELECT * INTO t FROM whaleu_ratings.subscription_transitions WHERE id=NEW.subscription_transition_id;
 SELECT * INTO target FROM whaleu_ratings.targets WHERE id=t.target_id;
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=t.account_id AND request_id=t.request_id;
 q:=whaleu_ratings.scoped_domain_request(q.account_id,q.request_id);
 IF pg_trigger_depth()<2 OR t.id IS NULL OR target.id IS NULL OR q.account_id IS NULL
  OR t.mutation_transaction IS DISTINCT FROM pg_current_xact_id()
  OR q.receipt IS NOT NULL OR q.operation IS DISTINCT FROM 'set_target_subscription'
  OR ROW(NEW.event_kind,NEW.target_id,NEW.actor_account_id,NEW.region_id,NEW.request_id,NEW.occurred_at,NEW.mutation_transaction)
   IS DISTINCT FROM ROW(CASE WHEN t.delta=1 THEN 'target_subscribed' ELSE 'target_unsubscribed' END,t.target_id,t.account_id,target.region_id,t.request_id,t.occurred_at,t.mutation_transaction)
 THEN RAISE EXCEPTION 'Subscription effect exact source mismatch' USING ERRCODE='23514';END IF;
 NEW.expected_experience_units:=CASE WHEN t.delta=1 THEN 1 ELSE 0 END;
 NEW.expected_direct_notice_obligations:=0;
 RETURN NEW;
END;
 ELSE

DECLARE t whaleu_ratings.subscription_transitions;target whaleu_ratings.targets;q whaleu_ratings.requests;
BEGIN
 SELECT * INTO t FROM whaleu_ratings.subscription_transitions WHERE id=NEW.subscription_transition_id;
 SELECT * INTO target FROM whaleu_ratings.targets WHERE id=t.target_id;
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=t.account_id AND request_id=t.request_id;
 IF pg_trigger_depth()<2 OR t.id IS NULL OR target.id IS NULL OR q.account_id IS NULL
  OR t.mutation_transaction IS DISTINCT FROM pg_current_xact_id()
  OR q.receipt IS NOT NULL OR q.operation IS DISTINCT FROM 'set_target_subscription'
  OR ROW(NEW.event_kind,NEW.target_id,NEW.actor_account_id,NEW.region_id,NEW.request_id,NEW.occurred_at,NEW.mutation_transaction)
   IS DISTINCT FROM ROW(CASE WHEN t.delta=1 THEN 'target_subscribed' ELSE 'target_unsubscribed' END,t.target_id,t.account_id,target.region_id,t.request_id,t.occurred_at,t.mutation_transaction)
 THEN RAISE EXCEPTION 'Subscription effect exact source mismatch' USING ERRCODE='23514';END IF;
 NEW.expected_experience_units:=CASE WHEN t.delta=1 THEN 1 ELSE 0 END;
 NEW.expected_direct_notice_obligations:=0;
 RETURN NEW;
END;
 END IF;
END $dispatch$;

-- Same-OID typed dispatcher; the following ELSE retains the complete legacy body.
CREATE OR REPLACE FUNCTION whaleu_ratings.lock_like_subject(subject uuid,actor uuid,request uuid) RETURNS whaleu_ratings.like_subjects LANGUAGE plpgsql AS $dispatch$
BEGIN
 IF whaleu_ratings.scoped_registered_request(actor,request) THEN

DECLARE s whaleu_ratings.like_subjects;q whaleu_ratings.requests;
BEGIN
 SELECT * INTO s FROM whaleu_ratings.like_subjects WHERE id=subject;
 IF s.id IS NULL THEN RAISE EXCEPTION 'Like coverage unavailable' USING ERRCODE='23514';END IF;
 PERFORM id FROM whaleu_ratings.targets WHERE id=s.target_id AND active FOR UPDATE NOWAIT;IF NOT FOUND THEN RAISE EXCEPTION 'Like target unavailable' USING ERRCODE='23514';END IF;
 PERFORM id FROM whaleu_ratings.comments WHERE id=s.root_id AND target_id=s.target_id AND deleted_at IS NULL FOR UPDATE NOWAIT;IF NOT FOUND THEN RAISE EXCEPTION 'Like root unavailable' USING ERRCODE='23514';END IF;
 IF s.reply_id IS NOT NULL THEN PERFORM id FROM whaleu_ratings.replies WHERE id=s.reply_id AND root_id=s.root_id AND target_id=s.target_id AND deleted_at IS NULL FOR UPDATE NOWAIT;IF NOT FOUND THEN RAISE EXCEPTION 'Like reply unavailable' USING ERRCODE='23514';END IF;END IF;
 PERFORM subject_id FROM whaleu_ratings.like_states WHERE subject_id=s.id FOR UPDATE NOWAIT;IF NOT FOUND THEN RAISE EXCEPTION 'Like state unavailable' USING ERRCODE='23514';END IF;
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=actor AND request_id=request FOR UPDATE NOWAIT;
 q:=whaleu_ratings.scoped_domain_request(q.account_id,q.request_id);
 IF q.operation IS DISTINCT FROM (CASE s.kind WHEN 'comment' THEN 'set_comment_like' ELSE 'set_reply_like' END) OR q.receipt IS NOT NULL THEN RAISE EXCEPTION 'Like command unavailable' USING ERRCODE='23514';END IF;RETURN s;
END;
 ELSE

DECLARE s whaleu_ratings.like_subjects;q whaleu_ratings.requests;
BEGIN
 SELECT * INTO s FROM whaleu_ratings.like_subjects WHERE id=subject;
 IF s.id IS NULL THEN RAISE EXCEPTION 'Like coverage unavailable' USING ERRCODE='23514';END IF;
 PERFORM id FROM whaleu_ratings.targets WHERE id=s.target_id AND active FOR UPDATE NOWAIT;IF NOT FOUND THEN RAISE EXCEPTION 'Like target unavailable' USING ERRCODE='23514';END IF;
 PERFORM id FROM whaleu_ratings.comments WHERE id=s.root_id AND target_id=s.target_id AND deleted_at IS NULL FOR UPDATE NOWAIT;IF NOT FOUND THEN RAISE EXCEPTION 'Like root unavailable' USING ERRCODE='23514';END IF;
 IF s.reply_id IS NOT NULL THEN PERFORM id FROM whaleu_ratings.replies WHERE id=s.reply_id AND root_id=s.root_id AND target_id=s.target_id AND deleted_at IS NULL FOR UPDATE NOWAIT;IF NOT FOUND THEN RAISE EXCEPTION 'Like reply unavailable' USING ERRCODE='23514';END IF;END IF;
 PERFORM subject_id FROM whaleu_ratings.like_states WHERE subject_id=s.id FOR UPDATE NOWAIT;IF NOT FOUND THEN RAISE EXCEPTION 'Like state unavailable' USING ERRCODE='23514';END IF;
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=actor AND request_id=request FOR UPDATE NOWAIT;
 IF q.operation IS DISTINCT FROM (CASE s.kind WHEN 'comment' THEN 'set_comment_like' ELSE 'set_reply_like' END) OR q.receipt IS NOT NULL THEN RAISE EXCEPTION 'Like command unavailable' USING ERRCODE='23514';END IF;RETURN s;
END;
 END IF;
END $dispatch$;

-- Same-OID typed dispatcher; the following ELSE retains the complete legacy body.
CREATE OR REPLACE FUNCTION whaleu_ratings.lock_subscription_target(target uuid,actor uuid,request uuid) RETURNS whaleu_ratings.subscription_baselines LANGUAGE plpgsql AS $dispatch$
BEGIN
 IF whaleu_ratings.scoped_registered_request(actor,request) THEN

DECLARE b whaleu_ratings.subscription_baselines;q whaleu_ratings.requests;
BEGIN
 PERFORM id FROM whaleu_ratings.targets WHERE id=target AND active FOR UPDATE NOWAIT;IF NOT FOUND THEN RAISE EXCEPTION 'Subscription target unavailable' USING ERRCODE='23514';END IF;
 SELECT * INTO b FROM whaleu_ratings.subscription_baselines WHERE target_id=target;
 PERFORM target_id FROM whaleu_ratings.subscription_states WHERE target_id=target FOR UPDATE NOWAIT;
 IF b.id IS NULL OR NOT FOUND THEN RAISE EXCEPTION 'Subscription coverage unavailable' USING ERRCODE='23514';END IF;
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=actor AND request_id=request FOR UPDATE NOWAIT;
 q:=whaleu_ratings.scoped_domain_request(q.account_id,q.request_id);
 IF q.operation IS DISTINCT FROM 'set_target_subscription' OR q.receipt IS NOT NULL THEN RAISE EXCEPTION 'Subscription request unavailable' USING ERRCODE='23514';END IF;RETURN b;
END;
 ELSE

DECLARE b whaleu_ratings.subscription_baselines;q whaleu_ratings.requests;
BEGIN
 PERFORM id FROM whaleu_ratings.targets WHERE id=target AND active FOR UPDATE NOWAIT;IF NOT FOUND THEN RAISE EXCEPTION 'Subscription target unavailable' USING ERRCODE='23514';END IF;
 SELECT * INTO b FROM whaleu_ratings.subscription_baselines WHERE target_id=target;
 PERFORM target_id FROM whaleu_ratings.subscription_states WHERE target_id=target FOR UPDATE NOWAIT;
 IF b.id IS NULL OR NOT FOUND THEN RAISE EXCEPTION 'Subscription coverage unavailable' USING ERRCODE='23514';END IF;
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=actor AND request_id=request FOR UPDATE NOWAIT;
 IF q.operation IS DISTINCT FROM 'set_target_subscription' OR q.receipt IS NOT NULL THEN RAISE EXCEPTION 'Subscription request unavailable' USING ERRCODE='23514';END IF;RETURN b;
END;
 END IF;
END $dispatch$;

CREATE FUNCTION whaleu_ratings.scoped_request_causal() RETURNS trigger LANGUAGE plpgsql AS $kernel$
DECLARE r whaleu_ratings.requests;s whaleu_ratings.score_transitions;c whaleu_ratings.comment_transitions;p whaleu_ratings.reply_transitions;n integer;keys text[];time timestamptz;
BEGIN
 SELECT * INTO r FROM whaleu_ratings.requests WHERE account_id=NEW.account_id AND request_id=NEW.request_id;
 r:=whaleu_ratings.scoped_domain_request(r.account_id,r.request_id);
 IF r.receipt IS NULL OR NOT coalesce(r.receipt->>'requestId'=r.request_id::text AND r.receipt->>'operation'=r.operation,false) THEN RAISE EXCEPTION 'Missing canonical receipt' USING ERRCODE='23514';END IF;
 SELECT array_agg(k ORDER BY k) INTO keys FROM jsonb_object_keys(r.receipt) k;
 SELECT * INTO s FROM whaleu_ratings.score_transitions WHERE account_id=r.account_id AND request_id=r.request_id;
 SELECT * INTO c FROM whaleu_ratings.comment_transitions WHERE account_id=r.account_id AND request_id=r.request_id;SELECT * INTO p FROM whaleu_ratings.reply_transitions WHERE account_id=r.account_id AND request_id=r.request_id;n:=(s.id IS NOT NULL)::integer+(c.id IS NOT NULL)::integer+(p.id IS NOT NULL)::integer;
 IF r.receipt->>'outcome'='rejected' THEN
 IF keys IS DISTINCT FROM ARRAY['code','operation','outcome','requestId'] OR n<>0 OR NOT coalesce(r.receipt->>'code' IN ('RATING_NOT_FOUND','RATING_REVISION_CONFLICT','PHONE_VERIFICATION_REQUIRED','AFFILIATION_VERIFICATION_REQUIRED','IDENTITY_CAMPUS_REQUIRED','SAFETY_ACTION_RESTRICTED','CONTENT_REJECTED'),false) THEN RAISE EXCEPTION 'Invalid rejected receipt' USING ERRCODE='23514';END IF;RETURN NULL;
 END IF;
 IF r.operation IN ('create_reply','delete_reply') THEN
 IF keys IS DISTINCT FROM ARRAY['occurredAt','operation','outcome','replyId','requestId','revision','rootId','targetId'] OR NOT coalesce(r.receipt->>'outcome' IN ('applied','noop'),false) OR NOT coalesce(r.receipt->>'occurredAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$',false) THEN RAISE EXCEPTION 'Invalid reply receipt' USING ERRCODE='23514';END IF;
 time:=(r.receipt->>'occurredAt')::timestamptz;
 IF r.receipt->>'outcome'='noop' THEN
 IF n<>0 OR r.operation<>'delete_reply' THEN RAISE EXCEPTION 'Invalid reply noop' USING ERRCODE='23514';END IF;
 SELECT * INTO p FROM whaleu_ratings.reply_transitions WHERE account_id=r.account_id AND reply_id::text=r.receipt->>'replyId' AND revision::text=r.receipt->>'revision' AND operation='delete_reply';
 ELSIF n<>1 THEN RAISE EXCEPTION 'Uncaused reply receipt' USING ERRCODE='23514';END IF;
 IF NOT coalesce(p.operation=r.operation AND p.revision::text=r.receipt->>'revision' AND p.target_id::text=r.receipt->>'targetId' AND p.root_id::text=r.receipt->>'rootId' AND p.reply_id::text=r.receipt->>'replyId' AND p.occurred_at=time,false) THEN RAISE EXCEPTION 'Reply receipt transition mismatch' USING ERRCODE='23514';END IF;RETURN NULL;
 END IF;
 IF keys IS DISTINCT FROM ARRAY['occurredAt','operation','outcome','requestId','revision','subjectId','targetId'] OR NOT coalesce(r.receipt->>'outcome' IN ('applied','noop'),false) OR NOT coalesce(r.receipt->>'occurredAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$',false) THEN RAISE EXCEPTION 'Invalid success receipt' USING ERRCODE='23514';END IF;
 time:=(r.receipt->>'occurredAt')::timestamptz;
 IF r.receipt->>'outcome'='noop' THEN
 IF n<>0 OR r.operation='create_comment' THEN RAISE EXCEPTION 'Invalid noop receipt' USING ERRCODE='23514';END IF;
 IF r.operation='set_score' THEN SELECT * INTO s FROM whaleu_ratings.score_transitions WHERE account_id=r.account_id AND target_id::text=r.receipt->>'targetId' AND new_revision::text=r.receipt->>'revision';
 ELSE SELECT * INTO c FROM whaleu_ratings.comment_transitions WHERE account_id=r.account_id AND comment_id::text=r.receipt->>'subjectId' AND revision::text=r.receipt->>'revision' AND operation='delete_comment';END IF;
 ELSE IF n<>1 THEN RAISE EXCEPTION 'Uncaused applied receipt' USING ERRCODE='23514';END IF;END IF;
 IF (r.operation='set_score' AND NOT coalesce(s.new_revision::text=r.receipt->>'revision' AND s.target_id::text=r.receipt->>'targetId' AND s.target_id::text=r.receipt->>'subjectId' AND s.occurred_at=time,false))
 OR (r.operation<>'set_score' AND NOT coalesce(c.revision::text=r.receipt->>'revision' AND c.target_id::text=r.receipt->>'targetId' AND c.comment_id::text=r.receipt->>'subjectId' AND c.operation=r.operation AND c.occurred_at=time,false)) THEN RAISE EXCEPTION 'Receipt transition mismatch' USING ERRCODE='23514';END IF;RETURN NULL;
END $kernel$;
CREATE CONSTRAINT TRIGGER scoped_request_causal AFTER INSERT OR UPDATE ON whaleu_ratings.requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.operation IN ('set_score_scoped','create_comment_scoped','create_reply_scoped') AND NEW.receipt->>'outcome'<>'closed') EXECUTE FUNCTION whaleu_ratings.scoped_request_causal();

CREATE FUNCTION whaleu_ratings.scoped_like_request_causal() RETURNS trigger LANGUAGE plpgsql AS $kernel$
DECLARE q whaleu_ratings.requests;t whaleu_ratings.like_transitions;n whaleu_ratings.like_noop_observations;s whaleu_ratings.like_subjects;keys text[];
BEGIN SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=NEW.account_id AND request_id=NEW.request_id;
 q:=whaleu_ratings.scoped_domain_request(q.account_id,q.request_id);SELECT * INTO t FROM whaleu_ratings.like_transitions WHERE account_id=q.account_id AND request_id=q.request_id;SELECT * INTO n FROM whaleu_ratings.like_noop_observations WHERE account_id=q.account_id AND request_id=q.request_id;SELECT array_agg(k ORDER BY k) INTO keys FROM jsonb_object_keys(q.receipt) k;
 IF q.receipt IS NULL OR q.receipt->>'requestId' IS DISTINCT FROM q.request_id::text OR q.receipt->>'operation' IS DISTINCT FROM q.operation OR EXISTS(SELECT 1 FROM whaleu_ratings.score_transitions WHERE account_id=q.account_id AND request_id=q.request_id) OR EXISTS(SELECT 1 FROM whaleu_ratings.comment_transitions WHERE account_id=q.account_id AND request_id=q.request_id) OR EXISTS(SELECT 1 FROM whaleu_ratings.reply_transitions WHERE account_id=q.account_id AND request_id=q.request_id) THEN RAISE EXCEPTION 'Invalid like receipt source' USING ERRCODE='23514';END IF;
 IF q.receipt->>'outcome'='rejected' THEN
 IF keys IS DISTINCT FROM ARRAY['code','operation','outcome','requestId'] OR t.id IS NOT NULL OR n.subject_id IS NOT NULL OR NOT coalesce(q.receipt->>'code' IN ('RATING_NOT_FOUND','RATING_REVISION_CONFLICT','PHONE_VERIFICATION_REQUIRED','AFFILIATION_VERIFICATION_REQUIRED','IDENTITY_CAMPUS_REQUIRED','SAFETY_ACTION_RESTRICTED','CONTENT_REJECTED'),false) THEN RAISE EXCEPTION 'Invalid rejected like receipt' USING ERRCODE='23514';END IF;RETURN NULL;END IF;
 IF keys IS DISTINCT FROM ARRAY['liked','occurredAt','operation','outcome','replyId','requestId','revision','rootId','targetId'] OR jsonb_typeof(q.receipt->'liked') IS DISTINCT FROM 'boolean' OR NOT coalesce(q.receipt->>'occurredAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$',false) THEN RAISE EXCEPTION 'Invalid minimal like receipt' USING ERRCODE='23514';END IF;
 IF q.receipt->>'outcome'='applied' THEN
 IF t.id IS NULL OR n.subject_id IS NOT NULL OR (q.receipt->>'targetId',q.receipt->>'rootId',q.receipt->>'replyId',q.receipt->>'revision',(q.receipt->>'liked')::boolean,(q.receipt->>'occurredAt')::timestamptz) IS DISTINCT FROM (t.target_id::text,t.root_id::text,t.reply_id::text,t.new_revision::text,t.delta=1,t.occurred_at) THEN RAISE EXCEPTION 'Like receipt transition mismatch' USING ERRCODE='23514';END IF;
 ELSIF q.receipt->>'outcome'='noop' THEN SELECT * INTO s FROM whaleu_ratings.like_subjects WHERE id=n.subject_id;
 IF t.id IS NOT NULL OR n.subject_id IS NULL OR n.observation_transaction<>pg_current_xact_id() OR (q.receipt->>'targetId',q.receipt->>'rootId',q.receipt->>'replyId',q.receipt->>'revision',(q.receipt->>'liked')::boolean,(q.receipt->>'occurredAt')::timestamptz) IS DISTINCT FROM (s.target_id::text,s.root_id::text,s.reply_id::text,n.revision::text,n.liked,n.occurred_at) THEN RAISE EXCEPTION 'Like noop receipt observation mismatch' USING ERRCODE='23514';END IF;
 ELSE RAISE EXCEPTION 'Invalid like outcome' USING ERRCODE='23514';END IF;
 IF (q.operation='set_comment_like')<>(q.receipt->'replyId'='null'::jsonb) THEN RAISE EXCEPTION 'Like receipt typed subject mismatch' USING ERRCODE='23514';END IF;RETURN NULL;
END $kernel$;
CREATE CONSTRAINT TRIGGER scoped_like_request_causal AFTER INSERT OR UPDATE ON whaleu_ratings.requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.operation IN ('set_comment_like_scoped','set_reply_like_scoped') AND NEW.receipt->>'outcome'<>'closed') EXECUTE FUNCTION whaleu_ratings.scoped_like_request_causal();

CREATE FUNCTION whaleu_ratings.scoped_subscription_request_causal() RETURNS trigger LANGUAGE plpgsql AS $kernel$
DECLARE q whaleu_ratings.requests;e whaleu_ratings.subscription_transitions;n whaleu_ratings.subscription_noop_observations;keys text[];
BEGIN
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=NEW.account_id AND request_id=NEW.request_id;
 q:=whaleu_ratings.scoped_domain_request(q.account_id,q.request_id);SELECT * INTO e FROM whaleu_ratings.subscription_transitions WHERE account_id=q.account_id AND request_id=q.request_id;SELECT * INTO n FROM whaleu_ratings.subscription_noop_observations WHERE account_id=q.account_id AND request_id=q.request_id;
 IF q.receipt IS NULL OR (q.receipt->>'requestId',q.receipt->>'operation') IS DISTINCT FROM (q.request_id::text,q.operation) THEN RAISE EXCEPTION 'Subscription canonical receipt missing' USING ERRCODE='23514';END IF;SELECT array_agg(k ORDER BY k) INTO keys FROM jsonb_object_keys(q.receipt) k;
 IF q.receipt->>'outcome'='rejected' THEN IF keys IS DISTINCT FROM ARRAY['code','operation','outcome','requestId'] OR e.id IS NOT NULL OR n.target_id IS NOT NULL OR NOT coalesce(q.receipt->>'code' IN ('RATING_NOT_FOUND','RATING_REVISION_CONFLICT','PHONE_VERIFICATION_REQUIRED','AFFILIATION_VERIFICATION_REQUIRED','IDENTITY_CAMPUS_REQUIRED','SAFETY_ACTION_RESTRICTED','CONTENT_REJECTED'),false) THEN RAISE EXCEPTION 'Invalid rejected subscription receipt' USING ERRCODE='23514';END IF;RETURN NULL;END IF;
 IF keys IS DISTINCT FROM ARRAY['occurredAt','operation','outcome','requestId','revision','subscribed','targetId'] OR jsonb_typeof(q.receipt->'subscribed') IS DISTINCT FROM 'boolean' OR NOT coalesce(q.receipt->>'occurredAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$',false) THEN RAISE EXCEPTION 'Invalid subscription minimal receipt' USING ERRCODE='23514';END IF;
 IF q.receipt->>'outcome'='applied' THEN IF e.id IS NULL OR n.target_id IS NOT NULL OR (q.receipt->>'targetId',q.receipt->>'revision',(q.receipt->>'subscribed')::boolean,(q.receipt->>'occurredAt')::timestamptz) IS DISTINCT FROM (e.target_id::text,e.new_revision::text,e.delta=1,e.occurred_at) THEN RAISE EXCEPTION 'Subscription receipt transition mismatch' USING ERRCODE='23514';END IF;
 ELSIF q.receipt->>'outcome'='noop' THEN IF e.id IS NOT NULL OR n.target_id IS NULL OR n.observation_transaction<>pg_current_xact_id() OR (q.receipt->>'targetId',q.receipt->>'revision',(q.receipt->>'subscribed')::boolean,(q.receipt->>'occurredAt')::timestamptz) IS DISTINCT FROM (n.target_id::text,n.revision::text,n.subscribed,n.occurred_at) THEN RAISE EXCEPTION 'Subscription receipt noop mismatch' USING ERRCODE='23514';END IF;
 ELSE RAISE EXCEPTION 'Invalid subscription outcome' USING ERRCODE='23514';END IF;RETURN NULL;
END $kernel$;
CREATE CONSTRAINT TRIGGER scoped_subscription_request_causal AFTER INSERT OR UPDATE ON whaleu_ratings.requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.operation IN ('set_target_subscription_scoped') AND NEW.receipt->>'outcome'<>'closed') EXECUTE FUNCTION whaleu_ratings.scoped_subscription_request_causal();

-- Same-OID typed dispatcher; the following ELSE retains the complete legacy body.
CREATE OR REPLACE FUNCTION whaleu_ratings.like_subject_guard() RETURNS trigger LANGUAGE plpgsql AS $dispatch$
BEGIN
 IF EXISTS(SELECT 1 FROM whaleu_community.rating_scoped_content_bindings WHERE kind=NEW.kind AND subject_id=NEW.id) THEN

DECLARE c whaleu_ratings.comments;r whaleu_ratings.replies;ct whaleu_ratings.comment_transitions;rt whaleu_ratings.reply_transitions;b whaleu_community.rating_scoped_content_bindings;q whaleu_ratings.requests;a whaleu_ratings.like_activations;actor uuid;req uuid;created timestamptz;definition jsonb;revision uuid;
BEGIN
 IF NEW.creation_transaction<>pg_current_xact_id() THEN RAISE EXCEPTION 'Like baseline creation is not fresh' USING ERRCODE='23514';END IF;
 SELECT * INTO c FROM whaleu_ratings.comments WHERE id=NEW.root_id AND target_id=NEW.target_id;
 IF NEW.kind='comment' THEN SELECT * INTO ct FROM whaleu_ratings.comment_transitions WHERE id=NEW.comment_transition_id AND operation='create_comment';actor:=c.account_id;req:=c.request_id;created:=c.created_at;definition:=c.envelope;revision:=ct.revision;
 IF ct.id IS NULL OR (ct.comment_id,ct.target_id,ct.account_id,ct.request_id,ct.occurred_at,ct.mutation_transaction) IS DISTINCT FROM (c.id,c.target_id,c.account_id,c.request_id,c.created_at,c.publication_transaction) OR NEW.publication_transaction IS DISTINCT FROM c.publication_transaction THEN RAISE EXCEPTION 'Root like baseline publication mismatch' USING ERRCODE='23514';END IF;
 ELSE SELECT * INTO r FROM whaleu_ratings.replies WHERE id=NEW.reply_id AND root_id=NEW.root_id AND target_id=NEW.target_id;SELECT * INTO rt FROM whaleu_ratings.reply_transitions WHERE id=NEW.reply_transition_id AND operation='create_reply';actor:=r.account_id;req:=r.request_id;created:=r.created_at;definition:=r.envelope;revision:=rt.revision;
 IF rt.id IS NULL OR (rt.reply_id,rt.root_id,rt.target_id,rt.account_id,rt.request_id,rt.occurred_at,rt.mutation_transaction) IS DISTINCT FROM (r.id,r.root_id,r.target_id,r.account_id,r.request_id,r.created_at,r.publication_transaction) OR NEW.publication_transaction IS DISTINCT FROM r.publication_transaction THEN RAISE EXCEPTION 'Reply like baseline publication mismatch' USING ERRCODE='23514';END IF;END IF;
 SELECT * INTO b FROM whaleu_community.rating_scoped_content_bindings WHERE kind=NEW.kind AND subject_id=NEW.id;
 IF b.subject_id IS NULL OR (b.envelope,b.publication_transaction,b.content_version) IS DISTINCT FROM (definition,NEW.publication_transaction,1) THEN RAISE EXCEPTION 'Like baseline review provenance missing' USING ERRCODE='23514';END IF;
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=actor AND request_id=req;
 q:=whaleu_ratings.scoped_domain_request(q.account_id,q.request_id);
 IF q.operation IS DISTINCT FROM (CASE NEW.kind WHEN 'comment' THEN 'create_comment' ELSE 'create_reply' END) THEN RAISE EXCEPTION 'Like baseline request missing' USING ERRCODE='23514';END IF;
 IF NEW.provenance='native-publication' THEN
 IF NEW.publication_transaction<>pg_current_xact_id() OR NEW.baseline_at<>created OR q.receipt IS NOT NULL THEN RAISE EXCEPTION 'Old publication cannot claim fresh baseline' USING ERRCODE='23514';END IF;
 ELSE SELECT * INTO a FROM whaleu_ratings.like_activations WHERE id=NEW.activation_id;
 IF a.activation_transaction IS DISTINCT FROM pg_current_xact_id() OR NEW.baseline_at IS DISTINCT FROM a.activated_at OR created>a.activated_at OR q.receipt->>'outcome' IS DISTINCT FROM 'applied' OR q.receipt->>'revision' IS DISTINCT FROM revision::text OR (q.receipt->>'occurredAt')::timestamptz IS DISTINCT FROM created OR q.receipt->>'targetId' IS DISTINCT FROM NEW.target_id::text OR coalesce(q.receipt->>'subjectId',q.receipt->>'replyId') IS DISTINCT FROM NEW.id::text THEN RAISE EXCEPTION 'Like cutover publication receipt mismatch' USING ERRCODE='23514';END IF;END IF;
 RETURN NEW;
END;
 ELSE

DECLARE c whaleu_ratings.comments;r whaleu_ratings.replies;ct whaleu_ratings.comment_transitions;rt whaleu_ratings.reply_transitions;b whaleu_community.rating_approval_bindings;q whaleu_ratings.requests;a whaleu_ratings.like_activations;actor uuid;req uuid;created timestamptz;definition jsonb;revision uuid;
BEGIN
 IF NEW.creation_transaction<>pg_current_xact_id() THEN RAISE EXCEPTION 'Like baseline creation is not fresh' USING ERRCODE='23514';END IF;
 SELECT * INTO c FROM whaleu_ratings.comments WHERE id=NEW.root_id AND target_id=NEW.target_id;
 IF NEW.kind='comment' THEN SELECT * INTO ct FROM whaleu_ratings.comment_transitions WHERE id=NEW.comment_transition_id AND operation='create_comment';actor:=c.account_id;req:=c.request_id;created:=c.created_at;definition:=c.envelope;revision:=ct.revision;
 IF ct.id IS NULL OR (ct.comment_id,ct.target_id,ct.account_id,ct.request_id,ct.occurred_at,ct.mutation_transaction) IS DISTINCT FROM (c.id,c.target_id,c.account_id,c.request_id,c.created_at,c.publication_transaction) OR NEW.publication_transaction IS DISTINCT FROM c.publication_transaction THEN RAISE EXCEPTION 'Root like baseline publication mismatch' USING ERRCODE='23514';END IF;
 ELSE SELECT * INTO r FROM whaleu_ratings.replies WHERE id=NEW.reply_id AND root_id=NEW.root_id AND target_id=NEW.target_id;SELECT * INTO rt FROM whaleu_ratings.reply_transitions WHERE id=NEW.reply_transition_id AND operation='create_reply';actor:=r.account_id;req:=r.request_id;created:=r.created_at;definition:=r.envelope;revision:=rt.revision;
 IF rt.id IS NULL OR (rt.reply_id,rt.root_id,rt.target_id,rt.account_id,rt.request_id,rt.occurred_at,rt.mutation_transaction) IS DISTINCT FROM (r.id,r.root_id,r.target_id,r.account_id,r.request_id,r.created_at,r.publication_transaction) OR NEW.publication_transaction IS DISTINCT FROM r.publication_transaction THEN RAISE EXCEPTION 'Reply like baseline publication mismatch' USING ERRCODE='23514';END IF;END IF;
 SELECT * INTO b FROM whaleu_community.rating_approval_bindings WHERE kind=NEW.kind AND subject_id=NEW.id;
 IF b.subject_id IS NULL OR (b.envelope,b.publication_transaction,b.content_version) IS DISTINCT FROM (definition,NEW.publication_transaction,1) THEN RAISE EXCEPTION 'Like baseline review provenance missing' USING ERRCODE='23514';END IF;
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=actor AND request_id=req;
 IF q.operation IS DISTINCT FROM (CASE NEW.kind WHEN 'comment' THEN 'create_comment' ELSE 'create_reply' END) THEN RAISE EXCEPTION 'Like baseline request missing' USING ERRCODE='23514';END IF;
 IF NEW.provenance='native-publication' THEN
 IF NEW.publication_transaction<>pg_current_xact_id() OR NEW.baseline_at<>created OR q.receipt IS NOT NULL THEN RAISE EXCEPTION 'Old publication cannot claim fresh baseline' USING ERRCODE='23514';END IF;
 ELSE SELECT * INTO a FROM whaleu_ratings.like_activations WHERE id=NEW.activation_id;
 IF a.activation_transaction IS DISTINCT FROM pg_current_xact_id() OR NEW.baseline_at IS DISTINCT FROM a.activated_at OR created>a.activated_at OR q.receipt->>'outcome' IS DISTINCT FROM 'applied' OR q.receipt->>'revision' IS DISTINCT FROM revision::text OR (q.receipt->>'occurredAt')::timestamptz IS DISTINCT FROM created OR q.receipt->>'targetId' IS DISTINCT FROM NEW.target_id::text OR coalesce(q.receipt->>'subjectId',q.receipt->>'replyId') IS DISTINCT FROM NEW.id::text THEN RAISE EXCEPTION 'Like cutover publication receipt mismatch' USING ERRCODE='23514';END IF;END IF;
 RETURN NEW;
END;
 END IF;
END $dispatch$;

-- Same-OID typed dispatcher; the following ELSE retains the complete legacy body.
CREATE OR REPLACE FUNCTION whaleu_ratings.like_subject_complete() RETURNS trigger LANGUAGE plpgsql AS $dispatch$
BEGIN
 IF EXISTS(SELECT 1 FROM whaleu_community.rating_scoped_content_bindings WHERE kind=NEW.kind AND subject_id=NEW.id) THEN

DECLARE q whaleu_ratings.requests;req uuid;actor uuid;created timestamptz;revision uuid;
BEGIN
 IF NEW.kind='comment' THEN SELECT account_id,request_id,occurred_at,t.revision INTO actor,req,created,revision FROM whaleu_ratings.comment_transitions t WHERE id=NEW.comment_transition_id;
 ELSE SELECT account_id,request_id,occurred_at,t.revision INTO actor,req,created,revision FROM whaleu_ratings.reply_transitions t WHERE id=NEW.reply_transition_id;END IF;
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=actor AND request_id=req;
 q:=whaleu_ratings.scoped_domain_request(q.account_id,q.request_id);
 IF q.receipt->>'outcome' IS DISTINCT FROM 'applied' OR q.receipt->>'revision' IS DISTINCT FROM revision::text OR (q.receipt->>'occurredAt')::timestamptz IS DISTINCT FROM created OR coalesce(q.receipt->>'subjectId',q.receipt->>'replyId') IS DISTINCT FROM NEW.id::text OR NOT EXISTS(SELECT 1 FROM whaleu_ratings.like_states WHERE subject_id=NEW.id) THEN RAISE EXCEPTION 'Native like baseline receipt incomplete' USING ERRCODE='23514';END IF;RETURN NULL;
END;
 ELSE

DECLARE q whaleu_ratings.requests;req uuid;actor uuid;created timestamptz;revision uuid;
BEGIN
 IF NEW.kind='comment' THEN SELECT account_id,request_id,occurred_at,t.revision INTO actor,req,created,revision FROM whaleu_ratings.comment_transitions t WHERE id=NEW.comment_transition_id;
 ELSE SELECT account_id,request_id,occurred_at,t.revision INTO actor,req,created,revision FROM whaleu_ratings.reply_transitions t WHERE id=NEW.reply_transition_id;END IF;
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=actor AND request_id=req;
 IF q.receipt->>'outcome' IS DISTINCT FROM 'applied' OR q.receipt->>'revision' IS DISTINCT FROM revision::text OR (q.receipt->>'occurredAt')::timestamptz IS DISTINCT FROM created OR coalesce(q.receipt->>'subjectId',q.receipt->>'replyId') IS DISTINCT FROM NEW.id::text OR NOT EXISTS(SELECT 1 FROM whaleu_ratings.like_states WHERE subject_id=NEW.id) THEN RAISE EXCEPTION 'Native like baseline receipt incomplete' USING ERRCODE='23514';END IF;RETURN NULL;
END;
 END IF;
END $dispatch$;

CREATE TRIGGER scoped_like_subject_enrollment AFTER INSERT ON whaleu_community.rating_scoped_content_bindings FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.enroll_native_like_subject();
CREATE FUNCTION whaleu_ratings.scoped_edit_preparation(target uuid,revision uuid) RETURNS whaleu_ratings.scoped_command_preparations LANGUAGE plpgsql STABLE AS $$
DECLARE p whaleu_ratings.scoped_command_preparations;e whaleu_ratings.scoped_command_causes;BEGIN
 SELECT * INTO e FROM whaleu_ratings.scoped_command_causes WHERE cause_kind='target_edit' AND artifact_id=target AND artifact_revision=revision AND mutation_transaction=pg_current_xact_id();
 SELECT * INTO p FROM whaleu_ratings.scoped_command_preparations WHERE account_id=e.account_id AND request_id=e.request_id;
 IF NOT coalesce(p.operation='edit_target_scoped' AND p.target_id=target AND p.target_revision=revision AND e.proof->>'definitionRevision'=p.definition_revision::text
 AND (e.proof->>'contentVersion')::integer=p.content_version AND p.envelope->>'purpose'='edit_rating_target_scoped'
 AND p.envelope->>'previousTargetRevision'=p.intent->'payload'->>'expectedTargetRevision' AND p.envelope->>'previousDefinitionRevision'=p.intent->'payload'->>'expectedDefinitionRevision',false)
 THEN RAISE EXCEPTION 'Scoped edit has no exact fresh cause' USING ERRCODE='23514';END IF;
 PERFORM whaleu_ratings.scoped_domain_request(p.account_id,p.request_id);RETURN p;
END $$;
CREATE FUNCTION whaleu_ratings.verify_scoped_content(kind text,subject uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE rowdata jsonb;content_envelope jsonb;p whaleu_ratings.scoped_command_preparations;t whaleu_ratings.targets;b whaleu_community.rating_scoped_content_bindings;
BEGIN
 IF kind='comment' THEN SELECT to_jsonb(c) INTO rowdata FROM whaleu_ratings.comments c WHERE id=subject;
 ELSIF kind='reply' THEN SELECT to_jsonb(c) INTO rowdata FROM whaleu_ratings.replies c WHERE id=subject;
 ELSE RAISE EXCEPTION 'Unknown scoped content kind' USING ERRCODE='23514';END IF;
 content_envelope:=rowdata->'envelope';SELECT * INTO p FROM whaleu_ratings.scoped_command_preparations WHERE account_id=(rowdata->>'account_id')::uuid AND request_id=(rowdata->>'request_id')::uuid;
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=p.target_id;
 SELECT * INTO b FROM whaleu_community.rating_scoped_content_bindings WHERE rating_scoped_content_bindings.kind=verify_scoped_content.kind AND subject_id=subject;
 IF NOT coalesce(p.operation=CASE kind WHEN 'comment' THEN 'create_comment_scoped' ELSE 'create_reply_scoped' END
 AND p.envelope=content_envelope AND p.subject_id=subject AND p.subject_revision::text=rowdata->>'revision' AND p.target_id::text=rowdata->>'target_id'
 AND p.target_revision=t.revision AND t.active AND t.category_id::text=p.intent->'payload'->>'categoryId'
 AND content_envelope->'targetOrigin'->>'regionId' IS NOT DISTINCT FROM t.region_id::text
 AND content_envelope->>'authorMode'=rowdata->>'author_mode' AND content_envelope->>'body'=rowdata->>'body'
 AND rowdata->'deleted_at'='null'::jsonb AND rowdata->>'publication_transaction'=pg_current_xact_id()::text
 AND b.envelope=content_envelope AND b.subject_revision=p.subject_revision AND b.publication_transaction=pg_current_xact_id()
 AND whaleu_community.rating_scoped_content_current(kind,subject,p.subject_revision,content_envelope)
 AND EXISTS(SELECT 1 FROM whaleu_ratings.scoped_categories c WHERE c.catalog_id=(p.intent->'context'->>'catalogRevision')::uuid AND c.category_id=t.category_id AND c.effective_revision::text=p.intent->'payload'->>'expectedCategoryRevision'),false)
 THEN RAISE EXCEPTION 'Scoped content/review/preparation reverse mismatch' USING ERRCODE='23514';END IF;
 IF kind='reply' AND NOT coalesce(EXISTS(SELECT 1 FROM whaleu_ratings.comments c WHERE c.id=(rowdata->>'root_id')::uuid AND c.target_id=t.id AND c.deleted_at IS NULL AND c.revision::text=content_envelope->>'rootRevision' AND whaleu_community.rating_scoped_parent_review_current('comment',c.id,c.revision))
  AND content_envelope->>'rootId'=rowdata->>'root_id' AND ((rowdata->'reply_to_id'='null'::jsonb AND content_envelope->'replyTo'='null'::jsonb) OR EXISTS(SELECT 1 FROM whaleu_ratings.replies r WHERE r.id=(rowdata->>'reply_to_id')::uuid AND r.root_id=(rowdata->>'root_id')::uuid AND r.target_id=t.id AND r.deleted_at IS NULL AND content_envelope->'replyTo'=jsonb_build_object('replyId',r.id,'revision',r.revision) AND whaleu_community.rating_scoped_parent_review_current('reply',r.id,r.revision))),false)
 THEN RAISE EXCEPTION 'Scoped reply ancestry mismatch' USING ERRCODE='23514';END IF;
 PERFORM whaleu_ratings.scoped_domain_request(p.account_id,p.request_id);
END $$;
CREATE FUNCTION whaleu_ratings.verify_scoped_target_initial(target uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE t whaleu_ratings.targets;p whaleu_ratings.scoped_command_preparations;e whaleu_ratings.scoped_command_causes;v whaleu_ratings.target_definition_versions;
 b whaleu_community.rating_scoped_target_definition_bindings;s whaleu_ratings.target_sources;o whaleu_ratings.target_origin_sources;policy whaleu_ratings.scoped_source_attestations;
BEGIN
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=target;
 SELECT * INTO p FROM whaleu_ratings.scoped_command_preparations WHERE account_id=t.creator_id AND request_id=(t.envelope->>'clientRequestId')::uuid;
 SELECT * INTO e FROM whaleu_ratings.scoped_command_causes WHERE account_id=p.account_id AND request_id=p.request_id AND cause_kind='target_initial';
 SELECT * INTO v FROM whaleu_ratings.target_definition_versions WHERE target_id=target AND content_version=1;
 SELECT * INTO b FROM whaleu_community.rating_scoped_target_definition_bindings WHERE target_id=target AND content_version=1;
 SELECT * INTO s FROM whaleu_ratings.target_sources WHERE id=t.source_id;
 SELECT src.* INTO o FROM whaleu_ratings.target_origin_sources src JOIN whaleu_ratings.target_origin_heads h ON h.source_id=src.id WHERE h.target_id=target;
 SELECT policy_source.* INTO policy FROM whaleu_ratings.scoped_source_attestations policy_source WHERE policy_source.id=p.policy_source_id AND policy_source.revision=p.policy_source_revision;
 IF NOT coalesce(p.operation='create_target_scoped' AND t.id=p.target_id AND t.revision=p.target_revision AND t.creation_transaction=pg_current_xact_id()
 AND t.category_id::text=p.intent->'payload'->>'categoryId' AND t.name=p.intent->'payload'->>'name' AND t.description=p.intent->'payload'->>'description' AND t.envelope=p.envelope
 AND t.region_id::text IS NOT DISTINCT FROM p.envelope->'targetOrigin'->>'regionId'
 AND e.artifact_id=t.id AND e.artifact_revision=t.revision AND e.mutation_transaction=t.creation_transaction AND (e.proof->>'occurredAt')::timestamptz=t.created_at
 AND (v.definition_revision,v.applied_target_revision,v.name,v.description,v.envelope,v.publication_transaction,v.published_at)=(p.definition_revision,p.target_revision,t.name,t.description,t.envelope,t.creation_transaction,t.created_at)
 AND (b.content_version,b.definition_revision,b.applied_target_revision,b.account_id,b.envelope,b.publication_transaction)=(1,p.definition_revision,p.target_revision,t.creator_id,t.envelope,t.creation_transaction)
 AND whaleu_community.rating_scoped_target_definition_current(target,1,p.definition_revision,p.target_revision,t.envelope)
 AND s.id::text=e.proof->>'sourceId' AND s.target_id=t.id AND s.origin='new_native' AND s.coverage='complete' AND s.provenance='accepted'
 AND s.source_reference='rating-scoped-create:'||p.account_id::text||':'||p.request_id::text AND s.policy_reference=policy.policy_reference AND s.effective_at=t.created_at
 AND policy.source_kind='native_scoped_create' AND policy.payload->'enabled'='true'::jsonb AND whaleu_ratings.scoped_source_current(policy.id,policy.revision,clock_timestamp())
 AND EXISTS(SELECT 1 FROM whaleu_ratings.score_baselines sb WHERE sb.target_id=t.id AND sb.id::text=e.proof->>'baselineId' AND sb.kind='fresh_zero' AND sb.source_id=s.id AND sb.source_reference=s.source_reference AND sb.policy_reference=s.policy_reference)
 AND o.id::text=e.proof->>'originId' AND o.target_id=t.id AND o.origin_campus_id::text IS NOT DISTINCT FROM p.envelope->'targetOrigin'->>'originCampusId'
 AND o.source_reference=s.source_reference AND o.policy_reference=s.policy_reference AND NOT o.revoked
 AND EXISTS(SELECT 1 FROM whaleu_ratings.target_definition_heads h WHERE h.target_id=t.id AND (h.content_version,h.definition_revision)=(1,p.definition_revision))
 AND EXISTS(SELECT 1 FROM whaleu_ratings.target_definition_lifecycles l WHERE l.target_id=t.id AND l.target_revision=t.revision AND (l.content_version,l.definition_revision)=(1,p.definition_revision)),false)
 THEN RAISE EXCEPTION 'Scoped initial target/source/baseline/origin/Review chain incomplete' USING ERRCODE='23514';END IF;
 PERFORM whaleu_ratings.scoped_domain_request(p.account_id,p.request_id);
END $$;
CREATE FUNCTION whaleu_ratings.verify_scoped_target_edit(actor uuid,request uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE p whaleu_ratings.scoped_command_preparations;t whaleu_ratings.targets;v whaleu_ratings.target_definition_versions;e whaleu_ratings.scoped_command_causes;b whaleu_community.rating_scoped_target_definition_bindings;
BEGIN
 SELECT * INTO p FROM whaleu_ratings.scoped_command_preparations WHERE account_id=actor AND request_id=request;
 SELECT * INTO e FROM whaleu_ratings.scoped_command_causes WHERE account_id=actor AND request_id=request AND cause_kind='target_edit';
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=p.target_id;
 SELECT * INTO v FROM whaleu_ratings.target_definition_versions WHERE target_id=t.id AND content_version=p.content_version;
 SELECT * INTO b FROM whaleu_community.rating_scoped_target_definition_bindings WHERE target_id=t.id AND content_version=p.content_version;
 IF NOT coalesce(p.operation='edit_target_scoped' AND t.creator_id=actor AND t.active AND t.revision=p.target_revision AND e.artifact_id=t.id AND e.artifact_revision=t.revision AND e.mutation_transaction=pg_current_xact_id()
 AND (v.definition_revision,v.applied_target_revision,v.name,v.description,v.envelope,v.publication_transaction,v.published_at)=(p.definition_revision,p.target_revision,p.intent->'payload'->>'name',p.intent->'payload'->>'description',p.envelope,e.mutation_transaction,(e.proof->>'occurredAt')::timestamptz)
 AND (b.definition_revision,b.applied_target_revision,b.account_id,b.envelope,b.publication_transaction)=(p.definition_revision,p.target_revision,actor,p.envelope,e.mutation_transaction)
 AND whaleu_community.rating_scoped_target_definition_current(t.id,p.content_version,p.definition_revision,p.target_revision,p.envelope)
 AND EXISTS(SELECT 1 FROM whaleu_ratings.target_definition_versions old WHERE old.target_id=t.id AND old.content_version=p.content_version-1 AND old.definition_revision::text=p.intent->'payload'->>'expectedDefinitionRevision')
 AND EXISTS(SELECT 1 FROM whaleu_ratings.target_definition_heads h WHERE h.target_id=t.id AND (h.content_version,h.definition_revision)=(p.content_version,p.definition_revision))
 AND EXISTS(SELECT 1 FROM whaleu_ratings.target_definition_lifecycles l WHERE l.target_id=t.id AND l.target_revision=t.revision AND (l.content_version,l.definition_revision)=(p.content_version,p.definition_revision))
 AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.target_owner_tombstones WHERE target_id=t.id),false)
 THEN RAISE EXCEPTION 'Scoped edit/definition/Review/head chain incomplete' USING ERRCODE='23514';END IF;
 PERFORM whaleu_ratings.scoped_domain_request(actor,request);
END $$;
CREATE FUNCTION whaleu_ratings.verify_scoped_command(actor uuid,request uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE q whaleu_ratings.requests;p whaleu_ratings.scoped_command_preparations;o whaleu_ratings.scoped_command_outcomes;cause whaleu_ratings.scoped_command_causes;expected jsonb;n integer;t whaleu_ratings.targets;
BEGIN
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=actor AND request_id=request;
 SELECT * INTO o FROM whaleu_ratings.scoped_command_outcomes WHERE account_id=actor AND request_id=request;
 IF NOT coalesce(whaleu_ratings.rating_scoped_operation_rule(q.operation,2) IS NOT NULL AND o.operation=q.operation AND o.intent_hash=q.intent_hash AND o.mutation_transaction=pg_current_xact_id(),false)
 THEN RAISE EXCEPTION 'Scoped outcome is absent or not exact' USING ERRCODE='23514';END IF;
 expected:=jsonb_build_object('protocolVersion',2,'requestId',request,'operation',q.operation,'intentHash',q.intent_hash,'outcome',o.outcome)||CASE WHEN o.outcome='closed' THEN jsonb_build_object('code',o.code) ELSE jsonb_build_object('result',o.result) END;
 IF q.receipt IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Scoped receipt bytes differ from immutable outcome' USING ERRCODE='23514';END IF;
 SELECT count(*) INTO n FROM (SELECT id FROM whaleu_ratings.score_transitions WHERE account_id=actor AND request_id=request UNION ALL SELECT id FROM whaleu_ratings.comment_transitions WHERE account_id=actor AND request_id=request UNION ALL SELECT id FROM whaleu_ratings.reply_transitions WHERE account_id=actor AND request_id=request UNION ALL SELECT id FROM whaleu_ratings.like_transitions WHERE account_id=actor AND request_id=request UNION ALL SELECT id FROM whaleu_ratings.subscription_transitions WHERE account_id=actor AND request_id=request) mutations;
 IF o.outcome='closed' THEN
  IF n<>0 OR EXISTS(SELECT 1 FROM whaleu_ratings.scoped_command_causes WHERE account_id=actor AND request_id=request)
   OR EXISTS(SELECT 1 FROM whaleu_ratings.effect_events WHERE actor_account_id=actor AND request_id=request)
   OR (o.code='RATING_CREATION_CANCELLED' AND q.operation<>'create_target_scoped') OR (o.code='RATING_EDIT_CANCELLED' AND q.operation<>'edit_target_scoped')
  THEN RAISE EXCEPTION 'Scoped closure cannot hide a mutation' USING ERRCODE='23514';END IF;RETURN;
 END IF;
 SELECT * INTO p FROM whaleu_ratings.scoped_command_preparations WHERE account_id=actor AND request_id=request;
 PERFORM whaleu_ratings.scoped_domain_request(actor,request);
 IF NOT whaleu_ratings.scoped_command_parents_current(p) OR p.intent IS DISTINCT FROM o.intent OR p.envelope IS DISTINCT FROM whaleu_ratings.scoped_preparation_envelope(p) OR p.valid_until<=clock_timestamp() OR p.before_state IS NULL
 OR NOT whaleu_ratings.target_edit_session_current(actor,p.session_id,clock_timestamp()) OR o.result->>'targetId' IS DISTINCT FROM p.target_id::text
 OR NOT coalesce(o.result->>'occurredAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$',false)
 THEN RAISE EXCEPTION 'Scoped success preparation/session mismatch' USING ERRCODE='23514';END IF;
 IF (SELECT array_agg(cause_kind ORDER BY cause_kind) FROM whaleu_ratings.scoped_command_causes WHERE account_id=actor AND request_id=request)
 IS DISTINCT FROM (CASE WHEN q.operation='create_target_scoped' THEN ARRAY['catalog_release','execution','target_initial'] WHEN q.operation='edit_target_scoped' AND o.outcome='applied' THEN ARRAY['execution','target_edit'] ELSE ARRAY['execution'] END)
 THEN RAISE EXCEPTION 'Scoped request has missing or extra typed causes' USING ERRCODE='23514';END IF;
 IF q.operation='set_score_scoped' THEN
  IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.scores x WHERE x.target_id=p.target_id AND x.account_id=actor AND x.score=(p.intent->'payload'->>'score')::smallint AND x.revision::text=o.result->>'revision')
   OR (o.outcome='applied' AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.score_transitions x WHERE x.account_id=actor AND x.request_id=request AND x.target_id=p.target_id AND x.new_score=(p.intent->'payload'->>'score')::smallint AND x.old_revision::text IS NOT DISTINCT FROM p.intent->'payload'->>'expectedRevision'))
   OR (o.outcome='noop' AND o.result->>'revision' IS DISTINCT FROM p.intent->'payload'->>'expectedRevision')
  THEN RAISE EXCEPTION 'Scoped score differs from exact original desired state/CAS' USING ERRCODE='23514';END IF;
 ELSIF q.operation IN ('set_comment_like_scoped','set_reply_like_scoped') THEN
  IF (o.outcome='applied' AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.like_transitions x WHERE x.account_id=actor AND x.request_id=request AND x.target_id=p.target_id
    AND x.root_id::text=p.intent->'payload'->>'rootId' AND x.reply_id::text IS NOT DISTINCT FROM p.intent->'payload'->>'replyId'
    AND x.old_revision::text=p.intent->'payload'->>'expectedLikeRevision' AND (x.delta=1)=(p.intent->'payload'->>'liked')::boolean))
   OR (o.outcome='noop' AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.like_noop_observations x WHERE x.account_id=actor AND x.request_id=request
    AND x.subject_id::text=coalesce(p.intent->'payload'->>'replyId',p.intent->'payload'->>'rootId') AND x.revision::text=p.intent->'payload'->>'expectedLikeRevision' AND x.liked=(p.intent->'payload'->>'liked')::boolean))
  THEN RAISE EXCEPTION 'Scoped like differs from original exact subject/CAS/desired state' USING ERRCODE='23514';END IF;
 ELSIF q.operation='set_target_subscription_scoped' THEN
  IF (o.outcome='applied' AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.subscription_transitions x WHERE x.account_id=actor AND x.request_id=request AND x.target_id=p.target_id AND x.old_revision::text=p.intent->'payload'->>'expectedSubscriptionRevision' AND (x.delta=1)=(p.intent->'payload'->>'subscribed')::boolean))
   OR (o.outcome='noop' AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.subscription_noop_observations x WHERE x.account_id=actor AND x.request_id=request AND x.target_id=p.target_id AND x.revision::text=p.intent->'payload'->>'expectedSubscriptionRevision' AND x.subscribed=(p.intent->'payload'->>'subscribed')::boolean))
  THEN RAISE EXCEPTION 'Scoped subscription differs from exact original target/CAS/desired state' USING ERRCODE='23514';END IF;
 END IF;
 IF q.operation IN ('create_target_scoped','edit_target_scoped') THEN
  IF n<>0 OR EXISTS(SELECT 1 FROM whaleu_ratings.effect_events WHERE actor_account_id=actor AND request_id=request) THEN RAISE EXCEPTION 'Target definition cannot cause scalar/content rewards' USING ERRCODE='23514';END IF;
  IF q.operation='create_target_scoped' THEN
   IF o.outcome<>'applied' THEN RAISE EXCEPTION 'Scoped creation cannot noop' USING ERRCODE='23514';END IF;
   PERFORM whaleu_ratings.verify_scoped_target_initial(p.target_id);
   SELECT * INTO cause FROM whaleu_ratings.scoped_command_causes WHERE account_id=actor AND request_id=request AND cause_kind='catalog_release';
   IF NOT coalesce(cause.mutation_transaction=pg_current_xact_id() AND cause.proof->>'catalogId'=o.result->>'catalogRevision'
    AND EXISTS(SELECT 1 FROM whaleu_ratings.scoped_releases r JOIN whaleu_ratings.scoped_catalogs c ON c.release_id=r.id JOIN whaleu_ratings.scoped_catalog_heads h ON h.catalog_id=c.id
     WHERE r.id=cause.artifact_id AND r.cause_kind='create_target_scoped' AND r.cause->>'accountId'=actor::text AND r.cause->>'requestId'=request::text
     AND c.id::text=o.result->>'catalogRevision' AND h.head_revision=cause.artifact_revision AND EXISTS(SELECT 1 FROM whaleu_ratings.scoped_target_memberships m WHERE m.catalog_id=c.id AND m.target_id=p.target_id)),false)
   THEN RAISE EXCEPTION 'Scoped creation requires exact full after catalog' USING ERRCODE='23514';END IF;
  ELSIF o.outcome='applied' THEN PERFORM whaleu_ratings.verify_scoped_target_edit(actor,request);
  ELSE SELECT * INTO t FROM whaleu_ratings.targets WHERE id=p.target_id;
   IF NOT coalesce(t.active AND t.creator_id=actor AND t.revision::text=p.intent->'payload'->>'expectedTargetRevision'
    AND p.before_state->>'name'=p.intent->'payload'->>'name' AND p.before_state->>'description'=p.intent->'payload'->>'description'
    AND o.result->>'revision'=t.revision::text AND o.result->>'definitionRevision'=p.intent->'payload'->>'expectedDefinitionRevision'
    AND o.result->'contentVersion'=p.intent->'payload'->'expectedContentVersion'
    AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.scoped_command_causes WHERE account_id=actor AND request_id=request AND cause_kind<>'execution'),false)
   THEN RAISE EXCEPTION 'Scoped edit noop must retain exact unchanged tuple' USING ERRCODE='23514';END IF;
  END IF;
 ELSE
  IF n<>(CASE WHEN o.outcome='applied' THEN 1 ELSE 0 END) THEN RAISE EXCEPTION 'Scoped scalar/content cardinality mismatch' USING ERRCODE='23514';END IF;
  IF q.operation='create_comment_scoped' THEN PERFORM whaleu_ratings.verify_scoped_content('comment',p.subject_id);
  ELSIF q.operation='create_reply_scoped' THEN PERFORM whaleu_ratings.verify_scoped_content('reply',p.subject_id);END IF;
 END IF;
END $$;
CREATE OR REPLACE FUNCTION whaleu_ratings.scoped_command_causal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_TABLE_NAME='scoped_command_causes' AND to_jsonb(NEW)->>'cause_kind'='legacy_bridge' THEN PERFORM whaleu_ratings.verify_legacy_scoped_bridge(NEW.account_id,NEW.request_id);
 ELSIF TG_TABLE_NAME='scoped_command_causes' AND to_jsonb(NEW)->>'cause_kind'='legacy_boundary' THEN PERFORM whaleu_ratings.verify_legacy_boundary(NEW.account_id,NEW.request_id);
 ELSE PERFORM whaleu_ratings.verify_scoped_command(NEW.account_id,NEW.request_id);END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER scoped_command_causal AFTER INSERT OR UPDATE ON whaleu_ratings.requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(whaleu_ratings.rating_scoped_operation_rule(NEW.operation,2) IS NOT NULL) EXECUTE FUNCTION whaleu_ratings.scoped_command_causal();
CREATE CONSTRAINT TRIGGER scoped_outcome_causal AFTER INSERT ON whaleu_ratings.scoped_command_outcomes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.scoped_command_causal();
CREATE CONSTRAINT TRIGGER scoped_cause_reverse AFTER INSERT ON whaleu_ratings.scoped_command_causes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.scoped_command_causal();

CREATE OR REPLACE FUNCTION whaleu_ratings.require_review_binding() RETURNS trigger LANGUAGE plpgsql AS $dispatch$
BEGIN IF TG_TABLE_SCHEMA='whaleu_ratings' AND NEW.envelope->'version'='5'::jsonb THEN
BEGIN
 IF TG_TABLE_NAME='targets' THEN PERFORM whaleu_ratings.verify_scoped_target_initial(NEW.id);
 ELSE PERFORM whaleu_ratings.verify_scoped_content(CASE TG_TABLE_NAME WHEN 'replies' THEN 'reply' ELSE 'comment' END,NEW.id);END IF;
 RETURN NULL;END;
ELSE

DECLARE requested_kind text;subject uuid;definition jsonb;publication xid8;b whaleu_community.rating_approval_bindings;t whaleu_ratings.targets;c whaleu_ratings.comments;category whaleu_ratings.categories;r whaleu_ratings.replies;parent whaleu_ratings.comments;direct whaleu_ratings.replies;
BEGIN
 IF TG_TABLE_SCHEMA='whaleu_community' THEN requested_kind:=NEW.kind;subject:=NEW.subject_id;ELSE requested_kind:=CASE TG_TABLE_NAME WHEN 'targets' THEN 'target' WHEN 'replies' THEN 'reply' ELSE 'comment' END;subject:=NEW.id;END IF;
 IF requested_kind='target' THEN
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=subject;definition:=t.envelope;publication:=t.creation_transaction;
 IF NOT coalesce(t.id IS NOT NULL AND definition->>'accountId'=t.creator_id::text AND definition->>'purpose'='publish_rating_target' AND definition->>'targetId'=t.id::text AND definition->>'targetRevision'=t.revision::text AND definition->>'categoryId'=t.category_id::text AND definition->>'name'=t.name AND definition->>'description'=t.description AND (definition->'scope'->>'regionId') IS NOT DISTINCT FROM t.region_id::text,false) THEN RAISE EXCEPTION 'Target definition mismatch' USING ERRCODE='23514';END IF;
 ELSIF requested_kind='reply' THEN
 SELECT * INTO r FROM whaleu_ratings.replies WHERE id=subject;definition:=r.envelope;publication:=r.publication_transaction;
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=r.target_id;
 SELECT * INTO parent FROM whaleu_ratings.comments WHERE id=r.root_id AND target_id=r.target_id;
 IF NOT coalesce(r.id IS NOT NULL AND definition->>'accountId'=r.account_id::text AND definition->>'purpose'='publish_rating_reply' AND definition->>'targetId'=r.target_id::text AND definition->>'targetRevision'=t.revision::text AND definition->>'rootId'=r.root_id::text AND definition->>'rootRevision'=parent.revision::text AND parent.deleted_at IS NULL AND t.active AND definition->>'categoryId'=t.category_id::text AND definition->>'clientRequestId'=r.request_id::text AND definition->>'authorMode'=r.author_mode AND definition->>'body'=r.body,false) THEN RAISE EXCEPTION 'Reply definition mismatch' USING ERRCODE='23514';END IF;
 IF r.reply_to_id IS NULL THEN IF definition->'replyTo' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'Reply root binding mismatch' USING ERRCODE='23514';END IF;
 ELSE SELECT * INTO direct FROM whaleu_ratings.replies WHERE id=r.reply_to_id AND root_id=r.root_id AND target_id=r.target_id;
 IF direct.id IS NULL OR direct.deleted_at IS NOT NULL OR definition->'replyTo' IS DISTINCT FROM jsonb_build_object('replyId',direct.id,'revision',direct.revision) THEN RAISE EXCEPTION 'Reply direct binding mismatch' USING ERRCODE='23514';END IF;END IF;
 ELSE
 SELECT * INTO c FROM whaleu_ratings.comments WHERE id=subject;definition:=c.envelope;publication:=c.publication_transaction;SELECT * INTO t FROM whaleu_ratings.targets WHERE id=c.target_id;
 IF NOT coalesce(c.id IS NOT NULL AND definition->>'accountId'=c.account_id::text AND definition->>'purpose'='publish_rating_comment' AND definition->>'targetId'=c.target_id::text AND definition->>'targetRevision'=t.revision::text AND definition->>'categoryId'=t.category_id::text AND t.active AND definition->>'clientRequestId'=c.request_id::text AND definition->>'authorMode'=c.author_mode AND definition->>'body'=c.body,false) THEN RAISE EXCEPTION 'Comment definition mismatch' USING ERRCODE='23514';END IF;
 END IF;
 SELECT * INTO b FROM whaleu_community.rating_approval_bindings WHERE kind=requested_kind AND subject_id=subject;
 IF b.subject_id IS NULL OR b.envelope IS DISTINCT FROM definition OR b.publication_transaction IS DISTINCT FROM publication OR publication<>pg_current_xact_id() OR b.content_version<>1 OR definition->'assetIds' IS DISTINCT FROM '[]'::jsonb THEN RAISE EXCEPTION 'Exact same-transaction review binding required' USING ERRCODE='23514';END IF;
 SELECT * INTO category FROM whaleu_ratings.categories WHERE catalog_id=(definition->>'catalogRevision')::uuid AND id=(definition->>'categoryId')::uuid;
 IF category.id IS NULL OR category.revision::text<>definition->>'categoryRevision' THEN RAISE EXCEPTION 'Category review mismatch' USING ERRCODE='23514';END IF;RETURN NULL;
END;
END IF;END $dispatch$;

CREATE OR REPLACE FUNCTION whaleu_ratings.verify_target_definition_initial(target uuid) RETURNS void LANGUAGE plpgsql AS $dispatch$
BEGIN IF EXISTS(SELECT 1 FROM whaleu_ratings.targets WHERE id=target AND envelope->'version'='5'::jsonb) THEN
BEGIN PERFORM whaleu_ratings.verify_scoped_target_initial(target);RETURN;END;
ELSE

DECLARE t whaleu_ratings.targets;v whaleu_ratings.target_definition_versions;h whaleu_ratings.target_definition_heads;
 l whaleu_ratings.target_definition_lifecycles;b whaleu_community.rating_approval_bindings;
BEGIN
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=target;
 SELECT * INTO v FROM whaleu_ratings.target_definition_versions WHERE target_id=target AND content_version=1;
 SELECT * INTO h FROM whaleu_ratings.target_definition_heads WHERE target_id=target;
 SELECT * INTO l FROM whaleu_ratings.target_definition_lifecycles WHERE target_id=target AND target_revision=t.revision;
 SELECT * INTO b FROM whaleu_community.rating_approval_bindings WHERE kind='target' AND subject_id=target;
 IF NOT coalesce(t.id=target AND t.creation_transaction=pg_current_xact_id()
  AND (v.definition_revision,v.applied_target_revision,v.name,v.description,v.envelope,v.publication_transaction,v.published_at)
   =((t.envelope->>'targetRevision')::uuid,(t.envelope->>'targetRevision')::uuid,t.name,t.description,t.envelope,t.creation_transaction,t.created_at)
  AND t.revision=v.applied_target_revision AND (h.content_version,h.definition_revision)=(1,v.definition_revision)
  AND (l.content_version,l.definition_revision)=(1,v.definition_revision)
  AND EXISTS(SELECT 1 FROM whaleu_ratings.target_state_revisions s WHERE s.target_id=target AND s.revision=t.revision AND s.active=t.active AND s.mutation_transaction=t.creation_transaction)
  AND (b.content_version,b.account_id,b.envelope,b.publication_transaction)=(1,t.creator_id,t.envelope,t.creation_transaction),false)
 THEN RAISE EXCEPTION 'Initial target definition/head/state/binding reverse link incomplete' USING ERRCODE='23514';END IF;
END;
END IF;END $dispatch$;

CREATE OR REPLACE FUNCTION whaleu_ratings.target_definition_version_guard() RETURNS trigger LANGUAGE plpgsql AS $dispatch$
BEGIN IF NEW.content_version>1 AND NEW.envelope->'version'='5'::jsonb THEN
DECLARE p whaleu_ratings.scoped_command_preparations;t whaleu_ratings.targets;h whaleu_ratings.target_definition_heads;e whaleu_ratings.scoped_command_causes;BEGIN
 p:=whaleu_ratings.scoped_edit_preparation(NEW.target_id,NEW.applied_target_revision);
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=p.target_id FOR UPDATE NOWAIT;
 SELECT * INTO h FROM whaleu_ratings.target_definition_heads WHERE target_id=p.target_id FOR UPDATE NOWAIT;
 SELECT * INTO e FROM whaleu_ratings.scoped_command_causes WHERE account_id=p.account_id AND request_id=p.request_id AND cause_kind='target_edit';
 IF NOT coalesce(t.active AND t.creator_id=p.account_id AND t.revision::text=p.intent->'payload'->>'expectedTargetRevision'
 AND h.definition_revision::text=p.intent->'payload'->>'expectedDefinitionRevision' AND h.content_version=(p.intent->'payload'->>'expectedContentVersion')::integer
 AND (NEW.content_version,NEW.definition_revision,NEW.applied_target_revision,NEW.name,NEW.description,NEW.envelope,NEW.publication_transaction,NEW.published_at)
 =(p.content_version,p.definition_revision,p.target_revision,p.intent->'payload'->>'name',p.intent->'payload'->>'description',p.envelope,pg_current_xact_id(),(e.proof->>'occurredAt')::timestamptz)
 AND NEW.content_version=h.content_version+1 AND NEW.definition_revision<>h.definition_revision
 AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.target_owner_tombstones WHERE target_id=t.id),false)
 THEN RAISE EXCEPTION 'Scoped definition version has no exact predecessor/cause' USING ERRCODE='23514';END IF;RETURN NEW;END;
ELSE

DECLARE t whaleu_ratings.targets;e whaleu_ratings.target_edit_transitions;p whaleu_ratings.target_edit_preparations;h whaleu_ratings.target_definition_heads;
BEGIN
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=NEW.target_id FOR UPDATE NOWAIT;
 IF NEW.content_version=1 THEN
  IF NOT coalesce(pg_trigger_depth()>=2 AND t.id=NEW.target_id AND t.creation_transaction=pg_current_xact_id()
   AND (NEW.definition_revision,NEW.applied_target_revision,NEW.name,NEW.description,NEW.envelope,NEW.publication_transaction,NEW.published_at)
    =((t.envelope->>'targetRevision')::uuid,(t.envelope->>'targetRevision')::uuid,t.name,t.description,t.envelope,t.creation_transaction,t.created_at)
   AND t.revision::text=t.envelope->>'targetRevision' AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.target_definition_heads WHERE target_id=t.id),false)
  THEN RAISE EXCEPTION 'Initial target definition requires exact fresh target insertion' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO e FROM whaleu_ratings.target_edit_transitions WHERE target_id=NEW.target_id AND after_content_version=NEW.content_version;
  SELECT * INTO p FROM whaleu_ratings.target_edit_preparations WHERE account_id=e.actor_account_id AND request_id=e.request_id;
  SELECT * INTO h FROM whaleu_ratings.target_definition_heads WHERE target_id=NEW.target_id FOR UPDATE NOWAIT;
  IF NOT coalesce(e.id IS NOT NULL AND e.mutation_transaction=pg_current_xact_id() AND t.active AND t.creator_id=e.actor_account_id AND t.revision=e.before_revision
   AND (h.content_version,h.definition_revision)=(e.before_content_version,e.before_definition_revision)
   AND (NEW.definition_revision,NEW.applied_target_revision,NEW.name,NEW.description,NEW.envelope,NEW.publication_transaction,NEW.published_at)
    =(e.after_definition_revision,e.after_revision,p.intent->>'name',p.intent->>'description',p.envelope,e.mutation_transaction,e.occurred_at)
   AND whaleu_community.rating_envelope_shape(NEW.envelope,'edit_rating_target')
   AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.target_owner_tombstones WHERE target_id=t.id),false)
  THEN RAISE EXCEPTION 'Target definition version has no exact edit cause' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END;
END IF;END $dispatch$;

CREATE OR REPLACE FUNCTION whaleu_ratings.target_definition() RETURNS trigger LANGUAGE plpgsql AS $dispatch$
BEGIN IF TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM whaleu_ratings.scoped_command_causes WHERE cause_kind='target_edit' AND artifact_id=NEW.id AND artifact_revision=NEW.revision AND mutation_transaction=pg_current_xact_id()) THEN
DECLARE p whaleu_ratings.scoped_command_preparations;BEGIN
 p:=whaleu_ratings.scoped_edit_preparation(NEW.id,NEW.revision);
 IF (to_jsonb(NEW)-'revision') IS DISTINCT FROM (to_jsonb(OLD)-'revision') OR NOT OLD.active OR NEW.revision=OLD.revision OR OLD.creator_id<>p.account_id OR OLD.revision::text<>p.intent->'payload'->>'expectedTargetRevision'
 OR EXISTS(SELECT 1 FROM whaleu_ratings.target_owner_tombstones WHERE target_id=OLD.id)
 OR NOT EXISTS(SELECT 1 FROM whaleu_ratings.target_definition_versions v WHERE v.target_id=NEW.id AND (v.content_version,v.definition_revision,v.applied_target_revision,v.publication_transaction)=(p.content_version,p.definition_revision,p.target_revision,pg_current_xact_id()))
 THEN RAISE EXCEPTION 'Scoped target lifecycle is not its exact immutable identity edit' USING ERRCODE='23514';END IF;RETURN NEW;END;
ELSE

DECLARE a whaleu_ratings.target_owner_delete_audits;e whaleu_ratings.target_edit_transitions;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Target definition is immutable' USING ERRCODE='23514';END IF;
 IF ROW(NEW.id,NEW.category_id,NEW.creator_id,NEW.region_id,NEW.source_id,NEW.name,NEW.description,NEW.envelope,NEW.content_version,NEW.creation_transaction,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.category_id,OLD.creator_id,OLD.region_id,OLD.source_id,OLD.name,OLD.description,OLD.envelope,OLD.content_version,OLD.creation_transaction,OLD.created_at)
 OR NEW.revision=OLD.revision OR EXISTS(SELECT 1 FROM whaleu_ratings.target_owner_tombstones WHERE target_id=OLD.id)
 THEN RAISE EXCEPTION 'Target definition or owner tombstone is immutable' USING ERRCODE='23514';END IF;
 SELECT * INTO a FROM whaleu_ratings.target_owner_delete_audits WHERE target_id=OLD.id AND after_revision=NEW.revision AND outcome='applied' AND mutation_transaction=pg_current_xact_id();
 SELECT * INTO e FROM whaleu_ratings.target_edit_transitions WHERE target_id=OLD.id AND mutation_transaction=pg_current_xact_id();
 IF a.id IS NOT NULL THEN
  IF e.id IS NOT NULL OR NOT coalesce(a.actor_account_id=OLD.creator_id AND a.before_revision=OLD.revision AND a.before_active=OLD.active AND NOT NEW.active,false)
  THEN RAISE EXCEPTION 'Target lifecycle does not match owner deletion' USING ERRCODE='23514';END IF;
 ELSIF e.id IS NOT NULL THEN
  IF NOT coalesce(OLD.active AND NEW.active AND e.actor_account_id=OLD.creator_id AND e.before_revision=OLD.revision AND e.after_revision=NEW.revision
   AND EXISTS(SELECT 1 FROM whaleu_ratings.target_definition_heads h WHERE h.target_id=OLD.id AND (h.content_version,h.definition_revision)=(e.before_content_version,e.before_definition_revision))
   AND EXISTS(SELECT 1 FROM whaleu_ratings.target_definition_versions v WHERE v.target_id=OLD.id AND (v.content_version,v.definition_revision,v.applied_target_revision,v.publication_transaction,v.published_at)
    =(e.after_content_version,e.after_definition_revision,e.after_revision,e.mutation_transaction,e.occurred_at)),false)
  THEN RAISE EXCEPTION 'Target lifecycle does not match exact applied edit' USING ERRCODE='23514';END IF;
 ELSIF NEW.active=OLD.active THEN RAISE EXCEPTION 'Target definition is immutable' USING ERRCODE='23514';END IF;
 RETURN NEW;
END;
END IF;END $dispatch$;

CREATE OR REPLACE FUNCTION whaleu_ratings.record_target_definition_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $dispatch$
BEGIN IF EXISTS(SELECT 1 FROM whaleu_ratings.scoped_command_causes WHERE cause_kind='target_edit' AND artifact_id=NEW.target_id AND artifact_revision=NEW.revision AND mutation_transaction=pg_current_xact_id()) THEN
DECLARE p whaleu_ratings.scoped_command_preparations;BEGIN p:=whaleu_ratings.scoped_edit_preparation(NEW.target_id,NEW.revision);
 INSERT INTO whaleu_ratings.target_definition_lifecycles(target_id,target_revision,content_version,definition_revision) VALUES(NEW.target_id,NEW.revision,p.content_version,p.definition_revision);RETURN NULL;END;
ELSE

DECLARE e whaleu_ratings.target_edit_transitions;h whaleu_ratings.target_definition_heads;
BEGIN
 SELECT * INTO e FROM whaleu_ratings.target_edit_transitions WHERE target_id=NEW.target_id AND after_revision=NEW.revision AND mutation_transaction=pg_current_xact_id();
 IF e.id IS NOT NULL THEN
  INSERT INTO whaleu_ratings.target_definition_lifecycles(target_id,target_revision,content_version,definition_revision) VALUES(NEW.target_id,NEW.revision,e.after_content_version,e.after_definition_revision);
 ELSE
  SELECT * INTO h FROM whaleu_ratings.target_definition_heads WHERE target_id=NEW.target_id;
  IF h.target_id IS NULL THEN RAISE EXCEPTION 'Lifecycle definition head is absent' USING ERRCODE='23514';END IF;
  INSERT INTO whaleu_ratings.target_definition_lifecycles(target_id,target_revision,content_version,definition_revision) VALUES(NEW.target_id,NEW.revision,h.content_version,h.definition_revision);
 END IF;RETURN NULL;
END;
END IF;END $dispatch$;

CREATE OR REPLACE FUNCTION whaleu_ratings.target_definition_lifecycle_guard() RETURNS trigger LANGUAGE plpgsql AS $dispatch$
BEGIN IF EXISTS(SELECT 1 FROM whaleu_ratings.scoped_command_causes WHERE cause_kind='target_edit' AND artifact_id=NEW.target_id AND artifact_revision=NEW.target_revision AND mutation_transaction=pg_current_xact_id()) THEN
DECLARE p whaleu_ratings.scoped_command_preparations;BEGIN p:=whaleu_ratings.scoped_edit_preparation(NEW.target_id,NEW.target_revision);
 IF pg_trigger_depth()<2 OR (NEW.content_version,NEW.definition_revision) IS DISTINCT FROM (p.content_version,p.definition_revision)
 OR NOT EXISTS(SELECT 1 FROM whaleu_ratings.target_state_revisions s JOIN whaleu_ratings.targets t ON t.id=s.target_id AND t.revision=s.revision AND t.active=s.active WHERE s.target_id=NEW.target_id AND s.revision=NEW.target_revision AND s.mutation_transaction=pg_current_xact_id())
 THEN RAISE EXCEPTION 'Scoped lifecycle has no exact state transition' USING ERRCODE='23514';END IF;RETURN NEW;END;
ELSE

DECLARE s whaleu_ratings.target_state_revisions;t whaleu_ratings.targets;h whaleu_ratings.target_definition_heads;e whaleu_ratings.target_edit_transitions;
BEGIN
 SELECT * INTO s FROM whaleu_ratings.target_state_revisions WHERE target_id=NEW.target_id AND revision=NEW.target_revision;
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=NEW.target_id;
 SELECT * INTO h FROM whaleu_ratings.target_definition_heads WHERE target_id=NEW.target_id;
 SELECT * INTO e FROM whaleu_ratings.target_edit_transitions WHERE target_id=NEW.target_id AND after_revision=NEW.target_revision AND mutation_transaction=pg_current_xact_id();
 IF NOT coalesce(pg_trigger_depth()>=2 AND s.target_id=t.id AND t.revision=s.revision AND t.active=s.active AND s.mutation_transaction=pg_current_xact_id()
  AND ((e.id IS NOT NULL AND (NEW.content_version,NEW.definition_revision)=(e.after_content_version,e.after_definition_revision))
   OR (e.id IS NULL AND (NEW.content_version,NEW.definition_revision)=(h.content_version,h.definition_revision))),false)
 THEN RAISE EXCEPTION 'Lifecycle definition mapping has no exact state cause' USING ERRCODE='23514';END IF;RETURN NEW;
END;
END IF;END $dispatch$;

CREATE OR REPLACE FUNCTION whaleu_ratings.target_definition_head_guard() RETURNS trigger LANGUAGE plpgsql AS $dispatch$
BEGIN IF TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM whaleu_ratings.target_definition_versions WHERE target_id=NEW.target_id AND content_version=NEW.content_version AND envelope->'version'='5'::jsonb) THEN
DECLARE p whaleu_ratings.scoped_command_preparations;v whaleu_ratings.target_definition_versions;BEGIN
 SELECT * INTO v FROM whaleu_ratings.target_definition_versions WHERE target_id=NEW.target_id AND content_version=NEW.content_version;
 p:=whaleu_ratings.scoped_edit_preparation(NEW.target_id,v.applied_target_revision);
 IF NOT coalesce(NEW.target_id=OLD.target_id AND NEW.content_version=OLD.content_version+1 AND NEW.definition_revision<>OLD.definition_revision
 AND (NEW.content_version,NEW.definition_revision)=(p.content_version,p.definition_revision)
 AND OLD.definition_revision::text=p.intent->'payload'->>'expectedDefinitionRevision' AND OLD.content_version=(p.intent->'payload'->>'expectedContentVersion')::integer
 AND EXISTS(SELECT 1 FROM whaleu_ratings.targets t WHERE t.id=p.target_id AND t.active AND t.creator_id=p.account_id AND t.revision=p.target_revision)
 AND EXISTS(SELECT 1 FROM whaleu_ratings.target_definition_lifecycles l WHERE l.target_id=p.target_id AND l.target_revision=p.target_revision AND (l.content_version,l.definition_revision)=(p.content_version,p.definition_revision)),false)
 THEN RAISE EXCEPTION 'Scoped head must advance exactly caused version' USING ERRCODE='23514';END IF;RETURN NEW;END;
ELSE

DECLARE t whaleu_ratings.targets;v whaleu_ratings.target_definition_versions;e whaleu_ratings.target_edit_transitions;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Target definition head is retained' USING ERRCODE='23514';END IF;
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=NEW.target_id FOR UPDATE NOWAIT;
 SELECT * INTO v FROM whaleu_ratings.target_definition_versions WHERE target_id=NEW.target_id AND content_version=NEW.content_version AND definition_revision=NEW.definition_revision;
 IF TG_OP='INSERT' THEN
  IF NOT coalesce(pg_trigger_depth()>=2 AND NEW.content_version=1 AND v.publication_transaction=pg_current_xact_id()
   AND t.creation_transaction=v.publication_transaction AND t.revision=v.applied_target_revision AND NEW.definition_revision=v.applied_target_revision,false)
  THEN RAISE EXCEPTION 'Initial target definition head has no fresh target' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO e FROM whaleu_ratings.target_edit_transitions WHERE target_id=NEW.target_id AND after_content_version=NEW.content_version;
  IF NOT coalesce(NEW.target_id=OLD.target_id AND OLD.content_version<2147483647 AND NEW.content_version=OLD.content_version+1
   AND NEW.definition_revision<>OLD.definition_revision AND e.id IS NOT NULL AND e.mutation_transaction=pg_current_xact_id()
   AND (OLD.content_version,OLD.definition_revision)=(e.before_content_version,e.before_definition_revision)
   AND (NEW.content_version,NEW.definition_revision)=(e.after_content_version,e.after_definition_revision)
   AND t.active AND t.creator_id=e.actor_account_id AND t.revision=e.after_revision AND v.applied_target_revision=e.after_revision
   AND EXISTS(SELECT 1 FROM whaleu_ratings.target_definition_lifecycles l WHERE l.target_id=t.id AND l.target_revision=t.revision AND (l.content_version,l.definition_revision)=(NEW.content_version,NEW.definition_revision))
   AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.target_owner_tombstones WHERE target_id=t.id),false)
  THEN RAISE EXCEPTION 'Target definition head must advance exactly one caused version' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END;
END IF;END $dispatch$;

CREATE OR REPLACE FUNCTION whaleu_ratings.target_definition_artifact_causal() RETURNS trigger LANGUAGE plpgsql AS $dispatch$
BEGIN IF TG_TABLE_NAME IN ('target_definition_versions','target_definition_heads') AND (to_jsonb(NEW)->>'content_version')::integer>1 AND EXISTS(SELECT 1 FROM whaleu_ratings.target_definition_versions WHERE target_id=(to_jsonb(NEW)->>'target_id')::uuid AND content_version=(to_jsonb(NEW)->>'content_version')::integer AND envelope->'version'='5'::jsonb) THEN
DECLARE p whaleu_ratings.scoped_command_preparations;v whaleu_ratings.target_definition_versions;BEGIN
 SELECT * INTO v FROM whaleu_ratings.target_definition_versions WHERE target_id=NEW.target_id AND content_version=NEW.content_version;
 p:=whaleu_ratings.scoped_edit_preparation(NEW.target_id,v.applied_target_revision);
 IF TG_TABLE_NAME='target_definition_heads' AND TG_OP='UPDATE' AND (OLD.definition_revision::text,OLD.content_version) IS DISTINCT FROM (p.intent->'payload'->>'expectedDefinitionRevision',(p.intent->'payload'->>'expectedContentVersion')::integer)
 THEN RAISE EXCEPTION 'Scoped definition artifact predecessor mismatch' USING ERRCODE='23514';END IF;
 PERFORM whaleu_ratings.verify_scoped_target_edit(p.account_id,p.request_id);RETURN NULL;END;
ELSE

DECLARE e whaleu_ratings.target_edit_transitions;v whaleu_ratings.target_definition_versions;
BEGIN
 IF TG_TABLE_NAME='target_definition_lifecycles' THEN
  PERFORM whaleu_ratings.verify_target_definition_lifecycle(NEW.target_id,NEW.target_revision);RETURN NULL;
 ELSIF TG_TABLE_NAME='target_state_revisions' THEN
  PERFORM whaleu_ratings.verify_target_definition_lifecycle(NEW.target_id,NEW.revision);RETURN NULL;
 END IF;
 IF NEW.content_version=1 THEN
  PERFORM whaleu_ratings.verify_target_definition_initial(NEW.target_id);RETURN NULL;
 END IF;
 SELECT * INTO e FROM whaleu_ratings.target_edit_transitions WHERE target_id=NEW.target_id AND after_content_version=NEW.content_version;
 SELECT * INTO v FROM whaleu_ratings.target_definition_versions WHERE target_id=NEW.target_id AND content_version=NEW.content_version;
 IF NOT coalesce(e.id IS NOT NULL AND e.mutation_transaction=pg_current_xact_id()
  AND NEW.definition_revision=e.after_definition_revision AND v.definition_revision=e.after_definition_revision
  AND v.applied_target_revision=e.after_revision AND v.publication_transaction=e.mutation_transaction,false)
 THEN RAISE EXCEPTION 'Target definition artifact has no exact fresh edit' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='target_definition_heads' AND TG_OP='UPDATE' THEN
  IF (OLD.target_id,OLD.content_version,OLD.definition_revision) IS DISTINCT FROM (e.target_id,e.before_content_version,e.before_definition_revision)
  THEN RAISE EXCEPTION 'Target definition head predecessor mismatch' USING ERRCODE='23514';END IF;
 END IF;
 PERFORM whaleu_ratings.verify_target_edit(e.actor_account_id,e.request_id);RETURN NULL;
END;
END IF;END $dispatch$;

CREATE OR REPLACE FUNCTION whaleu_ratings.verify_target_definition_lifecycle(_target uuid,_revision uuid) RETURNS void LANGUAGE plpgsql AS $body$
DECLARE t whaleu_ratings.targets;s whaleu_ratings.target_state_revisions;l whaleu_ratings.target_definition_lifecycles;
 h whaleu_ratings.target_definition_heads;current_l whaleu_ratings.target_definition_lifecycles;e whaleu_ratings.target_edit_transitions;
BEGIN
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=_target;
 SELECT * INTO s FROM whaleu_ratings.target_state_revisions x WHERE x.target_id=_target AND x.revision=_revision;
 SELECT * INTO l FROM whaleu_ratings.target_definition_lifecycles WHERE target_id=_target AND target_revision=_revision;
 SELECT * INTO h FROM whaleu_ratings.target_definition_heads WHERE target_id=_target;
 SELECT * INTO current_l FROM whaleu_ratings.target_definition_lifecycles WHERE target_id=_target AND target_revision=t.revision;
 SELECT * INTO e FROM whaleu_ratings.target_edit_transitions WHERE target_id=_target AND after_revision=_revision AND mutation_transaction=pg_current_xact_id();
 IF NOT coalesce(t.id=_target AND s.target_id=_target AND s.mutation_transaction=pg_current_xact_id()
  AND (l.content_version,l.definition_revision)=(h.content_version,h.definition_revision)
  AND (current_l.content_version,current_l.definition_revision)=(h.content_version,h.definition_revision)
  AND EXISTS(SELECT 1 FROM whaleu_ratings.target_state_revisions current_s WHERE current_s.target_id=t.id AND current_s.revision=t.revision AND current_s.active=t.active),false)
 THEN RAISE EXCEPTION 'Target state/current definition reverse link incomplete' USING ERRCODE='23514';END IF;
 IF e.id IS NOT NULL THEN PERFORM whaleu_ratings.verify_target_edit(e.actor_account_id,e.request_id);END IF;
PERFORM whaleu_ratings.verify_scoped_target_edit(cause_row.account_id,cause_row.request_id) FROM whaleu_ratings.scoped_command_causes cause_row WHERE cause_row.cause_kind='target_edit' AND cause_row.artifact_id=_target AND cause_row.artifact_revision=_revision AND cause_row.mutation_transaction=pg_current_xact_id();
END $body$;

CREATE OR REPLACE FUNCTION whaleu_ratings.managed_source_causal() RETURNS trigger LANGUAGE plpgsql AS $dispatch$
BEGIN IF NEW.source_reference LIKE 'rating-scoped-create:%' THEN
DECLARE e whaleu_ratings.scoped_command_causes;BEGIN SELECT * INTO e FROM whaleu_ratings.scoped_command_causes WHERE cause_kind='target_initial' AND proof->>'sourceId'=NEW.id::text;
 IF e.artifact_id IS NULL THEN RAISE EXCEPTION 'Scoped native source needs exact initial cause' USING ERRCODE='23514';END IF;
 PERFORM whaleu_ratings.verify_scoped_target_initial(e.artifact_id);RETURN NULL;END;
ELSE

DECLARE e whaleu_ratings.target_create_transitions;
BEGIN
 IF NEW.source_reference LIKE 'rating-create:%' THEN
 SELECT * INTO e FROM whaleu_ratings.target_create_transitions WHERE source_id=NEW.id;
 IF e.target_id IS NULL THEN RAISE EXCEPTION 'Managed native source requires create command' USING ERRCODE='23514';END IF;
 PERFORM whaleu_ratings.verify_target_create(e.account_id,e.request_id);END IF;RETURN NULL;
END;
END IF;END $dispatch$;
CREATE INDEX scoped_actor_subscriptions ON whaleu_ratings.subscription_memberships(account_id,target_id);
CREATE FUNCTION whaleu_ratings.scoped_native_placement(actor uuid,request uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE p whaleu_ratings.scoped_command_preparations;policy whaleu_ratings.scoped_source_attestations;old whaleu_ratings.scoped_source_attestations;key text;placement uuid:=gen_random_uuid();source uuid:=gen_random_uuid();revision uuid:=gen_random_uuid();coverage uuid:=gen_random_uuid();coverage_revision uuid:=gen_random_uuid();payload jsonb;at timestamptz:=clock_timestamp();BEGIN
 SELECT * INTO p FROM whaleu_ratings.scoped_command_preparations WHERE account_id=actor AND request_id=request;
 PERFORM whaleu_ratings.scoped_domain_request(actor,request);
 SELECT policy_source.* INTO policy FROM whaleu_ratings.scoped_source_attestations policy_source WHERE policy_source.id=p.policy_source_id AND policy_source.revision=p.policy_source_revision;
 key:=CASE WHEN p.intent->'context'->'selector'->>'kind'='global' THEN 'global' ELSE 'campus:'||(p.intent->'context'->'selector'->>'campusId') END;
 IF NOT coalesce(p.operation='create_target_scoped' AND policy.source_kind='native_scoped_create' AND policy.payload->'enabled'='true'::jsonb AND key=ANY(policy.scope_keys)
 AND whaleu_ratings.scoped_source_current(policy.id,policy.revision,at) AND EXISTS(SELECT 1 FROM whaleu_ratings.scoped_command_causes WHERE account_id=actor AND request_id=request AND cause_kind='target_initial' AND artifact_id=p.target_id AND mutation_transaction=pg_current_xact_id()),false)
 THEN RAISE EXCEPTION 'Native placement requires exact accepted creation authority' USING ERRCODE='23514';END IF;
 SELECT s.* INTO old FROM whaleu_ratings.scoped_source_heads h JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(h.source_id,h.source_revision) WHERE h.source_kind='scope_absence' AND h.source_key=key FOR UPDATE OF h;
 IF old.id IS NULL OR old.payload->'complete'<>'true'::jsonb OR NOT whaleu_ratings.scoped_source_current(old.id,old.revision,at) THEN RAISE EXCEPTION 'Native placement requires complete negative predecessor' USING ERRCODE='23514';END IF;
 payload:=jsonb_build_object('targetId',p.target_id,'categoryId',p.intent->'payload'->'categoryId','nativeCommand',jsonb_build_object('accountId',actor,'requestId',request),'policySourceId',policy.id,'policySourceRevision',policy.revision);
 INSERT INTO whaleu_ratings.scoped_source_attestations(id,revision,source_kind,source_key,scope_keys,payload,digest,coverage,provenance,issuer,source_reference,policy_reference,effective_at,valid_until)
 VALUES(source,revision,'scoped_target_placement',p.target_id::text,ARRAY[key],payload,whaleu_ratings.scoped_digest('source',jsonb_build_object('id',source,'revision',revision,'kind','scoped_target_placement','key',p.target_id::text,'scopeKeys',ARRAY[key],'payload',payload)),'complete','accepted','ratings-native-command','rating-scoped-create:'||actor::text||':'||request::text,policy.policy_reference,at,least(policy.valid_until,old.valid_until));
 INSERT INTO whaleu_ratings.scoped_source_heads VALUES('scoped_target_placement',p.target_id::text,source,revision);
 INSERT INTO whaleu_ratings.target_scope_placements VALUES(placement,p.target_id,ARRAY[key],source,revision,pg_current_xact_id());
 payload:=jsonb_set(old.payload,'{targetIds}',(SELECT jsonb_agg(id ORDER BY id) FROM (SELECT value id FROM jsonb_array_elements_text(old.payload->'targetIds') UNION SELECT p.target_id::text) targets));
 payload:=payload||jsonb_build_object('nativeCommand',jsonb_build_object('accountId',actor,'requestId',request),'previousSourceId',old.id,'previousSourceRevision',old.revision);
 INSERT INTO whaleu_ratings.scoped_source_attestations(id,revision,source_kind,source_key,scope_keys,payload,digest,coverage,provenance,issuer,source_reference,policy_reference,effective_at,valid_until)
 VALUES(coverage,coverage_revision,'scope_absence',key,ARRAY[key],payload,whaleu_ratings.scoped_digest('source',jsonb_build_object('id',coverage,'revision',coverage_revision,'kind','scope_absence','key',key,'scopeKeys',ARRAY[key],'payload',payload)),'complete','accepted','ratings-native-command','rating-scoped-create:'||actor::text||':'||request::text,policy.policy_reference,greatest(at,old.effective_at+interval '1 microsecond'),least(policy.valid_until,old.valid_until));
 UPDATE whaleu_ratings.scoped_source_heads SET source_id=coverage,source_revision=coverage_revision WHERE source_kind='scope_absence' AND source_key=key AND source_id=old.id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Native placement source predecessor changed' USING ERRCODE='23514';END IF;
END $$;

CREATE FUNCTION whaleu_ratings.scoped_preparation_causal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_ratings.requests;
BEGIN
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=NEW.account_id AND request_id=NEW.request_id;
 IF q.receipt IS NOT NULL THEN PERFORM whaleu_ratings.verify_scoped_command(NEW.account_id,NEW.request_id);RETURN NULL;END IF;
 IF NEW.valid_until<=clock_timestamp() OR NOT whaleu_ratings.scoped_context_current(NEW.context_id,NEW.account_id,NEW.session_id,clock_timestamp())
 OR NEW.envelope IS DISTINCT FROM whaleu_ratings.scoped_preparation_envelope(NEW)
 OR NOT EXISTS(SELECT 1 FROM whaleu_ratings.command_claims c WHERE c.account_id=NEW.account_id AND c.request_id=NEW.request_id AND c.operation=NEW.operation AND c.intent_hash=NEW.intent_hash)
 THEN RAISE EXCEPTION 'Scoped preparation lacks current exact namespace/context/envelope' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER scoped_preparation_causal AFTER INSERT ON whaleu_ratings.scoped_command_preparations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.scoped_preparation_causal();
