-- Immutable rating effects and a typed, FK-backed Experience bridge.
CREATE TABLE whaleu_ratings.effect_events (
 id uuid PRIMARY KEY,source_version integer NOT NULL DEFAULT 1 CHECK(source_version=1),rule_version text NOT NULL DEFAULT 'rating-effects-v1' CHECK(rule_version='rating-effects-v1'),
 event_kind text NOT NULL CHECK(event_kind IN ('root_created','reply_created','root_deleted','reply_deleted')),
 target_id uuid NOT NULL REFERENCES whaleu_ratings.targets(id),root_id uuid NOT NULL,reply_id uuid,reply_to_id uuid,
 actor_account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),author_mode text NOT NULL CHECK(author_mode IN ('named','anonymous')),root_author_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),direct_reply_author_id uuid REFERENCES whaleu_identity.accounts(id),region_id uuid REFERENCES whaleu_campus.operating_regions(id),
 comment_transition_id uuid UNIQUE REFERENCES whaleu_ratings.comment_transitions(id),reply_transition_id uuid UNIQUE REFERENCES whaleu_ratings.reply_transitions(id),request_id uuid NOT NULL,
 occurred_at timestamptz NOT NULL CHECK(isfinite(occurred_at)),mutation_transaction xid8 NOT NULL,event_sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 expected_experience_units smallint NOT NULL CHECK(expected_experience_units BETWEEN 0 AND 2),expected_direct_notice_obligations smallint NOT NULL CHECK(expected_direct_notice_obligations BETWEEN 0 AND 2),
 UNIQUE(actor_account_id,request_id),FOREIGN KEY(actor_account_id,request_id) REFERENCES whaleu_ratings.requests(account_id,request_id),FOREIGN KEY(root_id,target_id) REFERENCES whaleu_ratings.comments(id,target_id),FOREIGN KEY(reply_id,root_id,target_id) REFERENCES whaleu_ratings.replies(id,root_id,target_id),FOREIGN KEY(reply_to_id,root_id,target_id) REFERENCES whaleu_ratings.replies(id,root_id,target_id),
 CHECK((comment_transition_id IS NULL)<>(reply_transition_id IS NULL)),CHECK((event_kind LIKE 'root_%')=(comment_transition_id IS NOT NULL)),CHECK((reply_id IS NULL)=(comment_transition_id IS NOT NULL)),CHECK((reply_to_id IS NULL)=(direct_reply_author_id IS NULL)),CHECK(reply_id IS NOT NULL OR reply_to_id IS NULL)
);
CREATE FUNCTION whaleu_ratings.expected_reward_units(event uuid) RETURNS TABLE(beneficiary_id uuid,action text) LANGUAGE sql STABLE AS $$
 SELECT actor_account_id,'comment'::text FROM whaleu_ratings.effect_events WHERE id=event AND event_kind IN ('root_created','reply_created')
 UNION ALL SELECT CASE WHEN reply_to_id IS NULL THEN root_author_id ELSE direct_reply_author_id END,'received_comment'::text FROM whaleu_ratings.effect_events WHERE id=event AND event_kind='reply_created' AND CASE WHEN reply_to_id IS NULL THEN root_author_id ELSE direct_reply_author_id END<>actor_account_id
$$;
CREATE FUNCTION whaleu_ratings.expected_direct_notices(event uuid) RETURNS TABLE(recipient_account_id uuid,reason text) LANGUAGE sql STABLE AS $$
 SELECT root_author_id,'direct_root'::text FROM whaleu_ratings.effect_events WHERE id=event AND event_kind='reply_created' AND root_author_id<>actor_account_id AND root_author_id IS DISTINCT FROM direct_reply_author_id
 UNION ALL SELECT direct_reply_author_id,'direct_reply'::text FROM whaleu_ratings.effect_events WHERE id=event AND event_kind='reply_created' AND direct_reply_author_id IS NOT NULL AND direct_reply_author_id<>actor_account_id
$$;
CREATE TABLE whaleu_ratings.notice_obligations (
 event_id uuid NOT NULL REFERENCES whaleu_ratings.effect_events(id),recipient_account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),reason text NOT NULL CHECK(reason IN ('direct_root','direct_reply')),
 region_id uuid REFERENCES whaleu_campus.operating_regions(id),target_id uuid NOT NULL,root_id uuid NOT NULL,reply_id uuid NOT NULL,source_transaction xid8 NOT NULL,
 PRIMARY KEY(event_id,recipient_account_id),UNIQUE(event_id,recipient_account_id,reason),FOREIGN KEY(reply_id,root_id,target_id) REFERENCES whaleu_ratings.replies(id,root_id,target_id)
);
CREATE FUNCTION whaleu_ratings.effect_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c whaleu_ratings.comment_transitions;r whaleu_ratings.reply_transitions;root whaleu_ratings.comments;reply whaleu_ratings.replies;direct whaleu_ratings.replies;t whaleu_ratings.targets;kind text;expected_actor uuid;expected_request uuid;occurred timestamptz;xid xid8;mode text;q whaleu_ratings.requests;
BEGIN
 IF pg_trigger_depth()<2 THEN RAISE EXCEPTION 'Effect requires a fresh content transition' USING ERRCODE='23514';END IF;
 SELECT * INTO root FROM whaleu_ratings.comments WHERE id=NEW.root_id AND target_id=NEW.target_id;
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=NEW.target_id;
 IF NEW.comment_transition_id IS NOT NULL THEN SELECT * INTO c FROM whaleu_ratings.comment_transitions WHERE id=NEW.comment_transition_id;
 kind:=CASE c.operation WHEN 'create_comment' THEN 'root_created' ELSE 'root_deleted' END;expected_actor:=c.account_id;expected_request:=c.request_id;occurred:=c.occurred_at;xid:=c.mutation_transaction;mode:=root.author_mode;
 IF (c.comment_id,c.target_id) IS DISTINCT FROM (NEW.root_id,NEW.target_id) THEN RAISE EXCEPTION 'Effect root mismatch' USING ERRCODE='23514';END IF;
 ELSE SELECT * INTO r FROM whaleu_ratings.reply_transitions WHERE id=NEW.reply_transition_id;
 SELECT * INTO reply FROM whaleu_ratings.replies WHERE id=r.reply_id;SELECT * INTO direct FROM whaleu_ratings.replies WHERE id=reply.reply_to_id;
 kind:=CASE r.operation WHEN 'create_reply' THEN 'reply_created' ELSE 'reply_deleted' END;expected_actor:=r.account_id;expected_request:=r.request_id;occurred:=r.occurred_at;xid:=r.mutation_transaction;mode:=reply.author_mode;
 IF (r.reply_id,r.root_id,r.target_id,reply.reply_to_id) IS DISTINCT FROM (NEW.reply_id,NEW.root_id,NEW.target_id,NEW.reply_to_id) THEN RAISE EXCEPTION 'Effect reply mismatch' USING ERRCODE='23514';END IF;END IF;
 IF xid IS DISTINCT FROM pg_current_xact_id() OR ROW(NEW.event_kind,NEW.actor_account_id,NEW.request_id,NEW.occurred_at,NEW.mutation_transaction,NEW.author_mode,NEW.root_author_id,NEW.direct_reply_author_id,NEW.region_id) IS DISTINCT FROM ROW(kind,expected_actor,expected_request,occurred,xid,mode,root.account_id,direct.account_id,t.region_id) THEN RAISE EXCEPTION 'Effect source mismatch' USING ERRCODE='23514';END IF;
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=expected_actor AND request_id=expected_request;
 IF q.receipt IS NOT NULL OR q.operation IS DISTINCT FROM (CASE kind WHEN 'root_created' THEN 'create_comment' WHEN 'root_deleted' THEN 'delete_comment' WHEN 'reply_created' THEN 'create_reply' ELSE 'delete_reply' END) THEN RAISE EXCEPTION 'Effect command is not fresh' USING ERRCODE='23514';END IF;
 IF kind='root_created' AND (root.account_id IS DISTINCT FROM c.account_id OR root.publication_transaction<>pg_current_xact_id() OR root.deleted_at IS NOT NULL OR (root.request_id,root.created_at,root.revision) IS DISTINCT FROM (c.request_id,c.occurred_at,c.revision)) THEN RAISE EXCEPTION 'Effect root publication mismatch' USING ERRCODE='23514';END IF;
 IF kind='root_deleted' AND (root.account_id IS DISTINCT FROM c.account_id OR root.deleted_at IS NULL OR (root.delete_request_id,root.deleted_at,root.revision) IS DISTINCT FROM (c.request_id,c.occurred_at,c.revision)) THEN RAISE EXCEPTION 'Effect root deletion mismatch' USING ERRCODE='23514';END IF;
 NEW.expected_experience_units:=CASE WHEN kind LIKE '%_deleted' THEN 0 WHEN kind='root_created' OR coalesce(direct.account_id,root.account_id)=expected_actor THEN 1 ELSE 2 END;
 NEW.expected_direct_notice_obligations:=CASE WHEN kind<>'reply_created' THEN 0 ELSE (root.account_id<>expected_actor AND root.account_id IS DISTINCT FROM direct.account_id)::integer+coalesce((direct.account_id<>expected_actor)::integer,0) END;
 RETURN NEW;
END $$;
CREATE TRIGGER rating_effect_guard BEFORE INSERT ON whaleu_ratings.effect_events FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.effect_guard();
CREATE FUNCTION whaleu_ratings.record_effect() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE root whaleu_ratings.comments;reply whaleu_ratings.replies;direct whaleu_ratings.replies;t whaleu_ratings.targets;event uuid:=gen_random_uuid();is_root boolean:=TG_TABLE_NAME='comment_transitions';
BEGIN
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=NEW.target_id;
 IF is_root THEN SELECT * INTO root FROM whaleu_ratings.comments WHERE id=NEW.comment_id;
 ELSE SELECT * INTO reply FROM whaleu_ratings.replies WHERE id=NEW.reply_id;SELECT * INTO root FROM whaleu_ratings.comments WHERE id=NEW.root_id;SELECT * INTO direct FROM whaleu_ratings.replies WHERE id=reply.reply_to_id;END IF;
 INSERT INTO whaleu_ratings.effect_events(id,event_kind,target_id,root_id,reply_id,reply_to_id,actor_account_id,author_mode,root_author_id,direct_reply_author_id,region_id,comment_transition_id,reply_transition_id,request_id,occurred_at,mutation_transaction,expected_experience_units,expected_direct_notice_obligations)
 VALUES(event,CASE NEW.operation WHEN 'create_comment' THEN 'root_created' WHEN 'delete_comment' THEN 'root_deleted' WHEN 'create_reply' THEN 'reply_created' ELSE 'reply_deleted' END,NEW.target_id,root.id,reply.id,reply.reply_to_id,NEW.account_id,CASE WHEN is_root THEN root.author_mode ELSE reply.author_mode END,root.account_id,direct.account_id,t.region_id,CASE WHEN is_root THEN NEW.id END,CASE WHEN NOT is_root THEN NEW.id END,NEW.request_id,NEW.occurred_at,NEW.mutation_transaction,0,0);
 INSERT INTO whaleu_ratings.notice_obligations(event_id,recipient_account_id,reason,region_id,target_id,root_id,reply_id,source_transaction)
 SELECT event,n.recipient_account_id,n.reason,t.region_id,t.id,root.id,reply.id,NEW.mutation_transaction FROM whaleu_ratings.expected_direct_notices(event) n;
 RETURN NULL;
END $$;
CREATE TRIGGER rating_root_effect AFTER INSERT ON whaleu_ratings.comment_transitions FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.record_effect();
CREATE TRIGGER rating_reply_effect AFTER INSERT ON whaleu_ratings.reply_transitions FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.record_effect();
CREATE FUNCTION whaleu_ratings.notice_obligation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e whaleu_ratings.effect_events;
BEGIN SELECT * INTO e FROM whaleu_ratings.effect_events WHERE id=NEW.event_id;
 IF e.mutation_transaction IS DISTINCT FROM pg_current_xact_id() OR ROW(NEW.region_id,NEW.target_id,NEW.root_id,NEW.reply_id,NEW.source_transaction) IS DISTINCT FROM ROW(e.region_id,e.target_id,e.root_id,e.reply_id,e.mutation_transaction) OR NOT EXISTS(SELECT 1 FROM whaleu_ratings.expected_direct_notices(e.id) n WHERE (n.recipient_account_id,n.reason)=(NEW.recipient_account_id,NEW.reason)) THEN RAISE EXCEPTION 'Invalid rating notice obligation' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE TRIGGER rating_notice_obligation_guard BEFORE INSERT ON whaleu_ratings.notice_obligations FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.notice_obligation_guard();
CREATE TABLE whaleu_ratings.reward_groups (
 id uuid PRIMARY KEY,event_id uuid NOT NULL UNIQUE REFERENCES whaleu_ratings.effect_events(id),source_version integer NOT NULL DEFAULT 1 CHECK(source_version=1),event_kind text NOT NULL CHECK(event_kind IN ('root_created','reply_created')),
 target_id uuid NOT NULL,root_id uuid NOT NULL,reply_id uuid,reply_to_id uuid,actor_account_id uuid NOT NULL,root_author_id uuid NOT NULL,direct_reply_author_id uuid,
 occurred_at timestamptz NOT NULL CHECK(isfinite(occurred_at)),enrollment_order bigint NOT NULL UNIQUE,creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),expected_unit_count smallint NOT NULL CHECK(expected_unit_count BETWEEN 1 AND 2),
 UNIQUE(id,enrollment_order),UNIQUE(id,enrollment_order,creation_transaction),FOREIGN KEY(enrollment_order,creation_transaction) REFERENCES whaleu_experience.enrollments(enrollment_order,creation_transaction)
);
CREATE TABLE whaleu_ratings.reward_units (
 id uuid PRIMARY KEY,group_id uuid NOT NULL,event_id uuid NOT NULL REFERENCES whaleu_ratings.effect_events(id),beneficiary_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),action text NOT NULL CHECK(action IN ('comment','received_comment')),enrollment_order bigint NOT NULL,
 UNIQUE(id,group_id,beneficiary_id,action,enrollment_order),UNIQUE(group_id,beneficiary_id,action),FOREIGN KEY(group_id,enrollment_order) REFERENCES whaleu_ratings.reward_groups(id,enrollment_order)
);
CREATE FUNCTION whaleu_ratings.reward_group_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e whaleu_ratings.effect_events;
BEGIN SELECT * INTO e FROM whaleu_ratings.effect_events WHERE id=NEW.event_id;
 IF e.id IS NULL OR e.mutation_transaction<>pg_current_xact_id() OR NEW.creation_transaction<>pg_current_xact_id() OR ROW(NEW.source_version,NEW.event_kind,NEW.target_id,NEW.root_id,NEW.reply_id,NEW.reply_to_id,NEW.actor_account_id,NEW.root_author_id,NEW.direct_reply_author_id,NEW.occurred_at,NEW.expected_unit_count) IS DISTINCT FROM ROW(e.source_version,e.event_kind,e.target_id,e.root_id,e.reply_id,e.reply_to_id,e.actor_account_id,e.root_author_id,e.direct_reply_author_id,e.occurred_at,e.expected_experience_units) THEN RAISE EXCEPTION 'Rating reward source mismatch' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE TRIGGER rating_reward_group_guard BEFORE INSERT ON whaleu_ratings.reward_groups FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.reward_group_guard();
CREATE FUNCTION whaleu_ratings.reward_unit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE g whaleu_ratings.reward_groups;
BEGIN SELECT * INTO g FROM whaleu_ratings.reward_groups WHERE id=NEW.group_id;
 IF g.creation_transaction IS DISTINCT FROM pg_current_xact_id() OR (g.event_id,g.enrollment_order) IS DISTINCT FROM (NEW.event_id,NEW.enrollment_order) OR NOT EXISTS(SELECT 1 FROM whaleu_ratings.expected_reward_units(g.event_id) u WHERE (u.beneficiary_id,u.action)=(NEW.beneficiary_id,NEW.action)) THEN RAISE EXCEPTION 'Rating reward beneficiary mismatch' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE TRIGGER rating_reward_unit_guard BEFORE INSERT ON whaleu_ratings.reward_units FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.reward_unit_guard();
-- Bridge migration is a projection of already verified old sources, never a replay.
LOCK TABLE whaleu_community.reward_source_groups,whaleu_community.reward_source_units,whaleu_experience.work,whaleu_experience.enrollments IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE whaleu_community.reward_source_groups ADD UNIQUE(id,enrollment_order,creation_transaction);
CREATE TABLE whaleu_experience.source_groups (
 group_id uuid PRIMARY KEY,source_domain text NOT NULL CHECK(source_domain IN ('community','ratings')),source_version integer NOT NULL CHECK(source_version=1),enrollment_order bigint NOT NULL UNIQUE,creation_transaction xid8 NOT NULL,community_group_id uuid,rating_group_id uuid,
 UNIQUE(group_id,enrollment_order,source_domain),
 CHECK((source_domain='community' AND community_group_id=group_id AND community_group_id IS NOT NULL AND rating_group_id IS NULL) OR (source_domain='ratings' AND rating_group_id=group_id AND rating_group_id IS NOT NULL AND community_group_id IS NULL)),
 FOREIGN KEY(community_group_id,enrollment_order,creation_transaction) REFERENCES whaleu_community.reward_source_groups(id,enrollment_order,creation_transaction),FOREIGN KEY(rating_group_id,enrollment_order,creation_transaction) REFERENCES whaleu_ratings.reward_groups(id,enrollment_order,creation_transaction)
);
CREATE TABLE whaleu_experience.source_units (
 unit_id uuid PRIMARY KEY,source_domain text NOT NULL CHECK(source_domain IN ('community','ratings')),group_id uuid NOT NULL,beneficiary_id uuid NOT NULL,action text NOT NULL,enrollment_order bigint NOT NULL,community_unit_id uuid,rating_unit_id uuid,
 UNIQUE(unit_id,group_id,beneficiary_id,action,enrollment_order),FOREIGN KEY(group_id,enrollment_order,source_domain) REFERENCES whaleu_experience.source_groups(group_id,enrollment_order,source_domain),
 CHECK((source_domain='community' AND community_unit_id=unit_id AND community_unit_id IS NOT NULL AND rating_unit_id IS NULL) OR (source_domain='ratings' AND rating_unit_id=unit_id AND rating_unit_id IS NOT NULL AND community_unit_id IS NULL)),
 FOREIGN KEY(community_unit_id,group_id,beneficiary_id,action,enrollment_order) REFERENCES whaleu_community.reward_source_units(id,group_id,beneficiary_id,action,enrollment_order),FOREIGN KEY(rating_unit_id,group_id,beneficiary_id,action,enrollment_order) REFERENCES whaleu_ratings.reward_units(id,group_id,beneficiary_id,action,enrollment_order)
);
INSERT INTO whaleu_experience.source_groups SELECT id,'community',source_version,enrollment_order,creation_transaction,id,NULL FROM whaleu_community.reward_source_groups;
INSERT INTO whaleu_experience.source_units SELECT id,'community',group_id,beneficiary_id,action,enrollment_order,id,NULL FROM whaleu_community.reward_source_units;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM whaleu_experience.work w LEFT JOIN whaleu_experience.source_units u ON (u.unit_id,u.group_id,u.beneficiary_id,u.action,u.enrollment_order)=(w.unit_id,w.group_id,w.beneficiary_id,w.action,w.enrollment_order) WHERE u.unit_id IS NULL OR u.source_domain<>'community') OR (SELECT count(*) FROM whaleu_experience.source_units)<>(SELECT count(*) FROM whaleu_community.reward_source_units) OR (SELECT count(*) FROM whaleu_experience.source_groups)<>(SELECT count(*) FROM whaleu_community.reward_source_groups) THEN RAISE EXCEPTION 'Experience bridge migration does not reconcile';END IF;END $$;
ALTER TABLE whaleu_experience.work ADD CONSTRAINT work_typed_source_fk FOREIGN KEY(unit_id,group_id,beneficiary_id,action,enrollment_order) REFERENCES whaleu_experience.source_units(unit_id,group_id,beneficiary_id,action,enrollment_order) NOT VALID;
ALTER TABLE whaleu_experience.work VALIDATE CONSTRAINT work_typed_source_fk;
DO $$ DECLARE c record;BEGIN FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='whaleu_experience.work'::regclass AND confrelid='whaleu_community.reward_source_units'::regclass LOOP EXECUTE format('ALTER TABLE whaleu_experience.work DROP CONSTRAINT %I',c.conname);END LOOP;END $$;
CREATE FUNCTION whaleu_experience.register_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE domain text:=CASE TG_TABLE_SCHEMA WHEN 'whaleu_community' THEN 'community' ELSE 'ratings' END;
BEGIN
 IF TG_TABLE_NAME IN ('reward_source_groups','reward_groups') THEN
 INSERT INTO whaleu_experience.source_groups VALUES(NEW.id,domain,NEW.source_version,NEW.enrollment_order,NEW.creation_transaction,CASE WHEN domain='community' THEN NEW.id END,CASE WHEN domain='ratings' THEN NEW.id END);
 ELSE INSERT INTO whaleu_experience.source_units VALUES(NEW.id,domain,NEW.group_id,NEW.beneficiary_id,NEW.action,NEW.enrollment_order,CASE WHEN domain='community' THEN NEW.id END,CASE WHEN domain='ratings' THEN NEW.id END);END IF;RETURN NULL;
END $$;
CREATE FUNCTION whaleu_experience.source_bridge_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE exact boolean:=false;
BEGIN
 IF pg_trigger_depth()<2 THEN RAISE EXCEPTION 'Registry is source-owned' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='source_groups' THEN
 IF NEW.source_domain='community' THEN SELECT ROW(g.id,g.source_version,g.enrollment_order,g.creation_transaction) IS NOT DISTINCT FROM ROW(NEW.group_id,NEW.source_version,NEW.enrollment_order,NEW.creation_transaction) INTO exact FROM whaleu_community.reward_source_groups g WHERE g.id=NEW.community_group_id;
 ELSE SELECT ROW(g.id,g.source_version,g.enrollment_order,g.creation_transaction) IS NOT DISTINCT FROM ROW(NEW.group_id,NEW.source_version,NEW.enrollment_order,NEW.creation_transaction) INTO exact FROM whaleu_ratings.reward_groups g WHERE g.id=NEW.rating_group_id;END IF;
 IF NEW.creation_transaction<>pg_current_xact_id() THEN RAISE EXCEPTION 'Registry source is not fresh' USING ERRCODE='23514';END IF;
 ELSE
 IF NEW.source_domain='community' THEN SELECT ROW(u.id,u.group_id,u.beneficiary_id,u.action,u.enrollment_order) IS NOT DISTINCT FROM ROW(NEW.unit_id,NEW.group_id,NEW.beneficiary_id,NEW.action,NEW.enrollment_order) AND g.creation_transaction=pg_current_xact_id() INTO exact FROM whaleu_community.reward_source_units u JOIN whaleu_community.reward_source_groups g ON g.id=u.group_id WHERE u.id=NEW.community_unit_id;
 ELSE SELECT ROW(u.id,u.group_id,u.beneficiary_id,u.action,u.enrollment_order) IS NOT DISTINCT FROM ROW(NEW.unit_id,NEW.group_id,NEW.beneficiary_id,NEW.action,NEW.enrollment_order) AND g.creation_transaction=pg_current_xact_id() INTO exact FROM whaleu_ratings.reward_units u JOIN whaleu_ratings.reward_groups g ON g.id=u.group_id WHERE u.id=NEW.rating_unit_id;END IF;
 END IF;
 IF exact IS DISTINCT FROM true THEN RAISE EXCEPTION 'Registry exact source mismatch' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER source_group_guard BEFORE INSERT ON whaleu_experience.source_groups FOR EACH ROW EXECUTE FUNCTION whaleu_experience.source_bridge_guard();
CREATE TRIGGER source_unit_guard BEFORE INSERT ON whaleu_experience.source_units FOR EACH ROW EXECUTE FUNCTION whaleu_experience.source_bridge_guard();
CREATE TRIGGER register_experience_source AFTER INSERT ON whaleu_community.reward_source_groups FOR EACH ROW EXECUTE FUNCTION whaleu_experience.register_source();
CREATE TRIGGER register_experience_source AFTER INSERT ON whaleu_community.reward_source_units FOR EACH ROW EXECUTE FUNCTION whaleu_experience.register_source();
CREATE TRIGGER register_experience_source AFTER INSERT ON whaleu_ratings.reward_groups FOR EACH ROW EXECUTE FUNCTION whaleu_experience.register_source();
CREATE TRIGGER register_experience_source AFTER INSERT ON whaleu_ratings.reward_units FOR EACH ROW EXECUTE FUNCTION whaleu_experience.register_source();
CREATE OR REPLACE FUNCTION whaleu_experience.enrollment_complete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_experience.source_groups WHERE enrollment_order=NEW.enrollment_order AND creation_transaction=NEW.creation_transaction) THEN RAISE EXCEPTION 'Experience enrollment reservation is incomplete' USING ERRCODE='23514';END IF;RETURN NULL;END $$;
CREATE FUNCTION whaleu_ratings.effect_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event uuid;e whaleu_ratings.effect_events;g whaleu_ratings.reward_groups;
BEGIN
 IF TG_TABLE_NAME='effect_events' THEN event:=NEW.id;ELSE event:=NEW.event_id;END IF;
 SELECT * INTO e FROM whaleu_ratings.effect_events WHERE id=event;SELECT * INTO g FROM whaleu_ratings.reward_groups WHERE event_id=event;
 IF e.expected_experience_units=0 THEN
 IF g.id IS NOT NULL THEN RAISE EXCEPTION 'Deleted ratings cannot grant or deduct experience' USING ERRCODE='23514';END IF;
 ELSE
 IF g.id IS NULL OR (SELECT count(*) FROM whaleu_ratings.reward_units WHERE group_id=g.id)<>e.expected_experience_units OR EXISTS(SELECT 1 FROM whaleu_ratings.expected_reward_units(event) x WHERE NOT EXISTS(SELECT 1 FROM whaleu_ratings.reward_units u WHERE u.group_id=g.id AND (u.beneficiary_id,u.action)=(x.beneficiary_id,x.action))) OR EXISTS(SELECT 1 FROM whaleu_ratings.reward_units u WHERE u.group_id=g.id AND NOT EXISTS(SELECT 1 FROM whaleu_experience.work w WHERE (w.unit_id,w.group_id,w.beneficiary_id,w.action,w.enrollment_order)=(u.id,u.group_id,u.beneficiary_id,u.action,u.enrollment_order))) THEN RAISE EXCEPTION 'Rating reward capture incomplete' USING ERRCODE='23514';END IF;
 END IF;
 IF (SELECT count(*) FROM whaleu_ratings.notice_obligations WHERE event_id=event)<>e.expected_direct_notice_obligations OR EXISTS(SELECT 1 FROM whaleu_ratings.expected_direct_notices(event) x WHERE NOT EXISTS(SELECT 1 FROM whaleu_ratings.notice_obligations n WHERE n.event_id=event AND (n.recipient_account_id,n.reason)=(x.recipient_account_id,x.reason))) THEN RAISE EXCEPTION 'Rating notice capture incomplete' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER rating_effect_complete AFTER INSERT ON whaleu_ratings.effect_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.effect_complete();
CREATE CONSTRAINT TRIGGER rating_reward_group_complete AFTER INSERT ON whaleu_ratings.reward_groups DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.effect_complete();
CREATE CONSTRAINT TRIGGER rating_reward_unit_complete AFTER INSERT ON whaleu_ratings.reward_units DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.effect_complete();
CREATE CONSTRAINT TRIGGER rating_notice_capture_complete AFTER INSERT ON whaleu_ratings.notice_obligations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.effect_complete();
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['effect_events','notice_obligations','reward_groups','reward_units'] LOOP
 EXECUTE format('CREATE TRIGGER rating_immutable BEFORE UPDATE OR DELETE ON whaleu_ratings.%I FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.immutable()',t);
 EXECUTE format('CREATE TRIGGER rating_retain BEFORE TRUNCATE ON whaleu_ratings.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.immutable()',t);END LOOP;
 FOREACH t IN ARRAY ARRAY['source_groups','source_units'] LOOP
 EXECUTE format('CREATE TRIGGER source_immutable BEFORE UPDATE OR DELETE ON whaleu_experience.%I FOR EACH ROW EXECUTE FUNCTION whaleu_experience.immutable_row()',t);
 EXECUTE format('CREATE TRIGGER source_retain BEFORE TRUNCATE ON whaleu_experience.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_experience.immutable_row()',t);END LOOP;END $$;
-- Reverse links also catch a failed/suppressed automatic source insertion.
-- Only future transitions receive this obligation; R1 history is not replayed.
CREATE FUNCTION whaleu_ratings.transition_effect_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='comment_transitions' THEN
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.effect_events e WHERE e.comment_transition_id=NEW.id AND (e.actor_account_id,e.request_id,e.target_id,e.root_id,e.occurred_at,e.mutation_transaction)=(NEW.account_id,NEW.request_id,NEW.target_id,NEW.comment_id,NEW.occurred_at,NEW.mutation_transaction)) THEN RAISE EXCEPTION 'Root transition effect missing' USING ERRCODE='23514';END IF;
 ELSE
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.effect_events e WHERE e.reply_transition_id=NEW.id AND (e.actor_account_id,e.request_id,e.target_id,e.root_id,e.reply_id,e.occurred_at,e.mutation_transaction)=(NEW.account_id,NEW.request_id,NEW.target_id,NEW.root_id,NEW.reply_id,NEW.occurred_at,NEW.mutation_transaction)) THEN RAISE EXCEPTION 'Reply transition effect missing' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.reply_heads h WHERE h.root_id=NEW.root_id AND h.target_id=NEW.target_id AND h.sequence>=NEW.sequence AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.reply_transitions later WHERE later.root_id=h.root_id AND later.sequence>h.sequence)) THEN RAISE EXCEPTION 'Reply continuation head incomplete' USING ERRCODE='23514';END IF;
 END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER rating_root_effect_complete AFTER INSERT ON whaleu_ratings.comment_transitions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.transition_effect_complete();
CREATE CONSTRAINT TRIGGER rating_reply_effect_complete AFTER INSERT ON whaleu_ratings.reply_transitions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.transition_effect_complete();
ALTER TABLE whaleu_ratings.effect_events ADD CHECK(event_sequence>0);
