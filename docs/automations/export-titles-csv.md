# ICM | Export Titles CSV

**Built state (2026-09-09)**: **DEPLOYED ON TOOL (prod)**, 8 nodes, deployed
version 2 / workflow version 4. `ua.mjs validate` clean · `lint.mjs` clean. Built
directly on **tool**; orbit does not have it. Wired to the Titles page through
`ds_export_titles_csv` (`e_6aa1178535cc1f4f3c76891e`).

| field | value |
|---|---|
| Token / name | `ICM \| Export Titles CSV` (`6aa110803c7f7b6b919d9695`), tags from `kit.config.json` (`icm`), CALLABLE |
| Purpose | The Titles screen's Download button: the rows the screen is showing, written to a CSV file and handed back as a download link. |
| Callers | **Pages** — the Titles screen's `ListToolbar` Download button, through `ds_export_titles_csv` (`e_6aa1178535cc1f4f3c76891e`). |
| Authorization | **Any authenticated caller.** `Title` is org structure, not money. It reads `Title` and writes nothing to the data model. |

## Why a second callable and not a fourth verb on Manage Titles

`ICM | Manage Titles` says it in its own spec: *"If a fourth verb ever appears
(delete, bulk import), revisit this. A mode switch with five arms is a router,
and a router is the wrong shape for a callable."* EXPORT is that fourth verb, so
it lives here.

What is NOT duplicated is the thing that matters: the search filter is the same
`OR` over `titleCode`/`name`/`description` that Manage Titles LIST builds, so the
file is the rows the screen is showing. **That similarity is copied Groovy, not a
shared node, and it is the one thing that can silently drift** — if the LIST
search changes and this does not, the download stops matching the table.

## The CSV is written by the platform, not by us

`n_Write` is `csv_by_unifyapps_list_to_csv_file` ("Write data to CSV file"),
which runs `CsvWriterAction` over commons-csv. Quoting is `quoteMode: MINIMAL` —
RFC 4180, a library guarantee rather than a regex of ours. The first build of
this automation rendered CSV by hand in Groovy; that was replaced, because
hand-rolled quoting is the kind of thing a description with a comma in it breaks
one column at a time.

Config, and why each value: `delimiter ","`, `encoding "UTF-8"`, `quote "\""`,
`fileType "csv"`, `headerType "STATIC"`, `skipHeaderRow false`,
`keepExactFileName false` — the timestamp suffix is deliberate, so two exports in
one session cannot collide on one storage key.

**`staticHeaders` is `{key, value}` where `key` is the header label written to the
file and `value` is a pill into row zero of `dataSource`.** The runtime reduces
that pill to a bare field name by stripping the `<dataSource>[0].` prefix
(`CsvUtils.cleanupListPrefix`). It reads backwards — the label is the key — and
getting it the wrong way round produces a file whose header row is a list of
template expressions.

## Entity study

- **`Title`** — read only. Eight fields exported; `titleId` is deliberately NOT
  among them. The unique key `titleCode` leads the file, because that is what a
  re-import has to match on.
- Column order is the Titles screen's own, and the header labels are the screen's
  labels, so the file reads like the table it came from.

## Period and money

Touches neither. No `periodId`, no amount, no rounding point.

## Input (`setup`)

| field | type | required | blank / default |
|---|---|---|---|
| `search` | string | no | `""` → **no filter: the whole catalog**. Matches `titleCode` OR `name` OR `description`, case-insensitively, SERVER-SIDE |
| `maxRows` | string | no | `""` → `50000`, clamped 1..50000. A runaway guard, NOT a page size |

A caller that OMITS a field entirely, rather than sending `""`, is also handled:
`n_Norm` reads its parameters through `binding.hasVariable`. Without that, an
unbound parameter is a *missing* Groovy variable, not a null one, and the run
dies with `No such property: search` — an engine error, not a business outcome.
Confirmed by test run on tool, 2026-09-09.

## The whole catalog, always

This exports EVERYTHING matching the filter. The caller's own paging is ignored on
purpose — there is no `offset` input, and the Download button on a screen showing
page 3 of 40 still gets all 40 pages' worth. `search` is left blank by that button.

**One fetch is enough, and that is a checked fact, not an assumption.** Nothing
clamps `page.limit` on the way through: `BaseStorageAction.getPageDetailsOrDefault`
passes it straight into the query, and neither the node config nor the action
declares a maximum. So `maxRows` is a runaway guard, not a page size, and no paging
loop is needed. (`loop_while` exists and is verified, but no automation in this repo
has ever built a loop; not needing one here is worth more than proving one works.)

**A short file can never look like a complete one.** The fetch asks for
`includeTotalCount`, so `matched` is the true count of everything matching, uncapped
by the limit. When it exceeds what came back, `n_Rows` computes `status:
"TRUNCATED"` — the STOP node's status is a pill from that node, not a literal,
precisely so this case cannot be lost. `success` stays `true`: the file is real and
downloadable, it is just short, and the message says by how much.

## Output

| status | meaning |
|---|---|
| `OK` | the complete file. An empty catalog is `OK` with a header-only file (70 bytes), not an error |
| `TRUNCATED` | the file is real but SHORT of `matched` — `maxRows` was hit. `success` is still `true` |
| `INVALID_INPUT` | non-numeric `maxRows` — refused BEFORE any fetch |

```
status, success, message, total, matched, truncated,
fileDetails { name, source, sourceType, fileType, mimeType, fileFormat, size, link }
```

`required` is `["status","success","message","total"]` and nothing more.

**`total` is what is IN the file; `matched` is what the filter found.** They differ
exactly when `truncated` is true.

**The automation cannot hand back a URL, and the one you can see is a trap.**
`fileDetails.source` is a cloud-storage path (`workflow_uploads/export/...`) that a
browser cannot fetch. A `link` field DOES appear in the workflow builder's test
panel — and it is added by that panel. It is **not** in the deployed
`POST /api/workflow/execute/node` response. Verified against tool 2026-09-09 by
calling the data source exactly as the page does: `fileDetails` came back with
`fileType`, `name`, `size`, `source`, `sourceType`, `ua:type` — and no `link`.

A page built around `link` would work in every test run and fail for every real
user. The supported crossing is **`POST /api/file/signed-url`** with
`{ fileDetails }` — the whole object, unmodified — which answers `{ url }`: a
relative `/api/file/download/<encrypted key>` path resolved against the caller's own
session. Confirmed end to end: signed-url → `HTTP 200 text/csv`, 882 bytes, the same
11 rows.

## Node plan

1. **`n_sTaRt`** START, CALLABLE. **Carries `trigger: {type: "CALLABLE"}`** —
   without it `validate` dies with `Node.getTrigger() is null`.
2. **`n_Norm`** Groovy — defaults, `maxRows` validation, and the search filter
   built as one object and passed as a single pill. The nested `OR` inside the
   `AND` is something a node's static config cannot express.
3. **`n_IfBad`** IF `valid == false` → **`n_StBad`** STOP `INVALID_INPUT`.
4. **`n_Fetch`** fetch `Title` with that filter, limit `rowCap`, offset 0,
   `includeTotalCount: true` — the count is what makes `truncated` honest.
5. **`n_Rows`** Groovy — flatten `properties` into row maps, default missing
   fields to `''` so no column reads `null`, and compute the counts.
6. **`n_Write`** the platform CSV node. → **`n_StOk`** STOP `OK`.

Every `groupId` is computed by the build script, never typed.

## The four questions, for the node that leaves the automation

**`n_Write`** (`csv_by_unifyapps_list_to_csv_file`)
- **SENT**: the flattened rows as `dataSource`, eight `staticHeaders`, and the
  format config above.
- **NOT sent**: `dynamicHeaders` — headers are STATIC on purpose. Dynamic headers
  would take whatever keys the first row happens to carry, which makes the file's
  columns depend on the data instead of on the contract.
- **WHEN**: only after `valid`, on every non-refused run, including a run that
  matched nothing.
- **NOT called**: on `INVALID_INPUT`. Correct — a refused request should not leave
  a file in storage.

## Errors

- Fetch and write failures reach the caller as the platform's error
  (`fallbackMode: STOP`) — **accepted debt**, same reasoning as the other ICM
  callables: an infrastructure failure is not a business outcome.
- Read-only against the data model, so there is no half-done state and no
  duplicate-on-retry question. A retry costs one more file in storage.

## Changes — the system of changes

| thing | verb | verdict | how would we notice if this is wrong? |
|---|---|---|---|
| `Title` object | unaffected | **unaffected** — read only, no schema change | `ua.mjs snap-types Title --env tool` diff |
| `scripts/lint.mjs` | update | **cascade** — `csv_by_unifyapps_list_to_csv_file` added to `UACODE_VERIFIED_RESOURCES`, citing its uacode config | delete the entry only if that config disappears from uacode |
| `ICM \| Manage Titles` | unaffected | **unaffected** — not called, not edited. The shared search filter is copied, not shared; see the drift warning above | diff the two `n_Norm` bodies when either changes |
| Titles page | **wired** | `useTitleExport` in `app/src/data/titles.ts`; `onDownload` on `ListToolbar`; binding `EXPORT_TITLES_CSV` | typecheck + oxlint clean; not yet clicked in a browser |
| `ds_export_titles_csv` | create | **cascade** — mirrors `ds_manage_titles` field for field, including `version: "-1"` and `runtimeConnections`, which the kit's `ua-datasource.mjs` builder omits | diff the two rows if a call ever answers `forbidden datasource` |
| Storage retention | **open** | every click leaves a file under `workflow_uploads/export/`. Nothing cleans them up | ask the platform team before this gets real traffic |
| Orbit | diverged | **accepted, by instruction** — this callable exists on tool only | `inventory --tag icm` on both envs |

## Tests

**No suite yet.** `tests/6aa110803c7f7b6b919d9695.json` does not exist. What HAS
been run, by `testrun.mjs` against tool on 2026-09-09, all passing:

| payload | result |
|---|---|
| `{}` (fields omitted) | `OK`, 11 rows |
| `{"search":"","maxRows":""}` | `OK`, 11 rows, `truncated: false` |
| `{"search":"enterprise","maxRows":""}` | `OK`, 1 row |
| `{"maxRows":"3"}` | `TRUNCATED`, 3 of 11, message names both counts |
| `{"search":"zzz-no-match","maxRows":""}` | `OK`, 0 rows, 70-byte header-only file |
| `{"search":"","maxRows":"abc"}` | `INVALID_INPUT`, refused before the fetch |

Those cases belong in `tests/<id>.json` before this is deployed.

## Notes

- **Accepted debt**: no regression suite; no storage cleanup; the copied search
  filter; platform errors surface raw.
- **Verified end to end 2026-09-09**: `fileDetails.link` was fetched with the
  caller's session cookie and returned `HTTP 200 text/csv`, 882 bytes matching
  `fileDetails.size` — the header row plus all 11 titles, columns in contract
  order, empty optional fields rendered as empty rather than `null`.
- **The doubled slash was a red herring**, and only ever affected the builder's
  `link`. The `url` from `/api/file/signed-url` is a clean relative path.
- **Never clicked in a real browser.** Every check above was made by calling the
  same endpoints the page calls, with the same payload; the button itself, the
  new-tab open, and the session cookie inside the preview frame have not been
  exercised by a human.
- **Still not exercised: MINIMAL quoting.** No current `Title` has a comma, quote
  or newline in any field, so no row in any test run has needed quoting. The
  guarantee is commons-csv's, not ours, but it is untested HERE. A test-tagged
  clone returning a hardcoded row with a comma in the description would settle
  it without writing anything to the real catalog.

## `filter` — the Download button follows the screen (2026-09-11)

The button used to send nothing, so the file was always the whole catalog even when the
screen was showing four rows. It now sends the search box AND the filter block, and this
automation ANDs them exactly as `ICM | Manage Titles` LIST does. **With neither set the file is still
the whole catalog** — "everything" is the absence of a question, not a second code path.

### What changed

| thing | change |
|---|---|
| `n_sTaRt` `setup` | `filter` added, `string`, matching how `ICM | Manage Titles` declares it |
| `n_Norm` `inputs.parameters` | `filter: {{ n_sTaRt.outputs.filter }}` — **the edit that actually matters** |
| `n_Norm` `inputs.input` | `filter` added to the node's own input schema |
| `n_Norm` code | the wire→storage translator, ported from `ICM | Manage Titles` |

**Declaring `filter` on the START node is NOT enough.** A Groovy node binds only what its
own `parameters` map pipes in, so the first build had `filter` visible on `n_sTaRt`,
absent inside the script, `binding.hasVariable('filter')` false, and the filter silently
ignored — a run that answered `OK` with every row. Found by test run, not by reading.

**`raw` was already taken.** The ported block declares `def raw = parsed.trim()`; this
script's head binds `raw` to the parameter reader. `ICM | Manage Titles` had the name free. Groovy
refuses the shadow at compile time, so the node failed startup until it was renamed
`rawText`.

### The data source, and why there is a second one

`validateDataSourceContextAndInputs` compares a request's parameter KEYS against the
stored row's, so adding `filter` to `ds_export_titles_csv` would refuse every call from the
deployed app and break Download on the live Titles page. The key set was not changed:
`ds_export_titles_filtered` (`e_6aa3bc896dbbfa43d36b66b1`) is a second row against this automation, the same
move `ds_titles_filtered` made for `ICM | Manage Titles`. Only the branch binds to it.

### Backward compatible

A caller that sends no `filter` key at all — which is exactly what the old row does — is
read through `binding.hasVariable` and gets the whole catalog. Verified by test run below,
so the old row and the new one can both point at this automation indefinitely.

### Tested on tool, 2026-09-11, by `testrun.mjs`

| payload | result |
|---|---|
| `filter` key ABSENT (the old caller) | `OK`, whole catalog — unchanged |
| `filter: ""` | `OK`, whole catalog |
| one `EQUAL` leaf | `OK`, the matching subset, translated to `properties.<field>` |
| search + one leaf | `OK`, ANDed — narrower than either alone |
| unknown field | `INVALID_INPUT`, naming the field, refused before the fetch |

Still untested: `OR` at the root, `EXISTS`/`MISSING`, and a nested group — the same three
`ICM | Manage Titles` still owes.

**Ordering when deploying.** Deploy this BEFORE the app that sends `filter`. Against the
old deployed definition the key is ignored rather than refused, so Download would quietly
return the whole catalog while the screen shows a filtered table — wrong, and silent.
