/** Pure test adapter only. No IPC listeners, application imports or I/O on import. */
import assert from 'node:assert/strict';

/** Record attempts before validating, and keep failures outside application catches.
 * Invalid dispatches are refused, but refusal can never masquerade as no attempt.
 * Exported only for focused, I/O-free regression checks of this test adapter.
 */
export interface NoticeTransportRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
}
interface DispatchAttempt {
  method: string;
  path: string | null;
}
interface ReadAttempt {
  noticeId: string | null;
  category: string | null;
  method: string;
}
export function checkedNoticeTransport<T>(
  real: { send(request: NoticeTransportRequest): T },
  credentials: { readonly accessToken: string },
  noticeIds: Readonly<Record<string, string>>,
  nativeOrigin: string,
) {
  const attempts: DispatchAttempt[] = [];
  const writes: ReadAttempt[] = [];
  const invariantFailures: string[] = [];
  const expectedCategory = new Map(
    Object.entries(noticeIds).map(([role, id]) => [
      id,
      role === 'follower' ? 'followers' : 'likes',
    ]),
  );
  function validate<Result>(check: () => Result): Result {
    try {
      return check();
    } catch (error) {
      invariantFailures.push(
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }
  return {
    attempts,
    writes,
    validate,
    assertHealthy() {
      assert.deepEqual(
        invariantFailures,
        [],
        'No transport or response invariant may be swallowed by production error handling',
      );
    },
    transport: {
      send(request: NoticeTransportRequest) {
        // This must be first: even malformed URL, method, ownership or payload
        // attempts survive an application catch and are observable to the test.
        const attempt: DispatchAttempt = { method: request.method, path: null };
        attempts.push(attempt);
        let write: ReadAttempt | null =
          request.method === 'GET'
            ? null
            : {
                noticeId: null,
                category: null,
                method: request.method,
              };
        if (write) writes.push(write);
        validate(() => {
          const url = new URL(request.url);
          attempt.path = url.pathname;
          // A read endpoint accidentally called with GET is still an attempted
          // acknowledgment, not a harmless request hidden from noWrite checks.
          if (!write && url.pathname.endsWith('/read')) {
            write = { noticeId: null, category: null, method: request.method };
            writes.push(write);
          }
          assert.equal(
            url.origin,
            nativeOrigin,
            'Only the fixture API origin is permitted',
          );
          assert.equal(url.username, '');
          assert.equal(url.password, '');
          assert.equal(url.hash, '');
          assert.ok(
            request.headers['Authorization'] ===
              `Bearer ${credentials.accessToken}`,
            'Every private request carries the exact owner session, not the replacement account',
          );
          if (write) {
            const match = /^\/v1\/me\/social-updates\/([^/]+)\/read$/.exec(
              url.pathname,
            );
            assert.ok(match, 'Only a source-owned social read may mutate');
            write.noticeId = match[1]!;
            write.category = url.searchParams.get('category');
            assert.equal(request.method, 'PUT');
            assert.deepEqual(request.body, {});
            assert.equal(write.category, expectedCategory.get(match[1]!));
            assert.equal(url.searchParams.size, 1);
          } else {
            assert.equal(request.method, 'GET');
            assert.ok(
              [
                '/v1/me/social-updates',
                '/v1/me/social-updates/unread-count',
              ].includes(url.pathname) ||
                /^\/v1\/me\/social-updates\/[^/]+\/target$/.test(url.pathname),
              'Read-only requests stay within the real social owner routes',
            );
          }
        });
        // Keep validation before actual I/O. An invalid scope/owner is recorded
        // and refused, never sent to the server merely to make a test fail.
        return real.send(request);
      },
    },
  };
}
