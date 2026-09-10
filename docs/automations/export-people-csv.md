# ICM | Export People CSV

**Built state (2026-09-10)**: **BUILT ON TOOL (prod) AS A DRAFT, 9 nodes.**
`ua.mjs validate` clean · `lint.mjs` clean · **suite 6/6 green**
(`tests/6aa2b1e58f7899040900afe2.json`). **NOT DEPLOYED** — deploying is
`deploy.mjs` with its gates and an explicit human yes, and no caller can reach a
draft. Built directly on **tool**; orbit does not have it, matching the whole
Titles/People family.

Derived from the deployed `ICM | Export Titles CSV` structure plus one Currency
fetch. Definition authored directly rather than through the copilot — mechanical
work, and the column table generating the headers, the row shape and the result
schema from one list is what keeps a header from naming a column that is not
written.

**Verified end to end on tool 2026-09-10**: the run wrote
`people_1789047296999.csv`, 1977 bytes, 21 rows. The file was DOWNLOADED and read
back — 15 headers in the screen's order, `hireDate` rendered `2026-01-01`,
`currencyCode` resolved to `USD`. Not inferred from the run's own report.

| field | value |
|---|---|
| Token / name | `ICM \| Export People CSV` (`6aa2b1e58f7899040900afe2`), tags from `kit.config.json` (`icm`), CALLABLE |
| Purpose | The People screen's Download button: the roster written to a CSV file and handed back as `fileDetails`. |
| Callers | **Pages** — the People screen's `ListToolbar` Download button, through `ds_export_people_csv` (`e_6aa2b25b9753751b39ba1323`). See `docs/pages/people.md`. |
| Authorization | **Inherits the People authorization question, and sharpens it.** See below. |

## This export is a payroll file, and that is not a rhetorical flourish

`ICM | Export Titles CSV` can be called by anyone authenticated because a title
catalog is org structure. **This one writes `salary` and `personalTarget` for
every person into a file the caller downloads.**

A LIST call leaks a page at a time to a screen; an export hands over the whole
roster in one artifact that leaves the platform. Whatever answer question 1 in
`manage-people.md` gets, **this callable takes the stricter half of it**, and
until it has one, this must not deploy.

Stated separately from the LIST rule because the two are genuinely different
risks and a single "authorization: TBD" on both would hide that.

## Why a second callable and not a fourth verb on Manage People

`manage-people.md` says it, inheriting the rule from Titles: *a mode switch with
five arms is a router, and a router is the wrong shape for a callable.* EXPORT is
the fourth verb, so it lives here.

What is NOT duplicated is the thing that matters: the search filter is the same
`OR` over `employeeId`/`name`/`email` that Manage People LIST builds, so the file
is the rows the screen is showing. **That similarity is copied Groovy, not a
shared node, and it is the one thing that can silently drift** — if the LIST
search changes and this does not, the download stops matching the table. Titles
records the same hazard; it has not bitten there yet.

## The CSV is written by the platform, not by us

`n_Write` is `csv_by_unifyapps_list_to_csv_file` ("Write data to CSV file"),
running `CsvWriterAction` over commons-csv. Quoting is `quoteMode: MINIMAL` —
RFC 4180, a library guarantee rather than a regex of ours. The first build of the
Titles export rendered CSV by hand in Groovy and was replaced; hand-rolled
quoting is what a name with a comma in it breaks one column at a time.

Config, each value inherited from the working Titles export: `delimiter ","`,
`encoding "UTF-8"`, `quote "\""`, `fileType "csv"`, `headerType "STATIC"`,
`skipHeaderRow false`, `keepExactFileName false` — the timestamp suffix is
deliberate, so two exports in one session cannot collide on one storage key.

**`staticHeaders` is `{key, value}` where `key` is the header LABEL and `value`
is a pill into row zero of `dataSource`.** The runtime strips the
`<dataSource>[0].` prefix (`CsvUtils.cleanupListPrefix`). It reads backwards, and
getting it the wrong way round produces a file whose header row is a list of
template expressions.

## Entity study

`Payee`, read only. Columns, in the screen's own order, with the screen's labels:

```
Employee ID, First Name, Last Name, Name, Email, Region, Business Group, Team,
Status, Hire Date, Termination Date, Payment Currency, Personal Currency,
Personal Target, Salary
```

- **`payeeId` is deliberately NOT exported.** The unique key `employeeId` leads
  the file, because that is what a re-import has to match on. Same call Titles
  made with `titleId`/`titleCode`.
- **Currency columns are CODES, not ids.** `currencyId` is an FK, and a file of
  `e_6a9c...` ids is not something a person can read or re-import. One bulk
  fetch of `Currency`, joined in `n_Rows` — never one call per row.
- **Dates are rendered as `yyyy-MM-dd` in UTC**, not as epoch millis. The stored
  value is epoch; a spreadsheet showing `1788594607505` is a file nobody can use.
  UTC is named here because `manage-people.md` stores UTC midnight, and a
  render in local time would move a hire date across a day boundary.

## Period and money

Touches no period and computes no amount. It **transports** money — see the
authorization section, which is where that fact matters.

## Input (`setup`)

| field | type | required | blank / default |
|---|---|---|---|
| `search` | string | no | `""` → **no filter: the whole roster**. Matches `employeeId` OR `name` OR `email`, case-insensitively, SERVER-SIDE |
| `maxRows` | string | no | `""` → `50000`, clamped 1..50000. A runaway guard, NOT a page size |

A caller that OMITS a field entirely, rather than sending `""`, is also handled:
`n_Norm` reads its parameters through `binding.hasVariable`. Without that, an
unbound parameter is a *missing* Groovy variable, not a null one, and the run
dies with `No such property: search`. Confirmed on tool 2026-09-09 building the
Titles export.

## The whole roster, always

This exports EVERYTHING matching the filter. The caller's own paging is ignored
on purpose — there is no `offset` input, and the Download button on a screen
showing page 3 of 40 still gets all 40 pages' worth. `search` is left blank by
that button.

**One fetch is enough, and that is a checked fact.** Nothing clamps `page.limit`
on the way through: `BaseStorageAction.getPageDetailsOrDefault` passes it
straight into the query, and neither the node config nor the action declares a
maximum. So `maxRows` is a runaway guard, not a page size, and no paging loop is
needed.

**A short file can never look like a complete one.** The fetch asks for
`includeTotalCount`, so `matched` is the true count uncapped by the limit. When
it exceeds what came back, `n_Rows` computes `status: "TRUNCATED"` — the STOP
node's status is a pill from that node, not a literal, precisely so this case
cannot be lost. `success` stays `true`: the file is real and downloadable, just
short, and the message says by how much.

## Output

| status | meaning |
|---|---|
| `OK` | the complete file. An empty roster is `OK` with a header-only file, not an error |
| `TRUNCATED` | the file is real but SHORT of `matched` — `maxRows` was hit. `success` is still `true` |
| `INVALID_INPUT` | non-numeric `maxRows` — refused BEFORE any fetch |

```
status, success, message, total, matched, truncated,
fileDetails { name, source, sourceType, fileType, mimeType, fileFormat, size }
```

`required` is `["status","success","message","total"]` and nothing more.

**`total` is what is IN the file; `matched` is what the filter found.** They
differ exactly when `truncated` is true.

### The automation cannot hand back a URL, and the one you can see is a trap

`fileDetails.source` is a cloud-storage path (`workflow_uploads/export/...`) a
browser cannot fetch. A `link` field DOES appear in the workflow builder's test
panel — **added by that panel.** It is not in the deployed
`POST /api/workflow/execute/node` response. Verified against tool 2026-09-09 for
the Titles export by calling the data source exactly as the page does:
`fileDetails` came back with `fileType`, `name`, `size`, `source`, `sourceType`,
`ua:type` — and no `link`.

A page built around `link` works in every test run and fails for every real user.
The page crosses with `POST /api/file/signed-url`, then fetches the bytes and
saves a blob — `app/src/data/titles.ts` carries the full reasoning and the People
data layer reuses it rather than re-deriving it.

## Node plan

1. **`n_sTaRt`** START, CALLABLE, `trigger: {type: "CALLABLE"}`.
2. **`n_Norm`** Groovy — `maxRows` coercion, the search filter as one pill.
3. **`n_IfBad`** IF `valid == false` → **`n_StBad`** STOP `INVALID_INPUT`.
4. **`n_FtCur`** fetch `Currency` — the id→code map.
5. **`n_Ft`** fetch `Payee`, `includeTotalCount`, `page.limit = maxRows`.
6. **`n_Rows`** Groovy — flatten, join currency codes, render dates, compute
   `total` / `matched` / `truncated` / `status`.
7. **`n_Write`** `csv_by_unifyapps_list_to_csv_file`.
8. **`n_St`** STOP, status as a pill from `n_Rows`.

## The four questions, for each node that leaves the automation

**`n_Ft`** (`storage_by_unifyapps_fetch_records`, `Payee`)
- **SENT**: `object_type: Payee`, the search filter (or none), `page.limit` =
  `maxRows`, `includeTotalCount: true`.
- **NOT sent**: `page.offset` — an export is not a page. Without
  `includeTotalCount`, `TRUNCATED` cannot be detected at all.
- **WHEN**: after `maxRows` validates.
- **NOT called**: on `INVALID_INPUT`.

**`n_Write`** (`csv_by_unifyapps_list_to_csv_file`)
- **SENT**: the flattened rows from `n_Rows`, the 15 static headers, the config
  above.
- **NOT sent**: `keepExactFileName: true` — the timestamp suffix prevents two
  exports in one session colliding on one storage key.
- **WHEN**: after the fetch returns, including when it returns zero rows.
- **NOT called**: on `INVALID_INPUT`. A header-only file for an empty roster IS
  written, deliberately — an empty roster is a valid answer, not an error.

## Changes — the system of changes

| thing | verb | verdict | how would we notice if this is wrong? |
|---|---|---|---|
| `Payee` object | reads | **cascade** — the 8 fields added 2026-09-10 are 8 new columns; this spec is the record of the column list | a column in the file with no header, or a header with no column |
| `ICM \| Manage People` | sibling | **accepted** — the search filter is copied Groovy, not a shared node. Named in "Why a second callable" as the drift risk | a suite case asserting both return the same count for the same `search` |
| People page | create | **cascade** — `docs/pages/people.md` records the dependency; nothing on the platform does | `graph.mjs --check` |
| Orbit | diverged | **accepted, by instruction** | `inventory --tag icm` on both envs |

## Tests

| case | asserts |
|---|---|
| all-empty-strings | `OK`, whole roster, header row correct |
| `maxRows` = 1 | `TRUNCATED`, `success` still `true`, `total` 1, `matched` > 1 |
| non-numeric `maxRows` | `INVALID_INPUT`, no fetch |
| `search` matching nothing | `OK`, header-only file |
| **same `search` as Manage People LIST** | identical `matched` — the anti-drift case |
| a payee with a comma in `name` | one row, quoted by commons-csv |

## Notes

- **Accepted debt**: fetch/write failures reach the caller as the platform's
  error (`fallbackMode: STOP`).
- No paging loop, per the checked fact above.
- **Blocks deploy**: the authorization question, stricter here than on LIST.

## Confirmed on tool, 2026-09-10

The `link` trap this spec warns about was **observed again, first-hand**: the test
run's `fileDetails` DID carry a `link`, because a test run goes through the
builder's panel. The deployed `execute/node` response does not. A page built
around it works in every test and fails for every real user — which is why
`csv-export.ts` crosses via `POST /api/file/signed-url` and fetches the bytes.

Every First Name and Last Name column in the verification file was EMPTY. That is
not a bug in this automation: it is the 11 pre-2026-09-10 rows that have a `name`
and no `firstName`/`lastName`, and it is open question 2 in `manage-people.md`
showing up in a file rather than in prose.
