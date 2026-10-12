-- One complete canonical Major owner per bounded read, not per projected field
-- or page member. Preserve missing rows by ordinal; no accepted data is added.
-- 0121 is immutable. Existing singular helpers keep their exact return shape.
SET LOCAL lock_timeout='5s';
CREATE FUNCTION whaleu_majors.major_discussion_sources(ids uuid[],instant timestamptz)
RETURNS TABLE(ordinal bigint,major_id uuid,source jsonb) LANGUAGE sql STABLE AS $$
 WITH catalog_capture AS MATERIALIZED(SELECT whaleu_majors.major_catalog_source(instant) source),
 owner_capture AS MATERIALIZED(SELECT (source->>'catalog')::uuid catalog_id,encode(sha256(convert_to(source::text,'UTF8')),'hex') owner FROM catalog_capture)
 SELECT requested.ordinal,requested.major_id,
 CASE WHEN e.major_id IS NOT NULL THEN jsonb_build_object('catalog',e.catalog_id::text,'revision',e.revision::text,'owner',owner_capture.owner,'population',whaleu_majors.major_discussion_history(requested.major_id,'population',instant),'likes',whaleu_majors.major_discussion_history(requested.major_id,'likes',instant)) END
 FROM unnest(ids) WITH ORDINALITY requested(major_id,ordinal)
 CROSS JOIN owner_capture
 LEFT JOIN whaleu_majors.major_entries e ON e.major_id=requested.major_id AND e.catalog_id=owner_capture.catalog_id AND e.is_active
 ORDER BY requested.ordinal
$$;
CREATE OR REPLACE FUNCTION whaleu_majors.major_discussion_source(wid uuid,instant timestamptz) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT source FROM whaleu_majors.major_discussion_sources(ARRAY[wid],instant)
$$;
