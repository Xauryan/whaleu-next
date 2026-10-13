import type { PoolClient } from 'pg';

/** Canonical counts fence active regions only; related view callers opt into all topology sources. */
export async function fenceSmallCampusContentCount(
  tx: PoolClient,
  relatedDistribution = false,
): Promise<void> {
  await tx.query(
    relatedDistribution
      ? 'LOCK TABLE whaleu_campus.community_topology_snapshots, whaleu_campus.community_topology_heads, whaleu_campus.community_distribution_generation, whaleu_campus.operating_regions IN SHARE MODE NOWAIT'
      : 'LOCK TABLE whaleu_campus.operating_regions IN SHARE MODE NOWAIT',
  );
}
