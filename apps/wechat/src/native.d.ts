import type { WxApi } from './platform/wechat';
import type { WxUploadApi } from './platform/wechat-upload';

declare global {
  const wx: WxApi & WxUploadApi;
  function App<T extends object>(
    options: T & {
      onLaunch(): void;
      onShow?(): void;
      onHide?(): void;
    } & ThisType<T>,
  ): void;
  function getApp<T>(): T;
  function Page<T extends object>(
    options: T &
      ThisType<
        T & {
          setData(data: Record<string, unknown>, callback?: () => void): void;
        }
      >,
  ): void;
  function setTimeout(callback: () => void, milliseconds: number): number;
  function clearTimeout(id: number): void;
}
export {};
