# ICM | Resolve Seat Occupant

**Built state (2026-09-03)**: **v1, 19 nodes — DEPLOYED.** `ua.mjs validate`
clean · `lint.mjs` clean · suite `tests/6a9879742ada0c631031e64b.json`
**24/24 green**. Deployed by Sarthak on 2026-09-03; verified by reading
`deploymentState` back, not by trusting the deploy call:
`status: DEPLOYED`, `workflowVersion: 1`, matching the record's own `version: 1`
— so the deployed copy IS the current draft and callers reach this behaviour.

**It is live, which changes the rules for editing it.** From here on a change to
this automation is a change to something callers already depend on: the draft
may move freely, but the moment it is redeployed every caller sees the new
contract. Walk the Changes table below before touching it.

| field | value |
|---|---|
| Token / name | `ICM \| Resolve Seat Occupant` (`6a9879742ada0c631031e64b`), tags from `kit.config.json` (`icm`), CALLABLE |
| Purpose | Given a `Position` and a date, say who held that seat **on that date** — or say precisely why the question has no single answer. |
| Replaces | Nothing yet. Today the question is unanswerable: `PayeePositionAssignment` was created 2026-09-03 and nothing reads it. |
| Callers | **Pages** — `docs/pages/seat-directory.md` (specified, not built), and any screen that shows "who owns this account/territory as of …". **Not the calculation engine** — see the loud note below. |
| Authorization | **Open to any authenticated caller, deliberately.** It returns org structure (who sits in which seat), not money. No amount, no quota, no payout field appears in its response. The moment a money field is added here, this row changes and the callable needs a caller check — that is written into the Changes table so the omission is not silent. |

## This callable is NOT for the calculation path

Worth saying before anything else, because the mistake would be natural and
expensive. Resolving one seat costs one call. The engine resolves a seat for
*every transaction* — hundreds of thousands in a quarter — so calling this per
transaction is exactly the "API call inside a per-item loop" that
`CLAUDE.md` forbids and that turns a 30-second run into an overnight one.

**The engine bulk-fetches `PayeePositionAssignment` once and does the same
as-of resolution in Groovy**, using the identical rules written below. That
duplication is deliberate and is the one place in this product where the same
logic legitimately lives twice: once as an interactive callable, once as an
in-memory fold. The rules are specified here, in one place, so the two cannot
drift silently — and the engine's version is tested against the same fixtures.

## Entity study

Read from `snapshots/orbit/entity-types/`, not assumed.

- **`Position`** — required `positionCode`, `name`; `uniqueKeyFields: ["positionCode"]`;
  no FKs out. Written by: nothing yet.
- **`PayeePositionAssignment`** — required `name`, `payeeId`, `positionId`,
  `effectiveStart`; optional `effectiveEnd`, `allocationPct`.
  `uniqueKeyFields: []` — **deliberately empty**. FKs out: `payeeId` →
  `ENTITY_ID:Payee`, `positionId` → `ENTITY_ID:Position`, both with
  `foreignKeyConstraintEnforced: false`, so a dangling id is possible and this
  flow must survive one. Written by: nothing yet.
- **`Payee`** — required `employeeId`, `name`, `currency`, `status`;
  `uniqueKeyFields: ["employeeId"]`; FKs out: `currencyId` → `ENTITY_ID:Currency`,
  `userId` → `USER`. Read-only here. **Note the dead field**: `currency` (a plain
  string) still exists beside `currencyId` and is still marked `required`, a
  leftover of retyping-by-addition. This flow reads `currencyId`, the real one.
- **`Currency`** — required `code`, `name`; `uniqueKeyFields: ["code"]`.
  Read-only here, and read WHOLE rather than filtered: it is a handful of rows.

**The uniqueness that does not exist is the important part.** Mongo cannot
express "no two assignments for the same position with overlapping date
ranges", so nothing stops two rows covering 2026-03-14. This callable does not
paper over that: two matches is `AMBIGUOUS`, a distinct status, never a pick.
The build spec's `asOf()` helper says the same thing ("more than one match
throws; that is a data bug, not something to pick from arbitrarily") and this is
that rule with a status code instead of an exception.

## Period and money

Touches neither. No `periodId` is read or written, no amount is returned, so
there is no period guard and no rounding point. This is the reason the
authorization row above is as permissive as it is.

**Effective dating** is the whole subject of this flow. See the date rules.

## Input (`setup`)

| field | type | required | blank-string behaviour |
|---|---|---|---|
| `positionId` | string — the platform id of a `Position` | yes | `""` → `INVALID_INPUT`, never a fetch on an empty id |
| `asOfDate` | string | yes | `""` → `INVALID_INPUT` |

**`asOfDate` and its timezone rule.** Accepted in two forms, because real
callers send both: `YYYY-MM-DD`, or a string of epoch milliseconds. A
`YYYY-MM-DD` is interpreted as **midnight UTC on that day**, and that choice is
stated here rather than left to whichever node parses it first. The date a deal
closed decides which quarter it pays in, so "2026-03-31" resolving to a
different instant in two timezones is a pay bug, not a display bug.

`allocationPct` is carried through untouched. It is not applied to anything
here — this callable answers *who*, not *how much*.

## Output

Always `status`, `success`, `message`. Everything else is present only on
`RESOLVED`, and `required` reflects exactly that.

| status | success | meaning | what the caller should do |
|---|---|---|---|
| `RESOLVED` | true | exactly one assignment covers the date | show the payee |
| `VACANT` | false | the seat exists, nobody held it that day | show "unoccupied on <date>" — this is normal, not an error |
| `AMBIGUOUS` | false | 2+ assignments cover the date — a data bug | show both, and route to whoever fixes assignments. `matchCount` says how many |
| `POSITION_NOT_FOUND` | false | no `Position` with that id | the caller sent a stale id |
| `PAYEE_NOT_FOUND` | false | the assignment points at a `Payee` that does not exist | dangling FK; FK constraints are not enforced on this object |
| `INVALID_INPUT` | false | blank or unparseable `positionId` / `asOfDate` | fix the request |

Result fields: `status`, `success`, `message`, `asOfDate` (echoed, normalised to
`YYYY-MM-DD`), `asOfEpoch`, `positionId`, `positionCode`, `positionName`,
`payeeId`, `employeeId`, `payeeName`, `payeeCurrency` (the CODE, joined from
the `Currency` lookup), `payeeCurrencySymbol`, `effectiveStart`,
`effectiveEnd` (empty string when open-ended — the seat is still held),
`allocationPct`, `matchCount`.

`required` is `["status", "success", "message", "matchCount"]` and nothing more.

## Node plan

All reads. Nothing leaves this automation except three storage fetches, so the
four questions are answered per fetch.

1. **`n_sTaRt`** START, CALLABLE. Setup `{positionId, asOfDate}`.
2. **`n_Norm`** Groovy — *"Normalise the as-of date and reject blanks"*. Trims
   both inputs, parses `asOfDate` by the rule above, emits `asOfEpoch`,
   `asOfDay`, `valid`, `reason`. On invalid input `asOfEpoch` is `0`, which
   makes the fetch below match nothing — harmless, because `n_Pick` checks
   `valid` before it looks at any row.
3. **`n_FtPos`** fetch `Position`.
   - **sent**: `id EQUAL {{ positionId }}`, `limit 1`, fields
     `id, properties.positionCode, properties.name`.
   - **not sent**: `active` — the flow answers a historical question, and a seat
     being closed today does not change who sat in it in March. Filtering on it
     would silently return `POSITION_NOT_FOUND` for every retired seat.
   - **when**: always. **not called**: never.
4. **`n_FtAsg`** fetch `PayeePositionAssignment`.
   - **sent**: `positionId EQUAL` AND `effectiveStart LESS_THAN_EQUAL asOfEpoch`,
     `limit 200`, fields `id, properties.payeeId, properties.effectiveStart,
     properties.effectiveEnd, properties.allocationPct`.
   - **not sent**: the `effectiveEnd` half of the window. **This is deliberate
     and it is the sharpest configuration decision in the flow.** An open-ended
     assignment has `effectiveEnd` *missing*, and a MISSING property does not
     match an `EQUAL ""` filter (`notes/runtime-facts.md`, proven 2026-08-25) —
     so a server-side `effectiveEnd >= asOf OR effectiveEnd is blank` would
     silently drop exactly the rows that matter most: the people currently in
     the seat. The `effectiveStart` half is still applied server-side because it
     is safe and it is what keeps the row count small.
   - **when**: always. **not called**: never.
   - **limit 200**: one seat's assignment history. A seat changing hands 200
     times is not a real seat, but silence past the limit is how a bulk fetch
     lies, so `n_Pick` compares `total` against the rows it received and returns
     `AMBIGUOUS` with a truncation message rather than a confident wrong answer.
5. **`n_Ids`** Groovy — *"Collect the candidate payee ids for one bulk lookup"*.
   Applies the `effectiveEnd` half of the window in memory (missing / blank /
   `>= asOf` all count as still open), and emits the surviving `payeeIds`. Emits
   the `['__none__']` sentinel when empty, the house pattern, so the fetch below
   is a clean no-op rather than an unfiltered scan.
6. **`n_FtPay`** fetch `Payee`.
   - **sent**: `id IN {{ payeeIds }}`, fields `id, properties.employeeId,
     properties.name, properties.currency`.
   - **not sent**: `status`, `terminationDate` — a terminated payee still held
     the seat in March and still gets paid for it. Filtering them out would
     silently rewrite history.
   - **when**: always (the sentinel makes the empty case safe). **not called**: never.
7. **`n_FtCur`** fetch `Currency` — *"Resolve the payee's currency lookup to its code"*.
   - **sent**: `active EXISTS`, fields `id, properties.code, properties.symbol`.
     The whole table, because it is a handful of rows and an `IN` over candidate
     ids would cost the same one call.
   - **not sent**: no id filter. **Why the fetch exists at all**: `Payee.currencyId`
     is a lookup, so the id alone is useless to a screen — and the page contract
     forbids a page reaching around a callable to an object to resolve it. The
     join belongs here.
   - **NOT cached**: `options.cacheConfig` exists (`notes/runtime-facts.md`) and
     this is textbook slowly-changing data, but its exact JSON shape is unproven
     in either corpus. Guessing node config is how a silent no-op ships, and
     caching two rows saves nothing measurable. Revisit when a real read path
     needs it.
   - **when**: always. **not called**: never.
8. **`n_Pick`** Groovy — *"Decide the outcome and explain it"*. One node owns the
   whole decision, so there is exactly one place the as-of rule lives. Emits
   `outcome` plus every result field.
9. **`n_IfOk`** IF `outcome == RESOLVED` → **`n_StOk`** STOP `RESOLVED`.
10. **`n_IfAmb`** IF `outcome == AMBIGUOUS` → **`n_StAmb`** STOP `AMBIGUOUS`.
11. **`n_IfVac`** IF `outcome == VACANT` → **`n_StVac`** STOP `VACANT`.
12. **`n_IfBad`** IF `outcome == INVALID_INPUT` → **`n_StBad`** STOP `INVALID_INPUT`.
13. **`n_IfNoPay`** IF `outcome == PAYEE_NOT_FOUND` → **`n_StNoPay`** STOP
    `PAYEE_NOT_FOUND`; else → **`n_StNoPos`** STOP `POSITION_NOT_FOUND`.

Every STOP node's TYPE is `STOP` with `callables_return_to_automation`, and each
carries a different status. The IF chain nests five deep, so every node's
`groupId` carries its full branch path — the trap that pruned three nodes off
`Check Period Writable` on 2026-09-02. The paths are computed by the build
script, never typed by hand, and the node count is re-read after the create.

## Errors

No writes, so there is no half-done state and no duplicate-on-retry question.
The flow is idempotent by construction: the same inputs against unchanged data
return the same answer.

| failure | what the caller sees |
|---|---|
| `n_FtPos` / `n_FtAsg` / `n_FtPay` errors | `fallbackMode: STOP` — the run dies and the caller gets the platform error. **Accepted debt**: a storage fetch failing is an infrastructure failure, not a business outcome, and inventing a status for it would tell the caller to retry something that is not their fault. Recorded here so the omission is a decision. |
| assignment row with a blank `payeeId` | treated as a dangling reference → `PAYEE_NOT_FOUND`, not a crash |
| `n_FtAsg` truncated at 200 | `AMBIGUOUS` with a truncation message, never a confident answer from a partial set |

## Changes — the system of changes

| thing | verb | verdict | how would we notice if this is wrong? |
|---|---|---|---|
| `Position`, `PayeePositionAssignment`, `Payee` objects | create | **cascade** — created 2026-09-03 in this same commit, specs in `objects/`, snapshots refreshed | `ua.mjs snap-types --tag icm` diff; a renamed field breaks the fetch's `fields` projection and the suite goes red |
| The calculation engine's in-memory as-of fold | create (future) | **accepted** — the same rule will exist twice, once here and once in Groovy, for the performance reason stated above | the engine's fixtures reuse this suite's cases; if the two disagree, one of them fails |
| `docs/model/00-domain-model.md` (participant-centric `icmHierarchy` / `icmPlanAssignment`) | change the contract | **cascade** — the model doc is now wrong and is rewritten seat-centric in this commit | the doc names objects; `types --tag icm` lists what exists; a name in the doc that is not in that list is the bug |
| `docs/architecture.md` register and map | change the contract | **cascade** — updated in this commit | the file's own rule: an asset not in the register is not done |
| Pages that will call this | create (future) | **unaffected today** — no page exists. The first one that does gets a row in `docs/pages/` naming this token | `docs/pages/` is the only record; a callable with no page listing it and a page in the builder is drift |
| Authorization | create | **accepted** — open to any authenticated caller because the response carries no money. Written into the Authorization row with the trigger that would change it | a reviewer adding an amount field to the result must cross this row; the suite asserts the result field list |
| `Title` / `PositionAttribute` | create | **unaffected** — created alongside, but this flow does not read them. A seat's title is a separate question from its occupant | — |

## Tests

`tests/6a9879742ada0c631031e64b.json` — **24 cases, all green 2026-09-03.**
Every status has a case. The fixture family is `tests/fixtures/seats.json`,
seeded by `node scripts/fixtures.mjs seed seats`; every record's business key
starts with `KITFIX-` so it can never be confused with real data.

**No case hardcodes a platform id.** Each one finds its fixture by business key
first (`entityFind`, added to `regress.mjs` for this suite) — ids are minted per
environment and per reseed, so a suite pinned to one is green only on the machine
that wrote it. The suite is read-only and safe to re-run.

| case | asserts |
|---|---|
| happy path — date inside a closed range | `RESOLVED`, the right `payeeId`, `matchCount: 1` |
| happy path — open-ended assignment (no `effectiveEnd`) | `RESOLVED`. **The case that matters most**: it is the one a server-side `effectiveEnd` filter would have broken, and it would have broken for the people currently in seats |
| date one day before `effectiveStart` | `VACANT` |
| date one day after `effectiveEnd` | `VACANT` |
| exactly on `effectiveStart` / exactly on `effectiveEnd` | `RESOLVED` both — boundaries are inclusive, asserted rather than assumed |
| two overlapping assignments | `AMBIGUOUS`, `matchCount: 2` |
| unknown `positionId` | `POSITION_NOT_FOUND` |
| assignment pointing at a deleted payee | `PAYEE_NOT_FOUND` |
| all-empty-strings payload | `INVALID_INPUT`, no fetch on a blank id |
| `asOfDate` as epoch millis | `RESOLVED` — the second accepted input form |
| `asOfDate` = "not-a-date" | `INVALID_INPUT` |
| `asOfDate` = "2026-02-30" (date-shaped, not a real day) | `INVALID_INPUT` — a regex alone would have passed this |
| a seat held by a TERMINATED payee | `RESOLVED` — history does not change because someone left |
| a payee paid in a different currency | `RESOLVED` with **that payee's** code, proving the join picks the right row rather than the first |

## Notes

- **Accepted debt**: storage-fetch infrastructure failures reach the caller as
  the platform's error rather than a status. Reason in the Errors table.
- **Accepted debt**: the as-of rule will exist twice once the engine is built.
  Reason and mitigation in the Changes table.
- **Boundaries are inclusive at both ends** (`effectiveStart <= asOf <= effectiveEnd`).
  A same-day handover therefore reads as `AMBIGUOUS`, which is the honest
  answer: two people cannot each be the sole occupant on the same day. If the
  business wants half-open ranges (`effectiveEnd` exclusive), that is a
  one-line change here and a rewrite of every fixture — decide it before the
  first real assignment is loaded, not after.
- **Open question 1 (multi-currency)** touches this indirectly: `payeeCurrency`
  is returned so that a caller never has to guess which currency a seat's
  occupant is paid in.
- Probed 2026-09-03 and relied on here: a MISSING property does not match an
  `EQUAL ""` filter; an empty `IN` list is a safe no-op; `fields` projections
  need the `properties.` prefix or rows come back with no properties at all.
