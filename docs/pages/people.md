# Page | People

**Built state (2026-09-10)**: **CODE WRITTEN, GATES GREEN, NOT DEPLOYED.**
`tsc -b` clean · `oxlint` clean for every file touched · `vite build` succeeds.
The automations behind it are DRAFTS, so the page cannot work in the product
until they are deployed — a call to a draft reaches nothing.

**This is a CODE page, not a builder page.** Every other file in this folder
describes a page built through the `ua-agent-devkit` MCP tools. This one is a
React route in the **Ledger** repo (`Sales-Commission-Management`), branch
`managing-people`:

| file | what it is |
|---|---|
| `app/src/routes/org/People.tsx` | the screen |
| `app/src/data/people.ts` | the data layer — the ONLY thing that talks to the callables |
| `app/src/data/callables.ts` | the three `e_data_source` bindings, read off the stored rows |
| `app/src/data/csv-export.ts` | the signed-URL crossing, shared with Titles |

The devkit's `/start` and `/restore` do not apply — git is the undo. **The reason
this file exists is unchanged: nothing on the platform records that a page calls
a callable, so the dependency lives here and nowhere else.**

## What it calls

| data source | id | automation | used for |
|---|---|---|---|
| `ds_people_filtered` | `e_6aa2b25b35cc1f4f3c876371` | `ICM \| Manage People` (`6aa2b0043aa7845ea19179f4`) | the list — search, filter block, paging |
| `ds_manage_people` | `e_6aa2b25a9753751b39ba1321` | same automation | Create and Edit writes |
| `ds_export_people_csv` | `e_6aa2b25b9753751b39ba1323` | `ICM \| Export People CSV` (`6aa2b1e58f7899040900afe2`) | the Download button |

**Two rows against one automation, from the start.** The key sets differ by
exactly `filter`, and `validateDataSourceContextAndInputs` compares a request's
parameter KEYS against the stored row — so one row cannot serve both. Titles
learned this after the fact and needed a third row bolted on; People is built
with both from day one.

**These rows carry NO `version` and NO `runtimeConnections`**, unlike the older
Titles rows. `callables.ts` mirrors that exactly, because a key the row does not
have is `forbidden datasource : invalid input`.

**It does NOT call `ICM | List Payees`** (`6a9c001e723e7964da56efee`). That
read-only callable stays where it is, feeding the Create Position payee dropdown
through `app/src/data/positions.ts`. Two callables over one object is the same
pattern `List Titles` / `Manage Titles` already runs.

## The screen

Mirrors Titles, because it is the same shape of problem and a second layout for
the same job is a second thing to maintain.

- **Toolbar**: search (debounced 300 ms, server-side), a `FilterBuilder`, Create,
  Download.
- **Table**: Person (composed name + email) · Employee ID · Region · Status ·
  Personal Target · Salary. Six columns, the same density the seed-driven page had.
- **Create** is a DIALOG; **Edit** is a SHEET opening from the row. Same split and
  same reason as Titles.
- **Pagination** sizes itself from `total`, which is the count of every matching
  row rather than the page — the automation's fetch asks for `includeTotalCount`.

### The Currency picker is fed by the list call

`ICM | Manage People` returns `currencies[]` alongside `people[]`, so the two
currency dropdowns cannot offer a currency that does not exist, and there is no
second data source for a table of six rows. That is why `usePeople` takes the
WHOLE response instead of a `recordsPath` — the rows and the lookup table arrive
together.

**The trade is written down in the automation's spec**: right at this size,
wrong if `Currency` ever grows.

### Two things the screen must not do

1. **Never list `hireDate`, `terminationDate`, `personalTarget` or `salary` in
   `PEOPLE_FILTER_FIELDS`.** The automation's translator speaks single-value
   operators only. Listing a DATE or NUMBER field makes the block offer `BETWEEN`
   and the automation refuse it, which reads as a broken filter rather than an
   unfinished one. **The screen is the half that can violate this silently.**
2. **Never point the browser at the export's signed URL.** A navigation carries no
   auth layer, so the file 401s while the callable that wrote it has already
   succeeded — a Download button that toasts and does nothing. The bytes are
   fetched and saved as a blob; see `csv-export.ts`.

### Dates cross at UTC, in one place

The object stores epoch millis; `DatePicker` speaks `yyyy-MM-dd`; a hire date is
a CALENDAR DAY. `isoToEpoch` / `epochToIso` in `people.ts` pin both directions to
UTC, and the table renders with `timeZone: 'UTC'` for the same reason. A date
parsed as local and re-serialised lands a day earlier for everyone west of
Greenwich, and a hire date that drifts across a period boundary moves someone's pay.

### Money is formatted defensively

`Intl.NumberFormat` THROWS on anything that is not valid ISO 4217, and this
roster genuinely holds `KITFIX-INR`. A picker fed by real data will eventually
contain something Intl refuses, so `money()` falls back to a plain number plus the
code rather than taking the table down over one row.

## What this page replaced

The old `People.tsx` read `PEOPLE` and `PROFILES` from `app/src/data/org-seed.ts`,
searched on the client, had no paging, no filter block and no download, and its
Create wrote to a Zustand store that vanished on reload while Edit was a
`toast('Edit Person')` stub.

| thing | verdict |
|---|---|
| `org-seed.ts` `PEOPLE` | **accepted** — orphaned by this change, left in place. `Profile` still uses the same file, and deleting a seed in the same commit as a rewrite makes the diff unreadable |
| `useOrgRecordsStore.addPerson` | **cascade** — the client-side create is gone; a create is a server write now |
| `commissionEligible` | **unaffected** — still resolved as-of-a-date from `PayeeEligibility` by `ICM \| List Profiles`, still NOT a field on `Payee`. It is deliberately absent from this screen rather than moved onto the person record |

## Open, and blocking deploy

**This page shows and exports everyone's salary.** `Payee` gained `salary` and
`personalTarget` on 2026-09-10, so neither callable can claim the "org structure,
not money" exemption Titles relies on, and no role model is wired to decide who
may call them. Question 1 in `manage-people.md`, sharpened in
`export-people-csv.md` because the export hands over the whole roster in one file
that leaves the platform.

**The 11 rows that predate the schema change have no `firstName`/`lastName`.** The
table falls back to the composed `name`, and the edit path repairs them one at a
time via the automation's BACKFILL guard. Until someone is edited, the exported
CSV shows empty First/Last columns for them — visible in the verification export
taken 2026-09-10.
