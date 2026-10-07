-- Empty C2B discussion storage. No source import, provider or authority activation.
CREATE SEQUENCE whaleu_community.discussion_sequence;
ALTER TABLE whaleu_community.root_comments ADD COLUMN interaction_sequence bigint;
-- Existing C1 roots preserve deterministic chronology; heap/update order is not evidence.
DO $$
DECLARE root_record record;
BEGIN
 FOR root_record IN SELECT id FROM whaleu_community.root_comments ORDER BY created_at,id LOOP
  UPDATE whaleu_community.root_comments SET interaction_sequence=nextval('whaleu_community.discussion_sequence') WHERE id=root_record.id;
 END LOOP;
END $$;
ALTER TABLE whaleu_community.root_comments ALTER COLUMN interaction_sequence SET DEFAULT nextval('whaleu_community.discussion_sequence');
ALTER TABLE whaleu_community.root_comments ALTER COLUMN interaction_sequence SET NOT NULL;
ALTER TABLE whaleu_community.root_comments ADD CONSTRAINT root_comments_id_post UNIQUE(id,post_id);
CREATE FUNCTION whaleu_community.root_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (OLD.id,OLD.post_id,OLD.account_id,OLD.author_mode,OLD.interaction_sequence)
   IS DISTINCT FROM (NEW.id,NEW.post_id,NEW.account_id,NEW.author_mode,NEW.interaction_sequence)
 THEN RAISE EXCEPTION 'Root identity and parent are immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER root_identity_immutable BEFORE UPDATE ON whaleu_community.root_comments
 FOR EACH ROW EXECUTE FUNCTION whaleu_community.root_identity_immutable();
CREATE TABLE whaleu_community.replies (
  id uuid PRIMARY KEY,
  post_id uuid NOT NULL REFERENCES whaleu_community.posts(id),
  root_comment_id uuid NOT NULL,
  target_reply_id uuid,
  account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
  text text NOT NULL,
  author_mode text NOT NULL CHECK (author_mode IN ('named','anonymous')),
  visibility text NOT NULL DEFAULT 'approved' CHECK (visibility IN ('approved','hidden')),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  sequence bigint NOT NULL DEFAULT nextval('whaleu_community.discussion_sequence') UNIQUE CHECK(sequence>0),
  UNIQUE(id,root_comment_id,post_id),
  FOREIGN KEY(root_comment_id,post_id) REFERENCES whaleu_community.root_comments(id,post_id),
  FOREIGN KEY(target_reply_id,root_comment_id,post_id) REFERENCES whaleu_community.replies(id,root_comment_id,post_id),
  CHECK(target_reply_id IS DISTINCT FROM id)
);
CREATE FUNCTION whaleu_community.reply_target_precedes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.target_reply_id IS NOT NULL AND EXISTS(SELECT 1 FROM whaleu_community.replies WHERE id=NEW.target_reply_id AND sequence>=NEW.sequence)
 THEN RAISE EXCEPTION 'Reply target must precede reply' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER reply_target_precedes AFTER INSERT ON whaleu_community.replies
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.reply_target_precedes();
CREATE INDEX replies_root ON whaleu_community.replies(root_comment_id,sequence);
CREATE INDEX replies_account ON whaleu_community.replies(account_id);
CREATE FUNCTION whaleu_community.reply_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Reply records are retained' USING ERRCODE='23514'; END IF;
 IF (OLD.id,OLD.post_id,OLD.root_comment_id,OLD.target_reply_id,OLD.account_id,OLD.author_mode,OLD.text,OLD.created_at,OLD.sequence)
   IS DISTINCT FROM (NEW.id,NEW.post_id,NEW.root_comment_id,NEW.target_reply_id,NEW.account_id,NEW.author_mode,NEW.text,NEW.created_at,NEW.sequence)
 THEN RAISE EXCEPTION 'Reply content and target are immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reply_identity_immutable BEFORE UPDATE OR DELETE ON whaleu_community.replies
 FOR EACH ROW EXECUTE FUNCTION whaleu_community.reply_identity_immutable();
CREATE TABLE whaleu_community.reply_images (
 reply_id uuid NOT NULL REFERENCES whaleu_community.replies(id), asset_id uuid NOT NULL,
 digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'), position integer NOT NULL CHECK(position BETWEEN 0 AND 2),
 PRIMARY KEY(reply_id,position), UNIQUE(reply_id,asset_id)
);
CREATE TABLE whaleu_community.comment_likes (
 comment_id uuid NOT NULL REFERENCES whaleu_community.root_comments(id),
 account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id), PRIMARY KEY(comment_id,account_id)
);
CREATE TABLE whaleu_community.reply_likes (
 reply_id uuid NOT NULL REFERENCES whaleu_community.replies(id),
 account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id), PRIMARY KEY(reply_id,account_id)
);
CREATE TABLE whaleu_community.comment_pins (
 post_id uuid PRIMARY KEY REFERENCES whaleu_community.posts(id),
 comment_id uuid NOT NULL UNIQUE,
 pinned_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
 FOREIGN KEY(comment_id,post_id) REFERENCES whaleu_community.root_comments(id,post_id)
);
ALTER TABLE whaleu_community.outbox ADD COLUMN context jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(context)='object');
ALTER TABLE whaleu_community.publication_requests DROP CONSTRAINT publication_requests_operation_check;
ALTER TABLE whaleu_community.publication_requests ADD CONSTRAINT publication_requests_operation_check CHECK(operation IN ('publish_post','publish_comment','publish_reply'));
-- Old C1 payload hashes and terminal receipt bytes are not rewritten.
CREATE FUNCTION whaleu_community.publication_request_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Publication request is immutable' USING ERRCODE='23514'; END IF;
 IF (OLD.account_id,OLD.client_request_id,OLD.payload_hash,OLD.operation) IS DISTINCT FROM
    (NEW.account_id,NEW.client_request_id,NEW.payload_hash,NEW.operation) OR OLD.receipt IS NOT NULL OR NEW.receipt IS NULL
 THEN RAISE EXCEPTION 'Publication request is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER publication_request_immutable BEFORE UPDATE OR DELETE ON whaleu_community.publication_requests
 FOR EACH ROW EXECUTE FUNCTION whaleu_community.publication_request_immutable();
CREATE FUNCTION whaleu_community.publication_request_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM whaleu_community.publication_requests WHERE account_id=NEW.account_id AND client_request_id=NEW.client_request_id AND receipt IS NULL)
 THEN RAISE EXCEPTION 'Publication request is incomplete' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER publication_request_complete AFTER INSERT ON whaleu_community.publication_requests
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.publication_request_complete();
CREATE TABLE whaleu_community.discussion_requests (
 account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id), client_request_id uuid NOT NULL,
 payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
 operation text NOT NULL CHECK(operation IN ('set_comment_like','set_reply_like','set_comment_pin')),
 receipt jsonb, PRIMARY KEY(account_id,client_request_id),
 CHECK(receipt IS NULL OR coalesce(jsonb_typeof(receipt)='object' AND receipt->>'requestId'=client_request_id::text AND
  receipt->>'operation'=operation AND receipt->>'outcome' IN ('applied','rejected'),false))
);
CREATE TRIGGER discussion_request_immutable BEFORE UPDATE OR DELETE ON whaleu_community.discussion_requests
 FOR EACH ROW EXECUTE FUNCTION whaleu_community.publication_request_immutable();
CREATE FUNCTION whaleu_community.discussion_request_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM whaleu_community.discussion_requests WHERE account_id=NEW.account_id AND client_request_id=NEW.client_request_id AND receipt IS NULL)
 THEN RAISE EXCEPTION 'Discussion request is incomplete' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER discussion_request_complete AFTER INSERT ON whaleu_community.discussion_requests
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.discussion_request_complete();
ALTER TABLE whaleu_authorization.identity_view_audit DROP CONSTRAINT identity_view_audit_target_kind_check;
ALTER TABLE whaleu_authorization.identity_view_audit ADD CONSTRAINT identity_view_audit_target_kind_check CHECK(target_kind IN ('post','comment','reply'));
