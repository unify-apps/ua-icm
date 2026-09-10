# ICM | Manage Titles

**Filter block added 2026-09-09** — `filter` input, draft only, NOT yet deployed.
See "The filter block" below. `validate` clean · `lint` clean. The deployed copy is
still the 2026-09-05 one, so the live page is unaffected until someone deploys.

**Built state (2026-09-05)**: **CREATED ON TOOL (prod) AS A DRAFT, 20 nodes.**
`ua.mjs validate` clean · `lint.mjs` clean. **Not deployed** — deploying is
`deploy.mjs` with its gates and an explicit human yes, and no caller can reach a
draft. Built directly on **tool**; orbit does not have it. That reverses the
kit's orbit-first default and was an explicit instruction, not an oversight.

| field | value |
|---|---|
| Token / name | `ICM \| Manage Titles` (`6a9bef655f22d93ee6e9b03a`), tags from `kit.config.json` (`icm`), CALLABLE |
| Purpose | One callable behind the Titles screen: list the catalog, create a title, edit a title. |
| Callers | **Pages** — the Titles screen and its Edit Title drawer. No page exists yet; when one is built it needs an `e_data_source` per the page contract. |
| Authorization | **Any authenticated caller.** `Title` is org structure, not money — no amount, quota, attainment or payout field is read or written. Adding one changes this row and the caller check together, or the change is refused. |

## Why one callable and not three

The screen is one resource with three verbs against it, and the guards the
writes need — the unique-key pre-check especially — are the same code for CREATE
and UPDATE. Splitting them would copy that guard into a second automation on
day one, which the reuse rule exists to prevent. The cost is a callable with a
mode switch, and the mitigation is that every branch ends in its own status.

**If a fourth verb ever appears (delete, bulk import), revisit this.** A mode
switch with five arms is a router, and a router is the wrong shape for a
callable.

## Entity study

- **`Title`** — `titleCode` is `uniqueKey: true` and in `uniqueKeyFields`;
  `titleCode` and `name` are required. `description`, `category`, `level`,
  `market`, `function`, `payPeriod` are optional strings, added 2026-09-05.
- **`function` is a field name here.** It is valid JSON and the platform
  accepts it; it is deliberately NOT used as a Groovy variable name (the node
  parameter is `functionName`), because the field name is what the screen's
  column is called and renaming the field to suit Groovy would be the tail
  wagging the dog.
- **No foreign keys.** `Title` references nothing and is referenced by
  `PositionAttribute` — which is why this callable never deletes.

## Period and money

Touches neither. No `periodId`, no amount, no rounding point.

## Input (`setup`)

| field | type | required | blank / default |
|---|---|---|---|
| `action` | string | no | `""` → `LIST`. `LIST` · `CREATE` · `UPDATE`, case-insensitive |
| `titleId` | string | for UPDATE | the platform entity id |
| `titleCode` | string | for CREATE | the unique key |
| `name` | string | for CREATE | |
| `description` `category` `level` `market` `function` `payPeriod` | string | no | `""` |
| `search` | string | no | `""` → no filter. Matches `titleCode` OR `name` OR `description`, case-insensitively, SERVER-SIDE |
| `filter` | object or JSON string | no | `""` → unfiltered. The platform wire filter; see below |
| `limit` | string | no | `""` → `50`, clamped 1..200 |
| `offset` | string | no | `""` → `0` |

Every default is applied INSIDE the automation. Real callers send empty strings
for what they don't fill, so `""` is what each branch is built around.

**Blank on UPDATE means "clear it" for the six optional fields, and "leave it"
for the two required ones.** The caller is a form that posts every field, so a
blank Description is a user clearing the box, not a partial payload — and a
blank `titleCode` must never blank out the unique key. Stated here because the
two halves of that rule differ and neither is guessable.

## Output

| status | meaning |
|---|---|
| `OK` | the list. An empty result is `OK` with `titles: []`, not an error |
| `CREATED` | one title made; `title` carries it, `total` is 1 |
| `UPDATED` | one title edited; `title` carries it |
| `DUPLICATE_TITLE_CODE` | `titleCode` already belongs to another record — refused BEFORE any write |
| `NOT_FOUND` | UPDATE against an id that no longer exists |
| `INVALID_INPUT` | unknown action, missing required field, or non-numeric paging |

```
status, success, message, action, total, hasMore, offset, limit,
titles [ { titleId, titleCode, name, description, category,
           level, market, function, payPeriod } ],
title  { same shape }
```

`required` is `["status","success","message","total","titles"]` and nothing more.

## Node plan

1. **`n_sTaRt`** START, CALLABLE. **Carries `trigger: {type: "CALLABLE"}`** —
   without it `validate` dies with `Node.getTrigger() is null`, an HTTP 500 that
   names no node. Cost one build cycle 2026-09-05; recorded so it costs nobody
   else one.
2. **`n_Norm`** Groovy — defaults, validation, and all three filters built as
   objects and passed as single pills. The LIST search is a nested `OR` inside
   the `AND`, which a node's static config cannot express.
3. **`n_IfBad`** IF `valid == false` → **`n_StBad`** STOP `INVALID_INPUT`.
4. **`n_IfList`** IF `action == LIST`:
   - **`n_FtList`** fetch `Title` → **`n_Rows`** Groovy (flatten, count) →
     **`n_StList`** STOP `OK`.
5. Otherwise the write path, **guards before the side effect**:
   - **`n_FtDup`** fetch `Title` where `titleCode EQUAL <code>`, limit 5.
   - **`n_FtOne`** fetch `Title` where `id EQUAL <titleId>`, limit 1. Both use a
     `__none__` sentinel when the branch does not apply, so neither ever runs
     unfiltered.
   - **`n_Guard`** Groovy — duplicate (any row whose id differs from `titleId`),
     not-found, and the merged record to write.
   - **`n_IfDup`** → **`n_StDup`** STOP `DUPLICATE_TITLE_CODE`.
   - **`n_IfNF`** → **`n_StNF`** STOP `NOT_FOUND`.
   - **`n_IfCr`** IF `action == CREATE` → **`n_Create`** create record →
     **`n_StCr`** STOP `CREATED`; else **`n_Update`** update record by id →
     **`n_StUp`** STOP `UPDATED`.

Every `groupId` is computed by the build script, never typed.

## The four questions, for each node that leaves the automation

**`n_Create`** (`storage_by_unifyapps_create_record`)
- **SENT**: `object_type: Title` and the whole eight-field record from `n_Guard`.
- **NOT sent**: `useUuid`, `batching`, `useRawPayload` — all left at their `false`
  defaults; the record is a plain map, not a raw payload.
- **WHEN**: only after `valid`, not-duplicate, and `action == CREATE`.
- **NOT called**: on LIST, on a duplicate code, on UPDATE. All correct.

**`n_Update`** (`storage_by_unifyapps_update_record_by_id`)
- **SENT**: `recordId` from `n_Norm`, `upsert: false`, the merged record.
- **NOT sent**: `upsert: true` — deliberately. An UPDATE against a missing id is
  `NOT_FOUND`, a caller-actionable fact; upsert would silently mint a record
  with a caller-supplied id instead.
- **WHEN**: after `valid`, not-duplicate, target exists, `action == UPDATE`.
- **NOT called**: every other path.

## Errors

- The unique-key pre-check is the one guard that cannot be skipped: a
  `titleCode` collision at write time is a raw Mongo `E11000` that kills the run
  and reaches the caller as an engine error. `n_FtDup` turns it into
  `DUPLICATE_TITLE_CODE`.
- **Sending the same CREATE twice returns `DUPLICATE_TITLE_CODE`, not an engine
  error** — the double-click case the shared contract requires.
- Single write per run, so there is no half-done state and no
  duplicate-on-retry question.
- Fetch and write failures reach the caller as the platform's error
  (`fallbackMode: STOP`) — **accepted debt**, same reasoning as the other ICM
  callables: an infrastructure failure is not a business outcome.

## Changes — the system of changes

| thing | verb | verdict | how would we notice if this is wrong? |
|---|---|---|---|
| `Title` object | unaffected | **unaffected** — no schema change here; the six fields were added 2026-09-05 before this was built | `ua.mjs snap-types Title --env tool` diff |
| `scripts/lint.mjs` | update | **cascade** — `storage_by_unifyapps_create_record` and `storage_by_unifyapps_update_record_by_id` added to `UACODE_VERIFIED_RESOURCES`, each citing its uacode config | delete an entry only if the config disappears from uacode |
| Titles page | create | **not built** — no page, no data source, no `docs/pages/titles.md` yet | a page in the builder with no entry in `docs/pages/` is drift |
| Orbit | diverged | **accepted, by instruction** — this callable exists on tool only | `inventory --tag icm` on both envs |

## Tests

**None yet.** `tests/6a9bef655f22d93ee6e9b03a.json` does not exist. The suite the
shared contract requires — all-empty-strings, the duplicate-create case, the
stale-id update, paging, and a search matching nothing — has to be written
before this is deployed, and its write cases need a fixture family that
`fixtures.mjs` will not seed on prod.

## Notes

- **Accepted debt**: no suite; fetch/write failures surface as platform errors;
  the mode switch discussed above.
- The blank-means-clear rule on UPDATE is the one behaviour a caller could get
  wrong without noticing. It is stated in the Input section and in the node plan.


## The filter block (added 2026-09-09, LIST only)

The Titles screen's Filter control sends the platform's own wire shape, the same one
`toWireFilter` builds for Reference Tables:

```
{ op: 'AND' | 'OR', values: [ { field, op, values: [v] }, ... ] }
```

**The storage node speaks a different dialect**, and translating between them is the
whole of the new code in `n_Norm`:

```
{ operator, filters: [ { property: 'properties.<field>', filter: { operator, value } } ] }
```

Passing the wire shape straight through answers HTTP 500 `Filter$Op ... op is null` at
RUN time, naming no node — the same failure `notes/runtime-facts.md` records for the
two filter dialects generally.

### What it accepts, and why that list is short

Filterable fields are the eight `Title` properties the screen shows. Operators are
exactly the ones `platform-filter.ts` offers for a TEXT field: `EQUAL`, `NOT_EQUAL`,
`ICONTAINS`, `NOT_ICONTAINS`, `CONTAINS`, `NOT_CONTAINS`, `STARTS_WITH`,
`NOT_STARTS_WITH`, `ENDS_WITH`, `NOT_ENDS_WITH`, `REGEX`, `NOT_REGEX` (one value each),
plus `EXISTS` and `MISSING` (none).

**There is no list- or range-valued case, deliberately.** Every `Title` field is TEXT,
so the screen cannot produce `BETWEEN` or `IN`. **Adding a NUMBER or DATE field to
`TITLE_FILTER_FIELDS` means teaching this node the two-value shape first** — otherwise
the screen offers `BETWEEN` and the automation refuses it, which reads as a broken
filter rather than an unfinished one.

### Rules

- **Groups nest.** A node with no `field` is a group; `values` holds its children. That
  the same key means "children" for a group and "operands" for a leaf is the wire
  format's doing, not ours.
- **An empty group is dropped, not refused.** It is a filter the user started and did
  not finish, and the screen already shows every row unfiltered.
- **Every problem is collected**, then named in one `INVALID_INPUT` — a caller fixing
  three mistakes one refusal at a time is the experience this avoids.
- **Search and filter are ANDed.** The box narrows what the block selected.
- A `REGEX` value is compiled here, so a bad pattern is `INVALID_INPUT` and not an
  engine error.

### Backward compatibility — the thing that had to be true

`filter` arrived after this callable was live, and `ds_manage_titles` does not send it.
It is read with `binding.hasVariable`, because **an unbound parameter is a MISSING
Groovy variable, not a null one** — a direct reference dies with `No such property`.

Verified on tool 2026-09-09 by replaying the live caller's exact 13-key payload:
`valid: true`, `listFilter` empty, 5 of 11 rows. The deployed app is unaffected.

### The data source, and why there is now a third one

`validateDataSourceContextAndInputs` compares a request's parameter KEYS against the
stored row's. Adding `filter` to `ds_manage_titles` would refuse every call from the
deployed app — which still sends thirteen — and **take the live Titles page down**.

So the key set was not changed. `ds_titles_filtered`
(`e_6aa14ec835cc1f4f3c79a9d9`) is a third row against this automation, joining
`ds_manage_titles` and `ds_list_titles`. Only the branch binds to it; `main` keeps
using the old row, and the two can be collapsed later when both sides ship together.

### Tested on tool, 2026-09-09

| payload | result |
|---|---|
| the live caller's 13 keys, no `filter` | `OK`, 5 of 11 — unchanged |
| `category EQUAL Sales` | `OK`, 5 matched, translated to `properties.category` |
| unknown field `salary` + `BETWEEN` on `name` | `INVALID_INPUT` naming BOTH problems |

Still untested: `OR` at the root, `EXISTS`/`MISSING`, a nested group, and search
combined with a filter.


## Call volume — why this is the most-called automation in the app (2026-09-10)

**862 runs.** Investigated because that is far more than a title catalog should
need. The cause was not the Titles screen: it was **option lists fetched eagerly
by pages that were not showing them.**

Three data sources point at this one automation, so the count is all of them
together. The call sites, as found:

| site | fired | verdict |
|---|---|---|
| `Titles.tsx` LIST + writes | per search / filter / page / save | **correct** — this is the screen |
| `Profiles.tsx` filter panel | every page visit | **correct but duplicated** — the panel is rendered inline, so it genuinely needs the options |
| `Positions.tsx` Create dialog | **every page visit** | **waste** — the dialog is usually shut |
| `ProfileDetail.tsx` | **every profile opened** | **pure waste — the result was never read** |
| `plan-form-dialog.tsx` | only when opened | correct; `Plans.tsx` mounts it conditionally |

**The worst one was `ProfileDetail`.** It calls `useProfileFilterOptions` for
`seats` alone, and `seats` is built entirely from the profile scan — the 200-row
title read was fetched, waited on (its `isLoading` was OR'd into the manager
picker's loading state) and then discarded, once per profile anyone clicked into.

**And the two remaining legitimate readers did not share a cache.**
`useTitleOptions` went through `useData`; `useProfileFilterOptions` built its own
`useExecuteWorkflowNode` call. Two React Query keys for one 200-row answer means
two network calls even back to back.

### What was changed in the app (branch `managing-people`)

Nothing about this automation changed — **the fix is entirely on the caller side**,
which is where the problem was:

1. `ProfileDetail` passes `includeTitles: false`. One call per profile view → zero.
2. `useProfileFilterOptions` now reads through `useTitleOptions`, so every consumer
   resolves to ONE query entry.
3. `Positions.tsx` gates its Create-dialog options on `createOpen`.
4. `useData` gained `staleTime`, and the title options use **5 minutes**. The SDK's
   QueryClient defaults to 30s, which is right for a list someone is working with
   and wrong for a catalog that changes a few times a year.

**The data-source rows carry `refetchOnWindowFocus: true`, and it is a red
herring here.** That is a builder-page setting; the Ledger app is a CODE app whose
SDK QueryClient sets `refetchOnWindowFocus: false` outright. It was checked rather
than assumed, and it was not the cause.

### How we would notice if this regresses

A new consumer of the title catalog that calls `useExecuteWorkflowNode` directly,
or a `useTitleOptions()` at component top level in a page whose dialog is shut.
Both look harmless in review. The check is the run count on this automation.
