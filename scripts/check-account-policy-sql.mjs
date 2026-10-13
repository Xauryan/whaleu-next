import { format } from 'prettier';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrations = path.join(root, 'apps/api/migrations');
const functions = new Map();
for (const file of fs
  .readdirSync(migrations)
  .filter((name) => /^\d{4}.*\.sql$/.test(name) && name.slice(0, 4) <= '0133')
  .sort()) {
  const sql = fs.readFileSync(path.join(migrations, file), 'utf8');
  const pattern =
    /CREATE (?:OR REPLACE )?FUNCTION\s+([\w.]+)\s*\([\s\S]*?\bAS\s+(\$[a-zA-Z_0-9]*\$)[\s\S]*?\2\s*;/gi;
  for (const match of sql.matchAll(pattern))
    functions.set(match[1], {
      source: `apps/api/migrations/${file}`,
      sql: match[0],
      hash: crypto.createHash('sha256').update(match[0]).digest('hex'),
      calls: [
        ...new Set(
          [...match[0].matchAll(/\b(whaleu_[a-z_]+\.[a-z_]+)\s*\(/g)]
            .map((m) => m[1])
            .filter((name) => name !== match[1]),
        ),
      ],
    });
}
const direct = new Set(
  [...functions]
    .filter(([, f]) =>
      /whaleu_safety\.account_heads|actions_allowed|restriction_coverage/.test(
        f.sql,
      ),
    )
    .map(([name]) => name),
);
const closure = new Set(direct);
let changed;
do {
  changed = false;
  for (const [name, f] of functions)
    if (!closure.has(name) && f.calls.some((call) => closure.has(call))) {
      closure.add(name);
      changed = true;
    }
} while (changed);
const forwards = new Map([
  ['whaleu_safety.course_comment_allowed', 'browse'],
  ['whaleu_safety.window_rating_allowed', 'browse'],
  ['whaleu_safety.major_rating_allowed', 'browse'],
  ['whaleu_profile.moderation_actor_current', 'privileged_read'],
  ['whaleu_ratings.category_management_actor_current', 'content_management'],
  ['whaleu_community.require_post_owner_restore_safety', 'interaction'],
  [
    'whaleu_safety.window_discussion_named',
    'viewer_browse_not_author_punishment',
  ],
  [
    'whaleu_safety.major_discussion_named',
    'viewer_browse_not_author_punishment',
  ],
]);
const snapshot = [...closure].sort().map((name) => {
  const f = functions.get(name);
  return {
    function: name,
    source: f.source,
    sourceSha256: f.hash,
    directBaselineConsumer: direct.has(name),
    dependencies: f.calls.filter((call) => closure.has(call)).sort(),
    policyIntegration: forwards.has(name)
      ? { kind: 'forward_predicate', action: forwards.get(name) }
      : name === 'whaleu_safety.dish_contribution_status'
        ? {
            kind: 'unchanged_target_authority',
            reason:
              'Historical target contribution is not the current caller; new account punishment must not hide every authored item.',
          }
        : name === 'whaleu_safety.event_shape'
          ? {
              kind: 'unchanged_import_authority',
              reason:
                'Accepted baseline source shape remains independent from punishment issue or release.',
            }
          : {
              kind: 'retained_owner_contract',
              reason:
                'Original deadline, source, effect, visibility or final-fence function is retained; actor overlay is composed at its explicit caller/command source and does not replace this owner proof.',
            },
  };
});
const consumerSql = fs.readFileSync(
  path.join(migrations, '0136_account_policy_consumers.sql'),
  'utf8',
);
for (const name of forwards.keys())
  if (
    !consumerSql.includes(`CREATE OR REPLACE FUNCTION ${name}(`) &&
    !consumerSql.includes(`CREATE OR REPLACE FUNCTION ${name} (`)
  )
    throw new Error(`Missing forward predicate ${name}`);
const artifact = path.join(
  root,
  'docs/account-moderation/sql-baseline-consumers.json',
);
const value = await format(
  JSON.stringify(
    {
      directCount: direct.size,
      transitiveCount: closure.size,
      functions: snapshot,
    },
    null,
    2,
  ),
  { parser: 'json' },
);
if (process.argv.includes('--write-inventory'))
  fs.writeFileSync(artifact, value);
else if (
  !fs.existsSync(artifact) ||
  fs.readFileSync(artifact, 'utf8') !== value
)
  throw new Error(
    'SQL baseline consumer inventory changed; review before regenerating.',
  );
console.log(
  `SQL baseline inventory: ${direct.size} direct, ${closure.size} reachable current functions; historical definitions hashed. Runtime and PostgreSQL tests remain separate.`,
);

const sources = JSON.parse(
  fs.readFileSync(
    path.join(root, 'docs/account-moderation/sql-source-owners.json'),
    'utf8',
  ),
);
const captured = [
  ...consumerSql.matchAll(
    /CREATE TRIGGER account_policy_consumer_capture AFTER INSERT(?: OR UPDATE)? ON ([a-z_]+\.[a-z_]+)\s+FOR EACH ROW EXECUTE FUNCTION whaleu_safety\.account_policy_consumer_capture\(\)/g,
  ),
]
  .map((match) => match[1])
  .sort();
const expected = sources.map((source) => source.relation).sort();
if (
  new Set(captured).size !== captured.length ||
  JSON.stringify(captured) !== JSON.stringify(expected)
)
  throw new Error(
    'Consumer capture registry differs from reviewed exact source manifest.',
  );
console.log(
  `Consumer capture registry: ${captured.length} exact source relations; installed PostgreSQL trigger equality is tested separately.`,
);
