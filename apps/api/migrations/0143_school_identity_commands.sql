-- Explicit current-school correction and UID completion. No production admission.
CREATE FUNCTION whaleu_school_uid.affiliation_current(subject uuid, assertion uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_verification.account_heads h
 JOIN whaleu_verification.snapshots s ON(s.id,s.account_id,s.revision)=(h.snapshot_id,h.account_id,h.revision)
 JOIN whaleu_verification.assertions a ON(a.id,a.account_id)=(s.affiliation_assertion_id,s.account_id)
 WHERE h.account_id=subject AND a.id=assertion AND a.fact_kind='affiliation' AND a.assertion_state='verified'
 AND a.coverage_state='complete' AND a.provenance_state='accepted' AND a.source_account_id=subject
 AND a.issuer_institution_id IS NOT NULL AND a.source_issuer_institution_id=a.issuer_institution_id
 AND a.origin_region_id IS NOT NULL AND btrim(a.source_reference)<>'' AND btrim(a.policy_reference)<>''
 AND a.method IN('document_review','institutional_email','institutional_sso','reconciled_import','administrator_correction')
 AND isfinite(a.verified_at) AND a.verified_at<=clock_timestamp()
 AND ((a.expiry_kind='policy_exempt' AND a.expires_at IS NULL) OR(a.expiry_kind='at' AND isfinite(a.expires_at) AND a.expires_at>a.verified_at AND a.expires_at>clock_timestamp())))
$$;
CREATE FUNCTION whaleu_school_uid.projection_facts(subject uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object(
 'head',(SELECT jsonb_build_array(to_jsonb(h),h.xmin::text,h.ctid::text) FROM whaleu_school_uid.account_heads h WHERE h.account_id=subject),
 'event',(SELECT to_jsonb(e) FROM whaleu_school_uid.account_heads h JOIN whaleu_school_uid.assignment_events e ON e.id=h.event_id WHERE h.account_id=subject),
 'allocation',(SELECT to_jsonb(a)||jsonb_build_object('uid',a.uid::text) FROM whaleu_school_uid.account_heads h JOIN whaleu_school_uid.allocations a ON(a.id,a.account_id,a.institution_id)=(h.allocation_id,h.account_id,h.institution_id) WHERE h.account_id=subject),
 'admission',(SELECT to_jsonb(d)||jsonb_build_object('reserved_floor',d.reserved_floor::text) FROM whaleu_school_uid.account_heads h JOIN whaleu_school_uid.allocations a ON(a.id,a.account_id,a.institution_id)=(h.allocation_id,h.account_id,h.institution_id) JOIN whaleu_school_uid.school_admissions d ON(d.id,d.institution_id)=(a.admission_id,a.institution_id) WHERE h.account_id=subject),
 'coverage',(SELECT to_jsonb(c) FROM whaleu_school_uid.account_coverage c WHERE c.account_id=subject),
 'coverage_valid',whaleu_school_uid.coverage_valid(subject),
 'native_lineage',CASE WHEN EXISTS(SELECT 1 FROM whaleu_school_uid.account_coverage c WHERE c.account_id=subject AND c.kind='native_absence') THEN whaleu_school_uid.native_identity_proof(subject) ELSE NULL END,
 'mappings',(SELECT coalesce(jsonb_agg(jsonb_build_array(to_jsonb(m),m.xmin::text) ORDER BY m.source_system,m.legacy_id),'[]'::jsonb) FROM whaleu_identity.legacy_account_mappings m WHERE m.account_id=subject),
 'verification',whaleu_authorization.school_admin_affiliation_facts(subject),
 'school',(SELECT jsonb_build_array(to_jsonb(i),i.xmin::text,to_jsonb(m),m.xmin::text) FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON(s.id,s.account_id,s.revision)=(h.snapshot_id,h.account_id,h.revision) JOIN whaleu_verification.assertions a ON(a.id,a.account_id)=(s.affiliation_assertion_id,s.account_id) JOIN whaleu_campus.institutions i ON i.id=a.issuer_institution_id JOIN whaleu_campus.school_identifiers m ON m.institution_id=i.id WHERE h.account_id=subject))
$$;
CREATE FUNCTION whaleu_school_uid.projection(subject uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE a whaleu_verification.assertions;u record;covered boolean;BEGIN
 SELECT whaleu_school_uid.coverage_valid(subject) INTO covered;
 IF covered IS DISTINCT FROM true OR NOT EXISTS(SELECT 1 FROM whaleu_identity.accounts WHERE id=subject AND status='active') THEN RETURN jsonb_build_object('status','unavailable');END IF;
 SELECT va.* INTO a FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON(s.id,s.account_id,s.revision)=(h.snapshot_id,h.account_id,h.revision) JOIN whaleu_verification.assertions va ON(va.id,va.account_id)=(s.affiliation_assertion_id,s.account_id) WHERE h.account_id=subject;
 IF a.id IS NULL OR NOT whaleu_school_uid.affiliation_current(subject,a.id) THEN
  RETURN jsonb_build_object('status',CASE WHEN covered THEN 'unassigned' ELSE 'unavailable' END);
 END IF;
 SELECT al.uid::text uid,i.name,m.school_code INTO u FROM whaleu_school_uid.account_heads h
 JOIN whaleu_school_uid.assignment_events e ON(e.id,e.account_id)=(h.event_id,h.account_id)
 JOIN whaleu_school_uid.allocations al ON(al.id,al.account_id,al.institution_id)=(h.allocation_id,h.account_id,h.institution_id)
 JOIN whaleu_school_uid.school_admissions d ON(d.id,d.institution_id)=(al.admission_id,al.institution_id)
 JOIN whaleu_campus.institutions i ON i.id=al.institution_id JOIN whaleu_campus.school_identifiers m ON m.institution_id=i.id
 WHERE h.account_id=subject AND h.institution_id=a.issuer_institution_id AND whaleu_school_uid.allocation_valid(al.id) AND e.resulting_allocation_id=al.id
 AND e.affiliation_assertion_id=a.id AND e.institution_id=al.institution_id AND e.outcome IN('issued','retained','imported');
 IF u.uid IS NULL THEN RETURN jsonb_build_object('status','unavailable');END IF;
 RETURN jsonb_build_object('status','assigned','school',jsonb_build_object('code',u.school_code,'name',u.name),'uid',u.uid,'formattedUid',CASE WHEN length(u.uid)<6 THEN lpad(u.uid,6,'0') ELSE u.uid END);
END$$;
CREATE FUNCTION whaleu_school_uid.destination_facts(campus uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('campus',jsonb_build_array(to_jsonb(c),c.xmin::text,c.ctid::text),
 'institution',jsonb_build_array(to_jsonb(i),i.xmin::text),'mapping',jsonb_build_array(to_jsonb(m),m.xmin::text),
 'region',jsonb_build_array(to_jsonb(r),r.xmin::text),'assignment',jsonb_build_array(to_jsonb(a),a.xmin::text),
 'admission',(SELECT to_jsonb(d)||jsonb_build_object('reserved_floor',d.reserved_floor::text) FROM whaleu_school_uid.admission_heads h JOIN whaleu_school_uid.school_admissions d ON d.id=h.admission_id WHERE h.institution_id=i.id))
 FROM whaleu_campus.campuses c JOIN whaleu_campus.institutions i ON i.id=c.institution_id
 JOIN whaleu_campus.school_identifiers m ON m.institution_id=i.id
 JOIN whaleu_campus.campus_region_assignments a ON a.campus_id=c.id
 JOIN whaleu_campus.operating_regions r ON r.id=a.operating_region_id WHERE c.id=campus
$$;
CREATE FUNCTION whaleu_school_uid.destination_version(campus uuid)
RETURNS text LANGUAGE sql STABLE AS $$ SELECT whaleu_profile.moderation_hash(whaleu_school_uid.destination_facts(campus)) $$;
CREATE FUNCTION whaleu_school_uid.management_inputs(actor uuid,selected uuid,target uuid,campus uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('authority',whaleu_authorization.school_admin_management_input_facts(actor,selected,target,false),
 'safety',(SELECT coalesce(jsonb_agg(jsonb_build_array(to_jsonb(b),b.xmin::text) ORDER BY b.id),'[]'::jsonb) FROM whaleu_safety.blocks b WHERE (b.blocker_id,b.blocked_id) IN((actor,p.account_id),(p.account_id,actor))),
 'verification',whaleu_authorization.school_admin_affiliation_facts(p.account_id),
 'uid',whaleu_school_uid.projection_facts(p.account_id),
 'destination',whaleu_school_uid.destination_facts(campus),
 'current_admission',(SELECT to_jsonb(d)||jsonb_build_object('reserved_floor',d.reserved_floor::text) FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON(s.id,s.account_id,s.revision)=(h.snapshot_id,h.account_id,h.revision) JOIN whaleu_verification.assertions va ON(va.id,va.account_id)=(s.affiliation_assertion_id,s.account_id) JOIN whaleu_school_uid.admission_heads uh ON uh.institution_id=va.issuer_institution_id JOIN whaleu_school_uid.school_admissions d ON d.id=uh.admission_id WHERE h.account_id=p.account_id))
 FROM whaleu_profile.profiles p WHERE p.public_id=target
$$;
CREATE FUNCTION whaleu_school_uid.state_version(target uuid,actor uuid DEFAULT NULL)
RETURNS text LANGUAGE sql STABLE AS $$
 SELECT whaleu_profile.moderation_hash(whaleu_school_uid.management_inputs(actor,NULL,target,NULL)-'authority'||jsonb_build_object('target',whaleu_authorization.school_admin_management_input_facts(NULL,NULL,target,false)-ARRAY['actor_grants','selected','epoch','target_grants','assignment_regions']))
$$;
CREATE FUNCTION whaleu_school_uid.command_hash(command jsonb)
RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT encode(sha256(convert_to('whaleu:school-identity-command:v1'||chr(10)||concat_ws(chr(10),command->>'version',command->>'action',command->>'targetProfileId',command->>'expectedStateVersion',CASE WHEN command->>'action'='correct_school' THEN command->>'destinationCampusId' END,CASE WHEN command->>'action'='correct_school' THEN command->>'expectedDestinationVersion' END),'UTF8')),'hex')
$$;
CREATE TABLE whaleu_school_uid.commands(
 id uuid PRIMARY KEY,actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,
 session_id uuid NOT NULL,token_hash text NOT NULL,target_profile_id uuid NOT NULL,account_id uuid,actor_grant_id uuid,
 intent_hash text NOT NULL,command jsonb NOT NULL,receipt jsonb NOT NULL,input_before jsonb,
 identity_before text NOT NULL DEFAULT '',state_before text,old_snapshot_id uuid,new_snapshot_id uuid,new_assertion_id uuid,
 verification_event_id uuid,uid_event_id uuid,cause_id uuid,
 created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(actor_id,request_id),CHECK(intent_hash=whaleu_school_uid.command_hash(command)),
 CHECK(octet_length(command::text)<4096 AND octet_length(receipt::text)<4096),
 CHECK(request_id::text~'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
);
CREATE FUNCTION whaleu_school_uid.command_before() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actual jsonb;expected jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'immutable school identity command' USING ERRCODE='23514',CONSTRAINT='school_identity_command_immutable';END IF;
 IF NEW.created_xid<>pg_current_xact_id() OR NEW.created_at>clock_timestamp() OR NEW.command->'version' IS DISTINCT FROM '1'::jsonb
 OR coalesce(NEW.command->>'action','') NOT IN('correct_school','complete_uid') OR NEW.command->>'clientRequestId' IS DISTINCT FROM NEW.request_id::text
 OR NEW.command->>'targetProfileId' IS DISTINCT FROM NEW.target_profile_id::text
 OR whaleu_authorization.school_admin_management_identity(NEW.actor_id,NEW.session_id,NEW.token_hash) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'invalid school identity intent' USING ERRCODE='23514',CONSTRAINT='school_identity_command_intent';END IF;
 expected:=NEW.command-'clientRequestId'||jsonb_build_object('requestId',NEW.request_id::text);
 IF NEW.receipt->>'outcome' IN('applied','unchanged') THEN expected:=expected||jsonb_build_object('outcome',NEW.receipt->>'outcome','eventId',NEW.receipt->>'eventId','recordedAt',NEW.receipt->>'recordedAt');
 ELSIF NEW.receipt->>'outcome'='rejected' AND NEW.receipt->>'code' IN('SCHOOL_IDENTITY_STALE','SCHOOL_IDENTITY_CANCELLED') THEN expected:=expected||jsonb_build_object('outcome','rejected','code',NEW.receipt->>'code');
 ELSE RAISE EXCEPTION 'invalid school identity receipt' USING ERRCODE='23514';END IF;
 IF NEW.receipt IS DISTINCT FROM expected THEN RAISE EXCEPTION 'school identity receipt intent mismatch' USING ERRCODE='23514';END IF;
 IF whaleu_community.post_owner_visibility_keys(NEW.command,CASE WHEN NEW.command->>'action'='correct_school' THEN ARRAY['version','clientRequestId','action','targetProfileId','expectedStateVersion','destinationCampusId','expectedDestinationVersion'] ELSE ARRAY['version','clientRequestId','action','targetProfileId','expectedStateVersion'] END) IS DISTINCT FROM true
 OR coalesce(NEW.command->>'expectedStateVersion','') !~ '^[a-f0-9]{64}$'
 OR (NEW.command->>'action'='correct_school' AND (coalesce(NEW.command->>'expectedDestinationVersion','') !~ '^[a-f0-9]{64}$' OR whaleu_profile.moderation_uuid_valid(NEW.command->>'destinationCampusId') IS DISTINCT FROM true)) THEN RAISE EXCEPTION 'noncanonical school identity command' USING ERRCODE='23514';END IF;
 IF NEW.receipt->>'outcome' IN('applied','unchanged') THEN
  IF NEW.receipt->>'eventId' IS DISTINCT FROM (CASE WHEN NEW.receipt->>'outcome'='applied' THEN NEW.uid_event_id::text ELSE NEW.id::text END)
  OR NEW.receipt->>'recordedAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  OR NOT isfinite((NEW.receipt->>'recordedAt')::timestamptz)
  OR (NEW.receipt->>'recordedAt')::timestamptz<date_trunc('milliseconds',transaction_timestamp())
  OR (NEW.receipt->>'recordedAt')::timestamptz>clock_timestamp()
  THEN RAISE EXCEPTION 'school identity receipt event or clock mismatch' USING ERRCODE='23514',CONSTRAINT='school_identity_receipt_event';END IF;
  NEW.created_at:=(NEW.receipt->>'recordedAt')::timestamptz;
 END IF;
 NEW.identity_before:=whaleu_profile.moderation_hash(whaleu_profile.moderation_identity_facts(NEW.actor_id,NEW.session_id,NEW.token_hash));
 IF NEW.receipt->>'code'='SCHOOL_IDENTITY_CANCELLED' THEN
  IF NEW.account_id IS NOT NULL OR NEW.actor_grant_id IS NOT NULL OR NEW.cause_id IS NOT NULL THEN RAISE EXCEPTION 'cancel has effects' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 IF whaleu_authorization.school_admin_management_super(NEW.actor_id,NEW.actor_grant_id) IS DISTINCT FROM true
 OR NOT EXISTS(SELECT 1 FROM whaleu_profile.profiles p JOIN whaleu_identity.accounts a ON a.id=p.account_id WHERE p.public_id=NEW.target_profile_id AND p.account_id=NEW.account_id AND a.status='active') THEN RAISE EXCEPTION 'school identity authority unavailable' USING ERRCODE='23514',CONSTRAINT='school_identity_authority';END IF;
 IF NEW.command->>'action'='correct_school' AND NOT EXISTS(SELECT 1 FROM whaleu_campus.campuses cc JOIN whaleu_campus.campus_region_assignments ca ON ca.campus_id=cc.id JOIN whaleu_campus.operating_regions rr ON rr.id=ca.operating_region_id JOIN whaleu_campus.school_identifiers si ON si.institution_id=cc.institution_id WHERE cc.id=(NEW.command->>'destinationCampusId')::uuid AND cc.is_active AND rr.is_active) THEN RAISE EXCEPTION 'school identity destination is not current' USING ERRCODE='23514',CONSTRAINT='school_identity_destination';END IF;
 actual:=whaleu_school_uid.management_inputs(NEW.actor_id,NEW.actor_grant_id,NEW.target_profile_id,(NEW.command->>'destinationCampusId')::uuid);
 IF actual IS DISTINCT FROM NEW.input_before THEN RAISE EXCEPTION 'school identity source changed' USING ERRCODE='23514',CONSTRAINT='school_identity_source';END IF;
 NEW.state_before:=whaleu_school_uid.state_version(NEW.target_profile_id,NEW.actor_id);
 IF NEW.receipt->>'code'='SCHOOL_IDENTITY_STALE' THEN
  IF NEW.state_before=NEW.command->>'expectedStateVersion' AND (NEW.command->>'action'='complete_uid' OR whaleu_school_uid.destination_version((NEW.command->>'destinationCampusId')::uuid)=NEW.command->>'expectedDestinationVersion') THEN RAISE EXCEPTION 'fabricated stale receipt' USING ERRCODE='23514';END IF;
  IF NEW.cause_id IS NOT NULL THEN RAISE EXCEPTION 'stale command has effects' USING ERRCODE='23514';END IF;
 ELSE
  IF NEW.state_before IS DISTINCT FROM NEW.command->>'expectedStateVersion'
  OR (NEW.command->>'action'='correct_school' AND whaleu_school_uid.destination_version((NEW.command->>'destinationCampusId')::uuid) IS DISTINCT FROM NEW.command->>'expectedDestinationVersion')
  OR NEW.cause_id IS NULL THEN RAISE EXCEPTION 'school identity stale input' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER school_identity_command_before BEFORE INSERT OR UPDATE OR DELETE ON whaleu_school_uid.commands FOR EACH ROW EXECUTE FUNCTION whaleu_school_uid.command_before();
CREATE FUNCTION whaleu_school_uid.command_forbid_statement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable school identity statement' USING ERRCODE='23514',CONSTRAINT='school_identity_immutable_statement';END$$;
CREATE TRIGGER school_identity_command_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_school_uid.commands FOR EACH STATEMENT EXECUTE FUNCTION whaleu_school_uid.command_forbid_statement();
CREATE FUNCTION whaleu_school_uid.command_inputs_current(q whaleu_school_uid.commands)
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE actual jsonb;old_school uuid;BEGIN
 actual:=whaleu_school_uid.management_inputs(q.actor_id,q.actor_grant_id,q.target_profile_id,(q.command->>'destinationCampusId')::uuid);
 IF actual->'authority' IS DISTINCT FROM q.input_before->'authority' OR actual->'destination' IS DISTINCT FROM q.input_before->'destination'
 OR actual->'safety' IS DISTINCT FROM q.input_before->'safety' THEN RETURN false;END IF;
 old_school:=(q.input_before->'verification'->'assertion'->0->>'issuer_institution_id')::uuid;
 -- management_inputs retains an absent admission explicitly as JSON null.
 -- Canonicalize only that observed absence; a newly present admission still differs.
 IF coalesce((SELECT to_jsonb(d)||jsonb_build_object('reserved_floor',d.reserved_floor::text) FROM whaleu_school_uid.admission_heads h JOIN whaleu_school_uid.school_admissions d ON d.id=h.admission_id WHERE h.institution_id=old_school),'null'::jsonb) IS DISTINCT FROM q.input_before->'current_admission' THEN RETURN false;END IF;
 IF q.receipt->>'outcome' IN('unchanged','rejected') THEN
  RETURN actual->'verification' IS NOT DISTINCT FROM q.input_before->'verification' AND actual->'uid' IS NOT DISTINCT FROM q.input_before->'uid';
 END IF;
 IF q.command->>'action'='complete_uid' AND actual->'verification' IS DISTINCT FROM q.input_before->'verification' THEN RETURN false;END IF;
 RETURN EXISTS(SELECT 1 FROM whaleu_school_uid.account_heads h JOIN whaleu_school_uid.assignment_events e ON(e.id,e.account_id)=(h.event_id,h.account_id)
 WHERE h.account_id=q.account_id AND h.cause_id=q.cause_id AND e.id=q.uid_event_id AND e.cause_id=q.cause_id
 AND e.previous_allocation_id IS NOT DISTINCT FROM (q.input_before->'uid'->'head'->0->>'allocation_id')::uuid);
END$$;
CREATE FUNCTION whaleu_school_uid.command_authority_current(q whaleu_school_uid.commands)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT q.created_xid=pg_current_xact_id() AND whaleu_authorization.school_admin_management_identity(q.actor_id,q.session_id,q.token_hash)
 AND q.identity_before=whaleu_profile.moderation_hash(whaleu_profile.moderation_identity_facts(q.actor_id,q.session_id,q.token_hash))
 AND whaleu_authorization.school_admin_management_super(q.actor_id,q.actor_grant_id)
 AND NOT EXISTS(SELECT 1 FROM whaleu_safety.blocks b WHERE b.active AND (b.blocker_id,b.blocked_id) IN((q.actor_id,q.account_id),(q.account_id,q.actor_id)))
 AND whaleu_school_uid.command_inputs_current(q)
$$;
CREATE OR REPLACE FUNCTION whaleu_school_uid.management_cause_authorized(cause whaleu_school_uid.producing_causes)
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE c whaleu_school_uid.producing_causes:=cause;q whaleu_school_uid.commands;e whaleu_school_uid.assignment_events;BEGIN
 SELECT * INTO q FROM whaleu_school_uid.commands WHERE id=c.source_id;
 IF q.id IS NULL OR q.cause_id IS DISTINCT FROM c.id OR q.account_id IS DISTINCT FROM c.account_id OR q.actor_id IS DISTINCT FROM c.actor_account_id
 OR q.created_xid IS DISTINCT FROM c.creation_transaction OR whaleu_school_uid.command_authority_current(q) IS DISTINCT FROM true
 OR q.receipt->>'outcome' NOT IN('applied','unchanged') OR q.old_snapshot_id IS DISTINCT FROM c.old_snapshot_id
 OR q.new_snapshot_id IS DISTINCT FROM c.snapshot_id OR q.new_assertion_id IS DISTINCT FROM c.affiliation_assertion_id
 OR q.verification_event_id IS DISTINCT FROM c.verification_event_id THEN RETURN false;END IF;
 IF c.kind='unchanged' THEN
  RETURN q.receipt->>'outcome'='unchanged' AND q.uid_event_id IS NULL AND c.snapshot_id=c.old_snapshot_id
  AND whaleu_school_uid.affiliation_current(c.account_id,c.affiliation_assertion_id)
  AND ((q.command->>'action'='correct_school' AND EXISTS(SELECT 1 FROM whaleu_campus.campuses cc WHERE cc.id=(q.command->>'destinationCampusId')::uuid AND cc.institution_id=c.institution_id AND cc.is_active))
   OR(q.command->>'action'='complete_uid' AND whaleu_school_uid.projection(c.account_id)->>'status'='assigned'));
 END IF;
 SELECT * INTO e FROM whaleu_school_uid.assignment_events WHERE id=q.uid_event_id;
 IF e.id IS NULL OR e.cause_id<>c.id OR e.outcome NOT IN('issued','retained') OR e.account_id<>c.account_id OR e.institution_id<>c.institution_id OR q.receipt->>'outcome'<>'applied' THEN RETURN false;END IF;
 RETURN c.kind=q.command->>'action' AND whaleu_school_uid.affiliation_current(c.account_id,c.affiliation_assertion_id);
END$$;
CREATE OR REPLACE FUNCTION whaleu_school_uid.school_identity_correction_authorized(command_id uuid,cause_id uuid,actor uuid,target uuid,old_snapshot uuid,new_snapshot uuid,new_assertion uuid,new_event uuid,institution uuid,region uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_school_uid.commands q JOIN whaleu_school_uid.producing_causes c ON c.id=q.cause_id
 JOIN whaleu_campus.campuses campus ON campus.id=(q.command->>'destinationCampusId')::uuid
 JOIN whaleu_campus.campus_region_assignments ca ON ca.campus_id=campus.id JOIN whaleu_campus.operating_regions r ON r.id=ca.operating_region_id
 WHERE q.id=command_id AND q.cause_id=cause_id AND q.actor_id=actor AND q.account_id=target AND q.old_snapshot_id=old_snapshot
 AND q.new_snapshot_id=new_snapshot AND q.new_assertion_id=new_assertion AND q.verification_event_id=new_event
 AND q.command->>'action'='correct_school' AND q.receipt->>'outcome'='applied' AND c.institution_id=institution AND campus.institution_id=institution
 AND ca.operating_region_id=region AND campus.is_active AND r.is_active AND whaleu_school_uid.management_cause_authorized(c))
$$;
CREATE FUNCTION whaleu_school_uid.command_assert_complete(q whaleu_school_uid.commands)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE c whaleu_school_uid.producing_causes;BEGIN
 IF q.created_xid<>pg_current_xact_id() OR whaleu_authorization.school_admin_management_identity(q.actor_id,q.session_id,q.token_hash) IS DISTINCT FROM true
 OR q.identity_before IS DISTINCT FROM whaleu_profile.moderation_hash(whaleu_profile.moderation_identity_facts(q.actor_id,q.session_id,q.token_hash)) THEN RAISE EXCEPTION 'school identity creation identity changed' USING ERRCODE='23514',CONSTRAINT='school_identity_final_identity';END IF;
 IF q.receipt->>'code'='SCHOOL_IDENTITY_CANCELLED' THEN
  IF EXISTS(SELECT 1 FROM whaleu_school_uid.producing_causes WHERE source_id=q.id) THEN RAISE EXCEPTION 'cancelled command cause' USING ERRCODE='23514';END IF;RETURN;
 END IF;
 IF whaleu_school_uid.command_authority_current(q) IS DISTINCT FROM true THEN RAISE EXCEPTION 'school identity current authority changed' USING ERRCODE='23514',CONSTRAINT='school_identity_final_authority';END IF;
 IF q.receipt->>'code'='SCHOOL_IDENTITY_STALE' THEN
  IF EXISTS(SELECT 1 FROM whaleu_school_uid.producing_causes WHERE source_id=q.id) THEN RAISE EXCEPTION 'stale command cause' USING ERRCODE='23514';END IF;RETURN;
 END IF;
 SELECT * INTO c FROM whaleu_school_uid.producing_causes WHERE id=q.cause_id;
 IF c.id IS NULL OR whaleu_school_uid.management_cause_authorized(c) IS DISTINCT FROM true THEN RAISE EXCEPTION 'school identity cause incomplete' USING ERRCODE='23514',CONSTRAINT='school_identity_final_cause';END IF;
 IF whaleu_school_uid.producing_cause_complete(c.id) IS DISTINCT FROM true THEN RAISE EXCEPTION 'school identity UID/source closure' USING ERRCODE='23514';END IF;
END$$;
CREATE FUNCTION whaleu_school_uid.command_closure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM whaleu_school_uid.command_assert_complete(NEW);RETURN NULL;END$$;
CREATE CONSTRAINT TRIGGER school_identity_command_closure AFTER INSERT ON whaleu_school_uid.commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_school_uid.command_closure();
