# ICM | Plans

The plan model, and the four callables the Plans page reads and writes.

| callable | id | data source | suite |
|---|---|---|---|
| `ICM \| List Plans` | `6aa18daa3c7f7b6b91c15ce6` | `e_6aa26765561c60372d70121f` | green |
| `ICM \| Get Plan` | `6aa18daaff41994689752982` | `e_6aa26766561c60372d701223` | 9/9 |
| `ICM \| Create Plan` | `6aa18daacab06d30bad86124` | `e_6aa26766561c60372d701226` | 15/15 |
| `ICM \| Update Plan` | `6aa264103aa7845ea17fca52` | `e_6aa26767561c60372d701243` | 11/11 |
| `ICM \| List Periods` | `6aa18db5cab06d30bad86183` | `e_6aa26767561c60372d701246` | green |

All five deployed on tool 2026-09-10 and verified end to end through the data
sources: create with one title and one position, read it back, edit down to one
title, read again (status and description changed, positions gone), then list.

## Storage

**`Plan` gained four fields** — `description`, `periodId`, `creditRules`,
`payoutRules`. The two rule lists are genuine `array` columns holding plain arrays of
rule ids; there is no `{items:[...]}` wrapper.

**They are named `creditRules` / `payoutRules` and not `...Ids`, and that is not a
style choice.** They were first created as json objects. A field's STORAGE TYPE is
fixed when the column is created: retyping the schema to `array` does not migrate it,
deleting the field from the schema does not drop the column (it is keyed by name),
and re-adding the same name reuses the original object column — so every array
written into `creditRuleIds` came back as `{}` while the schema reported
`"type":"array"`. There is no per-field delete API. The only way to get an array
column is a name that has never been used. See `notes/runtime-facts.md`.

**The callables kept `creditRuleIds` / `payoutRuleIds` as their INPUT and RESPONSE
names**, so the app's contract never moved — only storage did. Worth knowing when
reading a graph: the parameter and the column are deliberately named differently.

**`periodId` holds the period's NAME**, e.g. `YEAR-2026`. That is not a shortcut:
`Period.name` is that object's own unique key, so the plan is storing the business
key rather than inventing a second identity for it.

**`PlanAssignment` carries two real LOOKUPS**, `titleId` to `Title` and `positionId`
to `Position`. One row per target; each row fills the column that applies and leaves
the other unset. `targetType` (`Title` / `Position`) still labels the kind, so nothing
has to test two columns for emptiness to find out what a row is.

`targetId` is no longer written. `Get Plan` still RETURNS one, derived from whichever
lookup is set, so the page can render both kinds through a single path without the
value being stored twice.

Both lookups hold RECORD ids, which is what the pickers already supply:
`TitleOption.titleId` and `LivePosition.positionId` are both `String.valueOf(r.id)`.
The position picker was passing `positionCode` — the business key — and now passes the
id, with the code kept as the option's label.

## Create — inputs and refusals

| field | required | note |
|---|---|---|
| `name` | **yes** | |
| `periodId` | **yes** | a plan without a period has no window to pay in |
| `description` | no | |
| `status` | no | `Draft` (default), `Active` or `Retired` |
| `creditRuleIds`, `payoutRuleIds` | no | real arrays, not JSON strings |
| `assignments` | no | `{titles:[{titleId, effectiveStart, effectiveEnd}], positions:[{positionId, ...}]}` |

`effectiveEnd: null` is a real state — open-ended — not a missing value.

`Plan.status` is a **single-select of `Draft` / `Active` / `Retired`**, title-cased.
Passing anything else reaches the entity validator and fails at WRITE time with
`property status invalid; oneOf fail`, which is a late and unhelpful place to learn
it. The automation normalises case and refuses the rest up front.

The plan id is minted (`PLAN-<millis>-<rand>`) and written onto the assignment rows
in the same run, so the two are linked without a second read.

**A plan with no assignments at all works** — the bulk write of an empty list
succeeds. That was worth proving rather than designing around.

## Four traps, all the same family: a write that reports success and does nothing

**`Plan.status`** is a single-select of `Draft` / `Active` / `Retired`, title-cased.
Anything else reaches the entity validator and fails at WRITE time with
`property status invalid; oneOf fail`.

**`PlanAssignment.targetType`** is `Title` / `Position`, likewise. `TITLE` was
refused — and `bulk_create_records` answered `inserted: 0` with an `errors` map while
the NODE stayed `ok`, so the automation reported success having written no assignment
rows at all. Create Plan now compares `inserted` against the expected count and
answers `ASSIGNMENTS_FAILED` rather than lying.

**`update_records` matched zero rows** with the identical filter that found the
record one node earlier. Updating by record id works; the plan is already fetched for
the existence check, so the id is in hand.

**`update_record_by_id` with `useRawPayload` REPLACES the property set** — it does not
merge. Sending only the changed fields wiped `planId`, and the plan then could not be
found by the key it is looked up by. The update reads the whole record first and lays
the changes over it.

**`PlanAssignment.planId` is a foreign key**, so it holds the plan's RECORD id, not
the business key. The create stamps it in after the plan exists; both readers filter
on it.

**Get Plan guards the second fetch.** A planId matching nothing left
`objects[0].id` null, which put a null in the assignment filter and errored the node
— so a missing plan crashed instead of answering `NOT_FOUND`.

**`PlanComponent` overlaps with this and is untouched.** It already carries calc
type, rate table, caps, draw and sort order per component, while this model points
rule ids straight at the plan. Both cannot be what the calculation engine reads;
that is a decision, not a merge.
