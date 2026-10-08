/**
 * Application schemas created by the real migrations, in cleanup order.
 * Refuse these before claiming a disposable database and only drop them after
 * that suite has claimed ownership. Keep suite-specific fixture schemas local.
 */
export const migrationSchemaNames = [
  'whaleu_post_hotness',
  'whaleu_experience',
  'whaleu_safety',
  'whaleu_notifications',
  'whaleu_verification',
  'whaleu_authorization',
  'whaleu_community',
  'whaleu_profile',
  'whaleu_campus',
  'whaleu_identity',
  'whaleu_meta',
] as const;
