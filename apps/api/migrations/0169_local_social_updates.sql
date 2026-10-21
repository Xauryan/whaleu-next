-- Fresh local social notifications. No historical INSERT/SELECT adoption.
ALTER TABLE whaleu_community.user_follows ADD COLUMN source_request_id uuid;
ALTER TABLE whaleu_community.user_follows ADD COLUMN local_creation_transaction xid8;
ALTER TABLE whaleu_community.user_follows ALTER COLUMN local_creation_transaction SET DEFAULT pg_current_xact_id();
CREATE TRIGGER social_follow_provenance BEFORE INSERT OR UPDATE ON whaleu_community.user_follows
 FOR EACH ROW EXECUTE FUNCTION whaleu_community.reward_insert_provenance();
ALTER TABLE whaleu_community.follow_requests ADD COLUMN local_creation_transaction xid8;
ALTER TABLE whaleu_community.follow_requests ALTER COLUMN local_creation_transaction SET DEFAULT pg_current_xact_id();
CREATE TRIGGER social_follow_request_provenance BEFORE INSERT OR UPDATE ON whaleu_community.follow_requests
 FOR EACH ROW EXECUTE FUNCTION whaleu_community.reward_insert_provenance();

CREATE TABLE whaleu_community.social_sources (
 id uuid PRIMARY KEY,
 kind text NOT NULL CHECK(kind IN ('like','save','follow')),
 actor_account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 recipient_account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 resource_kind text NOT NULL CHECK(resource_kind IN ('post','comment','reply','profile')),
 resource_id uuid NOT NULL,
 post_id uuid, root_comment_id uuid, reply_id uuid, target_reply_id uuid,
 source_epoch_id uuid NOT NULL,
 reward_group_id uuid UNIQUE REFERENCES whaleu_community.reward_source_groups(id),
 occurred_at timestamptz NOT NULL CHECK(isfinite(occurred_at)),
 creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 UNIQUE(actor_account_id,kind,resource_kind,source_epoch_id),
 UNIQUE(id,recipient_account_id,kind),
 CHECK(actor_account_id<>recipient_account_id),
 CHECK((kind='follow' AND resource_kind='profile' AND post_id IS NULL AND root_comment_id IS NULL AND reply_id IS NULL AND target_reply_id IS NULL AND reward_group_id IS NULL)
  OR (kind IN ('like','save') AND reward_group_id IS NOT NULL AND post_id IS NOT NULL AND resource_kind<>'profile')),
 CHECK(kind<>'save' OR resource_kind='post')
);
CREATE FUNCTION whaleu_community.social_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE g whaleu_community.reward_source_groups; e whaleu_community.user_follows; r whaleu_community.follow_requests;
BEGIN
 NEW.creation_transaction:=pg_current_xact_id();
 IF NEW.kind='follow' THEN
  SELECT * INTO e FROM whaleu_community.user_follows WHERE follower_id=NEW.actor_account_id AND followed_id=NEW.recipient_account_id;
  SELECT * INTO r FROM whaleu_community.follow_requests WHERE account_id=NEW.actor_account_id AND request_id=NEW.source_epoch_id;
  IF e.follower_id IS NULL OR r.account_id IS NULL OR e.local_creation_transaction IS DISTINCT FROM pg_current_xact_id()
   OR r.local_creation_transaction IS DISTINCT FROM pg_current_xact_id() OR r.outcome<>'applied' OR NOT r.following
   OR e.source_request_id IS DISTINCT FROM NEW.source_epoch_id
   OR e.followed_profile_id<>NEW.resource_id OR r.profile_id<>NEW.resource_id OR e.created_at<>NEW.occurred_at THEN
   RAISE EXCEPTION 'Social follow requires a fresh positive edge and its applied receipt' USING ERRCODE='23514';
  END IF;
 ELSE
  SELECT * INTO g FROM whaleu_community.reward_source_groups WHERE id=NEW.reward_group_id;
  IF g.id IS NULL OR g.creation_transaction IS DISTINCT FROM pg_current_xact_id()
   OR g.actor_account_id<>NEW.actor_account_id OR g.resource_author_id<>NEW.recipient_account_id
   OR g.resource_kind<>NEW.resource_kind OR coalesce(g.reply_id,g.root_comment_id,g.post_id)<>NEW.resource_id
   OR g.post_id IS DISTINCT FROM NEW.post_id OR g.root_comment_id IS DISTINCT FROM NEW.root_comment_id
   OR g.reply_id IS DISTINCT FROM NEW.reply_id OR g.target_reply_id IS DISTINCT FROM NEW.target_reply_id
   OR g.occurred_at<>NEW.occurred_at OR coalesce(g.like_id,g.save_epoch_id) IS DISTINCT FROM NEW.source_epoch_id
   OR (NEW.kind='like' AND g.event_type NOT IN ('post_liked','comment_liked','reply_liked'))
   OR (NEW.kind='save' AND g.event_type<>'post_saved') THEN
   RAISE EXCEPTION 'Social interaction requires exact fresh immutable source facts' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER social_source_guard BEFORE INSERT ON whaleu_community.social_sources FOR EACH ROW EXECUTE FUNCTION whaleu_community.social_source_guard();
CREATE TRIGGER social_source_immutable BEFORE UPDATE OR DELETE ON whaleu_community.social_sources FOR EACH ROW EXECUTE FUNCTION whaleu_experience.immutable_row();

CREATE TABLE whaleu_notifications.social_work (
 source_id uuid PRIMARY KEY,
 recipient_account_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('like','save','follow')),
 automatic_eligible boolean NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','completed')),
 enrolled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(source_id,recipient_account_id,kind) REFERENCES whaleu_community.social_sources(id,recipient_account_id,kind)
);
CREATE INDEX social_pending ON whaleu_notifications.social_work(next_attempt_at,enrolled_at,source_id) WHERE state='pending' AND automatic_eligible;
CREATE INDEX social_owner_pending ON whaleu_notifications.social_work(recipient_account_id,kind) WHERE state='pending';
CREATE SEQUENCE whaleu_notifications.social_notice_order;
CREATE TABLE whaleu_notifications.social_notices (
 id uuid PRIMARY KEY,
 source_id uuid NOT NULL UNIQUE,
 recipient_account_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('like','save','follow')),
 dedupe_key text NOT NULL CHECK(dedupe_key ~ '^[a-f0-9]{64}$'),
 ordinal bigint NOT NULL UNIQUE,
 created_at timestamptz NOT NULL CHECK(isfinite(created_at)),
 read_at timestamptz CHECK(read_at IS NULL OR isfinite(read_at)),
 FOREIGN KEY(source_id,recipient_account_id,kind) REFERENCES whaleu_community.social_sources(id,recipient_account_id,kind),
 UNIQUE(recipient_account_id,kind,dedupe_key),
 UNIQUE(id,recipient_account_id,kind)
);
-- Allocate order only after the owner lock, including internal/direct SQL writers.
-- A smaller same-owner ordinal can therefore never commit after a higher one.
CREATE FUNCTION whaleu_notifications.social_notice_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_at timestamptz;
BEGIN
 SELECT occurred_at INTO source_at FROM whaleu_community.social_sources WHERE id=NEW.source_id
  AND recipient_account_id=NEW.recipient_account_id AND kind=NEW.kind;
 IF source_at IS NULL OR NEW.created_at IS DISTINCT FROM source_at THEN
  RAISE EXCEPTION 'Social notice time must equal its immutable first source' USING ERRCODE='23514';
 END IF;
 INSERT INTO whaleu_notifications.owners(account_id) VALUES(NEW.recipient_account_id) ON CONFLICT DO NOTHING;
 PERFORM account_id FROM whaleu_notifications.owners WHERE account_id=NEW.recipient_account_id FOR UPDATE;
 NEW.ordinal:=nextval('whaleu_notifications.social_notice_order');
 RETURN NEW;
END $$;
CREATE TRIGGER social_notice_insert_guard BEFORE INSERT ON whaleu_notifications.social_notices FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.social_notice_insert_guard();
CREATE INDEX social_notice_ordinal ON whaleu_notifications.social_notices(recipient_account_id,kind,ordinal DESC);
CREATE INDEX social_notice_page ON whaleu_notifications.social_notices(recipient_account_id,kind,created_at DESC,ordinal DESC);
CREATE INDEX social_notice_unread ON whaleu_notifications.social_notices(recipient_account_id,kind,ordinal DESC) WHERE read_at IS NULL;
CREATE TABLE whaleu_notifications.social_receipts (
 source_id uuid PRIMARY KEY,
 recipient_account_id uuid NOT NULL,
 kind text NOT NULL,
 outcome text NOT NULL CHECK(outcome IN ('materialized','existing')),
 notice_id uuid NOT NULL,
 settled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(source_id,recipient_account_id,kind) REFERENCES whaleu_community.social_sources(id,recipient_account_id,kind),
 FOREIGN KEY(notice_id,recipient_account_id,kind) REFERENCES whaleu_notifications.social_notices(id,recipient_account_id,kind)
);
CREATE TRIGGER social_receipt_immutable BEFORE UPDATE OR DELETE ON whaleu_notifications.social_receipts FOR EACH ROW EXECUTE FUNCTION whaleu_experience.immutable_row();
CREATE FUNCTION whaleu_notifications.social_notice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(OLD)-'read_at') IS DISTINCT FROM (to_jsonb(NEW)-'read_at')
  OR (OLD.read_at IS NOT NULL AND OLD.read_at IS DISTINCT FROM NEW.read_at) OR NEW.read_at IS NULL THEN
  RAISE EXCEPTION 'Social notices preserve immutable evidence and first read time' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER social_notice_immutable BEFORE UPDATE OR DELETE ON whaleu_notifications.social_notices FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.social_notice_guard();
CREATE FUNCTION whaleu_notifications.social_completeness() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sid uuid; w whaleu_notifications.social_work; r whaleu_notifications.social_receipts; n whaleu_notifications.social_notices; s whaleu_community.social_sources; expected_key text;
BEGIN
 sid:=coalesce((to_jsonb(NEW)->>'source_id')::uuid,(to_jsonb(NEW)->>'id')::uuid);
 SELECT * INTO w FROM whaleu_notifications.social_work WHERE source_id=sid;
 SELECT * INTO r FROM whaleu_notifications.social_receipts WHERE source_id=sid;
 IF w.source_id IS NULL OR ((w.state='completed')<>(r.source_id IS NOT NULL)) THEN
  RAISE EXCEPTION 'Social source requires complete independent work and receipt' USING ERRCODE='23514';
 END IF;
 IF TG_TABLE_NAME='social_notices' AND (r.notice_id IS DISTINCT FROM (to_jsonb(NEW)->>'id')::uuid OR r.outcome IS DISTINCT FROM 'materialized') THEN
  RAISE EXCEPTION 'Social notice requires exact materialized receipt' USING ERRCODE='23514';
 END IF;
 IF r.source_id IS NOT NULL THEN
  SELECT * INTO n FROM whaleu_notifications.social_notices WHERE id=r.notice_id;
  SELECT * INTO s FROM whaleu_community.social_sources WHERE id=sid;
  expected_key:=encode(sha256(convert_to(concat_ws(':','social-lifetime-v1',s.recipient_account_id::text,s.actor_account_id::text,s.kind,s.resource_kind,s.resource_id::text),'UTF8')),'hex');
  IF n.dedupe_key IS DISTINCT FROM expected_key OR (r.outcome='materialized' AND (n.source_id IS DISTINCT FROM sid OR n.created_at IS DISTINCT FROM s.occurred_at)) THEN
   RAISE EXCEPTION 'Social notice receipt source mismatch' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER social_source_complete AFTER INSERT ON whaleu_community.social_sources DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.social_completeness();
CREATE CONSTRAINT TRIGGER social_work_complete AFTER INSERT OR UPDATE ON whaleu_notifications.social_work DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.social_completeness();
CREATE CONSTRAINT TRIGGER social_receipt_complete AFTER INSERT ON whaleu_notifications.social_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.social_completeness();
CREATE CONSTRAINT TRIGGER social_notice_complete AFTER INSERT ON whaleu_notifications.social_notices DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.social_completeness();

CREATE FUNCTION whaleu_notifications.social_work_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(OLD)-ARRAY['state','attempts','next_attempt_at']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['state','attempts','next_attempt_at'])
  OR (OLD.state='completed' AND NEW IS DISTINCT FROM OLD) OR NEW.attempts<OLD.attempts THEN
  RAISE EXCEPTION 'Social work identity and completed state are immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER social_work_guard BEFORE UPDATE OR DELETE ON whaleu_notifications.social_work FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.social_work_guard();

CREATE FUNCTION whaleu_community.social_follow_edge_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.source_request_id IS DISTINCT FROM OLD.source_request_id OR NEW.follower_id<>OLD.follower_id OR NEW.followed_id<>OLD.followed_id
  OR NEW.followed_profile_id<>OLD.followed_profile_id OR NEW.created_at<>OLD.created_at THEN
  RAISE EXCEPTION 'Follow edge epoch is immutable; remove then follow again' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER social_follow_edge_guard BEFORE UPDATE ON whaleu_community.user_follows FOR EACH ROW EXECUTE FUNCTION whaleu_community.social_follow_edge_guard();
CREATE TRIGGER social_follow_receipt_immutable BEFORE UPDATE OR DELETE ON whaleu_community.follow_requests FOR EACH ROW EXECUTE FUNCTION whaleu_experience.immutable_row();
