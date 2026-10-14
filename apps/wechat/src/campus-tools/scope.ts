/** Ephemeral browse selection only. It does not persist affiliation or location. */
export class ToolBrowseScope {
  private selected: string | null = null;
  private generation = 0;
  private readonly listeners = new Set<() => void>();
  snapshot() {
    return { campusId: this.selected, generation: this.generation };
  }
  select(campusId: string | null) {
    if (this.selected === campusId) return;
    this.selected = campusId;
    this.generation++;
    for (const listener of this.listeners) listener();
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
