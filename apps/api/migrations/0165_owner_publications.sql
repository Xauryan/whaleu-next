-- Bounded owner-only history seeks are index-backed for each identity filter.
CREATE INDEX posts_owner_publication ON whaleu_community.posts(account_id,author_mode,published_at DESC,id DESC);
CREATE INDEX comments_owner_publication ON whaleu_community.root_comments(account_id,author_mode,created_at DESC,id DESC);
CREATE INDEX replies_owner_publication ON whaleu_community.replies(account_id,author_mode,created_at DESC,id DESC);
