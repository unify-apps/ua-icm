# ICM | Create / List Credit & Payout Rules

**Built state (2026-09-07)**: four callables on tool, all suites green.

| callable | id | suite |
|---|---|---|
| `ICM \| Create Credit Rule` | `6a9eb7623aa7845ea189ac2d` | 8/8 |
| `ICM \| Create Payout Rule` | `6a9eb76200191677c2e0740a` | 5/5 |
| `ICM \| List Credit Rules` | `6a9eb762057e966846c793b4` | 22/22 |
| `ICM \| List Payout Rules` | `6a9eb762b614217b0da02797` | 22/22 |

Caller: the Plan Design → Rules screen and its Create Rule pages.

## Storage: one `Rule` object, two stages

A rule is a header plus two ordered lists. Both lists live on the same record as
`json`, by decision — a normalised `RuleCondition` / `RuleResult` pair was the
alternative and was not taken.

**Every ordered list is `{ items: [...] }`, never a bare array.** A bare array
written into a `json` property is silently dropped: 200, a record id, and the
field reads back `{}`. See `notes/runtime-facts.md`. A rule whose conditions
vanished still saves, still lists and still looks right — it just matches every
deal instead of the ones it was written for.

`stage` (`credit` | `payout`) is what separates the two families. It is written
by the create callable and filtered by the list callable, and in neither case is
it a caller input: a payout rule must not be filable as a credit one, and must
never surface in the credit list however the caller filters. Both list suites
seed a rule of the OTHER stage purely so that guard is testable.

## Create — inputs and refusals

| field | required | note |
|---|---|---|
| `name` | **yes** | |
| `ruleType` | **yes** | |
| `description`, `tags` | no | |
| `activeStart`, `activeEnd` | no | `YYYY-MM-DD` or epoch ms. `""` means UNSET, not today — a rule with no window is in force for all time |
| `rollableOnReporting` | credit only | |
| `multiplier` | payout only | |
| `conditionsJson`, `resultsJson` | no / **effectively yes** | JSON arrays as strings, parsed server-side |

| status | meaning |
|---|---|
| `OK` | created. Returns `ruleId`, `recordId`, `conditionCount`, `resultCount` |
| `INVALID_INPUT` | missing name or ruleType, unparseable JSON, a result with no name, no results at all, a bad date, or `activeEnd` before `activeStart` |
| `DUPLICATE_RULE_ID` | the minted id collided; the caller should retry |

**`ruleId` is minted, not asked for** (`CR-`/`PR-` + epoch + a random suffix).
The form has no field for one and a human-picked key buys nothing on a rule,
unlike a position code where the code is the handle people use.

**A rule with no results is refused.** It would match deals and change no
numbers — the one kind of rule whose effect nobody can see.

Every check runs before the write, so a refusal never leaves a half-made rule.

## List — filters and paging

`search` (name OR ruleId, `ICONTAINS`), `name` (`ICONTAINS`), `ruleType`
(`EQUAL`), `limit` (default 50, clamped 1..200), `offset`. All narrow
**server-side**, so `total` and `hasMore` describe the filtered set and the
pager only offers pages that exist.

Rows carry `conditionCount` and `resultCount`, read through `.items`.

## Changes — the system of changes

| thing | verb | verdict | how would we notice if this is wrong? |
|---|---|---|---|
| `CreditRule` object | unaffected | **unaffected** — it stays the calculation-shaped object it was specified as, and `Credit.creditRuleId` still points at it. These four callables use `Rule`, which is the AUTHORING model | if the engine is later pointed at `Rule`, that is a migration with its own decision, not a rename |
| Rules page + Create Rule pages | create | **cascade** — the only caller; its dropdown vocabularies stay hardcoded in the page by decision | `docs/pages/` records page→callable dependencies |
| Results are not individually addressable | accepted | **accepted** — results live inside `Rule.results`, so an `Earning` cannot point at the result that produced it. That was the cost of the JSON model | it blocks the day an earning must explain WHICH result paid it; revisit then, as a migration |
| The duplicate check reads the search index | accepted | **accepted** — search lags writes, so two creates in the same second could in principle both pass the check. The minted id carries a random suffix precisely so a collision is vanishingly unlikely rather than merely unlucky | `DUPLICATE_RULE_ID` exists as a status for the caller to retry on |

## Tests

`node scripts/regress.mjs <id>` per callable. The list suites seed four rules,
**wait 15 seconds**, then assert — entity search is eventually consistent and a
6-second settle was measurably not enough. Not padding; see `runtime-facts.md`.
