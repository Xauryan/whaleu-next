-- Explicit optional upgrade. Never edits installed semantic v1/v2 bytes.
CREATE TABLE whaleu_semantic.rating_link_installation(version integer PRIMARY KEY CHECK(version=3),checksum text NOT NULL);
CREATE OR REPLACE FUNCTION whaleu_semantic.source_revision(k text, source_id uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 WITH source AS (
  SELECT p.id AS post_id,NULL::uuid AS root_id FROM whaleu_community.posts p WHERE k='post' AND p.id=source_id
  UNION ALL SELECT c.post_id,c.id FROM whaleu_community.root_comments c WHERE k='comment' AND c.id=source_id
  UNION ALL SELECT r.post_id,r.root_comment_id FROM whaleu_community.replies r WHERE k='reply' AND r.id=source_id
 ), nodes AS (
  SELECT 'post'::text AS kind,post_id AS id,0 AS ordinal FROM source
  UNION ALL SELECT 'comment',root_id,1 FROM source WHERE root_id IS NOT NULL
  UNION ALL SELECT 'reply',source_id,2 FROM source WHERE k='reply'
 ), revisions AS (
  SELECT n.ordinal,jsonb_build_array(n.kind,n.id,whaleu_community.rating_link_semantic_generation(n.kind,n.id,g.generation),b.digest,b.decision_id,d.policy_revision_id,h.event_id) AS revision
  FROM nodes n JOIN whaleu_semantic.source_generations g ON g.kind=n.kind AND g.content_id=n.id
  JOIN whaleu_community.content_approval_bindings b ON b.content_kind=n.kind AND b.content_id=n.id AND b.content_version=1
  JOIN whaleu_community.content_approval_decisions d ON d.id=b.decision_id
  JOIN whaleu_community.content_approval_heads h ON h.decision_id=d.id
 ) SELECT CASE WHEN (SELECT count(*) FROM nodes)>0 AND count(*)=(SELECT count(*) FROM nodes) THEN jsonb_agg(revision ORDER BY ordinal) ELSE NULL END FROM revisions
$$;
