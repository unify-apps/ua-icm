# ICM | Bulk Manage Titles · ICM | Bulk Manage People

**One spec for two automations, deliberately.** They are generated from a single
description that differs only by object, unique key and column table, so two
files would be one truth in two places. The shared-contract rule allows a spec
per "tight family"; this is one.

**Built state (2026-09-10)**: **BUILT ON TOOL (prod) AS DRAFTS.**
`ua.mjs validate` clean · `lint.mjs` clean for both. **NOT DEPLOYED.**

| | id | nodes | data source |
|---|---|---|---|
| `ICM \| Bulk Manage Titles` | `6aa2c0793c7f7b6b9117ea02` | 7 | `ds_bulk_manage_titles` `e_6aa2c15d6838a70636280355` |
| `ICM \| Bulk Manage People` | `6aa2c07a3aa7845ea195a187` | 8 | `ds_bulk_manage_people` `e_6aa2c15e6838a70636280379` |

Modelled on the deployed `ICM | Bulk Manage Position Hierarchy`
(`6aa29545ff41994689abebb8`), which the Hierarchy screen already uses.

| field | value |
|---|---|
| Purpose | Create and update from a CSV, matched on the object's unique key, with a per-row verdict for every line. |
| Callers | **Pages** — the Titles and People screens' Upload button. See `docs/pages/people.md`. |
| Authorization | **Titles: org structure.** **People: WRITES SALARY IN BULK** — see below. |

## Authorization: the People one is the sharpest edge in this repo

`ICM | Manage People` reads salary. **This one WRITES it, for the whole roster,
from a file.** A mistake here is not a bad screen — it is everyone's
compensation overwritten in one call, and the only record of what it used to be
is whatever the audit log kept.

That is on top of the unanswered question 1 in `manage-people.md`. Until there is
a rule about who may call these, **the People one must not deploy.** The Titles
one carries no money and is the lower risk of the two.

## Input (`setup`)

| field | type | required | blank / default |
|---|---|---|---|
| `fileDetails` | object | yes | the uploader's file object. `sourceType` + `source` are what the loop node reads |
| `batchId` | string | no | echoed back so a run can be referred to |
| `dryRun` | string | no | `'true'` validates and reports, writing NOTHING |

## Output

| status | meaning |
|---|---|
| `APPLIED` | every row accepted |
| `PARTIAL` | some accepted, some refused. The accepted ones ARE written |
| `REFUSED` | every row refused; nothing written |
| `INVALID_INPUT` | the file produced no rows at all |

```
status, batchId, applied, written, message,
rows [ { line, outcome, error, ...the file's own columns } ]
```

**`applied` counts rows created or updated; `written` counts rows actually
written.** They differ exactly on a dry run, where `applied` is the preview and
`written` is 0.

**Every row comes back, not just the failures.** The result file is the user's own
file with `outcome` and `error` appended, so it can be corrected and re-uploaded
whole rather than reassembled by hand.

### Outcomes

`created` · `updated` · `unchanged` · `error`

**`unchanged` is reported and NOT written.** Re-uploading the template unedited
says "nothing to change" instead of bumping the version of every record in the
catalog. Verified: the second upload of an identical file returned `applied: 0`,
`written: 0`, both rows `unchanged`.

## Columns

**Titles** (`title_code` is the key): `title_code` · `name` · `description` ·
`category` · `level` · `market` · `function` · `pay_period`

**People** (`employee_id` is the key): `employee_id` · `first_name` ·
`last_name` · `email` · `region` · `business_group` · `team` · `status` ·
`hire_date` · `termination_date` · `payment_currency` · `personal_currency` ·
`personal_target` · `salary`

- **Currency columns carry CODES, not entity ids.** A file of `e_6a9c…` is not
  something a person can read or edit. Resolved from one bulk `Currency` fetch;
  an unknown code is that row's error, not the run's.
- **Dates are `yyyy-MM-dd`, read as UTC calendar days** — the same shape
  `ICM | Export People CSV` writes, so a downloaded file can be edited and sent
  straight back.
- **`name` is COMPOSED from first + last and is not a column**, exactly as in
  `ICM | Manage People`. Two writers for one field is how a display name drifts.
- **A column the file omits keeps its stored value.** A bulk upload is not a form:
  an absent column means "not mentioned", never "clear it". This is why only the
  file's own columns are `SET`.

## Node plan

`n_sTaRt` → `n_FtEx` (→ `n_FtCur`, People only) → `n_Loop` → [`n_Plan` →
`n_Ups` → `n_Err` → loopback] → `n_StDone`

**`n_Loop` is `csv_by_unifyapps_for_each_row_or_rows` with `batch: true,
batchSize: 5000`.** That is the whole reason this design is allowed: the loop
hands the ENTIRE file to one Groovy node, which validates it against the whole
catalog and produces ONE bulk upsert. A per-row loop would be an API call per
row, which the architecture rules forbid outright.

Edges mirror the source exactly: they carry **no `id`**, and the loop-back is a
`next` edge NAMED `loopback` rather than a type of its own.

## Three traps this build paid for, on 2026-09-10

**1. A bare `{ … }` block in Groovy is a CLOSURE, not a block.** The generated
per-column validation used `{ … }` blocks for scoping. Groovy parses a brace
block following an expression as a closure ARGUMENT, so `def rec = [:]` followed
by two blocks became "call that map with two closures" and died at RUN time with
`No signature of method: java.util.LinkedHashMap.call()`, naming no column. Each
column now gets its own variable instead.

**2. The bulk upsert takes `updateFields`, and SILENTLY ACCEPTS a flat map.**
`storage_by_unifyapps_bulk_upsert_records_by_id` wants
`{id, updateFields: [{fieldName: 'properties.x', actionType: 'SET', setValue: v}]}`.
Given a flat property map instead, it answered **`success: true` with
`successCount: 0`** and wrote nothing — so the run reported `written: 2`, the
caller was told the file applied, and no record moved. Caught only by reading the
`Title` count back afterwards. **This is the failure mode to remember: the node
does not refuse a wrong payload shape, it ignores it.**

**3. `n_Ups` answers `success: false` when `updates` is empty.** That is what an
all-`unchanged` file produces, and it is not an error. Nothing branches on it —
the STOP node's status comes from `n_Plan`, which is the only node that knows
what the file meant. Worth knowing before someone "fixes" it.

## Idempotency

New records need an id before they exist, so one is **minted from the unique
key** (`md5('<Object>|' + key)`), not from randomness. The same row uploaded
twice targets the same record rather than minting a second one — which is what
makes a re-upload safe, and what makes `unchanged` reachable at all.

## Tested on tool, 2026-09-10

Headlessly, via a throwaway `ICM | Make Test CSV (KIT TEST - safe to delete)`
that wrote a CSV to storage from JSON — because the app's uploader is Uppy's S3
multipart flow and is not reproducible from a script. **That automation has been
deleted**; `search --tag icmkit-test` returns nothing.

| case | result |
|---|---|
| dry run, 4 rows (2 good, 1 in-file duplicate, 1 missing key) | `PARTIAL`, `applied: 2`, **`written: 0`** |
| the same file applied | `PARTIAL`, `applied: 2`, `written: 2`; `Title` 11 → 13, both rows correct |
| **the same file again** | `PARTIAL`, `applied: 0`, `written: 0`, both rows `unchanged` |

Test records were deleted afterwards; `Title` is back to 11.

**Not yet tested: the People one.** It is generated from the same source as the
Titles one and gated identically, but it has NOT been exercised against a file —
its currency resolution, date parsing and number coercion are unproven at
runtime. **That, plus the authorization question, is why it must not deploy yet.**

## Tests

**No `tests/<id>.json` suite for either, and `deploy.mjs` will refuse them
because of it.** A suite needs a `fileDetails` for a file in storage, and
`regress.mjs` has no verb that puts one there. Options, none yet taken:

1. Teach `regress.mjs` a `fileCreate` verb (the throwaway proves the mechanism).
2. Keep a permanent fixture file in storage and reference it by `source`.

This is the honest blocker on deploying these two, and it is a real one.

## Changes — the system of changes

| thing | verb | verdict | how would we notice if this is wrong? |
|---|---|---|---|
| `Title` / `Payee` objects | bulk write | **cascade** — a new field is a new column here, or it is silently unwritable from a file | a column in the template with no effect |
| `ICM \| Manage Titles` / `Manage People` | sibling | **accepted** — same objects, same unique keys, different entry point. The unique-key guard is duplicated in Groovy rather than shared | a create that one refuses and the other accepts |
| Titles / People pages | cascade | `showUpload` + `onUpload` wired; `docs/pages/people.md` records it | `graph.mjs --check` |
| `ICM \| Bulk Manage Position Hierarchy` | unaffected | **unaffected** — its own automation, own columns, own screen | its own behaviour |
