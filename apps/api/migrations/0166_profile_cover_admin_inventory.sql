-- Cover request markers advance the existing media owner epoch. They must
-- participate in all administrative owners' live source inventory, just like
-- every other epoch input. Preserve the original fail-closed inventory and
-- same-transaction statement guards; do not special-case cover out of any.
CREATE TRIGGER a00_admin_post_removal_source_statement
 BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
 ON whaleu_media.profile_cover_request_markers
 FOR EACH STATEMENT
 EXECUTE FUNCTION whaleu_community.admin_post_removal_source_statement_guard();

CREATE TRIGGER a00_admin_discussion_removal_source_statement
 BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
 ON whaleu_media.profile_cover_request_markers
 FOR EACH STATEMENT
 EXECUTE FUNCTION whaleu_community.admin_discussion_removal_source_statement_guard();

CREATE TRIGGER a00_avatar_moderation_media_statement
 BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
 ON whaleu_media.profile_cover_request_markers
 FOR EACH STATEMENT
 EXECUTE FUNCTION whaleu_profile.avatar_moderation_media_statement_guard();

DO $$
BEGIN
 IF NOT whaleu_community.admin_post_removal_inventory_current()
    OR NOT whaleu_community.admin_discussion_removal_inventory_current()
    OR NOT whaleu_profile.avatar_moderation_media_inventory_current()
 THEN
  RAISE EXCEPTION 'Incomplete profile-cover administrative input inventory';
 END IF;
END$$;
