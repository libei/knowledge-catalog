# Inheritance MVP: scoping the claim

**Status: proposal.** Nothing here is implemented. The evidence below was
produced by running the current generator; the recommendation is not.

The proposed restriction has three parts: only entities inherit, every supertype
is abstract, and every relationship endpoint is concrete. The question is how
much the push simplifies under it, and what can then be claimed honestly.

## What is already true

Three of the four proposed rules are already how kcmd behaves. The restriction
mostly promotes existing behavior from silent to enforced, and adds little
machinery.

- **Only entities inherit.** `Relationship` in `src/libts/semantic/ir.ts:239`
  has no `extends` and no `abstract`. `resolve_inheritance.ts` flattens fields
  and nothing else. There is no relationship inheritance to remove.
- **Relationships on a supertype already fail.** An edge naming an abstract
  entity is dropped by the BigQuery leg (`bigquery.ts:205-215`), by the Spanner
  leg, and by the catalog leg (`knowledge_catalog.ts:152-165`). All three
  already require concrete endpoints; only the diagnostic differs.
- **Inherited fields are already bound per subtype.** A field with no
  `expression` is unbound (`ir.ts:228`) and omitted from the node table,
  inherited or not.

Only the second rule — a supertype must be abstract — is a real change. It is
also the one carrying the value.

## Evidence

The findings below come from running models through `generatePropertyGraph` on
the current tree.

**An abstract supertype with a metric on a concrete subtype generates cleanly
and emits zero warnings.** The measure lands on the subtype node table, both
subtypes carry `LABEL Party` backed by their own columns.

**A concrete supertype generates DDL BigQuery will reject.** With `Party` bound
to `party(p_id, p_name)` and `Customer` bound to `customer(c_id, c_name)`, the
customer node table is emitted as:

```sql
`p.d.customer` AS Customer
  KEY(c_id)
  DEFAULT LABEL
  PROPERTIES( p_id AS id, p_name AS name, c_spend AS spend, ... )
```

`p_id` and `p_name` are columns of the *party* table. The customer table does
not have them. The canonical-definition logic at `bigquery.ts:606-622` makes a
concrete supertype authoritative for the rendered expression, which includes the
physical column, so a subtype's own correct binding is discarded. The warning
says the remapping "is dropped"; it does not say the resulting DDL will not
deploy. The concrete-supertype path therefore only works when every subtype
table happens to use the supertype's column names.

**Both committed inheritance fixtures use that path.**
`tests/libts/semantic/fixtures/hierarchy_graph.yaml` and
`reserved_words_inherit.yaml` are all-concrete, and `hierarchy_graph` works only
because `person`, `customer`, `employee`, and `manager` all use the identical
column names. Its golden also demonstrates the double-count the guide warns
against: four tables carry `LABEL Person`, so a person who is also a customer is
two nodes under that label.

**An edge on an abstract supertype yields a graph with no edges and a warning.**
The push reports success. This is the worst of the failure modes, because
nothing in the exit status says the model lost its traversals.

## What the restriction buys

**Double-counting becomes impossible.** With no supertype table, no real thing
can appear twice under one label. The guide's longest section — diagnosing a
supertype total that is too high — describes a state the model can no longer
reach.

**Metrics stop being restricted to leaf types.** The leaf rule
(`bigquery.ts:364-377`) exists because a supertype's label is shared across
subtype tables. If supertypes are abstract, no emitted node table's label is
ever shared, so the check never fires and every concrete entity accepts a
metric. A restriction on the model removes a restriction on the feature.

**Silent binding overrides disappear**, along with the invalid DDL above.

## Code the restriction deletes

Line ranges are from the current tree.

| Block | Lines | Becomes |
|---|---|---|
| `bigquery.ts` canonical-definition maps and `renderOwn` override handling (597-654) | 58 | 2 |
| `bigquery.ts` dropped-ancestor LABEL branch (727-740) | 14 | unreachable |
| `bigquery.ts` abstract-vs-concrete label signature branch (742-757) | 16 | 6 |
| `bigquery.ts` shared-label OPTIONS drop (684-700) | 17 | 3 |
| `bigquery.ts` leaf-measure check (364-377) | 14 | 0 |
| `spanner.ts` mirrors of the label branches (estimate) | ~35 | ~10 |

Roughly 150 lines out, against roughly 30 lines in: two validation rules, and a
default in the OWL importer. Call it 120 lines net.

Five warning classes disappear: the structural remap of an inherited property,
the metadata-only override of an inherited property, the dropped supertype
description, the ancestor with no node table, and the metric on a non-leaf type.

120 lines is not a large saving. The saving that matters is conceptual. Every deleted block exists to reconcile two tables that disagree
about one property, and that disagreement is what the restriction makes
unreachable. The feature stops having a wrong way to use it.

## What to claim

**Claim plainly.** Class hierarchies of entities, any depth, multiple supertypes
and diamonds. One query over the general kind reaches every specific kind,
exactly once. One model deploys to BigQuery Graph and Spanner Graph. Metrics on
any concrete entity.

**Claim with the boundary attached.** A hierarchy classifies things. Edges
attach to the concrete kind that holds the key. A hierarchy is a classification
over one-table-per-kind storage rather than a storage layout of its own.

**Do not claim.** Traversal over a supertype. A metric spanning a hierarchy.
Discriminator-column hierarchies. Overriding an inherited field. Any governance
story for hierarchies in Knowledge Catalog.

The last one is worth separating out, because it is the gap least visible from
the code and most damaging to the narrative: **the hierarchy does not reach the
catalog at all.** `knowledge_catalog.ts:152-165` skips every abstract entity,
and no published entry carries `extends`. The catalog sees `Customer` and
`Supplier` as unrelated entries. The hierarchy lives in the deployed graph and
in the model file, and nowhere else. Positioning the semantic model as the place
an ontology is governed is not supportable until that changes.

## The one judgment call: relationship fan-out

Banning relationship inheritance outright is the right call for a first
release, and it leaves the single most natural ontology query unavailable:
everything a party of any kind owns. A reader who tries that and cannot write it
will conclude the hierarchy is decorative.

There is a middle position that avoids the Cartesian blow-up the restriction was
meant to prevent. Allow an edge with **one** abstract endpoint, and generate one
edge table per concrete descendant, all sharing the edge label. That is linear
in the number of subtypes, and it was verified live to work:
`MATCH (:Party)-[:owns]->(:Account)` returned both the customer's and the
supplier's account. Forbid the both-endpoints-abstract case, which is the one
that goes quadratic.

Recommendation: ship the four rules as the MVP, and treat one-sided fan-out as
the immediate follow-on rather than a someday item. It is the difference between
a hierarchy that answers questions and a hierarchy that only labels rows. Two
caveats to settle first: the descendant tables must each expose the foreign-key
column, and `GRAPH_EXPAND` has cardinality limits when several edge tables share
a label.

## Migration cost

- Rewrite `hierarchy_graph.yaml` and `reserved_words_inherit.yaml` to abstract
  supertypes, and regenerate four goldens.
- Add two validation rules: a supertype must be abstract, and a relationship
  endpoint must be concrete. Both belong on the push path rather than in the
  loader, so a purely logical model still loads and an imported ontology is not
  rejected for having no bindings.
- `kcmd owl import` sets no `abstract` today, and `rdfs:subClassOf` maps
  straight to `extends` (`converters/owl/to_ir.ts:250-265`). Default a class
  with at least one subclass and no source to `abstract: true`, or every
  imported ontology fails the new rule.

## Owed verification

Two claims in the draft guide are reasoned from the label model rather than run:
that a query may aggregate a supertype property over the supertype label even
though a declared metric cannot sit there, and that an empty `LABEL <Ancestor>`
block (emitted when a subtype binds none of the inherited fields) is accepted by
BigQuery. Both should be run before the guide ships.
