-- Only expands the existing named block source contract. No profile, display
-- entitlement, verification, provider, production import or access grant is created.
ALTER TABLE whaleu_safety.blocks DROP CONSTRAINT blocks_source_kind_check;
ALTER TABLE whaleu_safety.blocks ADD CONSTRAINT blocks_source_kind_check
  CHECK(source_kind IN ('post','comment','reply','profile'));
