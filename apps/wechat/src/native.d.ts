import type { WxApi } from './platform/wechat';

declare global {
  const wx: WxApi;
  function App(options: {
    onLaunch(): void;
    globalData: Record<string, unknown>;
  }): void;
  function Page(options: { data: Record<string, unknown> }): void;
  function setTimeout(callback: () => void, milliseconds: number): number;
  function clearTimeout(id: number): void;
}
export {};
