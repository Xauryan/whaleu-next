import { ApplicationError } from '../../http/application-error.js';
import { scopedDigest, scopedId } from '../scoped/contracts.js';
import { RATING_SCOPED_SCOPE_LIMIT } from '../scoped/constants.js';
import { RATING_CATEGORY_ICON_EXTENSION } from './icon-contracts.js';

/** Release metadata alone dispatches each scope, including empty catalogs.
 * Partial or unknown markers never become evidence of legacy absence. */
export function categoryIconScopeAdopted(
  cause: unknown,
  scopeKey: string,
): boolean {
  if (!cause || typeof cause !== 'object' || Array.isArray(cause))
    throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
  const marker = cause as Record<string, unknown>;
  const fields = [
    'categoryIconExtension',
    'categoryIconDigest',
    'categoryIconScopeKeys',
  ] as const;
  if (fields.every((field) => !Object.hasOwn(marker, field))) return false;
  const keys = marker['categoryIconScopeKeys'];
  if (
    fields.some((field) => !Object.hasOwn(marker, field)) ||
    marker['categoryIconExtension'] !== RATING_CATEGORY_ICON_EXTENSION ||
    !scopedDigest.safeParse(marker['categoryIconDigest']).success ||
    !Array.isArray(keys) ||
    !keys.length ||
    keys.length > RATING_SCOPED_SCOPE_LIMIT ||
    Array.from(keys).some(
      (key, index) =>
        typeof key !== 'string' ||
        (key !== 'global' &&
          (!key.startsWith('campus:') ||
            !scopedId.safeParse(key.slice(7)).success)) ||
        (index > 0 && keys[index - 1] >= key),
    )
  )
    throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
  return keys.includes(scopeKey);
}
