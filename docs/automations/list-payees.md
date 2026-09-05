# ICM | List Payees

**Built state (2026-09-05)**: **DEPLOYED on tool**, id `6a9c001e723e7964da56efee`,
7 nodes. Suite `tests/6a9c001e723e7964da56efee.json` **10/10 green**, `validate`
and `lint` clean.

| field | value |
|---|---|
| Token / name | `ICM \| List Payees` (`6a9c001e723e7964da56efee`), tag `icm`, CALLABLE |
| Purpose | A searchable, paged list of people — enough to PICK one, and no more. |
| Callers | The Positions screen's Create dialog, for its Person select. Any later screen that has to choose a person. |
| Authorization | Any authenticated caller. It returns name, employee id, email and status — **org identity, never money.** No amount, quota, attainment or payout appears in it, which is what keeps it open. Adding one changes this row and the caller check together, or the change is refused. |

## Why it returns so little

A payee record carries more than a picker needs — currency, hire and termination
dates, the platform `userId` that links to a login. This returns five fields
because a select renders two of them, and every extra field is one more thing a
screen can leak by rendering it "just in case".

## Input (`setup`)

| field | type | required | blank / default |
|---|---|---|---|
| `search` | string | no | `""` → everything, paged. Matches the **name OR the employee id**, `ICONTAINS`, because those are the two things a human types |
| `limit` | string | no | `""` → `50`. Clamped to 1..200 |
| `offset` | string | no | `""` → `0` |
| `activeOnly` | string | no | `""` → **false**, everyone. `"true"` excludes `TERMINATED` |

**`activeOnly` defaults to FALSE on purpose.** A terminated payee must stay
findable — `ICM | List Positions` deliberately shows that one held a position
historically, and a picker that could not find them would make that history
unexplainable. It is the CALLER that knows whether the question is "who exists"
or "who could take this seat"; the Create dialog passes `"true"` because
offering a leaver a brand-new seat is the mistake worth preventing. Both halves
are pinned by cases.

## Output

| status | meaning |
|---|---|
| `OK` | the page, however long. Empty is `OK` with `payees: []`, not an error |
| `INVALID_INPUT` | `limit` or `offset` non-numeric |

```
status, success, message, total, hasMore, offset, limit,
payees [ { payeeId, employeeId, name, email, status } ]
```

`required` is `["status","success","message","total","payees"]` and nothing more.

## Changes — the system of changes

| thing | verb | verdict | how would we notice if this is wrong? |
|---|---|---|---|
| `ICM \| Create Position` | unaffected | **unaffected** — it takes a `payeeId` and validates it itself, so it never trusts this list. The two agree only on what an id IS | Create's `PAYEE_NOT_FOUND` case would go red if ids stopped meaning the same thing |
| Positions page Create dialog | create | **cascade** — it is the first caller and passes `activeOnly: "true"` | `docs/pages/` records page→callable dependencies; the dialog losing this call is drift |
| `Payee` object | unaffected | **unaffected** — read-only, no schema change, and only five of its fields are projected | `ua.mjs snap-types --tag icm` diff; a renamed field breaks the projection and the suite goes red |
| Returning money later | accepted | **blocks** — the Authorization row above is why this callable is open to any authenticated caller. Adding a quota or payout field is not a widening, it is a different callable with a different check | this row, and the fact that a reviewer must edit it to ship the change |

## Tests

`node scripts/regress.mjs 6a9c001e723e7964da56efee` — **10 cases**, all read-only
and idempotent. They assert against `KITFIX-` fixtures, so real payees arriving or
leaving on tool cannot redden the suite.

| case | asserts |
|---|---|
| every input blank | `OK`, defaults applied, the fixture family returned |
| `search` by employee id | exactly one, `total` reflects the filter — proves it narrows server-side |
| `search` by name, different case | same one — `ICONTAINS` is case-insensitive |
| `search` matching nothing | `OK`, `payees: []`, `total: 0` |
| `activeOnly: "true"` on a terminated payee | `total: 0` — not offerable for a new seat |
| the same payee without `activeOnly` | returned, `status: "TERMINATED"` — still findable |
| `limit`/`offset` paging | `hasMore` true, page respects the limit |
| `limit: "5000"` | clamped to 200 rather than trusted |
| `limit: "abc"` · `offset: "-3"` | `INVALID_INPUT` |
