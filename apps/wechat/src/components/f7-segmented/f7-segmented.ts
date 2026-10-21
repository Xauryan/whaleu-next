import {
  segmentPresentation,
  selectedSegment,
  type SegmentOption,
} from './model';
/** Project-owned native port of Framework7 v9.2.0 Segmented Strong (MIT). */
Component({
  options: { styleIsolation: 'isolated' },
  properties: {
    options: { type: Array, value: [] as SegmentOption[] },
    value: { type: String, value: '' },
    disabled: { type: Boolean, value: false },
    label: { type: String, value: '选项' },
  },
  data: { items: [] as SegmentOption[], activeIndex: -1, highlightStyle: '' },
  observers: {
    'options, value'(
      this: { setData(data: Record<string, unknown>): void },
      options: unknown,
      value: string,
    ) {
      this.setData(segmentPresentation(options, value));
    },
  },
  lifetimes: {
    attached() {
      this.setData(
        segmentPresentation(this.properties.options, this.properties.value),
      );
    },
  },
  methods: {
    onSelect(event: { currentTarget: { dataset: { value?: unknown } } }) {
      const value = selectedSegment(
        this.properties.options,
        this.properties.value,
        event.currentTarget.dataset.value,
        this.properties.disabled,
      );
      if (value !== null)
        this.triggerEvent(
          'change',
          { value },
          { bubbles: false, composed: false },
        );
    },
  },
});
