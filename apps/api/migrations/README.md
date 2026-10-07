# SQL migration contract

`0001_identity_sessions.sql` creates the new identity/session schema. It contains
no import or transformation of legacy records. Production schema mapping and all
legacy-data migration remain separate, required milestones.
`0002_identity_retention_index.sql` adds the terminal-session lookup index for
operator-only maintenance; applying it does not delete any records.

- Add immutable UTF-8 files named `0001_descriptive_name.sql`, in increasing order
- SQL files are trusted repository code and require review before execution
- Each file runs inside its own transaction and records its SHA-256 checksum in
  `whaleu_meta.schema_migrations` in the same transaction
- Do not include transaction-control statements (`BEGIN`, `COMMIT`, `ROLLBACK`)
  or commands that require execution outside a transaction, such as concurrent indexes
- The database-local session advisory lock serializes migrations. Waiting is bounded
- Applied files must not be removed, reordered, or edited; create a new forward migration
- A failed transaction rolls back and does not record a successful application
- `db:status` does not create schema or tables; `db:migrate` creates only bookkeeping
  when this directory contains no SQL files
- No automatic startup migration and no automatic down/reset command is provided
- Review a backup/restore rehearsal and run in a disposable database before any
  separately authorized production migration

The runner is migration infrastructure, not a legacy-data migration tool. Data
mapping, validation, dry-run comparisons, cutover, and rollback remain unimplemented.
