/** Framework7 v9.2.0 iOS Input native adaptation (MIT).
 * Copyright (c) 2014 Vladimir Kharlampidi.
 * See docs/vendor/framework7-v9.2.0/LICENSE.
 * No validation, persistence, permissions, form submission or secret logging.
 * readOnly maps to native disabled: not browser-selectable readonly text.
 */
import {
  editorPresentation,
  inputPresentation,
  nativeEditorData,
  nativeEditorMethods,
  nativeEditorPageLifetimes,
  nativeEditorProperties,
} from './model';
Component({
  options: { styleIsolation: 'isolated' },
  properties: {
    ...nativeEditorProperties,
    type: { type: String, value: 'text' },
    password: { type: Boolean, value: false },
    confirmType: { type: String, value: 'done' },
    label: { type: String, value: '' },
    description: { type: String, value: '' },
    errorText: { type: String, value: '' },
  },
  data: { ...nativeEditorData, nativeType: 'text', nativeConfirmType: 'done' },
  observers: {
    'type, password, confirmType, maxlength, cursorSpacing, selectionStart, selectionEnd'() {
      this.syncPresentation();
    },
    'disabled, readOnly'(disabled: boolean, readOnly: boolean) {
      if (disabled || readOnly) this.setData({ focused: false });
    },
  },
  lifetimes: {
    attached() {
      this.setData({ mounted: true, pageVisible: true });
      this.syncPresentation();
    },
    detached() {
      // Logical lifecycle guard only: no setData against a detached renderer.
      this.data.mounted = false;
      this.data.focused = false;
    },
  },
  pageLifetimes: nativeEditorPageLifetimes,
  methods: {
    ...nativeEditorMethods,
    syncPresentation() {
      this.setData({
        ...editorPresentation(this.properties),
        ...inputPresentation(
          this.properties.type,
          this.properties.password,
          this.properties.confirmType,
        ),
      });
    },
  },
});
