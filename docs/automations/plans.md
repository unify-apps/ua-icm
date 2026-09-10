# ICM | Plans

The plan model, and the four callables the Plans page reads and writes.

| callable | id | state |
|---|---|---|
| `ICM \| Create Plan` | `6aa18daacab06d30bad86124` | suite 11/11, **not deployed yet** |
| `ICM \| List Plans` | `6aa18daa3c7f7b6b91c15ce6` | built, untested |
| `ICM \| Get Plan` | `6aa18daaff41994689752982` | built, untested |
| `ICM \| List Periods` | `6aa18db5cab06d30bad86183` | built, untested |

## Storage

**`Plan` gained four fields** — `description`, `periodId`, `creditRuleIds`,
`payoutRuleIds`. The two id lists are `json` and are stored under `{items:[...]}`,
because a bare array in a json property is silently dropped on write.

**`periodId` holds the period's NAME**, e.g. `YEAR-2026`. That is not a shortcut:
`Period.name` is that object's own unique key, so the plan is storing the business
key rather than inventing a second identity for it.

**`PlanAssignment` needed no change.** One row per target, with `targetType`
(`TITLE` / `POSITION`), `targetId`, `startDate` and `endDate` — which is exactly the
`assignments.titles[]` / `assignments.positions[]` shape, flattened. `targetType` is
the only thing separating a title assignment from a position one.

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

## Still to do

Suites and deploys for the three read callables, an `Update Plan` for editing, five
data sources, and the page.

**`PlanComponent` overlaps with this and is untouched.** It already carries calc
type, rate table, caps, draw and sort order per component, while this model points
rule ids straight at the plan. Both cannot be what the calculation engine reads;
that is a decision, not a merge.
