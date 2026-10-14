# Frozen historical upgrade evidence

`008/installation.sql` is a committed synthetic installation produced by the
application and migration source at commit
`b5258d974c905ae6c621ed52fba6e8b5889aa7e7`, before large-session reads or migration
checksums existed. Tests load these bytes into a new isolated database and run the
normal owner initialization path; they never seed history with the current app
or reconstruct this installation from current schema constants.

The fixture contains an archived and an active session, exact balances and
journal entries, exact identity sequence positions, 11 orders, six fills, all four limit order states, filled and
partially canceled protected market orders, original command receipts, preview
uses, a completed rollover, allocations and synthetic invitation/user records.
The manifest pins the source commit, historical lockfile, builder/generator,
external dependency graph, each migration SQL statement, frozen installation and
expected receipt bytes using SHA-256, and records the direct dependency versions.

All identifiers and handles are synthetic. Generated password hashes are
replaced with a disabled sentinel, login sessions are removed and redeemed
invitation hashes are replaced with inert synthetic values before the data is
frozen. There are no usable credentials, original user records or private keys.
The upgrade test checks exact identity rows before resetting the administrator
password through owner recovery and testing login plus rollover receipt replay.

To review regeneration, provide `TEST_DATABASE_URL` for a disposable PostgreSQL18
server whose owner can create and drop databases, then run:

```sh
pnpm exec tsx tests/fixtures/historical/generate.ts
```

The generator archives the pinned commit into a private temporary directory,
binds workspace imports to that archived source and reuses installed external
dependencies only when their installed direct versions match the historical
manifests and their complete package/snapshot lockfile graph is identical.
If versions differ, install the archived lockfile rather than substituting newer
libraries. It creates and drops only a new isolated database and removes the
temporary source. Financial values and microsecond timestamps are copied as
PostgreSQL JSON text without conversion through JavaScript numbers or dates.

Regeneration is a repeatable procedure, not a promise of identical output:
historical commands generate fresh synthetic IDs and capture the database clock.
Review changed rows and update the hashes together only when deliberately
replacing the fixture. Routine tests do not regenerate it or require Git history,
database native dump binaries or network access.

Loading the frozen installation temporarily disables user triggers to restore
already archived evidence, then enables every trigger before committing. This
fixture loader is test-only and must never run against a live installation.
