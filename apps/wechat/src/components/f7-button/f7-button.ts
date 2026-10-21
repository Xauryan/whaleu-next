/**
 * Native adaptation of Framework7 v9.2.0 (MIT), not its DOM runtime.
 * Copyright (c) 2014 Vladimir Kharlampidi.
 * See docs/vendor/framework7-v9.2.0/LICENSE.
 *
 * Slots are presentational. Business actions belong to the owner's press
 * handler; this component never navigates, logs in or forwards open-type.
 */
Component({
  options: { multipleSlots: true, styleIsolation: 'isolated' },
  properties: {
    variant: { type: String, value: 'plain' },
    tone: { type: String, value: 'default' },
    interactionKey: { type: String, value: '' },
    size: { type: String, value: 'normal' },
    round: { type: Boolean, value: false },
    disabled: { type: Boolean, value: false },
    loading: { type: Boolean, value: false },
    ariaLabel: { type: String, value: '' },
  },
  data: {
    active: true,
    pageVisible: true,
    spokes: Array.from({ length: 8 }, (_, index) => ({
      angle: index * 45,
      opacity: 0.27 + ((0.85 - 0.27) * index) / 7,
    })),
  },
  lifetimes: {
    attached() {
      this.data.active = true;
      this.data.pageVisible = true;
    },
    detached() {
      this.data.active = false;
    },
  },
  pageLifetimes: {
    hide() {
      this.data.pageVisible = false;
    },
    show() {
      if (this.data.active) this.data.pageVisible = true;
    },
  },
  methods: {
    onPress(event?: {
      currentTarget?: { dataset?: { interactionKey?: unknown } };
    }) {
      if (
        !this.data.active ||
        !this.data.pageVisible ||
        this.properties.disabled ||
        this.properties.loading
      )
        return;
      const key = this.properties.interactionKey;
      const captured = event?.currentTarget?.dataset?.interactionKey;
      // Optional UI identity is captured at the inner native button boundary.
      // Never relabel an old tap using a newly rendered parent host dataset.
      if (
        key !== '' &&
        (typeof key !== 'string' ||
          key.length > 512 ||
          !/^[A-Za-z0-9_.:-]+$/.test(key) ||
          captured !== key)
      )
        return;
      this.triggerEvent(
        'press',
        key === '' ? {} : { interactionKey: captured },
        { bubbles: false, composed: false },
      );
    },
  },
});
