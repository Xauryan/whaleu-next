import { format } from 'prettier';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Split only top-level SQL statements; quoted bodies and comments cannot create registry entries. */
function migrationStatements(sql) {
  const statements = [];
  let statement = '';
  let index = 0;
  while (index < sql.length) {
    if (sql.startsWith('--', index)) {
      const end = sql.indexOf('\n', index + 2);
      index = end < 0 ? sql.length : end + 1;
      statement += ' ';
      continue;
    }
    if (sql.startsWith('/*', index)) {
      let depth = 1;
      index += 2;
      while (index < sql.length && depth > 0) {
        if (sql.startsWith('/*', index)) {
          depth++;
          index += 2;
        } else if (sql.startsWith('*/', index)) {
          depth--;
          index += 2;
        } else index++;
      }
      if (depth !== 0) throw new Error('Unterminated SQL comment');
      statement += ' ';
      continue;
    }
    const quote = sql[index];
    if (quote === "'" || quote === '"') {
      const start = index++;
      const escaped = quote === "'" && /(?:^|[^\w])e$/i.test(statement);
      let closed = false;
      while (index < sql.length) {
        if (escaped && sql[index] === '\\') {
          index += 2;
          continue;
        }
        if (sql[index++] !== quote) continue;
        if (sql[index] === quote) {
          index++;
          continue;
        }
        closed = true;
        break;
      }
      if (!closed) throw new Error('Unterminated SQL quote');
      statement += sql.slice(start, index);
      continue;
    }
    const dollar = /^\$(?:[a-z_][a-z_0-9]*)?\$/i.exec(sql.slice(index));
    if (dollar) {
      const end = sql.indexOf(dollar[0], index + dollar[0].length);
      if (end < 0) throw new Error('Unterminated SQL dollar quote');
      statement += sql.slice(index, end + dollar[0].length);
      index = end + dollar[0].length;
      continue;
    }
    if (sql[index] === ';') {
      if (statement.trim()) statements.push(statement.trim());
      statement = '';
    } else statement += sql[index];
    index++;
  }
  if (statement.trim()) statements.push(statement.trim());
  return statements;
}

/** Apply reviewed capture CREATE/DROP statements in migration order; unsupported lifecycle DDL fails closed. */
export function collectAccountPolicyCaptureSources(migrationFiles) {
  const active = new Map();
  const captureNames = new Set(['account_policy_consumer_capture']);
  const filenames = new Set();
  const executeCapture =
    /\bEXECUTE\s+(?:FUNCTION|PROCEDURE)\s+"?whaleu_safety"?\s*\.\s*"?account_policy_consumer_capture"?\s*\(/i;
  for (const { name, sql } of [...migrationFiles].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (filenames.has(name))
      throw new Error(`Duplicate migration name: ${name}`);
    filenames.add(name);
    for (const raw of migrationStatements(sql)) {
      const statement = raw.replace(/\s+/g, ' ').trim();
      if (
        /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\b/i.test(
          statement,
        )
      ) {
        const createsCapture = executeCapture.test(statement);
        const identity =
          /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+([a-z_]\w*)\b[\s\S]*?\bON\s+([a-z_]\w*\.[a-z_]\w*)\b/i.exec(
            statement,
          );
        if (!createsCapture) {
          if (
            identity &&
            (captureNames.has(identity[1].toLowerCase()) ||
              active.has(
                `${identity[2].toLowerCase()}/${identity[1].toLowerCase()}`,
              ))
          )
            throw new Error(
              `Capture trigger redirected or replaced in ${name}`,
            );
          continue;
        }
        const create =
          /^CREATE TRIGGER ([a-z_]\w*) AFTER INSERT(?: OR UPDATE)? ON ([a-z_]\w*\.[a-z_]\w*) FOR EACH ROW EXECUTE FUNCTION whaleu_safety\.account_policy_consumer_capture\(\s*\)$/i.exec(
            statement,
          );
        if (!create) throw new Error(`Unsupported capture CREATE in ${name}`);
        const trigger = create[1].toLowerCase();
        const relation = create[2].toLowerCase();
        if ([...active.values()].includes(relation))
          throw new Error(`Duplicate capture source ${relation} in ${name}`);
        active.set(`${relation}/${trigger}`, relation);
        captureNames.add(trigger);
        continue;
      }
      if (/^DROP\s+TRIGGER\b/i.test(statement)) {
        const drop =
          /^DROP TRIGGER (?:IF EXISTS )?([a-z_]\w*) ON ([a-z_]\w*\.[a-z_]\w*)(?: CASCADE| RESTRICT)?$/i.exec(
            statement,
          );
        if (!drop) throw new Error(`Unsupported trigger DROP in ${name}`);
        const trigger = drop[1].toLowerCase();
        const relation = drop[2].toLowerCase();
        if (
          !active.delete(`${relation}/${trigger}`) &&
          captureNames.has(trigger)
        )
          throw new Error(
            `Untracked capture DROP ${relation}/${trigger} in ${name}`,
          );
        continue;
      }
      if (
        /^(?:DO\b|CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\b)/i.test(
          statement,
        ) &&
        (executeCapture.test(statement) ||
          [...captureNames].some((trigger) =>
            new RegExp(
              `\\bDROP\\s+TRIGGER\\s+(?:IF\\s+EXISTS\\s+)?"?${trigger}\\b`,
              'i',
            ).test(statement),
          ))
      )
        throw new Error(
          `Dynamic capture DDL requires explicit review in ${name}`,
        );
      const unquoted = statement.replaceAll('"', '').toLowerCase();
      if (active.size > 0 && /^drop\s+owned\b/.test(unquoted))
        throw new Error(
          `Implicit capture deletion requires explicit review in ${name}`,
        );
      if (/^drop\s+(?:table|schema|function)\b/.test(unquoted)) {
        if (
          unquoted.includes('whaleu_safety.account_policy_consumer_capture') ||
          [...active.values()].some((relation) => {
            const target = /^drop\s+schema\b/.test(unquoted)
              ? relation.split('.')[0]
              : relation;
            return new RegExp(
              `(?:^|[\\s,])${target.replaceAll('.', '\\.')}[\\s,(]*$|(?:^|[\\s,])${target.replaceAll('.', '\\.')}[\\s,]`,
            ).test(unquoted);
          })
        )
          throw new Error(
            `Implicit capture deletion requires explicit review in ${name}`,
          );
      }
      if (
        /^alter\s+(?:table|trigger)\b/.test(unquoted) &&
        /\b(?:rename|set schema|disable trigger)\b/.test(unquoted) &&
        [...active.values()].some((relation) => unquoted.includes(relation))
      )
        throw new Error(`Unsupported capture lifecycle change in ${name}`);
    }
  }
  return [...active.values()].sort();
}

export async function main(args = process.argv.slice(2)) {
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
  if (args.includes('--write-inventory')) fs.writeFileSync(artifact, value);
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
  const captured = collectAccountPolicyCaptureSources(
    fs
      .readdirSync(migrations)
      .filter((name) => /^\d{4}.*\.sql$/.test(name))
      .sort()
      .map((name) => ({
        name,
        sql: fs.readFileSync(path.join(migrations, name), 'utf8'),
      })),
  );
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
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main();
}
