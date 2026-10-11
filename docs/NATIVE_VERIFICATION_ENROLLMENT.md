# Native account verification enrollment

Migration 0094 adds an append-only `native_enrollment` source for covered absence,
not verification. Identity calls the lifecycle only after inserting a genuinely
new account and its app-scoped WeChat provider identity in the same transaction.
Existing logins never initialize or repair verification history.

The database requires the account's immutable `local_creation_transaction` to
match the current top-level transaction, a matching provider row, no prior
verification head/assertion/snapshot/event, and no legacy mapping. At commit it
checks the matching provider still exists, no legacy mapping was added, and the
exact three absence assertions, revision-one snapshot, owner event and head exist.
The source cannot issue `verified`, `revoked` or `expired`, private numbers,
institutions, origin regions or a phone-binding pointer. Source and policy are
`native_enrollment:<account UUID>` and `native-account-absence/v1`.

A new account therefore reads affiliation/student-number/phone `unverified` and
application `none`. This is not student authentication, phone verification or
publication permission. Existing and legacy accounts without trustworthy records
continue to read `unavailable`; there is no backfill or fixture enrollment route.
The original phone-provider/import verification policy remains unchanged.

## Phone binding boundary

Enrollment itself does not bind a phone or grant verification. The separate,
explicitly enabled phone-binding slice is described in
[WECHAT_PHONE_BINDING.md](WECHAT_PHONE_BINDING.md). It uses actual server code
exchange rather than treating account creation/OpenID as phone proof. It remains
unvalidated and default-disabled. No live provider/real device was used.

On 2026-10-11, the official WeChat client, current server and historical server
documentation URLs returned inaccessible/Site Unavailable in this environment:

- https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/getPhoneNumber.html
- https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/user-info/phone-number/getPhoneNumber.html
- https://developers.weixin.qq.com/miniprogram/dev/api-backend/open-api/phonenumber/phonenumber.getPhoneNumber.html

Tencent's SuperApp tutorial corroborates explicit button authorization and a
five-minute single-use phone code distinct from login code, but it is not treated
as proof of the full WeChat server endpoint contract:
https://intl.cloud.tencent.com/document/product/1219/68263

## Verification

New independent unit and PostgreSQL integration tests cover source-only absence,
old/missing records, existing history, provider absence/removal, legacy mappings
before/after enrollment, repetition and forged native verification. They require
the usual disposable localhost `whaleu_test` fixture. No live provider is used.
At authoring time these tests have not been run; execution is awaiting the shared
validation lease. No real account/device validation has been performed.

## Explicit enrollment configuration

`NATIVE_VERIFICATION_ENROLLMENT=disabled` is the default. Set it to `enabled`
only in a non-production experience environment with migration 0094 applied.
Production rejects this setting. Default Identity behavior remains compatible
with earlier schemas: it does not query the new enrollment table. Enabled mode
fails and rolls back if migration 0094 is absent; it never swallows that failure.
The independent integration test opts in; existing fixtures remain disabled.
