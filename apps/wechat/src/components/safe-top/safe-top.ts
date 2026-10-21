import { safeTopHeight, type SafeTopNative } from './geometry';
Component({
  properties: {},
  data: { height: null as number | null },
  methods: {},
  lifetimes: {
    attached(this: { setData(data: { height: number | null }): void }) {
      this.setData({ height: safeTopHeight(wx as unknown as SafeTopNative) });
    },
  },
});
