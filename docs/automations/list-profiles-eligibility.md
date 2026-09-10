# Change: `ICM | List Profiles` returns commission eligibility

**Workflow** `6a9c00e1c4f2d5527e4cb2ee` · v13 · deployed, current
**Status** spec written 2026-09-09 · draft not yet edited · NOT deployed

## Why

`Sales_Comp_Design_Final.md` adds `is_commission_eligible` to PAYEE — *"whether
this person is on a variable plan at all. The engine checks this before anything
else."* Its rule 4 then requires the field be **effective-dated**, because
*"was she eligible in March?"* is one of the two questions a payout dispute
always asks, and a single overwritable boolean cannot answer it in April.

So the value is not stored on `Payee`. It lives in **`PayeeEligibility`**
(created on tool prod 2026-09-09), one row per date range per person, the same
shape `PositionAttribute` and `PayeePositionAssignment` already use.

`List Profiles` is the automation that answers "who are these people, as of this
date" for the Profiles page. Eligibility is now part of that answer, and it must
be resolved **as of the same date as everything else in the row** — a profile
that reports March's seat beside today's eligibility is a row nobody can
reconcile.

The consumer bug this fixes: `app/src/data/platform-profile.ts:27` in the app repo
hardcodes `commissionEligible: true` for every row, inside a block explicitly
labelled placeholder. The dashboard's "Commission eligible" KPI therefore reads
100% on real data regardless of the truth.

## Contract change

**Input:** unchanged. The existing `asOfDate` already carries the date this
resolves against.

**Output:** each element of `profiles[]` gains two fields.

| field | type | meaning |
|---|---|---|
| `commissionEligible` | boolean | was this person on a variable plan on `asOfDate` |
| `eligibilityReason` | string | why not, when false. `''` when eligible or unknown |

**Respond statuses:** unchanged. Eligibility cannot fail the request — a person
with no eligibility row is not an error (see the default below).

## The default, and why it is `true`

A payee with **no** `PayeeEligibility` row covering the date resolves to
`commissionEligible: true`, `eligibilityReason: ''`.

Every existing person on prod has no row, because the object was created today.
Defaulting to `false` would tell the app that nobody in the company is on a
variable plan — a silent, total change to what every screen shows, caused by
adding a table rather than by anything a human decided. Defaulting to `true`
keeps today's answer exactly as it is until somebody writes a row that says
otherwise, which is the only safe direction for a field that gates pay.

This is a deliberate, stated default, not an accident: **absence means "nothing
has been said about this person", and the system's existing behaviour is that
everyone is eligible.**

## Design

One new fetch, folded into the existing bulk join. **No API call inside a loop** —
the page's payee ids are already collected by `n_PayIds` for exactly this kind of
bulk look, and eligibility joins the same way seat, title and manager already do.

### New node — `n_FtElig` (ACTION, storage fetch)

- **subTitle** `Each person's plan eligibility as of the date`
- **title** `Fetch records`
- **object** `PayeeEligibility`
- **filter** `payeeId IN {{ n_PayIds.outputs.payeeIds }}`
- Placed after `n_PayIds` and before `n_Fold`, alongside `n_FtAsg`.

Fetches every eligibility row for this page's people — **not** filtered by date
in the query. The date window is applied in the fold, by the `inForce` helper
that already exists there and already implements this exact rule for assignments
and attributes. One implementation of "was this in force on that day", not two.

### Changed node — `n_Fold` (code)

1. New input `eligRows` ← `n_FtElig.outputs.objects`.
2. Group by `payeeId`, keep rows where `inForce(row.properties, asOf)`.
3. On each profile row:

```groovy
def elig = eligByPayee[String.valueOf(r.id)]
row.commissionEligible = (elig == null) ? true : (elig.properties?.isCommissionEligible != false)
row.eligibilityReason  = (elig == null) ? '' : (elig.properties?.reason ?: '')
```

`!= false` rather than `== true` on purpose: **a boolean the platform never set
is MISSING, not `false`** (`notes/runtime-facts.md`). A row created without the
flag must not silently make someone ineligible.

4. Two rows covering the same date is a data bug, the same one
   `PositionAttribute` has. Reuse the existing `conflict` counting rather than
   inventing a second convention: take the first row, and count it.

### Changed node — `n_sTaRt`

Add `commissionEligible` and `eligibilityReason` to the `profiles[]` item schema
in `result`, so the contract states what the caller receives.

## The system of changes

| what points here | verdict |
|---|---|
| `ICM | List Payees` | **unaffected** — a name/id picker; it does not carry plan state and no caller reads eligibility from it |
| `ICM | Update Profile` | **accepted, deferred** — writing eligibility means creating a *dated row*, not setting a field, so it is a genuinely separate change with its own spec. Until then eligibility is set by whoever seeds the table. Detection: the field is read-only in the UI, so a user cannot reach a write path that does not exist |
| `ICM | Resolve Position Occupant` | **unaffected** — resolves a seat to a person; eligibility is not part of that question |
| App: `platform-profile.ts` | **cascade** — delete `commissionEligible: true` from `PLACEHOLDER` and read `row.commissionEligible` instead. The file's own comment already instructs this |
| App: `workforce-dashboard.tsx` | **unaffected in code** — reads `profile.commissionEligible`, which keeps its name and type. Its KPI stops being wrong |
| App: generated types | **cascade** — `/reconcile_knowledge` regenerates `ListProfilesResult` from this automation's own schema, so the app fails to compile until it reads the new field |
| Existing records | **unaffected** — additive, and the default preserves today's answer |

**How we would notice this is wrong:** the regression suite below asserts the
default explicitly, and the app's build fails if the result schema and the
consumer disagree.

## Regression suite — REQUIRED before deploy

`deploy.mjs` refuses to ship an automation without a green suite, and this one
has none today. `tests/6a9c00e1c4f2d5527e4cb2ee.json` must cover, at minimum:

1. **A person with no eligibility row** → `commissionEligible: true`, reason `''`.
   The default, which is the whole risk of this change.
2. **A row saying false, covering the date** → `false`, with its reason.
3. **A row saying false that ENDED before the date** → `true`. Effective dating
   actually working, rather than the newest row winning.
4. **A row starting after the date** → `true`. The other end of the window.
5. **The page shape is unchanged** — same `total`, `hasMore`, same profile count
   as before the change, so the join added a field and did not drop rows.

Case 3 is the one that matters: it is the March question the doc's rule 4 is
about, and the only case that distinguishes a dated table from a flag.

## Rollout

1. Edit the **draft** only. The deployed v13 keeps serving the live app throughout.
2. `node scripts/testrun.mjs` against the draft, with real prod data, read-only.
3. Build the suite above; `node scripts/regress.mjs 6a9c00e1c4f2d5527e4cb2ee` green.
4. `node scripts/ua.mjs validate 6a9c00e1c4f2d5527e4cb2ee` prints `clean`.
5. **Deploy only with an explicit human yes.** The moment it ships, every caller
   sees the new fields — that is what a deploy means here.
6. Then the app change, and `/reconcile_knowledge` in the app repo.
