/** Framework7 v9.2.0 iOS Actions native adaptation (MIT).
 * Copyright (c) 2014 Vladimir Kharlampidi.
 * See docs/vendor/framework7-v9.2.0/LICENSE.
 * Backdrop=true, dismissible as upstream. No Popover conversion or mutations.
 */
import { actionItems } from './model';
import {
  emitOverlayIntent,
  eventDataset,
  overlayData,
  overlayLifecycle,
  overlayProperties,
} from '../f7-sheet/overlay';
const lifecycle = overlayLifecycle(300);
Component({
  options: { styleIsolation: 'isolated' },
  properties: {
    ...overlayProperties,
    title: { type: String, value: '' },
    actions: { type: Array, value: [] as unknown[] },
    cancelLabel: { type: String, value: '取消' },
    closeByBackdropClick: { type: Boolean, value: true },
  },
  data: { ...overlayData, items: actionItems([]), itemsRevision: 0 },
  ...lifecycle,
  observers: {
    ...lifecycle.observers,
    actions() {
      this.syncActions();
    },
  },
  lifetimes: {
    ...lifecycle.lifetimes,
    attached() {
      lifecycle.lifetimes.attached.call(this);
      this.syncActions();
    },
  },
  methods: {
    syncActions() {
      if (!this.data.mounted) return;
      this.setData({
        items: actionItems(this.properties.actions),
        itemsRevision: this.data.itemsRevision + 1,
      });
    },
    onConsumeTap() {},
    onConsumeMove() {},
    onBackdrop(event: unknown) {
      if (this.properties.closeByBackdropClick)
        emitOverlayIntent(this, event, 'requestclose', { reason: 'backdrop' });
    },
    onCancel(event: unknown) {
      if (this.properties.cancelLabel)
        emitOverlayIntent(this, event, 'requestclose', { reason: 'cancel' });
    },
    onAction(event: unknown) {
      const dataset = eventDataset(event);
      if (dataset?.itemsRevision !== this.data.itemsRevision) return;
      // Read live owner properties, not just the last rendered projection.
      const item = actionItems(this.properties.actions).find(
        (item) => item.id === dataset.id,
      );
      if (!item || item.disabled) return;
      emitOverlayIntent(this, event, 'action', { id: item.id });
    },
  },
});
