import {
  renderTextSource,
  type SourceTextBlock,
  type SourceTextRender,
} from '../../community/text-source-renderer';
import type { SourcePresentation } from '../../community/text-source-read-contract';
import type { TextSourceDescriptor } from '../../community/text-source-contract';

function emptyRender() {
  return {
    rawSource: '',
    blocks: [] as readonly SourceTextBlock[],
    mode: 'unavailable' as SourceTextRender['mode'],
    canToggleSource: false,
    showingRaw: false,
  };
}
interface ToggleEvent {
  currentTarget: { dataset: { revision?: number } };
}
Component({
  options: { styleIsolation: 'isolated' },
  properties: {
    descriptor: { type: Object, value: null as TextSourceDescriptor | null },
    source: { type: String, value: '' },
    presentation: { type: Object, value: null as SourcePresentation | null },
    preview: { type: Boolean, value: false },
    disabled: { type: Boolean, value: false },
  },
  data: { ...emptyRender(), active: false, visible: false, revision: 0 },
  observers: {
    'descriptor, source, presentation, preview, disabled'() {
      this.sync();
    },
  },
  lifetimes: {
    attached() {
      this.data.active = true;
      this.data.visible = true;
      this.sync();
    },
    detached() {
      // No writes to a detached native view. No retained private source cache.
      Object.assign(this.data, emptyRender(), {
        active: false,
        visible: false,
        revision: this.data.revision + 1,
      });
    },
  },
  pageLifetimes: {
    hide() {
      this.data.visible = false;
      this.setData({
        ...emptyRender(),
        visible: false,
        revision: this.data.revision + 1,
      });
    },
    show() {
      this.data.visible = true;
      this.sync();
    },
  },
  methods: {
    sync() {
      if (!this.data.active || !this.data.visible) return;
      const rendered = renderTextSource(this.properties);
      this.setData({
        rawSource: rendered.rawSource,
        blocks: rendered.blocks,
        mode: rendered.mode,
        canToggleSource: rendered.canToggleSource,
        showingRaw: false,
        active: true,
        visible: true,
        revision: this.data.revision + 1,
      });
    },
    onToggleSource(event: ToggleEvent) {
      if (
        !this.data.active ||
        !this.data.visible ||
        this.properties.disabled ||
        !this.data.canToggleSource ||
        event?.currentTarget?.dataset?.revision !== this.data.revision
      )
        return;
      // View-only state. Never emits editor/change events or rewrites properties.
      this.setData({ showingRaw: !this.data.showingRaw });
    },
  },
});
