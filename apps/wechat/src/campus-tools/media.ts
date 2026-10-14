import type { ApiClient } from '../api/client';
import { ClientError } from '../api/errors';
import type { AuthService } from '../auth/auth-service';
import type { SessionStore } from '../auth/session';
import { exact } from '../community/contract';
import type { LocalMediaFile } from '../media/contracts';
import { MediaLocalFiles } from '../media/local-files';
import { OptionalMediaPrincipalOwner } from '../media/optional-principal';
import { OwnerImageDownload } from '../media/owner-image-download';
import { Cancellation, type Clock } from '../platform/contracts';
import type { MediaFiles, WxMediaApi } from '../platform/wechat-media';
import {
  invalidTool,
  toolDigest,
  toolSlots,
  toolUuid,
  type EnabledToolEntry,
} from './contract';
import type { ToolGateway } from './gateway';
import type { ToolRoute } from './navigation';
import type { ToolBrowseScope } from './scope';
export interface ToolMediaDescriptor {
  protocol: 'campus-tools-media-v1';
  kind: 'campus-tool';
  campusId: string;
  catalogId: string;
  entryId: string;
  entryRevision: string;
  bindingId: string;
  assetId: string;
  manifestDigest: string;
  width: number;
  height: number;
  variants: readonly ['thumb-v1', 'display-v1'];
}
export function decodeToolMedia(raw: unknown): ToolMediaDescriptor {
  exact(raw, [
    'protocol',
    'kind',
    'campusId',
    'catalogId',
    'entryId',
    'entryRevision',
    'bindingId',
    'assetId',
    'manifestDigest',
    'width',
    'height',
    'variants',
  ]);
  if (
    raw.protocol !== 'campus-tools-media-v1' ||
    raw.kind !== 'campus-tool' ||
    typeof raw.width !== 'number' ||
    !Number.isInteger(raw.width) ||
    raw.width < 1 ||
    raw.width > 2048 ||
    typeof raw.height !== 'number' ||
    !Number.isInteger(raw.height) ||
    raw.height < 1 ||
    raw.height > 2048 ||
    !Array.isArray(raw.variants) ||
    raw.variants.length !== 2 ||
    raw.variants[0] !== 'thumb-v1' ||
    raw.variants[1] !== 'display-v1'
  )
    invalidTool();
  return {
    protocol: 'campus-tools-media-v1',
    kind: 'campus-tool',
    campusId: toolUuid(raw.campusId),
    catalogId: toolUuid(raw.catalogId),
    entryId: toolUuid(raw.entryId),
    entryRevision: toolUuid(raw.entryRevision),
    bindingId: toolUuid(raw.bindingId),
    assetId: toolUuid(raw.assetId),
    manifestDigest: toolDigest(raw.manifestDigest),
    width: raw.width,
    height: raw.height,
    variants: ['thumb-v1', 'display-v1'],
  };
}
export function toolMediaPath(route: ToolRoute, bindingId: string): string {
  return `/v3/media/campus-tools/${toolUuid(route.campusId)}/${toolUuid(route.catalogId)}/${toolUuid(route.entryId)}/${toolUuid(bindingId)}`;
}
export interface ToolMediaGateway {
  descriptor(
    route: ToolRoute,
    bindingId: string,
    cancel: Cancellation,
  ): Promise<ToolMediaDescriptor>;
}
export class HttpToolMediaGateway implements ToolMediaGateway {
  constructor(private readonly api: ApiClient) {}
  async descriptor(
    route: ToolRoute,
    bindingId: string,
    cancellation: Cancellation,
  ) {
    const result = await this.api.request(
      {
        path: toolMediaPath(route, bindingId),
        method: 'GET',
        authentication: 'optional',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeToolMedia,
      },
      { cancellation },
    );
    if (
      result.campusId !== route.campusId ||
      result.catalogId !== route.catalogId ||
      result.entryId !== route.entryId ||
      result.bindingId !== bindingId
    )
      invalidTool();
    return result;
  }
}
export class ToolImageDownload extends OwnerImageDownload<ToolMediaDescriptor> {
  constructor(
    origin: string,
    wx: WxMediaApi,
    files: MediaFiles,
    registry: MediaLocalFiles,
    principals: OptionalMediaPrincipalOwner,
    auth: Pick<AuthService, 'refresh'>,
    clock: Clock,
  ) {
    super(origin, wx, files, registry, principals, auth, clock, {
      decode: decodeToolMedia,
      shape: (value) => value,
      path: (value, variant) =>
        `${toolMediaPath(value, value.bindingId)}/${variant}`,
    });
  }
}
export interface ToolMediaContext {
  route: ToolRoute;
  digest: string;
  entry: EnabledToolEntry;
}
export interface ToolImageView {
  status: 'idle' | 'loading' | 'ready' | 'unavailable';
  src: string;
  viewId: string;
  alt: string;
  selected: number;
  total: number;
  expanded: boolean;
  message: string;
  bindingId: string;
}
export const initialToolImageView = (): ToolImageView => ({
  status: 'idle',
  src: '',
  viewId: '',
  alt: '',
  selected: 0,
  total: 0,
  expanded: false,
  message: '',
  bindingId: '',
});
export type ToolImageTransfer = Pick<
  ToolImageDownload,
  'download' | 'resolve' | 'release'
>;
/** One selected image is resident. Opening, retrying, or changing selection is a
 * new owner-authorized read. Never invokes wx.previewImage or promotes a cache. */
let toolImageSequence = 0;
export class ToolImageReader {
  private readonly lifecycleId = ++toolImageSequence;
  private generation = 0;
  private disposed = false;
  private cancel = new Cancellation();
  private file: LocalMediaFile | null = null;
  private readonly owner = {};
  private view = initialToolImageView();
  private context: ToolMediaContext | null = null;
  private stopExpiry = () => undefined as void;
  private releaseWork: Promise<void> = Promise.resolve();
  private readonly unsubscribe: () => void;
  constructor(
    private readonly principals: OptionalMediaPrincipalOwner,
    private readonly tools: ToolGateway,
    private readonly media: ToolMediaGateway,
    private readonly transfer: ToolImageTransfer,
    private readonly scope: ToolBrowseScope,
    private readonly clock: Clock,
    private readonly render: (view: ToolImageView) => void,
    private readonly invalidContext: () => void = () => undefined,
  ) {
    const stopPrincipal = principals.subscribe(() => this.clear());
    const stopScope = scope.subscribe(() => this.clear());
    this.unsubscribe = () => {
      stopPrincipal();
      stopScope();
    };
  }
  private publish(view: ToolImageView) {
    this.view = view;
    try {
      this.render(view);
    } catch {
      /* Revocation is independent of rendering. */
    }
  }
  async open(context: ToolMediaContext, index: number): Promise<void> {
    const slots = toolSlots(context.entry),
      slot = slots[index];
    if (
      this.disposed ||
      !Number.isInteger(index) ||
      !slot ||
      (this.view.status === 'loading' &&
        this.context?.route.campusId === context.route.campusId &&
        this.context?.route.catalogId === context.route.catalogId &&
        this.context?.route.entryId === context.route.entryId &&
        this.context?.digest === context.digest &&
        this.view.selected === index)
    )
      return;
    this.clear();
    this.context = context;
    const generation = this.generation,
      cancel = this.cancel,
      principal = this.principals.snapshot(),
      scope = this.scope.snapshot().generation;
    const current = () => {
      this.principals.assertCurrent(principal);
      if (
        this.disposed ||
        generation !== this.generation ||
        cancel.isCancelled ||
        scope !== this.scope.snapshot().generation
      )
        throw new ClientError('cancelled', 'Tool image closed');
      return this.principals.snapshot();
    };
    this.publish({
      ...initialToolImageView(),
      status: 'loading',
      expanded: true,
      selected: index,
      total: slots.length,
      alt: slot.alt,
      bindingId: slot.bindingId,
      viewId: `${this.lifecycleId}:${generation}`,
      message: '正在读取当前图片',
    });
    let file: LocalMediaFile | null = null;
    let mandatoryCurrent = false;
    try {
      await this.releaseWork;
      current();
      const detail = await this.tools.detail(context.route, cancel);
      current();
      if (
        detail.state !== 'ready' ||
        detail.digest !== context.digest ||
        detail.entry.revision !== context.entry.revision ||
        detail.entry.state !== 'enabled'
      )
        throw new ClientError('business', 'Tool image source changed');
      const fresh = toolSlots(detail.entry)[index];
      if (
        !fresh ||
        fresh.bindingId !== slot.bindingId ||
        fresh.assetId !== slot.assetId ||
        fresh.manifestDigest !== slot.manifestDigest
      )
        invalidTool();
      mandatoryCurrent = true;
      const descriptor = await this.media.descriptor(
        context.route,
        slot.bindingId,
        cancel,
      );
      current();
      if (
        descriptor.campusId !== context.route.campusId ||
        descriptor.catalogId !== context.route.catalogId ||
        descriptor.entryId !== context.route.entryId ||
        descriptor.entryRevision !== context.entry.revision ||
        descriptor.bindingId !== slot.bindingId ||
        descriptor.assetId !== slot.assetId ||
        descriptor.manifestDigest !== slot.manifestDigest
      )
        invalidTool();
      file = await this.transfer.download(
        descriptor,
        'display-v1',
        this.owner,
        { current },
        cancel,
      );
      current();
      const src = await this.transfer.resolve(file, this.owner, principal);
      current();
      // Download completion does not extend source authority. A new preview
      // checks the exact source again before exposing its temporary local path.
      mandatoryCurrent = false;
      const display = await this.tools.detail(context.route, cancel);
      current();
      if (
        display.state !== 'ready' ||
        display.digest !== context.digest ||
        display.entry.revision !== context.entry.revision ||
        display.entry.state !== 'enabled'
      )
        throw new ClientError('business', 'Tool preview source changed');
      const displaySlot = toolSlots(display.entry)[index];
      if (
        !displaySlot ||
        displaySlot.bindingId !== slot.bindingId ||
        displaySlot.assetId !== slot.assetId ||
        displaySlot.manifestDigest !== slot.manifestDigest
      )
        invalidTool();
      mandatoryCurrent = true;
      this.file = file;
      file = null;
      this.publish({ ...this.view, status: 'ready', src, message: '' });
      const expiry =
        display.provenance.validity.kind === 'finite'
          ? Date.parse(display.provenance.validity.expiresAt) - this.clock.now()
          : 30000;
      this.stopExpiry = this.clock.schedule(
        () => {
          this.clear();
          this.publish({
            ...initialToolImageView(),
            message: '预览已关闭，请重新查看当前图片',
          });
        },
        Math.max(0, Math.min(30000, expiry)),
      );
    } catch {
      if (
        !this.disposed &&
        generation === this.generation &&
        !cancel.isCancelled &&
        !mandatoryCurrent
      )
        this.invalidContext();
      if (
        !this.disposed &&
        generation === this.generation &&
        !cancel.isCancelled
      )
        this.publish({
          ...this.view,
          status: 'unavailable',
          src: '',
          message: '图片暂不可用，请重新核对并重试',
        });
    } finally {
      if (file) this.release(file);
    }
  }
  select(index: number) {
    if (this.context) return this.open(this.context, index);
    return Promise.resolve();
  }
  retry() {
    return this.select(this.view.selected);
  }
  imageFailed(source: string, viewId: string) {
    if (!source || source !== this.view.src || viewId !== this.view.viewId)
      return;
    const file = this.file;
    this.file = null;
    this.publish({
      ...this.view,
      src: '',
      status: 'unavailable',
      message: '图片显示失败，请重试',
    });
    if (file) this.release(file);
  }
  private release(file: LocalMediaFile) {
    this.releaseWork = Promise.all([
      this.releaseWork,
      this.transfer.release(file).catch(() => undefined),
    ]).then(() => undefined);
  }
  clear() {
    this.generation++;
    this.cancel.cancel();
    this.cancel = new Cancellation();
    this.stopExpiry();
    this.stopExpiry = () => undefined;
    this.context = null;
    const file = this.file;
    this.file = null;
    this.publish(initialToolImageView());
    if (file) this.release(file);
  }
  dispose() {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
    this.unsubscribe();
  }
}
export function createToolImageRuntime(options: {
  origin: string;
  api: ApiClient;
  sessions: SessionStore;
  wx: WxMediaApi;
  files: MediaFiles;
  registry: MediaLocalFiles;
  auth: Pick<AuthService, 'refresh'>;
  clock: Clock;
  scope: ToolBrowseScope;
  gateway: ToolGateway;
}) {
  const principals = new OptionalMediaPrincipalOwner(options.sessions),
    media = new HttpToolMediaGateway(options.api),
    transfer = new ToolImageDownload(
      options.origin,
      options.wx,
      options.files,
      options.registry,
      principals,
      options.auth,
      options.clock,
    ),
    readers = new Set<ToolImageReader>();
  return {
    createReader(
      render: (view: ToolImageView) => void,
      invalidContext: () => void = () => undefined,
    ) {
      const reader = new ToolImageReader(
        principals,
        options.gateway,
        media,
        transfer,
        options.scope,
        options.clock,
        render,
        invalidContext,
      );
      readers.add(reader);
      const dispose = reader.dispose.bind(reader);
      reader.dispose = () => {
        readers.delete(reader);
        dispose();
      };
      return reader;
    },
    hide() {
      for (const reader of readers) reader.clear();
    },
  };
}
