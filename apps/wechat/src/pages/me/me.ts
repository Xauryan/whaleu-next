import type { WhaleuApp } from '../../app';
import type { SessionTicket } from '../../auth/session';
import {
  FeedThumbnails,
  type FeedThumbnail,
} from '../../media/feed-thumbnails';
import {
  initialAvatarReadView,
  type AvatarReadController,
} from '../../profile/avatar-read-controller';
import {
  initialCoverReadView,
  type CoverReadController,
} from '../../profile/cover-read-controller';
import { HttpProfileGateway } from '../../profile/gateway';
import {
  initialProfileDetailsView,
  ProfileDetailsController,
} from '../../profile/details-controller';
import { HttpProfileDetailsGateway } from '../../profile/details-gateway';
import {
  initialProfileStatsView,
  ProfileStatsController,
} from '../../profile/stats-controller';
import { HttpProfileStatsGateway } from '../../profile/stats-gateway';
import { HttpOwnPublicationsGateway } from '../../profile/own-publications';
import { profileGenderLabels } from '../../profile/details-contract';
import {
  initialOwnSchoolUidView,
  OwnSchoolUidController,
} from '../../school-uid/controller';
import { initialProfileView, ProfileController } from '../profile/controller';
import {
  initialMeContentView,
  filterMeContent,
  MeContentController,
  type MeContentCard,
  type MeContentView,
} from './controller';
import {
  initialMeIdentityView,
  MeIdentityController,
} from './identity-controller';
import {
  buildOwnProfileShare,
  initialProfileScanView,
  ProfileScanner,
} from './profile-actions';

Page({
  data: {
    profile: initialProfileView(),
    content: initialMeContentView(),
    visibleContentItems: [] as readonly MeContentCard[],
    contentQuery: '',
    contentSearchOpen: false,
    contentImages: {} as Readonly<Record<string, FeedThumbnail>>,
    avatarRead: initialAvatarReadView(),
    coverRead: initialCoverReadView(),
    schoolUidView: initialOwnSchoolUidView(),
    publicIdentity: initialMeIdentityView(),
    details: initialProfileDetailsView(),
    stats: initialProfileStatsView(),
    profileGenderLabels,
    scan: initialProfileScanView(),
    actionError: '',
    showMenu: false,
    tabs: [
      { key: 'posts', label: '主题' },
      { key: 'replies', label: '回复' },
      { key: 'saved', label: '收藏' },
      { key: 'liked', label: '赞过' },
    ],
    account: [
      {
        title: '浏览记录',
        icon: 'post',
        url: '/pages/browsing-history/browsing-history',
      },
      {
        title: '更多服务',
        icon: 'settings',
        url: '/pages/account-menu/account-menu',
      },
      {
        title: '我的全部发布',
        icon: 'post',
        url: '/pages/community-mine/community-mine',
      },
      {
        title: '我的跑腿',
        icon: 'bag',
        url: '/pages/errand-mine/errand-mine',
      },
      {
        title: '成长记录',
        icon: 'chart',
        url: '/pages/experience/experience',
      },
      {
        title: '校园认证',
        icon: 'graduation',
        url: '/pages/verification/verification',
      },
      {
        title: '身份校区',
        icon: 'campus',
        url: '/pages/identity-campus/identity-campus',
      },
      {
        title: '账号与安全',
        icon: 'shield',
        url: '/pages/account-status/account-status',
      },
      {
        title: '屏蔽管理',
        icon: 'blocked-user',
        url: '/pages/community-blocks/community-blocks',
      },
      {
        title: '意见与建议',
        icon: 'message',
        url: '/pages/feedback/feedback',
      },
      {
        title: '登录与会话',
        icon: 'person',
        url: '/pages/login/login',
      },
    ],
  },
  controller: undefined as ProfileController | undefined,
  contentController: undefined as MeContentController | undefined,
  contentThumbnails: undefined as FeedThumbnails | undefined,
  schoolUidController: undefined as OwnSchoolUidController | undefined,
  publicIdentityController: undefined as MeIdentityController | undefined,
  detailsController: undefined as ProfileDetailsController | undefined,
  statsController: undefined as ProfileStatsController | undefined,
  scanner: undefined as ProfileScanner | undefined,
  avatarReader: undefined as AvatarReadController | undefined,
  coverReader: undefined as CoverReadController | undefined,
  coverTicket: null as SessionTicket | null,
  avatarTicket: null as SessionTicket | null,
  pageGeneration: 0,
  searchSessionUnsubscribe: undefined as (() => void) | undefined,
  onShow() {
    this.onHide();
    const generation = ++this.pageGeneration;
    const app = getApp<WhaleuApp>();
    const runtime = app.identity;
    if (!runtime) {
      this.setData({
        profile: { ...initialProfileView(), error: '账号服务暂未连接' },
      });
      return;
    }
    let searchTicket = runtime.sessions.snapshot();
    this.searchSessionUnsubscribe = runtime.sessions.subscribe(() => {
      if (generation !== this.pageGeneration) return;
      try {
        runtime.sessions.assertCurrent(searchTicket);
      } catch {
        searchTicket = runtime.sessions.snapshot();
        this.setData({
          contentQuery: '',
          contentSearchOpen: false,
          visibleContentItems: [],
        });
        this.contentThumbnails?.clear();
      }
    });
    if (!this.scanner)
      this.scanner = new ProfileScanner(wx, runtime.sessions, (scan) =>
        this.setData({ scan }),
      );
    this.scanner.onShow();
    const holder: { current?: ProfileController } = {};
    const controller = new ProfileController(
      runtime.sessions,
      runtime.api ? new HttpProfileGateway(runtime.api) : undefined,
      (profile) => {
        if (generation !== this.pageGeneration) return;
        this.setData({ profile });
        const ticket = holder.current?.avatarBasicsTicket();
        if (ticket) {
          this.activateAvatar(ticket, generation);
          this.activateCover(ticket, generation);
        } else {
          this.deactivateAvatar();
          this.deactivateCover();
        }
        if (!profile.hasSession) this.setData({ showMenu: false });
      },
    );
    holder.current = controller;
    this.controller = controller;
    if (app.community) {
      this.contentThumbnails = new FeedThumbnails(
        app.community.sessions,
        app.mediaRead,
        wx,
        this,
        (contentImages) => {
          if (generation === this.pageGeneration)
            this.setData({ contentImages });
        },
      );
      this.contentController = new MeContentController(
        app.community,
        (content) => {
          if (generation !== this.pageGeneration) return;
          this.presentContent(content);
        },
        runtime.api ? new HttpOwnPublicationsGateway(runtime.api) : undefined,
      );
      this.schoolUidController = new OwnSchoolUidController(
        app.community,
        (schoolUidView) => {
          if (generation === this.pageGeneration)
            this.setData({ schoolUidView });
        },
      );
      this.publicIdentityController = new MeIdentityController(
        app.community,
        (publicIdentity) => {
          if (generation === this.pageGeneration)
            this.setData({ publicIdentity });
        },
      );
      this.detailsController = new ProfileDetailsController(
        app.community,
        runtime.api ? new HttpProfileDetailsGateway(runtime.api) : undefined,
        (details) => {
          if (generation === this.pageGeneration) this.setData({ details });
        },
      );
      this.statsController = new ProfileStatsController(
        app.community,
        runtime.api ? new HttpProfileStatsGateway(runtime.api) : undefined,
        (stats) => {
          if (generation === this.pageGeneration) this.setData({ stats });
        },
      );
    } else
      this.setData({
        content: {
          ...initialMeContentView(),
          error: '内容服务暂未连接，请稍后重试',
        },
      });
    void this.reload();
  },
  deactivateAvatar() {
    this.avatarTicket = null;
    const reader = this.avatarReader;
    this.avatarReader = undefined;
    reader?.dispose();
    this.setData({ avatarRead: initialAvatarReadView() });
  },
  activateAvatar(ticket: SessionTicket, generation: number) {
    const app = getApp<WhaleuApp>();
    if (
      generation !== this.pageGeneration ||
      !app.identity ||
      !ticket.credentials
    )
      return;
    try {
      app.identity.sessions.assertCurrent(ticket);
    } catch {
      return;
    }
    if (
      this.avatarTicket?.epoch === ticket.epoch &&
      this.avatarTicket.credentials?.accountId === ticket.credentials.accountId
    )
      return;
    this.deactivateAvatar();
    if (!app.profileAvatar) return;
    this.avatarTicket = ticket;
    this.avatarReader = app.profileAvatar.createReader((view) => {
      if (generation === this.pageGeneration)
        this.setData({ avatarRead: view });
    });
    void this.avatarReader.load(null);
  },
  deactivateCover() {
    this.coverTicket = null;
    const reader = this.coverReader;
    this.coverReader = undefined;
    reader?.dispose();
    this.setData({ coverRead: initialCoverReadView() });
  },
  activateCover(ticket: SessionTicket, generation: number) {
    const app = getApp<WhaleuApp>();
    if (
      generation !== this.pageGeneration ||
      !app.identity ||
      !ticket.credentials
    )
      return;
    try {
      app.identity.sessions.assertCurrent(ticket);
    } catch {
      return;
    }
    if (
      this.coverTicket?.epoch === ticket.epoch &&
      this.coverTicket.credentials?.accountId === ticket.credentials.accountId
    )
      return;
    this.deactivateCover();
    if (!app.profileCover) return;
    this.coverTicket = ticket;
    this.coverReader = app.profileCover.createReader((view) => {
      if (generation === this.pageGeneration) this.setData({ coverRead: view });
    });
    void this.coverReader.load(null, true);
  },
  onCoverError() {
    this.coverReader?.imageFailed();
  },
  async reload() {
    await Promise.all([
      this.controller?.load(),
      this.contentController?.load(),
      this.schoolUidController?.load(),
      this.publicIdentityController?.load(),
      this.detailsController?.load(),
      this.statsController?.load(),
    ]);
  },
  async onPullDownRefresh() {
    try {
      await this.reload();
    } finally {
      wx.stopPullDownRefresh?.();
    }
  },
  onReload() {
    if (this.controller) void this.reload();
    else this.onShow();
  },
  onContentReload() {
    if (this.contentController) void this.contentController.load();
    else this.onShow();
  },
  presentContent(content: MeContentView) {
    const visibleContentItems = filterMeContent(
      content.items,
      this.data.contentQuery,
    );
    const committed = this.contentThumbnails?.render(
      content.loaded &&
        !content.busy &&
        content.hasSession &&
        content.availability === 'available'
        ? visibleContentItems
        : [],
      `me:${content.tab}:${content.mode}`,
    );
    this.setData({ content, visibleContentItems }, committed);
  },
  onContentSearchToggle() {
    this.setData({
      contentSearchOpen: !this.data.contentSearchOpen,
      contentQuery: '',
    });
    this.presentContent(this.data.content);
  },
  onContentSearchInput(event: { detail: { value: string } }) {
    this.setData({ contentQuery: event.detail.value.slice(0, 100) });
    this.presentContent(this.data.content);
  },
  onStatsReload() {
    void this.statsController?.load();
  },
  onTab(event: { currentTarget: { dataset: { key: string } } }) {
    const key = event.currentTarget.dataset.key;
    if (
      !['posts', 'replies', 'saved', 'liked'].includes(key) ||
      key === this.data.content.tab
    )
      return;
    this.setData({ contentQuery: '' });
    void this.contentController?.setTab(key);
  },
  onContentMode(event: { currentTarget: { dataset: { key: string } } }) {
    const key = event.currentTarget.dataset.key;
    if (!['named', 'anonymous'].includes(key) || key === this.data.content.mode)
      return;
    this.setData({ contentQuery: '' });
    this.contentThumbnails?.clear();
    void this.contentController?.setMode(key);
  },
  onMore() {
    void this.contentController?.more();
  },
  onPrevious() {
    void this.contentController?.previous();
  },
  onOpenMenu() {
    this.setData({ showMenu: true });
  },
  onCloseMenu() {
    this.setData({ showMenu: false });
  },
  onScan() {
    this.setData({ actionError: '', showMenu: false });
    if (this.scanner) this.scanner.scan();
    else this.setData({ actionError: '扫码服务尚未就绪，请重新打开小程序' });
  },
  onShareUnavailable() {
    this.setData({
      actionError: '当前公开主页尚不可分享，请重新加载后再试。',
    });
  },
  onShareAppMessage() {
    return buildOwnProfileShare(
      this.data.publicIdentity.profile,
      getApp<WhaleuApp>().identity?.sessions,
      this.publicIdentityController?.shareTicket() ?? null,
    );
  },
  onOpenAvatar() {
    void this.avatarReader?.open();
  },
  onCloseAvatar() {
    void this.avatarReader?.close();
  },
  onAvatarError() {
    this.avatarReader?.imageFailed();
  },
  onContentImageError(event: {
    currentTarget: { dataset: { id?: string; src?: string; viewId?: string } };
  }) {
    const { id, src, viewId } = event.currentTarget.dataset;
    if (id && src && viewId)
      this.contentThumbnails?.imageFailed(id, src, viewId);
  },
  onHide() {
    this.scanner?.onHide();
    this.pageGeneration++;
    this.searchSessionUnsubscribe?.();
    this.searchSessionUnsubscribe = undefined;
    this.contentThumbnails?.dispose();
    this.contentThumbnails = undefined;
    this.controller?.dispose();
    this.controller = undefined;
    this.contentController?.dispose();
    this.contentController = undefined;
    this.schoolUidController?.dispose();
    this.schoolUidController = undefined;
    this.publicIdentityController?.dispose();
    this.publicIdentityController = undefined;
    this.detailsController?.dispose();
    this.detailsController = undefined;
    this.statsController?.dispose();
    this.statsController = undefined;
    this.deactivateAvatar();
    this.deactivateCover();
    this.setData({
      profile: initialProfileView(),
      content: initialMeContentView(),
      visibleContentItems: [],
      contentQuery: '',
      contentSearchOpen: false,
      contentImages: {},
      schoolUidView: initialOwnSchoolUidView(),
      publicIdentity: initialMeIdentityView(),
      details: initialProfileDetailsView(),
      stats: initialProfileStatsView(),
      actionError: '',
      showMenu: false,
    });
  },
  onUnload() {
    this.onHide();
    this.scanner?.dispose();
    this.scanner = undefined;
  },
});
