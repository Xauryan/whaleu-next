-- Empty local development storage only. No import, grants, delivery or rewards.
-- Reuse the discussion order under the same parent lock. Existing rows, hashes
-- and receipts remain unchanged; wall-clock equality never defines eligibility.
CREATE FUNCTION whaleu_community.saved_discussion_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM whaleu_community.posts WHERE id=NEW.post_id FOR UPDATE;
  IF TG_TABLE_NAME='root_comments' THEN
    NEW.interaction_sequence := nextval('whaleu_community.discussion_sequence');
  ELSE NEW.sequence := nextval('whaleu_community.discussion_sequence'); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER saved_discussion_order BEFORE INSERT ON whaleu_community.root_comments
  FOR EACH ROW EXECUTE FUNCTION whaleu_community.saved_discussion_order();
CREATE TRIGGER saved_discussion_order BEFORE INSERT ON whaleu_community.replies
  FOR EACH ROW EXECUTE FUNCTION whaleu_community.saved_discussion_order();

CREATE TABLE whaleu_community.saved_posts (
  account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
  post_id uuid NOT NULL REFERENCES whaleu_community.posts(id),
  epoch_id uuid, saved_at timestamptz,
  revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
  PRIMARY KEY(account_id,post_id),
  CHECK((epoch_id IS NULL)=(saved_at IS NULL)),
  CHECK(saved_at IS NULL OR isfinite(saved_at))
);
CREATE TABLE whaleu_community.saved_epochs (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL, post_id uuid NOT NULL,
  started_at timestamptz NOT NULL CHECK(isfinite(started_at)),
  started_sequence bigint NOT NULL UNIQUE CHECK(started_sequence>0),
  ended_at timestamptz CHECK(ended_at IS NULL OR isfinite(ended_at)),
  ended_sequence bigint UNIQUE,
  UNIQUE(id,account_id,post_id),
  FOREIGN KEY(account_id,post_id) REFERENCES whaleu_community.saved_posts(account_id,post_id),
  CHECK((ended_at IS NULL)=(ended_sequence IS NULL)),
  CHECK(ended_sequence IS NULL OR ended_sequence>started_sequence)
);
CREATE UNIQUE INDEX saved_one_active_epoch ON whaleu_community.saved_epochs(account_id,post_id) WHERE ended_sequence IS NULL;
ALTER TABLE whaleu_community.saved_posts ADD CONSTRAINT saved_current_epoch
  FOREIGN KEY(epoch_id,account_id,post_id) REFERENCES whaleu_community.saved_epochs(id,account_id,post_id);
CREATE INDEX saved_posts_list ON whaleu_community.saved_posts(account_id,saved_at DESC,epoch_id DESC) WHERE epoch_id IS NOT NULL;
CREATE INDEX saved_posts_count ON whaleu_community.saved_posts(post_id) WHERE epoch_id IS NOT NULL;
CREATE FUNCTION whaleu_community.saved_epoch_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.ended_sequence IS NOT NULL OR NEW.ended_sequence IS NULL OR
    (to_jsonb(OLD)-'ended_at'-'ended_sequence') IS DISTINCT FROM (to_jsonb(NEW)-'ended_at'-'ended_sequence') THEN
    RAISE EXCEPTION 'Saved epoch is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER saved_epoch_immutable BEFORE UPDATE OR DELETE ON whaleu_community.saved_epochs
  FOR EACH ROW EXECUTE FUNCTION whaleu_community.saved_epoch_immutable();
CREATE FUNCTION whaleu_community.saved_relation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (OLD.account_id,OLD.post_id) IS DISTINCT FROM (NEW.account_id,NEW.post_id) OR
    NEW.revision<=OLD.revision THEN
    RAISE EXCEPTION 'Saved relationship is retained and ordered' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER saved_relation_guard BEFORE UPDATE OR DELETE ON whaleu_community.saved_posts
  FOR EACH ROW EXECUTE FUNCTION whaleu_community.saved_relation_guard();
CREATE FUNCTION whaleu_community.saved_epoch_shape() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_row whaleu_community.saved_posts; epoch_row whaleu_community.saved_epochs;
BEGIN
  SELECT * INTO current_row FROM whaleu_community.saved_posts WHERE account_id=NEW.account_id AND post_id=NEW.post_id;
  SELECT * INTO epoch_row FROM whaleu_community.saved_epochs WHERE account_id=NEW.account_id AND post_id=NEW.post_id AND ended_sequence IS NULL;
  IF current_row.epoch_id IS DISTINCT FROM epoch_row.id OR
    current_row.saved_at IS DISTINCT FROM epoch_row.started_at OR
    (current_row.epoch_id IS NOT NULL AND current_row.revision<>epoch_row.started_sequence) THEN
    RAISE EXCEPTION 'Saved epoch and current relationship disagree' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER saved_relation_shape AFTER INSERT OR UPDATE ON whaleu_community.saved_posts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.saved_epoch_shape();
CREATE CONSTRAINT TRIGGER saved_epoch_shape AFTER INSERT OR UPDATE ON whaleu_community.saved_epochs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.saved_epoch_shape();

CREATE TABLE whaleu_community.post_update_preferences (
  account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
  post_id uuid NOT NULL REFERENCES whaleu_community.posts(id),
  saved_updates_enabled boolean NOT NULL DEFAULT true,
  external_updates_enabled boolean NOT NULL DEFAULT true,
  saved_changed_at timestamptz,
  external_changed_at timestamptz,
  revision bigint NOT NULL CHECK(revision>0),
  PRIMARY KEY(account_id,post_id),
  CHECK(saved_changed_at IS NULL OR isfinite(saved_changed_at)),
  CHECK(external_changed_at IS NULL OR isfinite(external_changed_at))
);
CREATE TRIGGER preference_retained BEFORE UPDATE OR DELETE ON whaleu_community.post_update_preferences
  FOR EACH ROW EXECUTE FUNCTION whaleu_community.saved_relation_guard();
CREATE TABLE whaleu_community.post_update_preference_history (
  account_id uuid NOT NULL, post_id uuid NOT NULL,
  revision bigint NOT NULL PRIMARY KEY CHECK(revision>0),
  changed_at timestamptz NOT NULL CHECK(isfinite(changed_at)),
  channel text NOT NULL CHECK(channel IN ('saved','external')),
  enabled boolean NOT NULL,
  saved_updates_enabled boolean NOT NULL,
  external_updates_enabled boolean NOT NULL,
  FOREIGN KEY(account_id,post_id) REFERENCES whaleu_community.post_update_preferences(account_id,post_id),
  CHECK((channel='saved' AND enabled=saved_updates_enabled) OR (channel='external' AND enabled=external_updates_enabled))
);
CREATE TRIGGER preference_history_immutable BEFORE UPDATE OR DELETE ON whaleu_community.post_update_preference_history
  FOR EACH ROW EXECUTE FUNCTION whaleu_community.poll_immutable();
CREATE FUNCTION whaleu_community.saved_preference_shape() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE settings whaleu_community.post_update_preferences; history whaleu_community.post_update_preference_history;
BEGIN
  SELECT * INTO settings FROM whaleu_community.post_update_preferences WHERE account_id=NEW.account_id AND post_id=NEW.post_id;
  SELECT * INTO history FROM whaleu_community.post_update_preference_history WHERE revision=settings.revision;
  IF history.revision IS NULL OR (settings.account_id,settings.post_id,settings.saved_updates_enabled,settings.external_updates_enabled)
    IS DISTINCT FROM (history.account_id,history.post_id,history.saved_updates_enabled,history.external_updates_enabled) THEN
    RAISE EXCEPTION 'Preference history and current state disagree' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER saved_preference_shape AFTER INSERT OR UPDATE ON whaleu_community.post_update_preferences
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.saved_preference_shape();

CREATE TABLE whaleu_community.saved_obligations (
  id uuid PRIMARY KEY,
  epoch_id uuid NOT NULL REFERENCES whaleu_community.saved_epochs(id),
  transition text NOT NULL CHECK(transition IN ('saved','unsaved')),
  action text NOT NULL CHECK(action IN ('saver_reward','author_reward','author_interactions','save_ranking')),
  recipient_account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
  delta smallint NOT NULL CHECK(delta IN (-1,1)),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','suppressed','failed')),
  UNIQUE(epoch_id,transition,action,recipient_account_id),
  CHECK((transition='saved' AND delta=1) OR (transition='unsaved' AND delta=-1 AND action IN ('author_interactions','save_ranking')))
);
CREATE TABLE whaleu_community.saved_requests (
  account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id), client_request_id uuid NOT NULL,
  payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
  operation text NOT NULL CHECK(operation IN ('set_post_saved','set_post_update_preference')),
  post_id uuid NOT NULL, desired boolean NOT NULL, channel text,
  receipt jsonb,
  PRIMARY KEY(account_id,client_request_id),
  CHECK(coalesce((operation='set_post_saved' AND channel IS NULL) OR (operation='set_post_update_preference' AND channel IN ('saved','external')),false)),
  CHECK(receipt IS NULL OR coalesce(jsonb_typeof(receipt)='object' AND
    receipt->>'requestId'=client_request_id::text AND receipt->>'operation'=operation AND
    receipt->>'postId'=post_id::text AND receipt->'desired'=to_jsonb(desired) AND
    receipt->'channel'=coalesce(to_jsonb(channel),'null'::jsonb) AND
    ((receipt->>'outcome'='applied' AND receipt-ARRAY['requestId','operation','postId','desired','channel','outcome']='{}'::jsonb) OR
     (receipt->>'outcome'='rejected' AND jsonb_typeof(receipt->'code')='string' AND
      receipt->>'code' IN ('POST_NOT_FOUND','COMMUNITY_SCOPE_UNAVAILABLE','PHONE_VERIFICATION_REQUIRED','COMMUNITY_ACTION_RESTRICTED') AND
      receipt-ARRAY['requestId','operation','postId','desired','channel','outcome','code']='{}'::jsonb)),false))
);
CREATE FUNCTION whaleu_community.saved_request_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.receipt IS NOT NULL OR NEW.receipt IS NULL OR
    (to_jsonb(OLD)-'receipt') IS DISTINCT FROM (to_jsonb(NEW)-'receipt') THEN
    RAISE EXCEPTION 'Saved request is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER saved_request_immutable BEFORE UPDATE OR DELETE ON whaleu_community.saved_requests
  FOR EACH ROW EXECUTE FUNCTION whaleu_community.saved_request_immutable();
CREATE FUNCTION whaleu_community.saved_request_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM whaleu_community.saved_requests WHERE account_id=NEW.account_id AND client_request_id=NEW.client_request_id AND receipt IS NULL) THEN
    RAISE EXCEPTION 'Saved request is incomplete' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER saved_request_complete AFTER INSERT ON whaleu_community.saved_requests
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.saved_request_complete();

-- Future consumers may advance their own outcome; the original obligation is
-- retained and cannot be retargeted, reclassified or changed into a new grant.
CREATE FUNCTION whaleu_community.saved_obligation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (to_jsonb(OLD)-'status') IS DISTINCT FROM (to_jsonb(NEW)-'status') THEN
    RAISE EXCEPTION 'Saved obligation identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER saved_obligation_immutable BEFORE UPDATE OR DELETE ON whaleu_community.saved_obligations
  FOR EACH ROW EXECUTE FUNCTION whaleu_community.saved_obligation_immutable();
