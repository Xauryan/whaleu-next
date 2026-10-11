import { sha256 } from 'js-sha256';
import type { ApiClient } from '../api/client';
import { ClientError, clientError, isRecord } from '../api/errors';
import { normalizeOrigin } from '../api/origin';
import type { SessionStore } from '../auth/session';
import { exact } from '../community/contract';
import { Cancellation } from '../platform/contracts';
import type { Storage, Json } from '../platform/contracts';
import { decodePublishErrand, decodeErrandReceipt, errandId } from './contract';
import type { ErrandForm } from './controller';
import type {
  ErrandMediaRuntime,
  ErrandMediaUploader,
  ErrandReadyImage,
} from './media-runtime';
import { errandMediaSlot, errandMediaSlots } from './media-validation';
import type { ErrandMediaSlot } from './media-validation';
const protocol = 'errand-publication-v2' as const;
interface Fact extends ErrandReadyImage {
  slot: ErrandMediaSlot;
}
interface Pending {
  version: 2;
  accountId: string;
  draftId: string;
  targetRegionId: string;
  revision: 1;
  images: Fact[];
  publication: { requestId: string; requestHash: string } | null;
}
export interface ErrandPublicationView {
  busy: boolean;
  message: string;
  hasDraft: boolean;
  frozen: boolean;
  images: readonly { slot: ErrandMediaSlot; label: string; ready: boolean }[];
  confirmedOrderId: string;
}
export const initialErrandPublicationView = (): ErrandPublicationView => ({
  busy: false,
  message: '',
  hasDraft: false,
  frozen: false,
  images: errandMediaSlots.map((slot) => ({
    slot,
    label:
      (slot.startsWith('public') ? '公开图片' : '私密图片') +
      (Number(slot.slice(-1)) + 1),
    ready: false,
  })),
  confirmedOrderId: '',
});
export function canonicalErrandPublication(value: unknown): string {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return JSON.stringify(value);
  if (Array.isArray(value))
    return '[' + value.map(canonicalErrandPublication).join(',') + ']';
  if (isRecord(value))
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(
          (k) => JSON.stringify(k) + ':' + canonicalErrandPublication(value[k]),
        )
        .join(',') +
      '}'
    );
  throw new ClientError('protocol', 'Invalid publication intent');
}
export const errandPublicationRequestHash = (body: Record<string, unknown>) => {
  const { clientRequestId: _id, ...intent } = body;
  void _id;
  return sha256(
    'whaleu:errand-command:v2\n' +
      canonicalErrandPublication({ operation: 'publish', intent }),
  );
};
const hash = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function draftResponse(v: unknown) {
  exact(v, [
    'protocol',
    'draftId',
    'targetRegionId',
    'revision',
    'state',
    'expiresAt',
  ]);
  if (
    v.protocol !== protocol ||
    !errandId(v.draftId) ||
    !errandId(v.targetRegionId) ||
    v.revision !== 1 ||
    !['open', 'published', 'cancelled'].includes(String(v.state)) ||
    typeof v.expiresAt !== 'number' ||
    !Number.isSafeInteger(v.expiresAt)
  )
    throw new ClientError('protocol', 'Invalid errand draft');
  return v;
}
function draftCancellationResponse(v: unknown) {
  if (isRecord(v) && v.state === 'cancelled_before_create') {
    exact(v, ['protocol', 'draftId', 'revision', 'state']);
    if (v.protocol !== protocol || !errandId(v.draftId) || v.revision !== 1)
      throw new ClientError('protocol', 'Invalid original draft cancellation');
    return {
      protocol,
      draftId: v.draftId,
      revision: 1,
      state: 'cancelled_before_create' as const,
    };
  }
  return draftResponse(v);
}
function preparation(v: unknown) {
  exact(v, [
    'protocol',
    'requestId',
    'requestHash',
    'draftId',
    'draftRevision',
    'reviewDigest',
  ]);
  if (
    v.protocol !== protocol ||
    !errandId(v.requestId) ||
    !hash(v.requestHash) ||
    !errandId(v.draftId) ||
    v.draftRevision !== 1 ||
    !hash(v.reviewDigest)
  )
    throw new ClientError('protocol', 'Invalid errand publication');
  return {
    requestId: v.requestId,
    requestHash: v.requestHash,
    draftId: v.draftId,
  };
}
/** One origin/account metadata journal. It deliberately contains no form text,
 * contacts, local paths, bytes or bearer. Original server-frozen intent enables recovery. */
export class ErrandPublicationJournal {
  private prefix: string;
  constructor(
    private readonly storage: Storage,
    origin: string,
  ) {
    this.prefix =
      'whaleu.errand-publication.v2.' + sha256(normalizeOrigin(origin)) + '.';
  }
  read(actor: string): Pending | null {
    const v = this.storage.get(this.prefix + actor);
    if (v === undefined || v === null || v === '') return null;
    exact(v, [
      'version',
      'accountId',
      'draftId',
      'targetRegionId',
      'revision',
      'images',
      'publication',
    ]);
    if (
      v.version !== 2 ||
      v.accountId !== actor ||
      !errandId(v.draftId) ||
      !errandId(v.targetRegionId) ||
      v.revision !== 1 ||
      !Array.isArray(v.images) ||
      v.images.length > 6
    )
      throw new ClientError('storage', '跑腿图片恢复记录损坏');
    const images = v.images.map((x) => {
      exact(x, ['slot', 'assetId', 'manifestDigest']);
      if (!errandId(x.assetId) || !hash(x.manifestDigest))
        throw new ClientError('storage', '跑腿图片恢复记录损坏');
      return {
        slot: errandMediaSlot(x.slot),
        assetId: x.assetId,
        manifestDigest: x.manifestDigest,
      };
    });
    if (
      new Set(images.map((x) => x.slot)).size !== images.length ||
      new Set(images.map((x) => x.assetId)).size !== images.length
    )
      throw new ClientError('storage', '跑腿图片恢复记录损坏');
    let publication: Pending['publication'] = null;
    if (v.publication !== null) {
      exact(v.publication, ['requestId', 'requestHash']);
      if (
        !errandId(v.publication.requestId) ||
        !hash(v.publication.requestHash)
      )
        throw new ClientError('storage', '跑腿发布恢复记录损坏');
      publication = {
        requestId: v.publication.requestId,
        requestHash: v.publication.requestHash,
      };
    }
    return {
      version: 2,
      accountId: actor,
      draftId: v.draftId,
      targetRegionId: v.targetRegionId,
      revision: 1,
      images,
      publication,
    };
  }
  write(v: Pending) {
    this.storage.set(this.prefix + v.accountId, JSON.parse(JSON.stringify(v)));
    if (
      canonicalErrandPublication(this.read(v.accountId)) !==
      canonicalErrandPublication(v)
    )
      throw new ClientError('storage', '无法保存原跑腿图片请求');
  }
  clear(v: Pending) {
    const current = this.read(v.accountId);
    if (current?.draftId !== v.draftId)
      throw new ClientError('storage', '原图片草稿已变化');
    this.storage.remove(this.prefix + v.accountId);
    if (this.read(v.accountId))
      throw new ClientError('storage', '无法清除已结束图片草稿');
  }
}
export class ErrandImageComposer {
  private readonly uploader: ErrandMediaUploader;
  private cancellation: Cancellation | null = null;
  private active = false;
  private disposed = false;
  private view = initialErrandPublicationView();
  private readonly unsubscribe: () => void;
  constructor(
    private readonly api: ApiClient,
    private readonly sessions: SessionStore,
    private readonly media: ErrandMediaRuntime,
    private readonly journal: ErrandPublicationJournal,
    private readonly newId: () => Promise<string>,
    private readonly render: (view: ErrandPublicationView) => void,
  ) {
    this.uploader = media.createUploader((view) =>
      this.update({ message: view.message }),
    );
    let ticket = sessions.snapshot();
    this.unsubscribe = sessions.subscribe(() => {
      const current = sessions.snapshot();
      if (current.epoch !== ticket.epoch) {
        ticket = current;
        this.clear();
      }
    });
    try {
      this.refresh();
    } catch (error) {
      this.update({
        hasDraft: true,
        frozen: true,
        message: clientError(error).message,
      });
    }
  }
  get hasDraft() {
    return this.view.hasDraft;
  }
  get frozen() {
    return this.view.frozen;
  }
  private refresh() {
    const actor = this.sessions.snapshot().credentials?.accountId;
    const p = actor ? this.journal.read(actor) : null;
    this.update({
      hasDraft: !!p,
      frozen: !!p?.publication,
      images: initialErrandPublicationView().images.map((x) => ({
        ...x,
        ready: !!p?.images.some((y) => y.slot === x.slot),
      })),
    });
  }
  private update(v: Partial<ErrandPublicationView>) {
    if (this.disposed) return;
    this.view = { ...this.view, ...v };
    this.render(this.view);
  }
  private async work(
    run: (
      actor: string,
      cancel: Cancellation,
      current: () => void,
    ) => Promise<void>,
  ) {
    if (this.active || this.disposed) return;
    const ticket = this.sessions.snapshot(),
      actor = ticket.credentials?.accountId;
    if (!actor) {
      this.update({ message: '请先登录' });
      return;
    }
    const cancel = new Cancellation();
    this.cancellation = cancel;
    this.active = true;
    this.update({ busy: true, message: '' });
    const current = () => {
      this.sessions.assertCurrent(ticket);
      if (cancel.isCancelled || this.disposed)
        throw new ClientError('cancelled', '页面已关闭');
    };
    try {
      await run(actor, cancel, current);
      current();
      this.refresh();
    } catch (e) {
      if (!cancel.isCancelled && !this.disposed)
        this.update({ message: clientError(e).message });
    } finally {
      this.active = false;
      if (this.cancellation === cancel) this.cancellation = null;
      if (!cancel.isCancelled) this.update({ busy: false });
    }
  }
  private call<T>(
    path: string,
    method: 'GET' | 'POST',
    decode: (v: unknown) => T,
    cancel: Cancellation,
    body?: unknown,
  ) {
    return this.api.request(
      {
        path,
        method,
        decode,
        authentication: 'required',
        authReplay: method === 'GET' ? 'once' : 'never',
        successStatus: 200,
      },
      {
        cancellation: cancel,
        ...(body === undefined
          ? {}
          : { body: JSON.parse(JSON.stringify(body)) as Json }),
      },
    );
  }
  private async ensure(
    actor: string,
    targetRegionId: string,
    cancel: Cancellation,
    current: () => void,
  ) {
    if (!errandId(targetRegionId))
      throw new ClientError('business', '请先选择目标地区');
    let p = this.journal.read(actor);
    if (!p) {
      const draftId = await this.newId();
      current();
      p = {
        version: 2,
        accountId: actor,
        draftId,
        targetRegionId,
        revision: 1,
        images: [],
        publication: null,
      };
      this.journal.write(p);
      this.refresh();
    }
    if (p.targetRegionId !== targetRegionId)
      throw new ClientError('business', '请先恢复或撤回原地区的图片草稿');
    if (p.publication)
      throw new ClientError(
        'business',
        '原发布结果尚未确认，请先恢复原发布，或明确撤回原草稿',
      );
    const d = await this.call(
      '/v2/errand-drafts',
      'POST',
      draftResponse,
      cancel,
      { protocol, draftId: p.draftId, targetRegionId: p.targetRegionId },
    );
    current();
    if (
      d.draftId !== p.draftId ||
      d.targetRegionId !== p.targetRegionId ||
      d.state !== 'open'
    )
      throw new ClientError('business', '原图片草稿已结束，请恢复结果');
    return p;
  }
  choose(slotValue: string, targetRegionId: string, recover = false) {
    return this.work(async (actor, cancel, current) => {
      const slot = errandMediaSlot(slotValue),
        p = await this.ensure(actor, targetRegionId, cancel, current),
        target = {
          draftId: p.draftId,
          draftRevision: 1,
          targetRegionId: p.targetRegionId,
          slot,
        };
      if (!recover && p.images.some((x) => x.slot === slot)) {
        await this.uploader.cancelPending(target);
        current();
        p.images = p.images.filter((x) => x.slot !== slot);
        this.journal.write(p);
      }
      const ready = await (recover
        ? this.uploader.recover(target)
        : this.uploader.pick(target));
      current();
      if (ready) {
        p.images = p.images.filter((x) => x.slot !== slot);
        p.images.push({ slot, ...ready });
        p.images.sort(
          (a, b) =>
            errandMediaSlots.indexOf(a.slot) - errandMediaSlots.indexOf(b.slot),
        );
        this.journal.write(p);
        this.update({ message: '图片已就绪，发布时将核验完整图片集' });
      }
    });
  }
  remove(slotValue: string) {
    return this.work(async (actor, _cancel, current) => {
      const slot = errandMediaSlot(slotValue),
        p = this.journal.read(actor);
      if (!p) return;
      if (p.publication)
        throw new ClientError(
          'business',
          '请先恢复或撤回原发布，不能释放可能已发布的图片',
        );
      await this.uploader.cancelPending({
        draftId: p.draftId,
        draftRevision: 1,
        targetRegionId: p.targetRegionId,
        slot,
      });
      current();
      p.images = p.images.filter((x) => x.slot !== slot);
      this.journal.write(p);
    });
  }
  publish(form: ErrandForm, targetRegionId: string) {
    return this.work(async (actor, cancel, current) => {
      let p = this.journal.read(actor);
      if (!p) return;
      if (p.publication) {
        await this.recoverOriginal(p, cancel, current, true);
        return;
      }
      p = await this.ensure(actor, targetRegionId, cancel, current);
      // Omit empty v1 arrays only after its canonical text/contact validation.
      const clientRequestId = await this.newId();
      current();
      const {
        publicAssetIds: _public,
        privateAssetIds: _private,
        ...text
      } = decodePublishErrand({
        clientRequestId,
        targetRegionId,
        title: form.title,
        publicText: form.publicText,
        privateText: form.privateText,
        expectedTimeText: form.expectedTimeText,
        reward: form.reward,
        publisherContacts: { wechat: form.wechat, phone: form.phone },
        publicAssetIds: [],
        privateAssetIds: [],
      });
      void _public;
      void _private;
      const body = {
        ...text,
        protocol,
        draftId: p.draftId,
        draftRevision: 1,
        publicMedia: p.images.filter((x) => x.slot.startsWith('public')),
        privateMedia: p.images.filter((x) => x.slot.startsWith('private')),
      };
      p.publication = {
        requestId: clientRequestId,
        requestHash: errandPublicationRequestHash(body),
      };
      this.journal.write(p);
      this.refresh();
      const prepared = await this.call(
        '/v2/errand-publications/prepare',
        'POST',
        preparation,
        cancel,
        body,
      );
      current();
      this.match(p, prepared);
      await this.publishOriginal(p, cancel, current);
    });
  }
  private match(
    p: Pending,
    v: { requestId: string; requestHash: string; draftId: string },
  ) {
    if (
      v.requestId !== p.publication?.requestId ||
      v.requestHash !== p.publication.requestHash ||
      v.draftId !== p.draftId
    )
      throw new ClientError('protocol', '原发布请求不匹配');
  }
  private async publishOriginal(
    p: Pending,
    cancel: Cancellation,
    current: () => void,
  ) {
    const key = p.publication!;
    const receipt = await this.call(
      `/v2/errand-publications/${key.requestId}/publish`,
      'POST',
      decodeErrandReceipt,
      cancel,
      { requestHash: key.requestHash },
    );
    current();
    if (receipt.requestId !== key.requestId || receipt.operation !== 'publish')
      throw new ClientError('protocol', '原发布回执不匹配');
    if (receipt.outcome === 'applied') {
      await this.media.reconcile(p.draftId, true);
      current();
      this.journal.clear(p);
      this.update({
        confirmedOrderId: receipt.orderId,
        message: '图片订单已发布',
      });
    } else {
      this.update({ message: '原发布已被拒绝，可撤回图片草稿后重新填写' });
    }
  }
  private async recoverOriginal(
    p: Pending,
    cancel: Cancellation,
    current: () => void,
    publish: boolean,
  ) {
    const key = p.publication;
    if (!key) return;
    const raw = await this.call(
      `/v2/errand-publications/${key.requestId}`,
      'GET',
      (v) => v,
      cancel,
    );
    current();
    if (!isRecord(raw) || !['prepared', 'terminal'].includes(String(raw.state)))
      throw new ClientError('protocol', '原发布恢复结果无效');
    const { state, receipt, ...base } = raw;
    this.match(p, preparation(base));
    if (state === 'terminal') {
      const known = decodeErrandReceipt(receipt);
      if (known.requestId !== key.requestId || known.operation !== 'publish')
        throw new ClientError('protocol', '原发布回执不匹配');
      if (known.outcome === 'applied') {
        await this.media.reconcile(p.draftId, true);
        current();
        this.journal.clear(p);
        this.update({
          confirmedOrderId: known.orderId,
          message: '已恢复原图片订单',
        });
      } else this.update({ message: '原发布已拒绝，请撤回图片草稿' });
    } else if (publish) await this.publishOriginal(p, cancel, current);
    else
      this.update({
        message: '原发布已保存，点击重试可用同一请求继续；图片保持冻结',
      });
  }
  recover(publish = false) {
    return this.work(async (actor, cancel, current) => {
      const p = this.journal.read(actor);
      if (!p) return;
      if (p.publication)
        await this.recoverOriginal(p, cancel, current, publish);
      else {
        await this.media.reconcile(p.draftId);
        current();
        this.update({
          message: '原图片草稿已保留，可逐栏恢复；文字和联系方式需重新填写',
        });
      }
    });
  }
  cancelDraft() {
    return this.work(async (actor, cancel, current) => {
      const p = this.journal.read(actor);
      if (!p) return;
      const d = await this.call(
        `/v2/errand-drafts/${p.draftId}/cancel`,
        'POST',
        draftCancellationResponse,
        cancel,
        { protocol, expectedRevision: p.revision, publication: p.publication },
      );
      current();
      if (
        d.draftId !== p.draftId ||
        d.revision !== p.revision ||
        (d.state !== 'cancelled_before_create' &&
          (!('targetRegionId' in d) || d.targetRegionId !== p.targetRegionId))
      )
        throw new ClientError('protocol', '撤回草稿不匹配');
      if (d.state === 'published') {
        await this.recoverOriginal(p, cancel, current, false);
        return;
      }
      if (d.state !== 'cancelled' && d.state !== 'cancelled_before_create')
        throw new ClientError('protocol', '撤回尚未确认');
      await this.media.reconcile(p.draftId, true);
      current();
      this.journal.clear(p);
      this.update({ message: '原发布已被阻止，图片草稿已撤回' });
    });
  }
  clear() {
    this.cancellation?.cancel();
    this.cancellation = null;
    this.uploader.clear();
    this.view = initialErrandPublicationView();
    if (!this.disposed) this.render(this.view);
  }
  dispose() {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
    this.uploader.dispose();
    this.unsubscribe();
  }
}
export function createErrandPublicationRuntime(options: {
  api: ApiClient;
  sessions: SessionStore;
  media: ErrandMediaRuntime;
  storage: Storage;
  origin: string;
  newRequestId: () => Promise<string>;
}) {
  const journal = new ErrandPublicationJournal(options.storage, options.origin);
  return {
    createComposer: (render: (v: ErrandPublicationView) => void) =>
      new ErrandImageComposer(
        options.api,
        options.sessions,
        options.media,
        journal,
        options.newRequestId,
        render,
      ),
  };
}
