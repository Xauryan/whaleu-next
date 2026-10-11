import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AnnouncementPopupController,
  initialAnnouncementPopupView,
} from '../src/announcements/popup-controller';
import { ClientError } from '../src/api/errors';
import {
  announcementHarness,
  popup,
  otherId,
  timestamp,
} from './announcement-helpers';
import type { AnnouncementsGateway } from '../src/announcements/gateway';
test('native candidate priority selects before acknowledgement; accepted fallback requires proven native none', async () => {
  for (const state of [
    'unseen',
    'acknowledged',
    'unavailable',
    'none',
    'failure',
  ] as const) {
    const f = announcementHarness();
    let nativeAck = 0;
    const native: AnnouncementsGateway = {
      ...f.runtime.announcements,
      ownerPopup: async (campus) => {
        if (state === 'failure')
          throw new ClientError('business', 'unavailable', {
            serverCode: 'ANNOUNCEMENTS_UNAVAILABLE',
          });
        return state === 'none'
          ? { context: { campusId: campus }, candidate: null }
          : {
              context: { campusId: campus },
              candidate: popup({ id: otherId }),
              acknowledgement:
                state === 'acknowledged'
                  ? { status: state, acknowledgedAt: timestamp }
                  : { status: state, acknowledgedAt: null },
            };
      },
      acknowledge: async (_campus, id) => {
        nativeAck++;
        return {
          announcementId: id,
          acknowledgement: {
            status: 'acknowledged',
            acknowledgedAt: timestamp,
          },
        };
      },
    };
    let view = initialAnnouncementPopupView();
    const c = new AnnouncementPopupController(
      { ...f.runtime, nativeAnnouncements: native },
      (v) => (view = v),
    );
    await c.load(null);
    if (state === 'none') {
      assert.equal(f.calls.filter((x) => x.method === 'ownerPopup').length, 1);
      assert.ok(view.popup);
      await c.close();
      assert.equal(nativeAck, 0);
      assert.equal(f.calls.filter((x) => x.method === 'acknowledge').length, 1);
    } else {
      assert.equal(f.calls.length, 0);
      assert.equal(view.popup?.id ?? null, state === 'unseen' ? otherId : null);
      if (state === 'unseen') {
        await c.close();
        assert.equal(nativeAck, 1);
      }
    }
    c.dispose();
    f.controller.dispose();
    f.popupController.dispose();
  }
});
