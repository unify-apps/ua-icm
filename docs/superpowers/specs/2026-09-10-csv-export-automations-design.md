# CSV export automations for Plans, Positions and Rules

Date: 2026-09-10
Status: approved design, not yet implemented
Decided by: krish.sharma

## Why

The Plans, Positions and Rules pages export CSV by assembling the file in the browser
(`app/src/lib/csv.ts`). `ICM | Export Titles CSV` does it server-side: an automation
writes the file with the platform's own CSV node and answers with `fileDetails`, which
the app turns into a signed URL and saves as a blob.

Two patterns for one job is one too many. **Decision: converge on the server-side
automation, and build the three exports as standalone automations mirroring Titles**
(approach "A"). An alternative — adding a CSV branch to the existing list automations,
so the display names would have exactly one implementation — was considered and
rejected in favour of uniform, isolated export automations.

That decision is recorded honestly here because it has a cost, stated in
"Duplication and how it is contained" below.

## Scope

Three new automations, their suites, docs, data sources and deploys; the app rewired to
call them; the client-side CSV module deleted.

Out of scope: `ICM | Export Titles CSV` itself, which already works and is someone
else's recent work. It stays standalone, so after this change all four exports share the
**app-side** contract and the internals of three of them are new.

## The automations

| name | object | notes |
|---|---|---|
| `ICM | Export Plans CSV` | `Plan` (+ `PlanAssignment`, `Title`, `Position`, `Rule`) | joins five bulk reads |
| `ICM | Export Positions CSV` | `Position` (+ the occupancy fold's objects) | copies the fold |
| `ICM | Export Rules CSV` | `Rule` | one automation, `stage` selects the half |

### Node shape, per automation

Mirrors `ICM | Export Titles CSV`:

```
n_sTaRt   Callable trigger
n_Norm    Groovy: validate the request, build the STORAGE filter
n_IfBad   Condition: did validation fail?
n_StBad   Respond: refused before any fetch
n_Fetch   Fetch records, includeTotalCount, limit = rowCap, NO offset
…         object-specific resolution nodes (see below)
n_Rows    Groovy: flatten to the CSV node's row shape, compute status/truncated
n_Write   csv_by_unifyapps_list_to_csv_file
n_StOk    Respond: the file — an empty result is OK, not an error
```

`n_Write` inputs follow Titles exactly: `fileType: 'csv'`, `headerType: 'STATIC'`,
`encoding: 'UTF-8'`, `quote: '"'`, `delimiter: ','`, `quoteMode: 'MINIMAL'`,
`skipHeaderRow: false`, `keepExactFileName: false`, `dataSource` bound to the row array,
and `staticHeaders` as `{key: 'Column Label', value: '{{ n_Rows.outputs.result.<rows>[0].<field> }}'}`
— where `[0]` denotes the current element, the same convention the mapped-array
parameter envelope uses.

### Inputs

Every input crosses as a string except `filter`, which is an object.

| input | all three | notes |
|---|---|---|
| `search` | yes | the same OR group the matching list callable uses |
| `filter` | yes | the caller's filter in the PLATFORM WIRE dialect |
| `maxRows` | yes | runaway guard; default and ceiling 50000, floor 1, as Titles |
| `asOfDate` | Positions only | the date occupancy is resolved as of |
| `stage` | Rules only | `credit` or `payout`; required |

**`filter` is a deliberate addition over Titles.** Titles' export takes `search` and
`maxRows` only and always writes the whole catalog. All three of these pages have a
FilterBuilder, and the exports they are replacing wrote the filtered set, so dropping
the filter would be a regression. The wire→storage translation, the per-object `FIELDS`
whitelist and the operator sets are copied from the matching list callable's `n_Norm`;
an unfilterable field or an unsupported operator is refused as `INVALID_INPUT` rather
than ignored.

**Paging is deliberately ignored.** No `offset`. An export is not a page of the screen.
`maxRows` is a runaway guard, and hitting it answers `TRUNCATED` rather than handing
back a short file quietly.

**`stage` is the Rules export's identity, not a filter the caller can bend.** It is
validated against exactly `credit` and `payout`, and applied as a pinned leaf ANDed
above the caller's filter, so a payout rule can never appear in a credit export however
the caller filters — the guarantee `ICM | List Credit Rules` already makes in its own
`n_Norm`. Implemented as a filter leaf rather than a graph branch: the two stages are
rows in one table with identical columns, so there is nothing for an `IF` to route
between.

### Response

Identical to Titles, so one app-side helper serves all four:

```
status      OK | TRUNCATED | INVALID_INPUT
success     boolean
message     human-readable, safe to show
total       rows written to the file
matched     rows matching the filter server-side (not capped by rowCap)
truncated   matched > total
fileDetails { name, source, … } — the CSV node's own output
```

`status` is computed in `n_Rows`, not written as a literal on the STOP node, because
only that node can know whether the file is short.

## Columns

Positions and Rules export the resolved names and deliberately omit record ids
(`payeeId`, `positionId`, `recordId`) — an id under a heading is a column nobody can
use.

- **Plans** — Plan ID, Plan Name, Period, Status, Description, Credit Rules, Payout
  Rules, Credit Rule Count, Payout Rule Count, Assigned Titles, Assigned Positions,
  Start Date, End Date. Multi-value cells join with `; ` — a comma inside a cell reads
  as a column even when quoted correctly.
- **Positions** — Position Code, Position, Title, Person, Employee ID, Occupancy,
  Active, Assignments On Date, Assignment Start, Assignment End, Allocation %, Title
  Effective From. The window columns are EMPTY unless occupancy is `OCCUPIED`: a vacant
  seat has no assignment and a contested one has several, so naming a window would
  invent an answer the fold deliberately refuses to give. Held with no end date reads
  `Open-ended`, which is a real state and not a gap.
- **Rules** — Rule ID, Rule Name, Rule Type, Stage, Result, Conditions, Description,
  Tags, Active Start, Active End. An absent bound is an empty cell: a rule with neither
  is in force for all time, which is not the same as unknown.

Dates are written `YYYY-MM-DD` in UTC. The records store midnight UTC, so UTC recovers
the day that was entered; rendering in the viewer's zone would shift a stored date to
the previous day anywhere west of UTC.

## Name resolution per automation

- **Rules** — copy the result-name lookup from `ICM | List Credit Rules`' shape node.
- **Positions** — copy the occupancy fold from `ICM | List Positions` **verbatim**.
  `titleName` and `payeeName` are produced by that fold, not stored on the row, so the
  export cannot skip it. Copying the text unchanged at least makes the two identical on
  day one.
- **Plans** — five bulk fetches (`Plan`, `PlanAssignment`, `Title`, `Position`, `Rule`)
  joined in one node. This is where the standalone approach is genuinely better than a
  branch on the list callable, which would have needed one `Get Plan` per plan. An
  unresolved name falls back to its id rather than to an empty cell: a plan still
  pointing at a deleted title is a real state worth seeing in an export.

## Duplication and how it is contained

Approach A means the occupancy fold and the result-name lookup each exist twice. Two
implementations of "who held this seat on this date" is how an exported file comes to
disagree with the screen about someone's commission, and this is pay data.

The containment is a test, not a comment. **Each suite gets a cross-check case** that
runs the export automation and the matching list callable with the same `filter` and
`asOfDate`, then asserts:

1. the export's `matched` equals the list's `total`;
2. a sampled row agrees field-for-field on the resolved names.

If someone edits one fold and not the other, a suite fails rather than a payslip. This
case is the reason the duplication is acceptable, so it is not optional.

## App side

- New `app/src/lib/file-download.ts` holding `signedUrlFor` and `saveCsv`, extracted
  from `app/src/data/titles.ts`; `titles.ts` imports it. Four copies of "fetch the bytes
  and save a blob" is the one duplication this change can remove for free.
- `usePlansExport`, `usePositionsExport` and `useRulesExport` keep their current
  signatures and return shapes, so `Plans.tsx`, `Positions.tsx` and `Rules.tsx` need no
  changes beyond what they already pass.
- Delete `app/src/lib/csv.ts` and `app/src/lib/csv.test.ts`. They become dead. Their 11
  tests were verifying client-side quoting the platform's CSV node now owns.
- `app/src/data/callables.ts` gains three bindings, read off the stored data-source rows
  and never invented.

**The signed URL must be fetched, not navigated to.** A navigation carries no auth
layer, so the file 401s while the callable that wrote it has already succeeded — which
reads as a Download button that toasts and does nothing. `saveCsv` fetches the bytes and
saves the blob, and reports failure rather than assuming success.

## Data sources and deploy

One `ds_export_*` data source per automation, created with `scripts/ua-datasource.mjs`.

**A created data source is invisible to the running app until the APP is deployed**, and
the browser's failure reads `forbidden datasource: not found`. So the order is:
create the automations → suites green → deploy the automations → create the data
sources → deploy the app → only then is the button real.

## Testing

Per automation:

- every input blank — the payload a Download button actually sends;
- `search` matches, and `matched` reflects it;
- `filter` narrows server-side, and the complement sums back to the unfiltered baseline;
- an unfilterable field and an unsupported operator are each refused as `INVALID_INPUT`,
  not ignored;
- `maxRows` non-numeric is refused; `maxRows` below the match count answers `TRUNCATED`
  with `matched > total`;
- an empty result writes a header-only file and answers `OK`, not an error;
- a lookup that no longer resolves falls back to its id;
- the cross-check against the matching list callable described above;
- Positions only: `OCCUPIED`, `VACANT`, `CONFLICT` and an open-ended assignment each
  export correctly, and the window columns are empty for the two that have no single
  window;
- Rules only: `stage` outside `{credit, payout}` is refused, and a caller filter cannot
  surface the other stage.

`fileDetails.name` is asserted present; the file's BYTES are not fetched by the suite,
because the suite runs outside the browser's auth context. That is a stated gap, not an
oversight — the byte path is only exercised by a person clicking Download.

Deploy through `scripts/deploy.mjs`, which gates on suite, validate and lint.

## Known limits

- Nobody has clicked these buttons in a browser. The suites prove the automations; the
  save-the-blob path is verified only by main's existing Titles export using the same
  helper.
- `ICM | Export Titles CSV` keeps its own copy of the export shape and still lacks a
  `filter` input. Converging it is a follow-up, deliberately not bundled here.
