/**
 * Native Framework7 v9.2.0 iOS list item (MIT).
 * Copyright (c) 2014 Vladimir Kharlampidi.
 * See docs/vendor/framework7-v9.2.0/LICENSE.
 *
 * All slots are PRESENTATIONAL: no buttons, toggles, inputs or navigators.
 * Linked rows have one native button overlay and one press event.
 * Provide ariaLabel for information that appears only inside a custom slot.
 * Set media=true to show the media slot, and last=true on the final item.
 */
Component({
  options: { multipleSlots: true, styleIsolation: 'isolated' },
  properties: {
    title: { type: String, value: '' },
    subtitle: { type: String, value: '' },
    text: { type: String, value: '' },
    after: { type: String, value: '' },
    link: { type: Boolean, value: false },
    disabled: { type: Boolean, value: false },
    loading: { type: Boolean, value: false },
    last: { type: Boolean, value: false },
    media: { type: Boolean, value: false },
    ariaLabel: { type: String, value: '' },
    titleSlot: { type: Boolean, value: false },
    afterSlot: { type: Boolean, value: false },
    footerSlot: { type: Boolean, value: false },
  },
  data: {
    spokes: Array.from({ length: 8 }, (_, index) => ({
      angle: index * 45,
      opacity: 0.27 + ((0.85 - 0.27) * index) / 7,
    })),
  },
  methods: {
    onPress() {
      if (
        !this.properties.link ||
        this.properties.disabled ||
        this.properties.loading
      )
        return;
      this.triggerEvent('press', {}, { bubbles: false, composed: false });
    },
  },
});
