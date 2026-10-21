/** Framework7 v9.2.0 iOS Dialog native adaptation (MIT).
 * Copyright (c) 2014 Vladimir Kharlampidi.
 * See docs/vendor/framework7-v9.2.0/LICENSE.
 * Backdrop=true and nondismissible. Real source buttons are round/large48,
 * strong fill / other tonal, not the obsolete dialog-button-height44 token.
 */
import { inputDetail } from '../f7-input/model';
import {
  emitOverlayButtonIntent,
  isolated,
  overlayData,
  overlayIdentity,
  overlayInteractive,
  overlayLifecycle,
  overlayProperties,
  validActionId,
} from '../f7-sheet/overlay';
Component({
  options: { styleIsolation: 'isolated' },
  properties: {
    ...overlayProperties,
    mode: { type: String, value: 'alert' },
    title: { type: String, value: '' },
    message: { type: String, value: '' },
    confirmLabel: { type: String, value: '确定' },
    cancelLabel: { type: String, value: '取消' },
    confirmId: { type: String, value: 'confirm' },
    confirmDisabled: { type: Boolean, value: false },
    destructive: { type: Boolean, value: false },
    value: { type: String, value: '' },
    placeholder: { type: String, value: '' },
    inputLabel: { type: String, value: '输入内容' },
    errorText: { type: String, value: '' },
    focus: { type: Boolean, value: false },
    maxlength: { type: Number, value: 140 },
  },
  data: { ...overlayData },
  ...overlayLifecycle(400),
  methods: {
    onConsumeTap() {},
    onConsumeMove() {},
    onConfirm(event: unknown) {
      if (
        this.properties.confirmDisabled ||
        this.properties.errorText ||
        !validActionId(this.properties.confirmId)
      )
        return;
      if (!['alert', 'confirm', 'prompt'].includes(this.properties.mode))
        return;
      // Prompt values stay in the owner's draft and never enter generic action
      // events. Validation and authorized submission belong to that owner.
      emitOverlayButtonIntent(this, event, 'action', {
        id: this.properties.confirmId,
      });
    },
    onCancel(event: unknown) {
      if (
        this.properties.mode === 'confirm' ||
        this.properties.mode === 'prompt'
      )
        emitOverlayButtonIntent(this, event, 'requestclose', {
          reason: 'cancel',
        });
    },
    onInput(event: unknown) {
      if (this.properties.mode !== 'prompt' || !overlayInteractive(this, event))
        return;
      const detail = inputDetail(event);
      if (detail)
        this.triggerEvent(
          'input',
          { ...overlayIdentity(this), ...detail },
          isolated,
        );
      // Returning a string here would replace the native IME buffer. Never do it.
    },
    onKeyboardConfirm(event: unknown) {
      if (this.properties.mode !== 'prompt' || !overlayInteractive(this, event))
        return;
      // Observation only, not implicit form or destructive confirmation.
      this.triggerEvent('keyboardconfirm', overlayIdentity(this), isolated);
    },
    onInputFocus(event: unknown) {
      if (this.properties.mode !== 'prompt' || !overlayInteractive(this, event))
        return;
      const height =
        event && typeof event === 'object'
          ? (event as { detail?: { height?: unknown } }).detail?.height
          : undefined;
      this.triggerEvent(
        'inputfocus',
        {
          ...overlayIdentity(this),
          ...(typeof height === 'number' &&
          Number.isFinite(height) &&
          height >= 0
            ? { height }
            : {}),
        },
        isolated,
      );
    },
    onInputBlur(event: unknown) {
      if (this.properties.mode !== 'prompt' || !overlayInteractive(this, event))
        return;
      this.triggerEvent('inputblur', overlayIdentity(this), isolated);
    },
  },
});
