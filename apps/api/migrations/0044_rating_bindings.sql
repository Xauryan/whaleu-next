-- Same-transaction cross-owner publication/binding. No source issuer installed.
CREATE FUNCTION whaleu_ratings.require_review_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE requested_kind text;subject uuid;definition jsonb;publication xid8;b whaleu_community.rating_approval_bindings;t whaleu_ratings.targets;c whaleu_ratings.comments;category whaleu_ratings.categories;
BEGIN
 IF TG_TABLE_SCHEMA='whaleu_community' THEN requested_kind:=NEW.kind;subject:=NEW.subject_id;ELSE requested_kind:=CASE WHEN TG_TABLE_NAME='targets' THEN 'target' ELSE 'comment' END;subject:=NEW.id;END IF;
 IF requested_kind='target' THEN
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=subject;definition:=t.envelope;publication:=t.creation_transaction;
 IF NOT coalesce(t.id IS NOT NULL AND definition->>'accountId'=t.creator_id::text AND definition->>'purpose'='publish_rating_target' AND definition->>'targetId'=t.id::text AND definition->>'targetRevision'=t.revision::text AND definition->>'categoryId'=t.category_id::text AND definition->>'name'=t.name AND definition->>'description'=t.description AND (definition->'scope'->>'regionId') IS NOT DISTINCT FROM t.region_id::text,false) THEN RAISE EXCEPTION 'Target definition mismatch' USING ERRCODE='23514';END IF;
 ELSE
 SELECT * INTO c FROM whaleu_ratings.comments WHERE id=subject;definition:=c.envelope;publication:=c.publication_transaction;SELECT * INTO t FROM whaleu_ratings.targets WHERE id=c.target_id;
 IF NOT coalesce(c.id IS NOT NULL AND definition->>'accountId'=c.account_id::text AND definition->>'purpose'='publish_rating_comment' AND definition->>'targetId'=c.target_id::text AND definition->>'targetRevision'=t.revision::text AND definition->>'categoryId'=t.category_id::text AND t.active AND definition->>'clientRequestId'=c.request_id::text AND definition->>'authorMode'=c.author_mode AND definition->>'body'=c.body,false) THEN RAISE EXCEPTION 'Comment definition mismatch' USING ERRCODE='23514';END IF;
 END IF;
 SELECT * INTO b FROM whaleu_community.rating_approval_bindings WHERE kind=requested_kind AND subject_id=subject;
 IF b.subject_id IS NULL OR b.envelope IS DISTINCT FROM definition OR b.publication_transaction IS DISTINCT FROM publication OR publication<>pg_current_xact_id() OR b.content_version<>1 OR definition->'assetIds' IS DISTINCT FROM '[]'::jsonb THEN RAISE EXCEPTION 'Exact same-transaction review binding required' USING ERRCODE='23514';END IF;
 SELECT * INTO category FROM whaleu_ratings.categories WHERE catalog_id=(definition->>'catalogRevision')::uuid AND id=(definition->>'categoryId')::uuid;
 IF category.id IS NULL OR category.revision::text<>definition->>'categoryRevision' THEN RAISE EXCEPTION 'Category review mismatch' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER rating_target_review AFTER INSERT ON whaleu_ratings.targets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.require_review_binding();
CREATE CONSTRAINT TRIGGER rating_comment_review AFTER INSERT ON whaleu_ratings.comments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.require_review_binding();
CREATE CONSTRAINT TRIGGER rating_binding_definition AFTER INSERT ON whaleu_community.rating_approval_bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.require_review_binding();
