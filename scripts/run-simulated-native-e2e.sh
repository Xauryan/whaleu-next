#!/usr/bin/env bash
# Synthetic WeChat boundary, emitted native Pages, real loopback AppModule/PostgreSQL.
set -euo pipefail
[[ ${NODE_ENV:-} == test && ${WHALEU_TEST_MAINTENANCE:-} == controlled ]] || {
  echo 'Explicit NODE_ENV=test and WHALEU_TEST_MAINTENANCE=controlled required' >&2
  exit 64
}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
npm run build -w @whaleu/wechat
cd apps/api
# Timeout stays inside the cluster wrapper, so normal cleanup also runs on expiry.
bash ../../scripts/run-controlled-test-postgres.sh \
  timeout 1200 node --import tsx --test --test-concurrency=1 \
  test/integration/community-text-review-native-roundtrip.test.ts \
  test/integration/community-feedback.test.ts \
  test/integration/school-configuration-native-roundtrip.test.ts \
  test/integration/school-qr-media.test.ts \
  test/integration/school-qr-native-roundtrip.test.ts \
  test/integration/school-posting-policy.test.ts \
  test/integration/school-posting-policy-native-roundtrip.test.ts \
  test/integration/organization-management.test.ts \
  test/integration/organization-media.test.ts \
  test/integration/organization-media-native-roundtrip.test.ts \
  test/integration/organization-management-native-roundtrip.test.ts \
  test/integration/activity-publication.test.ts \
  test/integration/activity-media.test.ts \
  test/integration/activity-publication-native-roundtrip.test.ts \
  test/integration/activity-read.test.ts \
  test/integration/activity-authority.test.ts \
  test/integration/activity-concurrency.test.ts \
  test/integration/activity-native-roundtrip.test.ts \
  test/integration/announcement-authoring.test.ts \
  test/integration/announcement-authoring-native-roundtrip.test.ts \
  test/integration/announcement-media.test.ts \
  test/integration/announcement-read.test.ts \
  test/integration/announcement-concurrency.test.ts \
  test/integration/announcement-native-roundtrip.test.ts \
  test/integration/student-verification.test.ts \
  test/integration/student-verification-evidence.test.ts \
  test/integration/student-verification-native-roundtrip.test.ts
