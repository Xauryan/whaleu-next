import { isRecord } from '../../api/errors';
Page({
  data: { valid: false },
  onLoad(query: unknown) {
    this.setData({
      valid:
        isRecord(query) &&
        Object.keys(query).length === 1 &&
        query.kind === 'activity',
    });
  },
});
