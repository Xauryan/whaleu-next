/**
 * Lossless execution of the 0176 catalog preimage, not a new schema authority.
 * The caller still pins the installed original function and compares its seal.
 *
 * Unrelated catalog churn must not turn thirteen function OID lookups and
 * forty-four trigger relation lookups into whole-catalog hash joins. The global
 * late-guard trigger scan deliberately remains global, including unknown schemas.
 * Relation OIDs are unique. The disjoint trigger branches retain each row once:
 * relation-owned triggers plus global named guards not owned by those relations.
 * This avoids the opaque OR/ANY selectivity estimate without narrowing the scan.
 * OFFSET 0 keeps each unique-OID lookup parameterized; it never limits its rows.
 *
 * All catalog names, operators and cast types are qualified because this query
 * is parsed before its transaction-local deparser search_path is established.
 */
const facts = `WITH relations AS MATERIALIZED (
  SELECT c.* FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) c.relnamespace
  WHERE n.nspname OPERATOR(pg_catalog.=) 'whaleu_community'
    AND c.relname OPERATOR(pg_catalog.~~) 'reading_format_%'::pg_catalog.text
), target_triggers AS MATERIALIZED (
  SELECT t.* FROM relations r
    JOIN pg_catalog.pg_trigger t ON t.tgrelid OPERATOR(pg_catalog.=) r.oid
    WHERE NOT t.tgisinternal
  UNION ALL
  SELECT t.* FROM pg_catalog.pg_trigger t
    WHERE NOT t.tgisinternal AND t.tgname OPERATOR(pg_catalog.=) 'reading_late_guard'
      AND NOT EXISTS (SELECT 1 FROM relations r WHERE r.oid OPERATOR(pg_catalog.=) t.tgrelid)
), function_oids AS MATERIALIZED (
  SELECT p.oid FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) p.pronamespace
  WHERE n.nspname OPERATOR(pg_catalog.=) 'whaleu_community'
    AND p.proname OPERATOR(pg_catalog.~~) 'reading_format_%'::pg_catalog.text
    AND NOT(p.proname OPERATOR(pg_catalog.=) 'reading_format_protocol'
      AND p.pronargs OPERATOR(pg_catalog.=) 0)
  UNION
  SELECT tgfoid FROM target_triggers
), facts AS (
  SELECT 'relation'::pg_catalog.text kind,c.relname::pg_catalog.text key,
    pg_catalog.jsonb_build_array(c.relkind,c.relpersistence,c.relowner,c.relrowsecurity,c.relforcerowsecurity,c.reloptions,c.relispartition) value FROM relations c
  UNION ALL
  SELECT 'column',c.relname::pg_catalog.text OPERATOR(pg_catalog.||) ':'::pg_catalog.text OPERATOR(pg_catalog.||) a.attnum::pg_catalog.text,
    pg_catalog.jsonb_build_array(a.attname,a.atttypid,a.atttypmod,a.attnotnull,a.attidentity,a.attgenerated,a.attisdropped,a.attcollation,pg_catalog.pg_get_expr(d.adbin,d.adrelid))
    FROM relations c JOIN pg_catalog.pg_attribute a ON a.attrelid OPERATOR(pg_catalog.=) c.oid AND a.attnum OPERATOR(pg_catalog.>) 0
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid OPERATOR(pg_catalog.=) c.oid AND d.adnum OPERATOR(pg_catalog.=) a.attnum
  UNION ALL
  SELECT 'constraint',c.relname::pg_catalog.text OPERATOR(pg_catalog.||) ':'::pg_catalog.text OPERATOR(pg_catalog.||) x.conname::pg_catalog.text,
    pg_catalog.jsonb_build_array(pg_catalog.pg_get_constraintdef(x.oid,true),x.convalidated,x.condeferrable,x.condeferred)
    FROM relations c JOIN pg_catalog.pg_constraint x ON x.conrelid OPERATOR(pg_catalog.=) c.oid
  UNION ALL
  SELECT 'index',c.relname,
    pg_catalog.jsonb_build_array(pg_catalog.pg_get_indexdef(c.oid),i.indisvalid,i.indisready,i.indislive)
    FROM relations c JOIN pg_catalog.pg_index i ON i.indexrelid OPERATOR(pg_catalog.=) c.oid
  UNION ALL
  SELECT 'function',n.nspname::pg_catalog.text OPERATOR(pg_catalog.||) '.'::pg_catalog.text OPERATOR(pg_catalog.||) p.proname::pg_catalog.text OPERATOR(pg_catalog.||) '('::pg_catalog.text OPERATOR(pg_catalog.||) pg_catalog.pg_get_function_identity_arguments(p.oid) OPERATOR(pg_catalog.||) ')'::pg_catalog.text,
    pg_catalog.jsonb_build_array(pg_catalog.pg_get_functiondef(p.oid),p.proowner)
    FROM function_oids wanted
    CROSS JOIN LATERAL (SELECT p.oid,p.proname,p.pronamespace,p.proowner FROM pg_catalog.pg_proc p WHERE p.oid OPERATOR(pg_catalog.=) wanted.oid OFFSET 0) p
    JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) p.pronamespace
  UNION ALL
  SELECT 'trigger',n.nspname::pg_catalog.text OPERATOR(pg_catalog.||) '.'::pg_catalog.text OPERATOR(pg_catalog.||) c.relname::pg_catalog.text OPERATOR(pg_catalog.||) ':'::pg_catalog.text OPERATOR(pg_catalog.||) t.tgname::pg_catalog.text,
    pg_catalog.jsonb_build_array(pg_catalog.pg_get_triggerdef(t.oid,true),t.tgenabled,t.tgdeferrable,t.tginitdeferred)
    FROM target_triggers t
    CROSS JOIN LATERAL (SELECT c.oid,c.relname,c.relnamespace FROM pg_catalog.pg_class c WHERE c.oid OPERATOR(pg_catalog.=) t.tgrelid OFFSET 0) c
    JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) c.relnamespace
), preimage AS (
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(kind,key,value)
    ORDER BY kind COLLATE pg_catalog."C",key COLLATE pg_catalog."C"),'[]'::pg_catalog.jsonb)::pg_catalog.text value FROM facts
)`;

function snapshotQuery(includePreimage: boolean): string {
  return `/* reading-catalog-snapshot-v1 */
WITH saved_path AS MATERIALIZED (
  SELECT pg_catalog.current_setting('search_path') original
), captured AS MATERIALIZED (
  SELECT CASE WHEN pg_catalog.set_config('search_path','pg_catalog',true) OPERATOR(pg_catalog.=) 'pg_catalog'
    THEN (${facts}
      SELECT pg_catalog.jsonb_build_object(
        'catalog',pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(value,'UTF8')),'hex'),
        'slots',(SELECT pg_catalog.array_agg(slot_id ORDER BY slot_id) FROM whaleu_community.reading_format_slots),
        'deparse_path',pg_catalog.current_setting('search_path')${includePreimage ? ",\n        'preimage',value" : ''}) FROM preimage)
    ELSE NULL::pg_catalog.jsonb END snapshot
  FROM saved_path
), restored AS MATERIALIZED (
  SELECT captured.snapshot,
    CASE WHEN captured.snapshot IS NOT NULL
      THEN pg_catalog.set_config('search_path',saved_path.original,true) OPERATOR(pg_catalog.=) saved_path.original
      ELSE false END path_restored
  FROM captured CROSS JOIN saved_path
)
SELECT decoded.catalog,decoded.slots,decoded.deparse_path AS "deparsePath",restored.path_restored AS "searchPathRestored"${includePreimage ? ',decoded.preimage' : ''}
FROM restored CROSS JOIN LATERAL pg_catalog.jsonb_to_record(restored.snapshot)
  AS decoded(catalog pg_catalog.text,slots pg_catalog.int4[],deparse_path pg_catalog.text${includePreimage ? ',preimage pg_catalog.text' : ''})`;
}

/** Same query for raw clients, managed transactions and bounded proof proxies.
 * Materialized dependencies plus CASE order the path change, snapshot and restore.
 * LOCAL changes are rolled back with a failed statement/transaction/savepoint;
 * no session-level setting, fallback collector or cached authority is introduced.
 */
export const readingCatalogSnapshotSql = snapshotQuery(false);

/** Read-only full-preimage differential evidence; never used as runtime authority. */
export const readingCatalogPreimageSql = snapshotQuery(true);
