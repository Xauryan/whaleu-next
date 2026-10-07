export const privilegedRoles = [
  'school_admin',
  'super_admin',
  'developer',
] as const;
export type PrivilegedRole = (typeof privilegedRoles)[number];
export type EffectiveRole = 'member' | PrivilegedRole;

/** An immutable grant binds school administrators to an operating region, never a campus. */
export interface ActiveGrant {
  readonly id: string;
  readonly role: PrivilegedRole;
  readonly operatingRegionId: string | null;
  /** Internal locked-grant deadline, never an HTTP capability field. */
  readonly validUntil: number | null;
}
export interface AuthorizationCapabilities {
  readonly role: EffectiveRole;
  readonly management: {
    readonly global: boolean;
    readonly operatingRegionIds: string[];
  };
  readonly identityView: {
    readonly allowed: boolean;
    readonly maxBatchSize: 20;
  };
}
export const IDENTITY_BATCH_LIMIT = 20 as const;
const rank: Record<EffectiveRole, number> = {
  member: 0,
  school_admin: 1,
  super_admin: 2,
  developer: 3,
};

export function capabilitiesFromGrants(
  grants: readonly ActiveGrant[],
): AuthorizationCapabilities {
  const role = grants.reduce<EffectiveRole>(
    (highest, grant) =>
      rank[grant.role] > rank[highest] ? grant.role : highest,
    'member',
  );
  const global = role === 'developer' || role === 'super_admin';
  return {
    role,
    management: {
      global,
      operatingRegionIds: [
        ...new Set(
          grants
            .filter(
              (grant) =>
                grant.role === 'school_admin' &&
                grant.operatingRegionId !== null,
            )
            .map((grant) => grant.operatingRegionId!),
        ),
      ].sort(),
    },
    identityView: {
      allowed: role === 'developer',
      maxBatchSize: IDENTITY_BATCH_LIMIT,
    },
  };
}

/** Advisory UI capabilities never replace a fresh server-side check at an action boundary. */
export function canManageRegion(
  grants: readonly ActiveGrant[],
  operatingRegionId: string | null,
): boolean {
  return grants.some(
    (grant) =>
      grant.role === 'developer' ||
      grant.role === 'super_admin' ||
      (operatingRegionId !== null &&
        grant.operatingRegionId === operatingRegionId),
  );
}
