# ICM | Bulk Manage Positions

**Built state (2026-09-11)**: `6aa3e58f162e4c15ae2f60a5` on **tool**, draft v1 **DEPLOYED**
(workflowVersion 1, verified from `deploymentState`), approved by the user in session.
`ua.mjs validate` clean, `lint.mjs` clean, suite `tests/6aa3e58f162e4c15ae2f60a5.json`
**56/56 green** on tool with every fixture row deleted by its own cleanup. Page data
source `ds_bulk_manage_positions` (`e_6aa3e81835cc1f4f3c926297`) on
`e_global_app-1621b11a65c8`. Not built on orbit.

Two things the first draft got wrong, both caught before deploy: a header-only file
answered with no status at all (fixed by `n_Final`), and the suite's first run read a
prefix count as 0 straight after a write - record search lag, not a write failure; every
count that asserts absence now waits 15s first.

| field | value |
|---|---|
| Token / name | `ICM \| Bulk Manage Positions` (id minted on create), tag `icm`, CALLABLE. Built by `scripts/build-bulk-manage-positions.mjs` from `automations/bulk-manage-positions/*.groovy` |
| Purpose | Create positions from an uploaded CSV in ONE run, with a verdict for every row. |
| Replaces | The Positions page's first upload, which created each row with its own `ICM \| Create Position` run from the browser: 200 rows was 200 runs and ~1,200 platform operations, a closed tab left the file half-applied, and a duplicate code across two rows was only caught by whichever run lost. |
| Callers | The Sales-Commission-Management Positions page, through the shared `BulkUploadDialog` and `useBulkUpload` - the same contract as `ICM \| Bulk Manage Titles` and `ICM \| Bulk Manage People`, so nothing app-side is specific to positions except the column list. |
| Authorization | Any authenticated user of the app, the same as Create Position. Org structure only, never money. |

Read `00-shared-contract.md` first.

## Contract

```
in    fileDetails   the uploader's object; the loop node reads `sourceType` + `source`
      batchId       echoed back; the app names the error file after it
      dryRun        "true" validates and reports, writes nothing
out   status        APPLIED | PARTIAL | REFUSED | INVALID_INPUT | WRITE_INCOMPLETE
      batchId, message
      applied       rows created or updated (also on a dry run - what WOULD apply)
      written       rows that landed; 0 on a dry run and on WRITE_INCOMPLETE
      rows[]        every data row: line, outcome (created | updated | unchanged | error),
                    error, and the row's own five columns
```

Columns, matched by header name case-insensitively and tolerant of an Excel BOM:

| column | new position | existing position |
|---|---|---|
| `position_code` | **required**, becomes the unique key | **required**, how the row is matched (exact) |
| `name` | **required** | blank keeps it; different renames it |
| `title_code` | **required**, matched case-insensitively | blank leaves it; see the dated rule below |
| `employee_id` | blank is an open seat | blank leaves it; see the dated rule below |
| `effective_start` | `yyyy-MM-dd`, blank is today UTC | the date the title/holder check is made on |

**The dated rule for existing positions.** A title or holder is ADDED only when the
position has none in force on `effective_start` (the new row stops one millisecond before
the next later row, so no overlap is manufactured). The SAME one already in force is
`unchanged`. A DIFFERENT one is an `error` pointing at the Positions drawer: replacing it
is a dated close-and-open that `ICM | Update Position` owns, and a second copy of that rule
in a bulk path is how two writers start disagreeing about history.

Statuses: `INVALID_INPUT` - no rows, or a required header is missing (named once, not N
times). `REFUSED` - every row is an error, the file is over 2,000 rows, or a read hit its
5,000-row page (a plan from a truncated read is refused, never made). `PARTIAL` - some rows
error; the rest ARE written. `APPLIED` - no row errors. `WRITE_INCOMPLETE` - a bulk write
landed fewer records than planned.

## Why the reads are shaped this way

The work must grow with the FILE, not with the org. So:

1. `Title` is read whole (catalog-scale, and codes match case-insensitively, which `IN` cannot).
2. The loop hands over the whole file as ONE batch (`batchSize` 100,000, rows capped at 2,000).
3. `n_Keys` normalises headers and collects the file's position codes and employee ids.
4. `Position` by `positionCode IN codes`; `Payee` by `employeeId IN employeeIds`.
5. `n_KPos` takes the ids of the positions that exist; `PositionAttribute` and
   `PayeePositionAssignment` are read by `positionId IN` those ids only.

Six reads and three writes per file, whatever its length. Nothing is fetched per row.

## Node plan

`n_Start` → `n_FtTitle` → `n_Loop` (CSV, one batch) → body: `n_Keys` → `n_FtPos` →
`n_FtPay` → `n_KPos` → `n_FtAttr` → `n_FtAsg` → `n_Plan` → `n_WrPos` → `n_WrAttr` →
`n_WrAsg` → `n_Done` → loopback; exit → `n_StDone`.

- **`n_Plan`** (no I/O) judges every row. Refused rows contribute no writes at all.
  New ids are minted from the business key (`Position|code`, `PositionAttribute|code|date`,
  `PayeePositionAssignment|code|date`) so re-uploading the same file targets the same
  records. On a dry run the three write lists are emptied.
- **`n_WrPos` / `n_WrAttr` / `n_WrAsg`** send `{id, updateFields: SET ...}` rows. An empty
  list is a no-op, so a refused, dry-run or all-unchanged file passes straight through.
  They never write `positionCode` of an existing position.
- **`n_Done`** compares each write's `successCount` with the planned count; a shortfall is
  `WRITE_INCOMPLETE`, never `APPLIED`.

## Errors

- A read fails → the run stops before any write.
- A write lands short → `WRITE_INCOMPLETE`. Positions are written before the rows that
  point at them, and every id is key-minted, so uploading the same file again converges:
  what landed comes back `unchanged`, what did not is written.

## Changes — the system of changes

| thing | verb | verdict | how would we notice if this is wrong? |
|---|---|---|---|
| `ICM \| Bulk Manage Positions` | create | nothing does this in one run today | the suite, `validate`, `lint` |
| Positions page upload | reassign | *cascade* - the page switches to `BulkUploadDialog` + `BULK_MANAGE_POSITIONS`; the per-row client upload (`position-upload.ts`, `position-upload-dialog.tsx`, `useBulkCreatePositions`) is deleted | the page's upload answers with this callable's verdicts |
| `ICM \| Create Position` | writes the same objects | *unaffected* - rows are named and shaped the way Create names them (`<name> attributes`, `allocationPct` 100) | the suite re-reads through List Positions |
| `ICM \| Update Position` | owns dated replacement | *handled already* - this refuses a different title/holder and points there | suite case: different title on an existing position is an error |
| List Positions / Calculate Credits | read these rows | *unaffected* - same as-of rule, no overlap created | suite re-reads every write through List Positions |
| `scripts/ua-upload.mjs` | create | *cascade* - new writer, listed in CLAUDE.md and START-HERE | the suite's files exist and the loop reads them |

## Tests

`tests/<workflowId>.json` on tool. Fixtures `KITTEST-BULKPOS-*` (two titles, two people),
every date 2030, files in `tests/fixtures/bulk-manage-positions/` uploaded with
`ua-upload.mjs`. Cases: dry run writes nothing · apply creates two of six (four errors:
missing name, unknown title, repeated code, unknown person + impossible date) · the same
file again is all `unchanged` · an update file renames, gives an open seat a holder,
creates a new position and refuses a different title · a wrong header is `INVALID_INPUT`
naming the columns · every write re-read through List Positions · cleanup.

## Notes

- **A file over `batchSize`** would reach the loop body twice and report only the last
  batch. The cap (2,000 rows) sits far below the batch size (100,000), so a real file is
  always one batch; a 100,000-row positions file is accepted as out of scope.
- **A header-only file** never enters the loop body. Measured on tool 2026-09-11 against
  the first draft: the response was `{batchId}` with no status at all. `n_Final`, after the
  loop, now answers it `INVALID_INPUT` with a reason, and the suite holds that case.
- **Key-minted ids after a hard delete**: re-uploading a code whose position was deleted
  targets the same id again. Bulk Manage People carries the same property.
