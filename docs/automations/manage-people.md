# ICM | Manage People

**Built state (2026-09-10)**: **BUILT ON TOOL (prod) AS A DRAFT, 21 nodes.**
`ua.mjs validate` clean · `lint.mjs` clean · **suite 25/25 green**
(`tests/6aa2b0043aa7845ea19179f4.json`). **NOT DEPLOYED** — deploying is
`deploy.mjs` with its gates and an explicit human yes, and no caller can reach a
draft. Built directly on **tool**; orbit does not have it, matching the whole
Titles family.

Derived from the deployed `ICM | Manage Titles` structure plus one Currency
fetch. Definition authored directly rather than through the copilot — the work
was mechanical, and generating the setup schema, the fetch projection, the row
shape and the coercion from ONE field table is what keeps them from drifting
apart.

**The suite writes and cleans up after itself.** Its two fixtures are
`KITFIX-E-SUITE-01` and `KITFIX-E-SUITE-LEGACY`; both are deleted by the last two
cases, and prod was checked back to 21 `Payee` rows with no leftovers after the
run. `fixtures.mjs` is not used — that script is orbit-only, and this automation
lives on tool.

**Still blocked on the authorization question before DEPLOY** — see "Open, and
blocking" at the end. It is not a build detail; it changes who may read a salary.

## Two things the build corrected in this spec

**Null-valued keys do not survive between nodes.** The first test run showed
`draft` arriving at the guard without its four null keys — the platform drops
them when it serialises. So a blank NUMBER or DATE is now ABSENT from the draft
rather than null, and on UPDATE that means LEAVE IT ALONE. The honest
consequence: **clearing a terminationDate is not expressible today** and is not
pretended to be. It needs a real sentinel, and that is a follow-up.

**`status` defaults to `ACTIVE`, uppercase.** The 21 rows on tool carry
`ACTIVE` / `ON_LEAVE` / `TERMINATED` (18/1/2, read 2026-09-10). A mixed-case
`Active` would sort and filter as a second value.

| field | value |
|---|---|
| Token / name | `ICM \| Manage People` (`6aa2b0043aa7845ea19179f4`), tags from `kit.config.json` (`icm`), CALLABLE |
| Purpose | One callable behind the People screen: list the roster, create a person, edit a person. |
| Callers | **Pages** — the People screen (`app/src/routes/org/People.tsx`) and its Edit sheet, through `ds_manage_people` (`e_6aa2b25a9753751b39ba1321`) and `ds_people_filtered` (`e_6aa2b25b35cc1f4f3c876371`). See `docs/pages/people.md`. |
| Authorization | **NOT "any authenticated caller" — see below.** This reads `salary` and `personalTarget`. |

## Authorization is different here, and that is the whole reason this is not a copy of Manage Titles

`ICM | Manage Titles` can say *"`Title` is org structure, not money — no amount,
quota, attainment or payout field is read or written"*, and that sentence is what
lets it be callable by anyone authenticated.

**This callable cannot say that.** The 2026-09-10 schema change put `salary` and
`personalTarget` on `Payee`, so a LIST response carries every employee's
compensation. The shared contract's guard table is explicit: *"the caller may see
this participant's money" → `FORBIDDEN` → every read of earnings, payouts,
statements.* Salary is that.

This is stated here rather than solved here because the product has no role model
wired yet, and inventing one inside a screen's callable is how a rep ends up
reading the payroll. It is **question 1 in "Open, and blocking"**, and it blocks
DEPLOY, not build.

## Why one callable and not three

Same reasoning `manage-titles.md` gives, and it holds harder here: the
`employeeId` unique-key pre-check is identical code for CREATE and UPDATE, and
so is the first/last → `name` composition. Splitting the verbs copies both
guards into a second automation on day one.

**EXPORT is deliberately NOT a fourth verb** — it lives in
`ICM | Export People CSV`, exactly as Titles split it out, and for the reason
that spec records: a mode switch with five arms is a router.

## Entity study

`Payee` (`lcName: people`, shown to users as **People**), read from
`snapshots/tool/entity-types/Payee.json`.

**The eight fields that were always there:**

- `employeeId` — `uniqueKey: true` AND in `uniqueKeyFields`. **The pre-check
  target.** A collision at write time is a raw Mongo `E11000` that kills the run.
- `name` — `nameField: true`, required.
- `email`, `status` — plain strings; `status` is required.
- `userId` — FK `USER`, `foreignKeyConstraintEnforced: false`.
- `currencyId` — FK `ENTITY_ID:Currency`, required. **This is PAYMENT currency.**
- `hireDate`, `terminationDate` — `integer`, `format: date`, `dateFormat: epoch`.

**The eight added 2026-09-10**, so that every field the People screen renders is
backed by the object rather than by `app/src/data/org-seed.ts`:

- `firstName`, `lastName` — strings. See the composition rule below.
- `region`, `businessGroup`, `team` — strings.
- `personalTarget`, `salary` — **numbers. These are why the authorization row above
  is what it is.**
- `personalCurrencyId` — FK `ENTITY_ID:Currency`. Distinct from `currencyId`:
  the screen has shown "Personal Currency" and "Payment Currency" as two rows
  since it was seed-driven, and collapsing them onto one field would silently
  convert someone's target.

**`commissionEligible` is NOT on this object and must not be added.** It is a
dated row in `PayeeEligibility`, resolved as-of-a-date by
`ICM | List Profiles`. `People.tsx` already carries the comment explaining why:
*"was she eligible in March?" is the question a payout dispute always asks.* A
boolean on the person record answers that question wrongly and confidently.

### `name` is composed, never sent

`name` is required and is the `nameField`, and the screen collects First Name and
Last Name as two boxes. So:

```
name = [firstName, lastName].findAll { it }.join(' ')
```

computed in `n_Norm` on CREATE and on UPDATE. **`name` is not an input** — there
is no parameter for it. Two writers for one field is how a display name drifts
from the two boxes that are supposed to produce it.

The consequence for existing rows: the 11 `Payee` records that predate this
change have a `name` and no `firstName`/`lastName`. Editing one through this
screen and saving would compose `name` from two blank boxes and **blank the name
field**. That is guard `BACKFILL` below, and it is not optional.

## Period and money

No `periodId`, no period state machine, no rounding point — this writes no
amount that is ever summed. `personalTarget` and `salary` are stored as given.

**They are still money for authorization purposes**, which is the distinction the
authorization row turns on: money you may not *read* is a separate rule from
money you may not *miscompute*.

## Input (`setup`)

| field | type | required | blank / default |
|---|---|---|---|
| `action` | string | no | `""` → `LIST`. `LIST` · `CREATE` · `UPDATE`, case-insensitive |
| `payeeId` | string | for UPDATE | the platform entity id |
| `employeeId` | string | for CREATE | the unique key |
| `firstName` | string | for CREATE | |
| `lastName` | string | no | `""` |
| `email` `region` `businessGroup` `team` `status` | string | no | `""` — `status` defaults to **`ACTIVE`** (uppercase) on CREATE |
| `userId` `currencyId` `personalCurrencyId` | string | `currencyId` for CREATE | `""` |
| `hireDate` `terminationDate` | string | no | `""` → not set on CREATE, **LEAVE ALONE on UPDATE**. Epoch MILLIS as a numeric string, UTC |
| `personalTarget` `salary` | string | no | `""` → not set on CREATE, **LEAVE ALONE on UPDATE**. Numeric string; a non-numeric one is `INVALID_INPUT` |
| `search` | string | no | `""` → no filter. Matches `employeeId` OR `name` OR `email`, case-insensitively, SERVER-SIDE |
| `filter` | object or JSON string | no | `""` → unfiltered. Platform wire filter; see below |
| `limit` | string | no | `""` → `50`, clamped 1..200 |
| `offset` | string | no | `""` → `0` |

Every default is applied INSIDE the automation. Real callers send empty strings
for what they don't fill, so `""` is what each branch is built around, and every
parameter is read through `binding.hasVariable` — an unbound parameter is a
MISSING Groovy variable, not a null one, and a direct reference dies with
`No such property`.

**Dates are epoch millis in UTC, and the spec says so because the shared contract
requires it.** `hireDate` is a calendar day, and a browser in IST sending local
midnight stores the previous day in UTC. The page sends UTC midnight for the
chosen day; the automation does not re-interpret what it is given.

### Blank on UPDATE

**Blank means "clear it" for the optional fields, and "leave it" for the required
ones.** The caller is a form that posts every field, so a blank Region is a user
emptying the box. The required set — `employeeId`, `firstName`, `currencyId`,
`status` — is left alone when blank, because a blank unique key must never blank
out the unique key. Same split as Titles, same reason, stated because neither
half is guessable.

## Output

| status | meaning |
|---|---|
| `OK` | the list. An empty result is `OK` with `people: []`, not an error |
| `CREATED` | one person made; `person` carries it, `total` is 1 |
| `UPDATED` | one person edited; `person` carries it |
| `DUPLICATE_EMPLOYEE_ID` | `employeeId` already belongs to another record — refused BEFORE any write |
| `NOT_FOUND` | UPDATE against an id that no longer exists |
| `INVALID_INPUT` | unknown action, missing required field, non-numeric paging/money/date, or a filter problem |

```
status, success, message, action, total, hasMore, offset, limit,
people [ { payeeId, employeeId, firstName, lastName, name, email,
           userId, currencyId, currencyCode, personalCurrencyId,
           personalCurrencyCode, hireDate, terminationDate, status,
           region, businessGroup, team, personalTarget, salary } ],
person { same shape },
currencies [ { currencyId, code, name } ]
```

`required` is `["status","success","message","total","people"]` and nothing more.

### `currencies[]` rides along on LIST, and that is on purpose

The screen needs a Currency dropdown for two fields, and `Currency` is a table of
a handful of rows. Two ways to feed it: a second callable and a second data
source, or one extra bulk fetch inside a call the screen already makes.

**The second is right here and would be wrong at scale.** It is right because the
alternative is a whole `e_data_source` and a round trip for a list that changes
about never; it would be wrong if `Currency` grew, and the moment it does this
moves out. Written down so the trade is visible rather than discovered.

The same fetch resolves `currencyCode` and `personalCurrencyCode` on every row —
**one bulk fetch, joined in one code step, never one call per row.**

## Node plan

Mirrors Manage Titles, plus the currency join and the backfill guard.

1. **`n_sTaRt`** START, CALLABLE. **Carries `trigger: {type: "CALLABLE"}`** —
   without it `validate` dies with `Node.getTrigger() is null`, an HTTP 500 that
   names no node. Recorded in `manage-titles.md`; not to be relearned.
2. **`n_Norm`** Groovy — defaults, validation, `name` composition, money and date
   coercion, and all filters built as objects and passed as single pills. The
   LIST search is a nested `OR` inside the `AND`, which a node's static config
   cannot express.
3. **`n_IfBad`** IF `valid == false` → **`n_StBad`** STOP `INVALID_INPUT`.
4. **`n_FtCur`** fetch `Currency` (all rows, small table) — feeds both the LIST
   join and the `currencies[]` block. Runs on every path; `options.cacheConfig`
   TTL is a candidate here and is NOT set in v1 (this flow never writes
   `Currency`, so it would be safe — left off until there is a reason).
5. **`n_IfList`** IF `action == LIST`:
   - **`n_FtList`** fetch `Payee`, `includeTotalCount` → **`n_Rows`** Groovy
     (flatten, join currency codes, count) → **`n_StList`** STOP `OK`.
6. Otherwise the write path, **guards before the side effect**:
   - **`n_FtDup`** fetch `Payee` where `employeeId EQUAL <employeeId>`, limit 5.
   - **`n_FtOne`** fetch `Payee` where `id EQUAL <payeeId>`, limit 1. Both use a
     `__none__` sentinel when the branch does not apply, so neither ever runs
     unfiltered.
   - **`n_Guard`** Groovy — duplicate (any row whose id differs from `payeeId`),
     not-found, **BACKFILL**, and the merged record to write.
   - **`n_IfDup`** → **`n_StDup`** STOP `DUPLICATE_EMPLOYEE_ID`.
   - **`n_IfNF`** → **`n_StNF`** STOP `NOT_FOUND`.
   - **`n_IfCr`** IF `action == CREATE` → **`n_Create`** create record →
     **`n_StCr`** STOP `CREATED`; else **`n_Update`** update record by id →
     **`n_StUp`** STOP `UPDATED`.

Every `groupId` is computed by the build script, never typed.

### The BACKFILL guard

In `n_Guard`, on UPDATE only:

> If the stored record has a `name` but no `firstName` and no `lastName`, and the
> caller sent both blank, then split the stored `name` on the first space into
> `firstName`/`lastName` and keep `name` as it was.

Without it, the first edit of any pre-2026-09-10 record blanks the `nameField` of
a person. **It is a one-time migration expressed as a guard**, because a real
backfill script over 11 rows is more moving parts than the rule it replaces, and
the rule is inert once every row has the two fields.

**How we would notice if it is wrong:** a regression case that updates a
name-only fixture and asserts `name` survives.

## The four questions, for each node that leaves the automation

**`n_Create`** (`storage_by_unifyapps_create_record`)
- **SENT**: `object_type: Payee` and the whole merged record from `n_Guard` —
  the 16 writable fields plus the composed `name`.
- **NOT sent**: `useUuid`, `batching`, `useRawPayload` — left at their `false`
  defaults; the record is a plain map. **`id`** — the platform mints it.
- **WHEN**: only after `valid`, not-duplicate, and `action == CREATE`.
- **NOT called**: on LIST, on a duplicate employeeId, on UPDATE. All correct.

**`n_Update`** (`storage_by_unifyapps_update_record_by_id`)
- **SENT**: `recordId` from `n_Norm`, `upsert: false`, the merged record.
- **NOT sent**: `upsert: true` — deliberately. An UPDATE against a missing id is
  `NOT_FOUND`, a caller-actionable fact; upsert would mint a record with a
  caller-supplied id.
- **WHEN**: after `valid`, not-duplicate, target exists, `action == UPDATE`.
- **NOT called**: every other path.

**`n_FtCur`** (`storage_by_unifyapps_fetch_records`, `Currency`)
- **SENT**: `object_type: Currency`, no filter, `page.limit` 200.
- **NOT sent**: a filter — the whole table is the point.
- **WHEN**: every path except the `INVALID_INPUT` short-circuit.
- **NOT called**: on invalid input, because nothing is rendered then.

## The filter block (LIST only)

Same wire shape the Titles screen sends, the same one `toWireFilter` builds:

```
{ op: 'AND' | 'OR', values: [ { field, op, values: [v] }, ... ] }
```

translated in `n_Norm` into the storage dialect:

```
{ operator, filters: [ { property: 'properties.<field>', filter: { operator, value } } ] }
```

Passing the wire shape straight through answers HTTP 500 `Filter$Op ... op is
null` at RUN time, naming no node.

### What it accepts — TEXT only, by decision

`employeeId` · `firstName` · `lastName` · `name` · `email` · `status` ·
`region` · `businessGroup` · `team`.

Operators are exactly what `platform-filter.ts` offers for TEXT: `EQUAL`,
`NOT_EQUAL`, `ICONTAINS`, `NOT_ICONTAINS`, `CONTAINS`, `NOT_CONTAINS`,
`STARTS_WITH`, `NOT_STARTS_WITH`, `ENDS_WITH`, `NOT_ENDS_WITH`, `REGEX`,
`NOT_REGEX` (one value each), plus `EXISTS` and `MISSING` (none).

**`hireDate`, `terminationDate`, `personalTarget` and `salary` are NOT
filterable, and that is a decision taken 2026-09-10, not an oversight.** Titles
records the rule: adding a NUMBER or DATE field to the screen's filter list means
teaching this node the two-value `BETWEEN` shape FIRST — otherwise the screen
offers `BETWEEN` and the automation refuses it, which reads to a user as a broken
filter rather than an unfinished one. That work was explicitly deferred.

**So `PEOPLE_FILTER_FIELDS` in the app must not list them.** The screen is the
half that can violate this silently.

### Rules

- **Groups nest.** A node with no `field` is a group; `values` holds its children.
- **An empty group is dropped, not refused** — a filter the user started and did
  not finish, and the screen already shows every row unfiltered.
- **Every problem is collected**, then named in one `INVALID_INPUT`.
- **Search and filter are ANDed.** The box narrows what the block selected.
- A `REGEX` value is compiled in `n_Norm`, so a bad pattern is `INVALID_INPUT`
  and not an engine error.

## The data sources — two rows, and why

`validateDataSourceContextAndInputs` compares a request's parameter KEYS against
the stored row's, so one row cannot serve two key sets.

| row | id | keys | used by |
|---|---|---|---|
| `ds_manage_people` | `e_6aa2b25a9753751b39ba1321` | the 20 without `filter` | create + edit writes |
| `ds_people_filtered` | `e_6aa2b25b35cc1f4f3c876371` | those 20 plus `filter` | the list |

**Both rows store NO `version` and NO `runtimeConnections`**, unlike the older
Titles rows — read back off the stored rows after creation, not assumed.
`app/src/data/callables.ts` mirrors that exactly, because sending a key the row
does not have is `forbidden datasource : invalid input`.

**Titles learned this the expensive way**: adding `filter` to `ds_manage_titles`
would have refused every call from the already-deployed app and taken the live
Titles page down, so `ds_titles_filtered` became a third row. Building People
with two rows from the start is that lesson applied rather than repeated.

Both are provisioned by `scripts/ua-datasource.mjs` against this app's global
page (`e_global_app-1621b11a65c8`). **Ids are read off the stored row, never
invented** — a wrong id is `forbidden datasource: not found`.

## Changes — the system of changes

| thing | verb | verdict | how would we notice if this is wrong? |
|---|---|---|---|
| `Payee` object | **change** (8 fields added) | **cascade** — `ua-schema.mjs add-fields`, additive only, never removes or retypes. Every existing row keeps working; the new fields are MISSING, not empty | `ua.mjs snap-types --tag icm --env tool` diff; `contracts/objects/Payee.json` regenerated by `/reconcile_knowledge` |
| `ICM \| List Payees` (`6a9c001e723e7964da56efee`) | unaffected | **unaffected** — read-only, 4 inputs, feeds the Create Position payee dropdown via `LIST_PAYEES`. Its key set and contract are untouched. Two callables over one object is the same pattern `List Titles` / `Manage Titles` already establishes | `app/src/data/positions.ts:205` still resolves; Create Position suite |
| `ICM \| List Profiles` (`6a9c00e1c4f2d5527e4cb2ee`) | reads `Payee` | **unaffected** — projects named fields; added properties cannot collide | its own suite |
| `ICM \| Resolve Position Occupant` | reads `Payee` | **unaffected** — same reason | its own suite |
| `People.tsx` | rewrite | **cascade** — seed-driven page becomes callable-driven, mirroring `Titles.tsx` | `bun run build` is the typecheck gate |
| `app/src/data/org-seed.ts` `PEOPLE` | orphaned | **accepted** — `Profile` still uses it; the `Person` seed loses its only consumer and is left in place rather than deleted in the same change | grep for `PEOPLE` after the page lands |
| `useOrgRecordsStore.addPerson` | orphaned | **cascade** — the Zustand client-side create disappears with the page; a create is a server write now | grep `addPerson` |
| `docs/pages/people.md` | create | **cascade** — nothing on the platform records a page's callable dependency | `graph.mjs --check` |
| Orbit | diverged | **accepted, by instruction** — built on tool only, like the whole Titles family | `inventory --tag icm` on both envs |

## Tests

`tests/6aa2b0043aa7845ea19179f4.json` — **25 cases, all green on tool
2026-09-10**. `deploy.mjs` refuses to ship without them. The suite the shared
contract requires, plus what is specific here:

| case | asserts |
|---|---|
| all-empty-strings | `OK`, LIST default paging, no crash on `"" as Integer` |
| CREATE minimal | `CREATED`; `name` composed from first+last |
| **CREATE the same payload again** | `DUPLICATE_EMPLOYEE_ID`, never an engine error |
| UPDATE stale id | `NOT_FOUND` |
| **UPDATE a name-only record with both name boxes blank** | `name` SURVIVES — the BACKFILL guard |
| UPDATE clearing an optional field | `region` cleared |
| UPDATE with blank `employeeId` | unique key NOT blanked |
| non-numeric `salary` | `INVALID_INPUT` |
| paging | `offset`/`limit`/`hasMore`/`total` agree |
| search matching nothing | `OK` with `people: []` |
| filter: `region EQUAL X` | translated to `properties.region` |
| filter: unknown field + `BETWEEN` | `INVALID_INPUT` naming BOTH problems |
| filter + search together | ANDed |

**The write cases seed and clean up their own fixtures**, inline, via the suite's
own `entityCreate` / `entityDelete` verbs. `fixtures.mjs` is not involved: that
script is orbit-only because its `reset` deletes by PREFIX MATCH, which is the
part that does not belong on production. Two loudly-named records created and
deleted by the same run is a different risk, and it writes no payout and touches
no period — the ICM rule stands.

Checked after the run: 21 `Payee` rows, no `KITFIX-E-SUITE` leftovers.

## Open, and blocking

1. **Authorization.** Stated at the top: this callable returns salary. Who may
   call it, and what does it do when the caller may not? A `FORBIDDEN` status is
   in the shared contract's guard table; there is no role model wired to decide
   it. **This blocks deploy, not build.**
2. **The 11 existing rows have no `firstName`/`lastName`.** The BACKFILL guard
   covers the edit path. Nothing covers the LIST path, where the screen shows a
   First Name column that is empty for every legacy row — acceptable, and worth
   the product team seeing before it ships.

## Notes

- **Accepted debt**: fetch/write failures reach the caller as the platform's
  error (`fallbackMode: STOP`) — an infrastructure failure is not a business
  outcome. Same trade as every other ICM callable.
- Single write per run, so there is no half-done state and no
  duplicate-on-retry question.
- The `currencies[]` ride-along is a deliberate, reversible trade — see above.


## Call volume — this one does not have the Titles problem (checked 2026-09-10)

`ICM | Manage Titles` reached 862 runs because option lists were fetched eagerly
by pages that were not showing them — see the "Call volume" section of
`manage-titles.md` for the full finding.

**This callable has exactly ONE consumer**: `app/src/routes/org/People.tsx`, which
calls it per search / filter / page change and once per write. There is no
options hook, no second cache key, and nothing fetches it from a page that is not
the People screen.

**The Currency picker is the reason it stays that way.** `currencies[]` rides
along on the LIST response, so the two currency dropdowns cost ZERO extra calls.
Had they been given their own lookup callable, every mount of the create dialog
would have been another run — which is precisely the shape that produced 862.

**The trap to avoid later**: a `usePeopleOptions()` for some other screen's
dropdown. If one is ever needed, it goes through a single shared hook, gated on
the UI that needs it being open, with a `staleTime` — the pattern
`useTitleOptions` was rewritten into, not the one it started as.
