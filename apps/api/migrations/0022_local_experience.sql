-- Fresh local experience only. No historical adoption, balance backfill or grants.
ALTER TABLE whaleu_identity.accounts ADD COLUMN local_creation_transaction xid8;
ALTER TABLE whaleu_identity.accounts ALTER COLUMN local_creation_transaction SET DEFAULT pg_current_xact_id();
CREATE FUNCTION whaleu_identity.account_creation_provenance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN NEW.local_creation_transaction:=pg_current_xact_id();
  ELSIF OLD.local_creation_transaction IS DISTINCT FROM NEW.local_creation_transaction THEN
    RAISE EXCEPTION 'Account creation provenance is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER account_creation_provenance BEFORE INSERT OR UPDATE ON whaleu_identity.accounts FOR EACH ROW EXECUTE FUNCTION whaleu_identity.account_creation_provenance();
CREATE SCHEMA whaleu_experience;
CREATE FUNCTION whaleu_experience.immutable_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Experience evidence is immutable' USING ERRCODE='23514'; END $$;
CREATE TABLE whaleu_experience.title_catalog (
  title_key text PRIMARY KEY, name text NOT NULL, kind text NOT NULL CHECK(kind IN ('default','level')),
  unlock_level integer CHECK(unlock_level BETWEEN 1 AND 30),
  CHECK((kind='level')=(unlock_level IS NOT NULL))
);
INSERT INTO whaleu_experience.title_catalog VALUES
('default_jingxiaoyu','鲸小语','default',NULL),
('level_1','萌新小白','level',1),('level_3','初来乍到','level',3),('level_5','崭露头角','level',5),
('level_7','小有名气','level',7),('level_9','活跃分子','level',9),('level_11','社区新星','level',11),
('level_13','人气达人','level',13),('level_15','校园红人','level',15),('level_17','意见领袖','level',17),
('level_19','社区元老','level',19),('level_21','校园名人','level',21),('level_23','风云人物','level',23),
('level_25','传奇人物','level',25),('level_27','校园之光','level',27),('level_29','一代宗师','level',29);
CREATE TABLE whaleu_experience.level_catalog(level integer PRIMARY KEY CHECK(level BETWEEN 1 AND 30),threshold bigint NOT NULL UNIQUE CHECK(threshold>=0));
INSERT INTO whaleu_experience.level_catalog SELECT ordinality,value FROM unnest(ARRAY[0,15,40,80,140,220,330,470,650,880,1150,1480,1880,2350,2900,3500,4150,4850,5600,6400,7250,8150,9100,10100,11150,12250,13400,14600,15850,17150]::bigint[]) WITH ORDINALITY AS x(value,ordinality);
CREATE TABLE whaleu_experience.color_catalog(color_id integer PRIMARY KEY CHECK(color_id BETWEEN 0 AND 25),unlock_level integer NOT NULL REFERENCES whaleu_experience.level_catalog(level));
INSERT INTO whaleu_experience.color_catalog SELECT x,CASE WHEN x<=10 THEN 1 ELSE (x-10)*2 END FROM generate_series(0,25) x;
CREATE TRIGGER title_catalog_immutable BEFORE UPDATE OR DELETE ON whaleu_experience.title_catalog FOR EACH ROW EXECUTE FUNCTION whaleu_experience.immutable_row();
CREATE TRIGGER level_catalog_immutable BEFORE UPDATE OR DELETE ON whaleu_experience.level_catalog FOR EACH ROW EXECUTE FUNCTION whaleu_experience.immutable_row();
CREATE TRIGGER color_catalog_immutable BEFORE UPDATE OR DELETE ON whaleu_experience.color_catalog FOR EACH ROW EXECUTE FUNCTION whaleu_experience.immutable_row();
CREATE TABLE whaleu_experience.owners(owner_id uuid PRIMARY KEY REFERENCES whaleu_identity.accounts(id));
CREATE SEQUENCE whaleu_experience.enrollment_order;
CREATE TABLE whaleu_experience.enrollments (
  enrollment_order bigint PRIMARY KEY,creation_transaction xid8 NOT NULL,
  UNIQUE(enrollment_order,creation_transaction)
);
CREATE FUNCTION whaleu_experience.enrollment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('experience-enrollment',0));
  NEW.enrollment_order:=nextval('whaleu_experience.enrollment_order');
  NEW.creation_transaction:=pg_current_xact_id();
  RETURN NEW;
END $$;
CREATE TRIGGER enrollment_guard BEFORE INSERT ON whaleu_experience.enrollments FOR EACH ROW EXECUTE FUNCTION whaleu_experience.enrollment_guard();
CREATE TRIGGER enrollment_immutable BEFORE UPDATE OR DELETE ON whaleu_experience.enrollments FOR EACH ROW EXECUTE FUNCTION whaleu_experience.immutable_row();
CREATE TABLE whaleu_experience.baselines (
  owner_id uuid PRIMARY KEY REFERENCES whaleu_experience.owners(owner_id),
  origin text NOT NULL CHECK(origin IN ('native_account_creation','synthetic_fixture')),
  opening_balance bigint NOT NULL CHECK(opening_balance>=0),
  opening_signin_day date CHECK(opening_signin_day IS NULL OR isfinite(opening_signin_day)),
  opening_streak integer NOT NULL CHECK(opening_streak BETWEEN 0 AND 7),
  history_coverage text NOT NULL CHECK(history_coverage IN ('complete','partial')),
  entitlement_coverage text NOT NULL CHECK(entitlement_coverage IN ('complete','partial')),
  rule_version text NOT NULL DEFAULT 'local-experience-v1' CHECK(rule_version='local-experience-v1'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(recorded_at)),
  CHECK((opening_signin_day IS NULL)=(opening_streak=0))
);
CREATE FUNCTION whaleu_experience.synthetic_fixture_allowed() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT current_database()='whaleu_test'
$$;
CREATE FUNCTION whaleu_experience.baseline_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.origin='native_account_creation' THEN
    IF NOT EXISTS(SELECT 1 FROM whaleu_identity.accounts WHERE id=NEW.owner_id AND local_creation_transaction=pg_current_xact_id()) OR
      NEW.opening_balance<>0 OR NEW.opening_streak<>0 OR NEW.opening_signin_day IS NOT NULL OR NEW.history_coverage<>'complete' OR NEW.entitlement_coverage<>'complete' THEN
      RAISE EXCEPTION 'Native baseline requires new account transaction' USING ERRCODE='23514';
    END IF;
  ELSIF NOT whaleu_experience.synthetic_fixture_allowed() THEN RAISE EXCEPTION 'Synthetic fixture is local test only' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER baseline_guard BEFORE INSERT ON whaleu_experience.baselines FOR EACH ROW EXECUTE FUNCTION whaleu_experience.baseline_guard();
CREATE TRIGGER baseline_immutable BEFORE UPDATE OR DELETE ON whaleu_experience.baselines FOR EACH ROW EXECUTE FUNCTION whaleu_experience.immutable_row();
CREATE TABLE whaleu_experience.account_states (
  owner_id uuid PRIMARY KEY REFERENCES whaleu_experience.baselines(owner_id),balance bigint NOT NULL CHECK(balance>=0),
  last_signin_day date CHECK(last_signin_day IS NULL OR isfinite(last_signin_day)),streak integer NOT NULL CHECK(streak BETWEEN 0 AND 7),
  revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
  CHECK((last_signin_day IS NULL)=(streak=0))
);
-- Integration fragment: place after experience.enrollments and before experience.work.
-- Future-only provenance does not adopt preexisting content, memberships or obligations.
ALTER TABLE whaleu_community.posts ADD COLUMN local_creation_transaction xid8;
ALTER TABLE whaleu_community.posts ALTER COLUMN local_creation_transaction SET DEFAULT pg_current_xact_id();
ALTER TABLE whaleu_community.posts ADD COLUMN local_deletion_transaction xid8;
ALTER TABLE whaleu_community.root_comments ADD COLUMN local_creation_transaction xid8;
ALTER TABLE whaleu_community.root_comments ALTER COLUMN local_creation_transaction SET DEFAULT pg_current_xact_id();
ALTER TABLE whaleu_community.root_comments ADD COLUMN local_deletion_transaction xid8;
ALTER TABLE whaleu_community.replies ADD COLUMN local_creation_transaction xid8;
ALTER TABLE whaleu_community.replies ALTER COLUMN local_creation_transaction SET DEFAULT pg_current_xact_id();
ALTER TABLE whaleu_community.replies ADD COLUMN local_deletion_transaction xid8;
ALTER TABLE whaleu_community.post_likes ADD COLUMN local_creation_transaction xid8;
ALTER TABLE whaleu_community.post_likes ALTER COLUMN local_creation_transaction SET DEFAULT pg_current_xact_id();
ALTER TABLE whaleu_community.comment_likes ADD COLUMN local_creation_transaction xid8;
ALTER TABLE whaleu_community.comment_likes ALTER COLUMN local_creation_transaction SET DEFAULT pg_current_xact_id();
ALTER TABLE whaleu_community.reply_likes ADD COLUMN local_creation_transaction xid8;
ALTER TABLE whaleu_community.reply_likes ALTER COLUMN local_creation_transaction SET DEFAULT pg_current_xact_id();
ALTER TABLE whaleu_community.saved_epochs ADD COLUMN local_creation_transaction xid8;
ALTER TABLE whaleu_community.saved_epochs ALTER COLUMN local_creation_transaction SET DEFAULT pg_current_xact_id();
ALTER TABLE whaleu_community.saved_obligations ADD COLUMN local_creation_transaction xid8;
ALTER TABLE whaleu_community.saved_obligations ALTER COLUMN local_creation_transaction SET DEFAULT pg_current_xact_id();

CREATE FUNCTION whaleu_community.reward_content_provenance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    NEW.local_creation_transaction:=pg_current_xact_id();
    NEW.local_deletion_transaction:=NULL;
  ELSE
    IF NEW.local_creation_transaction IS DISTINCT FROM OLD.local_creation_transaction THEN
      RAISE EXCEPTION 'Content creation provenance is immutable' USING ERRCODE='23514';
    END IF;
    IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
      NEW.local_deletion_transaction:=pg_current_xact_id();
    ELSIF NEW.local_deletion_transaction IS DISTINCT FROM OLD.local_deletion_transaction THEN
      RAISE EXCEPTION 'Deletion proof requires an actual transition' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
-- Existing content-definition guards run first; only this final trusted hook
-- stamps actual deletion provenance without exempting fields from older guards.
CREATE TRIGGER z_reward_content_provenance BEFORE INSERT OR UPDATE ON whaleu_community.posts FOR EACH ROW EXECUTE FUNCTION whaleu_community.reward_content_provenance();
CREATE TRIGGER z_reward_content_provenance BEFORE INSERT OR UPDATE ON whaleu_community.root_comments FOR EACH ROW EXECUTE FUNCTION whaleu_community.reward_content_provenance();
CREATE TRIGGER z_reward_content_provenance BEFORE INSERT OR UPDATE ON whaleu_community.replies FOR EACH ROW EXECUTE FUNCTION whaleu_community.reward_content_provenance();
CREATE FUNCTION whaleu_community.reward_insert_provenance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN NEW.local_creation_transaction:=pg_current_xact_id();
  ELSIF NEW.local_creation_transaction IS DISTINCT FROM OLD.local_creation_transaction THEN
    RAISE EXCEPTION 'Reward source creation provenance is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reward_insert_provenance BEFORE INSERT OR UPDATE ON whaleu_community.post_likes FOR EACH ROW EXECUTE FUNCTION whaleu_community.reward_insert_provenance();
CREATE TRIGGER reward_insert_provenance BEFORE INSERT OR UPDATE ON whaleu_community.comment_likes FOR EACH ROW EXECUTE FUNCTION whaleu_community.reward_insert_provenance();
CREATE TRIGGER reward_insert_provenance BEFORE INSERT OR UPDATE ON whaleu_community.reply_likes FOR EACH ROW EXECUTE FUNCTION whaleu_community.reward_insert_provenance();
CREATE TRIGGER reward_insert_provenance BEFORE INSERT OR UPDATE ON whaleu_community.saved_epochs FOR EACH ROW EXECUTE FUNCTION whaleu_community.reward_insert_provenance();
CREATE TRIGGER reward_insert_provenance BEFORE INSERT OR UPDATE ON whaleu_community.saved_obligations FOR EACH ROW EXECUTE FUNCTION whaleu_community.reward_insert_provenance();

CREATE TABLE whaleu_community.reward_source_groups (
  id uuid PRIMARY KEY,
  source_version smallint NOT NULL DEFAULT 1 CHECK(source_version=1),
  event_id uuid NOT NULL UNIQUE REFERENCES whaleu_community.outbox(id),
  event_type text NOT NULL CHECK(event_type IN ('post_created','comment_created','reply_created','post_liked','comment_liked','reply_liked','post_saved','post_deleted','comment_deleted','reply_deleted')),
  resource_kind text NOT NULL CHECK(resource_kind IN ('post','comment','reply')),
  post_id uuid NOT NULL REFERENCES whaleu_community.posts(id),
  root_comment_id uuid,
  reply_id uuid,
  target_reply_id uuid,
  save_epoch_id uuid UNIQUE REFERENCES whaleu_community.saved_epochs(id),
  like_id uuid,
  actor_account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
  actor_author_mode text CHECK(actor_author_mode IN ('named','anonymous')),
  resource_author_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
  resource_author_mode text NOT NULL CHECK(resource_author_mode IN ('named','anonymous')),
  post_author_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
  root_author_id uuid REFERENCES whaleu_identity.accounts(id),
  target_reply_author_id uuid REFERENCES whaleu_identity.accounts(id),
  occurred_at timestamptz NOT NULL CHECK(isfinite(occurred_at)),
  enrollment_order bigint NOT NULL UNIQUE,
  expected_unit_count smallint NOT NULL CHECK(expected_unit_count BETWEEN 1 AND 3),
  creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
  UNIQUE(id,enrollment_order),
  UNIQUE(resource_kind,like_id),
  FOREIGN KEY(enrollment_order,creation_transaction) REFERENCES whaleu_experience.enrollments(enrollment_order,creation_transaction),
  FOREIGN KEY(root_comment_id,post_id) REFERENCES whaleu_community.root_comments(id,post_id),
  FOREIGN KEY(reply_id,root_comment_id,post_id) REFERENCES whaleu_community.replies(id,root_comment_id,post_id),
  FOREIGN KEY(target_reply_id,root_comment_id,post_id) REFERENCES whaleu_community.replies(id,root_comment_id,post_id),
  CHECK((resource_kind='post' AND root_comment_id IS NULL AND reply_id IS NULL AND root_author_id IS NULL) OR
        (resource_kind='comment' AND root_comment_id IS NOT NULL AND reply_id IS NULL AND root_author_id IS NOT NULL) OR
        (resource_kind='reply' AND root_comment_id IS NOT NULL AND reply_id IS NOT NULL AND root_author_id IS NOT NULL)),
  CHECK((target_reply_id IS NULL)=(target_reply_author_id IS NULL)),
  CHECK(resource_kind='reply' OR target_reply_id IS NULL),
  CHECK((event_type='post_saved')=(save_epoch_id IS NOT NULL)),
  CHECK((event_type IN ('post_liked','comment_liked','reply_liked'))=(like_id IS NOT NULL)),
  CHECK((event_type IN ('post_liked','comment_liked','reply_liked','post_saved'))=(actor_author_mode IS NULL)),
  CHECK((resource_kind='post' AND event_type IN ('post_created','post_deleted','post_liked','post_saved')) OR
        (resource_kind='comment' AND event_type IN ('comment_created','comment_deleted','comment_liked')) OR
        (resource_kind='reply' AND event_type IN ('reply_created','reply_deleted','reply_liked')))
);
CREATE TABLE whaleu_community.reward_source_units (
  id uuid PRIMARY KEY,
  group_id uuid NOT NULL,
  beneficiary_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
  action text NOT NULL CHECK(action IN ('publish','comment','like_save','received_like_save','received_comment','delete_post','delete_comment','delete_reply')),
  enrollment_order bigint NOT NULL,
  outbox_event_id uuid REFERENCES whaleu_community.outbox(id),
  saved_obligation_id uuid UNIQUE REFERENCES whaleu_community.saved_obligations(id),
  UNIQUE(id,group_id,beneficiary_id,action,enrollment_order),
  UNIQUE(group_id,beneficiary_id,action),
  UNIQUE(outbox_event_id,beneficiary_id,action),
  FOREIGN KEY(group_id,enrollment_order) REFERENCES whaleu_community.reward_source_groups(id,enrollment_order),
  CHECK((outbox_event_id IS NULL)<>(saved_obligation_id IS NULL))
);

CREATE FUNCTION whaleu_community.reward_source_group_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e whaleu_community.outbox; p whaleu_community.posts; c whaleu_community.root_comments; r whaleu_community.replies; t whaleu_community.replies;
  epoch whaleu_community.saved_epochs; source_owner uuid; source_mode text; source_created timestamptz; source_deleted timestamptz;
  source_create_xid xid8; source_delete_xid xid8; source_id uuid; membership record; expected_mode text; expected_recipients jsonb; expected_obligations jsonb;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Reward source group is immutable' USING ERRCODE='23514'; END IF;
  IF NEW.creation_transaction<>pg_current_xact_id() THEN RAISE EXCEPTION 'Reward source must be fresh' USING ERRCODE='23514'; END IF;
  SELECT * INTO e FROM whaleu_community.outbox WHERE id=NEW.event_id;
  IF e.id IS NULL OR e.local_creation_transaction IS DISTINCT FROM pg_current_xact_id() OR e.event_type<>NEW.event_type OR
    e.context->'experienceSourceVersion' IS DISTINCT FROM '1'::jsonb OR e.context->>'actorAccountId' IS DISTINCT FROM NEW.actor_account_id::text THEN
    RAISE EXCEPTION 'Reward outbox source is not a fresh supported transition' USING ERRCODE='23514';
  END IF;
  SELECT * INTO p FROM whaleu_community.posts WHERE id=NEW.post_id;
  IF p.id IS NULL OR NEW.post_author_id<>p.account_id THEN RAISE EXCEPTION 'Reward parent snapshot disagrees' USING ERRCODE='23514'; END IF;
  IF NEW.resource_kind='post' THEN
    source_id:=p.id; source_owner:=p.account_id; source_mode:=p.author_mode; source_created:=p.published_at; source_deleted:=p.deleted_at;
    source_create_xid:=p.local_creation_transaction; source_delete_xid:=p.local_deletion_transaction;
  ELSE
    SELECT * INTO c FROM whaleu_community.root_comments WHERE id=NEW.root_comment_id AND post_id=p.id;
    IF c.id IS NULL OR NEW.root_author_id IS DISTINCT FROM c.account_id THEN RAISE EXCEPTION 'Reward root snapshot disagrees' USING ERRCODE='23514'; END IF;
    IF NEW.resource_kind='comment' THEN
      source_id:=c.id; source_owner:=c.account_id; source_mode:=c.author_mode; source_created:=c.created_at; source_deleted:=c.deleted_at;
      source_create_xid:=c.local_creation_transaction; source_delete_xid:=c.local_deletion_transaction;
    ELSE
      SELECT * INTO r FROM whaleu_community.replies WHERE id=NEW.reply_id AND root_comment_id=c.id AND post_id=p.id;
      IF r.id IS NULL OR NEW.target_reply_id IS DISTINCT FROM r.target_reply_id THEN RAISE EXCEPTION 'Reward reply snapshot disagrees' USING ERRCODE='23514'; END IF;
      SELECT * INTO t FROM whaleu_community.replies WHERE id=r.target_reply_id;
      IF NEW.target_reply_author_id IS DISTINCT FROM t.account_id THEN RAISE EXCEPTION 'Reward target author disagrees' USING ERRCODE='23514'; END IF;
      source_id:=r.id; source_owner:=r.account_id; source_mode:=r.author_mode; source_created:=r.created_at; source_deleted:=r.deleted_at;
      source_create_xid:=r.local_creation_transaction; source_delete_xid:=r.local_deletion_transaction;
    END IF;
  END IF;
  IF NEW.resource_author_id<>source_owner OR NEW.resource_author_mode<>source_mode OR
    e.context->>'resourceAuthorMode' IS DISTINCT FROM source_mode THEN RAISE EXCEPTION 'Reward resource snapshot disagrees' USING ERRCODE='23514'; END IF;
  expected_mode:=CASE WHEN NEW.event_type IN ('post_liked','comment_liked','reply_liked','post_saved') THEN NULL ELSE source_mode END;
  IF NEW.actor_author_mode IS DISTINCT FROM expected_mode OR e.context->'actorAuthorMode' IS DISTINCT FROM coalesce(to_jsonb(expected_mode),'null'::jsonb) THEN
    RAISE EXCEPTION 'Reward author mode disagrees' USING ERRCODE='23514';
  END IF;
  IF NEW.event_type='post_saved' THEN
    SELECT * INTO epoch FROM whaleu_community.saved_epochs WHERE id=NEW.save_epoch_id;
    IF epoch.id IS NULL OR e.resource_id<>epoch.id OR epoch.account_id<>NEW.actor_account_id OR epoch.post_id<>p.id OR
      epoch.local_creation_transaction IS DISTINCT FROM pg_current_xact_id() OR NEW.occurred_at<>epoch.started_at OR
      e.event_key<>'save:'||epoch.id::text||':started' OR e.context->>'postId' IS DISTINCT FROM p.id::text OR
      e.context->>'saveEpochId' IS DISTINCT FROM epoch.id::text OR e.context->'desired' IS DISTINCT FROM 'true'::jsonb THEN
      RAISE EXCEPTION 'Saved reward must describe its fresh epoch' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM whaleu_community.saved_obligations WHERE epoch_id=epoch.id AND transition='saved' AND action='saver_reward' AND recipient_account_id=NEW.actor_account_id AND delta=1 AND status='pending' AND local_creation_transaction=pg_current_xact_id()) OR
      (NEW.actor_account_id<>p.account_id AND NOT EXISTS(SELECT 1 FROM whaleu_community.saved_obligations WHERE epoch_id=epoch.id AND transition='saved' AND action='author_reward' AND recipient_account_id=p.account_id AND delta=1 AND status='pending' AND local_creation_transaction=pg_current_xact_id())) THEN
      RAISE EXCEPTION 'Saved reward obligations are incomplete or historical' USING ERRCODE='23514';
    END IF;
    SELECT coalesce(jsonb_agg(o.id::text ORDER BY o.id::text),'[]'::jsonb) INTO expected_obligations
      FROM whaleu_community.saved_obligations o WHERE o.epoch_id=epoch.id AND o.transition='saved'
        AND ((o.action='saver_reward' AND o.recipient_account_id=NEW.actor_account_id) OR
             (o.action='author_reward' AND NEW.actor_account_id<>p.account_id AND o.recipient_account_id=p.account_id));
    IF jsonb_typeof(e.context->'rewardObligationIds') IS DISTINCT FROM 'array' OR
      (SELECT coalesce(jsonb_agg(value ORDER BY value),'[]'::jsonb) FROM jsonb_array_elements(e.context->'rewardObligationIds')) IS DISTINCT FROM expected_obligations OR
      (SELECT count(*) FROM whaleu_community.saved_obligations WHERE epoch_id=epoch.id AND action IN ('saver_reward','author_reward'))<>jsonb_array_length(expected_obligations) THEN
      RAISE EXCEPTION 'Saved reward source must name its complete canonical obligations' USING ERRCODE='23514';
    END IF;
  ELSE
    IF e.resource_id<>source_id THEN RAISE EXCEPTION 'Reward resource key disagrees' USING ERRCODE='23514'; END IF;
    IF NEW.event_type LIKE '%_created' THEN
      IF NEW.actor_account_id<>source_owner OR source_create_xid IS DISTINCT FROM pg_current_xact_id() OR NEW.occurred_at<>source_created OR
        e.event_key<>NEW.resource_kind||':'||source_id::text||':created' THEN RAISE EXCEPTION 'Reward creation must be fresh and owned' USING ERRCODE='23514'; END IF;
    ELSIF NEW.event_type LIKE '%_deleted' THEN
      IF NEW.actor_account_id<>source_owner OR source_delete_xid IS DISTINCT FROM pg_current_xact_id() OR source_deleted IS NULL OR NEW.occurred_at<>source_deleted OR
        e.event_key<>NEW.resource_kind||':'||source_id::text||':deleted' THEN RAISE EXCEPTION 'Reward deletion must be fresh and owned' USING ERRCODE='23514'; END IF;
    ELSE
      EXECUTE format('SELECT liked_at,local_creation_transaction FROM whaleu_community.%I WHERE like_id=$1 AND %I=$2 AND account_id=$3',NEW.resource_kind||'_likes',NEW.resource_kind||'_id')
        INTO membership USING NEW.like_id,source_id,NEW.actor_account_id;
      IF membership.liked_at IS NULL OR membership.local_creation_transaction IS DISTINCT FROM pg_current_xact_id() OR NEW.occurred_at<>membership.liked_at OR
        e.event_key<>NEW.resource_kind||':like:'||NEW.like_id::text OR e.context->>'likeId' IS DISTINCT FROM NEW.like_id::text OR
        e.context->>'recipientAccountId' IS DISTINCT FROM source_owner::text THEN RAISE EXCEPTION 'Reward like must describe the exact fresh membership' USING ERRCODE='23514'; END IF;
    END IF;
  END IF;
  IF NEW.event_type IN ('comment_created','reply_created') THEN
    SELECT coalesce(jsonb_agg(x ORDER BY x),'[]'::jsonb) INTO expected_recipients FROM (
      SELECT DISTINCT unnest(CASE WHEN NEW.event_type='comment_created' THEN ARRAY[p.account_id] ELSE ARRAY[c.account_id,t.account_id] END)::text AS x
    ) recipients WHERE x IS NOT NULL AND x<>NEW.actor_account_id::text;
    IF jsonb_typeof(e.context->'recipientAccountIds') IS DISTINCT FROM 'array' OR
      (SELECT coalesce(jsonb_agg(value ORDER BY value),'[]'::jsonb) FROM jsonb_array_elements(e.context->'recipientAccountIds')) IS DISTINCT FROM expected_recipients THEN
      RAISE EXCEPTION 'Reward recipient snapshot disagrees' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reward_source_group_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.reward_source_groups FOR EACH ROW EXECUTE FUNCTION whaleu_community.reward_source_group_guard();

CREATE FUNCTION whaleu_community.reward_expected_units(group_key uuid)
RETURNS TABLE(beneficiary_id uuid,action text,outbox_event_id uuid,saved_obligation_id uuid) LANGUAGE sql STABLE AS $$
  WITH g AS (SELECT * FROM whaleu_community.reward_source_groups WHERE id=group_key),
  expected AS (
    SELECT actor_account_id AS beneficiary,CASE event_type WHEN 'post_created' THEN 'publish' WHEN 'comment_created' THEN 'comment' WHEN 'reply_created' THEN 'comment'
      WHEN 'post_deleted' THEN 'delete_post' WHEN 'comment_deleted' THEN 'delete_comment' WHEN 'reply_deleted' THEN 'delete_reply' ELSE 'like_save' END AS action FROM g
    UNION
    SELECT recipient,CASE WHEN event_type IN ('comment_created','reply_created') THEN 'received_comment' ELSE 'received_like_save' END FROM g,
      LATERAL unnest(CASE WHEN event_type='comment_created' THEN ARRAY[post_author_id] WHEN event_type='reply_created' THEN ARRAY[root_author_id,target_reply_author_id]
        WHEN event_type IN ('post_liked','comment_liked','reply_liked','post_saved') THEN ARRAY[resource_author_id] ELSE ARRAY[]::uuid[] END) recipient
      WHERE recipient IS NOT NULL AND recipient<>actor_account_id
  )
  SELECT expected.beneficiary,expected.action,CASE WHEN g.event_type='post_saved' THEN NULL::uuid ELSE g.event_id END,
    CASE WHEN g.event_type='post_saved' THEN o.id ELSE NULL::uuid END
    FROM g CROSS JOIN expected LEFT JOIN whaleu_community.saved_obligations o ON g.event_type='post_saved' AND o.epoch_id=g.save_epoch_id AND o.transition='saved'
      AND o.recipient_account_id=expected.beneficiary AND o.action=CASE WHEN expected.action='like_save' THEN 'saver_reward' ELSE 'author_reward' END;
$$;
CREATE FUNCTION whaleu_community.reward_unit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Reward source unit is immutable' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM whaleu_community.reward_source_groups g WHERE g.id=NEW.group_id AND g.creation_transaction=pg_current_xact_id()) OR
    NOT EXISTS(SELECT 1 FROM whaleu_community.reward_expected_units(NEW.group_id) e WHERE (e.beneficiary_id,e.action,e.outbox_event_id,e.saved_obligation_id)
      IS NOT DISTINCT FROM (NEW.beneficiary_id,NEW.action,NEW.outbox_event_id,NEW.saved_obligation_id)) THEN
    RAISE EXCEPTION 'Reward unit is not canonical for its fresh group' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reward_unit_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.reward_source_units FOR EACH ROW EXECUTE FUNCTION whaleu_community.reward_unit_guard();

CREATE FUNCTION whaleu_community.reward_enrollment_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE group_key uuid; expected_count integer; actual_count integer; canonical_count integer;
BEGIN
  IF TG_TABLE_NAME='reward_source_groups' THEN group_key:=NEW.id; ELSE group_key:=NEW.group_id; END IF;
  SELECT expected_unit_count INTO expected_count FROM whaleu_community.reward_source_groups WHERE id=group_key;
  SELECT count(*) INTO actual_count FROM whaleu_community.reward_source_units WHERE group_id=group_key;
  SELECT count(*) INTO canonical_count FROM whaleu_community.reward_expected_units(group_key);
  IF actual_count<>expected_count OR actual_count<>canonical_count OR
    EXISTS(SELECT 1 FROM whaleu_community.reward_expected_units(group_key) e WHERE NOT EXISTS(
      SELECT 1 FROM whaleu_community.reward_source_units u WHERE u.group_id=group_key AND
        (u.beneficiary_id,u.action,u.outbox_event_id,u.saved_obligation_id) IS NOT DISTINCT FROM (e.beneficiary_id,e.action,e.outbox_event_id,e.saved_obligation_id))) OR
    EXISTS(SELECT 1 FROM whaleu_community.reward_source_units u WHERE u.group_id=group_key AND NOT EXISTS(
      SELECT 1 FROM whaleu_experience.work w WHERE (w.unit_id,w.group_id,w.beneficiary_id,w.action,w.enrollment_order)=(u.id,u.group_id,u.beneficiary_id,u.action,u.enrollment_order))) THEN
    RAISE EXCEPTION 'Reward source enrollment is incomplete' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER reward_group_complete AFTER INSERT ON whaleu_community.reward_source_groups DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.reward_enrollment_complete();
CREATE CONSTRAINT TRIGGER reward_unit_complete AFTER INSERT ON whaleu_community.reward_source_units DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.reward_enrollment_complete();
CREATE FUNCTION whaleu_community.reward_outbox_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM whaleu_community.reward_source_groups WHERE event_id=OLD.id) THEN
    RAISE EXCEPTION 'Enrolled reward outbox is immutable' USING ERRCODE='23514';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER reward_outbox_immutable BEFORE UPDATE OR DELETE ON whaleu_community.outbox FOR EACH ROW EXECUTE FUNCTION whaleu_community.reward_outbox_immutable();
CREATE FUNCTION whaleu_community.reward_source_outbox_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.event_type IN ('post_created','comment_created','reply_created','post_liked','comment_liked','reply_liked','post_saved','post_deleted','comment_deleted','reply_deleted')
    AND NEW.context->'experienceSourceVersion'='1'::jsonb AND NOT EXISTS(SELECT 1 FROM whaleu_community.reward_source_groups WHERE event_id=NEW.id) THEN
    RAISE EXCEPTION 'Fresh reward event is missing enrollment' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER reward_source_outbox_complete AFTER INSERT ON whaleu_community.outbox DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.reward_source_outbox_complete();
CREATE FUNCTION whaleu_community.reward_obligation_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM whaleu_community.reward_source_units WHERE saved_obligation_id=NEW.id) AND
    (NEW.status<>'completed' OR (OLD.status='completed' AND NEW.status<>OLD.status) OR NOT EXISTS(
      SELECT 1 FROM whaleu_community.reward_source_units u JOIN whaleu_experience.settlements s ON s.unit_id=u.id
        WHERE u.saved_obligation_id=NEW.id AND s.owner_id=u.beneficiary_id AND s.action=u.action)) THEN
    RAISE EXCEPTION 'Enrolled reward obligation needs its own terminal settlement' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reward_obligation_settlement BEFORE UPDATE ON whaleu_community.saved_obligations FOR EACH ROW EXECUTE FUNCTION whaleu_community.reward_obligation_settlement();

CREATE TABLE whaleu_community.post_like_requests (
  account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
  client_request_id uuid NOT NULL,
  payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
  operation text NOT NULL DEFAULT 'set_post_like' CHECK(operation='set_post_like'),
  post_id uuid NOT NULL,
  liked boolean NOT NULL,
  receipt jsonb,
  PRIMARY KEY(account_id,client_request_id),
  CHECK(receipt IS NULL OR coalesce(jsonb_typeof(receipt)='object' AND receipt->>'requestId'=client_request_id::text AND receipt->>'operation'=operation AND
    receipt->>'postId'=post_id::text AND receipt->'liked'=to_jsonb(liked) AND
    ((receipt->>'outcome'='applied' AND receipt-ARRAY['requestId','operation','postId','liked','outcome']='{}'::jsonb) OR
    (receipt->>'outcome'='rejected' AND receipt->>'code' IN ('POST_NOT_FOUND','COMMUNITY_SCOPE_UNAVAILABLE','PHONE_VERIFICATION_REQUIRED','COMMUNITY_ACTION_RESTRICTED') AND
      receipt-ARRAY['requestId','operation','postId','liked','outcome','code']='{}'::jsonb)),false))
);
CREATE TRIGGER post_like_request_immutable BEFORE UPDATE OR DELETE ON whaleu_community.post_like_requests FOR EACH ROW EXECUTE FUNCTION whaleu_community.saved_request_immutable();
CREATE FUNCTION whaleu_community.post_like_request_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM whaleu_community.post_like_requests WHERE account_id=NEW.account_id AND client_request_id=NEW.client_request_id AND receipt IS NULL) THEN
    RAISE EXCEPTION 'Post like request is incomplete' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER post_like_request_complete AFTER INSERT ON whaleu_community.post_like_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.post_like_request_complete();
CREATE TABLE whaleu_experience.work (
  unit_id uuid PRIMARY KEY,group_id uuid NOT NULL,beneficiary_id uuid NOT NULL REFERENCES whaleu_experience.owners(owner_id),
  action text NOT NULL,enrollment_order bigint NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','blocked_baseline','completed')),
  completed_at timestamptz CHECK(completed_at IS NULL OR isfinite(completed_at)),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(next_attempt_at)),
  error_code text CHECK(error_code IN ('baseline_unknown','blocked_predecessor','local_processing_failed','source_unavailable')),
  FOREIGN KEY(unit_id,group_id,beneficiary_id,action,enrollment_order) REFERENCES whaleu_community.reward_source_units(id,group_id,beneficiary_id,action,enrollment_order),
  UNIQUE(unit_id,beneficiary_id,action),CHECK((state='completed')=(completed_at IS NOT NULL))
);
CREATE INDEX experience_owner_work ON whaleu_experience.work(beneficiary_id,enrollment_order,unit_id) WHERE state<>'completed';
CREATE INDEX experience_due_work ON whaleu_experience.work(next_attempt_at,enrollment_order,unit_id) WHERE state<>'completed';
CREATE FUNCTION whaleu_experience.work_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.state='completed' OR (to_jsonb(OLD)-ARRAY['state','completed_at','attempts','next_attempt_at','error_code']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['state','completed_at','attempts','next_attempt_at','error_code']) THEN
    RAISE EXCEPTION 'Experience work identity and completion are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER work_guard BEFORE UPDATE OR DELETE ON whaleu_experience.work FOR EACH ROW EXECUTE FUNCTION whaleu_experience.work_guard();
CREATE TABLE whaleu_experience.daily_buckets (
  owner_id uuid NOT NULL REFERENCES whaleu_experience.account_states(owner_id),reward_day date NOT NULL CHECK(isfinite(reward_day)),
  action text NOT NULL CHECK(action IN ('publish','comment','like_save','received_like_save','received_comment')),
  rewarded_count integer NOT NULL DEFAULT 0,refund_count integer NOT NULL DEFAULT 0,gross_positive_awarded bigint NOT NULL DEFAULT 0 CHECK(gross_positive_awarded>=0),
  rule_version text NOT NULL DEFAULT 'local-experience-v1' CHECK(rule_version='local-experience-v1'),PRIMARY KEY(owner_id,reward_day,action),
  CHECK(rewarded_count BETWEEN 0 AND CASE action WHEN 'publish' THEN 1 WHEN 'comment' THEN 5 WHEN 'received_comment' THEN 5 ELSE 10 END),
  CHECK(refund_count BETWEEN 0 AND CASE action WHEN 'publish' THEN 1 WHEN 'comment' THEN 3 ELSE 0 END)
);
CREATE TABLE whaleu_experience.settlements (
  id uuid PRIMARY KEY,unit_id uuid UNIQUE,owner_id uuid NOT NULL REFERENCES whaleu_experience.account_states(owner_id),
  action text NOT NULL CHECK(action IN ('publish','comment','like_save','received_like_save','received_comment','delete_post','delete_comment','delete_reply','sign_in')),
  outcome text NOT NULL CHECK(outcome IN ('awarded','capped','deducted')),
  rule_version text NOT NULL DEFAULT 'local-experience-v1' CHECK(rule_version='local-experience-v1'),
  nominal_delta bigint NOT NULL,applied_delta bigint NOT NULL,balance_before bigint NOT NULL CHECK(balance_before>=0),balance_after bigint NOT NULL CHECK(balance_after>=0),
  state_revision bigint NOT NULL CHECK(state_revision>0),applied_at timestamptz NOT NULL CHECK(isfinite(applied_at)),reward_day date NOT NULL CHECK(isfinite(reward_day)),
  bucket_action text,bucket_before integer,bucket_after integer,refund_before integer,refund_after integer,
  UNIQUE(owner_id,state_revision),UNIQUE(id,owner_id,action),UNIQUE(id,owner_id),
  FOREIGN KEY(unit_id,owner_id,action) REFERENCES whaleu_experience.work(unit_id,beneficiary_id,action),
  CHECK(balance_after::numeric=balance_before::numeric+applied_delta::numeric),
  CHECK(reward_day=(applied_at AT TIME ZONE 'Asia/Shanghai')::date),
  CHECK((action='sign_in')=(unit_id IS NULL)),
  CHECK((action='sign_in' AND bucket_action IS NULL AND bucket_before IS NULL AND bucket_after IS NULL AND refund_before IS NULL AND refund_after IS NULL) OR
    (action<>'sign_in' AND bucket_action=CASE action WHEN 'delete_post' THEN 'publish' WHEN 'delete_comment' THEN 'comment' WHEN 'delete_reply' THEN 'comment' ELSE action END AND bucket_before>=0 AND bucket_after>=0 AND refund_before>=0 AND refund_after>=0)),
  CHECK((outcome='capped' AND applied_delta=0 AND nominal_delta>0) OR (outcome='awarded' AND applied_delta=nominal_delta AND applied_delta>0) OR (outcome='deducted' AND nominal_delta<0 AND applied_delta=greatest(-balance_before,nominal_delta))),
  CHECK((action LIKE 'delete_%')=(outcome='deducted'))
);
CREATE TRIGGER settlement_immutable BEFORE UPDATE OR DELETE ON whaleu_experience.settlements FOR EACH ROW EXECUTE FUNCTION whaleu_experience.immutable_row();
CREATE FUNCTION whaleu_experience.settlement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_state whaleu_experience.account_states; first_unit uuid; expected_amount integer; current_bucket whaleu_experience.daily_buckets; limit_count integer; refund_limit integer;
BEGIN
  PERFORM 1 FROM whaleu_experience.owners WHERE owner_id=NEW.owner_id FOR UPDATE;
  SELECT * INTO current_state FROM whaleu_experience.account_states WHERE owner_id=NEW.owner_id;
  IF current_state.owner_id IS NULL OR NEW.balance_before<>current_state.balance OR NEW.state_revision<>current_state.revision+1 THEN RAISE EXCEPTION 'Settlement state is stale' USING ERRCODE='23514'; END IF;
  SELECT unit_id INTO first_unit FROM whaleu_experience.work WHERE beneficiary_id=NEW.owner_id AND state<>'completed' ORDER BY enrollment_order,unit_id LIMIT 1;
  IF (NEW.unit_id IS NULL AND first_unit IS NOT NULL) OR (NEW.unit_id IS NOT NULL AND NEW.unit_id IS DISTINCT FROM first_unit) THEN RAISE EXCEPTION 'Settlement cannot overtake owner work' USING ERRCODE='23514'; END IF;
  IF NEW.action='sign_in' THEN
    IF current_state.last_signin_day=NEW.reward_day THEN RAISE EXCEPTION 'Sign-in already settled' USING ERRCODE='23514'; END IF;
    expected_amount:=(ARRAY[2,4,6,8,10,12,15])[CASE WHEN current_state.last_signin_day=NEW.reward_day-1 THEN least(current_state.streak+1,7) ELSE 1 END];
  ELSE
    expected_amount:=CASE NEW.bucket_action WHEN 'publish' THEN 10 WHEN 'comment' THEN 3 WHEN 'like_save' THEN 1 WHEN 'received_like_save' THEN 2 ELSE 3 END;
    limit_count:=CASE NEW.bucket_action WHEN 'publish' THEN 1 WHEN 'comment' THEN 5 WHEN 'received_comment' THEN 5 ELSE 10 END;
    refund_limit:=CASE NEW.bucket_action WHEN 'publish' THEN 1 WHEN 'comment' THEN 3 ELSE 0 END;
    SELECT * INTO current_bucket FROM whaleu_experience.daily_buckets WHERE owner_id=NEW.owner_id AND reward_day=NEW.reward_day AND action=NEW.bucket_action;
    IF NEW.bucket_before<>coalesce(current_bucket.rewarded_count,0) OR NEW.refund_before<>coalesce(current_bucket.refund_count,0) THEN RAISE EXCEPTION 'Settlement quota is stale' USING ERRCODE='23514'; END IF;
    IF NEW.outcome='deducted' THEN
      expected_amount:=-expected_amount;
      IF NEW.bucket_after<>NEW.bucket_before-(CASE WHEN NEW.bucket_before>0 AND NEW.refund_before<refund_limit THEN 1 ELSE 0 END) OR NEW.refund_after<>NEW.refund_before+(CASE WHEN NEW.bucket_before>0 AND NEW.refund_before<refund_limit THEN 1 ELSE 0 END) THEN RAISE EXCEPTION 'Invalid opportunity refund' USING ERRCODE='23514'; END IF;
    ELSIF (NEW.outcome='capped') IS DISTINCT FROM (NEW.bucket_before>=limit_count) OR NEW.bucket_after<>NEW.bucket_before+(CASE WHEN NEW.outcome='awarded' THEN 1 ELSE 0 END) OR NEW.refund_after<>NEW.refund_before THEN RAISE EXCEPTION 'Invalid reward quota result' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.nominal_delta<>expected_amount THEN RAISE EXCEPTION 'Invalid configured reward' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER settlement_guard BEFORE INSERT ON whaleu_experience.settlements FOR EACH ROW EXECUTE FUNCTION whaleu_experience.settlement_guard();
CREATE TABLE whaleu_experience.records (
  id uuid PRIMARY KEY,owner_id uuid NOT NULL REFERENCES whaleu_experience.owners(owner_id),recorded_order bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  settlement_id uuid UNIQUE,action text NOT NULL CHECK(action IN ('publish','comment','like_save','received_like_save','received_comment','delete_post','delete_comment','delete_reply','sign_in')),
  origin text NOT NULL CHECK(origin IN ('settlement','synthetic_fixture')),outcome text NOT NULL CHECK(outcome IN ('awarded','capped','deducted','historical')),
  nominal_delta bigint,applied_delta bigint,balance_after bigint CHECK(balance_after IS NULL OR balance_after>=0),
  occurred_at timestamptz CHECK(occurred_at IS NULL OR isfinite(occurred_at)),applied_at timestamptz CHECK(applied_at IS NULL OR isfinite(applied_at)),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(recorded_at)),
  FOREIGN KEY(settlement_id,owner_id,action) REFERENCES whaleu_experience.settlements(id,owner_id,action),
  CHECK((origin='settlement' AND settlement_id IS NOT NULL AND outcome<>'historical' AND nominal_delta IS NOT NULL AND applied_delta IS NOT NULL AND balance_after IS NOT NULL AND applied_at IS NOT NULL) OR (origin='synthetic_fixture' AND settlement_id IS NULL AND outcome='historical' AND applied_delta IS NULL AND balance_after IS NULL AND applied_at IS NULL))
);
CREATE INDEX experience_records_owner ON whaleu_experience.records(owner_id,recorded_order DESC);
CREATE TRIGGER record_immutable BEFORE UPDATE OR DELETE ON whaleu_experience.records FOR EACH ROW EXECUTE FUNCTION whaleu_experience.immutable_row();
CREATE TABLE whaleu_experience.signin_days (
  owner_id uuid NOT NULL,reward_day date NOT NULL CHECK(isfinite(reward_day)),settlement_id uuid NOT NULL UNIQUE,
  streak integer NOT NULL CHECK(streak BETWEEN 1 AND 7),PRIMARY KEY(owner_id,reward_day),
  FOREIGN KEY(settlement_id,owner_id) REFERENCES whaleu_experience.settlements(id,owner_id)
);
CREATE TRIGGER signin_immutable BEFORE UPDATE OR DELETE ON whaleu_experience.signin_days FOR EACH ROW EXECUTE FUNCTION whaleu_experience.immutable_row();
CREATE TABLE whaleu_experience.entitlements (
  owner_id uuid NOT NULL REFERENCES whaleu_experience.owners(owner_id),title_key text NOT NULL REFERENCES whaleu_experience.title_catalog(title_key),
  origin text NOT NULL CHECK(origin IN ('registration','level','synthetic_fixture')),settlement_id uuid,
  earned_at timestamptz CHECK(earned_at IS NULL OR isfinite(earned_at)),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(recorded_at)),
  PRIMARY KEY(owner_id,title_key),FOREIGN KEY(settlement_id,owner_id) REFERENCES whaleu_experience.settlements(id,owner_id),
  CHECK((origin='level')=(settlement_id IS NOT NULL))
);
CREATE TRIGGER entitlement_immutable BEFORE UPDATE OR DELETE ON whaleu_experience.entitlements FOR EACH ROW EXECUTE FUNCTION whaleu_experience.immutable_row();
CREATE FUNCTION whaleu_experience.projection_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s whaleu_experience.settlements; threshold_value bigint;
BEGIN
  IF NEW.origin='synthetic_fixture' THEN
    IF NOT whaleu_experience.synthetic_fixture_allowed() THEN RAISE EXCEPTION 'Synthetic fixture is local test only' USING ERRCODE='23514'; END IF;
  ELSIF TG_TABLE_NAME='records' THEN
    SELECT * INTO s FROM whaleu_experience.settlements WHERE id=NEW.settlement_id;
    IF s.id IS NULL OR (NEW.nominal_delta,NEW.applied_delta,NEW.balance_after,NEW.applied_at,NEW.outcome) IS DISTINCT FROM (s.nominal_delta,s.applied_delta,s.balance_after,s.applied_at,s.outcome) THEN RAISE EXCEPTION 'Record disagrees with settlement' USING ERRCODE='23514'; END IF;
  ELSIF NEW.origin='registration' THEN
    IF NEW.title_key NOT IN ('default_jingxiaoyu','level_1') OR NEW.earned_at IS NULL OR NOT EXISTS(SELECT 1 FROM whaleu_experience.baselines b JOIN whaleu_identity.accounts a ON a.id=b.owner_id WHERE b.owner_id=NEW.owner_id AND b.origin='native_account_creation' AND a.local_creation_transaction=pg_current_xact_id()) THEN RAISE EXCEPTION 'Registration grant requires new account provenance' USING ERRCODE='23514'; END IF;
  ELSE
    SELECT l.threshold INTO threshold_value FROM whaleu_experience.title_catalog t JOIN whaleu_experience.level_catalog l ON l.level=t.unlock_level WHERE t.title_key=NEW.title_key AND t.kind='level';
    SELECT * INTO s FROM whaleu_experience.settlements WHERE id=NEW.settlement_id AND owner_id=NEW.owner_id;
    IF threshold_value IS NULL OR s.id IS NULL OR s.balance_after<threshold_value OR NEW.earned_at IS DISTINCT FROM s.applied_at THEN RAISE EXCEPTION 'Level grant lacks earned proof' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER record_guard BEFORE INSERT ON whaleu_experience.records FOR EACH ROW EXECUTE FUNCTION whaleu_experience.projection_guard();
CREATE TRIGGER entitlement_guard BEFORE INSERT ON whaleu_experience.entitlements FOR EACH ROW EXECUTE FUNCTION whaleu_experience.projection_guard();
CREATE TABLE whaleu_experience.appearance (
  owner_id uuid PRIMARY KEY REFERENCES whaleu_experience.owners(owner_id),title_key text,color_id integer REFERENCES whaleu_experience.color_catalog(color_id),revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
  FOREIGN KEY(owner_id,title_key) REFERENCES whaleu_experience.entitlements(owner_id,title_key)
);
CREATE FUNCTION whaleu_experience.appearance_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE needed bigint;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Appearance revision is retained' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' AND (NEW.owner_id<>OLD.owner_id OR NEW.revision<>OLD.revision+(CASE WHEN (NEW.title_key,NEW.color_id) IS DISTINCT FROM (OLD.title_key,OLD.color_id) THEN 1 ELSE 0 END)) THEN RAISE EXCEPTION 'Appearance revision is stale' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' AND NEW.revision<>0 THEN RAISE EXCEPTION 'Appearance begins at revision zero' USING ERRCODE='23514'; END IF;
  IF NEW.color_id>10 AND (TG_OP='INSERT' OR NEW.color_id IS DISTINCT FROM OLD.color_id) THEN
    SELECT l.threshold INTO needed FROM whaleu_experience.color_catalog c JOIN whaleu_experience.level_catalog l ON l.level=c.unlock_level WHERE c.color_id=NEW.color_id;
    IF NOT EXISTS(SELECT 1 FROM whaleu_experience.account_states WHERE owner_id=NEW.owner_id AND balance>=needed) THEN RAISE EXCEPTION 'Color selection is ineligible' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER appearance_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_experience.appearance FOR EACH ROW EXECUTE FUNCTION whaleu_experience.appearance_guard();
CREATE TABLE whaleu_experience.requests (
  owner_id uuid NOT NULL REFERENCES whaleu_experience.owners(owner_id),request_id uuid NOT NULL,operation text NOT NULL CHECK(operation IN ('sign_in','appearance')),
  intent_hash text NOT NULL CHECK(intent_hash ~ '^[a-f0-9]{64}$'),receipt jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(recorded_at)),PRIMARY KEY(owner_id,request_id),
  CHECK(coalesce(jsonb_typeof(receipt)='object' AND receipt->>'requestId'=request_id::text AND receipt->>'operation'=operation AND
    ((operation='sign_in' AND receipt->>'outcome' IN ('awarded','already_signed_in') AND receipt-ARRAY['requestId','operation','outcome','rewardDay','appliedDelta','balance','streak','stateRevision']='{}'::jsonb AND receipt->>'appliedDelta' ~ '^(0|[1-9][0-9]*)$' AND receipt->>'balance' ~ '^(0|[1-9][0-9]*)$' AND receipt->>'stateRevision' ~ '^(0|[1-9][0-9]*)$') OR
     (operation='appearance' AND receipt->>'outcome'='applied' AND receipt-ARRAY['requestId','operation','outcome','titleKey','colorId','revision']='{}'::jsonb AND receipt->>'revision' ~ '^(0|[1-9][0-9]*)$') OR
     (operation='appearance' AND receipt->>'outcome'='rejected' AND receipt-ARRAY['requestId','operation','outcome','code']='{}'::jsonb AND receipt->>'code' IN ('EXPERIENCE_APPEARANCE_CONFLICT','EXPERIENCE_TITLE_INELIGIBLE','EXPERIENCE_COLOR_INELIGIBLE'))),false))
);
CREATE TRIGGER request_immutable BEFORE UPDATE OR DELETE ON whaleu_experience.requests FOR EACH ROW EXECUTE FUNCTION whaleu_experience.immutable_row();
CREATE TABLE whaleu_experience.unlock_notices (
  id uuid PRIMARY KEY,owner_id uuid NOT NULL,settlement_id uuid NOT NULL UNIQUE,from_level integer NOT NULL CHECK(from_level BETWEEN 1 AND 29),to_level integer NOT NULL CHECK(to_level BETWEEN 2 AND 30),
  title_keys text[] NOT NULL,color_ids integer[] NOT NULL,created_at timestamptz NOT NULL CHECK(isfinite(created_at)),acknowledged_at timestamptz CHECK(acknowledged_at IS NULL OR isfinite(acknowledged_at)),
  FOREIGN KEY(settlement_id,owner_id) REFERENCES whaleu_experience.settlements(id,owner_id),CHECK(to_level>from_level)
);
CREATE INDEX experience_unread_notices ON whaleu_experience.unlock_notices(owner_id,created_at,id) WHERE acknowledged_at IS NULL;
CREATE FUNCTION whaleu_experience.notice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (to_jsonb(OLD)-'acknowledged_at') IS DISTINCT FROM (to_jsonb(NEW)-'acknowledged_at') OR NEW.acknowledged_at IS NULL OR (OLD.acknowledged_at IS NOT NULL AND NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at) THEN RAISE EXCEPTION 'Unlock notice is immutable except acknowledgement' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER notice_guard BEFORE UPDATE OR DELETE ON whaleu_experience.unlock_notices FOR EACH ROW EXECUTE FUNCTION whaleu_experience.notice_guard();
CREATE FUNCTION whaleu_experience.account_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner uuid; current_state whaleu_experience.account_states; base whaleu_experience.baselines; total numeric; count_settled bigint; latest whaleu_experience.signin_days;
BEGIN
  owner:=NEW.owner_id;
  SELECT * INTO current_state FROM whaleu_experience.account_states WHERE owner_id=owner;
  SELECT * INTO base FROM whaleu_experience.baselines WHERE owner_id=owner;
  SELECT coalesce(sum(applied_delta),0),count(*) INTO total,count_settled FROM whaleu_experience.settlements WHERE owner_id=owner;
  IF current_state.owner_id IS NULL OR base.owner_id IS NULL OR current_state.balance::numeric<>base.opening_balance::numeric+total OR current_state.revision<>count_settled THEN RAISE EXCEPTION 'Experience balance does not reconcile' USING ERRCODE='23514'; END IF;
  SELECT * INTO latest FROM whaleu_experience.signin_days WHERE owner_id=owner ORDER BY reward_day DESC LIMIT 1;
  IF (current_state.last_signin_day,current_state.streak) IS DISTINCT FROM (coalesce(latest.reward_day,base.opening_signin_day),coalesce(latest.streak,base.opening_streak)) THEN RAISE EXCEPTION 'Sign-in state does not reconcile' USING ERRCODE='23514'; END IF;
  IF base.origin='native_account_creation' AND (NOT EXISTS(SELECT 1 FROM whaleu_experience.entitlements WHERE owner_id=owner AND title_key='default_jingxiaoyu') OR NOT EXISTS(SELECT 1 FROM whaleu_experience.entitlements WHERE owner_id=owner AND title_key='level_1')) THEN RAISE EXCEPTION 'Native default ownership is incomplete' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER baseline_complete AFTER INSERT ON whaleu_experience.baselines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_experience.account_complete();
CREATE CONSTRAINT TRIGGER account_complete AFTER INSERT OR UPDATE ON whaleu_experience.account_states DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_experience.account_complete();
CREATE CONSTRAINT TRIGGER settlement_account_complete AFTER INSERT ON whaleu_experience.settlements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_experience.account_complete();
CREATE FUNCTION whaleu_experience.settlement_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s whaleu_experience.settlements; current_work whaleu_experience.work; bucket whaleu_experience.daily_buckets; total_count bigint; total_refunds bigint; total_gross numeric; v_from_level integer; v_to_level integer;
BEGIN
  IF TG_TABLE_NAME='work' THEN SELECT * INTO s FROM whaleu_experience.settlements WHERE unit_id=NEW.unit_id; SELECT * INTO current_work FROM whaleu_experience.work WHERE unit_id=NEW.unit_id;
    IF (current_work.state='completed') IS DISTINCT FROM (s.id IS NOT NULL) THEN RAISE EXCEPTION 'Work settlement incomplete' USING ERRCODE='23514'; END IF;
    IF s.id IS NULL THEN RETURN NULL; END IF;
  ELSE SELECT * INTO s FROM whaleu_experience.settlements WHERE id=NEW.id; END IF;
  IF NOT EXISTS(SELECT 1 FROM whaleu_experience.records WHERE settlement_id=s.id) THEN RAISE EXCEPTION 'Settlement record missing' USING ERRCODE='23514'; END IF;
  IF s.unit_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM whaleu_experience.work WHERE unit_id=s.unit_id AND state='completed') THEN RAISE EXCEPTION 'Settled work is pending' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM whaleu_community.reward_source_units u JOIN whaleu_community.saved_obligations o ON o.id=u.saved_obligation_id WHERE u.id=s.unit_id AND o.status<>'completed') THEN RAISE EXCEPTION 'Saved reward acknowledgement missing' USING ERRCODE='23514'; END IF;
  IF s.action='sign_in' THEN
    IF NOT EXISTS(SELECT 1 FROM whaleu_experience.signin_days WHERE settlement_id=s.id AND owner_id=s.owner_id AND reward_day=s.reward_day) THEN RAISE EXCEPTION 'Sign-in day missing' USING ERRCODE='23514'; END IF;
  ELSE
    SELECT * INTO bucket FROM whaleu_experience.daily_buckets WHERE owner_id=s.owner_id AND reward_day=s.reward_day AND action=s.bucket_action;
    SELECT coalesce(sum(bucket_after-bucket_before),0),coalesce(sum(refund_after-refund_before),0),coalesce(sum(greatest(applied_delta,0)),0) INTO total_count,total_refunds,total_gross FROM whaleu_experience.settlements WHERE owner_id=s.owner_id AND reward_day=s.reward_day AND bucket_action=s.bucket_action;
    IF bucket.owner_id IS NULL OR (bucket.rewarded_count,bucket.refund_count,bucket.gross_positive_awarded::numeric) IS DISTINCT FROM (total_count,total_refunds,total_gross) THEN RAISE EXCEPTION 'Daily bucket does not reconcile' USING ERRCODE='23514'; END IF;
  END IF;
  SELECT max(level) INTO v_from_level FROM whaleu_experience.level_catalog WHERE threshold<=s.balance_before;
  SELECT max(level) INTO v_to_level FROM whaleu_experience.level_catalog WHERE threshold<=s.balance_after;
  IF v_to_level>v_from_level THEN
    IF NOT EXISTS(SELECT 1 FROM whaleu_experience.unlock_notices WHERE settlement_id=s.id AND owner_id=s.owner_id AND unlock_notices.from_level=v_from_level AND unlock_notices.to_level=v_to_level) THEN RAISE EXCEPTION 'Level notice missing' USING ERRCODE='23514'; END IF;
    IF EXISTS(SELECT 1 FROM whaleu_experience.title_catalog t WHERE t.kind='level' AND t.unlock_level<=v_to_level AND NOT EXISTS(SELECT 1 FROM whaleu_experience.entitlements e WHERE e.owner_id=s.owner_id AND e.title_key=t.title_key)) THEN RAISE EXCEPTION 'Earned title ownership incomplete' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER settlement_complete AFTER INSERT ON whaleu_experience.settlements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_experience.settlement_complete();
CREATE CONSTRAINT TRIGGER work_complete AFTER INSERT OR UPDATE ON whaleu_experience.work DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_experience.settlement_complete();
CREATE FUNCTION whaleu_experience.enrollment_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM whaleu_community.reward_source_groups WHERE enrollment_order=NEW.enrollment_order AND creation_transaction=NEW.creation_transaction) THEN RAISE EXCEPTION 'Experience enrollment reservation is incomplete' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER enrollment_complete AFTER INSERT ON whaleu_experience.enrollments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_experience.enrollment_complete();
-- Retained state and projections cannot be weakened through independent writes.
CREATE FUNCTION whaleu_experience.state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR NEW.owner_id<>OLD.owner_id THEN RAISE EXCEPTION 'Known experience state is retained' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER state_guard BEFORE UPDATE OR DELETE ON whaleu_experience.account_states FOR EACH ROW EXECUTE FUNCTION whaleu_experience.state_guard();
CREATE FUNCTION whaleu_experience.bucket_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (NEW.owner_id,NEW.reward_day,NEW.action,NEW.rule_version) IS DISTINCT FROM (OLD.owner_id,OLD.reward_day,OLD.action,OLD.rule_version) THEN RAISE EXCEPTION 'Daily bucket identity is retained' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bucket_guard BEFORE UPDATE OR DELETE ON whaleu_experience.daily_buckets FOR EACH ROW EXECUTE FUNCTION whaleu_experience.bucket_guard();
CREATE FUNCTION whaleu_experience.bucket_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bucket whaleu_experience.daily_buckets; total_count bigint; total_refunds bigint; total_gross numeric;
BEGIN
  SELECT * INTO bucket FROM whaleu_experience.daily_buckets WHERE owner_id=NEW.owner_id AND reward_day=NEW.reward_day AND action=NEW.action;
  SELECT coalesce(sum(bucket_after-bucket_before),0),coalesce(sum(refund_after-refund_before),0),coalesce(sum(greatest(applied_delta,0)),0) INTO total_count,total_refunds,total_gross FROM whaleu_experience.settlements WHERE owner_id=NEW.owner_id AND reward_day=NEW.reward_day AND bucket_action=NEW.action;
  IF (bucket.rewarded_count,bucket.refund_count,bucket.gross_positive_awarded::numeric) IS DISTINCT FROM (total_count,total_refunds,total_gross) THEN RAISE EXCEPTION 'Daily bucket lacks settlement evidence' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER bucket_complete AFTER INSERT OR UPDATE ON whaleu_experience.daily_buckets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_experience.bucket_complete();
ALTER TABLE whaleu_experience.settlements ADD CONSTRAINT settlement_bucket_shape CHECK(
  (action='sign_in' AND bucket_action IS NULL AND bucket_before IS NULL AND bucket_after IS NULL AND refund_before IS NULL AND refund_after IS NULL) OR
  (action<>'sign_in' AND bucket_action IS NOT NULL AND bucket_before IS NOT NULL AND bucket_after IS NOT NULL AND refund_before IS NOT NULL AND refund_after IS NOT NULL));
CREATE FUNCTION whaleu_experience.signin_projection_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM whaleu_experience.settlements WHERE id=NEW.settlement_id AND owner_id=NEW.owner_id AND action='sign_in' AND reward_day=NEW.reward_day AND applied_delta=(ARRAY[2,4,6,8,10,12,15])[NEW.streak]) THEN RAISE EXCEPTION 'Sign-in day disagrees with settlement' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER signin_projection_guard BEFORE INSERT ON whaleu_experience.signin_days FOR EACH ROW EXECUTE FUNCTION whaleu_experience.signin_projection_guard();
CREATE CONSTRAINT TRIGGER signin_state_complete AFTER INSERT ON whaleu_experience.signin_days DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_experience.account_complete();
CREATE FUNCTION whaleu_experience.unlock_projection_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s whaleu_experience.settlements; low_level integer; high_level integer; expected_titles text[]; expected_colors integer[];
BEGIN
  SELECT * INTO s FROM whaleu_experience.settlements WHERE id=NEW.settlement_id AND owner_id=NEW.owner_id;
  SELECT max(level) INTO low_level FROM whaleu_experience.level_catalog WHERE threshold<=s.balance_before;
  SELECT max(level) INTO high_level FROM whaleu_experience.level_catalog WHERE threshold<=s.balance_after;
  SELECT coalesce(array_agg(e.title_key ORDER BY t.unlock_level),'{}'::text[]) INTO expected_titles FROM whaleu_experience.entitlements e JOIN whaleu_experience.title_catalog t ON t.title_key=e.title_key WHERE e.settlement_id=s.id;
  SELECT coalesce(array_agg(color_id ORDER BY color_id),'{}'::integer[]) INTO expected_colors FROM whaleu_experience.color_catalog WHERE color_id>10 AND unlock_level>low_level AND unlock_level<=high_level;
  IF s.id IS NULL OR (NEW.from_level,NEW.to_level,NEW.created_at,NEW.title_keys,NEW.color_ids) IS DISTINCT FROM (low_level,high_level,s.applied_at,expected_titles,expected_colors) THEN RAISE EXCEPTION 'Unlock notice disagrees with earned rewards' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER unlock_projection_guard BEFORE INSERT ON whaleu_experience.unlock_notices FOR EACH ROW EXECUTE FUNCTION whaleu_experience.unlock_projection_guard();
ALTER TABLE whaleu_experience.requests ADD CONSTRAINT receipt_strict_fields CHECK(coalesce(
  (operation='sign_in' AND receipt ?& ARRAY['requestId','operation','outcome','rewardDay','appliedDelta','balance','streak','stateRevision'] AND
    jsonb_typeof(receipt->'requestId')='string' AND jsonb_typeof(receipt->'operation')='string' AND jsonb_typeof(receipt->'outcome')='string' AND
    jsonb_typeof(receipt->'rewardDay')='string' AND receipt->>'rewardDay' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND
    jsonb_typeof(receipt->'appliedDelta')='string' AND jsonb_typeof(receipt->'balance')='string' AND jsonb_typeof(receipt->'stateRevision')='string' AND
    jsonb_typeof(receipt->'streak')='number' AND receipt->>'streak' ~ '^[1-7]$') OR
  (operation='appearance' AND receipt ?& ARRAY['requestId','operation','outcome'] AND jsonb_typeof(receipt->'requestId')='string' AND jsonb_typeof(receipt->'operation')='string' AND jsonb_typeof(receipt->'outcome')='string' AND
    ((receipt->>'outcome'='rejected' AND receipt ? 'code' AND jsonb_typeof(receipt->'code')='string') OR
     (receipt->>'outcome'='applied' AND receipt ?& ARRAY['titleKey','colorId','revision'] AND jsonb_typeof(receipt->'titleKey') IN ('string','null') AND jsonb_typeof(receipt->'colorId') IN ('number','null') AND jsonb_typeof(receipt->'revision')='string'))),false));
CREATE FUNCTION whaleu_experience.request_projection_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s whaleu_experience.settlements; d whaleu_experience.signin_days; state whaleu_experience.account_states; selected whaleu_experience.appearance;
BEGIN
  IF NEW.operation='sign_in' THEN
    SELECT * INTO d FROM whaleu_experience.signin_days WHERE owner_id=NEW.owner_id AND reward_day=(NEW.receipt->>'rewardDay')::date;
    SELECT * INTO s FROM whaleu_experience.settlements WHERE id=d.settlement_id;
    SELECT * INTO state FROM whaleu_experience.account_states WHERE owner_id=NEW.owner_id;
    IF s.id IS NULL OR (NEW.receipt->>'streak')::integer<>d.streak THEN RAISE EXCEPTION 'Sign-in receipt lacks owned day' USING ERRCODE='23514'; END IF;
    IF NEW.receipt->>'outcome'='awarded' THEN
      IF ((NEW.receipt->>'appliedDelta')::bigint,(NEW.receipt->>'balance')::bigint,(NEW.receipt->>'stateRevision')::bigint) IS DISTINCT FROM (s.applied_delta,s.balance_after,s.state_revision) THEN RAISE EXCEPTION 'Sign-in receipt disagrees with reward' USING ERRCODE='23514'; END IF;
    ELSIF ((NEW.receipt->>'appliedDelta')::bigint,(NEW.receipt->>'balance')::bigint,(NEW.receipt->>'stateRevision')::bigint) IS DISTINCT FROM (0::bigint,state.balance,state.revision) THEN RAISE EXCEPTION 'Already-signed receipt disagrees with state' USING ERRCODE='23514'; END IF;
  ELSIF NEW.receipt->>'outcome'='applied' THEN
    SELECT * INTO selected FROM whaleu_experience.appearance WHERE owner_id=NEW.owner_id;
    IF selected.owner_id IS NULL OR (NEW.receipt->>'titleKey',(NEW.receipt->>'colorId')::integer,(NEW.receipt->>'revision')::bigint) IS DISTINCT FROM (selected.title_key,selected.color_id,selected.revision) THEN RAISE EXCEPTION 'Appearance receipt disagrees with selection' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER request_projection_guard BEFORE INSERT ON whaleu_experience.requests FOR EACH ROW EXECUTE FUNCTION whaleu_experience.request_projection_guard();
