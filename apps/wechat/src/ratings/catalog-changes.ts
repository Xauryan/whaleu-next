export interface RatingCatalogChange {
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
