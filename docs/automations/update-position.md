# ICM | Update Position

**Built state (2026-09-11)**: `6aa3bb139b5b0739345087ea` on **tool**, draft v1 **DEPLOYED**
(workflowVersion 1, verified from `deploymentState`), approved by the user in session.
`ua.mjs validate` clean, `lint.mjs` clean, suite `tests/6aa3bb139b5b0739345087ea.json`
**58/58 green** on tool, every fixture row deleted by the suite's own cleanup. Page data
source `ds_update_position` on `e_global_app-1621b11a65c8`. Not built on orbit.

Lint needed one addition, made deliberately rather than by weakening the rule:
`storage_by_unifyapps_delete_records` joined R7's uacode-verified list, citing
`configs/workflow-nodes/storage_by_unifyapps/storage_by_unifyapps_delete_records.json`.
The suite then proved it on tool: the same-day emptying case removed its row and List
Positions read the seat `VACANT` with `matchCount 0`.

| field | value |
|---|---|
| Token / name | `ICM \| Update Position` (id minted on create), tag `icm`, CALLABLE. Built by `scripts/build-update-position.mjs` from `automations/update-position/*.groovy` |
| Purpose | Edit one position: its name and active flag, and — as dated changes — the title it carries and the person who holds it. |
| Replaces | Nothing. Before this, a position could be created (`ICM \| Create Position`) and never changed; a wrong title or a leaver's seat needed a hand edit of three objects. |
| Callers | The Sales-Commission-Management app's Positions drawer (`app/src/components/org/position-detail-sheet.tsx`, through `useUpdatePosition` and the `UPDATE_POSITION` binding in `app/src/data/callables.ts`). Callers must NOT assume a blank field clears anything: blank means leave alone, and emptying the seat is the explicit `clearPayee`. |
| Authorization | Any authenticated user of the app, the same as Create Position. **This callable writes org structure, never money** — no amount, quota, rate or payout is read or written. The moment it is asked to touch one, this row changes first. |

Read `00-shared-contract.md` first — everything it says applies here.

## Entity study

From `snapshots/tool/entity-types/`, not assumed:

- **`Position`** — required `positionCode` (UNIQUE), `name`; optional `active` (boolean,
  MISSING when never set). `positionCode` is **never** written: it is the business key
  plans, quotas and uploaded files refer to a seat by. Only `name` and `active` change.
- **`PositionAttribute`** — required `name`, `positionId`, `effectiveStart`; optional
  `titleId` → Title, `territoryId` → Territory, `effectiveEnd`. No unique key: overlap is
  a rule, not an index. A new row copies the closed row's `name` and `territoryId`, so a
  title change does not silently drop the territory.
- **`PayeePositionAssignment`** — required `name`, `payeeId`, `positionId`,
  `effectiveStart`; optional `effectiveEnd`, `allocationPct`. No unique key. A new row
  keeps the closed row's `allocationPct` (100 when there was none, as Create Position writes).
- **`Title`**, **`Payee`** — read by id only, to refuse a reference to nothing.
- **Other writers**: `ICM | Create Position` creates all three; `ICM | Update Profile`
  and the hierarchy callables touch `PositionHierarchy`, which this does not.
- **Readers that must agree with what this writes**: `ICM | List Positions`,
  `ICM | Resolve Position Occupant`, `ICM | Calculate Credits`. All three read
  "in force on a date" as `effectiveStart <= date <= effectiveEnd`, inclusive, a missing
  end meaning still in force. This callable plans with exactly that rule.

## Period and money

No `periodId`, no amount. The dated rows it writes are what calculations resolve a seat
through, which is why a change is **dated, never an overwrite**: a title changed from
1 July leaves June resolving to the old title. Dates are `yyyy-MM-dd`, read as midnight
UTC, the same rule Create Position applies. It **does not** recalculate anything: a
period already calculated with the old title keeps its credits until it is re-run.

## Input (`setup`)

All strings; `""` and an omitted key both mean "leave alone".

| input | meaning |
|---|---|
| `positionId` | **required**. The Position record id. |
| `name` | new name; blank leaves it. |
| `active` | `true` / `false`; blank leaves it. Anything else is `INVALID_INPUT`. |
| `titleId` | new Title record id, from `effectiveStart`; blank leaves it. |
| `payeeId` | new holder's Payee record id, from `effectiveStart`; blank leaves it. |
| `clearPayee` | `true` empties the seat from `effectiveStart`. Sent with `payeeId` it is `INVALID_INPUT`. |
| `effectiveStart` | `yyyy-MM-dd`; blank is today, UTC. Only title and person changes are dated. |

A request naming nothing to change is `INVALID_INPUT`.

## Output

Every outcome answers the same keys (a null is dropped from a callable's response, so
absent facts are `""`, `false`, `[]`):

```
status          OK | INVALID_INPUT | POSITION_NOT_FOUND | TITLE_NOT_FOUND | PAYEE_NOT_FOUND
                | CONFLICT | HISTORY_TOO_LONG | WRITE_INCOMPLETE
success         true only for OK
message         caller-actionable; on OK, what changed ("Nothing changed ..." when nothing did)
positionId      echoed
positionCode    the seat's code, once it has been read
changedFields   string[] of name | active | titleId | payeeId - only what actually moved
titleChanged    boolean
personChanged   boolean
attributeId     the title row created or corrected; "" when the title did not change
assignmentId    the assignment created or corrected; "" when none was (an emptied seat has none)
effectiveStart  the yyyy-MM-dd the dated changes took effect
```

## How a dated change is planned

For the title and, independently, the person:

1. **Nothing in force differs** → no write. Sending the same request twice therefore
   answers `OK` with `changedFields: []` the second time.
2. **Two or more rows in force on the date** → `CONFLICT`. Replacing one would leave the
   other in force; this is the same overlap List Positions reports, and it is refused
   rather than deepened.
3. **The row in force opened ON the effective date** → a correction: that row's
   `titleId` / `payeeId` is changed in place. Emptying a seat taken that same day
   **deletes** the assignment, because there is no day it was really held. (Closing it at
   `date - 1ms` would end it before it began — invisible to every as-of read, silent damage.)
4. **Otherwise** the row in force is closed at `date - 1ms` and a new row opens at `date`,
   inheriting the closed row's `effectiveEnd`. A later dated row is left untouched and
   the timeline never overlaps.
5. **No row in force** → a new row opens at `date`, ending one millisecond before the next
   row that starts later (open-ended when none does).

## Node plan

1. `n_Start` — callable trigger.
2. `n_Norm` (Groovy) — validate, default the date, `'__none__'` keys for lookups nobody asked for.
3. `n_IfBad` → `n_StBad` — `INVALID_INPUT`, nothing read or written.
4. `n_FtPos` — Position by id, limit 1.
5. `n_FtAttr` — PositionAttribute by `positionId`, limit 500, `hasMore` carried.
6. `n_FtAsg` — PayeePositionAssignment by `positionId`, limit 500, `hasMore` carried.
7. `n_FtTitle` — Title by id (sentinel when not asked), limit 1.
8. `n_FtPayee` — Payee by id (sentinel when not asked), limit 1.
9. `n_Plan` (Groovy, no I/O) — every refusal and every row to write.
10. `n_IfBlk` → `n_StBlk` — the plan's refusal, nothing written.
11. `n_WrPos` — bulk upsert Position (`name`, `active` via SET; empty batch is a no-op).
12. `n_WrAttr` — bulk upsert PositionAttribute (close + open, or correct).
13. `n_WrAsg` — bulk upsert PayeePositionAssignment (close + open, or correct).
14. `n_DelAsg` — delete PayeePositionAssignment `id IN deleteIds` (`['__none__']` → no-op).
15. `n_Done` (Groovy) — `successCount` against planned counts.
16. `n_IfWr` → `n_StPart` `WRITE_INCOMPLETE`, else `n_StOk` `OK`.

Per node that leaves the automation:

- **Fetches** send only an equality on a record id or `positionId`, and project only the
  fields the plan reads. They run after `n_Norm` accepted the request and never on
  `INVALID_INPUT`. Five reads is fixed regardless of history length; nothing is fetched
  per row.
- **`n_WrPos`** sends `{id: positionId, updateFields: SET name / active}` and never
  `positionCode` (the unique key — writing it could collide). Runs only after every guard passed.
- **`n_WrAttr` / `n_WrAsg`** send the close (`SET effectiveEnd`) and the new row with a
  pre-minted `e_` id so the response can name it. `updateFields` is per field, so an
  existing row keeps every property not named. They never run on a refusal.
- **`n_DelAsg`** deletes only ids the plan named, which only happens for a same-day
  emptying of a seat. Otherwise its filter is the sentinel and it matches nothing.

Reused rather than rebuilt: nothing callable exists for "the row in force" yet; the
as-of rule is now in four automations, and this is the flag for extracting it (see Notes).

## Errors

- **A fetch fails** → the run stops with the platform error (`stepError: STOP`) before
  anything is written. Accepted: no partial state is possible there.
- **`n_WrPos` fails** → nothing dated has been written; a retry re-plans the whole edit.
- **`n_WrAttr` fails after `n_WrPos` landed** → name/active changed, title not. The run
  stops with the platform error. A retry re-reads: the name is already right (no write),
  the title plan is made again from an unchanged store. No duplicate is possible,
  because a new row is only planned when the row in force still differs.
- **A batch lands partially** (close written, new row not) → `n_Done` sees the count
  short and answers `WRITE_INCOMPLETE` with which object fell short. The store then has
  a closed row and no successor: the seat reads as having no title / VACANT from the date.
  A retry plans case 5 and opens the missing row. Bulk upsert has been observed to be
  effectively all-or-nothing (runtime-facts 2026-08-24), so this is the unlikely path.

## Changes — the system of changes

| thing | verb | verdict | how would we notice if this is wrong? |
|---|---|---|---|
| `ICM \| Update Position` | create | nothing callable edits a position today — checked on tool and orbit 2026-09-11 | the suite, `validate`, `lint` |
| `ICM \| List Positions` / `Resolve Position Occupant` | read what this writes | *unaffected* — rows written with their own as-of rule and no overlap | suite cases re-read through List Positions after every dated change |
| `ICM \| Calculate Credits` | reads the same dated rows | *accepted* — an edit dated inside an already-calculated period changes what a re-run credits; nothing re-runs automatically (Notes) | a re-run's credits differ from the stored ones |
| `ICM \| Create Position` | writes the same objects | *unaffected* — this reads rows the way Create writes them (`allocationPct` 100, name suffixes) | the suite creates its position through Create Position |
| Sales-Commission-Management Positions drawer | new caller | *cascade* — `UPDATE_POSITION` binding filled in with the provisioned data source, and the result's status union widened with `CONFLICT`, `HISTORY_TOO_LONG`, `WRITE_INCOMPLETE` | the drawer shows the callable's `message` for every non-OK status |
| page data source | create | *cascade* — `ds_update_position` on the app's global page, via `ua-datasource.mjs` | the drawer's Save answers, not `forbidden datasource` |

## Tests

`tests/<workflowId>.json`, run on **tool** against fixtures the suite creates and deletes
itself, all loudly named `KITTEST-UPDPOS-*` and **dated 2030 onwards** so no real period
or seat is touched: two Titles, two Payees (currency `USD`), one Position created through
`ICM | Create Position`. Cases: every input blank · every key omitted · both payeeId and
clearPayee · not-found position / title / payee · rename + deactivate · the same payload
again (no change) · dated title change · assign, re-assign, empty the seat, each re-read
through `ICM | List Positions` on both sides of the date · same-day correction · planted
overlap → `CONFLICT` · cleanup of every fixture row.

## Notes

- **Four copies of the as-of rule** (List Positions, Resolve Position Occupant, Calculate
  Credits, this). Each is suite-tested against the same reading, which is what keeps them
  honest; the next automation that needs it should get a shared step instead.
- **No recalculation trigger.** A dated change inside a calculated period is not
  propagated. Accepted: deciding which periods to re-run is a comp-ops decision, not an
  edit side effect.
- **Concurrent edits** of the same position: two plans read the same store and both
  write; the later close wins. Accepted for an admin screen edited by a handful of people.
- **Future-dated rows are never rewritten.** An edit only ever touches the row in force
  on its date, so a change already scheduled for later still happens.
