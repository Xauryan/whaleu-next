import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { ArgumentsHost } from '@nestjs/common';
import { loadConfig } from '../src/config/config.js';
import type { RuntimeConfig } from '../src/config/config.js';
import {
  ApplicationError,
  applicationErrorCondition,
  MediaRequestRateLimited,
  TitleMaintenanceContinuationConflict,
} from '../src/http/application-error.js';
import { SafeExceptionFilter } from '../src/http/http.js';
import { safeErrorResponseSchema } from '../src/http/error-contracts.js';
import { createLogger } from '../src/observability/logger.js';
import type { AppLogger } from '../src/observability/logger.js';
import {
  assertHistoricalConfigProjection,
  historicalConfigEnvironment,
  restoreAcceptedHistoricalConfig,
} from './support/historical-lifecycle-identity/config-compatibility.js';
import {
  acceptedHistoricalErrorConditions,
  addedHistoricalErrorConditions,
  restoreAcceptedHistoricalErrors,
} from './support/historical-lifecycle-identity/application-error-compatibility.js';

const code = (value: string) => (error: unknown) =>
  error instanceof ApplicationError && error.code === value;

test('all accepted error conditions and specialized error behavior remain unchanged', async () => {
  const bytes = await readFile(
    new URL('../src/http/application-error.ts', import.meta.url),
  );
  for (const {
    code: errorCode,
    status,
    message,
  } of acceptedHistoricalErrorConditions(bytes)) {
    assert.deepEqual(
      applicationErrorCondition(errorCode),
      { status, message },
      errorCode,
    );
    const error = new ApplicationError(errorCode);
    assert.equal(error instanceof Error, true, errorCode);
    assert.equal(error.code, errorCode);
    assert.equal(error.name, 'ApplicationError');
    assert.equal(error.message, message, errorCode);
    assert.equal(error.getStatus(), status, errorCode);
    assert.equal(error.getResponse(), message, errorCode);
    assert.equal(error.cause, undefined, errorCode);
    assert.equal(error.toString(), `ApplicationError: ${message}`, errorCode);
  }
  for (const seconds of [1, 2, 86400]) {
    const error = new MediaRequestRateLimited(seconds);
    assert.equal(error instanceof ApplicationError, true);
    assert.equal(error.code, 'MEDIA_RATE_LIMITED');
    assert.equal(error.retryAfterSeconds, seconds);
    assert.equal(
      error.getStatus(),
      applicationErrorCondition('MEDIA_RATE_LIMITED').status,
    );
    assert.equal(
      error.getResponse(),
      applicationErrorCondition('MEDIA_RATE_LIMITED').message,
    );
  }
  for (const seconds of [
    -1,
    0,
    1.5,
    86401,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(
      () => new MediaRequestRateLimited(seconds),
      code('MEDIA_UNAVAILABLE'),
    );
  }
  const successor = '10000000-0000-4000-8000-000000000001';
  const continuation = new TitleMaintenanceContinuationConflict(successor);
  assert.equal(continuation instanceof ApplicationError, true);
  assert.equal(
    continuation.code,
    'EXPERIENCE_MAINTENANCE_CONTINUATION_CONFLICT',
  );
  assert.equal(continuation.successorRequestId, successor);
  assert.equal(
    continuation.getStatus(),
    applicationErrorCondition(continuation.code).status,
  );
  assert.equal(
    continuation.getResponse(),
    applicationErrorCondition(continuation.code).message,
  );
  for (const invalid of [
    '',
    'not-a-uuid',
    successor.toUpperCase().replace('10000000', 'A0000000'),
    successor.replace('-4000-', '-1000-'),
    successor.replace('-8000-', '-7000-'),
  ]) {
    assert.throws(
      () => new TitleMaintenanceContinuationConflict(invalid),
      code('EXPERIENCE_MAINTENANCE_UNAVAILABLE'),
    );
  }
});
test('exact error proof rejects any extra, duplicate, or edited source bytes', async () => {
  const bytes = await readFile(
    new URL('../src/http/application-error.ts', import.meta.url),
  );
  const current = bytes.toString('utf8');
  assert.throws(() =>
    restoreAcceptedHistoricalErrors(Buffer.from(current + '\n')),
  );
  assert.throws(() =>
    restoreAcceptedHistoricalErrors(
      Buffer.from(
        current.replace(
          '  REAL_DELETION_UNAVAILABLE:',
          '  REAL_DELETION_UNAVAILABLE: {} as never,\n  REAL_DELETION_UNAVAILABLE:',
        ),
      ),
    ),
  );
  assert.throws(() =>
    restoreAcceptedHistoricalErrors(
      Buffer.from(
        current.replace(
          'Account deletion is unavailable.',
          'Changed account deletion message.',
        ),
      ),
    ),
  );
  assert.throws(() =>
    restoreAcceptedHistoricalErrors(
      Buffer.from(
        current.replace(
          'Content reference is unavailable.',
          'Changed old reference message.',
        ),
      ),
    ),
  );
});
test('reviewed config additions preserve the historical enrollment and old-input projection', () => {
  // These old-contract inputs omit the new preparation-entry name. Equivalence is not
  // claimed for arbitrary environments: those formerly unknown names now validate.
  for (const NODE_ENV of ['development', 'test']) {
    for (const enrollment of [undefined, 'disabled', 'enabled']) {
      const input = Object.freeze({
        ...historicalConfigEnvironment,
        NODE_ENV,
        ...(enrollment === undefined
          ? {}
          : { NATIVE_VERIFICATION_ENROLLMENT: enrollment }),
      });
      const before = { ...input };
      const current = loadConfig(input);
      assertHistoricalConfigProjection(current, {
        NODE_ENV,
        NATIVE_VERIFICATION_ENROLLMENT: enrollment ?? 'disabled',
      });
      assert.equal(current.REAL_ACCOUNT_DELETION_ENTRY, 'disabled');
      assert.deepEqual(input, before);
      assert.deepEqual(
        loadConfig({ ...input, HISTORICAL_UNRELATED_INPUT: 'ignored' }),
        current,
      );
    }
  }
  assertHistoricalConfigProjection(
    loadConfig({
      ...historicalConfigEnvironment,
      PORT: '4242',
      PG_POOL_MAX: '3',
      NATIVE_VERIFICATION_ENROLLMENT: 'enabled',
    }),
    { PORT: 4242, PG_POOL_MAX: 3, NATIVE_VERIFICATION_ENROLLMENT: 'enabled' },
  );
  for (const enrollment of [undefined, 'disabled']) {
    assertHistoricalConfigProjection(
      loadConfig({
        ...historicalConfigEnvironment,
        NODE_ENV: 'production',
        PG_SSL_MODE: 'verify-full',
        ...(enrollment === undefined
          ? {}
          : { NATIVE_VERIFICATION_ENROLLMENT: enrollment }),
      }),
      { NODE_ENV: 'production', PG_SSL_MODE: 'verify-full' },
    );
  }
  assert.throws(
    () =>
      loadConfig({
        ...historicalConfigEnvironment,
        NODE_ENV: 'production',
        PG_SSL_MODE: 'verify-full',
        NATIVE_VERIFICATION_ENROLLMENT: 'enabled',
      }),
    /^Error: Native verification enrollment is limited to non-production experience environments$/,
  );
  assert.throws(
    () =>
      loadConfig({
        ...historicalConfigEnvironment,
        NATIVE_VERIFICATION_ENROLLMENT: 'unreviewed-value',
      }),
    /^Error: Invalid configuration fields: NATIVE_VERIFICATION_ENROLLMENT$/,
  );
});
test('config provenance proof rejects extra, duplicate, or changed source bytes', async () => {
  const current = await readFile(
    new URL('../src/config/config.ts', import.meta.url),
    'utf8',
  );
  for (const changed of [
    current + '\n// additional unreviewed change\n',
    current.replace(
      '  REAL_ACCOUNT_DELETION_ENTRY: z\n',
      '  REAL_ACCOUNT_DELETION_ENTRY: z\n  REAL_ACCOUNT_DELETION_ENTRY: z\n',
    ),
    current.replace(
      'NATIVE_VERIFICATION_ENROLLMENT: z',
      'NATIVE_VERIFICATION_ENROLLMENT_CHANGED: z',
    ),
  ]) {
    assert.notEqual(changed, current);
    assert.throws(() => restoreAcceptedHistoricalConfig(Buffer.from(changed)));
  }
});

test('only disabled and prepare_only are admitted; neither enables other historical defaults', () => {
  for (const mode of [undefined, 'disabled', 'prepare_only']) {
    const config = loadConfig({
      ...historicalConfigEnvironment,
      ...(mode === undefined ? {} : { REAL_ACCOUNT_DELETION_ENTRY: mode }),
    });
    assertHistoricalConfigProjection(config);
    assert.equal(config.REAL_ACCOUNT_DELETION_ENTRY, mode ?? 'disabled');
    for (const key of [
      'WECHAT_APP_ID',
      'WECHAT_APP_SECRET',
      'AUTH_RATE_LIMIT_KEY',
      'IDENTITY_DELETION_DIGEST_KEYRING',
      'REAL_ACCOUNT_DELETION_NEW_REQUESTS',
    ])
      assert.equal(key in config, false, key);
  }
  for (const invalid of [
    '',
    'enabled',
    'qualified_owner',
    'accept',
    'cancel',
    'automatic',
    'erase',
  ])
    assert.throws(
      () =>
        loadConfig({
          ...historicalConfigEnvironment,
          REAL_ACCOUNT_DELETION_ENTRY: invalid,
        }),
      /^Error: Invalid configuration fields: REAL_ACCOUNT_DELETION_ENTRY$/,
    );
});

test('old-input semantic oracle rejects changed historical defaults, not just changed source hashes', () => {
  const config = loadConfig(historicalConfigEnvironment);
  for (const patch of [
    { NATIVE_VERIFICATION_ENROLLMENT: 'enabled' },
    { WECHAT_PHONE_BINDING: 'enabled' },
    { COMMUNITY_TEXT_REVIEW: 'source_manual' },
    { IDENTITY_REGISTRATION_GUARD: 'required' },
    { COMMUNITY_READING_FORMATTING_PROCESSING: 'automatic' },
    { UNREVIEWED_HISTORICAL_DEFAULT: true },
  ])
    assert.throws(() =>
      assertHistoricalConfigProjection(
        Object.freeze({ ...config, ...patch }) as RuntimeConfig,
      ),
    );
});

const scope = {
  COMMUNITY_TEXT_REVIEW_SPACE_ID: '11111111-1111-4111-8111-111111111111',
  COMMUNITY_TEXT_REVIEW_REGION_ID: '22222222-2222-4222-8222-222222222222',
  COMMUNITY_TEXT_REVIEW_OPERATOR: 'manual:synthetic-reviewer',
};
const policy = '33333333-3333-4333-8333-333333333333';
test('preparation entry preserves explicit source/manual review validation and rejection branches', () => {
  for (const REAL_ACCOUNT_DELETION_ENTRY of ['disabled', 'prepare_only']) {
    for (const COMMUNITY_TEXT_REVIEW of ['local_manual', 'source_manual']) {
      const fields = {
        ...scope,
        COMMUNITY_TEXT_REVIEW,
        ...(COMMUNITY_TEXT_REVIEW === 'local_manual'
          ? { COMMUNITY_TEXT_REVIEW_POLICY_ID: policy }
          : { COMMUNITY_TEXT_SOURCE_REVIEW_POLICY_ID: policy }),
      };
      const input = {
        ...historicalConfigEnvironment,
        ...fields,
        REAL_ACCOUNT_DELETION_ENTRY,
      };
      assertHistoricalConfigProjection(loadConfig(input), fields);
      for (const key of Object.keys(fields).filter(
        (key) => key !== 'COMMUNITY_TEXT_REVIEW',
      ))
        assert.throws(
          () => loadConfig({ ...input, [key]: undefined }),
          /(?:Local text|Source manual) review/,
        );
      const production = {
        ...input,
        NODE_ENV: 'production',
        PG_SSL_MODE: 'verify-full',
      };
      if (COMMUNITY_TEXT_REVIEW === 'local_manual')
        assert.throws(() => loadConfig(production), /Local text review/);
      else {
        assertHistoricalConfigProjection(loadConfig(production), {
          ...fields,
          NODE_ENV: 'production',
          PG_SSL_MODE: 'verify-full',
        });
        for (const key of [
          'COMMUNITY_TEXT_REVIEW_POLICY_ID',
          'COMMUNITY_RELATED_REVIEW_POLICY_ID',
          'COMMUNITY_FEEDBACK_SPACE_ID',
        ])
          assert.throws(
            () => loadConfig({ ...production, [key]: policy }),
            /(?:Source manual|Related) review/,
          );
        assert.throws(
          () =>
            loadConfig({ ...production, COMMUNITY_TEXT_REVIEW: 'disabled' }),
          /Source review/,
        );
      }
    }
  }
});

test('preparation entry preserves required registration guard and sanitized digest-key parsing', () => {
  const ring = JSON.stringify({
    version: 1,
    activeEpoch: 'synthetic',
    keys: [{ epoch: 'synthetic', keyHex: '11'.repeat(32) }],
  });
  for (const REAL_ACCOUNT_DELETION_ENTRY of ['disabled', 'prepare_only']) {
    const input = {
      ...historicalConfigEnvironment,
      REAL_ACCOUNT_DELETION_ENTRY,
    };
    assert.throws(
      () => loadConfig({ ...input, IDENTITY_REGISTRATION_GUARD: 'disabled' }),
      /^Error: Invalid configuration fields: IDENTITY_REGISTRATION_GUARD$/,
    );
    assert.throws(
      () => loadConfig({ ...input, IDENTITY_REGISTRATION_GUARD: 'required' }),
      /^Error: Required registration guard needs IDENTITY_DELETION_DIGEST_KEYRING$/,
    );
    for (const IDENTITY_REGISTRATION_GUARD of ['automatic', 'required']) {
      const fields = {
        IDENTITY_REGISTRATION_GUARD,
        IDENTITY_DELETION_DIGEST_KEYRING: ring,
      };
      assertHistoricalConfigProjection(
        loadConfig({ ...input, ...fields }),
        fields,
      );
      for (const invalid of [
        'synthetic-secret-invalid',
        JSON.stringify({ version: 1, activeEpoch: 'missing', keys: [] }),
      ])
        assert.throws(
          () =>
            loadConfig({
              ...input,
              ...fields,
              IDENTITY_DELETION_DIGEST_KEYRING: invalid,
            }),
          /^Error: Invalid configuration field: IDENTITY_DELETION_DIGEST_KEYRING$/,
        );
    }
  }
});

test('source successor rejects an altered old default or registration guard condition', async () => {
  const source = await readFile(
    new URL('../src/config/config.ts', import.meta.url),
    'utf8',
  );
  for (const changed of [
    source.replace(".default('automatic'),", ".default('required'),"),
    source.replace(
      "config.IDENTITY_REGISTRATION_GUARD === 'required'",
      "config.IDENTITY_REGISTRATION_GUARD === 'automatic'",
    ),
    source.replace(".default('disabled'),", ".default('enabled'),"),
    source.replace(
      ".enum(['disabled', 'prepare_only'])",
      ".enum(['disabled', 'prepare_only', 'accept'])",
    ),
  ]) {
    assert.notEqual(changed, source);
    assert.throws(() => restoreAcceptedHistoricalConfig(Buffer.from(changed)));
  }
});

test('all three additive deletion errors have exact sanitized envelopes and logs', () => {
  const requestId = '11111111-1111-4111-8111-111111111111';
  for (const {
    code: errorCode,
    status,
    message,
  } of addedHistoricalErrorConditions) {
    assert.deepEqual(applicationErrorCondition(errorCode), { status, message });
    const error = Object.assign(new ApplicationError(errorCode), {
      recoverySecret: 'private-recovery-secret',
      accountId: 'private-account',
      intentId: 'private-intent',
      successorRequestId: 'private-successor',
      cause: new Error('private-database-credential'),
    });
    assert.equal(error.getStatus(), status);
    assert.equal(error.getResponse(), message);
    const logs: unknown[] = [];
    const logger = {
      structured: { error: (entry: unknown) => logs.push(entry) },
    } as unknown as AppLogger;
    let body: unknown;
    const response = {
      headersSent: false,
      getHeader: () => requestId,
      setHeader: (key: string, value: string) => {
        assert.equal(key, 'x-request-id');
        assert.equal(value, requestId);
      },
      status: (value: number) => {
        assert.equal(value, status);
        return response;
      },
      json: (value: unknown) => {
        body = value;
      },
    };
    const host = {
      switchToHttp: () => ({ getResponse: () => response }),
    } as unknown as ArgumentsHost;
    new SafeExceptionFilter(logger).catch(error, host);
    const expected = { error: { code: errorCode, message, requestId } };
    assert.deepEqual(body, expected);
    assert.deepEqual(safeErrorResponseSchema.parse(body), expected);
    assert.deepEqual(
      logs,
      status >= 500 ? [{ event: 'http_error', status, requestId }] : [],
    );
    assert.equal(JSON.stringify({ body, logs }).includes('private-'), false);
  }
});

test('preparation logger adds only four recovery-field redactions and preserves existing behavior', async () => {
  const source = await readFile(
    new URL('../src/observability/logger.ts', import.meta.url),
    'utf8',
  );
  const addition =
    "        'recoverySecret',\n        'replacementSecret',\n        '*.recoverySecret',\n        '*.replacementSecret',\n";
  const anchor = '      paths: [\n';
  const position = source.indexOf(addition);
  assert.notEqual(position, -1);
  assert.equal(source.indexOf(addition, position + 1), -1);
  assert.equal(position, source.indexOf(anchor) + anchor.length);
  const restored =
    source.slice(0, position) + source.slice(position + addition.length);
  assert.equal(
    createHash('sha256').update(restored).digest('hex'),
    '8d17a1817a463929e7b6188cb0e676c9a5e1be54373c049fe633c9f3b07c76f1',
  );
  const lines: string[] = [];
  const logger = createLogger('info', {
    write: (line: string) => {
      lines.push(line);
    },
  });
  logger.info({
    event: 'synthetic_redaction',
    recoverySecret: 'private-recovery',
    replacementSecret: 'private-replacement',
    accessToken: 'private-access',
    nested: {
      recoverySecret: 'private-nested-recovery',
      replacementSecret: 'private-nested-replacement',
    },
  });
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(entry['event'], 'synthetic_redaction');
  for (const key of ['recoverySecret', 'replacementSecret', 'accessToken'])
    assert.equal(entry[key], '[REDACTED]');
  assert.deepEqual(entry['nested'], {
    recoverySecret: '[REDACTED]',
    replacementSecret: '[REDACTED]',
  });
  assert.equal(lines[0]!.includes('private-'), false);
});

test('content-definition runtime closure records only the explicit preparation successors', async () => {
  const bytes = await readFile(
    new URL(
      './support/historical-content-definition/preparation-runtime-successor.json',
      import.meta.url,
    ),
  );
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    '115162792b6f5cd348589aadea6e839bfc450f4f49dd2a7fd67f960dcc878ec8',
  );
  const review = JSON.parse(bytes.toString('utf8')) as {
    baseTree: string;
    entry: string;
    originalImportProvenanceSha256: string;
    packageLockSha256: string;
    changed: string[];
    files: {
      path: string;
      baseSha256: string;
      sha256: string;
      imports: string[];
    }[];
  };
  assert.equal(review.baseTree, '62546a2f94ca41033b30d3beb87cfe9a95538586');
  assert.equal(review.files.length, 39);
  assert.deepEqual(review.changed, [
    'apps/api/src/config/config.ts',
    'apps/api/src/http/application-error.ts',
    'apps/api/src/observability/logger.ts',
  ]);
  const root = new URL('../../../', import.meta.url);
  for (const [path, expected] of [
    [
      'apps/api/test/support/historical-content-definition/import-provenance.tsv',
      review.originalImportProvenanceSha256,
    ],
    ['package-lock.json', review.packageLockSha256],
  ])
    assert.equal(
      createHash('sha256')
        .update(await readFile(new URL(path!, root)))
        .digest('hex'),
      expected,
    );
  assert.equal(
    new Set(review.files.map((entry) => entry.path)).size,
    review.files.length,
  );
  const byPath = new Map(review.files.map((entry) => [entry.path, entry]));
  const reached = new Set<string>();
  const visit = (path: string): void => {
    if (reached.has(path)) return;
    const entry = byPath.get(path);
    assert.ok(entry, `Unreviewed runtime import ${path}`);
    reached.add(path);
    entry.imports.forEach(visit);
  };
  visit(review.entry);
  assert.equal(reached.size, review.files.length);
  assert.equal(
    [...reached].some((path) => path.includes('/account-deletion/real/')),
    false,
  );
  for (const entry of review.files) {
    const live = await readFile(new URL(entry.path, root));
    assert.equal(
      createHash('sha256').update(live).digest('hex'),
      entry.sha256,
      entry.path,
    );
    if (entry.path === 'apps/api/src/config/config.ts')
      assert.equal(
        createHash('sha256')
          .update(restoreAcceptedHistoricalConfig(live))
          .digest('hex'),
        entry.baseSha256,
      );
    else if (entry.path === 'apps/api/src/http/application-error.ts')
      assert.equal(
        createHash('sha256')
          .update(restoreAcceptedHistoricalErrors(live))
          .digest('hex'),
        entry.baseSha256,
      );
    else if (entry.path !== 'apps/api/src/observability/logger.ts')
      assert.equal(entry.sha256, entry.baseSha256, entry.path);
  }
});
