-- Stage A: persistent ordinary-registration gate, NOT production account deletion.
-- A separate reviewed lifecycle must install actual completion authority. This
-- migration cannot fabricate it from the local 0172-0174 rehearsal.
DO $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_meta.schema_migrations
  WHERE name='0178_home_publication_protocol.sql') THEN
  RAISE EXCEPTION 'Registration guard requires the complete 0178 predecessor' USING ERRCODE='23514';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='whaleu_identity'::regnamespace AND relname LIKE 'registration_guard%')
  OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='whaleu_identity'::regnamespace AND proname LIKE 'registration_guard%') THEN
  RAISE EXCEPTION 'Registration guard namespace must be absent before installation' USING ERRCODE='23514';
 END IF;
END$$;

CREATE TABLE whaleu_identity.registration_guard_policy (
 slot smallint PRIMARY KEY CHECK(slot=1),
 protocol text NOT NULL CHECK(protocol='provider-registration-guard-v1'),
 revision bigint NOT NULL CHECK(revision>0),
 mode text NOT NULL CHECK(mode IN('inactive','enforced')),
 completion_protocol text NOT NULL CHECK(completion_protocol IN('unavailable','completed-account-deletion-v1')),
 active_epoch text,
 CHECK((mode='inactive' AND completion_protocol='unavailable' AND active_epoch IS NULL)
  OR (mode='enforced' AND completion_protocol='completed-account-deletion-v1' AND active_epoch IS NOT NULL))
);
CREATE TABLE whaleu_identity.registration_guard_key_epochs (
 epoch text PRIMARY KEY CHECK(epoch ~ '^[a-z][a-z0-9-]{0,31}$'),
 key_check text NOT NULL UNIQUE CHECK(key_check ~ '^[a-f0-9]{64}$')
);
ALTER TABLE whaleu_identity.registration_guard_policy ADD CONSTRAINT registration_guard_active_epoch
 FOREIGN KEY(active_epoch) REFERENCES whaleu_identity.registration_guard_key_epochs(epoch);
CREATE TABLE whaleu_identity.registration_guards (
 request_id uuid NOT NULL,
 generation bigint NOT NULL CHECK(generation>0),
 key_epoch text NOT NULL REFERENCES whaleu_identity.registration_guard_key_epochs(epoch),
 identity_digest text NOT NULL CHECK(identity_digest ~ '^[a-f0-9]{64}$'),
 completed_at timestamptz NOT NULL CHECK(isfinite(completed_at)),
 reregister_after timestamptz NOT NULL CHECK(isfinite(reregister_after)),
 completion_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 CHECK(reregister_after=completed_at+interval '2592000 seconds'),
 PRIMARY KEY(request_id,key_epoch,identity_digest)
);
CREATE INDEX registration_guards_identity ON whaleu_identity.registration_guards(key_epoch,identity_digest,reregister_after);
INSERT INTO whaleu_identity.registration_guard_policy(slot,protocol,revision,mode,completion_protocol,active_epoch)
 VALUES(1,'provider-registration-guard-v1',1,'inactive','unavailable',NULL);

-- The default permits ordinary first registration because no real completion
-- authority is installed, and guards/keys are necessarily empty. An environment
-- flag is never authority to disable an enforced persisted policy.
CREATE FUNCTION whaleu_identity.registration_guard_unavailable() RETURNS trigger
LANGUAGE plpgsql AS $$BEGIN
 RAISE EXCEPTION 'Real account deletion completion authority is not installed' USING ERRCODE='23514';
END$$;
CREATE TRIGGER registration_guard_policy_closed BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
 ON whaleu_identity.registration_guard_policy FOR EACH STATEMENT EXECUTE FUNCTION whaleu_identity.registration_guard_unavailable();
CREATE TRIGGER registration_guard_epochs_closed BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
 ON whaleu_identity.registration_guard_key_epochs FOR EACH STATEMENT EXECUTE FUNCTION whaleu_identity.registration_guard_unavailable();
CREATE TRIGGER registration_guards_closed BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
 ON whaleu_identity.registration_guards FOR EACH STATEMENT EXECUTE FUNCTION whaleu_identity.registration_guard_unavailable();
REVOKE ALL ON whaleu_identity.registration_guard_policy,whaleu_identity.registration_guard_key_epochs,whaleu_identity.registration_guards FROM PUBLIC;

-- Deliberately no lifecycle trigger replacement, owner inventory amendment,
-- enrollment, importer, key material, SQL SECURITY DEFINER grant or public route.
-- New relations are NOT added to the 0174 rehearsal inventory: that historical
-- qualification must fail closed against this and Home/Reading's newer owners.

-- Finite catalog qualification for this exact dormant contract. Stored policy
-- values alone cannot prove that write-closed admission actually remains installed.
CREATE FUNCTION whaleu_identity.registration_guard_catalog() RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog AS $catalog$
WITH relations AS MATERIALIZED (
 SELECT c.oid,c.relname,c.relkind,c.relpersistence,c.relowner,c.relrowsecurity,c.relforcerowsecurity,c.reloptions,c.relispartition,c.relhassubclass FROM (VALUES ('whaleu_identity.registration_guard_policy'),('whaleu_identity.registration_guard_key_epochs'),('whaleu_identity.registration_guards')) names(name)
 JOIN pg_class c ON c.oid=to_regclass(names.name)
), indexes AS MATERIALIZED (
 SELECT i.*,ic.reloptions index_options,
 coalesce(octet_length(i.indexprs::text)>16384,false) OR coalesce(octet_length(i.indpred::text)>16384,false) OR coalesce(octet_length(ic.reloptions::text)>16384,false) source_oversized
 FROM relations r JOIN pg_index i ON i.indrelid=r.oid JOIN pg_class ic ON ic.oid=i.indexrelid LIMIT 33
), objects AS MATERIALIZED (
 SELECT oid FROM relations UNION ALL SELECT indexrelid FROM indexes
), known_functions AS MATERIALIZED (
 SELECT to_regprocedure(name)::oid oid FROM (VALUES ('whaleu_identity.registration_guard_unavailable()'),('whaleu_identity.registration_guard_catalog()'),('whaleu_identity.registration_guard_protocol()')) functions(name)
), columns AS MATERIALIZED (
 SELECT 'column'::text kind,c.relname::text||':'||a.attnum::text key,
 jsonb_build_array(a.attname,a.atttypid,a.atttypmod,a.attnotnull,a.attidentity,a.attgenerated,a.attisdropped,a.attcollation,CASE WHEN octet_length(d.adbin::text)>16384 THEN NULL ELSE pg_get_expr(d.adbin,d.adrelid) END) value,coalesce(octet_length(d.adbin::text)>16384,false) oversized
 FROM relations c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0
 LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum LIMIT 65
), constraints AS MATERIALIZED (
 SELECT 'constraint'::text kind,c.relname::text||':'||x.conname::text key,
 jsonb_build_array(CASE WHEN coalesce(octet_length(x.conbin::text)>16384,false) OR (x.conindid<>0 AND (ix.indexrelid IS NULL OR ix.source_oversized)) THEN NULL ELSE pg_get_constraintdef(x.oid,true) END,x.convalidated,x.conenforced,x.condeferrable,x.condeferred,x.conislocal,x.coninhcount,x.connoinherit,x.conparentid) value,(coalesce(octet_length(x.conbin::text)>16384,false) OR (x.conindid<>0 AND (ix.indexrelid IS NULL OR ix.source_oversized))) oversized
 FROM relations c JOIN pg_constraint x ON x.conrelid=c.oid LEFT JOIN indexes ix ON ix.indexrelid=x.conindid LIMIT 65
), triggers AS MATERIALIZED (
 SELECT 'trigger'::text kind,c.relname::text||':'||t.tgname::text key,
 jsonb_build_array(CASE WHEN octet_length(t.tgargs)>16384 OR octet_length(t.tgqual::text)>16384 THEN NULL ELSE pg_get_triggerdef(t.oid,true) END,t.tgenabled,t.tgisinternal,t.tgdeferrable,t.tginitdeferred) value,coalesce(octet_length(t.tgargs)>16384,false) OR coalesce(octet_length(t.tgqual::text)>16384,false) oversized
 FROM relations c JOIN pg_trigger t ON t.tgrelid=c.oid LIMIT 65
), functions AS MATERIALIZED (
 SELECT 'function'::text kind,p.proname::text||'('||pg_get_function_identity_arguments(p.oid)||')' key,
 jsonb_build_array(CASE WHEN octet_length(p.prosrc)>16384 THEN NULL ELSE p.prosrc END,p.proowner,p.prolang,p.provolatile,p.prosecdef,p.proleakproof,p.proparallel,p.proisstrict,p.proretset,p.prorettype,CASE WHEN octet_length(p.proconfig::text)>16384 THEN NULL ELSE p.proconfig END) value,octet_length(p.prosrc)>16384 OR coalesce(octet_length(p.proconfig::text)>16384,false) oversized
 FROM known_functions f JOIN pg_proc p ON p.oid=f.oid
 WHERE p.oid IS DISTINCT FROM to_regprocedure('whaleu_identity.registration_guard_protocol()')::oid
), facts AS MATERIALIZED (
 SELECT 'relation'::text kind,c.relname::text key,jsonb_build_array(c.relkind,c.relpersistence,c.relowner,c.relrowsecurity,c.relforcerowsecurity,CASE WHEN octet_length(c.reloptions::text)>16384 THEN NULL ELSE c.reloptions END,c.relispartition,c.relhassubclass) value,coalesce(octet_length(c.reloptions::text)>16384,false) oversized FROM relations c
 UNION ALL SELECT * FROM columns
 UNION ALL SELECT * FROM constraints
 UNION ALL SELECT 'index',i.indexrelid::regclass::text,jsonb_build_array(CASE WHEN i.source_oversized THEN NULL ELSE pg_get_indexdef(i.indexrelid) END,i.indisvalid,i.indisready,i.indislive),i.source_oversized FROM indexes i
 UNION ALL SELECT * FROM triggers
 UNION ALL SELECT * FROM functions
 UNION ALL SELECT 'unexpected-relation','exists',to_jsonb(EXISTS(
  SELECT 1 FROM pg_class c WHERE c.relnamespace='whaleu_identity'::regnamespace AND c.relname LIKE 'registration_guard%'
  AND NOT EXISTS(SELECT 1 FROM objects o WHERE o.oid=c.oid) LIMIT 1)),false
 UNION ALL SELECT 'unexpected-function','exists',to_jsonb(EXISTS(
  SELECT 1 FROM pg_proc p WHERE p.pronamespace='whaleu_identity'::regnamespace AND p.proname LIKE 'registration_guard%'
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
 seal:=whaleu_identity.registration_guard_catalog();
 IF seal IS NULL OR seal !~ '^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'Registration guard catalog exceeds its qualification budget' USING ERRCODE='23514';
 END IF;
 EXECUTE format('CREATE FUNCTION whaleu_identity.registration_guard_protocol() RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS %L',
  'SELECT '||quote_literal(jsonb_build_object('version',1,'protocol','provider-registration-guard-v1','migration','0179_identity_registration_guard.sql','catalog',seal)::text)||'::jsonb');
END $marker$;
REVOKE ALL ON FUNCTION whaleu_identity.registration_guard_catalog(),whaleu_identity.registration_guard_protocol() FROM PUBLIC;
