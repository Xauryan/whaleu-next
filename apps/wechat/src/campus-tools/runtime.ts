import type { ApiClient } from '../api/client';
import { ClientError } from '../api/errors';
import type { AuthService } from '../auth/auth-service';
import type { SessionStore } from '../auth/session';
import type { MediaLocalFiles } from '../media/local-files';
import type { Clock } from '../platform/contracts';
import { WechatStorage, type WxApi } from '../platform/wechat';
import { ToolAuthRecovery } from './auth-recovery';
import type { MediaFiles } from '../platform/wechat-media';
import { HttpProfileGateway } from '../profile/gateway';
import type { ToolKind } from './contract';
import {
  ToolEntryController,
  ToolHubController,
  disabledToolEmbed,
  type ToolEmbedPort,
  type ToolEntryView,
  type ToolHubView,
} from './controller';
import { HttpToolGateway } from './gateway';
import { disabledToolLocation, type ToolLocationPort } from './location';
import { createToolImageRuntime } from './media';
import type { ToolRoute } from './navigation';
import { ToolBrowseScope } from './scope';
export function createCampusToolsRuntime(options: {
  api: ApiClient;
  sessions: SessionStore;
  origin: string;
  wx: WxApi;
  files: MediaFiles;
  registry: MediaLocalFiles;
  auth: Pick<AuthService, 'refresh'>;
  clock: Clock;
  authRecoveryRequired?: boolean;
  location?: ToolLocationPort;
  embed?: ToolEmbedPort;
}) {
  const recovery = new ToolAuthRecovery(
    options.sessions,
    new WechatStorage(options.wx),
    options.origin,
    options.authRecoveryRequired,
  );
  const scope = new ToolBrowseScope(),
    gateway = new HttpToolGateway(options.api, () => recovery.assertAllowed()),
    profile = new HttpProfileGateway(options.api);
  let ticket = options.sessions.snapshot();
  options.sessions.subscribe(() => {
    const now = options.sessions.snapshot();
    if (
      now.epoch !== ticket.epoch ||
      now.credentials?.accountId !== ticket.credentials?.accountId
    )
      scope.select(null);
    ticket = now;
  });
  const images = createToolImageRuntime({ ...options, scope, gateway });
  const controllers = new Set<{ dispose(): void }>();
  function retain<T extends { dispose(): void }>(controller: T): T {
    controllers.add(controller);
    const dispose = controller.dispose.bind(controller);
    controller.dispose = () => {
      controllers.delete(controller);
      dispose();
    };
    return controller;
  }
  return {
    scope,
    needsRecovery: () => recovery.needsRecovery(),
    continueGuest: () => recovery.continueGuest(),
    createHub: (render: (view: ToolHubView) => void) =>
      retain(
        new ToolHubController(
          options.sessions,
          gateway,
          profile,
          scope,
          options.clock,
          render,
        ),
      ),
    createEntry: (
      route: ToolRoute,
      kind: ToolKind,
      render: (view: ToolEntryView) => void,
      invalidateImages: () => void,
    ) =>
      retain(
        new ToolEntryController(
          route,
          kind,
          options.sessions,
          gateway,
          scope,
          options.clock,
          {
            set: (value) =>
              new Promise<void>((resolve, reject) => {
                if (!options.wx.setClipboardData) {
                  reject(new ClientError('network', 'Clipboard unavailable'));
                  return;
                }
                try {
                  options.wx.setClipboardData({
                    data: value,
                    success: resolve,
                    fail: () =>
                      reject(
                        new ClientError('network', 'Clipboard unavailable'),
                      ),
                  });
                } catch {
                  reject(new ClientError('network', 'Clipboard unavailable'));
                }
              }),
          },
          render,
          invalidateImages,
          options.location ?? disabledToolLocation,
          options.embed ?? disabledToolEmbed,
        ),
      ),
    createReader: images.createReader,
    hide() {
      for (const controller of controllers) controller.dispose();
      images.hide();
    },
  };
}
export type CampusToolsRuntime = ReturnType<typeof createCampusToolsRuntime>;
