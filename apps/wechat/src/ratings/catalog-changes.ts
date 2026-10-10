export interface RatingCatalogChange {
  readonly scopedHeads?: readonly {
    readonly scopeKey: string;
    readonly catalogRevision: string;
    readonly headRevision: string;
  }[];
  readonly releaseId: string;
  readonly catalogs: readonly {
    readonly regionId: string | null;
    readonly catalogRevision: string;
  }[];
}
/** A durable publication invalidates projections; historical receipts never install current data. */
export class RatingCatalogChanges {
  private readonly listeners = new Set<(change: RatingCatalogChange) => void>();
  subscribe(listener: (change: RatingCatalogChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  publish(change: RatingCatalogChange): void {
    const safe = Object.freeze({
      releaseId: change.releaseId,
      ...(change.scopedHeads === undefined
        ? {}
        : {
            scopedHeads: Object.freeze(
              change.scopedHeads.map((head) => Object.freeze({ ...head })),
            ),
          }),
      catalogs: Object.freeze(
        change.catalogs.map((catalog) =>
          Object.freeze({
            regionId: catalog.regionId,
            catalogRevision: catalog.catalogRevision,
          }),
        ),
      ),
    });
    for (const listener of [...this.listeners]) {
      try {
        listener(safe);
      } catch {
        // A bad rendering consumer cannot stop other consumers clearing revoked snapshots.
      }
    }
  }
}
