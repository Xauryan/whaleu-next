import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import { directoryRuntimeFixture } from '../support/directory-runtime-fixture.js';
import { createRuntimeActor } from '../support/community-runtime-fixtures.js';
import { officialAccountFixture } from '../support/official-account-fixture.js';
import {
  officialBrowser,
  officialBrowserVersion,
} from '../support/official-account-browser.js';

const B = '/v1/me/official-account-operations';
const journal = `JSON.parse(Object.entries(localStorage).find(([k])=>k.startsWith('whaleu.official-operator.v1:'))?.[1] || 'null')`;

test(
  `real Chromium ${officialBrowserVersion} operator DOM/events/fetch crosses ordinary HTTP/PG`,
  { timeout: 180000 },
  async (t) => {
    // Missing official runtime is a failed/not-run prerequisite, never a skip.
    const browser = await officialBrowser();
    t.after(() => browser.close());
    const f = await officialAccountFixture();
    t.after(() => f.close());
    await f.app.listen(0, '127.0.0.1');
    const origin = await f.app.getUrl();
    const url = `${origin}/operator/official-articles`;
    const secretText = '合成正文仅供当次预览';
    await f.publish(secretText);
    await f.ready();
    const actor = f.world.author;
    const effects = async () =>
      Number(
        (
          await f.pool.query(
            'SELECT count(*)::int n FROM whaleu_official.effects e JOIN whaleu_official.commands c ON c.id=e.command_id WHERE c.program_id=$1',
            [f.programId],
          )
        ).rows[0]!.n,
      );
    const commands = async (operation: string) =>
      (
        await f.pool.query<{ request_id: string }>(
          'SELECT request_id FROM whaleu_official.commands WHERE program_id=$1 AND operation=$2 ORDER BY accepted_at,id',
          [f.programId, operation],
        )
      ).rows;
    const exchanges: { path: string; method: string }[] = [];
    browser.on((packet) => {
      if (packet.method !== 'Network.requestWillBeSent') return;
      const req = packet.params?.['request'] as { url: string; method: string };
      const parsed = new URL(req.url);
      assert.equal(parsed.searchParams.has('bearer'), false);
      assert.ok(
        !req.url.includes(actor.accessToken),
        'Bearer never enters URL',
      );
      if (parsed.pathname.startsWith(B))
        exchanges.push({ path: parsed.pathname, method: req.method });
    });
    const bridge = async () => {
      // CDP injects an in-memory test bridge into the ACTUAL fetched module.
      // Credentials never enter HTML, query/hash, cookie or browser storage.
      await browser.evaluate(
        `(async()=>{const m=await import('/operator/official-articles/app.js');let s=${JSON.stringify({ accountId: actor.accountId, bearer: actor.accessToken })};const listeners=new Set();globalThis.officialTestLogout=()=>{s=null;for(const fn of listeners)fn()};m.mountOfficialOperator({session:()=>s,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)}})})()`,
      );
      await browser.until(
        "!document.getElementById('load').disabled",
        'memory bridge ready',
      );
    };
    const load = async () => {
      await browser.evaluate(
        `(()=>{const e=document.getElementById('program');e.value=${JSON.stringify(f.programId)};e.dispatchEvent(new Event('input',{bubbles:true}))})()`,
      );
      await browser.click('load');
      await browser.until(
        "!document.getElementById('preview').disabled",
        'actual authority and config loaded',
      );
    };
    const recovery = async (label: string) => {
      await browser.until(
        "!document.getElementById('recover').disabled",
        'recovery enabled',
      );
      await browser.click('recover');
      await browser.until(
        `document.getElementById('message').textContent===${JSON.stringify(label)}`,
        label,
      );
    };
    const storagePrivate = async () => {
      const stored = await browser.evaluate<string>(
        'JSON.stringify({local:Object.entries(localStorage),session:Object.entries(sessionStorage),cookie:document.cookie,url:location.href})',
      );
      assert.ok(!stored.includes(actor.accessToken), 'No bearer persisted');
      assert.ok(!stored.includes(secretText), 'No article body persisted');
      assert.ok(!stored.includes('合成公众号'), 'No account label persisted');
    };

    await t.test(
      'actual shell is inert without bridge; headers, inline CSP and no token entry',
      async () => {
        for (const path of [
          '/operator/official-articles',
          '/operator/official-articles/app.js',
          '/operator/official-articles/app.css',
        ]) {
          const r = await request(f.app.getHttpServer()).get(path).expect(200);
          assert.match(r.headers['cache-control'] ?? '', /no-store/);
          assert.equal(r.headers['x-content-type-options'], 'nosniff');
          assert.equal(r.headers['referrer-policy'], 'no-referrer');
          assert.match(
            r.headers['content-security-policy'] ?? '',
            /default-src 'none'; script-src 'self'; connect-src 'self'/,
          );
          assert.ok(!r.text.includes(actor.accessToken));
        }
        await browser.navigate(url);
        assert.equal(
          await browser.evaluate(
            "document.getElementById('message').textContent",
          ),
          '运营登录暂不可用',
        );
        assert.equal(
          await browser.evaluate(
            "[...document.querySelectorAll('button')].every(b=>b.disabled)",
          ),
          true,
        );
        assert.equal(
          await browser.evaluate(
            "document.querySelectorAll('input[type=password],textarea').length",
          ),
          0,
        );
        await browser.evaluate(
          "(()=>{globalThis.cspViolations=[];document.addEventListener('securitypolicyviolation',e=>cspViolations.push(e.violatedDirective));const s=document.createElement('script');s.textContent='globalThis.inlineExecuted=true';document.body.append(s)})()",
        );
        await browser.until('cspViolations.length>0', 'real CSP violation');
        assert.equal(
          await browser.evaluate('globalThis.inlineExecuted===undefined'),
          true,
        );
        assert.equal(await effects(), 0);
      },
    );

    await t.test(
      'pre-admission cancellation survives a lost ACK and real reload without a fabricated receipt',
      async () => {
        await bridge();
        await load();
        await browser.click('preview');
        await browser.until(
          "!document.getElementById('create').disabled",
          'pre-admission preview',
        );
        const failures: Error[] = [];
        const stop = browser.on((packet) => {
          if (packet.method !== 'Fetch.requestPaused') return;
          const id = packet.params?.['requestId'];
          if (typeof id === 'string')
            void browser
              .command('Fetch.failRequest', {
                requestId: id,
                errorReason: 'ConnectionClosed',
              })
              .catch((error) => failures.push(error as Error));
        });
        await browser.command('Fetch.enable', {
          patterns: [
            {
              urlPattern: `*${B}/operator/draft-commands`,
              requestStage: 'Request',
            },
          ],
        });
        await browser.click('create');
        await browser.until(
          "!document.getElementById('recover').disabled && document.getElementById('message').textContent.includes('暂不可用')",
          'blocked admission keeps journal',
        );
        const key = await browser.evaluate<string>(
          `${journal}.intent.requestId`,
        );
        assert.equal((await commands('manual_draft')).length, 0);
        await browser.command('Fetch.disable');
        await browser.command('Fetch.enable', {
          patterns: [
            {
              urlPattern: `*${B}/requests/${key}/cancel`,
              requestStage: 'Response',
            },
          ],
        });
        await browser.click('cancel');
        await browser.until(
          "!document.getElementById('recover').disabled && document.getElementById('message').textContent.includes('暂不可用')",
          'cancel ACK lost',
        );
        await browser.command('Fetch.disable');
        stop();
        assert.deepEqual(failures, []);
        await browser.command('Page.reload');
        await browser.until(
          "document.getElementById('message')?.textContent==='运营登录暂不可用'",
          'reload without bridge',
        );
        await bridge();
        await browser.until(
          `${journal}===null`,
          'same-key tombstone clears only matched journal',
        );
        assert.match(
          await browser.evaluate<string>(
            "document.getElementById('receipt').textContent",
          ),
          /录入前已取消/,
        );
        assert.equal((await commands('manual_draft')).length, 0);
        assert.equal(await effects(), 0);
      },
    );

    let draftRef: string;
    let createKey: string;
    await t.test(
      'real local preview produces no effect; double click plus lost response/reload recovers one original key',
      async () => {
        const previousCreateExchanges = exchanges.filter(
          (x) => x.path === `${B}/operator/draft-commands`,
        ).length;
        await bridge();
        await load();
        await browser.click('preview');
        await browser.until(
          "!document.getElementById('create').disabled",
          'manual newest preview',
        );
        assert.ok(
          (
            await browser.evaluate<string>(
              "document.getElementById('article').textContent",
            )
          ).includes(secretText),
        );
        assert.equal(await effects(), 0);
        await storagePrivate();
        const foreground = await browser.background();
        assert.equal(
          await browser.evaluate(
            "document.getElementById('article').textContent",
          ),
          '',
        );
        assert.equal(
          await browser.evaluate(
            "document.getElementById('account').textContent",
          ),
          '',
        );
        await foreground();
        await load();
        await browser.click('preview');
        await browser.until(
          "!document.getElementById('create').disabled",
          'explicit preview after real hide',
        );
        // Drop the response only AFTER the real API has replied; no mocked fetch.
        let dropped = false;
        const failures: Error[] = [];
        const stop = browser.on((packet) => {
          if (packet.method !== 'Fetch.requestPaused') return;
          const id = packet.params?.['requestId'];
          const status = packet.params?.['responseStatusCode'];
          if (typeof id !== 'string') return;
          dropped = status === 202 || status === 200;
          void browser
            .command('Fetch.failRequest', {
              requestId: id,
              errorReason: 'ConnectionClosed',
            })
            .catch((error) => failures.push(error as Error));
        });
        await browser.command('Fetch.enable', {
          patterns: [
            {
              urlPattern: `*${B}/operator/draft-commands`,
              requestStage: 'Response',
            },
          ],
        });
        await browser.evaluate(
          "(()=>{const b=document.getElementById('create');b.click();b.click()})()",
        );
        await browser.until(
          "!document.getElementById('recover').disabled && document.getElementById('message').textContent.includes('暂不可用')",
          'lost response retained',
        );
        assert.equal(dropped, true);
        assert.deepEqual(failures, []);
        await browser.command('Fetch.disable');
        stop();
        createKey = await browser.evaluate<string>(
          `${journal}.intent.requestId`,
        );
        assert.deepEqual(
          (await commands('manual_draft')).map((row) => row.request_id),
          [createKey],
        );
        assert.equal(
          exchanges.filter((x) => x.path === `${B}/operator/draft-commands`)
            .length - previousCreateExchanges,
          1,
        );
        await browser.command('Page.reload');
        await browser.until(
          "document.readyState==='complete' && document.getElementById('message')?.textContent==='运营登录暂不可用'",
          'real reload clears bridge',
        );
        assert.equal(
          await browser.evaluate(
            "document.getElementById('article').textContent",
          ),
          '',
        );
        assert.equal(
          await browser.evaluate<string>(`${journal}.intent.requestId`),
          createKey,
        );
        const before = exchanges.length;
        await bridge();
        await browser.until(
          "!document.getElementById('recover').disabled",
          'same-key recovery on reentry',
        );
        assert.ok(
          exchanges
            .slice(before)
            .some(
              (x) =>
                x.path === `${B}/requests/${createKey}` && x.method === 'GET',
            ),
        );
        await f.worker.runCycle();
        await recovery('草稿已生成，未发布');
        draftRef = (
          await request(f.app.getHttpServer())
            .get(`${B}/requests/${createKey}`)
            .set('Authorization', `Bearer ${actor.accessToken}`)
            .expect(200)
        ).body.status.draftRef as string;
        assert.ok(draftRef);
        await storagePrivate();
      },
    );

    await t.test(
      'fresh explicit publish confirmation, foreign rejection, submitted is never published',
      async () => {
        await load();
        await browser.click('confirm');
        await browser.until(
          "!document.getElementById('publish').disabled",
          'fresh confirmation read',
        );
        assert.match(
          await browser.evaluate<string>(
            "document.getElementById('confirmation').textContent",
          ),
          /确认发布到 合成公众号/,
        );
        assert.equal((await commands('manual_publish')).length, 0);
        const testPreview = (
          await request(f.app.getHttpServer())
            .post(`${B}/previews`)
            .set('Authorization', `Bearer ${actor.accessToken}`)
            .send({
              programId: f.programId,
              kind: 'test',
              expectedConfigRevision: f.revision,
            })
            .expect(200)
        ).body;
        const testKey = randomUUID();
        await request(f.app.getHttpServer())
          .post(`${B}/test-commands`)
          .set('Authorization', `Bearer ${actor.accessToken}`)
          .send({
            requestId: testKey,
            programId: f.programId,
            previewId: testPreview.previewId,
            manifestHash: testPreview.manifestHash,
            expectedConfigRevision: f.revision,
            acknowledgement: 'synthetic_draft_only',
          })
          .expect(202);
        await f.worker.runCycle();
        const testDraft = (
          await request(f.app.getHttpServer())
            .get(`${B}/requests/${testKey}`)
            .set('Authorization', `Bearer ${actor.accessToken}`)
            .expect(200)
        ).body.status;
        assert.equal(testDraft.state, 'draft_confirmed');
        await request(f.app.getHttpServer())
          .post(`${B}/operator/publish-previews`)
          .set('Authorization', `Bearer ${actor.accessToken}`)
          .send({ draftRef: testDraft.draftRef })
          .expect(404);
        await request(f.app.getHttpServer())
          .post(`${B}/operator/publish-previews`)
          .set('Authorization', `Bearer ${actor.accessToken}`)
          .send({ draftRef: randomUUID() })
          .expect(404);
        await request(f.app.getHttpServer())
          .post(`${B}/operator/publish-previews`)
          .set('Authorization', `Bearer ${f.world.reader.accessToken}`)
          .send({ draftRef })
          .expect(404);
        await request(f.app.getHttpServer())
          .post(`${B}/operator/publish-previews`)
          .set('Authorization', `Bearer ${actor.accessToken}`)
          .set('Origin', 'https://foreign.invalid')
          .send({ draftRef })
          .expect(403);
        // A real navigation must discard a previously fetched confirmation.
        await browser.navigate(url);
        await bridge();
        await load();
        assert.equal(
          await browser.evaluate("document.getElementById('publish').disabled"),
          true,
        );
        assert.equal(
          await browser.evaluate(
            "document.getElementById('confirmation').textContent",
          ),
          '',
        );
        await browser.click('confirm');
        await browser.until(
          "!document.getElementById('publish').disabled",
          'new confirmation after navigation',
        );
        await browser.evaluate(
          "(()=>{const b=document.getElementById('publish');b.click();b.click()})()",
        );
        await browser.until(
          `${journal}?.operation==='manual_publish' && !document.getElementById('recover').disabled`,
          'publish admission',
        );
        const publishKey = await browser.evaluate<string>(
          `${journal}.intent.requestId`,
        );
        await f.worker.runCycle();
        await recovery('已提交发布，等待结果');
        assert.deepEqual(
          (await commands('manual_publish')).map((row) => row.request_id),
          [publishKey],
        );
        assert.equal(
          exchanges.filter((x) => x.path === `${B}/operator/publish-commands`)
            .length,
          1,
        );
        assert.ok(
          !(
            await browser.evaluate<string>('document.body.textContent')
          ).includes('发布已确认'),
        );
        await browser.command('Page.reload');
        await browser.until(
          "document.getElementById('message')?.textContent==='运营登录暂不可用'",
          'reload without authentication',
        );
        await bridge();
        await recovery('已提交发布，等待结果');
        assert.equal(
          await browser.evaluate<string>(`${journal}.intent.requestId`),
          publishKey,
        );
        assert.equal((await commands('manual_publish')).length, 1);
        await browser.evaluate('officialTestLogout()');
        assert.equal(
          await browser.evaluate(
            "document.getElementById('article').textContent+document.getElementById('confirmation').textContent+document.getElementById('receipt').textContent",
          ),
          '',
        );
        assert.equal(
          await browser.evaluate(
            "[...document.querySelectorAll('button')].every(b=>b.disabled)",
          ),
          true,
        );
        await storagePrivate();
      },
    );
  },
);

test(
  'ordinary default-off AppModule remains inert through real browser and authenticated test bridge',
  { timeout: 120000 },
  async (t) => {
    const browser = await officialBrowser();
    t.after(() => browser.close());
    const f = await directoryRuntimeFixture();
    t.after(() => f.close());
    const actor = await createRuntimeActor(f.app);
    await browser.navigate(
      `http://127.0.0.1:${f.port}/operator/official-articles`,
    );
    await browser.evaluate(
      `(async()=>{const {mountOfficialOperator}=await import('/operator/official-articles/app.js');mountOfficialOperator({session:()=>${JSON.stringify({ accountId: actor.accountId, bearer: actor.accessToken })},subscribe:()=>()=>{}})})()`,
    );
    await browser.until(
      "!document.getElementById('load').disabled",
      'default bridge connected',
    );
    await browser.evaluate(
      `(()=>{const e=document.getElementById('program');e.value=${JSON.stringify(randomUUID())};e.dispatchEvent(new Event('input',{bubbles:true}))})()`,
    );
    await browser.click('load');
    await browser.until(
      "document.getElementById('message').textContent.includes('公众号运营暂不可用')",
      'disabled runtime message',
    );
    assert.equal(
      await browser.evaluate(
        "['preview','create','confirm','publish'].every(id=>document.getElementById(id).disabled)",
      ),
      true,
    );
    assert.equal(
      await browser.evaluate(
        "document.getElementById('account').textContent+document.getElementById('article').textContent",
      ),
      '',
    );
    assert.equal(
      await browser.evaluate('localStorage.length+sessionStorage.length'),
      0,
    );
  },
);
