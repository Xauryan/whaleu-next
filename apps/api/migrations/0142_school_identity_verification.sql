-- Explicit verified-school correction and exact, cause-scoped admission deltas.
-- Existing related-sync slot ownership/capacity/advance guards are unchanged.
ALTER TABLE whaleu_verification.assertions DROP CONSTRAINT assertions_method_check;
ALTER TABLE whaleu_verification.assertions ADD CONSTRAINT assertions_method_check CHECK(method IN ('document_review','institutional_email','institutional_sso','phone_provider','reconciled_import','native_enrollment','administrator_correction','unknown'));
ALTER TABLE whaleu_verification.events DROP CONSTRAINT verification_event_kind;
ALTER TABLE whaleu_verification.events DROP CONSTRAINT verification_event_fact;
ALTER TABLE whaleu_verification.events ADD CONSTRAINT verification_event_kind CHECK(kind IN ('reconciled_snapshot','revoke','expire','native_enrollment','phone_binding','student_application','student_decision','school_identity_correction'));
ALTER TABLE whaleu_verification.events ADD CONSTRAINT verification_event_fact CHECK((kind IN ('revoke','expire','phone_binding','school_identity_correction') AND fact_kind IS NOT NULL) OR (kind='student_decision' AND (fact_kind IS NULL OR fact_kind='affiliation')) OR (kind IN ('reconciled_snapshot','native_enrollment','student_application') AND fact_kind IS NULL));

-- Full accepted definitions, changing only the affiliation method branch.
CREATE OR REPLACE FUNCTION whaleu_verification.course_comment_fact(actor uuid,kind text,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id AND s.account_id=h.account_id JOIN whaleu_verification.assertions a ON a.id=CASE WHEN kind='phone' THEN s.phone_assertion_id ELSE s.affiliation_assertion_id END
 WHERE h.account_id=actor AND a.account_id=actor AND a.source_account_id=actor AND a.fact_kind=kind AND a.assertion_state='verified' AND a.coverage_state='complete' AND a.provenance_state='accepted'
 AND length(btrim(a.source_reference))>0 AND length(btrim(a.policy_reference))>0 AND a.issuer_institution_id IS NOT DISTINCT FROM a.source_issuer_institution_id
 AND ((kind='phone' AND a.method IN('phone_provider','reconciled_import') AND a.phone_binding_reference IS NOT NULL) OR (kind='affiliation' AND a.method IN('document_review','institutional_email','institutional_sso','reconciled_import','administrator_correction') AND a.issuer_institution_id IS NOT NULL AND a.origin_region_id IS NOT NULL))
 AND isfinite(a.verified_at) AND a.verified_at<=instant AND ((a.expiry_kind='policy_exempt' AND a.expires_at IS NULL) OR(a.expiry_kind='at' AND isfinite(a.expires_at) AND a.expires_at>a.verified_at AND a.expires_at>instant)))
$$;

CREATE OR REPLACE FUNCTION whaleu_verification.window_rating_fact(actor uuid,kind text,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id AND s.account_id=h.account_id JOIN whaleu_verification.assertions a ON a.id=CASE WHEN kind='phone' THEN s.phone_assertion_id ELSE s.affiliation_assertion_id END
 WHERE h.account_id=actor AND a.account_id=actor AND a.source_account_id=actor AND a.fact_kind=kind AND a.assertion_state='verified' AND a.coverage_state='complete' AND a.provenance_state='accepted'
 AND length(btrim(a.source_reference))>0 AND length(btrim(a.policy_reference))>0 AND a.issuer_institution_id IS NOT DISTINCT FROM a.source_issuer_institution_id
 AND ((kind='phone' AND a.method IN('phone_provider','reconciled_import') AND a.phone_binding_reference IS NOT NULL) OR (kind='affiliation' AND a.method IN('document_review','institutional_email','institutional_sso','reconciled_import','administrator_correction') AND a.issuer_institution_id IS NOT NULL AND a.origin_region_id IS NOT NULL))
 AND isfinite(a.verified_at) AND a.verified_at<=instant AND ((a.expiry_kind='policy_exempt' AND a.expires_at IS NULL) OR(a.expiry_kind='at' AND isfinite(a.expires_at) AND a.expires_at>a.verified_at AND a.expires_at>instant)))
$$;

CREATE OR REPLACE FUNCTION whaleu_verification.major_rating_fact(actor uuid,kind text,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id AND s.account_id=h.account_id JOIN whaleu_verification.assertions a ON a.id=CASE WHEN kind='phone' THEN s.phone_assertion_id ELSE s.affiliation_assertion_id END
 WHERE h.account_id=actor AND a.account_id=actor AND a.source_account_id=actor AND a.fact_kind=kind AND a.assertion_state='verified' AND a.coverage_state='complete' AND a.provenance_state='accepted'
 AND length(btrim(a.source_reference))>0 AND length(btrim(a.policy_reference))>0 AND a.issuer_institution_id IS NOT DISTINCT FROM a.source_issuer_institution_id
 AND ((kind='phone' AND a.method IN('phone_provider','reconciled_import') AND a.phone_binding_reference IS NOT NULL) OR (kind='affiliation' AND a.method IN('document_review','institutional_email','institutional_sso','reconciled_import','administrator_correction') AND a.issuer_institution_id IS NOT NULL AND a.origin_region_id IS NOT NULL))
 AND isfinite(a.verified_at) AND a.verified_at<=instant AND ((a.expiry_kind='policy_exempt' AND a.expires_at IS NULL) OR(a.expiry_kind='at' AND isfinite(a.expires_at) AND a.expires_at>a.verified_at AND a.expires_at>instant)))
$$;

CREATE OR REPLACE FUNCTION whaleu_authorization.school_admin_region_allowed(subject uuid,region uuid)
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE aff record;topology_snapshot whaleu_campus.community_topology_snapshots;t jsonb;o jsonb;chosen jsonb;v jsonb;r jsonb;g jsonb;campus_row record;instant timestamptz:=clock_timestamp();BEGIN
 SELECT va.id,va.account_id,va.fact_kind,va.assertion_state,va.coverage_state,va.provenance_state,va.method,va.source_reference,va.policy_reference,
 va.source_account_id,va.issuer_institution_id,va.source_issuer_institution_id,va.origin_region_id,va.verified_at,va.expiry_kind,va.expires_at INTO aff
 FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON(s.id,s.account_id,s.revision)=(h.snapshot_id,h.account_id,h.revision)
 JOIN whaleu_verification.assertions va ON(va.id,va.account_id)=(s.affiliation_assertion_id,s.account_id) WHERE h.account_id=subject;
 IF aff.id IS NULL OR aff.fact_kind<>'affiliation' OR aff.assertion_state<>'verified' OR aff.coverage_state<>'complete' OR aff.provenance_state<>'accepted'
 OR aff.source_account_id IS DISTINCT FROM subject OR aff.issuer_institution_id IS NULL OR aff.issuer_institution_id IS DISTINCT FROM aff.source_issuer_institution_id
 OR aff.origin_region_id IS NULL OR btrim(coalesce(aff.source_reference,''))='' OR btrim(coalesce(aff.policy_reference,''))=''
 OR aff.method NOT IN('document_review','institutional_email','institutional_sso','reconciled_import','administrator_correction')
 OR aff.verified_at IS NULL OR NOT isfinite(aff.verified_at) OR aff.verified_at>instant
 OR NOT ((aff.expiry_kind='policy_exempt' AND aff.expires_at IS NULL) OR(aff.expiry_kind='at' AND isfinite(aff.expires_at) AND aff.expires_at>aff.verified_at AND aff.expires_at>instant)) THEN RETURN false;END IF;
 SELECT ts.* INTO topology_snapshot FROM whaleu_campus.community_topology_heads h JOIN whaleu_campus.community_topology_snapshots ts ON(ts.id,ts.revision)=(h.snapshot_id,h.revision) WHERE h.scope_key='community';
 IF topology_snapshot.id IS NULL OR topology_snapshot.coverage_state<>'complete' OR topology_snapshot.provenance_state<>'accepted' OR btrim(coalesce(topology_snapshot.source_reference,''))='' OR btrim(coalesce(topology_snapshot.policy_reference,''))=''
 OR NOT isfinite(topology_snapshot.effective_at) OR topology_snapshot.effective_at>instant
 OR NOT ((topology_snapshot.expiry_kind='policy_exempt' AND topology_snapshot.valid_until IS NULL) OR(topology_snapshot.expiry_kind='at' AND isfinite(topology_snapshot.valid_until) AND topology_snapshot.valid_until>topology_snapshot.effective_at AND topology_snapshot.valid_until>instant))
 OR NOT whaleu_authorization.school_admin_topology_valid(topology_snapshot.topology) THEN RETURN false;END IF;
 t:=topology_snapshot.topology;
 SELECT value INTO o FROM jsonb_array_elements(t->'regions') WHERE value->>'regionId'=aff.origin_region_id::text;
 SELECT value INTO chosen FROM jsonb_array_elements(t->'regions') WHERE value->>'regionId'=region::text;
 IF o IS NULL OR chosen IS NULL OR o->>'institutionId' IS DISTINCT FROM aff.issuer_institution_id::text OR chosen->>'institutionId' IS DISTINCT FROM aff.issuer_institution_id::text
 OR o->>'groupId' IS DISTINCT FROM chosen->>'groupId' OR o->>'coverage' IS DISTINCT FROM 'complete' OR o->'isActive' IS DISTINCT FROM 'true'::jsonb
 OR chosen->>'coverage' IS DISTINCT FROM 'complete' OR chosen->'isActive' IS DISTINCT FROM 'true'::jsonb
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(t->'groups') group_entry WHERE group_entry->>'groupId'=o->>'groupId' AND group_entry->>'coverage'='complete' AND group_entry->'isActive'='true'::jsonb)
 OR NOT EXISTS(SELECT 1 FROM whaleu_campus.operating_regions WHERE id=aff.origin_region_id AND is_active)
 OR NOT EXISTS(SELECT 1 FROM whaleu_campus.institutions WHERE id=aff.issuer_institution_id) THEN RETURN false;END IF;
 FOR r IN SELECT value FROM jsonb_array_elements(t->'regions') WHERE value->>'institutionId'=aff.issuer_institution_id::text AND value->>'groupId'=o->>'groupId' LOOP
  IF r->>'coverage'<>'complete' OR NOT EXISTS(SELECT 1 FROM whaleu_campus.operating_regions p WHERE p.id::text=r->>'regionId' AND to_jsonb(p.is_active)=r->'isActive') THEN RETURN false;END IF;
 END LOOP;
 -- Every physical active campus must have complete reviewed authority, including
 -- campuses belonging to another known group that is excluded from the options.
 FOR campus_row IN SELECT * FROM whaleu_campus.campuses WHERE institution_id=aff.issuer_institution_id AND is_active LOOP
  SELECT value INTO v FROM jsonb_array_elements(t->'assignments') WHERE value->>'campusId'=campus_row.id::text;
  SELECT value INTO r FROM jsonb_array_elements(t->'regions') WHERE value->>'regionId'=v->>'regionId';
  SELECT value INTO g FROM jsonb_array_elements(t->'groups') WHERE value->>'groupId'=r->>'groupId';
  IF v IS NULL OR v->>'institutionId' IS DISTINCT FROM aff.issuer_institution_id::text OR v->>'coverage' IS DISTINCT FROM 'complete' OR v->'isActive' IS DISTINCT FROM 'true'::jsonb
  OR r IS NULL OR r->>'coverage' IS DISTINCT FROM 'complete' OR r->'isActive' IS DISTINCT FROM 'true'::jsonb
  OR g IS NULL OR g->>'coverage' IS DISTINCT FROM 'complete' OR g->'isActive' IS DISTINCT FROM 'true'::jsonb
  OR NOT EXISTS(SELECT 1 FROM whaleu_campus.operating_regions p WHERE p.id::text=r->>'regionId' AND p.is_active)
  OR NOT EXISTS(SELECT 1 FROM whaleu_campus.campus_region_assignments p WHERE p.campus_id=campus_row.id AND p.operating_region_id::text=v->>'regionId') THEN RETURN false;END IF;
 END LOOP;
 -- Reverse reconciliation retains inactive reviewed rows and missing/remapped
 -- physical inventory. An accepted singleton is proved through this same path.
 FOR v IN SELECT value FROM jsonb_array_elements(t->'assignments') WHERE value->>'institutionId'=aff.issuer_institution_id::text LOOP
  SELECT value INTO r FROM jsonb_array_elements(t->'regions') WHERE value->>'regionId'=v->>'regionId';
  SELECT value INTO g FROM jsonb_array_elements(t->'groups') WHERE value->>'groupId'=r->>'groupId';
  IF v->>'coverage'<>'complete' OR r IS NULL OR r->>'coverage' IS DISTINCT FROM 'complete' OR g IS NULL OR g->>'coverage' IS DISTINCT FROM 'complete'
  OR NOT EXISTS(SELECT 1 FROM whaleu_campus.campuses p WHERE p.id::text=v->>'campusId' AND p.institution_id::text=v->>'institutionId' AND to_jsonb(p.is_active)=v->'isActive')
  OR NOT EXISTS(SELECT 1 FROM whaleu_campus.campus_region_assignments p WHERE p.campus_id::text=v->>'campusId' AND p.operating_region_id::text=v->>'regionId')
  OR NOT EXISTS(SELECT 1 FROM whaleu_campus.operating_regions p WHERE p.id::text=r->>'regionId' AND to_jsonb(p.is_active)=r->'isActive') THEN RETURN false;END IF;
 END LOOP;
 RETURN EXISTS(SELECT 1 FROM jsonb_array_elements(t->'assignments') item JOIN whaleu_campus.campuses campus ON campus.id::text=item->>'campusId'
  JOIN whaleu_campus.campus_region_assignments p ON p.campus_id=campus.id JOIN whaleu_campus.operating_regions physical_region ON physical_region.id=p.operating_region_id
  WHERE item->>'institutionId'=aff.issuer_institution_id::text AND item->>'regionId'=region::text AND item->>'coverage'='complete' AND item->'isActive'='true'::jsonb
  AND campus.institution_id=aff.issuer_institution_id AND campus.is_active AND physical_region.id=region AND physical_region.is_active);
END$$;

CREATE OR REPLACE FUNCTION whaleu_community.related_sync_root_admitted(actor uuid,scope jsonb) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE g jsonb; selection whaleu_campus.community_identity_selections; affiliation whaleu_verification.assertions; config whaleu_community.region_policy_revisions; campus whaleu_campus.campuses; topo jsonb; origin jsonb; assignment jsonb; identity_region jsonb;
BEGIN
 IF whaleu_community.related_sync_scope_valid(scope) IS DISTINCT FROM true OR scope->>'sync'<>'related' THEN RETURN false; END IF;
 g:=whaleu_campus.community_distribution_group((scope->>'originalRegionId')::uuid);
 IF g->>'status'<>'known' OR jsonb_array_length(g->'memberRegionIds')<2 OR g->>'topologySnapshotId' IS DISTINCT FROM scope->>'topologySnapshotId' OR g->>'groupId' IS DISTINCT FROM scope->>'publicationGroupId'
 OR scope->>'publicationMembersDigest' IS DISTINCT FROM encode(sha256(convert_to('whaleu-related-publication-members:v1'||chr(10)||whaleu_community.content_canonical_json(g->'memberRegionIds'),'UTF8')),'hex') THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM whaleu_community.spaces WHERE id=(scope->>'originalSpaceId')::uuid AND kind='regional' AND is_active AND operating_region_id=(scope->>'originalRegionId')::uuid) OR NOT whaleu_community.related_sync_policy_current((scope->>'syncPolicyId')::uuid) OR NOT EXISTS(SELECT 1 FROM whaleu_community.related_sync_policies WHERE id=(scope->>'syncPolicyId')::uuid AND operating_region_id=(scope->>'originalRegionId')::uuid) THEN RETURN false; END IF;
 SELECT s.* INTO selection FROM whaleu_campus.community_identity_heads h JOIN whaleu_campus.community_identity_selections s ON s.id=h.selection_id AND s.account_id=h.account_id AND s.revision=h.revision WHERE h.account_id=actor AND s.id=(scope->>'identitySelectionId')::uuid;
 SELECT a.* INTO affiliation FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id AND s.account_id=h.account_id AND s.revision=h.revision JOIN whaleu_verification.assertions a ON a.id=s.affiliation_assertion_id AND a.account_id=s.account_id WHERE h.account_id=actor AND s.id=(scope->>'affiliationSnapshotId')::uuid AND a.id=(scope->>'affiliationAssertionId')::uuid;
 IF selection.id IS NULL OR selection.selection_state<>'selected' OR selection.campus_id::text IS DISTINCT FROM scope->>'identityCampusId' OR selection.topology_snapshot_id::text IS DISTINCT FROM scope->>'topologySnapshotId' OR selection.affiliation_assertion_id IS DISTINCT FROM affiliation.id OR selection.affiliation_snapshot_id::text IS DISTINCT FROM scope->>'affiliationSnapshotId'
 OR selection.coverage_state<>'complete' OR selection.provenance_state<>'accepted' OR coalesce(length(whaleu_profile.moderation_trim(selection.source_reference)),0)=0 OR coalesce(length(whaleu_profile.moderation_trim(selection.policy_reference)),0)=0 OR NOT isfinite(selection.effective_at) OR selection.effective_at>clock_timestamp() OR NOT ((selection.expiry_kind='policy_exempt' AND selection.valid_until IS NULL) OR (selection.expiry_kind='at' AND selection.valid_until>clock_timestamp()))
 OR affiliation.id IS NULL OR affiliation.fact_kind<>'affiliation' OR affiliation.assertion_state<>'verified' OR affiliation.coverage_state<>'complete' OR affiliation.provenance_state<>'accepted' OR affiliation.source_account_id IS DISTINCT FROM actor OR affiliation.issuer_institution_id IS NULL OR affiliation.issuer_institution_id IS DISTINCT FROM affiliation.source_issuer_institution_id OR affiliation.origin_region_id::text IS DISTINCT FROM scope->>'authorOriginRegionId'
 OR affiliation.method NOT IN ('document_review','institutional_email','institutional_sso','reconciled_import','administrator_correction') OR coalesce(length(whaleu_profile.moderation_trim(affiliation.source_reference)),0)=0 OR coalesce(length(whaleu_profile.moderation_trim(affiliation.policy_reference)),0)=0 OR affiliation.verified_at IS NULL OR NOT isfinite(affiliation.verified_at) OR affiliation.verified_at>clock_timestamp() OR NOT ((affiliation.expiry_kind='policy_exempt' AND affiliation.expires_at IS NULL) OR (affiliation.expiry_kind='at' AND isfinite(affiliation.expires_at) AND affiliation.expires_at>clock_timestamp() AND affiliation.expires_at>affiliation.verified_at)) THEN RETURN false; END IF;
 SELECT topology INTO topo FROM whaleu_campus.community_topology_snapshots WHERE id=selection.topology_snapshot_id;
 SELECT r INTO origin FROM jsonb_array_elements(topo->'regions') r WHERE r->>'regionId'=affiliation.origin_region_id::text;
 SELECT a INTO assignment FROM jsonb_array_elements(topo->'assignments') a WHERE a->>'campusId'=selection.campus_id::text;
 SELECT r INTO identity_region FROM jsonb_array_elements(topo->'regions') r WHERE r->>'regionId'=scope->>'identityRegionId';
 SELECT * INTO campus FROM whaleu_campus.campuses WHERE id=selection.campus_id;
 IF origin IS NULL OR assignment IS NULL OR identity_region IS NULL OR origin->>'institutionId' IS DISTINCT FROM affiliation.issuer_institution_id::text OR identity_region->>'groupId' IS DISTINCT FROM origin->>'groupId' OR origin->>'coverage' IS DISTINCT FROM 'complete' OR origin->'isActive'<>'true'::jsonb OR assignment->>'coverage' IS DISTINCT FROM 'complete' OR assignment->'isActive'<>'true'::jsonb OR assignment->>'regionId' IS DISTINCT FROM scope->>'identityRegionId' OR assignment->>'institutionId' IS DISTINCT FROM affiliation.issuer_institution_id::text
 OR campus.id IS NULL OR NOT campus.is_active OR campus.institution_id IS DISTINCT FROM affiliation.issuer_institution_id OR NOT EXISTS(SELECT 1 FROM whaleu_campus.campus_region_assignments WHERE campus_id=campus.id AND operating_region_id=(scope->>'identityRegionId')::uuid) OR NOT EXISTS(SELECT 1 FROM whaleu_campus.operating_regions WHERE id=affiliation.origin_region_id AND is_active) THEN RETURN false; END IF;
 SELECT p.* INTO config FROM whaleu_community.region_policy_heads h JOIN whaleu_community.region_policy_revisions p ON p.id=h.revision_id AND p.region_id=h.region_id AND p.revision=h.revision WHERE h.region_id=(scope->>'originalRegionId')::uuid AND p.id=(scope->>'configurationRevisionId')::uuid;
 RETURN config.id IS NOT NULL AND config.related_sync_enabled AND config.coverage_state='complete' AND config.provenance_state='accepted' AND coalesce(length(whaleu_profile.moderation_trim(config.source_reference)),0)>0 AND coalesce(length(whaleu_profile.moderation_trim(config.policy_reference)),0)>0 AND isfinite(config.effective_at) AND config.effective_at<=clock_timestamp() AND ((config.expiry_kind='policy_exempt' AND config.valid_until IS NULL) OR (config.expiry_kind='at' AND config.valid_until>clock_timestamp()));
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;

CREATE OR REPLACE FUNCTION whaleu_community.related_sync_child_scope_current(actor uuid,scope jsonb,mode text,root_mode text) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE a whaleu_verification.assertions; v whaleu_verification.snapshots; selection whaleu_campus.community_identity_selections;
 topo whaleu_campus.community_topology_snapshots; cfg whaleu_community.region_policy_revisions;
 verified boolean:=false; origin jsonb; identity_region jsonb; target_region jsonb; assignment jsonb; field text; instant timestamptz:=clock_timestamp();
BEGIN
 SELECT s.* INTO v FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON (s.id,s.account_id,s.revision)=(h.snapshot_id,h.account_id,h.revision) WHERE h.account_id=actor;
 SELECT * INTO a FROM whaleu_verification.assertions WHERE id=v.affiliation_assertion_id AND account_id=actor AND fact_kind='affiliation';
 IF a.id IS NULL OR a.coverage_state<>'complete' OR a.provenance_state<>'accepted' OR a.source_account_id IS DISTINCT FROM actor
 OR coalesce(length(whaleu_profile.moderation_trim(a.source_reference)),0)=0 OR coalesce(length(whaleu_profile.moderation_trim(a.policy_reference)),0)=0
 OR a.issuer_institution_id IS DISTINCT FROM a.source_issuer_institution_id THEN RETURN false; END IF;
 IF a.method='native_enrollment' THEN
  IF a.assertion_state<>'unverified' OR a.source_reference IS DISTINCT FROM 'native_enrollment:'||actor::text OR a.policy_reference<>'native-account-absence/v1'
   OR a.issuer_institution_id IS NOT NULL OR a.origin_region_id IS NOT NULL OR a.phone_binding_reference IS NOT NULL OR a.student_number IS NOT NULL
   OR a.verified_at IS NOT NULL OR a.expiry_kind<>'policy_exempt' OR a.expires_at IS NOT NULL THEN RETURN false; END IF;
 ELSE
  IF a.method NOT IN('document_review','institutional_email','institutional_sso','reconciled_import','administrator_correction') THEN RETURN false; END IF;
  IF a.assertion_state='verified' THEN
   IF a.verified_at IS NULL OR NOT isfinite(a.verified_at) OR a.verified_at>instant
    OR NOT ((a.expiry_kind='policy_exempt' AND a.expires_at IS NULL) OR (a.expiry_kind='at' AND isfinite(a.expires_at) AND a.expires_at>a.verified_at)) THEN RETURN false; END IF;
   verified:=a.expires_at IS NULL OR a.expires_at>instant;
   IF verified AND (a.issuer_institution_id IS NULL OR a.origin_region_id IS NULL) THEN RETURN false; END IF;
  ELSIF a.assertion_state NOT IN('unverified','revoked','expired') THEN RETURN false; END IF;
 END IF;
 IF NOT verified THEN
  IF mode<>'named' OR root_mode<>'named' THEN RETURN false; END IF;
  FOREACH field IN ARRAY ARRAY['authorOriginRegionId','identityRegionId','topologySnapshotId','identityCampusId','identitySelectionId','affiliationSnapshotId','affiliationAssertionId'] LOOP
   IF scope->field IS DISTINCT FROM 'null'::jsonb THEN RETURN false; END IF;
  END LOOP;
  SELECT p.* INTO cfg FROM whaleu_community.region_policy_heads h JOIN whaleu_community.region_policy_revisions p ON (p.id,p.region_id,p.revision)=(h.revision_id,h.region_id,h.revision) WHERE h.region_id=(scope->>'originalRegionId')::uuid;
  RETURN coalesce(cfg.id::text=scope->>'configurationRevisionId' AND cfg.unverified_comment_enabled AND cfg.coverage_state='complete' AND cfg.provenance_state='accepted'
   AND length(whaleu_profile.moderation_trim(cfg.source_reference))>0 AND length(whaleu_profile.moderation_trim(cfg.policy_reference))>0
   AND isfinite(cfg.effective_at) AND cfg.effective_at<=instant AND ((cfg.expiry_kind='policy_exempt' AND cfg.valid_until IS NULL) OR (cfg.expiry_kind='at' AND isfinite(cfg.valid_until) AND cfg.valid_until>cfg.effective_at AND cfg.valid_until>instant)),false);
 END IF;
 IF scope->'configurationRevisionId' IS DISTINCT FROM 'null'::jsonb OR scope->>'authorOriginRegionId' IS DISTINCT FROM a.origin_region_id::text OR scope->>'affiliationSnapshotId' IS DISTINCT FROM v.id::text OR scope->>'affiliationAssertionId' IS DISTINCT FROM a.id::text THEN RETURN false; END IF;
 SELECT s.* INTO selection FROM whaleu_campus.community_identity_heads h JOIN whaleu_campus.community_identity_selections s ON (s.id,s.account_id,s.revision)=(h.selection_id,h.account_id,h.revision) WHERE h.account_id=actor;
 SELECT s.* INTO topo FROM whaleu_campus.community_topology_heads h JOIN whaleu_campus.community_topology_snapshots s ON (s.id,s.revision)=(h.snapshot_id,h.revision) WHERE h.scope_key='community';
 IF selection.id IS NULL OR topo.id IS NULL OR selection.selection_state<>'selected' OR selection.id::text IS DISTINCT FROM scope->>'identitySelectionId'
 OR selection.campus_id::text IS DISTINCT FROM scope->>'identityCampusId' OR selection.affiliation_snapshot_id IS DISTINCT FROM v.id OR selection.affiliation_assertion_id IS DISTINCT FROM a.id
 OR selection.topology_snapshot_id IS DISTINCT FROM topo.id OR topo.id::text IS DISTINCT FROM scope->>'topologySnapshotId'
 OR selection.coverage_state<>'complete' OR selection.provenance_state<>'accepted' OR coalesce(length(whaleu_profile.moderation_trim(selection.source_reference)),0)=0 OR coalesce(length(whaleu_profile.moderation_trim(selection.policy_reference)),0)=0
 OR NOT isfinite(selection.effective_at) OR selection.effective_at>instant OR NOT ((selection.expiry_kind='policy_exempt' AND selection.valid_until IS NULL) OR (selection.expiry_kind='at' AND isfinite(selection.valid_until) AND selection.valid_until>selection.effective_at AND selection.valid_until>instant))
 OR topo.coverage_state<>'complete' OR topo.provenance_state<>'accepted' OR coalesce(length(whaleu_profile.moderation_trim(topo.source_reference)),0)=0 OR coalesce(length(whaleu_profile.moderation_trim(topo.policy_reference)),0)=0
 OR NOT isfinite(topo.effective_at) OR topo.effective_at>instant OR NOT ((topo.expiry_kind='policy_exempt' AND topo.valid_until IS NULL) OR (topo.expiry_kind='at' AND isfinite(topo.valid_until) AND topo.valid_until>topo.effective_at AND topo.valid_until>instant))
 OR whaleu_campus.community_distribution_topology_valid(topo.topology) IS DISTINCT FROM true THEN RETURN false; END IF;
 SELECT r INTO origin FROM jsonb_array_elements(topo.topology->'regions') r WHERE r->>'regionId'=a.origin_region_id::text;
 SELECT p INTO assignment FROM jsonb_array_elements(topo.topology->'assignments') p WHERE p->>'campusId'=selection.campus_id::text;
 SELECT r INTO identity_region FROM jsonb_array_elements(topo.topology->'regions') r WHERE r->>'regionId'=assignment->>'regionId';
 SELECT r INTO target_region FROM jsonb_array_elements(topo.topology->'regions') r WHERE r->>'regionId'=scope->>'originalRegionId';
 IF origin IS NULL OR identity_region IS NULL OR target_region IS NULL OR assignment IS NULL OR assignment->>'coverage' IS DISTINCT FROM 'complete' OR assignment->'isActive' IS DISTINCT FROM 'true'::jsonb
 OR origin->>'institutionId' IS DISTINCT FROM a.issuer_institution_id::text OR assignment->>'institutionId' IS DISTINCT FROM a.issuer_institution_id::text
 OR identity_region->>'groupId' IS DISTINCT FROM origin->>'groupId' OR scope->>'identityRegionId' IS DISTINCT FROM identity_region->>'regionId' THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM (VALUES(origin),(identity_region),(target_region)) node(value)
  WHERE value->>'coverage' IS DISTINCT FROM 'complete' OR value->'isActive' IS DISTINCT FROM 'true'::jsonb
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(topo.topology->'groups') g WHERE g->>'groupId'=value->>'groupId' AND g->>'coverage'='complete' AND g->'isActive'='true'::jsonb)
  OR NOT EXISTS(SELECT 1 FROM whaleu_campus.operating_regions r WHERE r.id=(value->>'regionId')::uuid AND r.is_active)) THEN RETURN false; END IF;
 RETURN EXISTS(SELECT 1 FROM whaleu_campus.campuses c JOIN whaleu_campus.institutions i ON i.id=c.institution_id JOIN whaleu_campus.campus_region_assignments assignment ON assignment.campus_id=c.id
  WHERE c.id=selection.campus_id AND c.is_active AND c.institution_id=a.issuer_institution_id AND assignment.operating_region_id=(scope->>'identityRegionId')::uuid);
END $$;

-- A full vector includes historical slots beyond the current writer capacity.
CREATE FUNCTION whaleu_verification.school_identity_admission_vector() RETURNS jsonb LANGUAGE sql VOLATILE AS $$
 SELECT coalesce(jsonb_object_agg(slot::text,generation::text ORDER BY slot),'{}'::jsonb) FROM whaleu_community.related_sync_admission_generation
$$;
-- The first write-path observation is DB-owned and cannot be replaced after a wait.
-- Read-only previews continue to call the vector function without inserting here.
CREATE TABLE whaleu_verification.school_identity_source_observations (
 id uuid PRIMARY KEY,account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 initial_vector jsonb NOT NULL DEFAULT '{}'::jsonb,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(account_id,creation_transaction)
);
CREATE FUNCTION whaleu_verification.school_identity_observation_capture() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.creation_transaction:=pg_current_xact_id();
 NEW.initial_vector:=whaleu_verification.school_identity_admission_vector();
 NEW.recorded_at:=clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER school_identity_observation_capture BEFORE INSERT ON whaleu_verification.school_identity_source_observations FOR EACH ROW EXECUTE FUNCTION whaleu_verification.school_identity_observation_capture();
CREATE TRIGGER school_identity_observation_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_verification.school_identity_source_observations FOR EACH STATEMENT EXECUTE FUNCTION whaleu_verification.immutable_record();
CREATE TABLE whaleu_verification.school_identity_source_proofs (
 cause_id uuid PRIMARY KEY REFERENCES whaleu_school_uid.producing_causes(id),
 observation_id uuid NOT NULL UNIQUE REFERENCES whaleu_verification.school_identity_source_observations(id),
 creation_transaction xid8 NOT NULL UNIQUE DEFAULT pg_current_xact_id(),
 initial_vector jsonb NOT NULL CHECK(jsonb_typeof(initial_vector)='object'),
 old_head jsonb NOT NULL, old_snapshot jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE whaleu_verification.school_identity_source_statements (
 cause_id uuid NOT NULL REFERENCES whaleu_verification.school_identity_source_proofs(cause_id),
 phase integer NOT NULL CHECK(phase BETWEEN 1 AND 3),
 relation_name text NOT NULL, operation text NOT NULL,
 before_vector jsonb NOT NULL, after_vector jsonb,
 old_rows jsonb NOT NULL DEFAULT '[]', new_rows jsonb NOT NULL DEFAULT '[]',
 writer_slot integer, PRIMARY KEY(cause_id,phase)
);
CREATE FUNCTION whaleu_verification.school_identity_source_proof_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c whaleu_school_uid.producing_causes; h whaleu_verification.account_heads; s whaleu_verification.snapshots; o whaleu_verification.school_identity_source_observations;
BEGIN
 SELECT * INTO c FROM whaleu_school_uid.producing_causes WHERE id=NEW.cause_id;
 SELECT * INTO o FROM whaleu_verification.school_identity_source_observations WHERE id=NEW.observation_id AND account_id=c.account_id AND creation_transaction=pg_current_xact_id();
 SELECT * INTO h FROM whaleu_verification.account_heads WHERE account_id=c.account_id;
 SELECT * INTO s FROM whaleu_verification.snapshots WHERE id=h.snapshot_id AND account_id=c.account_id;
 IF c.id IS NULL OR o.id IS NULL OR c.creation_transaction<>pg_current_xact_id() OR NEW.creation_transaction<>pg_current_xact_id()
 OR NEW.initial_vector IS DISTINCT FROM o.initial_vector
 OR NEW.initial_vector IS DISTINCT FROM whaleu_verification.school_identity_admission_vector()
 OR NEW.old_head IS DISTINCT FROM to_jsonb(h) OR NEW.old_snapshot IS DISTINCT FROM to_jsonb(s)
 OR h.snapshot_id IS DISTINCT FROM c.old_snapshot_id OR h.revision IS DISTINCT FROM c.old_revision
 THEN RAISE EXCEPTION 'School identity source proof requires its unchanged initial observations' USING ERRCODE='23514'; END IF;
 NEW.recorded_at:=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER school_identity_source_proof_guard BEFORE INSERT ON whaleu_verification.school_identity_source_proofs FOR EACH ROW EXECUTE FUNCTION whaleu_verification.school_identity_source_proof_guard();
CREATE TRIGGER school_identity_source_proof_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_verification.school_identity_source_proofs FOR EACH STATEMENT EXECUTE FUNCTION whaleu_verification.immutable_record();
CREATE FUNCTION whaleu_verification.school_identity_statement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP NOT IN('INSERT','UPDATE') OR pg_trigger_depth()<2 THEN RAISE EXCEPTION 'School identity transition journal is source-trigger owned' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER school_identity_statement_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_verification.school_identity_source_statements FOR EACH STATEMENT EXECUTE FUNCTION whaleu_verification.school_identity_statement_guard();
CREATE FUNCTION whaleu_verification.school_identity_source_before() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p whaleu_verification.school_identity_source_proofs; c whaleu_school_uid.producing_causes; step integer; expected jsonb;
BEGIN
 SELECT * INTO p FROM whaleu_verification.school_identity_source_proofs WHERE creation_transaction=pg_current_xact_id();
 IF p.cause_id IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO c FROM whaleu_school_uid.producing_causes WHERE id=p.cause_id;
 SELECT coalesce(max(phase),0)+1 INTO step FROM whaleu_verification.school_identity_source_statements WHERE cause_id=p.cause_id;
 SELECT after_vector INTO expected FROM whaleu_verification.school_identity_source_statements WHERE cause_id=p.cause_id AND phase=step-1;
 IF step=1 THEN expected:=p.initial_vector; END IF;
 IF c.kind NOT IN('correct_school','student_approval') OR step>3
 OR TG_TABLE_NAME IS DISTINCT FROM (CASE step WHEN 1 THEN 'assertions' WHEN 2 THEN 'snapshots' WHEN 3 THEN 'account_heads' END)
 OR TG_OP IS DISTINCT FROM (CASE step WHEN 3 THEN 'UPDATE' ELSE 'INSERT' END)
 OR expected IS NULL OR expected IS DISTINCT FROM whaleu_verification.school_identity_admission_vector()
 THEN RAISE EXCEPTION 'Unexpected or foreign school identity source statement' USING ERRCODE='23514'; END IF;
 INSERT INTO whaleu_verification.school_identity_source_statements(cause_id,phase,relation_name,operation,before_vector) VALUES(p.cause_id,step,TG_TABLE_SCHEMA||'.'||TG_TABLE_NAME,TG_OP,expected);
 RETURN NULL;
END $$;
CREATE FUNCTION whaleu_verification.school_identity_source_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p whaleu_verification.school_identity_source_proofs; j whaleu_verification.school_identity_source_statements;
BEGIN
 SELECT * INTO p FROM whaleu_verification.school_identity_source_proofs WHERE creation_transaction=pg_current_xact_id();
 IF p.cause_id IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO j FROM whaleu_verification.school_identity_source_statements WHERE cause_id=p.cause_id AND after_vector IS NULL;
 IF j.cause_id IS NULL OR j.relation_name<>TG_TABLE_SCHEMA||'.'||TG_TABLE_NAME OR j.operation<>TG_OP OR jsonb_array_length(j.new_rows)<>0
 THEN RAISE EXCEPTION 'Unexpected school identity source row cardinality' USING ERRCODE='23514'; END IF;
 UPDATE whaleu_verification.school_identity_source_statements SET new_rows=jsonb_build_array(to_jsonb(NEW)),old_rows=CASE WHEN TG_OP='UPDATE' THEN jsonb_build_array(to_jsonb(OLD)) ELSE '[]'::jsonb END WHERE cause_id=j.cause_id AND phase=j.phase;
 RETURN NULL;
END $$;
CREATE FUNCTION whaleu_verification.school_identity_source_after() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p whaleu_verification.school_identity_source_proofs; c whaleu_school_uid.producing_causes; j whaleu_verification.school_identity_source_statements; v jsonb; row_data jsonb; delta record; delta_count integer; prior_slot integer;
BEGIN
 SELECT * INTO p FROM whaleu_verification.school_identity_source_proofs WHERE creation_transaction=pg_current_xact_id();
 IF p.cause_id IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO c FROM whaleu_school_uid.producing_causes WHERE id=p.cause_id;
 SELECT * INTO j FROM whaleu_verification.school_identity_source_statements WHERE cause_id=p.cause_id AND after_vector IS NULL;
 v:=whaleu_verification.school_identity_admission_vector(); row_data:=j.new_rows->0;
 IF j.cause_id IS NULL OR j.relation_name<>TG_TABLE_SCHEMA||'.'||TG_TABLE_NAME OR j.operation<>TG_OP
 OR jsonb_array_length(j.new_rows)<>1 OR row_data->>'account_id' IS DISTINCT FROM c.account_id::text
 THEN RAISE EXCEPTION 'School identity source requires exactly its own row' USING ERRCODE='23514'; END IF;
 SELECT count(*) INTO delta_count FROM jsonb_each_text(j.before_vector) b FULL JOIN jsonb_each_text(v) a USING(key) WHERE b.value IS DISTINCT FROM a.value;
 SELECT coalesce(a.key,b.key) key,b.value before_value,a.value after_value INTO delta FROM jsonb_each_text(j.before_vector) b FULL JOIN jsonb_each_text(v) a USING(key) WHERE b.value IS DISTINCT FROM a.value;
 SELECT writer_slot INTO prior_slot FROM whaleu_verification.school_identity_source_statements WHERE cause_id=p.cause_id AND phase=j.phase-1;
 IF delta_count<>1 OR delta.after_value IS NULL OR delta.after_value::numeric IS DISTINCT FROM coalesce(delta.before_value::numeric,0)+1
 OR (j.phase>1 AND delta.key::integer IS DISTINCT FROM prior_slot)
 OR NOT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND granted AND mode='ExclusiveLock'
  AND classid=whaleu_community.related_sync_generation_namespace('admission')::oid AND objsubid=2 AND objid=delta.key::oid)
 THEN RAISE EXCEPTION 'School identity source has an unexplained admission-generation delta' USING ERRCODE='23514'; END IF;
 IF j.phase=1 AND (row_data->>'id' IS DISTINCT FROM c.affiliation_assertion_id::text OR row_data->>'fact_kind'<>'affiliation' OR row_data->>'assertion_state'<>'verified'
  OR row_data->>'issuer_institution_id' IS DISTINCT FROM c.institution_id::text
  OR row_data->>'previous_assertion_id' IS DISTINCT FROM p.old_snapshot->>'affiliation_assertion_id')
 OR j.phase=2 AND (row_data->>'id' IS DISTINCT FROM c.snapshot_id::text OR (row_data->>'revision')::integer<>c.old_revision+1
  OR row_data->>'affiliation_assertion_id' IS DISTINCT FROM c.affiliation_assertion_id::text
  OR row_data->'student_number_assertion_id' IS DISTINCT FROM p.old_snapshot->'student_number_assertion_id'
  OR row_data->'phone_assertion_id' IS DISTINCT FROM p.old_snapshot->'phone_assertion_id'
  OR (c.kind='correct_school' AND (row_data->'application_state' IS DISTINCT FROM p.old_snapshot->'application_state' OR row_data->'application_coverage' IS DISTINCT FROM p.old_snapshot->'application_coverage'))
  OR (c.kind='student_approval' AND (row_data->>'application_state'<>'none' OR row_data->>'application_coverage'<>'complete')))
 OR j.phase=3 AND (j.old_rows IS DISTINCT FROM jsonb_build_array(p.old_head) OR row_data IS DISTINCT FROM jsonb_build_object('account_id',c.account_id,'revision',c.old_revision+1,'snapshot_id',c.snapshot_id))
 THEN RAISE EXCEPTION 'School identity source row does not match its exact cause and predecessor' USING ERRCODE='23514'; END IF;
 UPDATE whaleu_verification.school_identity_source_statements SET after_vector=v,writer_slot=delta.key::integer WHERE cause_id=p.cause_id AND phase=j.phase;
 RETURN NULL;
END $$;
-- PostgreSQL fires same-event triggers by name. a0000 precedes the accepted
-- a000_related_admission_generation, without replacing or bypassing that trigger.
DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['assertions','snapshots','account_heads'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('whaleu_verification.'||relation)::regclass AND tgname='a000_related_admission_generation' AND NOT tgisinternal AND tgenabled='O' AND tgtype=62 AND tgfoid='whaleu_community.related_sync_advance_generation()'::regprocedure AND tgargs=decode('61646d697373696f6e00','hex')) THEN RAISE EXCEPTION 'Expected accepted related-sync source trigger is missing'; END IF;
  EXECUTE format('CREATE TRIGGER a0000_school_identity_source_before BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_verification.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_verification.school_identity_source_before()',relation);
  EXECUTE format('CREATE TRIGGER zzzz_school_identity_source_row AFTER INSERT OR UPDATE OR DELETE ON whaleu_verification.%I FOR EACH ROW EXECUTE FUNCTION whaleu_verification.school_identity_source_row()',relation);
  EXECUTE format('CREATE TRIGGER zzzz_school_identity_source_after AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_verification.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_verification.school_identity_source_after()',relation);
 END LOOP;
END $$;
CREATE FUNCTION whaleu_verification.school_identity_source_final(cause uuid) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE p whaleu_verification.school_identity_source_proofs; c whaleu_school_uid.producing_causes; expected jsonb; n integer;
BEGIN
 LOCK TABLE whaleu_verification.assertions,whaleu_verification.snapshots,whaleu_verification.account_heads,whaleu_community.related_sync_admission_generation IN SHARE MODE NOWAIT;
 SELECT * INTO p FROM whaleu_verification.school_identity_source_proofs WHERE cause_id=cause AND creation_transaction=pg_current_xact_id();
 SELECT * INTO c FROM whaleu_school_uid.producing_causes WHERE id=cause AND creation_transaction=pg_current_xact_id();
 n:=CASE WHEN c.kind IN('correct_school','student_approval') THEN 3 ELSE 0 END;
 IF p.cause_id IS NULL OR c.id IS NULL OR NOT EXISTS(SELECT 1 FROM whaleu_verification.school_identity_source_observations o WHERE o.id=p.observation_id AND o.account_id=c.account_id AND o.creation_transaction=pg_current_xact_id() AND o.initial_vector=p.initial_vector) OR (SELECT count(*) FROM whaleu_verification.school_identity_source_statements WHERE cause_id=cause)<>n
 OR EXISTS(SELECT 1 FROM whaleu_verification.school_identity_source_statements WHERE cause_id=cause AND (after_vector IS NULL OR jsonb_array_length(new_rows)<>1)) THEN RETURN false; END IF;
 IF n=0 THEN expected:=p.initial_vector; ELSE SELECT after_vector INTO expected FROM whaleu_verification.school_identity_source_statements WHERE cause_id=cause AND phase=3; END IF;
 IF expected IS DISTINCT FROM whaleu_verification.school_identity_admission_vector() THEN RETURN false; END IF;
 IF n=0 THEN RETURN EXISTS(SELECT 1 FROM whaleu_verification.account_heads h WHERE h.account_id=c.account_id AND to_jsonb(h)=p.old_head); END IF;
 RETURN EXISTS(SELECT 1 FROM whaleu_verification.account_heads h WHERE h.account_id=c.account_id AND h.snapshot_id=c.snapshot_id AND h.revision=c.old_revision+1);
END $$;
CREATE FUNCTION whaleu_verification.school_identity_source_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF whaleu_verification.school_identity_source_final(NEW.cause_id) IS DISTINCT FROM true THEN RAISE EXCEPTION 'School identity source transition proof is incomplete or changed' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER school_identity_source_complete AFTER INSERT ON whaleu_verification.school_identity_source_proofs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_verification.school_identity_source_complete();
CREATE FUNCTION whaleu_verification.school_identity_affiliation_valid(a whaleu_verification.assertions,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT coalesce(a.fact_kind='affiliation' AND a.assertion_state='verified' AND a.coverage_state='complete' AND a.provenance_state='accepted'
 AND a.source_account_id=a.account_id AND a.issuer_institution_id IS NOT NULL AND a.issuer_institution_id=a.source_issuer_institution_id AND a.origin_region_id IS NOT NULL
 AND length(btrim(a.source_reference))>0 AND length(btrim(a.policy_reference))>0
 AND a.method IN('document_review','institutional_email','institutional_sso','reconciled_import','administrator_correction')
 AND a.verified_at IS NOT NULL AND isfinite(a.verified_at) AND a.verified_at<=instant
 AND ((a.expiry_kind='policy_exempt' AND a.expires_at IS NULL) OR(a.expiry_kind='at' AND isfinite(a.expires_at) AND a.expires_at>a.verified_at AND a.expires_at>instant)),false)
$$;
CREATE FUNCTION whaleu_verification.school_identity_observation(subject uuid) RETURNS jsonb LANGUAGE sql VOLATILE AS $$
 SELECT jsonb_build_object('head',to_jsonb(h),'snapshot',to_jsonb(s),'affiliation',to_jsonb(a),'headXmin',h.xmin::text,'headCtid',h.ctid::text,'eventId',(SELECT e.id FROM whaleu_verification.events e WHERE e.account_id=h.account_id AND e.snapshot_id=h.snapshot_id AND e.revision=h.revision))
 FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON(s.id,s.account_id,s.revision)=(h.snapshot_id,h.account_id,h.revision)
 JOIN whaleu_verification.assertions a ON(a.id,a.account_id)=(s.affiliation_assertion_id,s.account_id)
 WHERE h.account_id=subject AND whaleu_verification.school_identity_affiliation_valid(a,clock_timestamp())
$$;
CREATE TABLE whaleu_verification.school_identity_corrections (
 cause_id uuid PRIMARY KEY REFERENCES whaleu_school_uid.producing_causes(id),
 command_id uuid NOT NULL UNIQUE, account_id uuid NOT NULL,actor_account_id uuid NOT NULL,
 old_observation jsonb NOT NULL, institution_id uuid NOT NULL,origin_region_id uuid NOT NULL,
 assertion_id uuid NOT NULL UNIQUE,snapshot_id uuid NOT NULL UNIQUE,event_id uuid NOT NULL UNIQUE,
 verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id()
);
-- The command owner replaces this fail-closed function in the same migration set.
CREATE FUNCTION whaleu_school_uid.school_identity_correction_authorized(command_id uuid,cause_id uuid,actor uuid,target uuid,old_snapshot uuid,new_snapshot uuid,new_assertion uuid,new_event uuid,institution uuid,region uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE FUNCTION whaleu_verification.school_identity_correction_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c whaleu_school_uid.producing_causes; old_a whaleu_verification.assertions;
BEGIN
 SELECT * INTO c FROM whaleu_school_uid.producing_causes WHERE id=NEW.cause_id;
 PERFORM 1 FROM whaleu_verification.account_heads WHERE account_id=NEW.account_id FOR UPDATE;
 SELECT * INTO old_a FROM whaleu_verification.assertions WHERE id=(NEW.old_observation->'affiliation'->>'id')::uuid AND account_id=NEW.account_id;
 IF c.id IS NULL OR c.kind<>'correct_school' OR c.creation_transaction<>pg_current_xact_id() OR NEW.creation_transaction<>pg_current_xact_id()
 OR (c.account_id,c.actor_account_id,c.source_id,c.affiliation_assertion_id,c.snapshot_id,c.verification_event_id,c.institution_id)
 IS DISTINCT FROM (NEW.account_id,NEW.actor_account_id,NEW.command_id,NEW.assertion_id,NEW.snapshot_id,NEW.event_id,NEW.institution_id)
 OR NEW.old_observation IS DISTINCT FROM whaleu_verification.school_identity_observation(NEW.account_id)
 OR (NEW.old_observation->'head'->>'revision')::integer<>c.old_revision OR NEW.old_observation->'head'->>'snapshot_id' IS DISTINCT FROM c.old_snapshot_id::text
 OR old_a.issuer_institution_id=NEW.institution_id OR whaleu_verification.school_identity_affiliation_valid(old_a,clock_timestamp()) IS DISTINCT FROM true
 OR NOT EXISTS(SELECT 1 FROM whaleu_campus.operating_regions WHERE id=NEW.origin_region_id AND is_active)
 OR NOT EXISTS(SELECT 1 FROM whaleu_verification.school_identity_source_proofs WHERE cause_id=NEW.cause_id AND creation_transaction=pg_current_xact_id())
 THEN RAISE EXCEPTION 'School correction requires exact current accepted predecessor and registered cause' USING ERRCODE='23514'; END IF;
 NEW.verified_at:=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER school_identity_correction_guard BEFORE INSERT ON whaleu_verification.school_identity_corrections FOR EACH ROW EXECUTE FUNCTION whaleu_verification.school_identity_correction_guard();
CREATE TRIGGER school_identity_correction_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_verification.school_identity_corrections FOR EACH STATEMENT EXECUTE FUNCTION whaleu_verification.immutable_record();
CREATE TABLE whaleu_verification.school_identity_descendants (
 assertion_id uuid PRIMARY KEY,account_id uuid NOT NULL,old_head jsonb NOT NULL,old_snapshot jsonb NOT NULL,
 creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER school_identity_descendant_owner BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_verification.school_identity_descendants FOR EACH STATEMENT EXECUTE FUNCTION whaleu_verification.school_identity_statement_guard();
CREATE TRIGGER school_identity_descendant_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_verification.school_identity_descendants FOR EACH STATEMENT EXECUTE FUNCTION whaleu_verification.immutable_record();
CREATE FUNCTION whaleu_verification.school_identity_assertion_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c whaleu_verification.school_identity_corrections; a whaleu_verification.assertions; h whaleu_verification.account_heads; s whaleu_verification.snapshots;
BEGIN
 IF NEW.method<>'administrator_correction' AND NEW.policy_reference IS DISTINCT FROM 'verified-school-correction/v1' AND NOT starts_with(coalesce(NEW.source_reference,''),'school_identity_correction:') THEN RETURN NEW; END IF;
 IF NEW.method<>'administrator_correction' OR NEW.policy_reference IS DISTINCT FROM 'verified-school-correction/v1'
 OR NEW.source_reference IS NULL OR NOT starts_with(NEW.source_reference,'school_identity_correction:') OR NEW.fact_kind<>'affiliation'
 OR NEW.coverage_state<>'complete' OR NEW.provenance_state<>'accepted' OR NEW.source_account_id IS DISTINCT FROM NEW.account_id
 OR NEW.student_number IS NOT NULL OR NEW.phone_binding_reference IS NOT NULL THEN RAISE EXCEPTION 'All reserved correction discriminators must agree' USING ERRCODE='23514'; END IF;
 IF NEW.assertion_state='verified' THEN
  SELECT * INTO c FROM whaleu_verification.school_identity_corrections WHERE assertion_id=NEW.id AND creation_transaction=pg_current_xact_id();
  SELECT * INTO a FROM whaleu_verification.assertions WHERE id=(c.old_observation->'affiliation'->>'id')::uuid AND account_id=NEW.account_id;
  IF c.cause_id IS NULL OR NEW.account_id<>c.account_id OR NEW.source_reference IS DISTINCT FROM 'school_identity_correction:'||c.command_id::text
  OR NEW.issuer_institution_id IS DISTINCT FROM c.institution_id OR NEW.source_issuer_institution_id IS DISTINCT FROM c.institution_id
  OR NEW.origin_region_id IS DISTINCT FROM c.origin_region_id OR NEW.previous_assertion_id IS DISTINCT FROM a.id
  OR NEW.verified_at IS DISTINCT FROM c.verified_at OR NEW.expiry_kind IS DISTINCT FROM a.expiry_kind OR NEW.expires_at IS DISTINCT FROM a.expires_at
  OR whaleu_verification.school_identity_affiliation_valid(a,clock_timestamp()) IS DISTINCT FROM true
  THEN RAISE EXCEPTION 'Verified correction requires its exact fresh source command' USING ERRCODE='23514'; END IF;
 ELSE
  SELECT * INTO a FROM whaleu_verification.assertions WHERE id=NEW.previous_assertion_id AND account_id=NEW.account_id;
  SELECT * INTO h FROM whaleu_verification.account_heads WHERE account_id=NEW.account_id FOR UPDATE;
  SELECT * INTO s FROM whaleu_verification.snapshots WHERE id=h.snapshot_id AND account_id=NEW.account_id;
  IF NEW.assertion_state NOT IN('revoked','expired') OR a.assertion_state NOT IN('verified','expired') OR a.method<>'administrator_correction'
  OR s.affiliation_assertion_id IS DISTINCT FROM a.id
  OR (to_jsonb(NEW)-ARRAY['id','assertion_state','previous_assertion_id','recorded_at']) IS DISTINCT FROM (to_jsonb(a)-ARRAY['id','assertion_state','previous_assertion_id','recorded_at'])
  OR (NEW.assertion_state='expired' AND (a.assertion_state<>'verified' OR a.expiry_kind<>'at' OR a.expires_at>clock_timestamp()))
  THEN RAISE EXCEPTION 'Correction revoke or expiry requires its exact current predecessor' USING ERRCODE='23514'; END IF;
  INSERT INTO whaleu_verification.school_identity_descendants(assertion_id,account_id,old_head,old_snapshot) VALUES(NEW.id,NEW.account_id,to_jsonb(h),to_jsonb(s));
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER school_identity_assertion_guard BEFORE INSERT ON whaleu_verification.assertions FOR EACH ROW EXECUTE FUNCTION whaleu_verification.school_identity_assertion_guard();
CREATE FUNCTION whaleu_verification.school_identity_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.kind='school_identity_correction' AND NOT EXISTS(SELECT 1 FROM whaleu_verification.school_identity_corrections c
 WHERE c.creation_transaction=pg_current_xact_id() AND c.event_id=NEW.id AND c.account_id=NEW.account_id AND c.actor_account_id=NEW.actor_account_id
 AND c.command_id=NEW.operation_id AND c.snapshot_id=NEW.snapshot_id AND NEW.fact_kind='affiliation'
 AND NEW.expected_revision=(c.old_observation->'head'->>'revision')::integer AND NEW.revision=NEW.expected_revision+1 AND NEW.reason_code='verified_school_corrected')
 THEN RAISE EXCEPTION 'Reserved correction event requires its exact source command' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER school_identity_event_guard BEFORE INSERT ON whaleu_verification.events FOR EACH ROW EXECUTE FUNCTION whaleu_verification.school_identity_event_guard();
CREATE FUNCTION whaleu_verification.school_identity_pointer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior uuid; next_id uuid; a whaleu_verification.assertions;
BEGIN
 IF TG_TABLE_NAME='snapshots' THEN next_id:=NEW.affiliation_assertion_id;
 ELSE
  IF TG_OP<>'UPDATE' THEN RETURN NEW; END IF;
  SELECT affiliation_assertion_id INTO prior FROM whaleu_verification.snapshots WHERE id=OLD.snapshot_id AND account_id=OLD.account_id;
  SELECT affiliation_assertion_id INTO next_id FROM whaleu_verification.snapshots WHERE id=NEW.snapshot_id AND account_id=NEW.account_id;
  IF prior IS NOT DISTINCT FROM next_id THEN RETURN NEW; END IF;
 END IF;
 SELECT * INTO a FROM whaleu_verification.assertions WHERE id=next_id AND account_id=NEW.account_id;
 IF a.method IS DISTINCT FROM 'administrator_correction' THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='account_heads' THEN
  IF NOT EXISTS(SELECT 1 FROM whaleu_verification.school_identity_corrections c WHERE c.assertion_id=next_id AND c.snapshot_id=NEW.snapshot_id AND c.creation_transaction=pg_current_xact_id())
  AND NOT EXISTS(SELECT 1 FROM whaleu_verification.school_identity_descendants d WHERE d.assertion_id=next_id AND d.creation_transaction=pg_current_xact_id())
  THEN RAISE EXCEPTION 'Correction pointer cannot be revived or attached to an unrelated head' USING ERRCODE='23514'; END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM whaleu_verification.school_identity_corrections c WHERE c.assertion_id=next_id AND c.creation_transaction=pg_current_xact_id() AND c.snapshot_id<>NEW.id)
  THEN RAISE EXCEPTION 'Fresh correction cannot be consumed by another snapshot' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER school_identity_pointer_guard BEFORE INSERT ON whaleu_verification.snapshots FOR EACH ROW EXECUTE FUNCTION whaleu_verification.school_identity_pointer_guard();
CREATE TRIGGER school_identity_pointer_guard BEFORE UPDATE ON whaleu_verification.account_heads FOR EACH ROW EXECUTE FUNCTION whaleu_verification.school_identity_pointer_guard();
CREATE FUNCTION whaleu_verification.school_identity_correction_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_a whaleu_verification.assertions;
BEGIN
 SELECT * INTO old_a FROM whaleu_verification.assertions WHERE id=(NEW.old_observation->'affiliation'->>'id')::uuid AND account_id=NEW.account_id;
 IF whaleu_school_uid.school_identity_correction_authorized(NEW.command_id,NEW.cause_id,NEW.actor_account_id,NEW.account_id,(NEW.old_observation->'head'->>'snapshot_id')::uuid,NEW.snapshot_id,NEW.assertion_id,NEW.event_id,NEW.institution_id,NEW.origin_region_id) IS DISTINCT FROM true
 OR whaleu_verification.school_identity_affiliation_valid(old_a,clock_timestamp()) IS DISTINCT FROM true
 OR whaleu_verification.school_identity_source_final(NEW.cause_id) IS DISTINCT FROM true
 OR whaleu_school_uid.producing_cause_complete(NEW.cause_id) IS DISTINCT FROM true
 OR NOT EXISTS(SELECT 1 FROM whaleu_verification.assertions a WHERE a.id=NEW.assertion_id AND a.account_id=NEW.account_id AND a.verified_at=NEW.verified_at AND a.expiry_kind=old_a.expiry_kind AND a.expires_at IS NOT DISTINCT FROM old_a.expires_at)
 OR NOT EXISTS(SELECT 1 FROM whaleu_verification.snapshots s JOIN whaleu_verification.account_heads h ON(s.id,s.account_id,s.revision)=(h.snapshot_id,h.account_id,h.revision)
 WHERE s.id=NEW.snapshot_id AND s.account_id=NEW.account_id AND s.affiliation_assertion_id=NEW.assertion_id
 AND s.student_number_assertion_id IS NOT DISTINCT FROM (NEW.old_observation->'snapshot'->>'student_number_assertion_id')::uuid
 AND s.phone_assertion_id IS NOT DISTINCT FROM (NEW.old_observation->'snapshot'->>'phone_assertion_id')::uuid
 AND s.application_state=NEW.old_observation->'snapshot'->>'application_state' AND s.application_coverage=NEW.old_observation->'snapshot'->>'application_coverage')
 OR NOT EXISTS(SELECT 1 FROM whaleu_verification.events e WHERE e.id=NEW.event_id AND e.snapshot_id=NEW.snapshot_id AND e.kind='school_identity_correction' AND e.fact_kind='affiliation')
 THEN RAISE EXCEPTION 'Correction command, verification and UID effects must close exactly together' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER school_identity_correction_complete AFTER INSERT ON whaleu_verification.school_identity_corrections DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_verification.school_identity_correction_complete();
CREATE FUNCTION whaleu_verification.school_identity_descendant_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a whaleu_verification.assertions;
BEGIN
 SELECT * INTO a FROM whaleu_verification.assertions WHERE id=NEW.assertion_id AND account_id=NEW.account_id;
 IF NOT EXISTS(SELECT 1 FROM whaleu_verification.snapshots s JOIN whaleu_verification.account_heads h ON(s.id,s.account_id,s.revision)=(h.snapshot_id,h.account_id,h.revision)
 JOIN whaleu_verification.events e ON(e.snapshot_id,e.account_id,e.revision)=(s.id,s.account_id,s.revision)
 WHERE s.account_id=NEW.account_id AND s.revision=(NEW.old_head->>'revision')::integer+1 AND s.affiliation_assertion_id=NEW.assertion_id
 AND s.student_number_assertion_id IS NOT DISTINCT FROM (NEW.old_snapshot->>'student_number_assertion_id')::uuid
 AND s.phone_assertion_id IS NOT DISTINCT FROM (NEW.old_snapshot->>'phone_assertion_id')::uuid
 AND s.application_state=NEW.old_snapshot->>'application_state' AND s.application_coverage=NEW.old_snapshot->>'application_coverage'
 AND e.kind=CASE a.assertion_state WHEN 'revoked' THEN 'revoke' WHEN 'expired' THEN 'expire' END
 AND e.fact_kind='affiliation' AND e.expected_revision=(NEW.old_head->>'revision')::integer AND e.recorded_at>=NEW.recorded_at)
 OR EXISTS(SELECT 1 FROM whaleu_school_uid.producing_causes c WHERE c.affiliation_assertion_id=NEW.assertion_id AND c.creation_transaction=pg_current_xact_id())
 THEN RAISE EXCEPTION 'Correction descendant requires exactly its revoke or expiry event and no UID issue' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER school_identity_descendant_complete AFTER INSERT ON whaleu_verification.school_identity_descendants DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_verification.school_identity_descendant_complete();
REVOKE ALL ON whaleu_verification.school_identity_source_proofs,whaleu_verification.school_identity_source_statements,whaleu_verification.school_identity_corrections,whaleu_verification.school_identity_descendants FROM PUBLIC;

CREATE OR REPLACE FUNCTION whaleu_school_uid.source_generation_complete(cause_id uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT whaleu_verification.school_identity_source_final(cause_id)
$$;
-- History retention also covers TRUNCATE, whose statement event skips row guards.
DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['assertions','snapshots','events'] LOOP
  EXECUTE format('CREATE TRIGGER school_identity_history_retain BEFORE TRUNCATE ON whaleu_verification.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_verification.immutable_record()',relation);
 END LOOP;
END $$;

-- A captured mutation observation closes through its exact cause, or a genuine
-- terminal stale command which performed no Verification/UID source mutation.
CREATE FUNCTION whaleu_verification.school_identity_observation_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cause uuid;
BEGIN
 SELECT id INTO cause FROM whaleu_school_uid.producing_causes WHERE account_id=NEW.account_id AND creation_transaction=NEW.creation_transaction;
 IF cause IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM whaleu_verification.school_identity_source_proofs p WHERE p.cause_id=cause AND p.observation_id=NEW.id)
  OR whaleu_verification.school_identity_source_final(cause) IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'Initial school identity observation has no exact source closure' USING ERRCODE='23514';
  END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM whaleu_school_uid.commands q WHERE q.account_id=NEW.account_id AND q.created_xid=NEW.creation_transaction AND q.receipt->>'code'='SCHOOL_IDENTITY_STALE') THEN
   RAISE EXCEPTION 'Initial school identity observation requires its authorized producing or terminal cause' USING ERRCODE='23514';
  END IF;
  PERFORM whaleu_school_uid.command_assert_complete(q) FROM whaleu_school_uid.commands q WHERE q.account_id=NEW.account_id AND q.created_xid=NEW.creation_transaction AND q.receipt->>'code'='SCHOOL_IDENTITY_STALE';
  IF NEW.initial_vector IS DISTINCT FROM whaleu_verification.school_identity_admission_vector() THEN
   RAISE EXCEPTION 'Terminal school identity source observation changed' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER school_identity_observation_complete AFTER INSERT ON whaleu_verification.school_identity_source_observations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_verification.school_identity_observation_complete();
REVOKE ALL ON whaleu_verification.school_identity_source_observations FROM PUBLIC;
