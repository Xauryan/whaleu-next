-- Explicit school-administrator appointment, fixed-region reassignment and
-- revocation. No global grants, real fixtures, source acceptance or notifications.
-- Writers use the common outer policy gate BEFORE every owner lock. The trigger
-- guards below cannot repair an earlier inverted lock in an uncooperative writer;
-- final NOWAIT relation fences remain mandatory, including for absent role rows.
INSERT INTO whaleu_experience.title_catalog(title_key,name,kind,unlock_level)
 VALUES('role_admin','管理员','special',NULL);

CREATE FUNCTION whaleu_authorization.school_admin_affiliation_facts(subject uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object(
 'head',(SELECT jsonb_build_array(to_jsonb(h),h.xmin::text,h.ctid::text) FROM whaleu_verification.account_heads h WHERE h.account_id=subject),
 'snapshot',(SELECT jsonb_build_array(jsonb_build_object('id',s.id,'account_id',s.account_id,'revision',s.revision,'affiliation_assertion_id',s.affiliation_assertion_id),s.xmin::text,s.ctid::text)
  FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON(s.id,s.account_id,s.revision)=(h.snapshot_id,h.account_id,h.revision) WHERE h.account_id=subject),
 'assertion',(SELECT jsonb_build_array(jsonb_build_object('id',a.id,'account_id',a.account_id,'fact_kind',a.fact_kind,'assertion_state',a.assertion_state,
  'coverage_state',a.coverage_state,'provenance_state',a.provenance_state,'method',a.method,'source_reference',a.source_reference,'policy_reference',a.policy_reference,
  'source_account_id',a.source_account_id,'issuer_institution_id',a.issuer_institution_id,'source_issuer_institution_id',a.source_issuer_institution_id,
  'origin_region_id',a.origin_region_id,'verified_at',a.verified_at,'expiry_kind',a.expiry_kind,'expires_at',a.expires_at),a.xmin::text,a.ctid::text)
  FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON(s.id,s.account_id,s.revision)=(h.snapshot_id,h.account_id,h.revision)
  JOIN whaleu_verification.assertions a ON(a.id,a.account_id)=(s.affiliation_assertion_id,s.account_id) WHERE h.account_id=subject))
$$;
-- Capture before any source wait. Includes absent rows, remapped campuses and
-- physical rows outside the accepted inventory, so both directions are retained.
-- Malformed JSON is fingerprintable; eligibility below separately fails closed.
CREATE FUNCTION whaleu_authorization.school_admin_scope_facts(institution uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 WITH topology AS (SELECT s.topology FROM whaleu_campus.community_topology_heads h
  JOIN whaleu_campus.community_topology_snapshots s ON(s.id,s.revision)=(h.snapshot_id,h.revision) WHERE h.scope_key='community'),
 reviewed AS (SELECT v FROM topology t CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(t.topology->'assignments')='array' THEN t.topology->'assignments' ELSE '[]'::jsonb END) v WHERE v->>'institutionId'=institution::text),
 campuses AS (SELECT c.* FROM whaleu_campus.campuses c WHERE c.institution_id=institution OR EXISTS(SELECT 1 FROM reviewed v WHERE v.v->>'campusId'=c.id::text)),
 regions AS (SELECT r.id FROM whaleu_campus.operating_regions r WHERE
  EXISTS(SELECT 1 FROM campuses c JOIN whaleu_campus.campus_region_assignments a ON a.campus_id=c.id WHERE a.operating_region_id=r.id)
  OR EXISTS(SELECT 1 FROM reviewed v WHERE v.v->>'regionId'=r.id::text)
  OR EXISTS(SELECT 1 FROM topology t CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(t.topology->'regions')='array' THEN t.topology->'regions' ELSE '[]'::jsonb END) v WHERE v->>'institutionId'=institution::text AND v->>'regionId'=r.id::text))
 SELECT jsonb_build_object(
 'head',(SELECT jsonb_build_array(to_jsonb(h),h.xmin::text,h.ctid::text) FROM whaleu_campus.community_topology_heads h WHERE h.scope_key='community'),
 'snapshot',(SELECT jsonb_build_array(to_jsonb(s),s.xmin::text,s.ctid::text) FROM whaleu_campus.community_topology_heads h JOIN whaleu_campus.community_topology_snapshots s ON(s.id,s.revision)=(h.snapshot_id,h.revision) WHERE h.scope_key='community'),
 'institutions',(SELECT coalesce(jsonb_agg(jsonb_build_array(to_jsonb(i),i.xmin::text,i.ctid::text) ORDER BY i.id),'[]'::jsonb) FROM whaleu_campus.institutions i WHERE i.id=institution OR EXISTS(SELECT 1 FROM campuses c WHERE c.institution_id=i.id)),
 'campuses',(SELECT coalesce(jsonb_agg(jsonb_build_array(to_jsonb(c),c.xmin::text,c.ctid::text) ORDER BY c.id),'[]'::jsonb) FROM whaleu_campus.campuses c WHERE c.id IN(SELECT id FROM campuses)),
 'assignments',(SELECT coalesce(jsonb_agg(jsonb_build_array(to_jsonb(a),a.xmin::text,a.ctid::text) ORDER BY a.campus_id),'[]'::jsonb) FROM whaleu_campus.campus_region_assignments a WHERE a.campus_id IN(SELECT id FROM campuses)),
 'regions',(SELECT coalesce(jsonb_agg(jsonb_build_array(to_jsonb(r),r.xmin::text,r.ctid::text) ORDER BY r.id),'[]'::jsonb) FROM whaleu_campus.operating_regions r WHERE r.id IN(SELECT id FROM regions)))
$$;
CREATE FUNCTION whaleu_authorization.school_admin_topology_valid(topology jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v jsonb;BEGIN
 IF whaleu_community.post_owner_visibility_keys(topology,ARRAY['version','groups','regions','assignments']) IS DISTINCT FROM true
 OR topology->'version' IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(topology->'groups') IS DISTINCT FROM 'array'
 OR jsonb_typeof(topology->'regions') IS DISTINCT FROM 'array' OR jsonb_typeof(topology->'assignments') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
 FOR v IN SELECT value FROM jsonb_array_elements(topology->'groups') LOOP
  IF whaleu_community.post_owner_visibility_keys(v,ARRAY['groupId','coverage','isActive']) IS DISTINCT FROM true
  OR whaleu_profile.moderation_uuid_valid(v->>'groupId') IS DISTINCT FROM true OR coalesce(v->>'coverage' IN('complete','missing','conflicting'),false)=false
  OR jsonb_typeof(v->'isActive') IS DISTINCT FROM 'boolean' THEN RETURN false;END IF;
 END LOOP;
 FOR v IN SELECT value FROM jsonb_array_elements(topology->'regions') LOOP
  IF whaleu_community.post_owner_visibility_keys(v,ARRAY['regionId','institutionId','groupId','coverage','isActive']) IS DISTINCT FROM true
  OR whaleu_profile.moderation_uuid_valid(v->>'regionId') IS DISTINCT FROM true OR whaleu_profile.moderation_uuid_valid(v->>'institutionId') IS DISTINCT FROM true
  OR whaleu_profile.moderation_uuid_valid(v->>'groupId') IS DISTINCT FROM true OR coalesce(v->>'coverage' IN('complete','missing','conflicting'),false)=false
  OR jsonb_typeof(v->'isActive') IS DISTINCT FROM 'boolean'
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(topology->'groups') g WHERE g->>'groupId'=v->>'groupId') THEN RETURN false;END IF;
 END LOOP;
 FOR v IN SELECT value FROM jsonb_array_elements(topology->'assignments') LOOP
  IF whaleu_community.post_owner_visibility_keys(v,ARRAY['campusId','institutionId','regionId','coverage','isActive']) IS DISTINCT FROM true
  OR whaleu_profile.moderation_uuid_valid(v->>'campusId') IS DISTINCT FROM true OR whaleu_profile.moderation_uuid_valid(v->>'institutionId') IS DISTINCT FROM true
  OR whaleu_profile.moderation_uuid_valid(v->>'regionId') IS DISTINCT FROM true OR coalesce(v->>'coverage' IN('complete','missing','conflicting'),false)=false
  OR jsonb_typeof(v->'isActive') IS DISTINCT FROM 'boolean'
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(topology->'regions') r WHERE r->>'regionId'=v->>'regionId' AND r->>'institutionId'=v->>'institutionId') THEN RETURN false;END IF;
 END LOOP;
 RETURN NOT EXISTS(SELECT 1 FROM jsonb_array_elements(topology->'groups') g GROUP BY g->>'groupId' HAVING count(*)<>1)
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(topology->'regions') r GROUP BY r->>'regionId' HAVING count(*)<>1)
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(topology->'assignments') a GROUP BY a->>'campusId' HAVING count(*)<>1);
END$$;
CREATE FUNCTION whaleu_authorization.school_admin_region_allowed(subject uuid,region uuid)
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE aff record;topology_snapshot whaleu_campus.community_topology_snapshots;t jsonb;o jsonb;chosen jsonb;v jsonb;r jsonb;g jsonb;campus_row record;instant timestamptz:=clock_timestamp();BEGIN
 SELECT va.id,va.account_id,va.fact_kind,va.assertion_state,va.coverage_state,va.provenance_state,va.method,va.source_reference,va.policy_reference,
 va.source_account_id,va.issuer_institution_id,va.source_issuer_institution_id,va.origin_region_id,va.verified_at,va.expiry_kind,va.expires_at INTO aff
 FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON(s.id,s.account_id,s.revision)=(h.snapshot_id,h.account_id,h.revision)
 JOIN whaleu_verification.assertions va ON(va.id,va.account_id)=(s.affiliation_assertion_id,s.account_id) WHERE h.account_id=subject;
 IF aff.id IS NULL OR aff.fact_kind<>'affiliation' OR aff.assertion_state<>'verified' OR aff.coverage_state<>'complete' OR aff.provenance_state<>'accepted'
 OR aff.source_account_id IS DISTINCT FROM subject OR aff.issuer_institution_id IS NULL OR aff.issuer_institution_id IS DISTINCT FROM aff.source_issuer_institution_id
 OR aff.origin_region_id IS NULL OR btrim(coalesce(aff.source_reference,''))='' OR btrim(coalesce(aff.policy_reference,''))=''
 OR aff.method NOT IN('document_review','institutional_email','institutional_sso','reconciled_import')
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
CREATE FUNCTION whaleu_authorization.school_admin_management_input_facts(actor uuid,selected uuid,target uuid,include_eligibility boolean DEFAULT true)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 WITH subject AS(SELECT account_id FROM whaleu_profile.profiles WHERE public_id=target),
 affiliation AS(SELECT whaleu_authorization.school_admin_affiliation_facts(account_id) facts FROM subject WHERE include_eligibility)
 SELECT jsonb_build_object(
 'selected',(SELECT jsonb_build_array(to_jsonb(g),g.xmin::text,g.ctid::text) FROM whaleu_authorization.role_grants g WHERE g.id=selected AND g.account_id=actor),
 'actor_grants',(SELECT coalesce(jsonb_agg(jsonb_build_array(to_jsonb(g),g.xmin::text,g.ctid::text) ORDER BY g.id),'[]'::jsonb) FROM whaleu_authorization.role_grants g WHERE g.account_id=actor),
 'target_grants',(SELECT coalesce(jsonb_agg(jsonb_build_array(to_jsonb(g),g.xmin::text,g.ctid::text) ORDER BY g.id),'[]'::jsonb) FROM whaleu_authorization.role_grants g WHERE g.account_id IN(SELECT account_id FROM subject)),
 'epoch',(SELECT revision::text FROM whaleu_majors.major_delete_authority_epoch WHERE singleton),
 'assignment_regions',(SELECT coalesce(jsonb_agg(jsonb_build_array(to_jsonb(r),r.xmin::text,r.ctid::text) ORDER BY r.id),'[]'::jsonb)
  FROM whaleu_campus.operating_regions r WHERE EXISTS(SELECT 1 FROM whaleu_authorization.role_grants g WHERE g.account_id IN(SELECT account_id FROM subject) AND g.role='school_admin' AND g.operating_region_id=r.id)),
 'fixed',whaleu_profile.moderation_hash(jsonb_build_object(
 'profile',(SELECT jsonb_build_array(to_jsonb(p),p.xmin::text,p.ctid::text) FROM whaleu_profile.profiles p WHERE p.public_id=target),
 'account',(SELECT jsonb_build_array(to_jsonb(a),a.xmin::text,a.ctid::text) FROM whaleu_identity.accounts a WHERE a.id IN(SELECT account_id FROM subject)),
 'affiliation',(SELECT facts FROM affiliation),
 'scope',(SELECT whaleu_authorization.school_admin_scope_facts((facts->'assertion'->0->>'issuer_institution_id')::uuid) FROM affiliation),
 'catalog',(SELECT jsonb_build_array(to_jsonb(t),t.xmin::text,t.ctid::text) FROM whaleu_experience.title_catalog t WHERE include_eligibility AND t.title_key='role_admin'))))
$$;
CREATE FUNCTION whaleu_authorization.school_admin_management_state_version(target uuid)
RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 -- Version is about the displayed target and all currently observed source
 -- facts, even when those facts prove unavailable. It grants no authority.
 SELECT whaleu_profile.moderation_hash(jsonb_build_object(
  'facts',whaleu_authorization.school_admin_management_input_facts(NULL,NULL,target,true)-ARRAY['actor_grants','selected','epoch'],
  'assignment_status',(SELECT coalesce(jsonb_agg(jsonb_build_array(g.id,CASE WHEN g.valid_from>clock_timestamp() THEN 'future'
    WHEN g.expires_at IS NOT NULL AND g.expires_at<=clock_timestamp() THEN 'expired' ELSE 'active' END) ORDER BY g.id),'[]'::jsonb)
   FROM whaleu_authorization.role_grants g JOIN whaleu_profile.profiles p ON p.account_id=g.account_id
   WHERE p.public_id=target AND g.role='school_admin' AND g.revoked_at IS NULL)))
$$;
CREATE FUNCTION whaleu_authorization.school_admin_management_super(actor uuid,selected uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_authorization.role_grants g WHERE g.id=selected AND g.account_id=actor AND g.role='super_admin'
 AND g.operating_region_id IS NULL AND g.revoked_at IS NULL AND g.valid_from<=clock_timestamp() AND(g.expires_at IS NULL OR g.expires_at>clock_timestamp()))
$$;
CREATE FUNCTION whaleu_authorization.school_admin_management_identity(actor uuid,session uuid,token text)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT whaleu_profile.moderation_identity_current(actor,session,token)
 AND EXISTS(SELECT 1 FROM whaleu_identity.sessions s WHERE s.id=session AND s.account_id=actor AND s.access_expires_at>clock_timestamp())
$$;

CREATE TABLE whaleu_authorization.school_admin_management_commands(
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,
 -- Exact active session is proved at creation/final closure. Keep the UUID as
 -- immutable audit metadata without blocking Identity terminal-session retention.
 session_id uuid NOT NULL,token_hash text NOT NULL,target_profile_id uuid NOT NULL,
 subject_id uuid,actor_grant_id uuid,old_grant_id uuid,new_grant_id uuid,intent_hash text NOT NULL,command jsonb NOT NULL,receipt jsonb NOT NULL,
 identity_hash text NOT NULL DEFAULT '',input_before jsonb,title_before jsonb,before_state_version text,
 creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),PRIMARY KEY(actor_id,request_id),UNIQUE(actor_id,request_id,creation_transaction),
 CHECK(request_id::text~'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 CHECK(octet_length(command::text)<4096 AND octet_length(receipt::text)<4096),
 CHECK(intent_hash=encode(sha256(convert_to('whaleu:school-admin-management-command:v1'||chr(10)||whaleu_community.content_canonical_json(jsonb_build_object('actor',actor_id::text,'command',command)),'UTF8')),'hex'))
);
CREATE INDEX school_admin_management_commands_transaction ON whaleu_authorization.school_admin_management_commands(creation_transaction);
-- A single management command owns the exact permitted role statements in a
-- transaction. Recovery/cancellation can still use the same immutable actor/key.
CREATE UNIQUE INDEX school_admin_management_one_transaction ON whaleu_authorization.school_admin_management_commands(creation_transaction);
CREATE TABLE whaleu_authorization.school_admin_management_statements(
 actor_id uuid NOT NULL,request_id uuid NOT NULL,ordinal integer NOT NULL CHECK(ordinal IN(1,2)),operation text NOT NULL CHECK(operation IN('INSERT','UPDATE')),
 creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),PRIMARY KEY(actor_id,request_id,ordinal),UNIQUE(actor_id,request_id,operation),
 FOREIGN KEY(actor_id,request_id,creation_transaction) REFERENCES whaleu_authorization.school_admin_management_commands(actor_id,request_id,creation_transaction)
);
CREATE TABLE whaleu_authorization.school_admin_management_epochs(
 actor_id uuid NOT NULL,request_id uuid NOT NULL,ordinal integer NOT NULL,before_epoch bigint NOT NULL,after_epoch bigint NOT NULL CHECK(after_epoch=before_epoch+1),
 creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),PRIMARY KEY(actor_id,request_id,ordinal),
 FOREIGN KEY(actor_id,request_id,ordinal) REFERENCES whaleu_authorization.school_admin_management_statements(actor_id,request_id,ordinal)
);
CREATE TABLE whaleu_authorization.school_admin_management_transitions(
 actor_id uuid NOT NULL,request_id uuid NOT NULL,grant_id uuid NOT NULL REFERENCES whaleu_authorization.role_grants(id),operation text NOT NULL CHECK(operation IN('INSERT','UPDATE')),
 before_row jsonb,after_row jsonb NOT NULL,creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),PRIMARY KEY(actor_id,request_id,operation),
 FOREIGN KEY(actor_id,request_id,operation) REFERENCES whaleu_authorization.school_admin_management_statements(actor_id,request_id,operation),
 CHECK((operation='INSERT')=(before_row IS NULL))
);
CREATE TABLE whaleu_authorization.school_admin_assignment_events(
 id uuid PRIMARY KEY,actor_id uuid NOT NULL,request_id uuid NOT NULL,subject_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),target_profile_id uuid NOT NULL,
 actor_grant_id uuid NOT NULL REFERENCES whaleu_authorization.role_grants(id),old_grant_id uuid,new_grant_id uuid,
 action text NOT NULL CHECK(action IN('appoint','reassign','revoke')),outcome text NOT NULL CHECK(outcome IN('applied','unchanged')),
 intent_hash text NOT NULL,expected_state_version text NOT NULL,recorded_at timestamptz NOT NULL,
 creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),UNIQUE(actor_id,request_id),
 FOREIGN KEY(actor_id,request_id,creation_transaction) REFERENCES whaleu_authorization.school_admin_management_commands(actor_id,request_id,creation_transaction),
 FOREIGN KEY(old_grant_id) REFERENCES whaleu_authorization.role_grants(id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(new_grant_id) REFERENCES whaleu_authorization.role_grants(id) DEFERRABLE INITIALLY DEFERRED,
 CHECK(isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at))
);
CREATE TABLE whaleu_experience.school_admin_title_grants(
 actor_id uuid NOT NULL,request_id uuid NOT NULL,owner_id uuid NOT NULL REFERENCES whaleu_experience.owners(owner_id),
 title_key text NOT NULL DEFAULT 'role_admin' CHECK(title_key='role_admin'),creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 PRIMARY KEY(actor_id,request_id),UNIQUE(owner_id,actor_id,request_id,title_key,creation_transaction),
 FOREIGN KEY(actor_id,request_id,creation_transaction) REFERENCES whaleu_authorization.school_admin_management_commands(actor_id,request_id,creation_transaction)
);
CREATE FUNCTION whaleu_authorization.school_admin_management_immutable() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 RAISE EXCEPTION 'School-administrator management evidence is immutable' USING ERRCODE='23514',CONSTRAINT='school_admin_management_causal';
END$$;
DO $$DECLARE relation text;BEGIN
 FOREACH relation IN ARRAY ARRAY['whaleu_authorization.school_admin_management_commands','whaleu_authorization.school_admin_management_statements',
 'whaleu_authorization.school_admin_management_epochs','whaleu_authorization.school_admin_management_transitions','whaleu_authorization.school_admin_assignment_events','whaleu_experience.school_admin_title_grants'] LOOP
 EXECUTE format('CREATE TRIGGER school_admin_management_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION whaleu_authorization.school_admin_management_immutable()',relation);
 END LOOP;
END$$;

CREATE FUNCTION whaleu_authorization.school_admin_management_command_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p record;old_grant record;action text;expected_outcome text;keys text[];instant timestamptz;BEGIN
 action:=NEW.command->>'action';
 keys:=ARRAY['clientRequestId','targetProfileId','expectedStateVersion','action'];
 IF action IN('appoint','reassign') THEN keys:=keys||ARRAY['regionId'];END IF;
 IF current_setting('transaction_isolation')<>'read committed' OR NEW.creation_transaction<>pg_current_xact_id()
 OR whaleu_community.post_owner_visibility_keys(NEW.command,keys) IS DISTINCT FROM true
 OR coalesce(action IN('appoint','reassign','revoke'),false)=false
 OR NEW.command->>'clientRequestId' IS DISTINCT FROM NEW.request_id::text
 OR NEW.command->>'targetProfileId' IS DISTINCT FROM NEW.target_profile_id::text
 OR NOT whaleu_profile.moderation_uuid_valid(NEW.target_profile_id::text)
 OR (jsonb_typeof(NEW.command->'expectedStateVersion')='string' AND NEW.command->>'expectedStateVersion'~'^[a-f0-9]{64}$') IS DISTINCT FROM true
 OR (action<>'revoke' AND (jsonb_typeof(NEW.command->'regionId')='string' AND whaleu_profile.moderation_uuid_valid(NEW.command->>'regionId')) IS DISTINCT FROM true)
 THEN RAISE EXCEPTION 'Strict school-administrator command required' USING ERRCODE='23514',CONSTRAINT='school_admin_management_causal';END IF;
 keys:=ARRAY['requestId','targetProfileId','expectedStateVersion','action','outcome'];
 IF action<>'revoke' THEN keys:=keys||ARRAY['regionId'];END IF;
 keys:=keys||CASE WHEN NEW.receipt->>'outcome'='rejected' THEN ARRAY['code'] ELSE ARRAY['eventId','recordedAt','titleGranted'] END;
 IF whaleu_community.post_owner_visibility_keys(NEW.receipt,keys) IS DISTINCT FROM true
 OR NEW.receipt->>'requestId' IS DISTINCT FROM NEW.request_id::text
 OR (NEW.receipt-ARRAY['requestId','outcome','code','eventId','recordedAt','titleGranted']) IS DISTINCT FROM (NEW.command-'clientRequestId')
 THEN RAISE EXCEPTION 'Receipt must retain the exact public command only' USING ERRCODE='23514',CONSTRAINT='school_admin_management_causal';END IF;
 IF NEW.receipt->>'outcome'='rejected' THEN
  IF coalesce(NEW.receipt->>'code' IN('SCHOOL_ADMIN_MANAGEMENT_CANCELLED','SCHOOL_ADMIN_MANAGEMENT_STALE'),false)=false THEN
   RAISE EXCEPTION 'Unsupported management rejection' USING ERRCODE='23514',CONSTRAINT='school_admin_management_causal';END IF;
 ELSE
  IF coalesce(NEW.receipt->>'outcome' IN('applied','unchanged'),false)=false
  OR (jsonb_typeof(NEW.receipt->'eventId')='string' AND whaleu_profile.moderation_uuid_valid(NEW.receipt->>'eventId')) IS DISTINCT FROM true
  OR jsonb_typeof(NEW.receipt->'titleGranted') IS DISTINCT FROM 'boolean'
  OR (jsonb_typeof(NEW.receipt->'recordedAt')='string' AND NEW.receipt->>'recordedAt'~'^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9][.][0-9]{3}Z$') IS DISTINCT FROM true
  THEN RAISE EXCEPTION 'Exact assignment event receipt required' USING ERRCODE='23514',CONSTRAINT='school_admin_management_causal';END IF;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:school-admin-management-request:v1:'||NEW.actor_id::text||':'||NEW.request_id::text,0));
 -- No source locks are acquired here. Orchestration already locked the exact
 -- actor session/token. Raw SQL still needs the final phantom-safe identity fence.
 IF NOT whaleu_authorization.school_admin_management_identity(NEW.actor_id,NEW.session_id,NEW.token_hash) THEN
  RAISE EXCEPTION 'Current actor identity required' USING ERRCODE='23514',CONSTRAINT='school_admin_management_causal';END IF;
 NEW.identity_hash:=whaleu_profile.moderation_hash(whaleu_profile.moderation_identity_facts(NEW.actor_id,NEW.session_id,NEW.token_hash));
 IF NEW.receipt->>'code'='SCHOOL_ADMIN_MANAGEMENT_CANCELLED' THEN
  IF NEW.subject_id IS NOT NULL OR NEW.actor_grant_id IS NOT NULL OR NEW.old_grant_id IS NOT NULL OR NEW.new_grant_id IS NOT NULL OR NEW.input_before IS NOT NULL THEN
   RAISE EXCEPTION 'Cancellation binds only active identity and immutable intent' USING ERRCODE='23514',CONSTRAINT='school_admin_management_causal';END IF;
  NEW.title_before:=NULL;NEW.before_state_version:=NULL;RETURN NEW;
 END IF;
 SELECT account_id INTO p FROM whaleu_profile.profiles WHERE public_id=NEW.target_profile_id;
 IF p.account_id IS NULL OR NEW.subject_id IS DISTINCT FROM p.account_id
 OR NOT whaleu_authorization.school_admin_management_super(NEW.actor_id,NEW.actor_grant_id)
 OR NEW.input_before IS DISTINCT FROM whaleu_authorization.school_admin_management_input_facts(NEW.actor_id,NULL,NEW.target_profile_id,action<>'revoke')
 OR NEW.input_before->>'epoch' IS NULL
 OR EXISTS(SELECT 1 FROM whaleu_authorization.role_grants WHERE account_id=NEW.subject_id AND role IN('super_admin','developer') AND revoked_at IS NULL)
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.input_before->'actor_grants') v WHERE v->0->>'id'=NEW.actor_grant_id::text AND v->0->>'role'='super_admin')
 THEN RAISE EXCEPTION 'Exact original super authority and supported target role set required' USING ERRCODE='23514',CONSTRAINT='school_admin_management_causal';END IF;
 SELECT * INTO old_grant FROM whaleu_authorization.role_grants WHERE account_id=NEW.subject_id AND role='school_admin' AND revoked_at IS NULL;
 IF NEW.old_grant_id IS DISTINCT FROM old_grant.id THEN
  RAISE EXCEPTION 'Original unrevoked school assignment required, including future or expired rows' USING ERRCODE='23514',CONSTRAINT='school_admin_management_causal';END IF;
 NEW.before_state_version:=whaleu_authorization.school_admin_management_state_version(NEW.target_profile_id);
 IF NEW.receipt->>'code'='SCHOOL_ADMIN_MANAGEMENT_STALE' THEN
  IF NEW.before_state_version IS NOT DISTINCT FROM NEW.command->>'expectedStateVersion' OR NEW.new_grant_id IS NOT NULL THEN
   RAISE EXCEPTION 'Stale rejection must be exact and read-only' USING ERRCODE='23514',CONSTRAINT='school_admin_management_causal';END IF;
  NEW.title_before:=NULL;RETURN NEW;
 END IF;
 instant:=clock_timestamp();
 IF (NEW.receipt->>'recordedAt')::timestamptz>instant
 OR (NEW.receipt->>'recordedAt')::timestamptz<date_trunc('milliseconds',transaction_timestamp())
 OR NEW.before_state_version IS DISTINCT FROM NEW.command->>'expectedStateVersion'
 THEN RAISE EXCEPTION 'Current state CAS and database transaction event time required' USING ERRCODE='23514',CONSTRAINT='school_admin_management_causal';END IF;
 IF action='revoke' THEN
  expected_outcome:=CASE WHEN old_grant.id IS NULL THEN 'unchanged' ELSE 'applied' END;
  IF NEW.new_grant_id IS NOT NULL OR NEW.receipt->'titleGranted' IS DISTINCT FROM 'false'::jsonb THEN
   RAISE EXCEPTION 'Revocation changes only the exact school grant' USING ERRCODE='23514',CONSTRAINT='school_admin_management_causal';END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM whaleu_identity.accounts WHERE id=NEW.subject_id AND status='active')
  OR NOT whaleu_authorization.school_admin_region_allowed(NEW.subject_id,(NEW.command->>'regionId')::uuid)
  OR NOT EXISTS(SELECT 1 FROM whaleu_experience.title_catalog WHERE title_key='role_admin' AND kind='special' AND name='管理员' AND unlock_level IS NULL)
  THEN RAISE EXCEPTION 'Current active target and accepted eligible region required' USING ERRCODE='23514',CONSTRAINT='school_admin_management_causal';END IF;
  IF action='appoint' AND old_grant.id IS NOT NULL AND
   (old_grant.operating_region_id::text IS DISTINCT FROM NEW.command->>'regionId' OR old_grant.valid_from>instant OR(old_grant.expires_at IS NOT NULL AND old_grant.expires_at<=instant)) THEN
   RAISE EXCEPTION 'Existing different or noncurrent assignment requires explicit reassignment' USING ERRCODE='23514',CONSTRAINT='school_admin_management_causal';END IF;
  IF action='reassign' AND old_grant.id IS NULL THEN
   RAISE EXCEPTION 'Reassignment requires an exact previous assignment' USING ERRCODE='23514',CONSTRAINT='school_admin_management_causal';END IF;
  expected_outcome:=CASE WHEN old_grant.id IS NOT NULL AND old_grant.operating_region_id::text=NEW.command->>'regionId'
   AND old_grant.valid_from<=instant AND(old_grant.expires_at IS NULL OR old_grant.expires_at>instant) THEN 'unchanged' ELSE 'applied' END;
  IF (expected_outcome='applied') IS DISTINCT FROM (NEW.new_grant_id IS NOT NULL) OR NEW.new_grant_id=NEW.old_grant_id
  OR(NEW.new_grant_id IS NOT NULL AND EXISTS(SELECT 1 FROM whaleu_authorization.role_grants WHERE id=NEW.new_grant_id)) THEN
   RAISE EXCEPTION 'Fresh replacement grant identity required exactly when assignment changes' USING ERRCODE='23514',CONSTRAINT='school_admin_management_causal';END IF;
 END IF;
 IF NEW.receipt->>'outcome' IS DISTINCT FROM expected_outcome THEN
  RAISE EXCEPTION 'Claimed assignment outcome disagrees with the actual initial state' USING ERRCODE='23514',CONSTRAINT='school_admin_management_causal';END IF;
 NEW.title_before:=NULL;
 IF action<>'revoke' THEN
  SELECT jsonb_build_array(to_jsonb(e),e.xmin::text,e.ctid::text) INTO NEW.title_before FROM whaleu_experience.entitlements e WHERE e.owner_id=NEW.subject_id AND e.title_key='role_admin';
 END IF;
 IF action<>'revoke' AND NEW.receipt->'titleGranted' IS DISTINCT FROM to_jsonb(NEW.title_before IS NULL) THEN
  RAISE EXCEPTION 'Title obligation is exactly the initially missing administrator entitlement' USING ERRCODE='23514',CONSTRAINT='school_admin_management_causal';END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER school_admin_management_command_guard BEFORE INSERT ON whaleu_authorization.school_admin_management_commands FOR EACH ROW EXECUTE FUNCTION whaleu_authorization.school_admin_management_command_guard();
CREATE FUNCTION whaleu_authorization.school_admin_management_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_authorization.school_admin_management_commands;BEGIN
 SELECT * INTO q FROM whaleu_authorization.school_admin_management_commands WHERE actor_id=NEW.actor_id AND request_id=NEW.request_id;
 IF q.creation_transaction IS DISTINCT FROM pg_current_xact_id() OR NEW.creation_transaction<>pg_current_xact_id()
 OR q.receipt->>'outcome' NOT IN('applied','unchanged') OR q.receipt->>'eventId' IS DISTINCT FROM NEW.id::text
 OR (NEW.subject_id,NEW.target_profile_id,NEW.actor_grant_id,NEW.old_grant_id,NEW.new_grant_id,NEW.action,NEW.outcome,NEW.intent_hash,NEW.expected_state_version,NEW.recorded_at)
 IS DISTINCT FROM(q.subject_id,q.target_profile_id,q.actor_grant_id,q.old_grant_id,q.new_grant_id,q.command->>'action',q.receipt->>'outcome',q.intent_hash,q.command->>'expectedStateVersion',(q.receipt->>'recordedAt')::timestamptz)
 THEN RAISE EXCEPTION 'Assignment event requires this exact immutable command' USING ERRCODE='23514',CONSTRAINT='school_admin_management_causal';END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER school_admin_management_event_guard BEFORE INSERT ON whaleu_authorization.school_admin_assignment_events FOR EACH ROW EXECUTE FUNCTION whaleu_authorization.school_admin_management_event_guard();
CREATE FUNCTION whaleu_authorization.school_admin_management_record_event() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.receipt->>'outcome' IN('applied','unchanged') THEN
  INSERT INTO whaleu_authorization.school_admin_assignment_events(id,actor_id,request_id,subject_id,target_profile_id,actor_grant_id,old_grant_id,new_grant_id,action,outcome,intent_hash,expected_state_version,recorded_at)
  VALUES((NEW.receipt->>'eventId')::uuid,NEW.actor_id,NEW.request_id,NEW.subject_id,NEW.target_profile_id,NEW.actor_grant_id,NEW.old_grant_id,NEW.new_grant_id,NEW.command->>'action',NEW.receipt->>'outcome',NEW.intent_hash,NEW.command->>'expectedStateVersion',(NEW.receipt->>'recordedAt')::timestamptz);
 END IF;RETURN NULL;
END$$;
CREATE TRIGGER school_admin_management_record_event AFTER INSERT ON whaleu_authorization.school_admin_management_commands FOR EACH ROW EXECUTE FUNCTION whaleu_authorization.school_admin_management_record_event();

CREATE FUNCTION whaleu_authorization.school_admin_management_nested_evidence() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF pg_trigger_depth()<2 OR NEW.creation_transaction<>pg_current_xact_id() THEN
  RAISE EXCEPTION 'Evidence may be issued only by a real grant mutation' USING ERRCODE='23514',CONSTRAINT='school_admin_management_causal';END IF;RETURN NEW;
END$$;
DO $$DECLARE name text;BEGIN FOREACH name IN ARRAY ARRAY['statements','epochs','transitions'] LOOP
 EXECUTE format('CREATE TRIGGER school_admin_management_nested_evidence BEFORE INSERT ON whaleu_authorization.%I FOR EACH ROW EXECUTE FUNCTION whaleu_authorization.school_admin_management_nested_evidence()','school_admin_management_'||name);
END LOOP;END$$;
CREATE FUNCTION whaleu_authorization.school_admin_management_source_statement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_authorization.school_admin_management_commands;ordinal integer;BEGIN
 FOR q IN SELECT * FROM whaleu_authorization.school_admin_management_commands WHERE creation_transaction=pg_current_xact_id() LOOP
  IF TG_TABLE_SCHEMA='whaleu_authorization' AND TG_TABLE_NAME='role_grants' AND q.receipt->>'outcome'='applied' THEN
   IF(TG_OP='UPDATE' AND q.old_grant_id IS NOT NULL) OR(TG_OP='INSERT' AND q.new_grant_id IS NOT NULL) THEN
    SELECT count(*)+1 INTO ordinal FROM whaleu_authorization.school_admin_management_statements s WHERE(s.actor_id,s.request_id)=(q.actor_id,q.request_id);
    IF TG_OP='INSERT' AND q.old_grant_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM whaleu_authorization.school_admin_management_transitions t WHERE(t.actor_id,t.request_id,t.operation)=(q.actor_id,q.request_id,'UPDATE')) THEN
     RAISE EXCEPTION 'Replacement follows the exact old revocation' USING ERRCODE='23514',CONSTRAINT='school_admin_management_causal';END IF;
    INSERT INTO whaleu_authorization.school_admin_management_statements(actor_id,request_id,ordinal,operation) VALUES(q.actor_id,q.request_id,ordinal,TG_OP);
    CONTINUE;
   END IF;
  ELSIF TG_TABLE_SCHEMA='whaleu_majors' AND TG_TABLE_NAME='major_delete_authority_epoch' AND TG_OP='UPDATE' AND pg_trigger_depth()>=2
   AND EXISTS(SELECT 1 FROM whaleu_authorization.school_admin_management_statements s WHERE(s.actor_id,s.request_id)=(q.actor_id,q.request_id) AND NOT EXISTS(SELECT 1 FROM whaleu_authorization.school_admin_management_epochs e WHERE(e.actor_id,e.request_id,e.ordinal)=(s.actor_id,s.request_id,s.ordinal))) THEN
   CONTINUE;
  ELSIF TG_TABLE_SCHEMA='whaleu_experience' AND TG_TABLE_NAME IN('owners','entitlements') AND TG_OP='INSERT'
   AND q.receipt->>'outcome' IN('applied','unchanged') AND q.command->>'action'<>'revoke' THEN
   CONTINUE;
  END IF;
  RAISE EXCEPTION 'Management may change only its exact role statements and optional title ownership' USING ERRCODE='23514',CONSTRAINT='school_admin_management_causal';
 END LOOP;RETURN NULL;
END$$;
-- No new early grant gate is installed. Raw writers that did not cooperate with
-- the outer gate are detected by the exact observations and final table fences.
CREATE TRIGGER a00_school_admin_management_source BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_authorization.role_grants FOR EACH STATEMENT EXECUTE FUNCTION whaleu_authorization.school_admin_management_source_statement_guard();
CREATE TRIGGER a00_school_admin_management_source BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_majors.major_delete_authority_epoch FOR EACH STATEMENT EXECUTE FUNCTION whaleu_authorization.school_admin_management_source_statement_guard();
CREATE FUNCTION whaleu_authorization.school_admin_management_grant_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_authorization.school_admin_management_commands;original jsonb;BEGIN
 SELECT * INTO q FROM whaleu_authorization.school_admin_management_commands WHERE creation_transaction=pg_current_xact_id();
 IF q.request_id IS NULL THEN
  -- The established synthetic-only fixture path remains test-local. A product
  -- marker can never be seeded without its causal command, even in that database.
  IF (TG_OP='INSERT' AND NEW.role='school_admin') OR(TG_OP='UPDATE' AND OLD.role='school_admin' AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
   IF NOT whaleu_experience.synthetic_fixture_allowed() OR NEW.approval_reference LIKE 'school-admin-management:%' THEN
    RAISE EXCEPTION 'Product school grants require an exact management command' USING ERRCODE='23514',CONSTRAINT='school_admin_management_causal';END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
 END IF;
 IF q.receipt->>'outcome' IS DISTINCT FROM 'applied' THEN
  RAISE EXCEPTION 'Unchanged or rejected command cannot write role rows' USING ERRCODE='23514',CONSTRAINT='school_admin_management_causal';END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.id IS DISTINCT FROM q.new_grant_id OR NEW.account_id IS DISTINCT FROM q.subject_id OR NEW.role<>'school_admin'
  OR NEW.operating_region_id::text IS DISTINCT FROM q.command->>'regionId' OR NEW.approved_by_account_id IS DISTINCT FROM q.actor_id
  OR NEW.approval_reference IS DISTINCT FROM 'school-admin-management:'||q.actor_id::text||':'||q.request_id::text
  OR NEW.expires_at IS NOT NULL OR NEW.revoked_at IS NOT NULL OR NEW.revoked_by_account_id IS NOT NULL
  THEN RAISE EXCEPTION 'Only the exact approved school grant may be inserted' USING ERRCODE='23514',CONSTRAINT='school_admin_management_causal';END IF;
  NEW.created_at:=(q.receipt->>'recordedAt')::timestamptz;NEW.valid_from:=NEW.created_at;
 ELSIF TG_OP='UPDATE' THEN
  SELECT v INTO original FROM jsonb_array_elements(q.input_before->'target_grants') v WHERE v->0->>'id'=q.old_grant_id::text;
  IF OLD.id IS DISTINCT FROM q.old_grant_id OR OLD.account_id IS DISTINCT FROM q.subject_id OR OLD.role<>'school_admin' OR OLD.revoked_at IS NOT NULL
  OR original IS DISTINCT FROM jsonb_build_array(to_jsonb(OLD),OLD.xmin::text,OLD.ctid::text)
  OR (to_jsonb(NEW)-ARRAY['revoked_at','revoked_by_account_id']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['revoked_at','revoked_by_account_id'])
  OR NEW.revoked_at IS DISTINCT FROM(q.receipt->>'recordedAt')::timestamptz OR NEW.revoked_by_account_id IS DISTINCT FROM q.actor_id
  THEN RAISE EXCEPTION 'Only the exact original unrevoked row may be revoked once' USING ERRCODE='23514',CONSTRAINT='school_admin_management_causal';END IF;
 ELSE RAISE EXCEPTION 'Management cannot delete grant history' USING ERRCODE='23514',CONSTRAINT='school_admin_management_causal';END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER a00_school_admin_management_grant BEFORE INSERT OR UPDATE OR DELETE ON whaleu_authorization.role_grants FOR EACH ROW EXECUTE FUNCTION whaleu_authorization.school_admin_management_grant_guard();
CREATE FUNCTION whaleu_authorization.school_admin_management_capture_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_authorization.school_admin_management_commands;before_value jsonb;BEGIN
 SELECT * INTO q FROM whaleu_authorization.school_admin_management_commands WHERE creation_transaction=pg_current_xact_id();
 IF q.request_id IS NULL THEN RETURN NULL;END IF;
 IF TG_OP='UPDATE' THEN before_value:=jsonb_build_array(to_jsonb(OLD),OLD.xmin::text,OLD.ctid::text);END IF;
 INSERT INTO whaleu_authorization.school_admin_management_transitions(actor_id,request_id,grant_id,operation,before_row,after_row)
 VALUES(q.actor_id,q.request_id,NEW.id,TG_OP,before_value,jsonb_build_array(to_jsonb(NEW),NEW.xmin::text,NEW.ctid::text));
 RETURN NULL;
END$$;
CREATE TRIGGER school_admin_management_capture_transition AFTER INSERT OR UPDATE ON whaleu_authorization.role_grants FOR EACH ROW EXECUTE FUNCTION whaleu_authorization.school_admin_management_capture_transition();
CREATE FUNCTION whaleu_authorization.school_admin_management_capture_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_authorization.school_admin_management_commands;statement_row record;expected_epoch bigint;BEGIN
 SELECT * INTO q FROM whaleu_authorization.school_admin_management_commands WHERE creation_transaction=pg_current_xact_id();
 IF q.request_id IS NULL THEN RETURN NULL;END IF;
 SELECT s.* INTO statement_row FROM whaleu_authorization.school_admin_management_statements s WHERE(s.actor_id,s.request_id)=(q.actor_id,q.request_id)
 AND NOT EXISTS(SELECT 1 FROM whaleu_authorization.school_admin_management_epochs e WHERE(e.actor_id,e.request_id,e.ordinal)=(s.actor_id,s.request_id,s.ordinal)) ORDER BY s.ordinal DESC LIMIT 1;
 SELECT coalesce(max(after_epoch),(q.input_before->>'epoch')::bigint) INTO expected_epoch FROM whaleu_authorization.school_admin_management_epochs WHERE(actor_id,request_id)=(q.actor_id,q.request_id);
 IF pg_trigger_depth()<2 OR statement_row.ordinal IS NULL OR OLD.singleton IS DISTINCT FROM true OR NEW.singleton IS DISTINCT FROM true
 OR OLD.revision IS DISTINCT FROM expected_epoch OR NEW.revision<>OLD.revision+1
 OR NOT EXISTS(SELECT 1 FROM whaleu_authorization.school_admin_management_transitions t WHERE(t.actor_id,t.request_id,t.operation)=(q.actor_id,q.request_id,statement_row.operation))
 THEN RAISE EXCEPTION 'Only an actual exact grant statement may advance the authority epoch' USING ERRCODE='23514',CONSTRAINT='school_admin_management_causal';END IF;
 INSERT INTO whaleu_authorization.school_admin_management_epochs(actor_id,request_id,ordinal,before_epoch,after_epoch)
 VALUES(q.actor_id,q.request_id,statement_row.ordinal,OLD.revision,NEW.revision);RETURN NULL;
END$$;
CREATE TRIGGER school_admin_management_capture_epoch AFTER UPDATE ON whaleu_majors.major_delete_authority_epoch FOR EACH ROW EXECUTE FUNCTION whaleu_authorization.school_admin_management_capture_epoch();

CREATE FUNCTION whaleu_authorization.school_admin_management_inputs_current(actor uuid,selected uuid,target uuid,expected jsonb,request uuid DEFAULT NULL,include_eligibility boolean DEFAULT true)
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE facts jsonb;q whaleu_authorization.school_admin_management_commands;roles jsonb;last_epoch bigint;transition_count integer;statement_count integer;epoch_count integer;BEGIN
 facts:=whaleu_authorization.school_admin_management_input_facts(actor,selected,target,include_eligibility);
 IF facts IS NOT DISTINCT FROM expected THEN RETURN true;END IF;
 IF request IS NULL OR expected IS NULL THEN RETURN false;END IF;
 SELECT * INTO q FROM whaleu_authorization.school_admin_management_commands c WHERE c.actor_id=actor AND c.request_id=request AND c.target_profile_id=target
 AND c.creation_transaction=pg_current_xact_id() AND c.receipt->>'outcome'='applied';
 IF q.request_id IS NULL OR expected->'target_grants' IS DISTINCT FROM q.input_before->'target_grants'
 OR expected->'actor_grants' IS DISTINCT FROM q.input_before->'actor_grants' OR expected->'epoch' IS DISTINCT FROM q.input_before->'epoch'
 OR facts->'fixed' IS DISTINCT FROM expected->'fixed' OR facts->'actor_grants' IS DISTINCT FROM expected->'actor_grants'
 OR facts->'selected' IS DISTINCT FROM expected->'selected'
 OR expected->'assignment_regions' IS DISTINCT FROM q.input_before->'assignment_regions'
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(expected->'assignment_regions') original
  WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(facts->'assignment_regions') current_region WHERE current_region=original))
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(facts->'assignment_regions') current_region
  WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(expected->'assignment_regions') original WHERE original=current_region)
  AND NOT(q.new_grant_id IS NOT NULL AND include_eligibility AND current_region->0->>'id'=q.command->>'regionId'
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(expected->'assignment_regions') original WHERE original->0->>'id'=q.command->>'regionId')))
 THEN RETURN false;END IF;
 SELECT count(*) INTO transition_count FROM whaleu_authorization.school_admin_management_transitions WHERE(actor_id,request_id)=(q.actor_id,q.request_id);
 SELECT count(*) INTO statement_count FROM whaleu_authorization.school_admin_management_statements WHERE(actor_id,request_id)=(q.actor_id,q.request_id);
 SELECT count(*),max(after_epoch) INTO epoch_count,last_epoch FROM whaleu_authorization.school_admin_management_epochs WHERE(actor_id,request_id)=(q.actor_id,q.request_id);
 IF transition_count<>(CASE WHEN q.old_grant_id IS NOT NULL THEN 1 ELSE 0 END)+(CASE WHEN q.new_grant_id IS NOT NULL THEN 1 ELSE 0 END)
 OR statement_count<>transition_count OR epoch_count<>transition_count OR last_epoch IS DISTINCT FROM (expected->>'epoch')::bigint+transition_count
 OR facts->>'epoch' IS DISTINCT FROM last_epoch::text
 OR EXISTS(SELECT 1 FROM whaleu_authorization.school_admin_management_epochs e WHERE(e.actor_id,e.request_id)=(q.actor_id,q.request_id)
  AND(e.creation_transaction<>pg_current_xact_id() OR e.before_epoch<>(expected->>'epoch')::bigint+e.ordinal-1 OR e.after_epoch<>e.before_epoch+1))
 OR EXISTS(SELECT 1 FROM whaleu_authorization.school_admin_management_transitions t WHERE(t.actor_id,t.request_id)=(q.actor_id,q.request_id)
  AND(t.creation_transaction<>pg_current_xact_id() OR
   (t.operation='UPDATE' AND(t.grant_id IS DISTINCT FROM q.old_grant_id OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(expected->'target_grants') v WHERE v=t.before_row))) OR
   (t.operation='INSERT' AND(t.grant_id IS DISTINCT FROM q.new_grant_id OR t.before_row IS NOT NULL)))) THEN RETURN false;END IF;
 SELECT coalesce(jsonb_agg(v ORDER BY v->0->>'id'),'[]'::jsonb) INTO roles FROM(
  SELECT coalesce((SELECT t.after_row FROM whaleu_authorization.school_admin_management_transitions t WHERE(t.actor_id,t.request_id,t.operation)=(q.actor_id,q.request_id,'UPDATE') AND t.before_row=v),v) v
  FROM jsonb_array_elements(expected->'target_grants') v
  UNION ALL SELECT t.after_row FROM whaleu_authorization.school_admin_management_transitions t WHERE(t.actor_id,t.request_id,t.operation)=(q.actor_id,q.request_id,'INSERT')) transformed;
 RETURN facts->'target_grants' IS NOT DISTINCT FROM roles;
END$$;
CREATE FUNCTION whaleu_experience.school_admin_title_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_authorization.school_admin_management_commands;BEGIN
 SELECT * INTO q FROM whaleu_authorization.school_admin_management_commands WHERE actor_id=NEW.actor_id AND request_id=NEW.request_id;
 IF q.request_id IS NULL OR q.creation_transaction<>pg_current_xact_id() OR NEW.creation_transaction<>pg_current_xact_id()
 OR q.receipt->>'outcome' NOT IN('applied','unchanged') OR q.command->>'action' NOT IN('appoint','reassign')
 OR q.receipt->'titleGranted' IS DISTINCT FROM 'true'::jsonb OR q.title_before IS NOT NULL OR NEW.owner_id IS DISTINCT FROM q.subject_id OR NEW.title_key<>'role_admin'
 OR NOT EXISTS(SELECT 1 FROM whaleu_authorization.school_admin_assignment_events e WHERE(e.actor_id,e.request_id,e.creation_transaction)=(q.actor_id,q.request_id,pg_current_xact_id()))
 OR NOT EXISTS(SELECT 1 FROM whaleu_authorization.role_grants g WHERE g.id=coalesce(q.new_grant_id,q.old_grant_id) AND g.account_id=NEW.owner_id AND g.role='school_admin'
  AND g.revoked_at IS NULL AND g.operating_region_id::text=q.command->>'regionId' AND g.valid_from<=clock_timestamp() AND(g.expires_at IS NULL OR g.expires_at>clock_timestamp()))
 THEN RAISE EXCEPTION 'Administrator title requires an exact live appointment obligation' USING ERRCODE='23514',CONSTRAINT='school_admin_management_causal';END IF;
 -- This is the terminal owner lock, normally a reacquisition. No source row
 -- locks may follow it; source checks at finalization only use NOWAIT fences.
 PERFORM owner_id FROM whaleu_experience.owners WHERE owner_id=NEW.owner_id FOR UPDATE;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM whaleu_experience.entitlements WHERE owner_id=NEW.owner_id AND title_key='role_admin') THEN
  RAISE EXCEPTION 'Administrator title proof requires locked ownership and a missing title' USING ERRCODE='23514',CONSTRAINT='school_admin_management_causal';END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER school_admin_title_guard BEFORE INSERT ON whaleu_experience.school_admin_title_grants FOR EACH ROW EXECUTE FUNCTION whaleu_experience.school_admin_title_guard();
ALTER TABLE whaleu_experience.entitlements DROP CONSTRAINT entitlements_origin_check;
ALTER TABLE whaleu_experience.entitlements ADD CONSTRAINT entitlements_origin_check CHECK(origin IN('registration','level','synthetic_fixture','redemption','maintenance','school_admin_appointment'));
ALTER TABLE whaleu_experience.entitlements ADD COLUMN school_admin_actor_id uuid;
ALTER TABLE whaleu_experience.entitlements ADD COLUMN school_admin_request_id uuid;
ALTER TABLE whaleu_experience.entitlements DROP CONSTRAINT redemption_origin;
ALTER TABLE whaleu_experience.entitlements ADD CONSTRAINT redemption_origin CHECK((origin='redemption')=(redemption_request_id IS NOT NULL) AND(origin IN('redemption','maintenance','school_admin_appointment'))=(creation_transaction IS NOT NULL));
ALTER TABLE whaleu_experience.entitlements ADD CONSTRAINT school_admin_origin CHECK((origin='school_admin_appointment')=(school_admin_actor_id IS NOT NULL) AND(origin='school_admin_appointment')=(school_admin_request_id IS NOT NULL));
ALTER TABLE whaleu_experience.entitlements ADD CONSTRAINT school_admin_title_proof FOREIGN KEY(owner_id,school_admin_actor_id,school_admin_request_id,title_key,creation_transaction)
 REFERENCES whaleu_experience.school_admin_title_grants(owner_id,actor_id,request_id,title_key,creation_transaction);

-- Preserve all existing registration, level, fixture, redemption and maintenance branches.
CREATE OR REPLACE FUNCTION whaleu_experience.projection_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s whaleu_experience.settlements; threshold_value bigint;
BEGIN
  IF NEW.origin='synthetic_fixture' THEN
    IF NOT whaleu_experience.synthetic_fixture_allowed() THEN RAISE EXCEPTION 'Synthetic fixture is local test only' USING ERRCODE='23514'; END IF;
  ELSIF TG_TABLE_NAME='records' THEN
    SELECT * INTO s FROM whaleu_experience.settlements WHERE id=NEW.settlement_id;
    IF s.id IS NULL OR (NEW.nominal_delta,NEW.applied_delta,NEW.balance_after,NEW.applied_at,NEW.outcome) IS DISTINCT FROM (s.nominal_delta,s.applied_delta,s.balance_after,s.applied_at,s.outcome) THEN RAISE EXCEPTION 'Record disagrees with settlement' USING ERRCODE='23514'; END IF;
  ELSIF NEW.origin='redemption' THEN
    IF NOT EXISTS(SELECT 1 FROM whaleu_experience.redemption_decisions d JOIN whaleu_experience.title_catalog t ON t.title_key=d.title_key
      WHERE d.owner_id=NEW.owner_id AND d.request_id=NEW.redemption_request_id AND d.title_key=NEW.title_key AND d.outcome='granted'
      AND d.creation_transaction=pg_current_xact_id() AND NEW.earned_at=d.decided_at AND t.kind='limited' AND t.title_key='redeem_liangchenmeijing') THEN
      RAISE EXCEPTION 'Redemption entitlement lacks current decision' USING ERRCODE='23514';
    END IF;
    NEW.creation_transaction:=pg_current_xact_id();
  ELSIF NEW.origin='maintenance' THEN
    IF NOT EXISTS(SELECT 1 FROM whaleu_experience.maintenance_grants g
      JOIN whaleu_experience.maintenance_items i USING(actor_id,request_id,owner_id,creation_transaction)
      JOIN whaleu_experience.maintenance_requests r USING(actor_id,request_id,creation_transaction)
      JOIN whaleu_experience.title_catalog t ON t.title_key=g.title_key
      WHERE g.owner_id=NEW.owner_id AND g.actor_id=NEW.maintenance_actor_id AND g.request_id=NEW.maintenance_request_id AND g.title_key=NEW.title_key AND
      g.creation_transaction=pg_current_xact_id() AND i.outcome='repaired' AND NEW.earned_at=i.decided_at AND
      ((r.operation='repair_default_title' AND i.eligible AND t.title_key='default_jingxiaoyu' AND t.kind='default') OR
       (r.operation='repair_level_titles' AND i.eligible AND t.kind='level' AND t.unlock_level<=i.observed_level))) THEN
      RAISE EXCEPTION 'Maintenance entitlement lacks this transaction allowed title proof' USING ERRCODE='23514';
    END IF;
    NEW.creation_transaction:=pg_current_xact_id();
  ELSIF NEW.origin='school_admin_appointment' THEN
    IF NEW.title_key<>'role_admin' OR NOT EXISTS(SELECT 1 FROM whaleu_experience.school_admin_title_grants g
      JOIN whaleu_authorization.school_admin_management_commands q USING(actor_id,request_id,creation_transaction)
      JOIN whaleu_experience.title_catalog t ON t.title_key=g.title_key
      WHERE g.owner_id=NEW.owner_id AND g.actor_id=NEW.school_admin_actor_id AND g.request_id=NEW.school_admin_request_id
      AND g.title_key=NEW.title_key AND g.creation_transaction=pg_current_xact_id() AND q.subject_id=g.owner_id
      AND q.command->>'action' IN('appoint','reassign') AND q.receipt->>'outcome' IN('applied','unchanged')
      AND q.receipt->'titleGranted'='true'::jsonb AND NEW.earned_at=(q.receipt->>'recordedAt')::timestamptz
      AND t.kind='special' AND t.name='管理员' AND t.unlock_level IS NULL) THEN
      RAISE EXCEPTION 'Administrator entitlement lacks this transaction exact appointment proof' USING ERRCODE='23514',CONSTRAINT='school_admin_management_causal';
    END IF;
    NEW.creation_transaction:=pg_current_xact_id();
  ELSIF NEW.origin='registration' THEN
    IF NEW.title_key NOT IN ('default_jingxiaoyu','level_1') OR NEW.earned_at IS NULL OR NOT EXISTS(SELECT 1 FROM whaleu_experience.baselines b JOIN whaleu_identity.accounts a ON a.id=b.owner_id WHERE b.owner_id=NEW.owner_id AND b.origin='native_account_creation' AND a.local_creation_transaction=pg_current_xact_id()) THEN RAISE EXCEPTION 'Registration grant requires new account provenance' USING ERRCODE='23514'; END IF;
  ELSIF NEW.origin='level' THEN
    SELECT l.threshold INTO threshold_value FROM whaleu_experience.title_catalog t JOIN whaleu_experience.level_catalog l ON l.level=t.unlock_level WHERE t.title_key=NEW.title_key AND t.kind='level';
    SELECT * INTO s FROM whaleu_experience.settlements WHERE id=NEW.settlement_id AND owner_id=NEW.owner_id;
    IF threshold_value IS NULL OR s.id IS NULL OR s.balance_after<threshold_value OR NEW.earned_at IS DISTINCT FROM s.applied_at THEN RAISE EXCEPTION 'Level grant lacks earned proof' USING ERRCODE='23514'; END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported experience projection origin' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION whaleu_authorization.school_admin_management_experience_row_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_authorization.school_admin_management_commands;BEGIN
 SELECT * INTO q FROM whaleu_authorization.school_admin_management_commands WHERE creation_transaction=pg_current_xact_id();
 IF q.request_id IS NULL THEN RETURN NEW;END IF;
 IF TG_TABLE_NAME='owners' THEN
  IF NEW.owner_id IS DISTINCT FROM q.subject_id THEN RAISE EXCEPTION 'Only the target experience owner may be created' USING ERRCODE='23514',CONSTRAINT='school_admin_management_causal';END IF;
 ELSE
  IF NEW.owner_id IS DISTINCT FROM q.subject_id OR NEW.title_key<>'role_admin' OR NEW.origin<>'school_admin_appointment'
  OR NEW.school_admin_actor_id IS DISTINCT FROM q.actor_id OR NEW.school_admin_request_id IS DISTINCT FROM q.request_id
  OR q.receipt->'titleGranted' IS DISTINCT FROM 'true'::jsonb THEN
   RAISE EXCEPTION 'Only the exact administrator entitlement may be created' USING ERRCODE='23514',CONSTRAINT='school_admin_management_causal';END IF;
 END IF;RETURN NEW;
END$$;
CREATE TRIGGER a00_school_admin_management_owner BEFORE INSERT ON whaleu_experience.owners FOR EACH ROW EXECUTE FUNCTION whaleu_authorization.school_admin_management_experience_row_guard();
CREATE TRIGGER a00_school_admin_management_entitlement BEFORE INSERT ON whaleu_experience.entitlements FOR EACH ROW EXECUTE FUNCTION whaleu_authorization.school_admin_management_experience_row_guard();

CREATE FUNCTION whaleu_authorization.school_admin_management_assert_complete(q whaleu_authorization.school_admin_management_commands)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE e record;title_value jsonb;expected_count integer;actual_count integer;BEGIN
 IF current_setting('transaction_isolation')<>'read committed' OR q.creation_transaction IS DISTINCT FROM pg_current_xact_id() THEN
  RAISE EXCEPTION 'Management closure requires its original read-committed transaction' USING ERRCODE='23514',CONSTRAINT='school_admin_management_causal';END IF;
 -- Recovery and cancellation intentionally never open unrelated source tables.
 LOCK TABLE whaleu_identity.accounts,whaleu_identity.sessions,whaleu_identity.access_tokens IN SHARE MODE NOWAIT;
 IF NOT whaleu_authorization.school_admin_management_identity(q.actor_id,q.session_id,q.token_hash)
 OR q.identity_hash IS DISTINCT FROM whaleu_profile.moderation_hash(whaleu_profile.moderation_identity_facts(q.actor_id,q.session_id,q.token_hash)) THEN
  RAISE EXCEPTION 'Original active account, session and presented token required' USING ERRCODE='23514',CONSTRAINT='school_admin_management_causal';END IF;
 IF q.receipt->>'code'='SCHOOL_ADMIN_MANAGEMENT_CANCELLED' THEN
  IF q.subject_id IS NOT NULL OR q.actor_grant_id IS NOT NULL OR q.old_grant_id IS NOT NULL OR q.new_grant_id IS NOT NULL OR q.input_before IS NOT NULL
  OR EXISTS(SELECT 1 FROM whaleu_authorization.school_admin_assignment_events WHERE(actor_id,request_id)=(q.actor_id,q.request_id))
  OR EXISTS(SELECT 1 FROM whaleu_authorization.school_admin_management_statements WHERE(actor_id,request_id)=(q.actor_id,q.request_id))
  THEN RAISE EXCEPTION 'Cancellation cannot issue assignment, mutation or title evidence' USING ERRCODE='23514',CONSTRAINT='school_admin_management_causal';END IF;
  -- Title proof INSERT requires an applied/unchanged command, so cancellation
  -- does not touch Experience even to prove an already-enforced absence.
  RETURN;
 END IF;
 LOCK TABLE whaleu_profile.profiles,whaleu_authorization.role_grants,whaleu_majors.major_delete_authority_epoch,whaleu_campus.operating_regions IN SHARE MODE NOWAIT;
 IF q.command->>'action'<>'revoke' THEN
  LOCK TABLE whaleu_verification.account_heads,whaleu_verification.snapshots,whaleu_verification.assertions,
  whaleu_campus.community_topology_heads,whaleu_campus.community_topology_snapshots,whaleu_campus.institutions,whaleu_campus.campuses,
  whaleu_campus.campus_region_assignments,whaleu_experience.title_catalog IN SHARE MODE NOWAIT;
 END IF;
 IF NOT whaleu_authorization.school_admin_management_super(q.actor_id,q.actor_grant_id)
 OR NOT whaleu_authorization.school_admin_management_inputs_current(q.actor_id,NULL,q.target_profile_id,q.input_before,q.request_id,q.command->>'action'<>'revoke')
 OR EXISTS(SELECT 1 FROM whaleu_authorization.role_grants WHERE account_id=q.subject_id AND role IN('super_admin','developer') AND revoked_at IS NULL)
 OR NOT EXISTS(SELECT 1 FROM whaleu_profile.profiles WHERE public_id=q.target_profile_id AND account_id=q.subject_id)
 THEN RAISE EXCEPTION 'Exact initial source observations and current super authority required' USING ERRCODE='23514',CONSTRAINT='school_admin_management_causal';END IF;
 IF q.receipt->>'outcome'='rejected' THEN
  IF EXISTS(SELECT 1 FROM whaleu_authorization.school_admin_assignment_events WHERE(actor_id,request_id)=(q.actor_id,q.request_id))
  OR EXISTS(SELECT 1 FROM whaleu_authorization.school_admin_management_statements WHERE(actor_id,request_id)=(q.actor_id,q.request_id))
  OR EXISTS(SELECT 1 FROM whaleu_experience.school_admin_title_grants WHERE(actor_id,request_id)=(q.actor_id,q.request_id))
  THEN RAISE EXCEPTION 'Stale rejection must remain read-only' USING ERRCODE='23514',CONSTRAINT='school_admin_management_causal';END IF;RETURN;
 END IF;
 SELECT * INTO e FROM whaleu_authorization.school_admin_assignment_events WHERE(actor_id,request_id)=(q.actor_id,q.request_id);
 IF e.id IS NULL OR e.creation_transaction<>pg_current_xact_id() OR e.id::text IS DISTINCT FROM q.receipt->>'eventId'
 OR e.recorded_at IS DISTINCT FROM(q.receipt->>'recordedAt')::timestamptz THEN
  RAISE EXCEPTION 'Exact immutable assignment event must commit with its command' USING ERRCODE='23514',CONSTRAINT='school_admin_management_causal';END IF;
 expected_count:=CASE WHEN q.receipt->>'outcome'='applied' THEN(CASE WHEN q.old_grant_id IS NOT NULL THEN 1 ELSE 0 END)+(CASE WHEN q.new_grant_id IS NOT NULL THEN 1 ELSE 0 END) ELSE 0 END;
 SELECT count(*) INTO actual_count FROM whaleu_authorization.school_admin_management_transitions WHERE(actor_id,request_id)=(q.actor_id,q.request_id);
 IF actual_count<>expected_count
 OR(SELECT count(*) FROM whaleu_authorization.school_admin_management_statements WHERE(actor_id,request_id)=(q.actor_id,q.request_id))<>expected_count
 OR(SELECT count(*) FROM whaleu_authorization.school_admin_management_epochs WHERE(actor_id,request_id)=(q.actor_id,q.request_id))<>expected_count
 THEN RAISE EXCEPTION 'Exactly the promised real grant rows, statements and authority epochs must commit' USING ERRCODE='23514',CONSTRAINT='school_admin_management_causal';END IF;
 IF q.command->>'action'='revoke' THEN
  IF EXISTS(SELECT 1 FROM whaleu_authorization.role_grants WHERE account_id=q.subject_id AND role='school_admin' AND revoked_at IS NULL)
  OR q.receipt->'titleGranted' IS DISTINCT FROM 'false'::jsonb
  OR EXISTS(SELECT 1 FROM whaleu_experience.school_admin_title_grants WHERE(actor_id,request_id)=(q.actor_id,q.request_id)) THEN
   RAISE EXCEPTION 'Revocation leaves no school authority and changes no title' USING ERRCODE='23514',CONSTRAINT='school_admin_management_causal';END IF;
  RETURN;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM whaleu_identity.accounts WHERE id=q.subject_id AND status='active')
 OR NOT whaleu_authorization.school_admin_region_allowed(q.subject_id,(q.command->>'regionId')::uuid)
 OR NOT EXISTS(SELECT 1 FROM whaleu_authorization.role_grants WHERE id=coalesce(q.new_grant_id,q.old_grant_id) AND account_id=q.subject_id
  AND role='school_admin' AND operating_region_id::text=q.command->>'regionId' AND revoked_at IS NULL
  AND valid_from<=clock_timestamp() AND(expires_at IS NULL OR expires_at>clock_timestamp())) THEN
  RAISE EXCEPTION 'Final assignment must have accepted current scope and a current exact grant' USING ERRCODE='23514',CONSTRAINT='school_admin_management_causal';END IF;
 SELECT jsonb_build_array(to_jsonb(t),t.xmin::text,t.ctid::text) INTO title_value FROM whaleu_experience.entitlements t WHERE t.owner_id=q.subject_id AND t.title_key='role_admin';
 IF q.receipt->'titleGranted'='true'::jsonb THEN
  IF q.title_before IS NOT NULL OR NOT EXISTS(SELECT 1 FROM whaleu_experience.school_admin_title_grants g JOIN whaleu_experience.entitlements t
   ON(t.owner_id,t.title_key,t.school_admin_actor_id,t.school_admin_request_id,t.creation_transaction)=(g.owner_id,g.title_key,g.actor_id,g.request_id,g.creation_transaction)
   WHERE(g.actor_id,g.request_id,g.owner_id,g.creation_transaction)=(q.actor_id,q.request_id,q.subject_id,pg_current_xact_id())
   AND t.origin='school_admin_appointment' AND t.title_key='role_admin' AND t.earned_at=e.recorded_at) THEN
   RAISE EXCEPTION 'Claimed title grant requires its actual same-transaction entitlement' USING ERRCODE='23514',CONSTRAINT='school_admin_management_causal';END IF;
 ELSIF title_value IS NULL OR title_value IS DISTINCT FROM q.title_before
 OR EXISTS(SELECT 1 FROM whaleu_experience.school_admin_title_grants WHERE(actor_id,request_id)=(q.actor_id,q.request_id)) THEN
  RAISE EXCEPTION 'Existing administrator title provenance and earned time must be preserved' USING ERRCODE='23514',CONSTRAINT='school_admin_management_causal';
 END IF;
END$$;
CREATE FUNCTION whaleu_authorization.school_admin_management_complete() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 PERFORM whaleu_authorization.school_admin_management_assert_complete(NEW);RETURN NULL;
END$$;
CREATE CONSTRAINT TRIGGER school_admin_management_complete AFTER INSERT ON whaleu_authorization.school_admin_management_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_authorization.school_admin_management_complete();
CREATE FUNCTION whaleu_authorization.school_admin_management_recheck_active() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_authorization.school_admin_management_commands;BEGIN
 FOR q IN SELECT * FROM whaleu_authorization.school_admin_management_commands WHERE creation_transaction=pg_current_xact_id() LOOP
  PERFORM whaleu_authorization.school_admin_management_assert_complete(q);
 END LOOP;RETURN NULL;
END$$;
-- Statement guards reject zero-row, same-value and late unrelated DML too.
-- Deferred row hooks independently close the SET CONSTRAINTS ALL IMMEDIATE then
-- late-DML boundary. No session GUC or application-executed boolean is authority.
DO $$DECLARE relation record;BEGIN
 FOR relation IN SELECT n.nspname schema_name,c.relname relation_name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN('r','p') AND(
  n.nspname IN('whaleu_profile','whaleu_verification','whaleu_campus','whaleu_experience')
  OR(n.nspname='whaleu_identity' AND c.relname IN('accounts','sessions','access_tokens'))
  OR(n.nspname='whaleu_authorization' AND c.relname IN('role_grants','school_admin_management_statements','school_admin_management_epochs','school_admin_management_transitions','school_admin_assignment_events'))
  OR(n.nspname='whaleu_majors' AND c.relname='major_delete_authority_epoch')) ORDER BY n.nspname,c.relname LOOP
  IF NOT(relation.schema_name='whaleu_authorization' OR relation.schema_name='whaleu_majors'
   OR(relation.schema_name='whaleu_experience' AND relation.relation_name='school_admin_title_grants')) THEN
   EXECUTE format('CREATE TRIGGER a00_school_admin_management_source BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON %I.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_authorization.school_admin_management_source_statement_guard()',relation.schema_name,relation.relation_name);
  END IF;
  EXECUTE format('CREATE CONSTRAINT TRIGGER school_admin_management_recheck_active AFTER INSERT OR UPDATE OR DELETE ON %I.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_authorization.school_admin_management_recheck_active()',relation.schema_name,relation.relation_name);
 END LOOP;
END$$;
REVOKE ALL ON whaleu_authorization.school_admin_management_commands,whaleu_authorization.school_admin_management_statements,
 whaleu_authorization.school_admin_management_epochs,whaleu_authorization.school_admin_management_transitions,whaleu_authorization.school_admin_assignment_events,
 whaleu_experience.school_admin_title_grants FROM PUBLIC;
