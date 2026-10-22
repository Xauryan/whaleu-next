import { ApplicationError } from '../../../src/http/application-error.js';
import { legacyCategorySchema } from '../../../src/community/contracts.js';
import { authorizeDiscussionPublication as authorizeCurrent } from '../../../src/community/discussion/publication-target.js';
export { withDiscussionPublicationMedia } from '../../../src/community/discussion/publication-target.js';

/** Test-only checked boundary for the f21 producer, whose post type had only
 * legacy categories and envelope versions 1–6. Never replaces authorization. */
export function requireLegacyDiscussionTarget<
  T extends {
    post: { category: unknown; publication_envelope_version?: number };
  },
>(target: T) {
  const category = legacyCategorySchema.safeParse(target.post.category);
  const version = target.post.publication_envelope_version;
  if (
    !category.success ||
    (version !== undefined && ![1, 2, 3, 4, 5, 6].includes(version))
  )
    throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
  return { ...target, post: { ...target.post, category: category.data } };
}

export async function authorizeDiscussionPublication(
  ...args: Parameters<typeof authorizeCurrent>
) {
  return requireLegacyDiscussionTarget(await authorizeCurrent(...args));
}
