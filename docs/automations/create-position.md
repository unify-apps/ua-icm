# ICM | Create Position

**Built state (2026-09-05)**: **DEPLOYED on tool**, id `6a9bfdeac4f2d5527e4c9a63`,
16 nodes. Suite `tests/6a9bfdeac4f2d5527e4c9a63.json` **19/19 green**, `validate`
and `lint` clean.

**The first WRITE callable in this repo.** Everything before it reads. That makes
two of its rules load-bearing rather than stylistic, and both are enforced by the
suite rather than asserted here.

| field | value |
|---|---|
| Token / name | `ICM \| Create Position` (`6a9bfdeac4f2d5527e4c9a63`), tag `icm`, CALLABLE |
| Purpose | Create a position, the title it carries, and optionally who holds it — in one call, so a caller cannot leave the set half-made. |
| Callers | The `Sales-Commission-Management` code app's Positions screen, via its Create dialog. |
| Authorization | Any authenticated caller, same as `ICM \| List Positions`: it writes org structure and no money. No amount, quota, attainment or payout is read or written. The moment it touches one, this row and the caller check change together, or the change is refused. |

## Why one callable and not three writes from the page

The layer rule: pages never touch objects. A create that the page performed as
three entity writes could fail after the first and leave a `Position` with no
title, which every screen then renders as a seat that exists and means nothing.
Here the three writes are one call, and **every check runs before the first
write** — so a refusal writes nothing at all.

That ordering is the whole design. `positionCode` carries a REAL unique index
(`uniqueKeyFields: ["positionCode"]`), and `notes/runtime-facts.md` records that a
duplicate does not fail at save time — it throws a raw `E11000` at RUN time and
kills the run mid-way. Checking first turns that into a `DUPLICATE_CODE` the
caller can act on, before a `Position` row exists to orphan.

## Input (`setup`)

| field | type | required | blank / default |
|---|---|---|---|
| `positionCode` | string | **yes** | — unique index; a human picks it, because every existing code on tool follows a readable convention a generator would break |
| `name` | string | **yes** | — |
| `titleId` | string | **yes** | — the seat's title, written to `PositionAttribute.titleId` |
| `payeeId` | string | no | `""` → **an open seat**. Present → a third write assigning that payee |
| `effectiveStart` | string | no | `""` → **today, UTC**. `YYYY-MM-DD` or epoch ms, same rule as the other ICM callables |

## Output

| status | meaning |
|---|---|
| `OK` | created. `positionId` and `attributeId` always; `assignmentId` only when a payee was named |
| `INVALID_INPUT` | a required field was blank, or `effectiveStart` is not a real date |
| `DUPLICATE_CODE` | that `positionCode` already exists — refused before any write |
| `TITLE_NOT_FOUND` | no `Title` with that id |
| `PAYEE_NOT_FOUND` | a payee was named and no `Payee` has that id |

```
status, success, message, positionId, positionCode, attributeId,
assignmentId (only when assigned), effectiveStart (epoch ms)
```

Every refusal returns with `positionId` **absent** — the suite asserts that on all
four, because "refused" and "half-created" are the two outcomes that must never be
confused for a write.

## What it writes

1. `Position` — `positionCode`, `name`, `active: true`
2. `PositionAttribute` — `name`, `positionId`, `titleId`, `effectiveStart`
3. `PayeePositionAssignment` — only when `payeeId` was given: `name`, `payeeId`,
   `positionId`, `effectiveStart`, `allocationPct: 100`

A brand-new position has no prior assignments, so creating one cannot produce the
CONFLICT state `ICM | List Positions` surfaces. **That stops being true the moment
this callable gains an "assign to an existing position" mode** — that version must
check for an overlapping window first, and this line is here so the next person
does not discover the rule by shipping the bug.

`territoryId` is deliberately not written: `Territory` exists, "Business Group"
does not, and the create dialog drops the field rather than mislabel one as the
other.

## Changes — the system of changes

| thing | verb | verdict | how would we notice if this is wrong? |
|---|---|---|---|
| `ICM \| List Positions` | unaffected | **unaffected** — it reads what this writes, and the shapes already agree: this sets the same `PositionAttribute` fields that callable resolves as of a date | the create suite's OK cases and the list suite run off one fixture family; a divergence reds one of them |
| `Position` unique index | handled already | **handled already** — checked before the write, returned as `DUPLICATE_CODE` | a case asserts the refusal, and asserts `positionId` is absent so a partial write would fail it |
| Positions page | create | **cascade** — its Create dialog is the only caller; the dialog's fields and this contract move together | `docs/pages/` records page→callable dependencies; a field added to the dialog with nowhere to go is caught here |
| A future "assign to existing position" mode | create | **blocks** — it would need the overlap check this version can skip, and must not be added by widening this one silently | the list callable already reports CONFLICT; a suite case there would turn red |
| Writing `territoryId` | accepted | **accepted** — dropped by decision, recorded above | a Territory column reappearing on the page with nothing behind it |

## Tests

`node scripts/regress.mjs 6a9bfdeac4f2d5527e4c9a63` — **19 cases**.

The two OK cases WRITE, so the suite makes itself idempotent: `allowZero`
cleanup first (leftovers from a run that died mid-way are the healthy case
there), then strict cleanup after, where matching zero means a record escaped.
No platform id is hardcoded — ids are minted per reseed, so the title and payee
are found by the business key a human recognises (`KITFIX-T-AE`, `KITFIX-E003`)
and chained with `{{case:...:id}}`.

| case | asserts |
|---|---|
| blank `positionCode` | `INVALID_INPUT`, nothing written |
| `effectiveStart: "2026-02-31"` | `INVALID_INPUT` — a date-shaped string that is not a real day |
| an existing code | `DUPLICATE_CODE` before any write |
| an id matching no Title | `TITLE_NOT_FOUND` |
| a payee id matching nothing | `PAYEE_NOT_FOUND` |
| no payee | `OK`, `positionId` + `attributeId`, `assignmentId` **absent** |
| a payee | `OK`, all three ids |
