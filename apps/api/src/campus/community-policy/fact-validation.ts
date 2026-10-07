import { z } from 'zod';
import type { PolicyProvenance } from './contracts.js';

const coverage = z.enum(['complete', 'missing', 'conflicting']);
const groupSchema = z.strictObject({
  groupId: z.uuid(),
  coverage,
  isActive: z.boolean(),
});
const regionSchema = z.strictObject({
  regionId: z.uuid(),
  institutionId: z.uuid(),
  groupId: z.uuid(),
  coverage,
  isActive: z.boolean(),
});
const assignmentSchema = z.strictObject({
  campusId: z.uuid(),
  institutionId: z.uuid(),
  regionId: z.uuid(),
  coverage,
  isActive: z.boolean(),
});
const topologySchema = z.strictObject({
  version: z.literal(1),
  groups: z.array(groupSchema),
  regions: z.array(regionSchema),
  assignments: z.array(assignmentSchema),
});
export type TopologySnapshotData = z.infer<typeof topologySchema>;
export type TopologyRegion = z.infer<typeof regionSchema>;
export interface Topology {
  groups: ReadonlyMap<string, z.infer<typeof groupSchema>>;
  regions: ReadonlyMap<string, TopologyRegion>;
  assignments: ReadonlyMap<string, z.infer<typeof assignmentSchema>>;
}

/** Duplicate memberships are conflicts, even if they repeat the same value. */
export function parseTopology(value: unknown): Topology | null {
  const parsed = topologySchema.safeParse(value);
  if (!parsed.success) return null;
  const groups = new Map(parsed.data.groups.map((row) => [row.groupId, row]));
  const regions = new Map(
    parsed.data.regions.map((row) => [row.regionId, row]),
  );
  const assignments = new Map(
    parsed.data.assignments.map((row) => [row.campusId, row]),
  );
  if (
    groups.size !== parsed.data.groups.length ||
    regions.size !== parsed.data.regions.length ||
    assignments.size !== parsed.data.assignments.length
  )
    return null;
  if ([...regions.values()].some((row) => !groups.has(row.groupId)))
    return null;
  if (
    [...assignments.values()].some((row) => {
      const region = regions.get(row.regionId);
      return !region || region.institutionId !== row.institutionId;
    })
  )
    return null;
  return { groups, regions, assignments };
}

export function knownRegion(topology: Topology, id: string) {
  const region = topology.regions.get(id);
  const group = region && topology.groups.get(region.groupId);
  return region?.coverage === 'complete' &&
    region.isActive &&
    group?.coverage === 'complete' &&
    group.isActive
    ? region
    : null;
}

export function validProvenance(fact: PolicyProvenance, now: number): boolean {
  const effective =
    fact.effective_at instanceof Date
      ? fact.effective_at.getTime()
      : Number.NaN;
  const until =
    fact.valid_until instanceof Date ? fact.valid_until.getTime() : undefined;
  return (
    fact.coverage_state === 'complete' &&
    fact.provenance_state === 'accepted' &&
    !!fact.source_reference?.trim() &&
    !!fact.policy_reference?.trim() &&
    Number.isFinite(now) &&
    Number.isFinite(effective) &&
    effective <= now &&
    (fact.expiry_kind === 'policy_exempt'
      ? fact.valid_until === null
      : fact.expiry_kind === 'at' &&
        until !== undefined &&
        Number.isFinite(until) &&
        until > effective &&
        until > now)
  );
}

export function earliestDeadline(...deadlines: (number | null)[]) {
  const bounded = deadlines.filter((value): value is number => value !== null);
  return bounded.length ? Math.min(...bounded) : null;
}
