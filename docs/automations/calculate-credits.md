# ICM | Calculate Credits

`6aa2ab9e4f1e1040ac32d181` on tool · **DRAFT, not deployed** · tag `icm`

Stage one of the calculation engine. One period in, `Credit` rows out: for every deal
in the window, who is recognised for it and for how much.

It does **not** decide money. That is the payout pass, which reads what this writes.
Keeping them apart is what lets a credit be re-read under a changed rate without
re-deciding who owned the deal.

Read `00-shared-contract.md` first — everything it says applies here and is not repeated.

## Why this exists next to `ICM | Calculate Period (credit pass)`

`6aa28e9c3c7f7b6b9108c281` enters the resolution at `Transaction.positionId`. The
source data has no position id. The Salesforce order export carries **"Team Member:
Full Name"** — a name string — and nothing else that identifies who is credited, so a
pass that demands an already-resolved seat cannot read what the product actually
receives.

This automation enters at the NAME and resolves forward. Everything downstream of that
first hop is the same engine, and the two `.groovy` files here are the reviewable copy
of the code node, the same arrangement `engine/README.md` describes in the
Sales-Commission-Management repo.

## Contract

```
in    periodId    required. The Period RECORD id to calculate.
      dryRun      default TRUE. Compute and report, write nothing.
      pageLimit   default 1000, clamped 1..5000. One page per object.
      keyCap      default 5000, clamped 1..20000. Max distinct keys one staged read's
                  IN filter may carry - the bound on the JOIN, not on the page.
out   status      OK | OK_DRY_RUN | INVALID_INPUT | PERIOD_NOT_FOUND | PERIOD_NOT_OPEN
                  | PERIOD_NOT_USABLE | FETCH_TRUNCATED | KEY_SET_TOO_LARGE
                  | HIERARCHY_TOO_DEEP | CREDIT_WRITE_INCOMPLETE
      message     caller-actionable, empty on success
      runId       the run this computed, whether or not it was written
      periodName, windowStart, windowEnd
      dryRun      what the run actually did, not what was asked
      written     credits that LANDED. 0 on every dry run and every refusal.
      credits[]   every credit, with the matcher trace that produced it
      exceptions[] every row that could not be decided, one reason each
      stats       transactions, scanned, matched, rolledUp, unmatched, refused, credits
```

Every outcome answers the same nine keys. A caller reads one contract whatever
happened — and a `null` is DROPPED from a callable's response rather than serialised,
so absent facts go back as `""` and `0`, never as a missing key.

**`dryRun` defaults to TRUE, and an empty string counts as absent.** Real callers send
`""` for anything they did not fill. Writing pay is opt-in.

## The resolution, in order

Everything is asked **as of the deal's incentive date** (falling back to close date).
Not today, not the period end — a deal dated in March is credited to whoever held the
seat in March.

```
transaction
  └─ attrs.payeeName ──> Payee            by name, case- and space-insensitive
       └─ PayeePositionAssignment  live on that date  ->  the SEAT
            ├─ PositionAttribute   live on that date  ->  titleId -> titleCode
            ├─ PlanAssignment (Position)  ──┐  the SEAT is asked FIRST
            ├─ PlanAssignment (Title)    ──┴─ then the TITLE
            │     └─ Plan (Active, in force)
            │          └─ creditRules[] -> Rule (stage=credit, in force)
            │               └─ conditions -> the matcher
            └─ PositionHierarchy   live on that date  ->  parent, for rollup
```

**The seat wins, but only if its plan is live.** A plan assigned to the seat is the more
specific statement about the deal, so it beats one assigned to everyone carrying its
title. It only wins if it is `Active` and in force on the date — an expired seat plan
must not shadow a title plan that is running, which is why `planUsable` is part of the
`find`, not a check after it.

**The title fact is the CODE, not the record id.** A rule stores `position.title ==
"T-AE"`; `PositionAttribute` stores a record id. The engine resolves one to the other
before building facts. Getting this backwards produces a rule that matches nothing and
says nothing, which is the failure the whole design is shaped against.

## The split is a fact on the deal, not only a number on the rule

The export carries `Percent (%)` per row, so the split is data:

| the rule says | the row says | credited |
|---|---|---|
| `splitBps: "7000"` | anything | 70% — the rule OVERRIDES |
| nothing | `attrs.splitBps: 7000` | 70% — the row stands |
| nothing | nothing | 100% |
| unparseable | — | `BAD_SPLIT`. Never 0, never 100% |

`BAD_SPLIT` is deliberately not "assume 100%" and not "assume 0". Both are guesses
about somebody's pay.

**Splits are NOT normalised to 100%.** Order `00388125` in the real export credits one
row at 100% and another at 70%. That is overlay crediting, not corruption, and any
guard of the form "credits on a transaction sum to <= 100%" would reject a real order.
`00-shared-contract.md` still carries that guard as `CREDIT_OVER_ALLOCATED`; it needs
to become "report the sum, do not block it" before either pass ships.

## Every rule that matches fires

A plan's credit rules are **not** first-match-wins. All are evaluated and every one that
matches emits its own credit, because one deal legitimately produces several credit
types. This is a decision, not an inheritance — the retired `CreditRule` object carried
a `mode: Add|Override` field that `Rule` does not, so if override is a real requirement
it needs a home before this ships. **Open question.**

## Not matching is not failing

The single most important distinction in the pass:

| outcome | meaning | where it goes |
|---|---|---|
| a rule cleanly did not match | normal. Most rules don't apply to most deals | `stats.unmatched`, silent |
| no rule matched at all | normal. The deal earns nobody credit | counted, silent |
| a rule **could not be evaluated** | broken input | `exceptions` |

Collapsing the third into the second is how an ICM product underpays someone and tells
nobody.

| code | when |
|---|---|
| `NO_DATE` | neither incentiveDate nor closeDate is set |
| `NO_PAYEE_NAME` | the row names nobody to pay |
| `UNRESOLVED_PAYEE` | no `Payee` carries that name |
| `AMBIGUOUS_PAYEE` | two payees share it — the model cannot index this away |
| `NO_POSITION` | that person held no seat on that date |
| `AMBIGUOUS_POSITION` | they held two. Real in the live data today |
| `NO_TITLE` | the seat had no title, and no seat plan covered it either |
| `NO_PLAN` | no ACTIVE plan reaches the seat or the title on that date |
| `RULE_MISSING` | the plan points at a `ruleId` no `Rule` record has |
| `RULE_REFUSED` | the matcher could not evaluate — a missing fact, an unknown subject |
| `BAD_SPLIT` | the split will not parse |
| `UNKNOWN_CREDIT_TYPE` | the rule files under a code no `CreditType` carries |

**`NO_PLAN` will over-report until `PayeeEligibility` is read.** Most of an org is never
on a plan — engineering, finance, support — so every deal touching an unplanned seat
lands in the list and a real misconfiguration hides inside it. The distinguishing signal
already exists as a dated table; the pass does not read it yet. Recorded, not worked
around.

## Rollup

`rollup: "true"` on the rule's result climbs `PositionHierarchy` as of the same date and
emits a separate credit per ancestor seat, filed under `rollupCreditType` (usually
`MGR_ROLLUP`). A different credit type is not cosmetic — with the same one, attainment
double-counts.

The walk **ends quietly** on no parent, a vacant or contested manager seat, or the level
budget. None is an error: a run that fails on "the VP has no manager" fails on every
top-of-tree deal. A `seen` set breaks a cycle rather than trusting the data not to have
one.

**Eligibility is NOT checked during rollup, on purpose.** A rep on leave or just
terminated still generates their manager's rolled credit; whether *they* are paid is a
payout-stage question. Checking it here silently drops manager attainment.

## Node plan

52 nodes. `groupId` is DERIVED by walking the edges in `build-calculate-credits.mjs` and
never typed — the builder draws its branch tree from those groups, and given wrong ones
it silently drops the nodes it cannot place (`ICM | Create Position` went 16 -> 5).

```
n_Start      START, callable
n_Norm       defaults; a SENTINEL periodId when the input is unusable; mints the runId
n_FtPeriod   Period by id
n_Shape      may this period be calculated, and over what window
n_IfPer  y-> n_RespPer     INVALID_INPUT / PERIOD_NOT_FOUND / PERIOD_NOT_OPEN
         n-> n_Br          BRANCH - two lanes, no conditions, both fire in parallel
              @1 Resolve and read   the dependency chain, serial by nature:
                 n_FtTxn -> n_KName -> n_FtPayee -> n_KPayee -> n_FtOcc -> n_KSeat
                 -> n_FtAttr -> n_FtHier1 -> n_KUp1 -> ... -> n_FtHier4 -> n_KUp4
                 -> n_FtPos -> n_FtOccUp -> n_KTitle -> n_FtTitle -> n_KAsg
                 -> n_FtAsgT -> n_FtAsgP -> n_FtAsgL -> n_KPlan -> n_FtPlan
                 -> n_KRule -> n_FtRule
              @2 Reference data     n_FtTerr -> n_FtCcy -> n_FtCT
              default ------------------------------------------------> n_Calc  (the join)
n_Calc       ConditionMatcher + CreditPass + the adapter. Pure fold, no I/O
n_IfCalc y-> n_RespCalc    FETCH_TRUNCATED
n_IfDry  y-> n_RespDry     OK_DRY_RUN - nothing written
         n-> n_CrRun       CalculationRun, written BEFORE the credits
              n_Stamp      stamp the run's RECORD id; build updateFields
              n_WrCr       bulk upsert every credit by its minted id, one call
              n_IfWr   y-> n_RespPart  CREDIT_WRITE_INCOMPLETE
                       n-> n_RespOk    OK
```

**Why the reads are a CHAIN, not a fan-out.** The first build fetched every `Payee`,
`Position`, `PositionAttribute`, assignment and hierarchy row in the org whether the
period touched them or not. That is wrong in the way that matters: the cost grew with
**headcount** rather than with the work. A month crediting 300 reps out of an org of
5,000 read ~25,000 rows to use ~1,500 of them, and past one page it stopped being slow
and started being **wrong**.

Each org-scale read is now keyed on the previous stage's actual keys:

```
Transaction (period window)
  -> distinct payee NAMES   -> Payee              by name IN
  -> payee ids              -> assignments        by payeeId IN
  -> the SEATS they held    -> attributes         by positionId IN
                            -> hierarchy          by positionId IN, four hops
  -> seats + ancestors      -> Position           by id IN
                            -> managers' seats    by positionId IN
  -> title ids              -> Title              by id IN
  -> ids AND codes          -> PlanAssignment     three structured IN fetches
  -> plan ids               -> Plan               by id IN
  -> rule business keys     -> Rule               by ruleId IN
```

**What it is deliberately NOT: a fetch per payee, or per transaction.** At 2,917 NA rows
in one month that is roughly 12,000 round trips inside a single run — the N+1 that "no
API call inside a per-item loop" exists to forbid. The dependency is real and it is
honoured; it is expressed one **set** at a time instead of one **row** at a time.

Of 20 fetches, **15 are keyed by the previous stage**. The three that are not —
`Territory`, `Currency`, `CreditType` — are single-digit reference tables that do not
grow with headcount, and making them dependent would add serial hops to save nothing;
they sit on a parallel lane and the `hasMore` guard still covers them.

**Cost of the trade, stated rather than hidden:** the chain is serial, so a small period
is slower in wall-clock than a twelve-way fan-out. A real one reads a fraction of the
rows and cannot silently truncate. That is the right way round.

**Why hops and not one hierarchy read.** Rollup climbs an unknown number of levels and
the seats above a rep are not knowable from the rep's own row, so each level has to be
asked for. Four hops covers five levels of org (AE → RSM → RVP → SVP → CRO); a deeper
one is **refused** as `HIERARCHY_TOO_DEEP`, never truncated. One file, `keys-up.groovy`,
serves all four nodes by reading its optional bindings through `binding.hasVariable`.

**Why three PlanAssignment fetches.** `startDate <= end AND (targetId IN … OR positionId
IN … OR titleId IN …)` is expressible, but only by building the whole filter in Groovy
and passing it as one pill — and a whole-value template filter does not render in the
builder **and** silently suppresses every missing-index warning for that node. These
filters will need an index. Three structured fetches keep both the drawing and the
warning; the fold unions and de-duplicates them by record id.

**Two new guards, because the honest failures of a set-based design are a set that got
too big and a walk that did not finish.** `KEY_SET_TOO_LARGE` refuses a period touching
more distinct payees or seats than `keyCap` (default 5000) — the fix is chunking, not a
bigger `IN`. `HIERARCHY_TOO_DEEP` refuses a reporting line still climbing after hop four.

**Proven output-identical.** The staged chain and the old fan-out produce
**byte-for-byte identical** credits on the real NA period: 39 credits, 11 rolled,
USD 626,741.48, one `UNRESOLVED_PAYEE` — same amounts, same splits, same types. Rows read
dropped to what the period actually touches: 29 transactions, 18 payees, 20 assignments,
18 attributes, 19 hierarchy, 20 positions, 1 plan assignment, 1 plan, 3 rules.

`stats.rowsRead` now reports that per object on every run, so the bound is visible instead
of assumed.

**Why the fetches are bounded, not limited.** No node carries a hard-coded page size:
`page.limit` comes from the caller's `pageLimit`, and every fetch carries `hasMore` into
the fold. If any object says there was more, the run answers `FETCH_TRUNCATED` naming
the objects instead of computing on a prefix. A bulk fetch that silently caps is the
scale failure `notes/runtime-facts.md` names first; this makes it loud. **It is not
pagination**, and it should become pagination — `cursor.next` is on the fetch output
already. Until then a period larger than one page refuses rather than lies.

**Why the filters are structured trees.** Every `triggerInputCondition` is a
`{operator, filters:[...]}` object, never a whole-value template string. A template
string resolves fine and renders as an empty condition row — and silently suppresses
every missing-index warning for that node. Losing the warning is not the same as fixing
it.

### The four questions, for each node that leaves the automation

| node | sent | not sent | when | when not |
|---|---|---|---|---|
| the twelve fetches | one page, a structured filter, an explicit `fields` projection | no cursor — single page by design | after the period is proved OPEN | never reached if the period is refused |
| `n_CrRun` | runId, periodId, status `CALCULATED`, startedAt, stats, `dryRun: false` | `supersededBy` — nothing supersedes a run at birth | only on a wet run whose fold returned OK | skipped entirely on a dry run |
| `n_WrCr` | one `updateFields` row per credit, keyed by an id minted in the fold | `isRollup` — the column does not exist; `sourceCreditId` carries it | after the run row exists | never reached on a dry run |

`n_CrRun` is a create against a UNIQUE `runId` with **no pre-check**, which the shared
contract normally forbids. The id is minted inside the engine from the clock plus
randomness and the caller cannot supply one, so it is unhittable — a pre-check would be
a fetch that can never find anything. **Accepted, with that reason.**

If `n_WrCr` fails after `n_CrRun` succeeded, a `CalculationRun` row is left with no
credits. That is recoverable and visible (`stats` says what it meant to write), and it
is the right order: the run is what the credits hang off, so it cannot come second.

`bulk_upsert_records_by_id` can answer `success: true` with `successCount: 0` when every
row is malformed, and a bulk write can insert nothing and still leave the node `ok`. So
the count is compared against what the fold meant to write, and a mismatch is its own
status rather than a silent success.

## Known divergences, recorded rather than hidden

- **`Credit.amount` is an `integer` column, so this pass ROUNDS.** `credit-pass.md` says
  the single rounding point belongs at payout. The column is why it happens anyway;
  HALF_UP, at the storage boundary only, and the full-precision split goes back in the
  response.
- **`Credit` has no `isRollup` column.** A rolled credit is the one carrying a
  `sourceCreditId`, which is why every credit id is minted in the fold — that is what
  lets a parent and its rollups be written in one batch with the link already resolved.
- **`Credit.creditRuleId` is a foreign key to the retired `CreditRule` object**, not to
  `Rule`. The engine writes the `Rule` record id into it. The constraint is not enforced,
  so it works; it is still the wrong target and needs retyping.
- **`ConditionMatcher.groovy` here is a COPY** of the one in
  `Sales-Commission-Management/engine/`. Nothing yet notices if they drift —
  `check-deployed.mjs` covers that repo's node, not this one.

## Reconciled against the customer's real export

**A slice of the real NA Salesforce export credits to the cent.** 24 rows across 15
orders, seeded as `records/na-sample-jul2026.json`, run `6aa2ba658f78990409034d0a` on
tool:

| | credits | engine | the sheet's own column |
|---|---|---|---|
| DIRECT | 23 | 477,404.66 | 485,848.35 less the one refused row |
| CHANNEL_INV | 5 | 102,421.20 | 102,421.20 |
| MGR_ROLLUP | 11 | 46,915.62 | = the RENEWAL total, 1 level |

Every one of the 28 direct credits equals `Amount (converted)` or `CHANNEL INVENTORY
SPLIT` exactly, including all four 50% rows, both 70% rows and all four negatives. The
one refusal is `UNRESOLVED_PAYEE` for a rep left unseeded on purpose.

### One export row is up to TWO commissionable lines

Measured across all 2,917 rows, not assumed:

```
TOTAL CREDITS           == Amount + CHANNEL INVENTORY SPLIT       2917 / 2917
CHANNEL INVENTORY SPLIT == Channel Inventory Amount x Percent     2917 / 2917
Amount                  == (Total Amount - Channel Inv) x Percent 2793 / 2917
```

The first two are exact, so they are the contract. `Amount` and `CHANNEL INVENTORY
SPLIT` are two separate credited figures that sum to `TOTAL CREDITS`, and the record type
is literally called "Channel and Direct". Each becomes its own `Transaction` carrying
`attrs.component`; a design that treats a row as one credit loses the channel half, and
on order `00386893` that half is **USD 47,069.40 sitting behind USD 13,019.94** of direct
value.

**`Total Amount` is NOT a per-order base.** The third identity fails on 124 rows and the
misses are structural, not noise: it is the OPPORTUNITY's value, which stays constant
while one opportunity spans several order numbers (59 rows) or ships in parts (65).
Orders `00392823` and `00392824` both read Total `132,093.04` while their Amounts are
`129,669.81` and `2,423.22` — the two halves of one opportunity. Multiplying it by
Percent is wrong 4% of the time, silently.

**Both credited figures already have the split applied**, so the base is recovered by
DIVIDING the split out (`Amount / Percent`). Feeding a pre-multiplied number to an engine
that multiplies again is how 70% silently becomes 49%.

### What the real data settled

- **200% splits are real.** Order `00392225` credits 50% + 100% + 50% across three reps.
  Order `00388125` and `00391559` each credit 170%. Three orders, two record types — the
  design doc's "unconfirmed" is now confirmed, and any guard that normalises to 100%
  rejects real orders.
- **Negatives flow all the way through.** `-4,365.59`, `-268.82`, `-2,562.00` land as
  credits, and their rolled copies are negative too.
- **Ship date decides the period.** `00377914` closed 29 May and `00384850` closed 23
  June; both are credited in July because the ship date is the commissionable trigger.
  Under close date neither would appear.

**Finding this run produced:** order `00387058` is USD 0.00 and the engine wrote a credit
of 0.00 for it. That is a row, not an earning — it needs a `ZERO_AMOUNT` pre-check at
ingest. Left in place so the behaviour is visible and the fix has a test.

## State

**All 19 regression cases green** (`node scripts/regress.mjs 6aa2ab9e4f1e1040ac32d181 --env tool`),
`ua.mjs validate` **clean**, `lint.mjs` **clean**. Draft v6, **not deployed**.

Proved end to end on tool, run `6aa2af693c7f7b6b91132e7c`: 6 credits written, the run
row flipped `Running` -> `Succeeded`, and both rolled credits carry their parent's minted
id in `sourceCreditId`.

Three things the suite found that review had not:

- **An omitted optional input is an unbound Groovy variable, not a null.** Nine cases
  died on `No such property: pageLimit`. The all-empty-strings case does not catch it -
  `""` binds fine; the case that OMITS the key is the one that does.
- **The fold's response projection renamed the minted credit id**, so every write row
  went out with an empty id and no `creditId` - the object's unique key. One row landed,
  the second collided with it, and the rest of the batch failed with them. The
  `successCount` guard is what turned that into `CREDIT_WRITE_INCOMPLETE` and a `Failed`
  run row instead of a silent success.
- **Credit order was not deterministic**, which makes two runs of the same period
  undiffable - and diffing two runs is how "my number changed on Tuesday, why" gets
  answered. `n_Calc` now sorts: deal, then person, then the direct credit before the
  rolled copies that hang off it.

`lint.mjs` R2/R3 were **wrong** about branches and are corrected in this change: they
flagged a condition-less branch arm as one that "never spawns". `BranchNodeRuntime`
picks arms with `boolean applicable = filter == null`, and a BRANCH_CONDITION without
`conditions` produces no filter - so it always fires, which is exactly what an
unconditional parallel fan-out needs. The rule now flags MIXED intent instead.

## Test bed

`records/calculate-credits-testbed.json` — 31 loudly-named `TEST-` rows seeded by
`scripts/seed-calculate-credits.mjs`, idempotent by business key. It stands up four
seats of its own because the live org data cannot produce a single clean credit in
September 2026: three people hold two live seats each, and every `T-AE` seat that month
is contested or vacant.

Proven on tool, run `6aa2abad3c7f7b6b9111fe38` (dry) — see the records file for the
expected shape of each row and why it is there.
