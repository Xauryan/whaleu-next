import { ClientError } from './errors';

/** Keep credentials on one explicit HTTPS origin; no hardcoded production destination. */
export function normalizeOrigin(origin: string): string {
  const match = /^https:\/\/([^/:?#@]+)(?::([0-9]{1,5}))?\/?$/i.exec(origin);
  const hostname = match?.[1];
  const port = match?.[2];
  if (
    match?.[0] !== origin ||
    !hostname ||
    hostname.length > 253 ||
    !hostname
      .split('.')
      .every((label) =>
        /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label),
      ) ||
    (port !== undefined && (Number(port) < 1 || Number(port) > 65535))
  ) {
    throw new ClientError(
      'configuration',
      'An explicit HTTPS API origin is required',
    );
  }
  return origin.replace(/\/$/, '').toLowerCase();
}
export function endpointUrl(
  origin: string,
  path: string,
  query?: Readonly<Record<string, string | number>>,
): string {
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
  const parameters = Object.entries(query ?? {}).map(([key, value]) => {
    if (
      !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key) ||
      (typeof value !== 'string' &&
        (typeof value !== 'number' || !Number.isFinite(value)))
    )
      throw new ClientError('configuration', 'Invalid API query');
    try {
      return `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`;
    } catch {
      throw new ClientError('configuration', 'Invalid API query encoding');
    }
  });
  return `${origin}${path}${parameters.length ? `?${parameters.join('&')}` : ''}`;
}
