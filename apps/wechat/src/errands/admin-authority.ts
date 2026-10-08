import { exact } from '../community/contract';
import type { Authorization } from '../identity-privacy/overlay';
import { decodeErrandAdminAuthorization } from './admin-contract';
import { errandId, invalidErrand } from './contract';

/** Local recovery binding, never an authorization token or a field sent to the API. */
export interface ErrandAdminAuthority {
  readonly role: Exclude<Authorization['role'], 'member'>;
  readonly operatingRegionIds: readonly string[];
  readonly regionId: string | null;
}
export function decodeErrandAdminAuthority(
  value: unknown,
): ErrandAdminAuthority {
  exact(value, ['role', 'operatingRegionIds', 'regionId']);
  if (
    !['school_admin', 'super_admin', 'developer'].includes(
      String(value.role),
    ) ||
    !Array.isArray(value.operatingRegionIds) ||
    value.operatingRegionIds.length > 1 ||
    !value.operatingRegionIds.every(errandId) ||
    !(value.regionId === null || errandId(value.regionId)) ||
    (value.role === 'school_admin' &&
      (value.operatingRegionIds.length !== 1 ||
        value.regionId !== value.operatingRegionIds[0]))
  )
    invalidErrand();
  return Object.freeze({
    role: value.role as ErrandAdminAuthority['role'],
    operatingRegionIds: Object.freeze([...value.operatingRegionIds]),
    regionId: value.regionId as string | null,
  });
}
export function errandAdminAuthority(
  raw: Authorization,
  regionId: string | null,
): ErrandAdminAuthority {
  const auth = decodeErrandAdminAuthorization(raw);
  return decodeErrandAdminAuthority({
    role: auth.role,
    operatingRegionIds: auth.management.operatingRegionIds,
    regionId,
  });
}
export function sameErrandAdminAuthority(
  original: ErrandAdminAuthority,
  current: Authorization,
): boolean {
  try {
    return (
      JSON.stringify(original) ===
      JSON.stringify(errandAdminAuthority(current, original.regionId))
    );
  } catch {
    return false;
  }
}

/** Recovery may use a newly selected role, but never a different order target. */
export function coversErrandAdminTarget(
  raw: Authorization,
  regionId: string | null,
): boolean {
  try {
    const current = decodeErrandAdminAuthorization(raw);
    return (
      current.management.global ||
      (regionId !== null &&
        current.role === 'school_admin' &&
        current.management.operatingRegionIds[0] === regionId)
    );
  } catch {
    return false;
  }
}
