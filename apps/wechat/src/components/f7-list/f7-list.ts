/**
 * Native Framework7 v9.2.0 iOS list shell (MIT).
 * Copyright (c) 2014 Vladimir Kharlampidi.
 * See docs/vendor/framework7-v9.2.0/LICENSE.
 * Children remain native components; mark the final item with last=true.
 */
Component({
  options: { multipleSlots: true, styleIsolation: 'isolated' },
  properties: {
    spacing: { type: String, value: 'default' },
    strong: { type: Boolean, value: false },
    inset: { type: Boolean, value: false },
    outline: { type: Boolean, value: false },
    title: { type: String, value: '' },
    footer: { type: String, value: '' },
    titleSlot: { type: Boolean, value: false },
    footerSlot: { type: Boolean, value: false },
  },
  data: {},
  methods: {},
});
