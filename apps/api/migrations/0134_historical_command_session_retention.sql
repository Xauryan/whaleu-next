-- Immutable moderation commands retain the original session UUID as audit
-- metadata, not as a lifetime lease on disposable Identity credential state.
-- These four command families already lock and validate exact actor/session/token
-- at issuance and repeat current Identity proof at finalization. Their immutable
-- history guards, account ownership FKs, UUID NOT NULL fields and actor-owned,
-- current-session-only receipt recovery are unchanged. Never cascade audit rows.
-- Do not generalize this to entities whose validity requires a live session.
ALTER TABLE whaleu_profile.moderation_commands
  DROP CONSTRAINT moderation_commands_session_id_fkey;
ALTER TABLE whaleu_profile.avatar_moderation_commands
  DROP CONSTRAINT avatar_moderation_commands_session_id_fkey;
ALTER TABLE whaleu_community.admin_post_removal_commands
  DROP CONSTRAINT admin_post_removal_commands_session_id_fkey;
ALTER TABLE whaleu_community.admin_discussion_removal_commands
  DROP CONSTRAINT admin_discussion_removal_commands_session_id_fkey;
