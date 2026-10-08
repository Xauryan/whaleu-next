import { ApplicationError } from '../../http/application-error.js';

// Recorded from the repository's pinned Node 24.19.0 runtime. A Unicode-data
// upgrade needs an intentional matcher version change, not silent cursor reuse.
export const SEARCH_UNICODE_VERSION = '17.0';
export const SEARCH_MATCHER_ID = `unicode-lower-substring-v1:${SEARCH_UNICODE_VERSION}`;

export function requireSearchMatcherRuntime(): void {
  if (process.versions['unicode'] !== SEARCH_UNICODE_VERSION)
    throw new ApplicationError('COMMUNITY_UNAVAILABLE');
}

/** Only call after canonical list visibility allows this exact, unchanged body. */
export function searchMatches(body: string, canonicalQuery: string): boolean {
  requireSearchMatcherRuntime();
  return body.toLowerCase().includes(canonicalQuery.toLowerCase());
}
