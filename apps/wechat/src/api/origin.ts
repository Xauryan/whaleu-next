import { ClientError } from './errors';

/** Keep credentials on one explicit HTTPS origin; no hardcoded production destination. */
export function normalizeOrigin(origin: string): string {
  if (
    !/^https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?\/?$/i.test(
      origin,
    )
  ) {
    throw new ClientError(
      'configuration',
      'An explicit HTTPS API origin is required',
    );
  }
  return origin.replace(/\/$/, '');
}
export function endpointUrl(origin: string, path: string): string {
  if (
    !/^\/[a-zA-Z0-9/_-]*$/.test(path) ||
    path.startsWith('//') ||
    path.includes('//')
  ) {
    throw new ClientError(
      'configuration',
      'An API path must be a root-relative path without a query or fragment',
    );
  }
  return `${origin}${path}`;
}
