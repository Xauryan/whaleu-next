import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { activeNativeComponentTags } from './native-template-component-coverage';

type MigrationStatus =
  'migration-needed' | 'not-applicable' | 'implemented' | 'verified';
interface AcceptanceEvidence {
  layer: string;
  artifact: string;
  sourceRevision: string;
  command: string;
  observedAt: string;
  result: string;
}
interface CoverageRoute {
  route: string;
  title: string;
  family: string;
  migration: {
    status: MigrationStatus;
    inProgress: boolean;
    reason: string;
    componentsUsed: string[];
    remainingDirectNativeControls: string[];
    exceptions: string[];
  };
  sourceFiles: string[];
  requiredBusinessFlow: string;
  flowEvidence: {
    status: string;
    scope: string;
    pageTests: string[];
  };
  requiredGateIds: string[];
  verification: {
    status: string;
    evidence: AcceptanceEvidence[];
  };
}
interface Coverage {
  schemaVersion: number;
  sourceOfTruth: string;
  expectedRouteCount: number;
  protectedLayoutRoutes: string[];
  evidencePolicy: {
    testReferencesAreExecutionResults: boolean;
    relatedFamilyTestsAreExhaustiveRouteCoverage: boolean;
    htmlPreviewIsNativeDeviceProof: boolean;
    mockIsPostgresProof: boolean;
    postgresIsRealProviderProof: boolean;
    verifiedRequiredLayers: string[];
    postgresLayerWhenRequired: string;
    verificationEvidenceRequiredFields: string[];
  };
  componentCatalog: {
    name: string;
    status: string;
    sourceFiles: string[];
    tests: string[];
    limits: string;
  }[];
  gates: Record<string, { status: string; requirement: string }>;
  flowFamilies: Record<
    string,
    {
      nativeTests: string[];
      postgresTests: string[];
      testEvidenceStatus: string;
      coverageScope: string;
      requiredGateIds: string[];
    }
  >;
  postgresTestCatalog: Record<
    string,
    {
      layer: string;
      status: string;
      scope: string;
      supportFiles: string[];
      executionEvidence: AcceptanceEvidence[];
    }
  >;
  boundedEmittedSmokes: {
    file: string;
    layer: string;
    routes: string[];
    status: string;
    scope: string;
  }[];
  observedRunReferences: {
    artifact: string;
    familyIds: string[];
    testFiles: string[];
    scope: string;
  }[];
  routes: CoverageRoute[];
}

const repository = path.resolve(__dirname, '../../..');
const nativeRoot = path.join(repository, 'apps/wechat');
const read = (relative: string) =>
  readFileSync(path.join(repository, relative), 'utf8');
const inventory = JSON.parse(
  read('apps/wechat/docs/native-component-flow-coverage.json'),
) as Coverage;
const registered = (
  JSON.parse(read('apps/wechat/src/app.json')) as { pages: string[] }
).pages;
const protectedRoutes = ['community-feed', 'inbox', 'me'].map(
  (name) => `pages/${name}/${name}`,
);
const statuses: MigrationStatus[] = [
  'migration-needed',
  'not-applicable',
  'implemented',
  'verified',
];
const postgresLayers = [
  'api-postgresql',
  'native-client-postgresql',
  'emitted-page-postgresql',
  'mixed-native-client-and-emitted-source-postgresql',
];
const unique = (values: string[], label: string) =>
  assert.equal(new Set(values).size, values.length, `${label}: duplicates`);
const text = (value: string, label: string) =>
  assert.ok(
    typeof value === 'string' && value.trim().length > 0,
    `${label}: missing description`,
  );
function localFile(relative: string) {
  text(relative, 'file');
  assert.ok(
    !path.isAbsolute(relative) &&
      !relative.split('/').includes('..') &&
      /^(apps|docs|scripts)\//.test(relative),
    `unsafe or unscoped evidence path: ${relative}`,
  );
  assert.ok(existsSync(path.join(repository, relative)), relative);
}

function validateInventory(value: Coverage) {
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.sourceOfTruth, 'apps/wechat/src/app.json');
  assert.equal(value.expectedRouteCount, 120);
  assert.equal(
    registered.length,
    120,
    '117 original routes plus three private manual timetable routes',
  );
  assert.equal(value.routes.length, 120, 'exactly 120 route rows required');
  unique(registered, 'registered routes');
  unique(
    value.routes.map((row) => row.route),
    'inventory routes',
  );
  assert.deepEqual(
    value.routes.map((row) => row.route),
    registered,
    'no missing, extra, substituted or reordered route rows',
  );
  assert.deepEqual(value.protectedLayoutRoutes, protectedRoutes);

  const policy = value.evidencePolicy;
  for (const key of [
    'testReferencesAreExecutionResults',
    'relatedFamilyTestsAreExhaustiveRouteCoverage',
    'htmlPreviewIsNativeDeviceProof',
    'mockIsPostgresProof',
    'postgresIsRealProviderProof',
  ] as const)
    assert.equal(policy[key], false, `${key} must remain false`);
  assert.deepEqual(policy.verifiedRequiredLayers, [
    'native-unit',
    'package',
    'native-device',
  ]);
  assert.equal(policy.postgresLayerWhenRequired, 'emitted-page-postgresql');
  assert.deepEqual(policy.verificationEvidenceRequiredFields, [
    'layer',
    'artifact',
    'sourceRevision',
    'command',
    'observedAt',
    'result',
  ]);

  const componentNames = value.componentCatalog.map((item) => item.name);
  unique(componentNames, 'component catalog');
  for (const component of value.componentCatalog) {
    assert.equal(component.status, 'implemented');
    assert.ok(component.sourceFiles.length >= 4);
    assert.ok(component.tests.length > 0);
    text(component.limits, component.name);
    for (const file of [...component.sourceFiles, ...component.tests])
      localFile(file);
  }
  const referencedPostgres = new Set<string>();
  for (const [name, family] of Object.entries(value.flowFamilies)) {
    assert.equal(family.testEvidenceStatus, 'implemented', name);
    text(family.coverageScope, name);
    assert.ok(
      family.nativeTests.length > 0,
      `${name}: native evidence missing`,
    );
    unique(family.nativeTests, name);
    unique(family.postgresTests, name);
    for (const file of [...family.nativeTests, ...family.postgresTests])
      localFile(file);
    for (const file of family.postgresTests) referencedPostgres.add(file);
    for (const gate of family.requiredGateIds)
      assert.ok(value.gates[gate], `${name}: unknown gate ${gate}`);
  }
  assert.deepEqual(
    Object.keys(value.postgresTestCatalog).sort(),
    [...referencedPostgres].sort(),
    'every related PostgreSQL file needs an explicit test-boundary classification',
  );
  for (const [file, evidence] of Object.entries(value.postgresTestCatalog)) {
    localFile(file);
    assert.ok(postgresLayers.includes(evidence.layer), file);
    assert.equal(evidence.status, 'implemented', file);
    assert.deepEqual(
      evidence.executionEvidence,
      [],
      'implementation references cannot silently become permanent run outcomes',
    );
    text(evidence.scope, file);
    for (const support of evidence.supportFiles) localFile(support);
  }
  for (const [name, gate] of Object.entries(value.gates)) {
    assert.ok(
      [
        'evidence-required',
        'external-validation-required',
        'configuration-required',
        'blocked-by-missing-dependency',
      ].includes(gate.status),
      `${name}: unsupported gate status`,
    );
    text(gate.requirement, name);
  }
  for (const row of value.routes) {
    text(row.title, row.route);
    assert.ok(value.flowFamilies[row.family], `${row.route}: unknown family`);
    text(row.requiredBusinessFlow, row.route);
    assert.ok(statuses.includes(row.migration.status), row.route);
    assert.equal(typeof row.migration.inProgress, 'boolean');
    text(row.migration.reason, row.route);
    assert.ok(row.migration.exceptions.length > 0, row.route);
    for (const exception of row.migration.exceptions)
      text(exception, row.route);
    unique(row.migration.componentsUsed, row.route);
    unique(row.requiredGateIds, row.route);
    assert.ok(row.requiredGateIds.includes('native-device'), row.route);
    for (const gate of row.requiredGateIds)
      assert.ok(value.gates[gate], `${row.route}: unknown gate ${gate}`);
    for (const gate of value.flowFamilies[row.family]!.requiredGateIds)
      assert.ok(
        row.requiredGateIds.includes(gate),
        `${row.route}: lost ${gate}`,
      );
    for (const component of row.migration.componentsUsed)
      assert.ok(componentNames.includes(component), component);
    assert.deepEqual(
      row.sourceFiles,
      ['.ts', '.json', '.wxml', '.wxss'].map(
        (extension) => `apps/wechat/src/${row.route}${extension}`,
      ),
      row.route,
    );
    for (const file of [...row.sourceFiles, ...row.flowEvidence.pageTests])
      localFile(file);
    assert.equal(row.flowEvidence.status, 'implemented', row.route);
    text(row.flowEvidence.scope, row.route);
    if (row.migration.status === 'not-applicable') {
      assert.ok(
        protectedRoutes.includes(row.route),
        `${row.route}: not-applicable requires a reviewed bounded exception`,
      );
      assert.match(row.migration.reason, /frozen/i);
      assert.match(row.migration.reason, /not permanent/i);
    }
    if (protectedRoutes.includes(row.route)) {
      assert.equal(row.migration.status, 'not-applicable', row.route);
      assert.equal(row.migration.inProgress, false, row.route);
    }
    if (['implemented', 'verified'].includes(row.migration.status)) {
      assert.ok(
        row.migration.componentsUsed.length > 0,
        `${row.route}: implementation requires actual F7 use`,
      );
      assert.ok(
        row.flowEvidence.pageTests.length > 0,
        `${row.route}: implementation requires focused page evidence`,
      );
      assert.equal(row.migration.inProgress, false, row.route);
    }
    if (row.migration.status === 'migration-needed')
      assert.ok(
        row.migration.componentsUsed.length === 0 || row.migration.inProgress,
        `${row.route}: refresh the migration status for newly adopted components`,
      );
    if (row.migration.status === 'verified') {
      assert.equal(row.verification.status, 'verified', row.route);
      const requiredLayers = [...policy.verifiedRequiredLayers];
      if (row.requiredGateIds.includes('pg-evidence'))
        requiredLayers.push(policy.postgresLayerWhenRequired);
      const layers = row.verification.evidence.map((item) => item.layer);
      for (const layer of requiredLayers)
        assert.ok(layers.includes(layer), `${row.route}: missing ${layer}`);
      for (const evidence of row.verification.evidence) {
        for (const field of policy.verificationEvidenceRequiredFields)
          text(
            evidence[field as keyof AcceptanceEvidence],
            `${row.route}: ${field}`,
          );
        assert.equal(evidence.result, 'passed');
        assert.ok(Number.isFinite(Date.parse(evidence.observedAt)));
        assert.match(
          evidence.artifact,
          /^docs\/.*\.(json|md)$/,
          'verification needs a result artifact, not test source or a preview',
        );
        localFile(evidence.artifact);
      }
    } else {
      assert.equal(row.verification.status, 'not-verified', row.route);
      assert.deepEqual(row.verification.evidence, [], row.route);
    }
  }
  for (const smoke of value.boundedEmittedSmokes) {
    localFile(smoke.file);
    assert.equal(smoke.layer, 'emitted-wxml-source-smoke');
    assert.equal(smoke.status, 'implemented');
    text(smoke.scope, smoke.file);
    for (const route of smoke.routes) assert.ok(registered.includes(route));
  }
  for (const reference of value.observedRunReferences) {
    localFile(reference.artifact);
    text(reference.scope, reference.artifact);
    const report = JSON.parse(read(reference.artifact)) as {
      files: { path: string; sha256: string }[];
      observedAt: string;
    };
    assert.ok(Number.isFinite(Date.parse(report.observedAt)));
    for (const family of reference.familyIds)
      assert.ok(value.flowFamilies[family], family);
    for (const file of reference.testFiles) {
      assert.ok(referencedPostgres.has(file), file);
      assert.ok(
        report.files.some(
          (item) => item.path === file && /^[a-f0-9]{64}$/.test(item.sha256),
        ),
        `${reference.artifact}: missing source-bound input ${file}`,
      );
    }
    assert.equal(
      'result' in reference,
      false,
      'do not cache an external run result as a timeless route verdict',
    );
  }
}

test('native component/flow inventory covers each exact registered route once with bounded evidence', () => {
  validateInventory(inventory);
});

test('route component and retained-control inventory matches actual WXML and native registrations', () => {
  for (const row of inventory.routes) {
    const markup = read(`apps/wechat/src/${row.route}.wxml`);
    const config = JSON.parse(read(`apps/wechat/src/${row.route}.json`)) as {
      usingComponents?: Record<string, string>;
    };
    const tags = activeNativeComponentTags(
      `apps/wechat/src/${row.route}.wxml`,
      read,
    );
    assert.deepEqual(row.migration.componentsUsed, tags, row.route);
    for (const tag of tags) {
      const component = tag.replace(/^wu-/, '');
      assert.equal(
        config.usingComponents?.[tag],
        `../../components/${component}/${component}`,
        `${row.route}: ${tag} must be a locally registered native component`,
      );
    }
    const nativeControls = [
      ...new Set(
        [
          ...markup.matchAll(
            /<(button|input|textarea|switch|navigator|map|web-view|picker|checkbox|checkbox-group|radio|radio-group)\b/g,
          ),
        ].map((match) => match[1]!),
      ),
    ].sort();
    assert.deepEqual(
      row.migration.remainingDirectNativeControls,
      nativeControls,
      row.route,
    );
  }
});

test('a filename containing native or roundtrip never upgrades client/PostgreSQL evidence to emitted Pages', () => {
  for (const name of [
    'directory',
    'ratings',
    'activity',
    'announcement',
    'school-configuration',
    'school-qr',
  ]) {
    const file = `apps/api/test/integration/${name}-native-roundtrip.test.ts`;
    assert.equal(
      inventory.postgresTestCatalog[file]?.layer,
      'native-client-postgresql',
      file,
    );
  }
  assert.equal(
    inventory.postgresTestCatalog[
      'apps/api/test/integration/campus-tools-native-roundtrip.test.ts'
    ]?.layer,
    'emitted-page-postgresql',
  );
});

test('inventory rejects missing, extra, duplicate and substituted routes even at unchanged count', () => {
  for (const mutate of [
    (copy: Coverage) => copy.routes.pop(),
    (copy: Coverage) => copy.routes.push(structuredClone(copy.routes[0]!)),
    (copy: Coverage) => {
      copy.routes[1] = structuredClone(copy.routes[0]!);
    },
    (copy: Coverage) => {
      copy.routes[1]!.route = 'pages/unregistered/unregistered';
    },
  ]) {
    const copy = structuredClone(inventory);
    mutate(copy);
    assert.throws(() => validateInventory(copy));
  }
});

test('inventory rejects missing test evidence, invented completion and broad layout exemptions', () => {
  const missing = structuredClone(inventory);
  missing.flowFamilies['directory']!.nativeTests = [
    'apps/wechat/test/does-not-exist.test.ts',
  ];
  assert.throws(() => validateInventory(missing));

  const invented = structuredClone(inventory);
  const row = invented.routes.find(
    (item) => item.route === 'pages/status/status',
  )!;
  row.migration.status = 'implemented';
  row.migration.inProgress = false;
  row.migration.componentsUsed = [];
  assert.throws(
    () => validateInventory(invented),
    /implementation requires actual F7 use/,
  );
  row.migration.componentsUsed = ['wu-f7-button'];
  row.flowEvidence.pageTests = [];
  assert.throws(
    () => validateInventory(invented),
    /implementation requires focused page evidence/,
  );

  const exemption = structuredClone(inventory);
  exemption.routes.find(
    (item) => item.route === 'pages/wallet/wallet',
  )!.migration.status = 'not-applicable';
  assert.throws(() => validateInventory(exemption));
});

test('verified requires source-bound layer evidence; unit, preview or PostgreSQL alone cannot satisfy device acceptance', () => {
  const copy = structuredClone(inventory);
  const row = copy.routes.find(
    (item) => item.route === 'pages/campus-tools/campus-tools',
  )!;
  row.migration.status = 'verified';
  row.verification.status = 'verified';
  row.verification.evidence = [];
  assert.throws(() => validateInventory(copy), /missing native-unit/);
  row.verification.evidence = [
    {
      layer: 'native-unit',
      artifact: 'apps/wechat/test/campus-tools.test.ts',
      sourceRevision: 'test-only-not-real-acceptance',
      command: 'node --test',
      observedAt: '2026-10-20T00:00:00Z',
      result: 'passed',
    },
  ];
  assert.throws(() => validateInventory(copy), /missing package/);
  for (const key of [
    'htmlPreviewIsNativeDeviceProof',
    'mockIsPostgresProof',
    'postgresIsRealProviderProof',
  ] as const) {
    const misleading = structuredClone(inventory);
    misleading.evidencePolicy[key] = true;
    assert.throws(() => validateInventory(misleading));
  }
});

test('missing-provider and platform exceptions remain domain-specific and fail closed', () => {
  const lookup = (name: string) =>
    inventory.routes.find((row) => row.route === `pages/${name}/${name}`)!;
  assert.ok(lookup('wallet').requiredGateIds.includes('wallet-provider'));
  assert.ok(
    lookup('campus-tools-webview').requiredGateIds.includes('embed-domain'),
  );
  assert.ok(
    lookup('campus-tools-map').requiredGateIds.includes('location-consent'),
  );
  assert.ok(
    lookup('window-discussion-notices').requiredGateIds.includes(
      'creator-crosswalk',
    ),
  );
  assert.ok(
    !lookup('major-discussion-notices').requiredGateIds.includes(
      'creator-crosswalk',
    ),
    'Major has no creator-notice concept; do not invent a Window blocker',
  );
  assert.ok(
    readFileSync(
      path.join(nativeRoot, 'src/pages/wallet/wallet.ts'),
      'utf8',
    ).includes('钱包服务暂未接入'),
  );
});

test('template component coverage follows real imported management and included category markup', () => {
  for (const name of [
    'safety-appeal-management',
    'safety-punishment-management',
    'rating-category-manage',
    'rating-category-editor',
  ]) {
    const entry = `apps/wechat/src/pages/${name}/${name}.wxml`;
    assert.doesNotMatch(read(entry), /<wu-f7-/);
    assert.ok(activeNativeComponentTags(entry, read).includes('wu-f7-button'));
  }
  assert.throws(
    () => activeNativeComponentTags('apps/wechat/../../package.json', read),
    /outside native source/,
  );
  const entry = 'apps/wechat/src/pages/example/example.wxml';
  const shared = 'apps/wechat/src/pages/example/shared.wxml';
  const fixture = (
    main: string,
    body = '<template name="real"><wu-f7-button /></template>',
  ) =>
    activeNativeComponentTags(entry, (file) => {
      if (file === entry) return main;
      if (file === shared) return body;
      throw new Error('missing source');
    });
  assert.deepEqual(fixture('<!-- <wu-f7-button /> --><view />'), []);
  assert.deepEqual(fixture('<import src="./shared.wxml" /><view />'), []);
  assert.deepEqual(
    fixture('<import src="./shared.wxml" /><template is="real" />'),
    ['wu-f7-button'],
  );
  assert.throws(
    () => fixture('<import src="./shared.wxml" /><template is="wrong" />'),
    /unresolved template/,
  );
  assert.throws(() => fixture('<include src="./example.wxml" />'), /cyclic/);
  assert.throws(
    () => fixture('<include src="../../../outside.wxml" />'),
    /outside native source/,
  );
  assert.throws(() => fixture('<include src="{{target}}" />'), /dynamic/);
  assert.throws(
    () => fixture('<include src="./missing.wxml" />'),
    /missing source/,
  );
  assert.throws(
    () =>
      fixture(
        '<import src="./shared.wxml" /><template is="real" />',
        '<template name="real"><template is="real" /></template>',
      ),
    /cyclic/,
  );
});
