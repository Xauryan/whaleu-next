import { ApplicationError } from '../../../src/http/application-error.js';
import { legacyCategorySchema } from '../../../src/community/contracts.js';
import { authorizeDiscussionPublication as authorizeCurrent } from '../../../src/community/discussion/publication-target.js';
export { withDiscussionPublicationMedia } from '../../../src/community/discussion/publication-target.js';

/** TEST ONLY: c27 knows legacy categories and envelope versions 1–5.
 * This checked narrowing runs after, and never substitutes for, authorization.
 */
export function requireC27DiscussionTarget<
  T extends {
    post: { category: unknown; publication_envelope_version?: number };
  },
>(target: T) {
  const category = legacyCategorySchema.safeParse(target.post.category);
  const version = target.post.publication_envelope_version;
  if (
    !category.success ||
    (version !== undefined && ![1, 2, 3, 4, 5].includes(version))
  )
    throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
  return { ...target, post: { ...target.post, category: category.data } };
}

export async function authorizeDiscussionPublication(
  ...args: Parameters<typeof authorizeCurrent>
) {
  return requireC27DiscussionTarget(await authorizeCurrent(...args));
}
