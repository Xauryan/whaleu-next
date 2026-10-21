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
  type NativeComponentInstance<
    T extends {
      properties: Record<string, { value: unknown }>;
      data: object;
      methods: object;
    },
  > = Omit<T, 'properties'> &
    T['methods'] & {
      properties: { [K in keyof T['properties']]: T['properties'][K]['value'] };
      setData(data: Record<string, unknown>): void;
      triggerEvent(
        name: string,
        detail?: unknown,
        options?: {
          bubbles?: boolean;
          composed?: boolean;
          capturePhase?: boolean;
        },
      ): void;
    };
  function Component<
    T extends {
      properties: Record<string, { type: unknown; value: unknown }>;
      data: object;
      methods: object;
    },
  >(
    options: T & {
      methods: T['methods'] & ThisType<NativeComponentInstance<T>>;
      lifetimes?: Record<string, () => void> &
        ThisType<NativeComponentInstance<T>>;
    } & ThisType<NativeComponentInstance<T>>,
  ): void;
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
