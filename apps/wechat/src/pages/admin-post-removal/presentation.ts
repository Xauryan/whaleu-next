/** Transient display-only disclosures. Never changes controller or action state. */
export function withModerationDetails<T extends { data: object }>(
  definition: T,
) {
  return {
    ...definition,
    data: {
      ...definition.data,
      detailsExpanded: false,
      historyExpanded: false,
    },
    onToggleDetails(this: {
      data: { detailsExpanded: boolean };
      setData(patch: Record<string, unknown>): void;
    }) {
      this.setData({ detailsExpanded: !this.data.detailsExpanded });
    },
    onToggleHistory(this: {
      data: { historyExpanded: boolean };
      setData(patch: Record<string, unknown>): void;
    }) {
      this.setData({ historyExpanded: !this.data.historyExpanded });
    },
  };
}
