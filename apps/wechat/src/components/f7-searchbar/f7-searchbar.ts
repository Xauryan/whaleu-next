/** Framework7 v9.2.0 iOS Searchbar native adaptation (MIT).
 * Copyright (c) 2014 Vladimir Kharlampidi.
 * See docs/vendor/framework7-v9.2.0/LICENSE.
 * Owner controls query, focus, clear and cancellation. No filtering, navigation,
 * debounce, requests, result state or DOM searchbar runtime is included.
 */
import {
  editorEnabled,
  editorPresentation,
  nativeEditorData,
  nativeEditorMethods,
  nativeEditorPageLifetimes,
  nativeEditorProperties,
} from '../f7-input/model';
Component({
  options: { styleIsolation: 'isolated' },
  properties: {
    ...nativeEditorProperties,
    placeholder: { type: String, value: '搜索' },
    clearable: { type: Boolean, value: true },
    showCancel: { type: Boolean, value: false },
    cancelText: { type: String, value: '取消' },
  },
  data: { ...nativeEditorData },
  observers: {
    'maxlength, cursorSpacing, selectionStart, selectionEnd'() {
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
      this.data.mounted = false;
      this.data.focused = false;
    },
  },
  pageLifetimes: nativeEditorPageLifetimes,
  methods: {
    ...nativeEditorMethods,
    syncPresentation() {
      this.setData(editorPresentation(this.properties));
    },
    onCancel() {
      if (!editorEnabled(this) || !this.properties.showCancel) return;
      this.triggerEvent('cancel', {}, { bubbles: false, composed: false });
    },
  },
});
