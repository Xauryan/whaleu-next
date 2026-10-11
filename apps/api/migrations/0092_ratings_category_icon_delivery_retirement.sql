-- Category-only lifecycle facts. Deliberately no Media/content/Category epoch
-- trigger: an in-flight read hold is not a content mutation or read authority.
-- Retirement takes LOCK TABLE ... IN SHARE MODE NOWAIT before checking open
-- rows. Every ordinary INSERT/UPDATE/DELETE/TRUNCATE already requires the
-- conflicting ROW EXCLUSIVE (or stronger) table lock, including raw writers.
CREATE TABLE whaleu_ratings.category_icon_delivery_holds(
 id uuid PRIMARY KEY,
 category_id uuid NOT NULL,
 appearance_id uuid NOT NULL REFERENCES whaleu_ratings.category_icon_appearances(id),
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 session_id uuid NOT NULL REFERENCES whaleu_identity.sessions(id),
 context_id uuid NOT NULL REFERENCES whaleu_ratings.scoped_contexts(id),
 context_token_digest text NOT NULL CHECK(context_token_digest ~ '^[a-f0-9]{64}$'),
 purpose text NOT NULL CHECK(purpose IN ('download','management-preview')),
 qualification jsonb NOT NULL CHECK(jsonb_typeof(qualification)='object'),
 binding_id uuid NOT NULL REFERENCES whaleu_media.bindings(id),
 manifest_digest text NOT NULL CHECK(manifest_digest ~ '^[a-f0-9]{64}$'),
 plan_digest text NOT NULL CHECK(plan_digest ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),
 closed_at timestamptz,
 CHECK(closed_at IS NULL OR (isfinite(closed_at) AND closed_at>=created_at))
);
CREATE INDEX category_icon_delivery_holds_open_appearance
 ON whaleu_ratings.category_icon_delivery_holds(appearance_id) WHERE closed_at IS NULL;

-- This only binds an already-authorized hold to the immutable references that
-- the original owner/Media proof read. It never grants public or management
-- authority and does not replace either of the two current proof commits.
CREATE FUNCTION whaleu_ratings.category_icon_delivery_hold_qualified(
 h whaleu_ratings.category_icon_delivery_holds
) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE q jsonb:=h.qualification;c whaleu_ratings.scoped_contexts;
 a whaleu_ratings.category_icon_appearances;b whaleu_ratings.category_icon_review_bindings;
BEGIN
 SELECT * INTO c FROM whaleu_ratings.scoped_contexts WHERE id=h.context_id;
 SELECT * INTO a FROM whaleu_ratings.category_icon_appearances WHERE id=h.appearance_id;
 IF NOT coalesce(
   (c.account_id,c.session_id,c.token_digest)=(h.actor_id,h.session_id,h.context_token_digest)
   AND c.context->'protocolVersion'='5'::jsonb
   AND c.authority->>'contextAuthority'='ratings-category-icon-context-v1'
   AND whaleu_ratings.scoped_context_current(c.id,h.actor_id,h.session_id,clock_timestamp())
   AND (a.category_id,a.media_binding_id,a.manifest_digest)=(h.category_id,h.binding_id,h.manifest_digest)
   AND a.identity_id::text=q->>'identityId'
   AND EXISTS(SELECT 1 FROM whaleu_media.bindings binding JOIN whaleu_media.assets asset ON asset.id=binding.asset_id
     WHERE binding.id=h.binding_id AND binding.resource_id=h.appearance_id
       AND binding.owner_kind='ratings' AND binding.resource_kind='category_icon'
       AND binding.content_version=1 AND binding.slot='icon' AND binding.ordinal=0
       AND binding.detached_at IS NULL AND binding.asset_id=a.asset_id
       AND binding.manifest_digest=h.manifest_digest AND asset.manifest_digest=h.manifest_digest)
   AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.category_icon_terminal_retirements r WHERE r.appearance_id=h.appearance_id),false)
 THEN RETURN false;END IF;

 IF h.purpose='download' THEN
   IF NOT coalesce(
     whaleu_community.rating_scoped_keys(q,ARRAY['releaseId','catalogId','effectiveRevision','identityId','baseSource','overrideSource','definitionId','extensionDigest'])
     AND whaleu_community.rating_scoped_ids(q,ARRAY['releaseId','catalogId','effectiveRevision','identityId','definitionId'])
     AND q->>'extensionDigest' ~ '^[a-f0-9]{64}$'
     AND c.context->>'mode' IN ('public','admin_preview') AND c.context->>'purpose'='read'
     AND EXISTS(SELECT 1 FROM jsonb_array_elements(c.context->'heads') head WHERE head->>'catalogRevision'=q->>'catalogId'),false)
   THEN RETURN false;END IF;
   SELECT review.* INTO b FROM whaleu_ratings.category_icon_projections p
     JOIN whaleu_ratings.category_icon_release_manifests m ON m.release_id=p.release_id
     JOIN whaleu_ratings.category_icon_review_bindings review ON review.id=p.review_binding_id
     WHERE p.release_id=(q->>'releaseId')::uuid AND p.catalog_id=(q->>'catalogId')::uuid
       AND p.category_id=h.category_id AND p.effective_revision=(q->>'effectiveRevision')::uuid
       AND p.appearance_id=h.appearance_id AND p.extension_digest=q->>'extensionDigest'
       AND m.extension_version='ratings-category-icon-v1'
       AND review.definition_id=(q->>'definitionId')::uuid;
   IF NOT FOUND THEN RETURN false;END IF;
 ELSE
   IF NOT coalesce(
     whaleu_community.rating_scoped_keys(q,ARRAY['kind','rootDefinitionId','closureRevision','identityId','baseSource','overrideSource','definitionId','definitionDigest'])
     AND q->>'kind'='management-root'
     AND whaleu_community.rating_scoped_ids(q,ARRAY['rootDefinitionId','identityId','definitionId'])
     AND q->>'closureRevision' ~ '^[a-f0-9]{64}$' AND q->>'definitionDigest' ~ '^[a-f0-9]{64}$'
     AND c.context->>'mode'='management' AND c.context->>'purpose'='manage_categories',false)
   THEN RETURN false;END IF;
   SELECT review.* INTO b FROM whaleu_ratings.category_icon_management_review_heads head
     JOIN whaleu_ratings.category_icon_definition_heads root_head ON root_head.definition_id=head.root_definition_id
     JOIN whaleu_ratings.category_icon_definitions root ON root.id=head.root_definition_id
     JOIN whaleu_ratings.category_icon_review_bindings review ON review.id=head.review_binding_id
     WHERE head.root_definition_id=(q->>'rootDefinitionId')::uuid
       AND head.selector=c.context->'selector'
       AND root.category_id=h.category_id AND root.identity_id=a.identity_id AND root.appearance_id=h.appearance_id
       AND review.definition_id=(q->>'definitionId')::uuid AND review.definition_digest=q->>'definitionDigest';
   IF NOT FOUND THEN RETURN false;END IF;
 END IF;

 RETURN coalesce(
   b.envelope->'content'->>'categoryId'=h.category_id::text
   AND b.envelope->'content'->>'identityId'=q->>'identityId'
   AND b.envelope->'content'->'baseSource'=q->'baseSource'
   AND b.envelope->'content'->'overrideSource'=q->'overrideSource'
   AND b.envelope->'content'->'icon'->>'kind'='image'
   AND b.envelope->'content'->'icon'->'appearance'->>'appearanceId'=h.appearance_id::text
   AND b.envelope->'content'->'icon'->'appearance'->>'manifestDigest'=h.manifest_digest
   AND whaleu_community.rating_category_icon_immutable_refs_match(b.envelope)
   AND EXISTS(SELECT 1 FROM whaleu_ratings.scoped_source_attestations s
     WHERE s.id=(q->'baseSource'->>'id')::uuid AND s.revision=(q->'baseSource'->>'revision')::uuid)
   AND (q->'overrideSource'='null'::jsonb OR EXISTS(SELECT 1 FROM whaleu_ratings.scoped_source_attestations s
     WHERE s.id=(q->'overrideSource'->>'id')::uuid AND s.revision=(q->'overrideSource'->>'revision')::uuid)),false);
EXCEPTION WHEN OTHERS THEN RETURN false;END$$;

CREATE FUNCTION whaleu_ratings.category_icon_delivery_hold_guard()
RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF TG_OP='INSERT' THEN
   IF NEW.closed_at IS NOT NULL OR NOT whaleu_ratings.category_icon_delivery_hold_qualified(NEW) THEN
     RAISE EXCEPTION 'Category delivery hold requires an exact authorized open lifecycle' USING ERRCODE='23514';
   END IF;
   NEW.created_at:=clock_timestamp();
 ELSE
   IF OLD.closed_at IS NOT NULL OR NEW.closed_at IS NULL
     OR (to_jsonb(NEW)-'closed_at') IS DISTINCT FROM (to_jsonb(OLD)-'closed_at') THEN
     RAISE EXCEPTION 'Category delivery hold identity is immutable and closure is one-way' USING ERRCODE='23514';
   END IF;
   -- The only application writer reaches this transition from physical quiet.
   -- No expiry, context deadline, revoked read or cancellation closes a hold.
   NEW.closed_at:=clock_timestamp();
 END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER category_icon_delivery_hold_guard BEFORE INSERT OR UPDATE
 ON whaleu_ratings.category_icon_delivery_holds FOR EACH ROW
 EXECUTE FUNCTION whaleu_ratings.category_icon_delivery_hold_guard();
CREATE TRIGGER category_icon_delivery_hold_retain BEFORE DELETE
 ON whaleu_ratings.category_icon_delivery_holds FOR EACH ROW
 EXECUTE FUNCTION whaleu_ratings.immutable();
CREATE TRIGGER category_icon_delivery_hold_retain_all BEFORE TRUNCATE
 ON whaleu_ratings.category_icon_delivery_holds FOR EACH STATEMENT
 EXECUTE FUNCTION whaleu_ratings.immutable();
-- Category C1 cleanup obligations, not automatic detach permission. Install after
-- the Category delivery-hold relation. No scheduler, retention policy or provider
-- is installed. The originating applied command remains the exact durable cause.
CREATE TABLE whaleu_ratings.category_icon_retirement_queue(
 appearance_id uuid NOT NULL REFERENCES whaleu_ratings.category_icon_appearances(id),
 causing_actor_id uuid NOT NULL,
 causing_request_id uuid NOT NULL,
 plan_digest text NOT NULL CHECK(plan_digest ~ '^[a-f0-9]{64}$'),
 scope_keys text[] NOT NULL CHECK(whaleu_ratings.scoped_scope_keys_valid(scope_keys)),
 global_required boolean NOT NULL,
 creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 PRIMARY KEY(appearance_id,causing_actor_id,causing_request_id),
 FOREIGN KEY(causing_actor_id,causing_request_id) REFERENCES whaleu_ratings.requests(account_id,request_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TRIGGER a00_category_icon_queue_writer BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
 ON whaleu_ratings.category_icon_retirement_queue FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.scoped_public_writer_gate();
CREATE TRIGGER a01_category_icon_queue_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
 ON whaleu_ratings.category_icon_retirement_queue FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.advance_category_icon_epoch();
CREATE TRIGGER category_icon_queue_immutable BEFORE UPDATE OR DELETE
 ON whaleu_ratings.category_icon_retirement_queue FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.immutable();
CREATE TRIGGER category_icon_queue_retain BEFORE TRUNCATE
 ON whaleu_ratings.category_icon_retirement_queue FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.immutable();

CREATE FUNCTION whaleu_ratings.category_icon_retirement_queue_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ip whaleu_ratings.category_icon_preparations;m jsonb;o whaleu_ratings.scoped_command_outcomes;
BEGIN
 SELECT * INTO ip FROM whaleu_ratings.category_icon_preparations WHERE actor_id=NEW.causing_actor_id AND request_id=NEW.causing_request_id;
 m:=ip.media_plan->'plan';
 IF NOT coalesce(NEW.creation_transaction=pg_current_xact_id() AND NEW.plan_digest=ip.plan_digest
   AND NEW.scope_keys=ip.affected_scope_keys AND NEW.global_required=(m->>'globalRequired')::boolean
   AND NOT ip.noop
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(m->'beforeRoots') r WHERE r->'value'->>'kind'='image' AND r->'value'->'appearance'->>'appearanceId'=NEW.appearance_id::text)
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(m->'afterRoots') r WHERE r->'value'->>'kind'='image' AND r->'value'->'appearance'->>'appearanceId'=NEW.appearance_id::text),false)
 THEN RAISE EXCEPTION 'Category cleanup obligation requires exact displaced appearance and original all-of scopes' USING ERRCODE='23514';END IF;
 IF TG_WHEN='AFTER' THEN
   SELECT * INTO o FROM whaleu_ratings.scoped_command_outcomes WHERE account_id=NEW.causing_actor_id AND request_id=NEW.causing_request_id;
   IF NOT coalesce(o.outcome='applied' AND o.intent_hash=ip.outer_hash AND o.mutation_transaction=pg_current_xact_id(),false)
   THEN RAISE EXCEPTION 'Category cleanup obligation requires applied original command' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER category_icon_queue_guard BEFORE INSERT ON whaleu_ratings.category_icon_retirement_queue
 FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_icon_retirement_queue_guard();
CREATE CONSTRAINT TRIGGER category_icon_queue_final AFTER INSERT ON whaleu_ratings.category_icon_retirement_queue
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_icon_retirement_queue_guard();

-- Scope metadata survives head removal. Reappearance followed by another
-- displacement can only widen this union; old obligations never silently vanish.
CREATE FUNCTION whaleu_ratings.category_icon_retirement_scopes(appearance uuid)
RETURNS text[] LANGUAGE sql STABLE AS $$
 SELECT ARRAY(SELECT DISTINCT scope COLLATE "C" FROM (
 SELECT scope FROM whaleu_ratings.category_icon_retirement_queue q,unnest(q.scope_keys) scope WHERE q.appearance_id=appearance
 UNION ALL SELECT jsonb_array_elements_text(r->'scopeKeys') FROM jsonb_array_elements(whaleu_ratings.category_icon_complete_roots()) r
   JOIN whaleu_ratings.category_icon_appearances a ON a.id=appearance AND r->>'categoryId'=a.category_id::text
 UNION ALL SELECT 'campus:'||(r->>'campusId') FROM jsonb_array_elements(whaleu_ratings.category_icon_complete_roots()) r
   JOIN whaleu_ratings.category_icon_appearances a ON a.id=appearance AND r->>'categoryId'=a.category_id::text WHERE r->>'kind'='override'
 ) scopes ORDER BY scope COLLATE "C")
$$;

-- No hold uses an elapsed lease/deadline as proof of physical quiet. Command
-- expiry only closes the *ability to commit that prepared command*, whose own
-- registered deadline is checked by the original command finalizer.
CREATE FUNCTION whaleu_ratings.category_icon_retirement_blocker(appearance uuid,final_phase boolean DEFAULT false)
RETURNS text LANGUAGE plpgsql VOLATILE AS $$
DECLARE a whaleu_ratings.category_icon_appearances;i whaleu_media.upload_intents;roots jsonb;
BEGIN
 SELECT * INTO a FROM whaleu_ratings.category_icon_appearances WHERE id=appearance;
 IF NOT FOUND THEN RETURN 'unknown';END IF;
 roots:=whaleu_ratings.category_icon_complete_roots();
 IF NOT coalesce(whaleu_ratings.category_icon_roots_valid(roots),false) THEN RETURN 'unknown';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(roots) r WHERE r->'value'->>'kind'='image' AND NOT EXISTS(
   SELECT 1 FROM whaleu_ratings.category_icon_appearances exact WHERE exact.id=(r->'value'->'appearance'->>'appearanceId')::uuid
     AND r->'value'->'appearance'=jsonb_build_object('appearanceId',exact.id,'assetId',exact.asset_id,'manifestDigest',exact.manifest_digest,
       'actorId',exact.actor_id,'categoryId',exact.category_id,'identityId',exact.identity_id,'origin',exact.origin)))
 THEN RETURN 'unknown';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(roots) r WHERE r->'value'->>'kind'='image' AND r->'value'->'appearance'->>'appearanceId'=appearance::text)
 THEN RETURN 'recoverable_root';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(roots) r WHERE r->>'categoryId'=a.category_id::text AND r->'value'->>'kind'='unresolved')
 THEN RETURN 'unresolved_root';END IF;
 IF EXISTS(SELECT 1 FROM whaleu_ratings.category_icon_preparations ip
   JOIN whaleu_ratings.scoped_command_preparations p ON (p.account_id,p.request_id)=(ip.actor_id,ip.request_id)
   WHERE NOT EXISTS(SELECT 1 FROM whaleu_ratings.scoped_command_outcomes o WHERE (o.account_id,o.request_id)=(p.account_id,p.request_id))
     AND p.valid_until>clock_timestamp()
     AND (ip.media_plan->'plan'->'beforeRoots' @> jsonb_build_array(jsonb_build_object('value',jsonb_build_object('appearance',jsonb_build_object('appearanceId',appearance))))
       OR ip.media_plan->'plan'->'afterRoots' @> jsonb_build_array(jsonb_build_object('value',jsonb_build_object('appearance',jsonb_build_object('appearanceId',appearance))))
       OR ip.media_plan->'plan'->'newAppearances' @> jsonb_build_array(jsonb_build_object('appearanceId',appearance))))
 THEN RETURN 'prepared_command';END IF;
 IF EXISTS(SELECT 1 FROM whaleu_ratings.category_icon_delivery_holds h WHERE h.appearance_id=appearance AND h.closed_at IS NULL)
 THEN RETURN 'delivery';END IF;
 SELECT intent.* INTO i FROM whaleu_media.assets asset JOIN whaleu_media.upload_intents intent ON intent.id=asset.intent_id
 WHERE asset.id=a.asset_id AND asset.actor_id=a.actor_id AND asset.manifest_digest=a.manifest_digest
   AND asset.owner_kind='ratings' AND asset.resource_kind='category_icon' AND intent.protocol_version=8;
 IF NOT FOUND OR (NOT final_phase AND i.state<>'ready') OR (final_phase AND i.state NOT IN ('ready','cleanup_pending'))
 THEN RETURN 'unknown';END IF;
 -- A failed/unknown attempt is not a successful completion. Generation changes
 -- and lease expiry cannot erase this conservative worker hold.
 IF EXISTS(SELECT 1 FROM whaleu_media.jobs j WHERE j.intent_id=i.id AND ((j.status<>'succeeded' AND NOT (j.status='cancelled' AND j.attempt=0)) OR j.lease_token IS NOT NULL OR j.lease_until IS NOT NULL))
   OR EXISTS(SELECT 1 FROM whaleu_media.upload_ingress g WHERE g.intent_id=i.id AND g.writer_state NOT IN ('observed','retired'))
   OR EXISTS(SELECT 1 FROM whaleu_media.upload_ingress_writers w JOIN whaleu_media.upload_ingress g ON g.object_attempt_id=w.object_attempt_id WHERE g.intent_id=i.id AND w.state<>'retired')
   OR EXISTS(SELECT 1 FROM whaleu_media.object_attempts x WHERE x.intent_id=i.id AND (x.state NOT IN ('sealed','deleted') OR x.source_version IS NULL OR x.sealed_version IS NULL))
   OR EXISTS(SELECT 1 FROM whaleu_media.derived_object_attempts d WHERE d.intent_id=i.id AND d.state NOT IN ('written','deleted'))
 THEN RETURN 'worker';END IF;
-- Successful multipart upload leaves a durable, never-claimed scratch cleanup
-- obligation even after its writer is proven stopped. The terminal-only Media
-- collector cannot delete that obligation while its asset is still bound.
-- Permit this exact housekeeping fact, not an arbitrary pending/expired lease.
--
-- After terminal admission, Media stages exact attempt / derivative / variant
-- obligations. Only their known never-claimed shapes are admissible here. Their
-- existing not_before deadlines still govern the original collector unchanged.
-- Retryable, retained, deleting, a prior attempt or any lease remains a hold;
-- clearing a lease or advancing time does not establish physical quiet.
IF EXISTS(
 SELECT 1
 FROM whaleu_media.cleanup_obligations c
 LEFT JOIN whaleu_media.object_attempts x ON x.id=c.object_attempt_id
 LEFT JOIN whaleu_media.derived_object_attempts d ON d.id=c.derived_attempt_id
 LEFT JOIN whaleu_media.upload_ingress_writers w ON w.writer_token=c.ingress_writer_id
 LEFT JOIN whaleu_media.upload_ingress g ON g.object_attempt_id=w.object_attempt_id
 LEFT JOIN whaleu_media.variants v ON (v.asset_id,v.variant_name)=(c.asset_id,c.variant_name)
 WHERE (c.asset_id=a.asset_id OR x.intent_id=i.id OR d.intent_id=i.id OR g.intent_id=i.id)
   AND NOT coalesce(
     c.lease_token IS NULL AND c.lease_until IS NULL
     AND (
       c.state='deleted'
       OR (
         c.state='pending' AND c.attempt=0 AND c.confirmed_deleted_at IS NULL
         AND (
           (
             c.ingress_writer_id IS NOT NULL AND g.intent_id=i.id
             AND w.state='retired'
             AND c.reason='ingress-scratch'
             AND c.effect_key='cleanup:scratch:'||w.writer_token::text
             AND (c.provider,c.environment,c.bucket,c.object_key,c.object_version)=
                 (w.provider,w.environment,w.bucket,w.object_key,w.object_version)
           )
           OR (
             final_phase
             AND (
               (
                 c.object_attempt_id IS NOT NULL AND x.intent_id=i.id
                 AND c.reason='intent-cancelled'
                 AND (c.provider,c.environment)=(x.provider,x.environment)
                 AND (
                   (
                     c.effect_key='cleanup:'||x.id::text||':staging'
                     AND (c.bucket,c.object_key,c.object_version)=
                         (x.staging_bucket,x.staging_key,x.source_version)
                   )
                   OR (
                     c.effect_key='cleanup:'||x.id::text||':sealed'
                     AND (c.bucket,c.object_key,c.object_version)=
                         (x.sealed_bucket,x.sealed_key,x.sealed_version)
                   )
                 )
               )
               OR (
                 c.derived_attempt_id IS NOT NULL AND d.intent_id=i.id
                 AND c.reason='intent-terminal'
                 AND c.effect_key='cleanup:derived:'||d.id::text
                 AND (c.provider,c.environment,c.bucket,c.object_key,c.object_version)=
                     (d.provider,d.environment,d.bucket,d.object_key,d.object_version)
               )
               OR (
                 c.asset_id=a.asset_id AND v.asset_id=a.asset_id
                 AND c.reason='intent-cancelled'
                 AND c.effect_key='cleanup:'||v.asset_id::text||':'||v.variant_name
                 AND (c.provider,c.environment,c.bucket,c.object_key,c.object_version)=
                     (v.provider,v.environment,v.bucket,v.object_key,v.object_version)
               )
             )
           )
         )
       )
     ),false)
) THEN RETURN 'retention';END IF;
 RETURN NULL;
EXCEPTION WHEN OTHERS THEN  RETURN 'unknown';END$$;

CREATE FUNCTION whaleu_ratings.category_icon_retirement_closure(actor uuid,request uuid,appearances uuid[])
RETURNS text LANGUAGE sql STABLE AS $$
 SELECT whaleu_ratings.category_icon_digest('terminal-closure',jsonb_build_object(
 'actorId',actor,'requestId',request,'roots',whaleu_ratings.category_icon_complete_roots(),
 'appearances',(SELECT coalesce(jsonb_agg(jsonb_build_object('appearanceId',a.id,'assetId',a.asset_id,'bindingId',a.media_binding_id,
   'actorAccountId',a.actor_id,'manifestDigest',a.manifest_digest,'scopes',whaleu_ratings.category_icon_retirement_scopes(a.id),
   'globalRequired',((SELECT bool_or(q.global_required) FROM whaleu_ratings.category_icon_retirement_queue q WHERE q.appearance_id=a.id) OR 'global'=ANY(whaleu_ratings.category_icon_retirement_scopes(a.id)))) ORDER BY a.id),'[]'::jsonb)
 FROM whaleu_ratings.category_icon_appearances a WHERE a.id=ANY(appearances))))
$$;

CREATE FUNCTION whaleu_ratings.category_icon_terminal_retirement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a whaleu_ratings.category_icon_appearances;b whaleu_media.bindings;keys text[];all_ids uuid[];
BEGIN
 IF TG_WHEN='BEFORE' THEN
   LOCK TABLE whaleu_ratings.scoped_catalog_heads,whaleu_ratings.scoped_source_heads,
     whaleu_ratings.category_icon_definition_heads,whaleu_ratings.category_icon_preparations,
     whaleu_ratings.scoped_command_preparations,whaleu_ratings.scoped_command_outcomes,
     whaleu_ratings.category_icon_delivery_holds,whaleu_ratings.category_icon_retirement_queue IN SHARE MODE NOWAIT;
 ELSE
   -- The Media batch/intent/asset/binding mutation has already completed. These
   -- final fences include phantom/zero-row writers; a lease cannot race commit.
   LOCK TABLE whaleu_media.upload_intents,whaleu_media.assets,whaleu_media.bindings,
     whaleu_media.jobs,whaleu_media.cleanup_obligations,whaleu_media.object_attempts,
     whaleu_media.derived_object_attempts,whaleu_media.upload_ingress,
     whaleu_media.upload_ingress_writers IN SHARE MODE NOWAIT;
 END IF;
 SELECT * INTO a FROM whaleu_ratings.category_icon_appearances WHERE id=NEW.appearance_id;
 SELECT * INTO b FROM whaleu_media.bindings WHERE id=NEW.binding_id;
 keys:=whaleu_ratings.category_icon_retirement_scopes(NEW.appearance_id);
 SELECT array_agg(t.appearance_id ORDER BY t.appearance_id) INTO all_ids FROM whaleu_ratings.category_icon_terminal_retirements t
 WHERE t.causing_actor_id=NEW.causing_actor_id AND t.causing_request_id=NEW.causing_request_id AND t.transaction_id=pg_current_xact_id();
 IF NOT coalesce(NEW.transaction_id=pg_current_xact_id()
   AND (NEW.asset_id,NEW.binding_id,NEW.actor_id,NEW.manifest_digest)=(a.asset_id,a.media_binding_id,a.actor_id,a.manifest_digest)
   AND (b.asset_id,b.resource_id,b.owner_kind,b.resource_kind,b.content_version,b.slot,b.ordinal,b.manifest_digest)=(a.asset_id,a.id,'ratings','category_icon',1,'icon',0,a.manifest_digest)
   AND EXISTS(SELECT 1 FROM whaleu_ratings.category_icon_retirement_queue q JOIN whaleu_ratings.scoped_command_outcomes o
     ON (o.account_id,o.request_id)=(q.causing_actor_id,q.causing_request_id)
     WHERE q.appearance_id=a.id AND q.causing_actor_id=NEW.causing_actor_id AND q.causing_request_id=NEW.causing_request_id AND o.outcome='applied')
   AND whaleu_ratings.category_management_actor_current(NEW.causing_actor_id,clock_timestamp())
   AND whaleu_authorization.rating_category_management_authority_covers(NEW.causing_actor_id,
     ARRAY(SELECT substring(k from 8)::uuid FROM unnest(keys) k WHERE k<>'global'),
     ((SELECT bool_or(q.global_required) FROM whaleu_ratings.category_icon_retirement_queue q WHERE q.appearance_id=a.id) OR 'global'=ANY(keys)))
   AND whaleu_ratings.category_icon_retirement_blocker(a.id,TG_WHEN='AFTER') IS NULL,false)
 THEN RAISE EXCEPTION 'Category terminal retirement requires exact empty recoverable closure and no unresolved holds' USING ERRCODE='23514';END IF;
 IF TG_WHEN='BEFORE' AND b.detached_at IS NOT NULL THEN RAISE EXCEPTION 'Category retirement cannot reauthorize detached media' USING ERRCODE='23514';END IF;
 IF TG_WHEN='AFTER' AND (b.detached_at IS NULL OR b.detach_reason IS DISTINCT FROM 'ratings-category-icon-terminal-retirement'
   OR NEW.closure_revision IS DISTINCT FROM whaleu_ratings.category_icon_retirement_closure(NEW.causing_actor_id,NEW.causing_request_id,all_ids))
 THEN RAISE EXCEPTION 'Category terminal retirement and exact Media8 detach must finish atomically' USING ERRCODE='23514';END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER category_icon_terminal_guard BEFORE INSERT ON whaleu_ratings.category_icon_terminal_retirements
 FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_icon_terminal_retirement_guard();
CREATE CONSTRAINT TRIGGER category_icon_terminal_final AFTER INSERT ON whaleu_ratings.category_icon_terminal_retirements
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_icon_terminal_retirement_guard();

-- Retirement is monotone. Historical definitions/releases may remain as audit
-- evidence, but no future current, dormant or archived recovery head may revive
-- the retired appearance, even through a source-only successor definition.
CREATE FUNCTION whaleu_ratings.category_icon_retired_root_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF EXISTS(SELECT 1 FROM whaleu_ratings.category_icon_definitions d
   JOIN whaleu_ratings.category_icon_terminal_retirements t ON t.appearance_id=d.appearance_id
   WHERE d.id=NEW.definition_id)
 THEN RAISE EXCEPTION 'A terminal Category appearance cannot become a recoverable root again' USING ERRCODE='23514';END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER category_icon_retired_root BEFORE INSERT OR UPDATE ON whaleu_ratings.category_icon_definition_heads
 FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_icon_retired_root_guard();
CREATE CONSTRAINT TRIGGER category_icon_retired_root_final AFTER INSERT OR UPDATE ON whaleu_ratings.category_icon_definition_heads
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_icon_retired_root_guard();
-- The management scope reservation is part of the shared Media request
-- namespace, even before bytes exist. A later legacy/other owner writer cannot
-- steal a cold cancelled Category key by omitting the Media8 marker.
CREATE FUNCTION whaleu_ratings.category_icon_upload_namespace_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor uuid;request uuid;s whaleu_ratings.category_icon_upload_scopes;q whaleu_ratings.command_claims;BEGIN
 actor:=NEW.actor_id;
 IF TG_TABLE_NAME='ratings_discussion_batch_request_fences' THEN request:=NEW.batch_request_id;
 ELSE request:=NEW.client_request_id;END IF;
 SELECT * INTO q FROM whaleu_ratings.command_claims WHERE account_id=actor AND request_id=request;
 IF q.operation IS DISTINCT FROM 'prepare_category_icon_upload_scope' THEN RETURN NULL;END IF;
 SELECT * INTO s FROM whaleu_ratings.category_icon_upload_scopes WHERE actor_id=actor AND client_request_id=request;
 IF s.id IS NULL THEN
 IF EXISTS(SELECT 1 FROM whaleu_media.upload_intents WHERE actor_id=actor AND client_request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_media.upload_request_fences WHERE actor_id=actor AND client_request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_media.profile_request_markers WHERE actor_id=actor AND client_request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_media.ratings_request_markers WHERE actor_id=actor AND client_request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_media.ratings_discussion_request_markers WHERE actor_id=actor AND client_request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_media.category_icon_request_markers WHERE actor_id=actor AND client_request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_media.ratings_discussion_batch_request_fences WHERE actor_id=actor AND batch_request_id=request)
 THEN RAISE EXCEPTION 'Unknown Category scope reservation cannot acquire another Media request' USING ERRCODE='23514';END IF;
 ELSE
 IF s.scope_request_hash<>q.intent_hash
 OR EXISTS(SELECT 1 FROM whaleu_media.upload_intents i WHERE i.actor_id=actor AND i.client_request_id=request AND (i.protocol_version<>8 OR i.request_hash<>s.request_hash OR i.resource_id<>s.id OR i.scope_revision<>s.scope_revision))
 OR EXISTS(SELECT 1 FROM whaleu_media.upload_request_fences f WHERE f.actor_id=actor AND f.client_request_id=request AND (f.protocol_namespace IS DISTINCT FROM 8 OR f.request_hash<>s.request_hash))
 OR EXISTS(SELECT 1 FROM whaleu_media.profile_request_markers WHERE actor_id=actor AND client_request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_media.ratings_request_markers WHERE actor_id=actor AND client_request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_media.ratings_discussion_request_markers WHERE actor_id=actor AND client_request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_media.ratings_discussion_batch_request_fences WHERE actor_id=actor AND batch_request_id=request)
 THEN RAISE EXCEPTION 'Category scope reservation requires its exact exclusive Media8 tuple' USING ERRCODE='23514';END IF;
 END IF;RETURN NULL;
END$$;
DO $$DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['upload_intents','upload_request_fences','profile_request_markers','ratings_request_markers','ratings_discussion_request_markers','category_icon_request_markers','ratings_discussion_batch_request_fences'] LOOP
 EXECUTE format('CREATE CONSTRAINT TRIGGER category_icon_owner_namespace AFTER INSERT OR UPDATE ON whaleu_media.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_icon_upload_namespace_guard()',tab);END LOOP;
 FOREACH tab IN ARRAY ARRAY['category_icon_upload_scopes','category_icon_upload_scope_fences'] LOOP
 EXECUTE format('CREATE CONSTRAINT TRIGGER category_icon_owner_namespace AFTER INSERT ON whaleu_ratings.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_icon_upload_namespace_guard()',tab);END LOOP;
END$$;
