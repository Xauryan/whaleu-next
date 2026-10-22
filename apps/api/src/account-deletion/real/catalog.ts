/** Finite preparation owner seal; successor request authority has a separate seal. */
export const preparationCatalogBody = `
WITH relations AS MATERIALIZED (
 SELECT c.oid,c.relname,c.relkind,c.relpersistence,c.relowner,c.relrowsecurity,c.relforcerowsecurity,c.reloptions,c.relispartition,c.relhassubclass FROM (VALUES ('whaleu_real_deletion.preparations')) names(name)
 JOIN pg_class c ON c.oid=to_regclass(names.name)
), constraint_sources AS MATERIALIZED (
 SELECT x.* FROM relations r JOIN pg_constraint x ON x.conrelid=r.oid LIMIT 65
), index_ids AS MATERIALIZED (
 SELECT DISTINCT id FROM (
  (SELECT i.indexrelid id FROM relations r JOIN pg_index i ON i.indrelid=r.oid LIMIT 33)
  UNION ALL (SELECT conindid id FROM constraint_sources WHERE conindid<>0 LIMIT 33)
 ) limited LIMIT 33
), indexes AS MATERIALIZED (
 SELECT i.*,ic.reloptions index_options,
 coalesce(octet_length(i.indexprs::text)>16384,false) OR coalesce(octet_length(i.indpred::text)>16384,false) OR coalesce(octet_length(ic.reloptions::text)>16384,false) source_oversized
 FROM index_ids ids JOIN pg_index i ON i.indexrelid=ids.id JOIN pg_class ic ON ic.oid=i.indexrelid LIMIT 33
), objects AS MATERIALIZED (
 SELECT oid FROM relations UNION ALL SELECT indexrelid FROM indexes
 UNION ALL SELECT c.oid FROM (VALUES ('whaleu_real_deletion.reauthentication_attempts'),('whaleu_real_deletion.provider_captures'),('whaleu_real_deletion.requests'),('whaleu_real_deletion.cancellations')) names(name) JOIN pg_class c ON c.oid=to_regclass(names.name)
 UNION ALL SELECT i.indexrelid FROM (VALUES ('whaleu_real_deletion.reauthentication_attempts'),('whaleu_real_deletion.provider_captures'),('whaleu_real_deletion.requests'),('whaleu_real_deletion.cancellations')) names(name) JOIN pg_index i ON i.indrelid=to_regclass(names.name) LIMIT 65
), known_functions AS MATERIALIZED (
 SELECT to_regprocedure(name)::oid oid FROM (VALUES ('whaleu_real_deletion.preparation_guard()'),('whaleu_real_deletion.preparation_unavailable()'),('whaleu_real_deletion.preparation_catalog()'),('whaleu_real_deletion.preparation_protocol()'),('whaleu_real_deletion.request_immutable()'),('whaleu_real_deletion.request_guard()'),('whaleu_real_deletion.request_apply()'),('whaleu_real_deletion.request_complete()'),('whaleu_real_deletion.attempt_guard()'),('whaleu_real_deletion.capture_guard()'),('whaleu_real_deletion.cancellation_guard()'),('whaleu_real_deletion.cancellation_apply()'),('whaleu_real_deletion.account_pointer_guard()'),('whaleu_real_deletion.account_complete()'),('whaleu_real_deletion.request_catalog()'),('whaleu_real_deletion.request_protocol()'),('whaleu_real_deletion.verification_complete()')) functions(name)
), columns AS MATERIALIZED (
 SELECT 'column'::text kind,c.relname::text||':'||a.attnum::text key,
 jsonb_build_array(a.attname,a.atttypid,a.atttypmod,a.attnotnull,a.attidentity,a.attgenerated,a.attisdropped,a.attcollation,CASE WHEN octet_length(d.adbin::text)>16384 THEN NULL ELSE pg_get_expr(d.adbin,d.adrelid) END) value,coalesce(octet_length(d.adbin::text)>16384,false) oversized
 FROM relations c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0
 LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum LIMIT 65
), constraints AS MATERIALIZED (
 SELECT 'constraint'::text kind,c.relname::text||':'||x.conname::text key,
 jsonb_build_array(CASE WHEN coalesce(octet_length(x.conbin::text)>16384,false) OR (x.conindid<>0 AND (ix.indexrelid IS NULL OR ix.source_oversized)) THEN NULL ELSE pg_get_constraintdef(x.oid,true) END,x.convalidated,x.conenforced,x.condeferrable,x.condeferred,x.conislocal,x.coninhcount,x.connoinherit,x.conparentid) value,(coalesce(octet_length(x.conbin::text)>16384,false) OR (x.conindid<>0 AND (ix.indexrelid IS NULL OR ix.source_oversized))) oversized
 FROM relations c JOIN constraint_sources x ON x.conrelid=c.oid LEFT JOIN indexes ix ON ix.indexrelid=x.conindid LIMIT 65
), triggers AS MATERIALIZED (
 SELECT 'trigger'::text kind,c.relname::text||':'||t.tgname::text key,
 jsonb_build_array(CASE WHEN octet_length(t.tgargs)>16384 OR octet_length(t.tgqual::text)>16384 THEN NULL ELSE pg_get_triggerdef(t.oid,true) END,t.tgenabled,t.tgisinternal,t.tgdeferrable,t.tginitdeferred) value,coalesce(octet_length(t.tgargs)>16384,false) OR coalesce(octet_length(t.tgqual::text)>16384,false) oversized
 FROM relations c JOIN pg_trigger t ON t.tgrelid=c.oid LIMIT 65
), functions AS MATERIALIZED (
 SELECT 'function'::text kind,p.proname::text||'('||pg_get_function_identity_arguments(p.oid)||')' key,
 jsonb_build_array(CASE WHEN octet_length(p.prosrc)>16384 THEN NULL ELSE p.prosrc END,p.proowner,p.prolang,p.provolatile,p.prosecdef,p.proleakproof,p.proparallel,p.proisstrict,p.proretset,p.prorettype,CASE WHEN octet_length(p.proconfig::text)>16384 THEN NULL ELSE p.proconfig END) value,octet_length(p.prosrc)>16384 OR coalesce(octet_length(p.proconfig::text)>16384,false) oversized
 FROM known_functions f JOIN pg_proc p ON p.oid=f.oid
 WHERE p.oid IN (to_regprocedure('whaleu_real_deletion.preparation_guard()'),to_regprocedure('whaleu_real_deletion.preparation_unavailable()'),to_regprocedure('whaleu_real_deletion.preparation_catalog()'))
), facts AS MATERIALIZED (
 SELECT 'relation'::text kind,c.relname::text key,jsonb_build_array(c.relkind,c.relpersistence,c.relowner,c.relrowsecurity,c.relforcerowsecurity,CASE WHEN octet_length(c.reloptions::text)>16384 THEN NULL ELSE c.reloptions END,c.relispartition,c.relhassubclass) value,coalesce(octet_length(c.reloptions::text)>16384,false) oversized FROM relations c
 UNION ALL SELECT * FROM columns
 UNION ALL SELECT * FROM constraints
 UNION ALL SELECT 'index',i.indexrelid::regclass::text,jsonb_build_array(CASE WHEN i.source_oversized THEN NULL ELSE pg_get_indexdef(i.indexrelid) END,i.indisvalid,i.indisready,i.indislive),i.source_oversized FROM indexes i
 UNION ALL SELECT * FROM triggers
 UNION ALL SELECT * FROM functions
 UNION ALL SELECT 'unexpected-relation','exists',to_jsonb(EXISTS(
  SELECT 1 FROM pg_class c WHERE c.relnamespace='whaleu_real_deletion'::regnamespace
  AND NOT EXISTS(SELECT 1 FROM objects o WHERE o.oid=c.oid) LIMIT 1)),false
 UNION ALL SELECT 'unexpected-function','exists',to_jsonb(EXISTS(
  SELECT 1 FROM pg_proc p WHERE p.pronamespace='whaleu_real_deletion'::regnamespace
  AND NOT EXISTS(SELECT 1 FROM known_functions f WHERE f.oid=p.oid) LIMIT 1)),false
 LIMIT 129
), sized AS MATERIALIZED (
 SELECT *,octet_length(jsonb_build_array(kind,key,value)::text) bytes FROM facts
), budget AS MATERIALIZED (
 SELECT coalesce(bool_and(NOT oversized),false) AND count(*)<=128 AND coalesce(max(bytes),0)<=32768 AND coalesce(sum(bytes),0)+greatest(count(*)-1,0)*2+2<=262144
  AND (SELECT count(*) FROM columns)<=64 AND (SELECT count(*) FROM constraints)<=64
  AND (SELECT count(*) FROM indexes)<=32 AND (SELECT count(*) FROM triggers)<=64 AS valid FROM sized
), admitted AS MATERIALIZED (
 SELECT kind,key,value FROM sized WHERE bytes<=32768 AND (SELECT valid FROM budget)
)
SELECT CASE WHEN (SELECT valid FROM budget) THEN encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_array(kind,key,value) ORDER BY kind COLLATE "C",key COLLATE "C"),'[]'::jsonb)::text,'UTF8')),'hex') ELSE NULL END FROM admitted
`;
export const preparationCatalogBodySha256 =
  'f576794f4a68b2ef9be2e670369203f7d51e0c7208391771eea4e8e242443c68';
