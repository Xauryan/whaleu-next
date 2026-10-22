import assert from 'node:assert/strict';

interface QueryEvent {
  sql: string;
  transactionId: symbol;
}

/** The HTTP guard, throttle and owner can use different managed transactions.
 * A finalization boundary applies only to its own transaction, not to all later
 * requests on the same pooled client. Query execution is never replaced. */
export function finalProofQueryObserver() {
  const finalized = new Set<symbol>();
  const statements: QueryEvent[] = [];
  return {
    statements,
    record(event: QueryEvent) {
      if (event.sql === 'SET CONSTRAINTS ALL IMMEDIATE')
        finalized.add(event.transactionId);
      else if (finalized.has(event.transactionId)) statements.push(event);
    },
    assertReadOnly() {
      assert.ok(finalized.size > 0, 'A real transaction finalization ran');
      for (const { sql } of statements)
        assert.ok(
          isReadOnlyFinalProofSql(sql),
          `Owner final proof remains read-only; unexpected SQL: ${sql}`,
        );
    },
  };
}

/** Select only the finalization of the transaction that emitted a required
 * tentative owner statement. An earlier guard finalization cannot arm a wait. */
export function finalizationAfterStatement(prefix: string) {
  let ownerTransaction: symbol | undefined;
  return {
    record(event: QueryEvent): boolean {
      if (event.sql.startsWith(prefix)) {
        assert.ok(
          ownerTransaction === undefined ||
            ownerTransaction === event.transactionId,
          'The expected tentative owner statement belongs to one transaction',
        );
        ownerTransaction = event.transactionId;
      }
      return (
        ownerTransaction !== undefined &&
        event.transactionId === ownerTransaction &&
        event.sql === 'SET CONSTRAINTS ALL IMMEDIATE'
      );
    },
  };
}

/** Conservative test-only SQL shape check, not a database authorization guard.
 * Inspect every statement and executable token, not only the first verb: WITH
 * can contain writes and SELECT can be followed by a second command. Quoted
 * literals/identifiers and comments cannot provide executable SQL keywords.
 * Reject opaque execution forms rather than trusting DO/CALL/EXECUTE bodies. */
export function isReadOnlyFinalProofSql(sql: string): boolean {
  const tokens: string[] = [];
  for (let i = 0; i < sql.length;) {
    const rest = sql.slice(i);
    const whitespace = /^\s+/.exec(rest);
    if (whitespace) {
      i += whitespace[0].length;
      continue;
    }
    if (rest.startsWith('--')) {
      const end = sql.indexOf('\n', i + 2);
      i = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (rest.startsWith('/*')) {
      i += 2;
      let depth = 1;
      while (i < sql.length && depth > 0) {
        if (sql.startsWith('/*', i)) {
          depth++;
          i += 2;
        } else if (sql.startsWith('*/', i)) {
          depth--;
          i += 2;
        } else i++;
      }
      if (depth !== 0) return false;
      continue;
    }
    const quote = rest[0];
    if (quote === "'" || quote === '"') {
      // Backslash escaping depends on session settings. Fail closed instead of
      // allowing an ambiguous literal to hide executable tokens.
      i++;
      let closed = false;
      while (i < sql.length) {
        if (sql[i] === '\\') return false;
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) i += 2;
          else {
            i++;
            closed = true;
            break;
          }
        } else i++;
      }
      if (!closed) return false;
      tokens.push('QUOTED');
      continue;
    }
    // No final proof needs dollar-quoted executable bodies. Do not erase them.
    if (/^\$(?:[a-z_][a-z0-9_]*)?\$/i.test(rest)) return false;
    const word = /^[a-z_][a-z0-9_$]*/i.exec(rest);
    if (word) {
      tokens.push(word[0].toUpperCase());
      i += word[0].length;
    } else {
      tokens.push(rest[0]!);
      i++;
    }
  }
  if (!tokens.length) return false;
  const forbidden = new Set([
    'INSERT',
    'UPDATE',
    'DELETE',
    'MERGE',
    'INTO',
    'DO',
    'CALL',
    'EXECUTE',
    'PREPARE',
    'COPY',
    'CREATE',
    'ALTER',
    'DROP',
    'TRUNCATE',
    'GRANT',
    'REVOKE',
    'REFRESH',
    'VACUUM',
    'ANALYZE',
    'REINDEX',
    'CLUSTER',
    'DISCARD',
    'RESET',
    'NEXTVAL',
    'SETVAL',
    'LO_IMPORT',
    'LO_UNLINK',
    'DBLINK_EXEC',
  ]);
  if (tokens.some((token) => forbidden.has(token))) return false;
  const statements: string[][] = [[]];
  for (const token of tokens) {
    if (token === ';') statements.push([]);
    else statements.at(-1)!.push(token);
  }
  return statements.every((statement) => {
    if (!statement.length) return true;
    if (statement[0] === 'COMMIT') return statement.length === 1;
    if (statement[0] === 'LOCK') {
      // Final owner fences must be nonblocking SHARE table locks, not DDL or
      // an unbounded/stronger mutation lock smuggled in under a LOCK prefix.
      return /^LOCK TABLE [A-Z_][A-Z0-9_]*(?: \. [A-Z_][A-Z0-9_]*)?(?: , [A-Z_][A-Z0-9_]*(?: \. [A-Z_][A-Z0-9_]*)?)* IN SHARE MODE NOWAIT$/.test(
        statement.join(' '),
      );
    }
    return statement[0] === 'SELECT' || statement[0] === 'WITH';
  });
}
