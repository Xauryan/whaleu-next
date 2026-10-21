/** Framework7 v9.2.0 iOS Sheet native adaptation (MIT).
 * Copyright (c) 2014 Vladimir Kharlampidi.
 * See docs/vendor/framework7-v9.2.0/LICENSE.
 * Modal backdrop defaults true here, unlike upstream iOS's false. The owner
 * must pause background readers BEFORE open and retain the pause until closed.
 */
import {
  emitOverlayIntent,
  emitOverlayButtonIntent,
  overlayData,
  overlayLifecycle,
  overlayProperties,
} from './overlay';
Component({
  options: { multipleSlots: true, styleIsolation: 'isolated' },
  properties: {
    ...overlayProperties,
    title: { type: String, value: '' },
    closeLabel: { type: String, value: '关闭' },
    showClose: { type: Boolean, value: true },
    backdrop: { type: Boolean, value: true },
    closeByBackdropClick: { type: Boolean, value: true },
  },
  data: { ...overlayData },
  ...overlayLifecycle(300),
  methods: {
    onConsumeTap() {},
    onConsumeMove() {},
    onBackdrop(event: unknown) {
      if (this.properties.closeByBackdropClick)
        emitOverlayIntent(this, event, 'requestclose', { reason: 'backdrop' });
    },
    onClose(event: unknown) {
      if (this.properties.showClose)
        emitOverlayButtonIntent(this, event, 'requestclose', {
          reason: 'close',
        });
    },
  },
});
