# Native student document verification

This increment restores the local student-material application and school-review loop. It does not enable real WeChat/COS providers, import old students, issue student numbers or create the old numeric campus UID. Production evidence adapters remain closed until an explicit private storage, processing and retention configuration is supplied.

## Preserved behavior and explicit new rules

Legacy evidence is fixed at `WhaleUCampus/WhaleU@57cf169c11123acf249909a1a7215b8cb1ec1f8e`: student `student.js` 129–246 and `student.wxml` 109–138; server `Auth.php` 20–141 and 282–459; `AuthApplication.php` 17–30. A campus card or admission notice is one image. A material's visible student number did not mean that legacy verification issued a structured student-number assertion. No real-name, identity-number or document-type field has been added. The native picker accepts one bounded image and the server re-encodes it; users may cover irrelevant details.

- Logged-in active accounts can apply without phone/student-number verification. Ordinary publication retains its own phone requirement.
- Pending and approved applications cannot be duplicated. Rejected attempts can immediately create a new attempt with new evidence; old decisions are immutable. Approved history, including a later revoked affiliation, requires school-admin assistance rather than a new self-service renewal/change-school flow.
- School admins have exactly one fixed current region; a true global super admin must explicitly choose the target. Developer grants and cosmetic roles do not qualify. Self-review is an explicit new minimum safety rule.
- Only an authorized immutable decision issues a complete/accepted document-review affiliation assertion. Submission, Safety image allowance and rejection issue no verified fact. Student-number and phone pointers are preserved. Public `profileId` is the existing account display reference; the old numeric campus UID remains a separate migration/issuance decision.
- Affiliation uses an explicit `policy_exempt` expiry policy to preserve the observed no-expiry behavior, independently of short-lived evidence retention. Missing/unknown old verification coverage is not repaired or relabeled by this workflow.
- Withdrawal, original-key cancellation fencing and evidence expiration are new recovery/retention infrastructure. Withdrawal wins atomically against review and never revokes an already-issued affiliation.

## Authority and lifecycle

Campus owns the transactional resolver from campus UUID to internal institution UUID and current operating region. The public Campus DTO's five-digit school code is never written into Verification. A conservative catalog fingerprint freezes the source campus mapping and labels; changed mappings/catalog rows fail closed, and owners can cancel the old draft/pending application before starting again.

Each accepted evidence item stores an immutable policy reference, expiry and cleanup choice. New configuration cannot extend an old item's lifetime. Terminal decisions immediately remove reviewer material access. Owner access remains private until expiry. An observed pending expiry becomes `expired`, releases the pending slot, and requires a fresh application/image. Actual provider deletion follows existing quiet-cleanup obligations; no new implicit production hard-delete schedule is activated.

The closed upload and display descriptors contain no raw URL, bucket, object locator or signed URL. Inline download is authenticated, static re-encoded, private/no-store and rejects Range. Owner/grant/campus/account/session/Safety proofs are repeated after external storage opens and finalized before bytes are released. Native pages clear their inline files and transient facts on hide, logout, account or revision change. Local journals contain operation IDs and opaque request identity hashes only, never images, file hashes, paths, reasons or student data.

Phone authorization now compares the claimed immutable phone pointer with the current pointer under the latest head lock. It retains all original actor/session/app/claim/provider/expiry guards, allows only independently changed affiliation/application facts, and preserves the latest snapshot's other pointers. Nonzero heads require their exact snapshot; an original zero head still supports phone-only verification without inventing affiliation or application coverage.

## API and native paths

- `/v1/me/student-verification`: current application; `/applications` reserves a draft; `/:id/submit` freezes one accepted image; `/:id/withdraw` closes an open attempt.
- Original actor request recovery and cancellation are under `/requests/:requestId`.
- `/v1/student-verification-review/capabilities` and `/regions/:regionId/applications`: current scoped queue/detail/decision. Reject requires a trimmed nonempty reason of at most 200 characters.
- `/v3/media/verification-evidence`: dedicated protocol 13 upload/recovery/private descriptor and inline bytes.
- Local `student_auth` and `auth_result` notices are atomic with source transitions. Recipient discovery has a complete bounded candidate-set proof, a 32-account/64-grant limit and an overflow sentinel. Explicitly blocked/restricted or ineligible candidates are skipped with retained negative facts; unknown authority rolls back. Historical recipient provenance never grants current access. No external WeChat/official-account send is activated.
- Native pages `student-verification`, `student-verification-review` and `student-verification-notices` are linked from the existing verification page. From an approval, the existing phone-binding and identity-campus pages lead into ordinary compose/Review/publication.

## Acceptance boundary

Tests use emitted App/Page/WXML, real HTTP/AppModule/PostgreSQL, actual identity and phone adapters with synthetic external transport, real private multipart/static image processing, actual grants/decisions/ledger, and the ordinary exact-text Review/publication path. This is simulated native acceptance, not WeChat DevTools/device or production acceptance. Exact frozen-tree commands/results are recorded separately at delivery; intermediate failures and partial passes are not a full-project or hosted pass.
