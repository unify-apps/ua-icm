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
| `conditions` | no | a real ARRAY, not a JSON string. Stored under `{items:[...]}` because a bare array is dropped on write |
| `result` | **yes** | a real OBJECT — ONE result per rule. Stored as itself; it is not a list, so it needs no wrapper |

| status | meaning |
|---|---|
| `OK` | created. Returns `ruleId`, `recordId`, `conditionCount` |
| `INVALID_INPUT` | missing name or ruleType, a `result` that is absent or not an object, a result with no name, a bad date, or `activeEnd` before `activeStart` |
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

Rows carry `conditionCount` (read through `conditions.items`) and `resultName`, taken straight off the stored `result` object. A count of one carries no information, so the name is returned instead.

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


## One result, passed natively (2026-09-08)

A rule has exactly ONE result. It used to be a one-element array inside
`results: {items:[...]}`, reached through `resultsJson` — a JSON string the
automation parsed. Both of those are gone:

- the object stores `result`, a single JSON object, not a list
- the callable takes `result` as a **real object** and `conditions` as a **real
  array**; nothing is stringified on the way in

**Objects and arrays cross `execute-node` intact.** Probed against tool: sending a
Map and a List where the START node declared strings arrived at the Groovy node as
a real Map and a real List. The old round trip existed because `opt()` calls
`toString()`, and a Java map's `toString` is not JSON — so the code now reads those
two variables directly instead of stringifying and re-parsing them.

`conditions` keeps its `{items:[...]}` wrapper on the way to STORAGE, because a
bare array written into a `json` property is still silently dropped. `result` is an
object, so it needs no wrapper.

**The `results` column still exists on `Rule`** and is no longer written. Removing
it is a deliberate contract step, separate from this expand.

## Get Rule — the detail read (2026-09-08)

`ICM | Get Rule` = `6aa023713aa7845ea1ef4310`, data source `ds_get_rule` =
`e_6aa0240b561c60372d5e8b88`. Deployed v2, suite 8/8.

One input, `ruleId`. Returns `rule` with every scalar field **plus the conditions
list and the result object with its values** — the two things the list callables
deliberately omit so that a page of 200 rules does not carry 200 condition arrays
to render a table showing neither.

| status | meaning |
|---|---|
| `OK` | found; `rule` is populated |
| `NOT_FOUND` | the id matched nothing |
| `INVALID_INPUT` | no `ruleId` given |

**The last two are separate on purpose.** Both produce zero rows, and collapsing
them tells a caller who forgot the id that their rule does not exist. A blank id is
also refused rather than falling through to an unfiltered fetch, which would return
whatever happened to be first — one rule shown while claiming to be another.

**Conditions written before the closed namespace stored the field under `subject`;
newer ones use `field`.** Both are returned as stored, and the drawer reads
whichever is present. Nothing rewrites old rows.
