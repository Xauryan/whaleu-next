import {
  splitContentReferenceText,
  type ContentReferenceTextSegment,
} from '../../content-references/text';
interface TextEvent {
  currentTarget: { dataset: { revision?: number; index?: number } };
}
Component({
  options: { virtualHost: true, styleIsolation: 'isolated' },
  properties: {
    source: { type: String, value: '' },
    available: { type: Boolean, value: false },
    rowKey: { type: String, value: '' },
    generation: { type: Number, value: 0 },
    fallback: { type: Boolean, value: false },
    disabled: { type: Boolean, value: false },
    placeholder: { type: String, value: '' },
  },
  data: {
    segments: [] as ContentReferenceTextSegment[],
    revision: 0,
    active: false,
    visible: true,
    pressed: -1,
    longPressed: false,
  },
  observers: {
    'source, available, rowKey, generation, disabled'() {
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
      this.data.active = false;
      this.data.pressed = -1;
    },
  },
  pageLifetimes: {
    hide() {
      this.data.visible = false;
      this.data.pressed = -1;
    },
    show() {
      this.data.visible = true;
      this.sync();
    },
  },
  methods: {
    sync() {
      this.data.pressed = -1;
      this.data.longPressed = false;
      this.setData({
        revision: this.data.revision + 1,
        segments: splitContentReferenceText(
          this.properties.source,
          this.properties.available === true,
        ),
      });
    },
    onStart(event: TextEvent) {
      if (
        !this.data.active ||
        !this.data.visible ||
        this.properties.disabled ||
        event.currentTarget.dataset.revision !== this.data.revision
      )
        return;
      this.data.longPressed = false;
      this.data.pressed = this.data.revision;
    },
    onLongPress() {
      this.data.longPressed = true;
      this.data.pressed = -1;
    },
    onCancel() {
      this.data.longPressed = true;
      this.data.pressed = -1;
    },
    onTap(event: TextEvent) {
      if (
        !this.data.active ||
        !this.data.visible ||
        this.properties.disabled ||
        this.data.longPressed ||
        event.currentTarget.dataset.revision !== this.data.revision
      )
        return;
      // Native accessibility activation may synthesize tap without touchstart.
      // Current inner revision is required; blocked longpress/cancel gestures
      // stay suppressed until a fresh touch or render, not a timing heuristic.
      this.data.pressed = -1;
      const segment =
        this.data.segments[event.currentTarget.dataset.index ?? -1];
      const detail = {
        rowKey: this.properties.rowKey,
        generation: this.properties.generation,
      };
      if (this.properties.available === true && segment?.kind === 'reference') {
        this.triggerEvent(
          'referencepress',
          { ...detail, code: segment.code, start: segment.start },
          { bubbles: false, composed: false },
        );
      } else if (this.properties.fallback) {
        this.triggerEvent('plaintextpress', detail, {
          bubbles: false,
          composed: false,
        });
      }
    },
  },
});
