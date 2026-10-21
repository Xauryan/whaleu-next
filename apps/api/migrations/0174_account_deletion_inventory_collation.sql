-- Canonical catalog ordering repair for synthetic local rehearsal only.
-- Canonical identifier ordering plus a new installation qualification; NOT a new owner.
-- Seven-owner protocol, exact request/generation/TX and payload-row seals unchanged.
-- Old sandbox rows/hashes are not backfilled. Fresh defaults capture the new shape.
-- Stable catalog names/source; alternate executable forms fail closed, no raw OIDs.
-- Function-local canonical deparser settings cover the original structural aggregate.
-- pg_temp is explicitly last so catalog relations cannot be shadowed by temp names.
CREATE OR REPLACE FUNCTION whaleu_account_deletion.inventory_current(request uuid) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE sandbox uuid;item record;shape jsonb;rows jsonb;row_total integer;known text[];BEGIN
 SELECT f.sandbox_id INTO sandbox FROM whaleu_account_deletion.requests r JOIN whaleu_account_deletion.fixture_accounts f ON f.account_id=r.account_id WHERE r.id=request;
 IF sandbox IS NULL OR NOT EXISTS(SELECT 1 FROM whaleu_account_deletion.sandboxes WHERE id=sandbox AND inventory='account-deletion-local-0173-v1' AND coordinator_shape_hash=whaleu_account_deletion.coordinator_shape()) OR NOT whaleu_account_deletion.follow_partition_valid(sandbox) THEN RETURN false;END IF;
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname LIKE 'whaleu\_%' ESCAPE '\' AND c.relkind IN('m','f'))
 OR (SELECT array_agg(n.nspname||'.'||c.relname ORDER BY (n.nspname||'.'||c.relname) COLLATE "C") FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('whaleu_account_deletion','whaleu_meta') AND c.relkind IN('r','p'))
 IS DISTINCT FROM ARRAY['whaleu_account_deletion.commands','whaleu_account_deletion.fixture_accounts','whaleu_account_deletion.fixture_media_cohorts','whaleu_account_deletion.follow_head_advances','whaleu_account_deletion.follow_mutations','whaleu_account_deletion.follow_pages','whaleu_account_deletion.follow_scopes','whaleu_account_deletion.follow_source_erasures','whaleu_account_deletion.follow_source_intents','whaleu_account_deletion.follow_source_retirements','whaleu_account_deletion.inventory','whaleu_account_deletion.media_observations','whaleu_account_deletion.owner_causes','whaleu_account_deletion.owner_receipts','whaleu_account_deletion.recovery_grants','whaleu_account_deletion.requests','whaleu_account_deletion.reregistration_guards','whaleu_account_deletion.reserved_profile_ids','whaleu_account_deletion.sandboxes','whaleu_meta.schema_migrations']::text[] THEN RETURN false;END IF;
 SELECT array_agg(relation ORDER BY relation COLLATE "C") INTO known FROM whaleu_account_deletion.inventory WHERE sandbox_id=sandbox;
 IF known IS NULL OR known IS DISTINCT FROM (SELECT array_agg(n.nspname||'.'||c.relname ORDER BY (n.nspname||'.'||c.relname) COLLATE "C")
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname LIKE 'whaleu\_%' ESCAPE '\' AND n.nspname NOT IN('whaleu_account_deletion','whaleu_meta') AND c.relkind IN('r','p'))
 OR EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname LIKE 'whaleu\_%' ESCAPE '\' AND n.nspname NOT IN('whaleu_account_deletion','whaleu_meta') AND NOT EXISTS(SELECT 1 FROM unnest(known) k WHERE split_part(k,'.',1)=n.nspname)) THEN RETURN false;END IF;
 FOR item IN SELECT * FROM whaleu_account_deletion.inventory WHERE sandbox_id=sandbox ORDER BY relation COLLATE "C" LOOP
  IF item.relation!~'^whaleu_[a-z_]+\.[a-z_][a-z0-9_]*$' OR item.supported IS DISTINCT FROM (item.relation=ANY(ARRAY['whaleu_identity.accounts','whaleu_identity.provider_identities','whaleu_identity.sessions','whaleu_identity.access_tokens','whaleu_identity.refresh_tokens','whaleu_profile.profiles','whaleu_profile.details','whaleu_profile.self_edit_causes','whaleu_profile.self_edit_transitions','whaleu_profile.self_edit_statements','whaleu_safety.account_policy_consumer_proofs','whaleu_timetable.terms','whaleu_timetable.entries','whaleu_timetable.commands','whaleu_community.follow_heads','whaleu_community.follow_requests','whaleu_community.user_follows','whaleu_community.social_sources','whaleu_notifications.social_work','whaleu_notifications.social_notices','whaleu_notifications.social_receipts','whaleu_notifications.owners','whaleu_community.discovery_cursors','whaleu_experience.owners','whaleu_experience.baselines','whaleu_experience.account_states','whaleu_experience.entitlements','whaleu_experience.appearance','whaleu_safety.account_heads','whaleu_safety.events','whaleu_verification.account_heads','whaleu_verification.assertions','whaleu_verification.snapshots','whaleu_verification.events','whaleu_verification.native_enrollments','whaleu_verification.relevant_fact_generations','whaleu_profile.admin_count_epochs','whaleu_safety.discovery_count_epochs','whaleu_community.related_sync_actor_generation','whaleu_community.related_sync_admission_generation','whaleu_community.related_sync_view_generation','whaleu_community.related_sync_applicability_generation']::text[])) THEN RETURN false;END IF;
  EXECUTE format('LOCK TABLE %I.%I IN SHARE ROW EXCLUSIVE MODE NOWAIT',split_part(item.relation,'.',1),split_part(item.relation,'.',2));
  SELECT jsonb_build_object('columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
   'constraints',(SELECT jsonb_agg(pg_get_constraintdef(k.oid) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
   'triggers',(SELECT jsonb_agg(pg_get_triggerdef(t.oid) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal)) INTO shape FROM pg_class c WHERE c.oid=item.relation::regclass;
  IF whaleu_account_deletion.json_hash(shape) IS DISTINCT FROM item.shape_hash THEN RETURN false;END IF;
  IF NOT item.supported THEN
   EXECUTE format('SELECT count(*),coalesce(jsonb_agg(raw ORDER BY raw),''[]''::jsonb) FROM (SELECT to_jsonb(t)::text raw FROM %I.%I t ORDER BY to_jsonb(t)::text LIMIT 10001) q',split_part(item.relation,'.',1),split_part(item.relation,'.',2)) INTO row_total,rows;
   IF row_total<>item.row_count OR whaleu_account_deletion.json_hash(rows) IS DISTINCT FROM item.rows_hash THEN RETURN false;END IF;
  END IF;
 END LOOP;
 RETURN true;
END$$;

CREATE OR REPLACE FUNCTION whaleu_account_deletion.coordinator_shape() RETURNS text LANGUAGE sql STABLE
 SET search_path=pg_catalog,pg_temp SET quote_all_identifiers=off SET IntervalStyle=postgres AS $$
 SELECT whaleu_account_deletion.json_hash(jsonb_build_object(
  'qualification','account-deletion-inventory-order-0174-v1',
  'relations',(SELECT coalesce(jsonb_agg(jsonb_build_object('relation',n.nspname||'.'||c.relname,
 'columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
 'constraints',(SELECT jsonb_agg(pg_get_constraintdef(k.oid) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
 'triggers',(SELECT jsonb_agg(pg_get_triggerdef(t.oid) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal)) ORDER BY n.nspname,c.relname),'[]'::jsonb) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('whaleu_account_deletion','whaleu_meta') AND c.relkind IN('r','p')),
  'inventoryCurrent',jsonb_build_object(
   'schema',pn.nspname::text,'name',p.proname::text,
   'argumentTypes',(SELECT jsonb_agg(an.nspname::text||'.'||at.typname::text ORDER BY arg.ordinal)
    FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY arg(type_id,ordinal)
    JOIN pg_type at ON at.oid=arg.type_id JOIN pg_namespace an ON an.oid=at.typnamespace),
   'allArgumentTypes',CASE WHEN p.proallargtypes IS NULL THEN NULL ELSE
    (SELECT jsonb_agg(an.nspname::text||'.'||at.typname::text ORDER BY arg.ordinal)
     FROM unnest(p.proallargtypes) WITH ORDINALITY arg(type_id,ordinal)
     JOIN pg_type at ON at.oid=arg.type_id JOIN pg_namespace an ON an.oid=at.typnamespace) END,
   'resultType',tn.nspname::text||'.'||t.typname::text,
   'source',p.prosrc,'language',l.lanname::text,'kind',p.prokind::text,
   'volatility',p.provolatile::text,'parallel',p.proparallel::text,'strict',p.proisstrict,
   'securityDefiner',p.prosecdef,'leakproof',p.proleakproof,'returnsSet',p.proretset,
   'argumentNames',p.proargnames,'argumentModes',p.proargmodes,'defaultCount',p.pronargdefaults,
   'config',p.proconfig,'cost',p.procost,'rows',p.prorows)))
 FROM pg_proc p JOIN pg_namespace pn ON pn.oid=p.pronamespace
 JOIN pg_language l ON l.oid=p.prolang
 JOIN pg_type t ON t.oid=p.prorettype JOIN pg_namespace tn ON tn.oid=t.typnamespace
 WHERE p.oid='whaleu_account_deletion.inventory_current(pg_catalog.uuid)'::regprocedure
  -- The exact installed PL/pgSQL function has none of these alternate executable
  -- representations. Reject them instead of hashing OID-bearing node trees or
  -- session-sensitive deparser output. No matching profile yields NULL/fail-closed.
  AND l.lanname='plpgsql' AND p.probin IS NULL AND p.prosqlbody IS NULL
  AND p.proargdefaults IS NULL AND p.pronargdefaults=0 AND p.prosupport=0
  AND p.protrftypes IS NULL AND p.provariadic=0
$$;
