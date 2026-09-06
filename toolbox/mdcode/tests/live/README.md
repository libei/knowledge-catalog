# Live tests

These tests run the constraints work against real Cloud Spanner and a real
Knowledge Catalog instead of fakes. They exist because the hermetic suite can
only prove that we generate the SQL we meant to generate; it cannot prove the
server accepts it. Running them found a real bug: the lowering emitted
`col != NULL`, which every hermetic test asserted was correct and which Spanner
rejects outright.

They are skipped unless you opt in, and they are not part of `npm test`.

## What they cover

| File | Proves |
| --- | --- |
| `spanner_live.test.ts` | The Spanner data client against the real API: sessions, the per-transaction statement sequence number, parameter binding, and the read-your-writes and rollback behaviour the runtime depends on. |
| `constraint_eval_live.test.ts` | Every lowered constraint probe is SQL the server accepts, returns the rows it should, and scopes correctly to the keys an action touched. |
| `runtime_live.test.ts` | An action commits when constraints hold and leaves the database untouched when one is violated, including failures the fake cannot produce (a probe the server type-checks and rejects). |
| `knowledge_catalog_live.test.ts` | Constraints survive a push and pull through a real Dataplex: both markers land in the one overview aspect, and a pull recovers them byte for byte. |

## Running them

Everything is gated on `KCMD_LIVE`. The catalog leg needs a second opt-in,
`KCMD_LIVE_KC`, because it writes entries to a real project.

Authenticate first: the tests use application default credentials.

```
gcloud auth application-default login
```

Create and seed the Spanner database once. It is a database of its own, not the
action demo's, so the tests cannot disturb anything else:

```
KCMD_LIVE=1 npx bun tests/live/setup.ts
```

Then run the Spanner and constraint legs:

```
KCMD_LIVE=1 npm run test:live
```

The catalog leg needs an entry group it can create, empty, and delete, and a
project that hosts the `semantic-*` entry types. Point `DATAPLEX_ENDPOINT` and
`KC_TYPE_PROJECT` at a surface where those types are published:

```
KCMD_LIVE=1 KCMD_LIVE_KC=1 \
  DATAPLEX_ENDPOINT=... KC_TYPE_PROJECT=... \
  npm run test:live
```

## Settings

Each has a default, so you only set the ones you need to move.

| Variable | Default | Meaning |
| --- | --- | --- |
| `KCMD_LIVE` | unset | Master switch. Everything skips without it. |
| `KCMD_LIVE_KC` | unset | Also run the catalog leg. |
| `KCMD_LIVE_PROJECT` | `sqlgen-testing` | Project for both Spanner and the catalog. |
| `KCMD_LIVE_SPANNER_INSTANCE` | `graph-unified-solution-demo` | Spanner instance. |
| `KCMD_LIVE_SPANNER_DATABASE` | `kcmd_live_test` | Database the setup script creates. |
| `KCMD_LIVE_KC_LOCATION` | `global` | Catalog location. |
| `KCMD_LIVE_KC_ENTRY_GROUP` | `kcmd_live_test` | Entry group the catalog tests own. |
| `DATAPLEX_ENDPOINT` | production | Catalog endpoint. |
| `KC_TYPE_PROJECT` | `dataplex-types` | Project hosting the `semantic-*` entry types. |

## What they assume about the data

The Spanner tests reseed before every test and again when the file finishes, so
a failed run leaves the database in a known state and the next run starts clean.
The seed is three people and six accounts, two of which share a name so the
ambiguous-reference path has two real rows to be ambiguous between.

The catalog tests own their entry group outright: they empty it before each run
and delete it afterwards. Point them at a group nothing else uses. They delete
entry links before entries, because deleting an entry first orphans its links
permanently.

## Two things the servers taught us

A session holds at most one read-write transaction. Beginning a second in the
same session invalidates the first, and the failure surfaces later as a lock
held by a transaction nobody is using any more. Tests that need two concurrent
transactions use two sessions.

An entry group answers `get` before it answers a list of its entries, so waiting
on the wrong call still fails the first real request. The catalog tests poll the
entries collection.
