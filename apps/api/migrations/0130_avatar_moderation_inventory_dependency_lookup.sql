-- Keep the exact 0129 inventory predicate, using PostgreSQL's indexed trigger
-- function dependencies rather than scanning the entire shared trigger catalog.
-- CREATE/REPLACE TRIGGER records a pg_trigger -> pg_proc dependency for its
-- actual function, including partition clones. Do not filter dependency kinds:
-- the real tgfoid/type/enabled/internal/guard facts below remain authoritative.
-- A WHEN expression can add a function dependency without using that function
-- as the trigger entry point, so the original tgfoid checks remain mandatory.
-- No stored inventory, cross-transaction cache, proof elision or budget change.
CREATE OR REPLACE FUNCTION whaleu_profile.avatar_moderation_media_inventory_current()
RETURNS boolean LANGUAGE sql STABLE AS $$
-- Materialize only function-reference candidates in this one SQL snapshot.
-- Applying classid outside these small CTEs prevents a misleading catalog
-- estimate from choosing a whole pg_trigger-class dependency scan instead.
WITH source_dependencies AS MATERIALIZED (
 SELECT classid,objid FROM pg_catalog.pg_depend
 WHERE refclassid='pg_catalog.pg_proc'::regclass
 AND refobjid='whaleu_media.advance_owner_epoch()'::regprocedure
), guard_dependencies AS MATERIALIZED (
 SELECT classid,objid FROM pg_catalog.pg_depend
 WHERE refclassid='pg_catalog.pg_proc'::regclass
 AND refobjid='whaleu_profile.avatar_moderation_media_statement_guard()'::regprocedure
)
SELECT NOT EXISTS(
 SELECT 1 FROM source_dependencies source_dep
 JOIN pg_catalog.pg_trigger source ON source.oid=source_dep.objid
 WHERE source_dep.classid='pg_catalog.pg_trigger'::regclass

 AND source.tgfoid='whaleu_media.advance_owner_epoch()'::regprocedure
 AND NOT source.tgisinternal AND source.tgenabled<>'D'
 AND ((source.tgtype&1)<>0 OR (source.tgtype&2)<>2 OR NOT EXISTS(
  SELECT 1 FROM guard_dependencies guard_dep
  JOIN pg_catalog.pg_trigger guard ON guard.oid=guard_dep.objid
  WHERE guard_dep.classid='pg_catalog.pg_trigger'::regclass

  AND guard.tgrelid=source.tgrelid
  AND guard.tgfoid='whaleu_profile.avatar_moderation_media_statement_guard()'::regprocedure
  AND guard.tgtype=62 AND guard.tgenabled IN('O','A') AND guard.tgqual IS NULL AND guard.tgnargs=0 AND NOT guard.tgisinternal)))
$$;
