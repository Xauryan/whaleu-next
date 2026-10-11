# Private student evidence

The owner is `verification`, resource `student_evidence`, audience `verification-private`, protocol `verification-evidence-media-v1` (storage protocol 13). Neither uploads nor reads borrow a public media owner. Application submission accepts only the closed upload descriptor `{protocol, kind: 'verification-evidence-upload', assetId}`.

## Integration

Register `verificationEvidenceControllers` and `verificationEvidenceProviders` in the Verification module, provide `VERIFICATION_EVIDENCE_ACCESS` using the real student access service, and import the shared Media delivery-budget module. The runtime token defaults to `null`: no provider, upload, read, or retention policy is implicitly enabled. Tests explicitly inject synthetic immutable storage, ingress, isolated static re-encoding and fixture Review.

Runtime retention requires an explicit policy reference, finite positive TTL (up to 365 days), and cleanup decision. These values are copied into immutable scopes; binding and application records preserve exact PostgreSQL expiry timestamps. Updating runtime policy never extends earlier evidence. Affiliation expiry/exemption is separate.

- `acceptAndBind(actor, applicationId, expectedRevision, uploadDescriptor, tx)` checks current exact Media/Safety, binds once, and returns internal IDs, manifest, expiry and policy. The caller atomically writes the pending application and its immutable `evidence_revision`; only after all owner writes does it enroll its final owner proof.
- `evidenceCurrent(application, tx)` returns the same internal facts plus an opaque display descriptor for current material. Callers retain the owner authorization/proof in the same transaction.
- `descriptorForApplication(application, tx)` returns the display descriptor or null for missing, expired or detached evidence. Infrastructure/current-Safety uncertainty fails closed.
- `retireEvidence(applicationId, bindingId, tx)` enrolls quiet cleanup only after immutable material expiry and only if that material's recorded policy enables cleanup. It never deletes bytes directly. Terminal reviewer access is closed by the real owner immediately, even before expiry.
- `retireEvidenceBatch([{applicationId, bindingId}], tx)` performs the same checks for at most 50 distinct bindings, completes all retirements, then captures one final Media epoch. Transactional owner sweeps use one batch after their owner writes; repeated single-item calls in one transaction would invalidate earlier epoch facts. An empty batch is a no-op.
- `cleanupExpired(limit)` performs a bounded pass of at most 50 expired bindings; a scheduler/maintenance caller can repeat. Existing quiet cleanup workers own actual deletion and retry evidence.

Authenticated routes live under `/v3/media/verification-evidence`. Read routes include application, immutable evidence revision and binding. Reviewer requests must include the real `reviewRegionId`; the region parameter alone grants no authority. Downloads are inline static re-encoded bytes with private/no-store, no ranges, redirects or locators. The existing exact-byte engine reauthorizes after storage open and before any source read; mandatory owner/Media proofs and deadlines are finalized before the stream is released.

Upload recovery/cancellation needs the authenticated original account and original request key/hash, not current campus or reviewer authority. Native recovery journals persist only original operation identities, never declarations, source-file hashes, bytes, local paths, names, student numbers or bearer tokens. Native pages must clear/dispose readers on hide/unload; all views also revoke on account/session change and after 30 seconds.

## Test boundaries

`verification-evidence-media.test.ts` covers exact contract/namespace rejection, policy validation, transaction-local owner proofs and post-open final-proof/expiry byte gating. The latter injects plan changes and is not a replacement for real database owner-race tests. Existing Media delivery/processing tests exercise actual static decode/re-encode, EXIF stripping, image limits and finite transport mechanics.

`test/support/student-evidence-fixture.ts` exposes real native login, HTTP multipart and worker transitions for disposable PostgreSQL integration. The real WeChat identity and phone adapters receive a route-restricted synthetic fetch; storage transport and Review use synthetic external ports. It does not mock account, campus, grants, owner authorization, application state or ledger.

`test/integration/student-verification-evidence.test.ts` covers real owner/reviewer private bytes and range rejection, then pauses storage open while grants, session expiry, account state, Media Safety or campus state change. Every rejected read consumes zero source bytes. Its retention scenario checks exact immutable timestamps, refusal to extend existing evidence with new configuration, post-open material expiry, pending-to-expired application transition, reapplication, and quiet cleanup. The cleanup assertion identifies each held original/derived/variant object independently: an already-retired ingress scratch object may be deleted without shortening their two-minute quiet hold. Final provider deletion/retries remain covered by the shared Media cleanup suites.

WeChat `verification-evidence.test.ts` covers strict codecs, original-key hashes, non-sensitive recovery journal, twenty old-scope closure, not-recorded cancellation fencing, ready-request restoration and late account-switch results. No real WeChat, storage provider or model is invoked.
