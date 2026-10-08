# Limited-title and inactive redemption acceptance

Local verification completed on 2026-10-08 against base
`9e6a049ba626b32638fd59bf202b0d16a0599f35` plus this increment. Hosted CI for the
resulting commit is reported separately. Real campaign activation is not included.

## Frozen gates

All 646 source/test/config/asset files remained unchanged across the final gates.
Fingerprint: `658247ee73c426b73114efab797a48007b129d38639fc1e297c05eac638b4a91`.
The [machine-readable evidence](title-redemption.json) records the full manifest,
hash convention and verification-log hashes. Documentation is excluded so evidence
can be added after testing.

- `npm run check`: lint, strict types, 421 API and 784 native tests, builds and
  fresh emitted native smokes passed
- `npm run format:check`: passed
- `npm run test:integration`: 682 tests passed in 381.674 seconds
- Total: 1,887 passed, zero failures/skips
- PostgreSQL 18.6, launch-only maximum 100 connections, zero application schemas
  remaining, server stopped after the runner

## Supported metadata and operational boundary

The API/SQL/native/public-display allowlists now agree on 17 catalog entries,
including the source-verified nonsecret `redeem_liangchenmeijing` / 良辰美景 limited
title. No administrator title or authority is inferred. Catalog metadata does not
create ownership, restore historical inventory or activate a campaign.

The production provider and attempt budget remain concretely unavailable. No
activation environment flag, default key, real code, code map or production grant
proof is shipped. Actual command/recovery/proof behavior is exercised with
synthetic providers in explicitly guarded disposable database fixtures. Production
SQL rejects that synthetic authority outside its permitted fixture environment.
The native UI truthfully reports unavailable configuration.

## Durable proof, privacy and lifecycle

Focused real AppModule/HTTP/PostgreSQL/native tests passed 18 cases, covering strict
owner authentication, exact input bytes, concurrent/replayed requests, separate
owners, invalid/already-owned receipts, atomic decision/entitlement/receipt proof,
forged/incomplete direct SQL, original undated ownership and unknown balances.
Actual observed lock waits verify session expiry and revocation cannot produce
stale-authority grants. No auto-equip, points, baseline creation or coverage
promotion follows a synthetic redemption.

Raw input is transient. Distinct keyed HMAC domains bind request intent and lookup;
repositories receive no plaintext input or cryptographic key. Synthetic canaries
are checked against SQL parameters, logs, responses and native storage. Recovery
GET remains usable when the provider is unavailable and returns only owned receipt
facts. Existing immutable operations and grant proof branches retain their checks.

Native storage keeps a scoped nonsecret handle, not an input-bearing intent.
Unit and emitted-code tests cover lost responses, GET-first recovery, unavailable
provider, re-entry after hide/restart, coalesced taps, interrupted writes, stale
owner/session responses and no auto-equip. A review caught inventory refresh
replacing an unsaved appearance selection; the final implementation preserves the
draft while updating owned titles, with regression coverage. Physical-device
rendering is not established by these compiled/template tests.

## Remaining gates

Real private provider/key provisioning, guarded production grant authority,
distributed abuse protection and campaign activation remain required before live
redemption. Historical import, complete population reconciliation, administrative
title maintenance, received-interaction policy, real providers/devices and
production processing remain open. No real account grant or production write was
performed.

## Hosted verification

Commit `7be98239da1fedb4866b9177f180828ebdfcffe1` was pushed with a valid
Verified SSH signature. [GitHub CI run 37728000697](https://github.com/Xauryan/whaleu-next/actions/runs/37728000697)
completed successfully: 421 API, 784 native and 682 real PostgreSQL tests, totaling
1,887 with zero failures/skips. Hosted PostgreSQL test duration was 511.519 seconds.
Lint/types/build/emitted smokes and formatting passed for that exact commit.
