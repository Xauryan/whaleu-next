-- M3C exact category management. No production grants, issuer policies or registries are seeded.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
DO $fingerprint$ DECLARE x record; actual text; n integer; BEGIN
 FOR x IN SELECT * FROM (VALUES
('whaleu_ratings.rating_scoped_operation_rule','cedd139a510c3ae090362500ac946fc0e4b9fe1063163d0bd92de6a3812c9029'),
('whaleu_ratings.scoped_intent_valid','1a674b89809d95451750f53aa5da88b13f102e7dd5628276c846242c65a9f83a'),
('whaleu_ratings.scoped_context_current','9d10ae98ccc376bf7d22bbcc3e0e73d45dc8b7532279670679ba581eaf1983f0'),
('whaleu_ratings.scoped_preparation_guard','47060ddd2a731059805903fa17e0afd6b41f84cb327d52ccd7ce0aa02ae9fe86'),
('whaleu_ratings.scoped_preparation_envelope','2ca557fb0ebae77894d76e067791423aee9cef3076eb1f3d3265fe3d60242475'),
('whaleu_ratings.verify_scoped_command','55151946b6899cd65474e7f3d6a1a2dd5b8b71838d327a06f51204d314fd9955'),
('whaleu_ratings.scoped_base_category','9ef2c7e503371e81cbc91b26430ef6a0bafecf3d69e26aeb593bc0ad086bb8ae'),
('whaleu_ratings.scoped_expected_category','594793dbb20ed4a484114eb0523de8d8adcc01d9589972bf69da8b3abb1c9dd4'),
('whaleu_ratings.verify_scoped_catalog','744157a9643752a5923d4fc61bf24d44c74753b43233cce847cfd92002311829'),
('whaleu_ratings.verify_scoped_release','cac8312ac34cae236da5d33e97fa4d7c92a8d0bdf64a7aabec9e47b38b5a25fd'),
('whaleu_community.verify_rating_scoped_source_binding','865e06859453ac2f7e673b2cb0e3b9f4ae4118d392593c09e20b64716f8dea16'),
('whaleu_ratings.legacy_bridge_source_causal','cbb19983ed0458f268205c2334506c705faba5486192fc32b628c1914eb1c9de'),
('whaleu_ratings.legacy_bridge_sources','e081fc7c19eb67d7b2b3a51cb9798c18f23599d1e13f7c30d2b31807e7d2db4a'),
('whaleu_ratings.scoped_execution_guard','ed892ac2cc7cbe860e76c653efb52014d4b076361cb9775916098a60eb07bea1'),
('whaleu_ratings.scoped_native_placement','1ef1fc84fdcb1f488b7b5900abf903e0578489c0531b8b311cd6fd3a709c1db4'),
('whaleu_ratings.scoped_placement_source_causal','5e65f7069f7f4dedd1567ae748195e835e41edaee4b6f8be207a8a42569d6b10'),
('whaleu_ratings.verify_compat_projection','f653060d97e2e0e2565f0162f12c6abdb4c5d9539b5b41e95045daea811375d4')) expected(name,digest) LOOP
 SELECT count(*),min(encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')) INTO n,actual FROM pg_proc p JOIN pg_namespace s ON s.oid=p.pronamespace WHERE s.nspname||'.'||p.proname=x.name;
 IF n<>1 OR actual<>x.digest THEN RAISE EXCEPTION 'Unexpected M3B function fingerprint: %',x.name USING ERRCODE='23514';END IF; END LOOP;END $fingerprint$;
CREATE TABLE whaleu_authorization.rating_category_campus_grants (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
  campus_id uuid NOT NULL REFERENCES whaleu_campus.campuses(id),
  approved_by_account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
  approval_reference text NOT NULL CHECK (
    char_length(approval_reference) BETWEEN 1 AND 200 AND
    char_length(btrim(approval_reference)) > 0
  ),
  valid_from timestamptz NOT NULL,
  expires_at timestamptz,
  revoked_at timestamptz,
  CHECK (isfinite(valid_from)),
  CHECK (expires_at IS NULL OR (isfinite(expires_at) AND expires_at > valid_from)),
  CHECK (revoked_at IS NULL OR isfinite(revoked_at))
);
CREATE UNIQUE INDEX rating_category_campus_grants_unrevoked
  ON whaleu_authorization.rating_category_campus_grants(account_id,campus_id)
  WHERE revoked_at IS NULL;
CREATE INDEX rating_category_campus_grants_actor
  ON whaleu_authorization.rating_category_campus_grants(account_id);
CREATE FUNCTION whaleu_authorization.protect_rating_category_campus_grant()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Category campus grants must be revoked, not deleted' USING ERRCODE='23514';
  END IF;
  IF (NEW.id,NEW.account_id,NEW.campus_id,NEW.approved_by_account_id,NEW.approval_reference,NEW.valid_from,NEW.expires_at)
     IS DISTINCT FROM
     (OLD.id,OLD.account_id,OLD.campus_id,OLD.approved_by_account_id,OLD.approval_reference,OLD.valid_from,OLD.expires_at)
     OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
  THEN
    RAISE EXCEPTION 'Category campus grant facts are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER protect_rating_category_campus_grant
  BEFORE UPDATE OR DELETE ON whaleu_authorization.rating_category_campus_grants
  FOR EACH ROW EXECUTE FUNCTION whaleu_authorization.protect_rating_category_campus_grant();

CREATE FUNCTION whaleu_authorization.rating_category_management_authority_covers(
  actor uuid, campus_ids uuid[], global_required boolean
) RETURNS boolean LANGUAGE sql VOLATILE AS $$
WITH instant AS MATERIALIZED (SELECT clock_timestamp() now),
role_sources AS MATERIALIZED (
  SELECT g.role,g.operating_region_id
  FROM whaleu_authorization.role_grants g CROSS JOIN instant
  WHERE g.account_id=actor AND g.revoked_at IS NULL
    AND isfinite(g.valid_from) AND g.valid_from<=instant.now
    AND (g.expires_at IS NULL OR (isfinite(g.expires_at) AND g.expires_at>g.valid_from AND g.expires_at>instant.now))
    AND char_length(btrim(g.approval_reference))>0
),
exact_sources AS MATERIALIZED (
  SELECT g.campus_id
  FROM whaleu_authorization.rating_category_campus_grants g CROSS JOIN instant
  WHERE g.account_id=actor AND g.revoked_at IS NULL
    AND isfinite(g.valid_from) AND g.valid_from<=instant.now
    AND (g.expires_at IS NULL OR (isfinite(g.expires_at) AND g.expires_at>g.valid_from AND g.expires_at>instant.now))
    AND char_length(btrim(g.approval_reference))>0
),
global_authority AS MATERIALIZED (
  SELECT EXISTS(SELECT 1 FROM role_sources WHERE role IN ('developer','super_admin') AND operating_region_id IS NULL) allowed
),
wanted AS MATERIALIZED (SELECT campus_id FROM unnest(campus_ids) AS w(campus_id))
SELECT coalesce(
  actor IS NOT NULL AND campus_ids IS NOT NULL AND global_required IS NOT NULL
  AND coalesce(array_ndims(campus_ids),1)=1
  AND cardinality(campus_ids)<=1000
  AND (SELECT count(*) FROM whaleu_authorization.role_grants WHERE account_id=actor AND revoked_at IS NULL)<=3
  AND (SELECT count(*) FROM whaleu_authorization.rating_category_campus_grants WHERE account_id=actor AND revoked_at IS NULL)<=1000
  AND NOT EXISTS(SELECT 1 FROM wanted WHERE campus_id IS NULL)
  AND (SELECT count(*) FROM wanted)=(SELECT count(DISTINCT campus_id) FROM wanted)
  AND (global_required OR cardinality(campus_ids)>0)
  AND (NOT global_required OR (SELECT allowed FROM global_authority))
  AND NOT EXISTS(
    SELECT 1 FROM wanted w
    LEFT JOIN whaleu_campus.campuses c ON c.id=w.campus_id
    LEFT JOIN whaleu_campus.campus_region_assignments a ON a.campus_id=c.id
    LEFT JOIN whaleu_campus.operating_regions r ON r.id=a.operating_region_id
    WHERE c.id IS NULL OR c.is_active IS DISTINCT FROM true OR r.is_active IS DISTINCT FROM true
      OR NOT (
        (SELECT allowed FROM global_authority)
        OR EXISTS(SELECT 1 FROM role_sources g WHERE g.role='school_admin' AND g.operating_region_id=r.id)
        OR EXISTS(SELECT 1 FROM exact_sources g WHERE g.campus_id=w.campus_id)
      )
  ),false);
$$;

CREATE TRIGGER a00_category_grant_writer BEFORE INSERT OR UPDATE OR DELETE ON whaleu_authorization.rating_category_campus_grants FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.scoped_public_writer_gate();
CREATE TRIGGER category_grant_retain BEFORE TRUNCATE ON whaleu_authorization.rating_category_campus_grants FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.immutable();
ALTER TABLE whaleu_ratings.scoped_source_attestations DROP CONSTRAINT scoped_source_attestations_source_kind_check;
ALTER TABLE whaleu_ratings.scoped_source_attestations ADD CONSTRAINT scoped_source_attestations_source_kind_check CHECK(source_kind IN ('m3a_native_bridge','legacy_adoption','scoped_category_base','scoped_category_override','scoped_category_lifecycle','scoped_category_order','scoped_category_scope','scoped_target_placement','native_scoped_create','native_v1_compat_write','scope_absence','scope_capabilities','native_scoped_category_management','scoped_category_system_registry'));
CREATE FUNCTION whaleu_ratings.category_management_operation(op text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT coalesce(op IN ('create_categories_scoped','edit_category_base_scoped','set_category_override_scoped','set_category_visibility_scoped','reorder_categories_scoped','set_category_scope_scoped','set_category_lifecycle_scoped','batch_update_subcategories_scoped','create_system_category_scoped'),false) $$;
CREATE FUNCTION whaleu_ratings.rating_scoped_operation_rule_pre_category(op text,protocol integer) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
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
CREATE OR REPLACE FUNCTION whaleu_ratings.rating_scoped_operation_rule(op text,protocol integer) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN protocol=2 AND whaleu_ratings.category_management_operation(op) THEN jsonb_build_object('domain','category_management','purpose',NULL,'effect',NULL) ELSE whaleu_ratings.rating_scoped_operation_rule_pre_category(op,protocol) END
$$;
CREATE FUNCTION whaleu_ratings.category_management_ids(v jsonb,maximum integer) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$ DECLARE item jsonb;BEGIN
 IF jsonb_typeof(v)<>'array' OR jsonb_array_length(v)>maximum OR (SELECT count(*)<>count(DISTINCT value) FROM jsonb_array_elements(v)) THEN RETURN false;END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(v) LOOP IF NOT whaleu_community.rating_scoped_ids(jsonb_build_object('id',item),ARRAY['id']) THEN RETURN false;END IF;END LOOP;RETURN true;EXCEPTION WHEN OTHERS THEN RETURN false;END $$;
CREATE FUNCTION whaleu_ratings.category_management_nodes(v jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$ DECLARE item jsonb;seen text[]:=ARRAY[]::text[];BEGIN
 IF jsonb_typeof(v)<>'array' OR jsonb_array_length(v)>32 THEN RETURN false;END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(v) LOOP
 IF NOT whaleu_community.rating_scoped_keys(item,ARRAY['key','parentKey','name','description']) OR item->>'key' !~ '^[a-z][a-z0-9_]{0,31}$' OR item->>'key'=ANY(seen)
 OR (item->'parentKey'<>'null'::jsonb AND NOT item->>'parentKey'=ANY(seen))
 OR NOT whaleu_community.rating_target_edit_text_valid(item->>'name',100,true) OR NOT whaleu_community.rating_target_edit_text_valid(item->>'description',500,false) THEN RETURN false;END IF;seen:=array_append(seen,item->>'key');END LOOP;RETURN true;EXCEPTION WHEN OTHERS THEN RETURN false;END $$;
CREATE FUNCTION whaleu_ratings.category_management_override(v jsonb,required boolean) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT coalesce((whaleu_community.rating_scoped_keys(v,ARRAY['mode']) AND v->>'mode'='inherit') OR (whaleu_community.rating_scoped_keys(v,ARRAY['mode','value']) AND v->>'mode'='set' AND whaleu_community.rating_target_edit_text_valid(v->>'value',CASE WHEN required THEN 100 ELSE 500 END,required)),false) $$;
CREATE FUNCTION whaleu_ratings.category_management_intent_valid(i jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE p jsonb:=i->'payload';c jsonb:=i->'context';op text:=i->>'operation';k text[]:=ARRAY['clientRequestId','expectedSnapshot'];item jsonb;
BEGIN
 IF NOT whaleu_community.rating_scoped_keys(i,ARRAY['protocolVersion','operation','context','payload']) OR i->'protocolVersion'<>'2'::jsonb OR NOT whaleu_ratings.category_management_operation(op)
 OR NOT whaleu_community.rating_scoped_keys(c,ARRAY['id','tokenDigest','token','selector','scopeRevision','protocolGeneration','catalogRevision','headRevision','sourceDigest']) OR NOT whaleu_community.rating_scoped_ids(c,ARRAY['id','protocolGeneration','catalogRevision','headRevision'])
 OR NOT whaleu_community.rating_scoped_selector_shape(c->'selector') OR c->>'token' !~ '^[A-Za-z0-9_-]{43}$' OR c->>'tokenDigest'<>encode(sha256(convert_to(c->>'token','UTF8')),'hex')
 OR c->>'scopeRevision' !~ '^[a-f0-9]{64}$' OR c->>'sourceDigest' !~ '^[a-f0-9]{64}$' OR NOT whaleu_community.rating_scoped_ids(p,ARRAY['clientRequestId']) OR p->>'expectedSnapshot' !~ '^[a-f0-9]{64}$' THEN RETURN false;END IF;
 CASE op
 WHEN 'create_categories_scoped' THEN k:=k||ARRAY['parentId','placement','nodes'];IF NOT whaleu_community.rating_scoped_nullable_id(p->'parentId') OR NOT whaleu_community.rating_scoped_placement_shape(p->'placement') OR NOT whaleu_ratings.category_management_nodes(p->'nodes') OR jsonb_array_length(p->'nodes')<1 OR (SELECT count(*) FROM jsonb_array_elements(p->'nodes') n WHERE n->'parentKey'='null'::jsonb)<>1 THEN RETURN false;END IF;
 WHEN 'create_system_category_scoped' THEN k:=k||ARRAY['systemKey','name','description','placement','levelCount'];IF p->>'systemKey' !~ '^[a-z][a-z0-9_]{1,48}$' OR NOT whaleu_community.rating_target_edit_text_valid(p->>'name',100,true) OR NOT whaleu_community.rating_target_edit_text_valid(p->>'description',500,false) OR NOT whaleu_community.rating_scoped_placement_shape(p->'placement') OR NOT whaleu_community.rating_scoped_integer(p->'levelCount',1) OR (p->>'levelCount')::integer>3 THEN RETURN false;END IF;
 WHEN 'edit_category_base_scoped' THEN k:=k||ARRAY['categoryId','name','description'];IF NOT whaleu_community.rating_scoped_ids(p,ARRAY['categoryId']) OR NOT whaleu_community.rating_target_edit_text_valid(p->>'name',100,true) OR NOT whaleu_community.rating_target_edit_text_valid(p->>'description',500,false) THEN RETURN false;END IF;
 WHEN 'set_category_override_scoped' THEN k:=k||ARRAY['categoryId','name','description'];IF NOT whaleu_community.rating_scoped_ids(p,ARRAY['categoryId']) OR NOT whaleu_ratings.category_management_override(p->'name',true) OR NOT whaleu_ratings.category_management_override(p->'description',false) THEN RETURN false;END IF;
 WHEN 'set_category_visibility_scoped' THEN k:=k||ARRAY['categoryId','hidden'];IF NOT whaleu_community.rating_scoped_ids(p,ARRAY['categoryId']) OR jsonb_typeof(p->'hidden')<>'boolean' THEN RETURN false;END IF;
 WHEN 'set_category_scope_scoped' THEN k:=k||ARRAY['categoryId','placement','propagation'];IF NOT whaleu_community.rating_scoped_ids(p,ARRAY['categoryId']) OR NOT whaleu_community.rating_scoped_placement_shape(p->'placement') OR p->>'propagation' NOT IN ('self','subtree') THEN RETURN false;END IF;
 WHEN 'set_category_lifecycle_scoped' THEN k:=k||ARRAY['categoryId','state','restore'];IF NOT whaleu_community.rating_scoped_ids(p,ARRAY['categoryId']) OR p->>'state' NOT IN ('enabled','disabled','archived') OR jsonb_typeof(p->'restore')<>'boolean' THEN RETURN false;END IF;
 WHEN 'reorder_categories_scoped' THEN k:=k||ARRAY['parentId','action','orderedIds'];IF NOT whaleu_community.rating_scoped_nullable_id(p->'parentId') OR p->>'action' NOT IN ('set','inherit') OR NOT whaleu_ratings.category_management_ids(p->'orderedIds',10000) OR (p->>'action'='inherit' AND p->'orderedIds'<>'[]'::jsonb) THEN RETURN false;END IF;
 WHEN 'batch_update_subcategories_scoped' THEN k:=k||ARRAY['parentId','addNodes','disableIds','restoreIds','enableIds','orderedChildren'];IF NOT whaleu_community.rating_scoped_ids(p,ARRAY['parentId']) OR NOT whaleu_ratings.category_management_nodes(p->'addNodes') OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->'addNodes') n WHERE n->'parentKey' IS DISTINCT FROM 'null'::jsonb) OR NOT whaleu_ratings.category_management_ids(p->'disableIds',10000) OR NOT whaleu_ratings.category_management_ids(p->'restoreIds',10000) OR NOT whaleu_ratings.category_management_ids(p->'enableIds',10000) OR jsonb_typeof(p->'orderedChildren')<>'array' OR jsonb_array_length(p->'orderedChildren')>10000 THEN RETURN false;END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p->'orderedChildren') LOOP IF NOT ((whaleu_community.rating_scoped_keys(item,ARRAY['kind','id']) AND item->>'kind'='existing' AND whaleu_community.rating_scoped_ids(item,ARRAY['id'])) OR (whaleu_community.rating_scoped_keys(item,ARRAY['kind','key']) AND item->>'kind'='new' AND item->>'key' ~ '^[a-z][a-z0-9_]{0,31}$')) THEN RETURN false;END IF;END LOOP;
 ELSE RETURN false;END CASE;RETURN whaleu_community.rating_scoped_keys(p,k);
EXCEPTION WHEN OTHERS THEN RETURN false;END $$;
CREATE FUNCTION whaleu_ratings.scoped_intent_valid_pre_category(i jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
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
CREATE OR REPLACE FUNCTION whaleu_ratings.scoped_intent_valid(i jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN whaleu_ratings.category_management_operation(i->>'operation') THEN whaleu_ratings.category_management_intent_valid(i) ELSE whaleu_ratings.scoped_intent_valid_pre_category(i) END $$;
ALTER TABLE whaleu_ratings.requests DROP CONSTRAINT requests_operation_check;
ALTER TABLE whaleu_ratings.requests ADD CONSTRAINT requests_operation_check CHECK(operation IN ('set_score','create_comment','delete_comment','create_reply','delete_reply','set_comment_like','set_reply_like','set_target_subscription','admin_delete_comment','admin_delete_reply','create_target','delete_target','edit_target','create_categories') OR whaleu_ratings.rating_scoped_operation_rule(operation,2) IS NOT NULL);
ALTER TABLE whaleu_ratings.scoped_command_preparations ADD COLUMN command_family text NOT NULL DEFAULT 'existing' CHECK(command_family IN ('existing','category')),ADD COLUMN category_plan jsonb;
ALTER TABLE whaleu_ratings.scoped_command_preparations ALTER COLUMN target_id DROP NOT NULL,ALTER COLUMN subject_id DROP NOT NULL,ALTER COLUMN target_revision DROP NOT NULL,ALTER COLUMN subject_revision DROP NOT NULL,ALTER COLUMN definition_revision DROP NOT NULL,ALTER COLUMN content_version DROP NOT NULL;
ALTER TABLE whaleu_ratings.scoped_command_preparations ADD CONSTRAINT scoped_category_family CHECK(
 (command_family='existing' AND NOT whaleu_ratings.category_management_operation(operation) AND category_plan IS NULL AND target_id IS NOT NULL AND subject_id IS NOT NULL AND target_revision IS NOT NULL AND subject_revision IS NOT NULL AND definition_revision IS NOT NULL AND content_version IS NOT NULL)
 OR (command_family='category' AND whaleu_ratings.category_management_operation(operation) AND jsonb_typeof(category_plan)='object' AND target_id IS NULL AND subject_id IS NULL AND target_revision IS NULL AND subject_revision IS NULL AND definition_revision IS NULL AND content_version IS NULL AND envelope IS NULL));
DO $$ DECLARE n text; c integer;BEGIN SELECT count(*),min(conname) INTO c,n FROM pg_constraint WHERE conrelid='whaleu_ratings.scoped_command_outcomes'::regclass AND pg_get_constraintdef(oid) LIKE '%RATING_CREATION_CANCELLED%';IF c<>1 THEN RAISE EXCEPTION 'Missing exact outcome check';END IF;EXECUTE format('ALTER TABLE whaleu_ratings.scoped_command_outcomes DROP CONSTRAINT %I',n);END $$;
ALTER TABLE whaleu_ratings.scoped_command_outcomes ADD CONSTRAINT scoped_command_outcomes_category_result_check CHECK((outcome='closed' AND result IS NULL AND (code IN ('RATING_SCOPED_CONTEXT_CHANGED','RATING_CREATION_CANCELLED','RATING_EDIT_CANCELLED','RATING_REVISION_CONFLICT','RATING_NOT_FOUND','CONTENT_REJECTED','PHONE_VERIFICATION_REQUIRED','AFFILIATION_VERIFICATION_REQUIRED','IDENTITY_CAMPUS_REQUIRED','SAFETY_ACTION_RESTRICTED') OR (code='RATING_CATEGORY_CANCELLED' AND whaleu_ratings.category_management_operation(operation)))) OR(outcome IN ('applied','noop') AND code IS NULL AND jsonb_typeof(result)='object'));
ALTER TABLE whaleu_ratings.scoped_command_causes DROP CONSTRAINT scoped_command_causes_cause_kind_check;
ALTER TABLE whaleu_ratings.scoped_command_causes ADD CONSTRAINT scoped_command_causes_cause_kind_check CHECK(cause_kind IN ('execution','domain_transition','target_initial','target_edit','catalog_release','legacy_bridge','legacy_boundary','category_execution','category_release'));
ALTER TABLE whaleu_ratings.scoped_releases DROP CONSTRAINT scoped_releases_cause_kind_check;
ALTER TABLE whaleu_ratings.scoped_releases ADD CONSTRAINT scoped_releases_cause_kind_check CHECK(cause_kind IN ('source_release','create_target_scoped','legacy_bridge','protocol_activation','category_management'));
