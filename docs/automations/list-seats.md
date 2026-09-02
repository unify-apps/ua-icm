# ICM | List Seats

**Built state (2026-09-03)**: **draft v1, 11 nodes.** `ua.mjs validate` clean ·
`lint.mjs` clean · suite `tests/6a988a792ada0c631038457a.json` **22/22 green**.
**NOT DEPLOYED** — callers only ever reach the deployed copy, so the Seat
Directory page cannot use it yet. Deploying needs an explicit human yes.

Lint caught one real defect during the build and it is worth recording: the
`seats` array was first mapped as a bare pill (`{{ n_Fold…seats }}`), which
**runs correctly** but shows as unmapped in the builder — the same class of
failure as the `groupId` trap, right at the runtime layer and wrong at the layer
a human opens. The fix is the `{ua:type: "mappedArray", source, items}` shape.

| field | value |
|---|---|
| Token / name | `ICM \| List Seats` (`6a988a792ada0c631038457a`), tags from `kit.config.json` (`icm`), CALLABLE |
| Purpose | A paged, searchable list of seats — optionally with **who occupies each one as of a date**, resolved in bulk. |
| Replaces | Nothing. It exists because the Seat Directory page needs a seat picker and **a page may not query `Position` directly** (`docs/architecture.html` layer rule). This is the first callable built purely to keep that rule absolute. |
| Callers | **Pages** — Seat Directory (`docs/pages/seat-directory.md`) for its picker, its filter chips and its counts. Any later admin screen listing seats. |
| Authorization | **Any authenticated caller**, same reasoning as `ICM \| Resolve Seat Occupant`: the response carries org structure and no money. No amount, quota, attainment or payout field appears in it. Adding one changes this row and the caller check together, or the change is refused. |

## Why occupancy is resolved HERE and not per row

The page shows a status against every seat and three counts. The naive build is
a seat list plus one `Resolve Seat Occupant` call per row — 84 calls for
today's data, thousands later. That is exactly the "API call inside a per-item
loop" `CLAUDE.md` forbids.

So this callable does the same as-of fold **in bulk, in one code node**: three
fetches total regardless of how many seats come back — seats, then every
assignment for those seats in one `IN`, then every referenced payee in one `IN`.

**The as-of rule is identical to `ICM | Resolve Seat Occupant`'s** — boundaries
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
  joined**, because a list of seats has no amounts on it and resolving a
  currency nobody displays is a fetch for nothing.

## Period and money

Touches neither. No `periodId`, no amount, no rounding point.

## Input (`setup`)

| field | type | required | blank / default |
|---|---|---|---|
| `search` | string | no | `""` → no search filter, return everything paged |
| `asOfDate` | string | no | `""` → **today, UTC**. `YYYY-MM-DD` or epoch ms, same rule as Resolve Seat Occupant |
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
| `OK` | the list, however long. An empty result is `OK` with `seats: []`, not an error — a new customer has no seats and that is the first screen they see |
| `INVALID_INPUT` | `asOfDate` unparseable, or `limit`/`offset` non-numeric |

```
status, success, message, asOfDate, total, hasMore, offset, limit,
occupancyResolved (bool), countsTruncated (bool),
counts { total, occupied, vacant, conflict },
seats [ { positionId, positionCode, name, active,
          occupancy, payeeId, employeeId, payeeName, matchCount } ]
```

`occupancy` is `OCCUPIED` · `VACANT` · `CONFLICT` · `UNKNOWN` (only when
`includeOccupancy` was false). `required` is
`["status","success","message","total","seats"]` and nothing more.

**`counts` counts the CURRENT PAGE, and `countsTruncated` says so.** Counting
occupancy across every seat would mean resolving every seat on every keystroke,
which is the scaling trap this callable exists to avoid. The page's "Conflicts
2" chip is therefore a count of conflicts *on screen*; if the product wants a
true global conflict count it is a different, aggregate-shaped callable and
should be built as one. Written here rather than discovered when a customer has
4,000 seats.

## Node plan

1. **`n_sTaRt`** START, CALLABLE.
2. **`n_Norm`** Groovy — *"Apply defaults and build the search filter"*. Trims
   every input, applies the defaults above, parses `asOfDate`, clamps `limit`,
   and returns the whole `filters` array. On bad input `valid: false`.
3. **`n_FtPos`** fetch `Position` — filter from `n_Norm`, `page` from `n_Norm`,
   fields `id, properties.positionCode, properties.name, properties.active`.
   - **not sent**: any `active` filter. A boolean never set is MISSING, so
     `active EQUAL true` would silently hide every seat nobody ticked.
4. **`n_Ids`** Groovy — the page's `positionId`s, `['__none__']` when empty.
5. **`n_FtAsg`** fetch `PayeePositionAssignment` — `positionId IN` those ids
   AND `effectiveStart LTE asOf`, limit 2000.
   - **not sent**: the `effectiveEnd` half — a missing property does not match
     an `EQUAL ""` filter, so a server-side end filter drops exactly the people
     currently in seats. Closed in memory instead, as in Resolve Seat Occupant.
6. **`n_PayIds`** Groovy — payee ids from the surviving assignments, sentinel
   when empty.
7. **`n_FtPay`** fetch `Payee` — `id IN` those, fields `id,
   properties.employeeId, properties.name`.
   - **not sent**: `status` / `terminationDate`. A terminated payee still held
     the seat, and filtering them out would rewrite history.
8. **`n_Fold`** Groovy — the as-of fold, per seat, plus `counts`.
9. **`n_IfBad`** IF `valid == false` → **`n_StBad`** STOP `INVALID_INPUT`;
   else → **`n_StOk`** STOP `OK`.

Three fetches, whatever the page size. Nesting is one level deep, and every
`groupId` is computed by the build script rather than typed.

## Errors

No writes, so no half-done state and no duplicate-on-retry question. Fetch
failures reach the caller as the platform's error (`fallbackMode: STOP`) —
**accepted debt**, same reasoning as Resolve Seat Occupant: an infrastructure
failure is not a business outcome and inventing a status for it tells the caller
to retry something that is not their fault.

`n_FtAsg` truncating at 2000 sets `countsTruncated` and leaves the affected
seats' occupancy honest rather than confidently wrong.

## Changes — the system of changes

| thing | verb | verdict | how would we notice if this is wrong? |
|---|---|---|---|
| `ICM \| Resolve Seat Occupant` | unaffected | **unaffected** — no shared node, no call between them. They share a RULE, not code | both suites use `tests/fixtures/seats.json`; a divergence in the as-of rule turns one of them red |
| The as-of rule existing twice | create | **accepted** — reason and mitigation above | the shared fixture family; a third caller triggers extraction |
| Seat Directory page | create | **cascade** — its spec's open question 1 is answered by this callable, and its Callables table gains this token | `docs/pages/` is the only record of a page→callable dependency; a page in the builder not listed there is drift |
| `Position` / `PayeePositionAssignment` / `Payee` | unaffected | **unaffected** — read-only, no schema change | `ua.mjs snap-types --tag icm` diff; a renamed field breaks the `fields` projection and the suite goes red |
| The layer rule ("pages never touch objects") | handled already | **handled already** — this callable is what keeps it absolute rather than carved out | if a data source over `Position` ever appears in the app, `get_data_sources` shows it and the rule was abandoned quietly |
| Global conflict count | accepted | **accepted** — `counts` is per page, stated in the Output section and surfaced as `countsTruncated` | the page labels the chip as on-screen; a product ask for a true global count becomes its own aggregate callable |

## Tests

`tests/6a988a792ada0c631038457a.json` — **22 cases, all green 2026-09-03**, against the `seats` fixture family
(`node scripts/fixtures.mjs seed seats`). Read-only, safe to re-run.

| case | asserts |
|---|---|
| no arguments at all (every field `""`) | `OK`, defaults applied, seats returned |
| `search` matching a positionCode | only that seat, `total` correct — proves the OR group narrows server-side |
| `search` matching a name, different case | same seat — `ICONTAINS` is case-insensitive |
| `search` matching nothing | `OK`, `seats: []`, `total: 0` — empty is not an error |
| `limit`/`offset` paging | `hasMore` true then false, no seat appearing on both pages |
| `includeOccupancy: "false"` | `occupancy: "UNKNOWN"`, `occupancyResolved: false` |
| a date inside a closed assignment | that seat `OCCUPIED` with the right `employeeId` |
| a date before every assignment | that seat `VACANT` |
| the contested seat on an overlap date | `CONFLICT`, `matchCount: 2`, no payee named |
| the open-ended assignment | `OCCUPIED` — the case a server-side `effectiveEnd` filter would break |
| `asOfDate: "not-a-date"` | `INVALID_INPUT` |
| `limit: "abc"` | `INVALID_INPUT` |
| counts on a page containing occupied + vacant + conflict | `counts` adds up to the page's seat count |

## Notes

- **Accepted debt**: fetch failures surface as platform errors; `counts` is
  per-page; the as-of rule exists in two callables. Each has its reason above.
- `asOfDate` defaulting to **today UTC** is the one default that could surprise
  a caller in another timezone. It is stated in the response as `asOfDate` so a
  page always knows which day it got, rather than assuming.
