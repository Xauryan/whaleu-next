# Campus tools owner

This owner serves only current trusted campus catalogs. No historical map,
shuttle image, installation resource, or legacy URL is admitted by migrations.
Production source authority, Media storage/processing, locate capability and
webview navigation attestation are disabled by default.

## Bounded source entrypoint

Run `npm run campus-tools -w @whaleu/api -- validate manifest.json` for offline
validation. Input is UTF-8 `campus-tools-canonical-v1` JSON with sorted object
keys, NFC text, finite JSON coordinates, explicit nulls, exact accepted array
order and at most one terminal newline. Obtain canonical encoding from
`sealToolCatalog(input).canonical`. Noncanonical JSON, including duplicate keys,
escaped aliases and arbitrary input fields, is rejected. Validation returns only
scope, digest, counts and quarantine reasons; `candidate` does not mean trusted.

`apply manifest.json REQUEST_UUID` uses `runCampusToolsCli` and
`CampusToolsAdmission`. The standalone runner refuses apply because no trusted
production adapter exists. A configured operational host must pass a database
and configuration-owned `CampusToolsRuntime`. The synthetic integration fixture
uses the same runner/service against its disposable database, an exact-digest
registered authority, real synthetic Sharp decoding, and immutable measured
storage. No manifest `accepted`, publisher role or environment flag creates
source authority.

The authority authenticates the complete canonical digest, exact campus,
expected head, source/policy references, applicability, complete coverage,
validity, link-policy revision and every measured Media binding. Immutable
admission cause/receipt/catalog relations and head CAS are one transaction.
Replacement and withdrawal use another complete admission with `expectedHead`.
Same-key/same-digest replay returns its prior receipt; changed digest conflicts.

Trusted staging inputs are outside the public manifest. Immutable private attempt
records bind the exact accepted source and both destinations before any provider
effect. Immutable result records bind measured output; final owner bindings must
reference those reconciled results. Retries adopt only the same planned objects.
The owner invokes the
existing bounded processor contract and `sealProcessedManifest`, writes measured
immutable variants, and binds their exact manifest digest. Provider effects run
outside SQL locks. A failed admission may leave only trusted immutable staging
objects; it cannot publish part of a catalog. Operator-managed staging retention
is required before real activation.

## Read and action boundaries

All five public routes are guest-capable browse intent and no-store. Supplied
credentials are never discarded. The owner retains original Campus/head/source/
Media facts before dependent waits and registers bounded final nonblocking proof
plus exact PostgreSQL deadlines before managed transaction commit.

Dedicated campus-tools Media references cannot read another owner's assets.
Descriptor and bytes have independent current authorization; exact delivery
checks again after opening immutable storage. Native preview is local, in-page
and lifecycle-owned. No raw source/storage URL is public.

Copy and webview are separate exact HTTPS host/path/query policies. The narrow
canonical ASCII subset forbids percent encoding entirely, userinfo, ports,
fragments, IPs, IDNs, path traversal and redirect parameters. Server URL parsing
must preserve the exact input. No remote fetching or redirects are followed.
Real webview activation additionally requires trusted enforceable platform/
controlled-destination attestation and physical-device evidence. Synthetic ports
cannot prove platform navigation containment or location permissions.
