-- Preserve original function OIDs and every pre-M3C command branch.
SET LOCAL lock_timeout='5s';
CREATE FUNCTION whaleu_ratings.scoped_context_current_pre_category(context_id uuid,actor uuid,session uuid,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT c.account_id=actor AND c.session_id=session AND c.issued_at<=instant AND c.valid_until>instant
 AND whaleu_ratings.target_edit_session_current(actor,session,instant)
 AND whaleu_ratings.category_topology_regions((c.authority->>'topologySnapshotId')::uuid,NULL) IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c.context->'heads') head LEFT JOIN whaleu_ratings.scoped_catalog_heads h ON h.scope_key=head->>'scopeKey'
  WHERE h.catalog_id IS NULL OR (h.catalog_id::text,h.head_revision::text) IS DISTINCT FROM (head->>'catalogRevision',head->>'headRevision') OR NOT whaleu_ratings.scoped_catalog_current(h.catalog_id,instant))
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c.protocol_tuples) p LEFT JOIN whaleu_ratings.scope_protocol_heads h ON h.logical_scope_key=p->>'scopeKey'
  LEFT JOIN whaleu_ratings.scope_protocol_versions v ON v.id=h.version_id WHERE v.id IS NULL OR v.phase<>'adopted' OR v.id::text<>p->>'versionId' OR v.generation::text<>p->>'generation')
 FROM whaleu_ratings.scoped_contexts c WHERE c.id=context_id),false)
$$;
CREATE OR REPLACE FUNCTION whaleu_ratings.scoped_context_current(context_id uuid,actor uuid,session uuid,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT whaleu_ratings.scoped_context_current_pre_category(context_id,actor,session,instant) AND coalesce((SELECT CASE WHEN c.context->>'purpose'='manage_categories' THEN
 c.context->>'mode'='management' AND c.authority->>'authorizationMode'='category_management'
 AND jsonb_array_length(c.context->'heads')=1 AND c.context->'heads'=whaleu_ratings.category_management_heads(ARRAY[CASE WHEN c.context->'selector'->>'kind'='global' THEN 'global' ELSE 'campus:'||(c.context->'selector'->>'campusId') END])
 AND c.context->>'managementSnapshot'=whaleu_ratings.scoped_digest('category-snapshot',jsonb_build_object('heads',c.context->'heads','vector',whaleu_ratings.scoped_current_source_vector(ARRAY[c.context->'heads'->0->>'scopeKey'])))
 AND c.context->>'sourceDigest'=whaleu_ratings.scoped_digest('vector',whaleu_ratings.scoped_current_source_vector(ARRAY[c.context->'heads'->0->>'scopeKey']))
 ELSE c.context->>'mode' IN ('public','admin_preview') AND c.authority->>'authorizationMode' IS DISTINCT FROM 'category_management' END FROM whaleu_ratings.scoped_contexts c WHERE c.id=context_id),false)
$$;
CREATE OR REPLACE FUNCTION whaleu_ratings.scoped_preparation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c whaleu_ratings.scoped_contexts;leaf whaleu_ratings.scoped_categories;BEGIN
 IF NEW.command_family='category' THEN
 SELECT * INTO c FROM whaleu_ratings.scoped_contexts WHERE id=NEW.context_id;
 IF NOT coalesce(NEW.preparation_transaction=pg_current_xact_id() AND c.context->>'purpose'='manage_categories' AND c.context->>'mode'='management'
 AND c.context->>'managementSnapshot'=NEW.intent->'payload'->>'expectedSnapshot'
 AND (c.context-ARRAY['protocolVersion','actorId','purpose','mode','heads','managementSnapshot','expiresAt','operations'])=NEW.intent->'context'
 AND NEW.valid_until<=c.valid_until AND whaleu_ratings.category_management_plan_valid(NEW,true),false) THEN RAISE EXCEPTION 'Category preparation requires exact current management context and plan' USING ERRCODE='23514';END IF;RETURN NEW;
 END IF;

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
CREATE OR REPLACE FUNCTION whaleu_ratings.scoped_execution_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p whaleu_ratings.scoped_command_preparations;q whaleu_ratings.requests;t whaleu_ratings.targets;h whaleu_ratings.target_definition_heads;BEGIN
 IF NEW.cause_kind IN ('category_execution','category_release') THEN
 SELECT * INTO p FROM whaleu_ratings.scoped_command_preparations WHERE account_id=NEW.account_id AND request_id=NEW.request_id;
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=NEW.account_id AND request_id=NEW.request_id FOR UPDATE NOWAIT;
 IF NOT coalesce(NEW.mutation_transaction=pg_current_xact_id() AND p.command_family='category' AND p.operation=q.operation AND p.intent_hash=q.intent_hash AND q.receipt IS NULL AND p.valid_until>clock_timestamp(),false) THEN RAISE EXCEPTION 'Category cause lacks fresh exact request' USING ERRCODE='23514';END IF;
 IF NEW.cause_kind='category_execution' THEN
 IF NOT whaleu_ratings.category_management_plan_valid(p,true) OR EXISTS(SELECT 1 FROM whaleu_ratings.scoped_source_attestations s JOIN jsonb_array_elements(p.category_plan->'sourceIssues') i ON s.id=(i->>'id')::uuid)
 OR NEW.artifact_id<>p.context_id OR NEW.artifact_revision<>p.context_id
 OR NEW.proof<>jsonb_build_object('intentHash',p.intent_hash,'planDigest',p.category_plan->>'previewDigest','contextRevision',p.context_revision,'executionDigest',whaleu_ratings.scoped_digest('category-execution',jsonb_build_object('accountId',p.account_id,'requestId',p.request_id,'planDigest',p.category_plan->>'previewDigest'))) THEN RAISE EXCEPTION 'Category execution requires before-state CAS before all source issuance' USING ERRCODE='23514';END IF;
 ELSE
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.scoped_command_causes WHERE account_id=p.account_id AND request_id=p.request_id AND cause_kind='category_execution' AND mutation_transaction=pg_current_xact_id()) THEN RAISE EXCEPTION 'Category release cannot precede execution' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;END IF;

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
CREATE OR REPLACE FUNCTION whaleu_ratings.verify_scoped_command(actor uuid,request uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE q whaleu_ratings.requests;p whaleu_ratings.scoped_command_preparations;o whaleu_ratings.scoped_command_outcomes;cause whaleu_ratings.scoped_command_causes;expected jsonb;n integer;t whaleu_ratings.targets;
BEGIN
 IF EXISTS(SELECT 1 FROM whaleu_ratings.requests WHERE account_id=actor AND request_id=request AND whaleu_ratings.category_management_operation(operation)) THEN PERFORM whaleu_ratings.verify_category_management_command(actor,request);RETURN;END IF;

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

-- Exact native management exit: every legacy domain has its own observed
-- predecessor. A boolean source label is not authorization and cannot substitute
-- another domain's catalog. The ordinary command/release deferred verifiers also
-- close the complete intent, outputs, CAS, source and Review cause graph.
CREATE FUNCTION whaleu_ratings.category_management_compat_exit(manifest uuid,category uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE m whaleu_ratings.compat_projection_manifests;v whaleu_ratings.compat_versions;r whaleu_ratings.scoped_releases;p whaleu_ratings.scoped_command_preparations;domain_keys text[];item jsonb;row record;
BEGIN
 SELECT * INTO m FROM whaleu_ratings.compat_projection_manifests WHERE id=manifest;
 SELECT * INTO v FROM whaleu_ratings.compat_versions WHERE id=m.compat_version_id;
 SELECT * INTO r FROM whaleu_ratings.scoped_releases WHERE id=m.release_id;
 IF r.cause_kind IS DISTINCT FROM 'category_management' OR r.publication_transaction<>pg_current_xact_id() OR m.publication_transaction<>r.publication_transaction OR v.publication_transaction<>r.publication_transaction OR v.release_id<>r.id THEN RETURN false;END IF;
 SELECT * INTO p FROM whaleu_ratings.scoped_command_preparations WHERE account_id=(r.cause->>'accountId')::uuid AND request_id=(r.cause->>'requestId')::uuid;
 IF NOT coalesce(p.command_family='category' AND p.operation='set_category_scope_scoped' AND p.intent_hash=whaleu_ratings.scoped_intent_hash(p.intent) AND p.category_plan->'categoryIds' @> to_jsonb(ARRAY[category]) AND p.category_plan->'affectedScopeKeys'=to_jsonb(r.affected_scope_keys)
 AND p.category_plan->'beforeCompatHeads' @> jsonb_build_array(jsonb_build_object('compatKey',v.compat_key,'versionId',v.previous_version_id,'legacyCatalogId',m.before_catalog_id,'scopeKeys',whaleu_ratings.scoped_compat_scope_keys(v)))
 AND EXISTS(SELECT 1 FROM whaleu_ratings.scoped_command_causes e JOIN whaleu_ratings.requests q USING(account_id,request_id) WHERE e.account_id=p.account_id AND e.request_id=p.request_id AND e.cause_kind='category_execution' AND e.mutation_transaction=pg_current_xact_id() AND e.proof->>'planDigest'=p.category_plan->>'previewDigest' AND q.operation=p.operation AND q.intent_hash=p.intent_hash)
 AND EXISTS(SELECT 1 FROM whaleu_ratings.scoped_command_causes e WHERE e.account_id=p.account_id AND e.request_id=p.request_id AND e.cause_kind='category_release' AND e.artifact_id=r.id AND e.artifact_revision=r.id AND e.mutation_transaction=pg_current_xact_id() AND e.proof->>'planDigest'=p.category_plan->>'previewDigest'),false) THEN RETURN false;END IF;
 domain_keys:=whaleu_ratings.scoped_compat_scope_keys(v);
 SELECT i INTO item FROM jsonb_array_elements(p.category_plan->'sourceIssues') i WHERE i->>'kind'='scoped_category_scope' AND i ? 'placement' AND i->'payload'->>'categoryId'=category::text;
 IF item IS NULL OR ARRAY(SELECT jsonb_array_elements_text(item->'scopeKeys'))&&domain_keys OR NOT EXISTS(SELECT 1 FROM whaleu_ratings.scoped_source_attestations s JOIN whaleu_ratings.category_scope_placements placement ON (placement.source_id,placement.source_revision)=(s.id,s.revision) WHERE s.id=(item->>'id')::uuid AND s.revision=(item->>'revision')::uuid AND s.issuer='ratings-category-management' AND s.publication_transaction=pg_current_xact_id() AND s.payload=item->'payload' AND placement.category_id=category AND placement.placement_revision=(item->'placement'->>'revision')::uuid AND whaleu_ratings.scoped_source_current(s.id,s.revision,clock_timestamp())) THEN RETURN false;END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.category_plan->'beforeHeads') head JOIN whaleu_ratings.scoped_category_lineage l ON l.catalog_id=(head->>'catalogRevision')::uuid WHERE head->>'scopeKey'=ANY(domain_keys) AND l.category_id=category) THEN RETURN false;END IF;
 FOR row IN SELECT head FROM jsonb_array_elements(p.category_plan->'beforeHeads') head WHERE head->>'scopeKey'=ANY(domain_keys) LOOP
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.scoped_release_scopes output WHERE output.release_id=r.id AND output.scope_key=row.head->>'scopeKey' AND output.before_catalog_id=(row.head->>'catalogRevision')::uuid AND output.before_head_revision=(row.head->>'headRevision')::uuid AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.scoped_categories c WHERE c.catalog_id=output.after_catalog_id AND c.category_id=category)) THEN RETURN false;END IF;
 END LOOP;
 RETURN true;
END $$;

CREATE OR REPLACE FUNCTION whaleu_ratings.verify_compat_projection(manifest uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE p whaleu_ratings.compat_projection_manifests;v whaleu_ratings.compat_versions;c whaleu_ratings.catalogs;m whaleu_ratings.catalog_materializations;expected jsonb;
BEGIN
 SELECT * INTO p FROM whaleu_ratings.compat_projection_manifests WHERE id=manifest;SELECT * INTO v FROM whaleu_ratings.compat_versions WHERE id=p.compat_version_id;
 SELECT * INTO c FROM whaleu_ratings.catalogs WHERE id=p.after_catalog_id;SELECT * INTO m FROM whaleu_ratings.catalog_materializations WHERE catalog_id=c.id;
 SELECT coalesce(jsonb_agg(jsonb_build_object('categoryId',old.id,'beforeRevision',old.revision,'afterRevision',fresh.revision,'action',CASE WHEN fresh.id IS NULL THEN 'exit' WHEN to_jsonb(old)-ARRAY['catalog_id','revision']=to_jsonb(fresh)-ARRAY['catalog_id','revision'] THEN 'retain' ELSE 'update' END) ORDER BY old.id),'[]'::jsonb) INTO expected
 FROM whaleu_ratings.categories old JOIN whaleu_ratings.catalog_category_lineage l ON (l.catalog_id,l.category_id)=(old.catalog_id,old.id)
 LEFT JOIN whaleu_ratings.categories fresh ON fresh.catalog_id=c.id AND fresh.id=old.id WHERE old.catalog_id=p.before_catalog_id AND l.source_kind IN ('native','compat_effective');
 IF NOT coalesce(p.publication_transaction=pg_current_xact_id() AND v.publication_transaction=p.publication_transaction AND m.publication_transaction=p.publication_transaction
 AND v.state='equal' AND v.legacy_catalog_id=c.id AND p.release_id=v.release_id AND p.source_digest=v.source_digest AND p.projection_digest=v.equality_digest
 AND c.region_id IS NOT DISTINCT FROM v.region_id AND c.coverage='complete' AND c.provenance='accepted' AND c.source_reference='rating-scoped-compat:'||p.id::text
 AND c.policy_reference='ratings-scoped-compat-v1' AND c.effective_at<=clock_timestamp() AND c.valid_until<=v.valid_until AND c.valid_until>clock_timestamp()
 AND p.native_successions=expected AND m.before_catalog_id IS NOT DISTINCT FROM p.before_catalog_id AND m.campus_ids=v.campus_ids
 AND whaleu_ratings.compat_projection_sources_complete(p.id) AND whaleu_ratings.scoped_compat_current(v.id),false)
 THEN RAISE EXCEPTION 'Compatibility projection has no exact current typed provenance' USING ERRCODE='23514';END IF;
 -- An exit needs its own explicit current placement/lifecycle evidence. A
 -- missing category caused by an unknown source is never an authorized exit.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(expected) x WHERE x->>'action'='exit' AND NOT EXISTS(
  SELECT 1 FROM whaleu_ratings.scoped_source_heads h JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(h.source_id,h.source_revision)
  WHERE s.source_kind IN ('scoped_category_scope','scoped_category_lifecycle') AND s.payload->>'categoryId'=x->>'categoryId' AND s.payload->'authorizedExit'='true'::jsonb
  AND s.payload->'legacyBeforeCatalogId'=to_jsonb(p.before_catalog_id) AND whaleu_ratings.scoped_source_current(s.id,s.revision,clock_timestamp())) AND NOT whaleu_ratings.category_management_compat_exit(p.id,(x->>'categoryId')::uuid))
 THEN RAISE EXCEPTION 'Native compatibility exit lacks explicit source' USING ERRCODE='23514';END IF;
END $$;

-- Preserve exact existing owner succession while removing a foreign command discriminator.
CREATE OR REPLACE FUNCTION whaleu_ratings.scoped_native_placement(actor uuid,request uuid) RETURNS void LANGUAGE plpgsql AS $$
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
 payload:=jsonb_set(old.payload-'management','{targetIds}',(SELECT jsonb_agg(id ORDER BY id) FROM (SELECT value id FROM jsonb_array_elements_text(old.payload->'targetIds') UNION SELECT p.target_id::text) targets));
 payload:=payload||jsonb_build_object('nativeCommand',jsonb_build_object('accountId',actor,'requestId',request),'previousSourceId',old.id,'previousSourceRevision',old.revision);
 INSERT INTO whaleu_ratings.scoped_source_attestations(id,revision,source_kind,source_key,scope_keys,payload,digest,coverage,provenance,issuer,source_reference,policy_reference,effective_at,valid_until)
 VALUES(coverage,coverage_revision,'scope_absence',key,ARRAY[key],payload,whaleu_ratings.scoped_digest('source',jsonb_build_object('id',coverage,'revision',coverage_revision,'kind','scope_absence','key',key,'scopeKeys',ARRAY[key],'payload',payload)),'complete','accepted','ratings-native-command','rating-scoped-create:'||actor::text||':'||request::text,policy.policy_reference,greatest(at,old.effective_at+interval '1 microsecond'),least(policy.valid_until,old.valid_until));
 UPDATE whaleu_ratings.scoped_source_heads SET source_id=coverage,source_revision=coverage_revision WHERE source_kind='scope_absence' AND source_key=key AND source_id=old.id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Native placement source predecessor changed' USING ERRCODE='23514';END IF;
END $$;

-- Preserve exact existing owner succession while removing a foreign command discriminator.
CREATE OR REPLACE FUNCTION whaleu_ratings.legacy_bridge_sources(actor uuid,request uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE e whaleu_ratings.scoped_command_causes;q whaleu_ratings.requests;d jsonb;node jsonb;output jsonb;keys text[];key text;old whaleu_ratings.scoped_source_attestations;s whaleu_ratings.scoped_source_attestations;base whaleu_ratings.scoped_source_attestations;place uuid;payload jsonb;p whaleu_ratings.target_preparations;deadline timestamptz;nodes jsonb;
BEGIN
 SELECT * INTO e FROM whaleu_ratings.scoped_command_causes WHERE account_id=actor AND request_id=request AND cause_kind='legacy_bridge';
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=actor AND request_id=request;
 IF e.artifact_id IS NULL THEN RETURN;END IF;
 IF NOT coalesce(e.mutation_transaction=pg_current_xact_id() AND q.receipt->>'outcome'='applied' AND q.operation IN ('create_target','create_categories') AND q.intent_hash=e.proof->>'intentHash',false) THEN RAISE EXCEPTION 'Legacy catalog derivative requires original applied command in this transaction' USING ERRCODE='23514';END IF;
 SELECT min((x->>'validUntil')::timestamptz) INTO deadline FROM jsonb_array_elements(e.proof->'domains') x;
 IF q.operation='create_target' THEN
  SELECT * INTO p FROM whaleu_ratings.target_preparations WHERE account_id=actor AND request_id=request;
  SELECT array_agg(scope_item.scope_key ORDER BY scope_item.scope_key COLLATE "C") INTO keys FROM jsonb_array_elements(e.proof->'domains') x CROSS JOIN LATERAL jsonb_array_elements_text(x->'scopeKeys') AS scope_item(scope_key);
  s:=whaleu_ratings.legacy_bridge_issue_source(e.artifact_id,'scoped_target_placement',p.target_id::text,keys,jsonb_build_object('targetId',p.target_id,'categoryId',p.intent->'categoryId'),deadline);
  INSERT INTO whaleu_ratings.target_scope_placements(placement_revision,target_id,scope_keys,source_id,source_revision) VALUES(gen_random_uuid(),p.target_id,keys,s.id,s.revision);
 ELSE
  SELECT x.nodes INTO nodes FROM whaleu_ratings.category_command_preparations x WHERE account_id=actor AND request_id=request;
  FOR d IN SELECT value FROM jsonb_array_elements(e.proof->'domains') LOOP
   SELECT value INTO output FROM jsonb_array_elements(e.proof->'legacyCatalogs') WHERE value->'logicalScopeKey'=d->'logicalScopeKey';
   keys:=ARRAY(SELECT jsonb_array_elements_text(d->'scopeKeys'));
   FOR node IN SELECT value FROM jsonb_array_elements(nodes) LOOP
    base:=whaleu_ratings.legacy_bridge_issue_source(e.artifact_id,'m3a_native_bridge','bridge-category:'||(node->>'id')||':'||(d->>'logicalScopeKey'),keys,
     jsonb_build_object('categoryId',node->'id','categoryRevision',node->'revision','legacyAfterCatalogId',output->'afterCatalogId'),deadline);
    place:=gen_random_uuid();payload:=jsonb_build_object('categoryId',node->'id','baseSourceId',base.id,'baseSourceRevision',base.revision,'placementRevision',place,'scopeKeys',keys,
     'placement',CASE WHEN keys=ARRAY['global'] THEN jsonb_build_object('kind','global') ELSE jsonb_build_object('kind','campuses','campusIds',ARRAY(SELECT substring(k from 8)::uuid FROM unnest(keys) k ORDER BY k)) END);
    s:=whaleu_ratings.legacy_bridge_issue_source(e.artifact_id,'scoped_category_scope','bridge-placement:'||(node->>'id')||':'||(d->>'logicalScopeKey'),keys,payload,deadline);
    INSERT INTO whaleu_ratings.category_scope_placements(placement_revision,category_id,base_source_id,base_source_revision,scope_keys,source_id,source_revision) VALUES(place,(node->>'id')::uuid,base.id,base.revision,keys,s.id,s.revision);
   END LOOP;
  END LOOP;
 END IF;
 FOR d IN SELECT value FROM jsonb_array_elements(e.proof->'domains') LOOP
  FOR key IN SELECT jsonb_array_elements_text(d->'scopeKeys') LOOP
   SELECT src.* INTO old FROM whaleu_ratings.scoped_source_heads h JOIN whaleu_ratings.scoped_source_attestations src ON (src.id,src.revision)=(h.source_id,h.source_revision) WHERE h.source_kind='scope_absence' AND h.source_key=key FOR UPDATE OF h;
   IF NOT coalesce(whaleu_ratings.scoped_source_current(old.id,old.revision,clock_timestamp()) AND old.payload->'complete'='true'::jsonb
    AND d->'sourceVector' @> jsonb_build_array(jsonb_build_object('id',old.id,'revision',old.revision,'digest',old.digest)),false) THEN RAISE EXCEPTION 'Legacy bridge absence predecessor changed' USING ERRCODE='23514';END IF;
   IF q.operation='create_target' THEN payload:=jsonb_set(old.payload-'management','{targetIds}',(SELECT jsonb_agg(id ORDER BY id) FROM (SELECT jsonb_array_elements_text(old.payload->'targetIds') id UNION SELECT p.target_id::text) ids));
   ELSE payload:=jsonb_set(old.payload-'management','{categoryIds}',(SELECT jsonb_agg(id ORDER BY id) FROM (SELECT jsonb_array_elements_text(old.payload->'categoryIds') id UNION SELECT n->>'id' FROM jsonb_array_elements(nodes) n) ids));END IF;
   payload:=payload||jsonb_build_object('previousSourceId',old.id,'previousSourceRevision',old.revision);
   PERFORM whaleu_ratings.legacy_bridge_issue_source(e.artifact_id,'scope_absence',key,ARRAY[key],payload,least(deadline,old.valid_until));
  END LOOP;
 END LOOP;
END $$;

-- Preserve exact existing owner succession while removing a foreign command discriminator.
CREATE OR REPLACE FUNCTION whaleu_ratings.legacy_bridge_source_causal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e whaleu_ratings.scoped_command_causes;q whaleu_ratings.requests;d jsonb;output jsonb;old whaleu_ratings.scoped_source_attestations;base whaleu_ratings.scoped_source_attestations;expected jsonb;nodes jsonb;target uuid;keys text[];
BEGIN
 SELECT * INTO e FROM whaleu_ratings.scoped_command_causes WHERE cause_kind='legacy_bridge' AND artifact_id=(NEW.payload->>'bridgeId')::uuid;
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=e.account_id AND request_id=e.request_id;
 IF NOT coalesce(NEW.publication_transaction=e.mutation_transaction AND e.mutation_transaction=pg_current_xact_id() AND NEW.source_reference='rating-legacy-bridge:'||e.artifact_id::text AND NEW.policy_reference='native-v1-compat-write-v1'
  AND NEW.coverage='complete' AND NEW.provenance='accepted' AND whaleu_ratings.scoped_source_current(NEW.id,NEW.revision,clock_timestamp()) AND q.operation IN ('create_target','create_categories'),false) THEN RAISE EXCEPTION 'Legacy source has no exact original companion cause' USING ERRCODE='23514';END IF;
 SELECT x.nodes INTO nodes FROM whaleu_ratings.category_command_preparations x WHERE account_id=e.account_id AND request_id=e.request_id;
 SELECT target_id INTO target FROM whaleu_ratings.target_preparations WHERE account_id=e.account_id AND request_id=e.request_id;
 SELECT value INTO d FROM jsonb_array_elements(e.proof->'domains') WHERE NEW.scope_keys<@ARRAY(SELECT jsonb_array_elements_text(value->'scopeKeys'));
 SELECT value INTO output FROM jsonb_array_elements(e.proof->'legacyCatalogs') WHERE value->'logicalScopeKey'=d->'logicalScopeKey';
 IF d IS NULL OR NEW.valid_until>(d->>'validUntil')::timestamptz THEN RAISE EXCEPTION 'Legacy derivative widened its exact policy scope/deadline' USING ERRCODE='23514';END IF;
 IF NEW.source_kind='m3a_native_bridge' THEN
  IF q.operation<>'create_categories' OR whaleu_ratings.legacy_bridge_native_category(NEW.id,NEW.revision) IS NULL OR NEW.scope_keys<>ARRAY(SELECT jsonb_array_elements_text(d->'scopeKeys'))
   OR NEW.payload IS DISTINCT FROM jsonb_build_object('bridgeId',e.artifact_id,'categoryId',NEW.payload->'categoryId','categoryRevision',NEW.payload->'categoryRevision','legacyAfterCatalogId',output->'afterCatalogId')
   OR NEW.source_key<>'bridge-category:'||(NEW.payload->>'categoryId')||':'||(d->>'logicalScopeKey') THEN RAISE EXCEPTION 'Legacy native category derivative differs' USING ERRCODE='23514';END IF;
 ELSIF NEW.source_kind='scoped_category_scope' THEN
  SELECT * INTO base FROM whaleu_ratings.scoped_source_attestations WHERE id=(NEW.payload->>'baseSourceId')::uuid AND revision=(NEW.payload->>'baseSourceRevision')::uuid;
  IF NOT coalesce(q.operation='create_categories' AND base.source_kind='m3a_native_bridge' AND base.issuer=NEW.issuer AND base.payload->'bridgeId'=NEW.payload->'bridgeId' AND base.payload->'categoryId'=NEW.payload->'categoryId' AND base.scope_keys=NEW.scope_keys
   AND NEW.source_key='bridge-placement:'||(NEW.payload->>'categoryId')||':'||(d->>'logicalScopeKey')
   AND whaleu_community.rating_scoped_keys(NEW.payload,ARRAY['bridgeId','categoryId','baseSourceId','baseSourceRevision','placementRevision','scopeKeys','placement']),false) THEN RAISE EXCEPTION 'Legacy category placement must use its exact native derivative' USING ERRCODE='23514';END IF;
 ELSIF NEW.source_kind='scoped_target_placement' THEN
  keys:=ARRAY(SELECT jsonb_array_elements_text(d->'scopeKeys'));
  IF q.operation<>'create_target' OR NEW.scope_keys<>keys OR NEW.source_key<>target::text OR NEW.payload IS DISTINCT FROM jsonb_build_object('bridgeId',e.artifact_id,'targetId',target,'categoryId',e.proof->'intent'->'categoryId') THEN RAISE EXCEPTION 'Legacy target placement differs from original target and complete allowed domain' USING ERRCODE='23514';END IF;
 ELSIF NEW.source_kind='scope_absence' THEN
  SELECT * INTO old FROM whaleu_ratings.scoped_source_attestations WHERE id=(NEW.payload->>'previousSourceId')::uuid AND revision=(NEW.payload->>'previousSourceRevision')::uuid;
  IF NOT coalesce(old.source_kind='scope_absence' AND old.source_key=NEW.source_key AND NEW.scope_keys=ARRAY[NEW.source_key]
   AND d->'sourceVector' @> jsonb_build_array(jsonb_build_object('id',old.id,'revision',old.revision,'digest',old.digest)) AND NEW.valid_until<=old.valid_until,false) THEN RAISE EXCEPTION 'Legacy absence derivative differs from observed negative source' USING ERRCODE='23514';END IF;
  IF q.operation='create_target' THEN expected:=jsonb_set(old.payload-'management','{targetIds}',(SELECT jsonb_agg(id ORDER BY id) FROM (SELECT jsonb_array_elements_text(old.payload->'targetIds') id UNION SELECT target::text) x));
  ELSE expected:=jsonb_set(old.payload-'management','{categoryIds}',(SELECT jsonb_agg(id ORDER BY id) FROM (SELECT jsonb_array_elements_text(old.payload->'categoryIds') id UNION SELECT n->>'id' FROM jsonb_array_elements(nodes) n) x));END IF;
  expected:=expected||jsonb_build_object('bridgeId',e.artifact_id,'previousSourceId',old.id,'previousSourceRevision',old.revision);
  IF NEW.payload IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Legacy absence derivative omitted or invented a category/target/source' USING ERRCODE='23514';END IF;
 ELSE RAISE EXCEPTION 'Unknown legacy derivative source kind' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.scoped_releases parent
  WHERE parent.cause_kind='legacy_bridge' AND parent.publication_transaction=e.mutation_transaction
  AND parent.cause->>'bridgeId'=e.artifact_id::text AND parent.cause->>'accountId'=e.account_id::text
  AND parent.cause->>'requestId'=e.request_id::text
  AND parent.source_vector @> jsonb_build_array(jsonb_build_object('id',NEW.id,'revision',NEW.revision,'digest',NEW.digest)))
 THEN RAISE EXCEPTION 'Legacy derivative is absent from its exact immutable release vector' USING ERRCODE='23514';END IF;
 -- Full original request, affected-set and source-vector checks belong to the
 -- immutable bridge cause/release boundaries. This row has already proved its
 -- exact derivative shape, source, transaction and original command above.
 RETURN NULL;
END $$;
