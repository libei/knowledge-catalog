# CLAUDE.md — mdcode (`kcmd`)

Guidance for working in this directory. Run all commands from `toolbox/mdcode`.

## What this is

`kcmd` — "Metadata as Code" for Google Knowledge Catalog (Dataplex). It gives
data producers and agents a source-artifact UX for catalog metadata: author
metadata as YAML + sidecar markdown in a directory tree that mirrors the
resource hierarchy, and bi-directionally sync it with the Catalog service.
Shipped as a TypeScript library, a CLI (`kcmd`), and an MCP server. See
`README.md` and `docs/` (`concept.md`, `design.md`, `spec.md`, `plan.md`).

## Commands

```bash
npm run compile      # tsc --noEmit — type-check only (fast; run this first)
npm run build        # build:libts (tsc) + build:tool (bun --compile -> dist/kcmd)
npm test             # test:libts (scenarios) + test:semantic
npm run test:libts   # bun test ./tests/libts/scenarios.ts   (catalog-sync scenarios)
npm run test:semantic# bun test ./tests/libts/semantic/      (semantic model)
```

Tests run under **Bun** (`npx bun test`), not the TS compiler. `dist/` and
`build/` are gitignored build output — never edit or commit them; edit `src/`.

## Architecture

Two independent subsystems live under `src/libts/`:

**1. Catalog sync** (the original core) — `manifest.ts`, `snapshot.ts`,
`sync.ts`, `source.ts`, `metadata.ts`, `layout.ts` + `layouts/`, `sources/`
(bq-dataset, entrygroup, kb), and `gcp/` (Dataplex/BigQuery/CRM API clients via
`gcp/context.ApiContext`). Flow: a `catalog.yaml` manifest defines a scope and a
`CatalogSource`; `CatalogSnapshot` reads/writes the local file tree; `CatalogSync`
does pull/push against the service. CLI verbs (`init`/`pull`/`push`/`mcp`) are in
`src/tool/` (`main.ts` → `commands.ts`, `mcp.ts`). Public API surface is
re-exported from `src/libts/index.ts`.

**2. Semantic model** (`src/libts/semantic/`) — a separate pipeline, not wired
into the CLI yet:
- `ir.ts` — the in-memory IR: `SemanticModel { entities[], relationships[],
  metrics[] }`. **Pure semantics** — no deployment/target config belongs here.
- `loader.ts` — front-end: parses the AI-first semantics format (YAML/JSON) into
  the IR. Unsupported fields are accepted and ignored (returns `warnings[]`).
- `bigquery.ts` — first back-end/emitter: IR → a single
  `CREATE OR REPLACE PROPERTY GRAPH` DDL with metrics as inline `MEASURE(...)`.
  A BigQuery measure binds one aggregate to one table's KEY; a metric whose
  aggregate spans multiple tables can't be one MEASURE and is skipped + warned
  (cross-dataset ratios are the pending Phase B work — see the plan).
- `expr.ts` — shared literal-aware helpers for `<Entity>.<column>` expressions.

The design is **shared front-end + per-destination emitters**: `loader` is
destination-agnostic; BigQuery is one target and more (e.g. Knowledge Catalog)
are planned. Keep destination-specific logic in the emitter, not the loader/IR.

## Semantic test & golden conventions

Under `tests/libts/semantic/`:
- `loader.test.ts` — shared front-end; asserts **IR only**, no destination DDL.
- `bigquery.test.ts` — BigQuery emitter unit tests (inline IR, inline goldens).
- `bigquery.e2e.test.ts` — full file→IR→DDL over the `fixtures/` corpus, checked
  against committed golden files.
- Golden files are **destination-scoped**: `<fixture>.<destination>.golden.<ext>`
  (today `<fixture>.bigquery.golden.sql`). Each holds the complete DDL + a
  `-- warnings --` block, so a `.yaml` next to its golden shows full input/output.
- Regenerate goldens after an intentional generator change, then read the diff:
  `UPDATE_GOLDENS=1 npx bun test ./tests/libts/semantic/bigquery.e2e.test.ts`

Naming rule: shared/front-end tests are unqualified (`loader.test.ts`);
anything destination-specific carries the destination in its name.

Catalog-sync tests are data-driven: `tests/libts/scenarios.ts` runs YAML cases
from `tests/scenarios/*.yaml` against fake GCP clients in `tests/libts/mocks.ts`
(these two are the sync harness — **not** semantic-model code).

## Conventions

- **Never name the upstream semantics product** (its product name / "OSI") in
  code, comments, tests, fixtures, or commit/PR text. Always call it
  "the AI-first semantics format." Fixtures use neutral names; upstream URLs are
  recorded only as provenance in the x20 doc, never in committed files.
- Commit subjects: `mdcode: <lowercase imperative summary>`.
- TypeScript is `strict` with `noUnusedLocals`/`noImplicitReturns`/
  `noFallthroughCasesInSwitch`; keep `npm run compile` clean before committing.
