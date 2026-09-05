# ICM | List Positions

**Also live on TOOL (PRODUCTION) since 2026-09-05**: id `6a9bcafbc4f2d5527e3c324c` (11 nodes, draft v0),
a SEPARATE copy from the orbit one above — prod mints its own ids. Suite
`tests/6a9bcafbc4f2d5527e3c324c.json` (re-keyed from the orbit suite, same cases) **22/22 green**
against `KITFIX-` fixtures seeded into prod. `validate` + `lint` clean. Deployed
through `deploy.mjs` with all four gates, verified by reading `deploymentState`
back. This is what the `app-1621b11a65c8` code app calls.

**Built state (2026-09-03)**: **DEPLOYED, workflowVersion 2, 11 nodes.**
`ua.mjs validate` clean · `lint.mjs` clean · suite
`tests/6a988a792ada0c631038457a.json` **22/22 green**. Deployed 2026-09-03 with
an explicit human yes, verified by reading `deploymentState` back rather than by
the deploy's 200.

**Renamed 2026-09-03, contract included.** This was `ICM | List Seats` and its
result array was `seats`. Both are now `positions`, because `Position` is what
the object is called and what the Ledger prototype calls it on screen — "seat"
stays as the explanatory metaphor and is no longer a name. The rename cascaded
in one commit: the definition, the suite, the fixture family (`KITFIX-POSITIONS`,
re-seeded), the Positions page's bindings, and this file. A caller still reading
`['data']['seats']` gets nothing, silently — which is exactly why the page was
rebound in the same session as the deploy.

Lint caught one real defect during the build and it is worth recording: the
`positions` array was first mapped as a bare pill (`{{ n_Fold…positions }}`), which
**runs correctly** but shows as unmapped in the builder — the same class of
failure as the `groupId` trap, right at the runtime layer and wrong at the layer
a human opens. The fix is the `{ua:type: "mappedArray", source, items}` shape.

| field | value |
|---|---|
| Token / name | `ICM \| List Positions` (`6a988a792ada0c631038457a`), tags from `kit.config.json` (`icm`), CALLABLE |
| Purpose | A paged, searchable list of positions — optionally with **who occupies each one as of a date**, resolved in bulk. |
| Replaces | Nothing. It exists because the Positions page needs a position picker and **a page may not query `Position` directly** (`docs/architecture.html` layer rule). This is the first callable built purely to keep that rule absolute. |
| Callers | **Pages** — Positions (`docs/pages/positions.md`) for its picker, its filter chips and its counts. Any later admin screen listing positions. **Also the `Sales-Commission-Management` CODE app on tool** (`app-1621b11a65c8`), whose `/organization/positions` screen reads it through dataSource `e_6a9bd839f684ae7710066170`. That app lives in its own repo and there is no `docs/pages/` entry for it — the dependency is recorded HERE because nothing else records it. |
| Authorization | **Any authenticated caller**, same reasoning as `ICM \| Resolve Position Occupant`: the response carries org structure and no money. No amount, quota, attainment or payout field appears in it. Adding one changes this row and the caller check together, or the change is refused. |

## Why occupancy is resolved HERE and not per row

The page shows a status against every position and three counts. The naive build is
a position list plus one `Resolve Position Occupant` call per row — 84 calls for
today's data, thousands later. That is exactly the "API call inside a per-item
loop" `CLAUDE.md` forbids.

So this callable does the same as-of fold **in bulk, in one code node**: three
fetches total regardless of how many positions come back — positions, then every
assignment for those positions in one `IN`, then every referenced payee in one `IN`.

**The as-of rule is identical to `ICM | Resolve Position Occupant`'s** — boundaries
inclusive at both ends, a missing/blank `effectiveEnd` means still held, two
matches is a conflict and never a pick. That rule now lives in two places and
this is the second; the mitigation is that both are tested against the same
fixture family, so a divergence turns a suite red rather than paying somebody
wrongly. If a third caller ever needs it, the fold moves into a shared code
step rather than being copied again.

## Entity study

- **`Position`** — required `positionCode`, `name`; `uniqueKeyFields:
  ["positionCode"]`; optional `active` (**boolean, and a boolean never set is
  MISSING, not false** — so `active` is never filtered on server-side).
- **`PayeePositionAssignment`** — required `name`, `payeeId`, `positionId`,
  `effectiveStart`; optional `effectiveEnd`, `allocationPct`. No unique key:
  overlap is a rule, not an index, which is why `CONFLICT` exists below.
- **`Payee`** — `employeeId` UNIQUE; `currencyId` → Currency. Only
  `employeeId` and `name` are read here; **`currencyId` is deliberately not
  joined**, because a list of positions has no amounts on it and resolving a
  currency nobody displays is a fetch for nothing.

## Period and money

Touches neither. No `periodId`, no amount, no rounding point.

## Input (`setup`)

| field | type | required | blank / default |
|---|---|---|---|
| `search` | string | no | `""` → no search filter, return everything paged |
| `asOfDate` | string | no | `""` → **today, UTC**. `YYYY-MM-DD` or epoch ms, same rule as Resolve Position Occupant |
| `limit` | string | no | `""` → `50`. Clamped to 1..200 |
| `offset` | string | no | `""` → `0` |
| `includeOccupancy` | string | no | `""` → `"true"`. `"false"` skips the two extra fetches and the fold |

Every default is applied INSIDE the automation. Real callers send empty strings
for what they don't fill, so `""` is the value each of these is designed
around, not an edge case.

**Search matches `positionCode` OR `name`, case-insensitively, SERVER-SIDE.**
The filter is built as an object in Groovy and passed to the fetch as one pill —
a nested `OR` group inside the `AND`, which a node's static config cannot
express but the runtime accepts (`notes/runtime-facts.md`, proven 2026-08-24).
Filtering after the fetch instead would break `total` and paging.

## Output

| status | meaning |
|---|---|
| `OK` | the list, however long. An empty result is `OK` with `positions: []`, not an error — a new customer has no positions and that is the first screen they see |
| `INVALID_INPUT` | `asOfDate` unparseable, or `limit`/`offset` non-numeric |

```
status, success, message, asOfDate, total, hasMore, offset, limit,
occupancyResolved (bool), countsTruncated (bool),
counts { total, occupied, vacant, conflict },
positions [ { positionId, positionCode, name, active,
          occupancy, payeeId, employeeId, payeeName, matchCount,
          effectiveStart, effectiveEnd, allocationPct } ]
```

`occupancy` is `OCCUPIED` · `VACANT` · `CONFLICT` · `UNKNOWN` (only when
`includeOccupancy` was false). `required` is
`["status","success","message","total","positions"]` and nothing more.

**`effectiveStart` / `effectiveEnd` / `allocationPct` describe the ONE assignment
that resolved the occupant, and are therefore ABSENT unless `occupancy` is
`OCCUPIED`.** On a VACANT row no assignment covered the date; on a CONFLICT row
several did and naming one would be the guess this callable refuses to make.

**Absent, not `null`** — measured, not assumed (2026-09-05): the runtime DROPS null
properties from a response rather than serialising them, so a suite case asserting
`equals: null` fails with `missing` and a caller must treat the key as optional.
Every "no answer" in this callable's output therefore reads as an absent key, and
`required` still names only the five fields it always sends.

`effectiveEnd` absent on an OCCUPIED row means **open-ended — still held**, the same
"absent means still held" rule the fold applies to the source assignment. So absence
carries two readings and `occupancy` is what separates them: read `effectiveEnd` only
once you have checked `occupancy === 'OCCUPIED'`. Stated here because a caller that
renders `effectiveEnd ?? 'End of Time'` on a VACANT row prints a confident answer
about a position nobody holds.

**`allocationPct` needed the fetch projection widened**, which the first attempt
missed: `n_FtAsg` listed only `positionId`, `payeeId`, `effectiveStart` and
`effectiveEnd`, so the field was never on the row to carry through. A projection is
a contract too — adding an output field means checking that the fetch actually reads
it, and the suite catches this because it asserts a real value (100) rather than a
type.

**This is deliberately NOT the whole occupant story.** `payeeCurrency`,
`payeeCurrencySymbol` and the resolution `message` stay in `ICM | Resolve Position
Occupant`, which a page calls on row select. A list callable that returned
everything a detail panel wants would resolve currency for every row on every
keystroke — the same scaling trap `counts` is fenced off for.

**`counts` counts the CURRENT PAGE, and `countsTruncated` says so.** Counting
occupancy across every position would mean resolving every position on every keystroke,
which is the scaling trap this callable exists to avoid. The page's "Conflicts
2" chip is therefore a count of conflicts *on screen*; if the product wants a
true global conflict count it is a different, aggregate-shaped callable and
should be built as one. Written here rather than discovered when a customer has
4,000 positions.

## Node plan

1. **`n_sTaRt`** START, CALLABLE.
2. **`n_Norm`** Groovy — *"Apply defaults and build the search filter"*. Trims
   every input, applies the defaults above, parses `asOfDate`, clamps `limit`,
   and returns the whole `filters` array. On bad input `valid: false`.
3. **`n_FtPos`** fetch `Position` — filter from `n_Norm`, `page` from `n_Norm`,
   fields `id, properties.positionCode, properties.name, properties.active`.
   - **not sent**: any `active` filter. A boolean never set is MISSING, so
     `active EQUAL true` would silently hide every position nobody ticked.
4. **`n_Ids`** Groovy — the page's `positionId`s, `['__none__']` when empty.
5. **`n_FtAsg`** fetch `PayeePositionAssignment` — `positionId IN` those ids
   AND `effectiveStart LTE asOf`, limit 2000.
   - **not sent**: the `effectiveEnd` half — a missing property does not match
     an `EQUAL ""` filter, so a server-side end filter drops exactly the people
     currently in positions. Closed in memory instead, as in Resolve Position Occupant.
6. **`n_PayIds`** Groovy — payee ids from the surviving assignments, sentinel
   when empty.
7. **`n_FtPay`** fetch `Payee` — `id IN` those, fields `id,
   properties.employeeId, properties.name`.
   - **not sent**: `status` / `terminationDate`. A terminated payee still held
     the position, and filtering them out would rewrite history.
8. **`n_Fold`** Groovy — the as-of fold, per position, plus `counts`.
9. **`n_IfBad`** IF `valid == false` → **`n_StBad`** STOP `INVALID_INPUT`;
   else → **`n_StOk`** STOP `OK`.

Three fetches, whatever the page size. Nesting is one level deep, and every
`groupId` is computed by the build script rather than typed.

## Errors

No writes, so no half-done state and no duplicate-on-retry question. Fetch
failures reach the caller as the platform's error (`fallbackMode: STOP`) —
**accepted debt**, same reasoning as Resolve Position Occupant: an infrastructure
failure is not a business outcome and inventing a status for it tells the caller
to retry something that is not their fault.

`n_FtAsg` truncating at 2000 sets `countsTruncated` and leaves the affected
positions' occupancy honest rather than confidently wrong.

## Changes — the system of changes

| thing | verb | verdict | how would we notice if this is wrong? |
|---|---|---|---|
| `ICM \| Resolve Position Occupant` | unaffected | **unaffected** — no shared node, no call between them. They share a RULE, not code | both suites use `tests/fixtures/positions.json`; a divergence in the as-of rule turns one of them red |
| The as-of rule existing twice | create | **accepted** — reason and mitigation above | the shared fixture family; a third caller triggers extraction |
| Positions page | create | **cascade** — its spec's open question 1 is answered by this callable, and its Callables table gains this token | `docs/pages/` is the only record of a page→callable dependency; a page in the builder not listed there is drift |
| `Position` / `PayeePositionAssignment` / `Payee` | unaffected | **unaffected** — read-only, no schema change | `ua.mjs snap-types --tag icm` diff; a renamed field breaks the `fields` projection and the suite goes red |
| The layer rule ("pages never touch objects") | handled already | **handled already** — this callable is what keeps it absolute rather than carved out | if a data source over `Position` ever appears in the app, `get_data_sources` shows it and the rule was abandoned quietly |
| **This contract, 2026-09-05** | change the contract | **cascade** — three fields ADDED to `positions[]`, none renamed or removed, so every existing caller keeps reading exactly what it read. The Positions page is updated in the same change to render them; the suite gains the cases below | a caller reading `effectiveEnd` without checking `occupancy` first shows "End of Time" on a vacant position — the suite pins `null` on VACANT and CONFLICT for exactly that |
| `n_PayIds` projection | change the contract | **cascade** — it dropped these three fields on the way into the fold; it now carries them, and its declared output schema says so. No extra fetch, no extra call | the suite's OCCUPIED cases assert real values, so a projection that silently drops one again goes red |
| `ICM \| Resolve Position Occupant` | unaffected | **unaffected** — it already returns these three and keeps owning the richer detail answer (currency, message). This change does not duplicate it, it stops the LIST from being useless for a row summary | its own suite is untouched; if the two ever disagree on the same assignment, both suites run off one fixture family and one of them goes red |
| Global conflict count | accepted | **accepted** — `counts` is per page, stated in the Output section and surfaced as `countsTruncated` | the page labels the chip as on-screen; a product ask for a true global count becomes its own aggregate callable |

## Tests

`tests/6a988a792ada0c631038457a.json` — **22 cases, all green 2026-09-03**, against the `positions` fixture family
(`node scripts/fixtures.mjs seed positions`). Read-only, safe to re-run.

| case | asserts |
|---|---|
| no arguments at all (every field `""`) | `OK`, defaults applied, positions returned |
| `search` matching a positionCode | only that position, `total` correct — proves the OR group narrows server-side |
| `search` matching a name, different case | same position — `ICONTAINS` is case-insensitive |
| `search` matching nothing | `OK`, `positions: []`, `total: 0` — empty is not an error |
| `limit`/`offset` paging | `hasMore` true then false, no position appearing on both pages |
| `includeOccupancy: "false"` | `occupancy: "UNKNOWN"`, `occupancyResolved: false` |
| a date inside a closed assignment | that position `OCCUPIED` with the right `employeeId` |
| a date before every assignment | that position `VACANT` |
| the contested position on an overlap date | `CONFLICT`, `matchCount: 2`, no payee named |
| the open-ended assignment | `OCCUPIED` — the case a server-side `effectiveEnd` filter would break |
| `asOfDate: "not-a-date"` | `INVALID_INPUT` |
| `limit: "abc"` | `INVALID_INPUT` |
| a date inside a closed assignment | `effectiveStart`/`effectiveEnd` are that assignment's real epochs, `allocationPct` its real value (100) |
| the open-ended assignment | `effectiveStart` set, `effectiveEnd` **absent** — open-ended, still held |
| a position nobody ever filled | all three **absent**, because VACANT means no assignment applied |
| the contested position on an overlap date | all three **absent**, because CONFLICT means the callable refused to pick one |
| `includeOccupancy: "false"` | all three **absent** — the fold never ran |
| counts on a page containing occupied + vacant + conflict | `counts` adds up to the page's position count |

## Notes

- **Accepted debt**: fetch failures surface as platform errors; `counts` is
  per-page; the as-of rule exists in two callables. Each has its reason above.
- `asOfDate` defaulting to **today UTC** is the one default that could surprise
  a caller in another timezone. It is stated in the response as `asOfDate` so a
  page always knows which day it got, rather than assuming.
