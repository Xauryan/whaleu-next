import { createHash, randomBytes } from 'node:crypto';
import { ApplicationError } from '../http/application-error.js';

export function mintToken(purpose: 'access' | 'refresh'): string {
  return `wu_${purpose === 'access' ? 'a' : 'r'}_${randomBytes(32).toString('base64url')}`;
}
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
export function requireToken(
  token: unknown,
  purpose: 'access' | 'refresh',
): string {
  const prefix = purpose === 'access' ? 'a' : 'r';
  if (
    typeof token !== 'string' ||
    !new RegExp(`^wu_${prefix}_[A-Za-z0-9_-]{43}$`).test(token)
  )
    throw new ApplicationError('AUTHENTICATION_REQUIRED');
  return token;
}
export function bearerToken(header: unknown): string {
  if (typeof header !== 'string' || !header.startsWith('Bearer '))
    throw new ApplicationError('AUTHENTICATION_REQUIRED');
  return requireToken(header.slice(7), 'access');
}
