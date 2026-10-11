import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import {
  commandSchema,
  commandHash,
} from '../src/announcements/authoring/contracts.js';
import { canonicalJson } from '../src/community/content-review/contracts.js';
const require = createRequire(import.meta.url),
  native = require('../../wechat/src/announcements/authoring/contract.ts');
const base = (text: string) => ({
  action: 'create' as const,
  clientRequestId: randomUUID(),
  expectedRevision: 0,
  content: {
    versionLabel: '版😀',
    bodyText: text,
    announcementDate: null,
    popupEnabled: true,
    highlight: false,
    popupTitle: '鲸语校园版😀',
    popupBodyText: text,
  },
  audience: { kind: 'all' as const },
});
test('announcement UTF-8 budget includes all canonical wrappers and matches native before durable pending', () => {
  const chinese = base('中'.repeat(6000)),
    actor = randomUUID(),
    target = randomUUID();
  assert.ok(commandSchema.safeParse(chinese).success);
  assert.deepEqual(native.decodeCommand(chinese), chinese);
  assert.equal(
    commandHash(actor, target, chinese),
    native.commandHash(actor, target, chinese),
  );
  let largest = base('😀');
  while (
    Buffer.byteLength(
      canonicalJson({
        ...largest,
        content: {
          ...largest.content,
          bodyText: largest.content.bodyText + '😀',
          popupBodyText: largest.content.popupBodyText + '😀',
        },
      }),
    ) <= 60000
  ) {
    largest = {
      ...largest,
      content: {
        ...largest.content,
        bodyText: largest.content.bodyText + '😀',
        popupBodyText: largest.content.popupBodyText + '😀',
      },
    };
  }
  assert.ok(commandSchema.safeParse(largest).success);
  assert.deepEqual(native.decodeCommand(largest), largest);
  const tooMuch = {
    ...largest,
    content: {
      ...largest.content,
      bodyText: largest.content.bodyText + '😀',
      popupBodyText: largest.content.popupBodyText + '😀',
    },
  };
  assert.equal(commandSchema.safeParse(tooMuch).success, false);
  assert.throws(() => native.decodeCommand(tooMuch));
  const {
    AnnouncementPublicationJournal,
  } = require('../../wechat/src/announcements/authoring/pending.ts');
  const values = new Map<string, unknown>();
  const journal = new AnnouncementPublicationJournal(
    {
      get: (k: string) => values.get(k),
      set: (k: string, v: unknown) => values.set(k, v),
      remove: (k: string) => values.delete(k),
    },
    'https://synthetic.invalid',
  );
  assert.throws(() => journal.write(actor, target, tooMuch));
  assert.equal(values.size, 0);
  const boundary = {
    ...largest,
    audience: {
      kind: 'regions',
      regionIds: Array.from({ length: 64 }, () => randomUUID()),
    },
  };
  assert.equal(commandSchema.safeParse(boundary).success, false);
  assert.throws(() => native.decodeCommand(boundary));
});
test('announcement commands reject actor/title/type/scheduling and unknown fields', () => {
  const good = base('逐行\n  正文');
  for (const bad of [
    { ...good, actorId: randomUUID() },
    { ...good, content: { ...good.content, title: 'spoof' } },
    { ...good, content: { ...good.content, type: 'major' } },
    { ...good, publishAt: '2099-01-01' },
  ]) {
    assert.equal(commandSchema.safeParse(bad).success, false);
    assert.throws(() => native.decodeCommand(bad));
  }
});
