import type { WxApi } from './platform/wechat';

declare global {
  const wx: WxApi;
  function App<T extends object>(
    options: T & { onLaunch(): void; onHide?(): void } & ThisType<T>,
  ): void;
  function getApp<T>(): T;
  function Page<T extends object>(
    options: T &
      ThisType<
        T & {
          setData(data: Record<string, unknown>): void;
        }
      >,
  ): void;
  function setTimeout(callback: () => void, milliseconds: number): number;
  function clearTimeout(id: number): void;
}
export {};
