-- Real, non-destructive preparation authority. Acceptance/revocation/erasure
-- remain unavailable. Never use synthetic requests or fixture enrollment.
DO $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_meta.schema_migrations WHERE name='0180_identity_session_revocation_epoch.sql')
    OR to_regnamespace('whaleu_real_deletion') IS NOT NULL THEN
  RAISE EXCEPTION 'Real preparations require exact0180 and a new namespace' USING ERRCODE='23514';
 END IF;
END$$;
CREATE SCHEMA whaleu_real_deletion;
REVOKE ALL ON SCHEMA whaleu_real_deletion FROM PUBLIC;
CREATE TABLE whaleu_real_deletion.preparations(
 intent_id uuid PRIMARY KEY,
 account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 session_id uuid NOT NULL,
 app_id text NOT NULL CHECK(app_id ~ '^wx[a-f0-9]{16}$'),
 base_generation bigint NOT NULL CHECK(base_generation>=0 AND base_generation<9223372036854775807),
 next_generation bigint NOT NULL CHECK(next_generation=base_generation+1),
 intent_hash text NOT NULL CHECK(intent_hash ~ '^[a-f0-9]{64}$'),
 recovery_hash text NOT NULL CHECK(recovery_hash ~ '^[a-f0-9]{64}$'),
 consent text NOT NULL CHECK(consent='explicit-real-account-deletion-v1'),
 created_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL CHECK(expires_at=created_at+interval '900 seconds'),
 created_transaction xid8 NOT NULL
);
CREATE INDEX preparations_account_expiry ON whaleu_real_deletion.preparations(account_id,expires_at,intent_id);
CREATE FUNCTION whaleu_real_deletion.preparation_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $guard$
DECLARE a whaleu_identity.accounts%ROWTYPE; s whaleu_identity.sessions%ROWTYPE; at_time timestamptz; n integer;
BEGIN
 IF TG_OP='UPDATE' THEN
  RAISE EXCEPTION 'Real preparation identity is immutable' USING ERRCODE='23514';
 END IF;
 IF TG_OP='DELETE' THEN
  IF OLD.expires_at>clock_timestamp() THEN
   RAISE EXCEPTION 'Unexpired real preparation cannot be erased' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
 END IF;
 SELECT * INTO a FROM whaleu_identity.accounts WHERE id=NEW.account_id FOR UPDATE NOWAIT;
 SELECT * INTO s FROM whaleu_identity.sessions WHERE id=NEW.session_id AND account_id=NEW.account_id FOR SHARE NOWAIT;
 at_time:=clock_timestamp();
 IF a.id IS NULL OR a.status<>'active' OR a.lifecycle<>'active' OR a.lifecycle_generation<>NEW.base_generation
   OR s.id IS NULL OR s.revoked_at IS NOT NULL OR s.absolute_expires_at<=at_time OR s.access_expires_at<=at_time
   OR s.issued_revocation_epoch<>a.session_revocation_epoch
   OR NOT EXISTS(SELECT 1 FROM whaleu_identity.provider_identities WHERE account_id=a.id AND provider='wechat' AND app_id=NEW.app_id) THEN
  RAISE EXCEPTION 'Real preparation requires current authenticated native identity' USING ERRCODE='23514';
 END IF;
 SELECT count(*) INTO n FROM(SELECT 1 FROM whaleu_real_deletion.preparations WHERE account_id=a.id AND expires_at>at_time LIMIT 4) bounded;
 IF n>=4 THEN RAISE EXCEPTION 'Real preparation budget exhausted' USING ERRCODE='23514'; END IF;
 NEW.created_at:=at_time;
 NEW.expires_at:=at_time+interval '900 seconds';
 NEW.created_transaction:=pg_current_xact_id();
 RETURN NEW;
END$guard$;
CREATE FUNCTION whaleu_real_deletion.preparation_unavailable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $closed$
BEGIN RAISE EXCEPTION 'Real deletion acceptance authority is unavailable' USING ERRCODE='23514';END
$closed$;
CREATE TRIGGER preparation_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_real_deletion.preparations
 FOR EACH ROW EXECUTE FUNCTION whaleu_real_deletion.preparation_guard();
CREATE TRIGGER preparation_no_truncate BEFORE TRUNCATE ON whaleu_real_deletion.preparations
 FOR EACH STATEMENT EXECUTE FUNCTION whaleu_real_deletion.preparation_unavailable();
REVOKE ALL ON whaleu_real_deletion.preparations FROM PUBLIC;
CREATE FUNCTION whaleu_real_deletion.preparation_catalog() RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog AS $catalog$
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
), known_functions AS MATERIALIZED (
 SELECT to_regprocedure(name)::oid oid FROM (VALUES ('whaleu_real_deletion.preparation_guard()'),('whaleu_real_deletion.preparation_unavailable()'),('whaleu_real_deletion.preparation_catalog()'),('whaleu_real_deletion.preparation_protocol()')) functions(name)
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
 WHERE p.oid IS DISTINCT FROM to_regprocedure('whaleu_real_deletion.preparation_protocol()')::oid
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
$catalog$;
DO $marker$DECLARE seal text;BEGIN
 seal:=whaleu_real_deletion.preparation_catalog();
 IF seal IS NULL OR seal !~ '^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'Real preparation schema exceeds qualification budget' USING ERRCODE='23514';
 END IF;
 EXECUTE format('CREATE FUNCTION whaleu_real_deletion.preparation_protocol() RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS %L',
  'SELECT '||quote_literal(jsonb_build_object('version',1,'protocol','real-account-deletion-preparation-v1','migration','0181_identity_real_deletion_preparations.sql','acceptance','unavailable','catalog',seal)::text)||'::jsonb');
END$marker$;
REVOKE ALL ON FUNCTION whaleu_real_deletion.preparation_guard(),whaleu_real_deletion.preparation_unavailable(),whaleu_real_deletion.preparation_catalog(),whaleu_real_deletion.preparation_protocol() FROM PUBLIC;
-- No replacement of0172 lifecycle authority or0180 write-closed epoch guard.
-- No accepted request, recovery rotation, completion, guard issuance, role or grant.
