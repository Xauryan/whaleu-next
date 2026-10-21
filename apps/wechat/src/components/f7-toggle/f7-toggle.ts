/** Framework7 v9.2.0 iOS Toggle native adaptation (MIT).
 * Copyright (c) 2014 Vladimir Kharlampidi.
 * See docs/vendor/framework7-v9.2.0/LICENSE.
 * The real native switch owns activation and accessibility; source-derived
 * track/knob views display ONLY the owner's checked property. The underlying
 * native control may transiently toggle before change; never call that a save.
 */
Component({
  options: { styleIsolation: 'isolated' },
  properties: {
    checked: { type: Boolean, value: false },
    disabled: { type: Boolean, value: false },
    readOnly: { type: Boolean, value: false },
    label: { type: String, value: '' },
    ariaLabel: { type: String, value: '' },
  },
  data: { mounted: false, pageVisible: true, nativeChecked: false },
  observers: {
    checked(checked: boolean) {
      this.setData({ nativeChecked: checked === true });
    },
  },
  lifetimes: {
    attached() {
      this.setData({
        mounted: true,
        pageVisible: true,
        nativeChecked: this.properties.checked,
      });
    },
    detached() {
      this.data.mounted = false;
    },
  },
  pageLifetimes: {
    hide() {
      if (this.data.mounted)
        this.setData({
          pageVisible: false,
          nativeChecked: this.properties.checked,
        });
    },
    show() {
      if (this.data.mounted)
        this.setData({
          pageVisible: true,
          nativeChecked: this.properties.checked,
        });
    },
  },
  methods: {
    onConsumeTap() {
      // Native switch change is the only intent. Consume its separate tap so
      // a surrounding navigable row cannot activate at the same time.
    },
    onChange(event: { detail?: { value?: unknown } } | null) {
      if (!this.data.mounted) return;
      // Reconcile BEFORE emission. An owner update inside its change handler
      // wins; no deferred callback can reset a newer value or detached control.
      this.setData({ nativeChecked: this.properties.checked });
      if (
        !this.data.pageVisible ||
        this.properties.disabled ||
        this.properties.readOnly
      )
        return;
      const value = event?.detail?.value;
      if (typeof value !== 'boolean' || value === this.properties.checked)
        return;
      this.triggerEvent(
        'change',
        { value },
        { bubbles: false, composed: false },
      );
    },
  },
});
