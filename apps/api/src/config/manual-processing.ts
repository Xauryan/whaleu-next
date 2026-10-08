import type { RuntimeConfig } from './config.js';

const processingFields = {
  updates: 'COMMUNITY_UPDATES_PROCESSING',
  jury: 'SAFETY_JURY_PROCESSING',
  experience: 'EXPERIENCE_PROCESSING',
  subscriptions: 'SUBSCRIPTION_COMPONENT_PROCESSING',
  likes: 'LIKE_COMPONENT_PROCESSING',
  comments: 'COMMENT_COMPONENT_PROCESSING',
} as const;

/** A selected CLI run must never start any background dispatcher, even when
 * its inherited application environment opts into automatic processing. */
export function manualProcessingConfig(
  config: RuntimeConfig,
  owner: keyof typeof processingFields,
): RuntimeConfig {
  const field = processingFields[owner];
  return Object.freeze({
    ...config,
    COMMUNITY_UPDATES_PROCESSING: 'disabled',
    SAFETY_JURY_PROCESSING: 'disabled',
    EXPERIENCE_PROCESSING: 'disabled',
    SUBSCRIPTION_COMPONENT_PROCESSING: 'disabled',
    LIKE_COMPONENT_PROCESSING: 'disabled',
    COMMENT_COMPONENT_PROCESSING: 'disabled',
    VIEW_REPORTING_RETENTION_PROCESSING: 'disabled',
    [field]: config[field] === 'disabled' ? 'disabled' : 'manual_only',
  });
}
