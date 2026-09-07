# ICM objects — the rules the schema cannot hold

Nineteen objects were created on tool on 2026-09-07 (Leave, Transaction, the plan
configuration set, the calculation output set, and the controls). Their FIELDS
are in `snapshots/tool/entity-types/`. This file is for everything the spec asked
for that a schema **cannot express**, so it is enforced deliberately rather than
assumed.

## Composite uniqueness is NOT enforced — measured, not assumed

The specs asked for three composite keys. **None of them exist**, and the
platform never said so:

| object | asked for | actually stored |
|---|---|---|
| `Transaction` | `sourceSystem` + `sourceId` | `transactionId` |
| `Quota` | `positionId` + `measureId` + `periodId` | `quotaId` |
| `Statement` | `employeeId` + `periodId` | `statementId` |

`ua-object.mjs` sent the composite list; the platform **derives
`uniqueKeyFields` from the per-field `uniqueKey: true` flags and discards it**.
Posting the whole definition back to `/api/entity-type/update` with the composite
set returns **HTTP 200 and changes nothing** — accepted, ignored, no error. See
`notes/runtime-facts.md`.

So these three are automation-enforced, and each has a failure that matters:

- **`Transaction` on `sourceSystem` + `sourceId`.** Without it a re-run of an
  import creates a second copy of every deal, and every credit and earning
  downstream doubles. The importer must check before it writes, the way
  `ICM | Create Position` checks `positionCode` before writing a seat.
- **`Quota` on `positionId` + `measureId` + `periodId`.** Two quota rows for one
  seat, measure and period means attainment depends on which one the fold reads
  first — a number that changes between runs with no input changing.
- **`Statement` on `employeeId` + `periodId`.** Two statements for one person and
  period is two payslips.

## Invariants per object

**`Leave`** — no overlapping rows for one `employeeId`. `guaranteeAmount` is
required when `type` is `LOA` and meaningless otherwise; the schema cannot make a
field conditionally required, so the writer must.

**`Transaction`** — **immutable**. No role and no automation may update or delete
a row. Corrections arrive as new rows with `reversalOf` set. This is the ledger
the whole calculation rests on: if a row can change after the fact, no
recalculation is reproducible and no statement can be explained.

**`RateTableBand`** — bands within a table must be contiguous, start at `0`, and
the last band's `toPct` must be blank ("and above"). A gap silently pays nothing
for attainment that falls in it; an overlap pays twice.

**`PlanComponent`** — `payTrigger` must be `Close` when `calcType` is `PctToGoal`
or `PayCurve`. Attainment is measured over a period, so paying it on invoice or
collection would credit a period the deal did not belong to.

**`PlanAssignment`** — a position must resolve to **exactly one** plan on any
date, with position-level assignment beating title-level. Zero means a seat earns
nothing silently; two means the answer depends on read order.

**`AuditLog`** — append-only. No update, no delete, by anyone.

## Money and percentages

Every money field is an **integer in minor units** (paise) and every percentage
is **integer basis points** (8% → 800). There are no decimals anywhere in this
model, deliberately: `notes/runtime-facts.md` records that a storage `number`
comes back as a different Java type depending on its value, which is not a thing
to discover while computing pay.

Field titles carry the unit — "Amount (minor units)", "Attainment % (bps)" — so a
reader of the builder cannot mistake 800 for eight percent.

## Self-references needed a second pass

`Transaction.reversalOf`, `CalculationRun.supersededBy` and `Credit.sourceCreditId`
each point at their own object, which cannot exist while the object is being
created. They were added afterwards with `ua-schema.mjs add-fields`. Any future
object with a self-reference needs the same two steps.
