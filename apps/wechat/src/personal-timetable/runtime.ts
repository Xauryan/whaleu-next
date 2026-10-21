import type { WhaleuApp } from '../app';
import { clientConfiguration } from '../config';
import { WechatStorage, type WxApi } from '../platform/wechat';
import {
  TimetableController,
  type Mode,
  type TimetableView,
} from './controller';
import { HttpTimetableGateway } from './gateway';
import { TimetableJournal } from './journal';
/** Page-local initialization. app.ts/CommunityRuntime implementation is never imported. */
export function createTimetableController(
  mode: Mode,
  app: WhaleuApp,
  native: WxApi,
  render: (view: TimetableView) => void,
): TimetableController | null {
  if (
    !app.identity?.api ||
    !app.community?.newRequestId ||
    !app.community.privateViews
  )
    return null;
  return new TimetableController(
    mode,
    app.identity.sessions,
    new HttpTimetableGateway(app.identity.api),
    new TimetableJournal(
      new WechatStorage(native),
      clientConfiguration.apiOrigin,
    ),
    app.community.newRequestId,
    render,
    Date.now,
    app.community.privateViews,
  );
}
