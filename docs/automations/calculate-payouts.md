# ICM | Calculate Payouts

**Built state** (2026-09-11): draft `6aa3ee0faf79f85169481670` on tool, **not deployed**, not
committed. Built by `scripts/build-calculate-payouts.mjs`, pushed by
`scripts/push-calculate-payouts.mjs` (round-trip clean), validate clean, lint clean. Suite
`tests/6aa3ee0faf79f85169481670.json`, all dry runs. Fixtures: `scripts/seed-payouts-na.mjs`.

Proved on TEST-NA-JUL-2026 (credit run RUN-1789049445958-81a256, 39 credits):
- dry run: 11 flat earnings, 9 tiered earnings, 9 measure results, 18 exceptions (11 NO_PLAN
  rollup credits on the RSM seat, 5 NO_QUOTA, 1 AMBIGUOUS_QUOTA, 1 NO_TIER), every tiered
  amount equal to the hand-computed one.
- wet run 1 `RUN-1789128426504-faa464`: 20 Earnings + 9 MeasureResults landed, Succeeded.
- wet run 2 `RUN-1789128433292-7ea4bb`: same counts landed; run 1 became `Superseded` with
  `supersededBy` = run 2.
- `PERIOD_NOT_OPEN` (JAN-2026), `NO_CREDIT_RUN` (OCT-2026), `INVALID_INPUT` (empty strings).
- Suite 15/15 green on draft v2. It caught one real bug on v1: a truncated CalculationRun read
  hid the credit run and answered `NO_CREDIT_RUN` for a credited period. Every wet payout run
  adds a Succeeded run to the period, so this would have grown into production. `n_KRun` now
  refuses a truncated run read with `FETCH_TRUNCATED`, and `n_RespRun` answers its status.

| field | value |
|---|---|
| Token / name | `ICM \| Calculate Payouts` (workflow id minted at create), tag `icm`, CALLABLE |
| Purpose | One period in, `Earning` rows out: the commission each payee earns on the credits `ICM \| Calculate Credits` already wrote for that period, under the payout rules on their plan. |
| Replaces | Nothing — no Earning or MeasureResult row exists on tool today. |
| Callers | None yet. A caller must NOT assume credits are recalculated — this reads the period's latest credit run, it never makes one. |
| Authorization | Admin / finance only. It computes everyone's pay for a period; never exposed to a rep-facing page. |

Read `00-shared-contract.md` and `calculate-credits.md` first. This is stage two of the
same engine and reuses its resolution code, guards and build/push/test tooling.

## Scope — kept deliberately simple

Two ways to calculate commission, chosen by `Rule.result.values.rateType`:

1. **Flat rate** — `credit.amount × rate`.
2. **Tiered** — an attainment measure picks which credits count, their total divided
   by a quota is the attainment, the rate table tier that attainment falls in gives the
   rate, and `total × rate` is the commission.

**Out for now:** bonus, cliff, marginal tiering, percent-of-target, caps and min/max,
YTD/QTD windows and true-up, measure filters beyond credit type (product, customer,
geography), eligibility hold, LOA/termination, draws, Statement, PayrollExport,
`PlanComponent`, multi-currency.

## Decisions (2026-09-11)

| decision | chosen |
|---|---|
| calculation types | Flat rate and Tiered, nothing else |
| config home | payout `Rule.result.values`, linked by `Plan.payoutRules` |
| measure filter | `AttainmentMeasure.creditTypes` only, for now |
| geography, when it comes | a Transaction attribute (`txn.attrs.*`), not the seat's territory |
| period | this period only; `AttainmentMeasure.periodType` is not read yet |
| quota | the rule's `quotaId` when set, else the payee's quota (Quota on their seat for the measure) |
| tier math | one rate: the tier the attainment falls in, applied to the whole measure total |
| approach | separate payout run reading the credits already written |

## Entity study (tool snapshots, 2026-09-11)

Every `*Pct` and rate is **bps**; every amount is **minor units**.

- `Credit` — `creditId`!U, `runId`→CalculationRun, `transactionId`, `employeeId`→Payee,
  `positionId`, `creditTypeId`→CreditType, `amount` (int), `sourceCreditId` (set = rollup).
  No plan and no date on it; both are re-derived. Written only by Calculate Credits.
- `CalculationRun` — `runId`!U, `periodId`, `scope` (object), `status`
  Running|Succeeded|Failed|Superseded, `dryRun`, `startedAt`, `supersededBy`. Credit runs
  write `scope: {}`; payout runs write `scope.stage = "payout"`.
- `Rule` (stage `payout`) — `ruleId`!U, `conditions.items[]`, `result.values`,
  `activeStart/End`.
- `Plan` — `planId`!U, `status`, `payoutRules[]` (Rule business keys).
- `AttainmentMeasure` — `measureId`!U, `creditTypes`, `periodType` (not read in v1).
  `creditTypes` is an untyped `object` column: an array written to it is stored as `{}`
  silently (probed 2026-09-11). It is stored as `{codes: ["NEW_BOOKING"]}`; the fold also
  reads a list, a comma string, `{items: [...]}` and `{CODE: true}`.
- `Quota` — `quotaId`!U, `positionId`, `measureId`→AttainmentMeasure, `periodId`,
  `amount` (minor units), effective dates.
- `RateTable` — `rateTableId`!U, effective dates. `mode` and `tiering` are not read in v1.
- `RateTableBand` — `rateTableId`→RateTable (record id), `fromPct` (bps, inclusive),
  `toPct` (bps, exclusive), `value` (bps), `label`, `bandId`!U.
- `MeasureResult` — `resultId`!U, `runId`, `employeeId`, `positionId`, `measureId`,
  `periodId`, `creditTotal`, `quota`, `attainmentPct` (bps).
- `Earning` — `earningId`!U, `runId`, `employeeId`, `componentKey`, `periodId`,
  `creditId`, `resultId`, `earnedToDate`, `previouslyPaid`, `amount`, `rateApplied` (bps),
  `bandHit`, `holdStatus` Payable|Held, `payablePeriodId`, `trace`.

## Rule configuration

```
Flat rate   values: { rateType: "Flat rate", rateBps: "500", creditTypes: "NEW_BOOKING", payWhen: "On close" }
Tiered      values: { rateType: "Tiered", measureId: "ACV", rateTableId: "RT-…",
                      quotaId: "Q-…" (optional), payWhen: "On close" }
```

`measureId`, `rateTableId` and `quotaId` are business keys. `payWhen` other than
`On close` is refused. `creditTypes` on a flat rule is optional, comma-separated codes.

## Contract

```
in    periodId    required. A Period record id.
      dryRun      default TRUE; "" counts as absent. Writing pay is opt-in.
      pageLimit   default 1000, clamped 1..5000.
      keyCap      default 5000, clamped 1..20000.
out   status      OK | OK_DRY_RUN | INVALID_INPUT | PERIOD_NOT_FOUND | PERIOD_NOT_OPEN
                  | NO_CREDIT_RUN | FETCH_TRUNCATED | KEY_SET_TOO_LARGE
                  | EARNING_WRITE_INCOMPLETE
      message     caller-actionable, "" on success
      runId, periodName, creditRunId
      dryRun      what the run did
      written     earnings that LANDED; 0 on dry runs and refusals
      earnings[]  every earning, with its trace
      measureResults[]
      exceptions[] everything that could not be decided, one code each
      stats       credits, flatEarnings, tieredEarnings, refused, total, rowsRead
```

Every outcome answers every key; absent facts are `""`, `0` or `[]`, never missing.

**Per-item exception codes** (the run continues): `NO_PLAN`, `RULE_MISSING`,
`RULE_REFUSED`, `UNSUPPORTED_RATE_TYPE`, `UNSUPPORTED_PAY_WHEN`, `NO_MEASURE`,
`NO_QUOTA`, `AMBIGUOUS_QUOTA`, `NO_RATE_TABLE`, `RATE_TABLE_INVALID`, `NO_TIER`.

## Which credits

The period's latest (`startedAt`) `CalculationRun` with `status = Succeeded`,
`dryRun = false` and `scope.stage` absent or `credit`. None → `NO_CREDIT_RUN`. That run's
`Credit` rows are read in ONE page of `pageLimit` (max 5,000); if the page did not hold
them all the run answers `FETCH_TRUNCATED`. **Paging with `loop_while` is not built yet** —
at NA scale (~6,000 credits a month) a real month will refuse until it is.

## Resolution, per credit

As of the credit's date: its Transaction's `incentiveDate`, falling back to `closeDate`.

1. Seat = `Credit.positionId` (already resolved by the credit pass).
2. Plan = the seat's Active, in-force Position assignment first, else its title's — the
   same `CreditPass` code Calculate Credits uses. None → `NO_PLAN`.
3. For each key in `Plan.payoutRules`: missing → `RULE_MISSING`; out of force on the
   credit date → skip; `rateType` not `Flat rate`/`Tiered` → `UNSUPPORTED_RATE_TYPE`;
   `payWhen` not `On close` → `UNSUPPORTED_PAY_WHEN`.
4. Conditions via `ConditionMatcher` with facts `credit.amount`, `credit.credit_type`,
   `credit.is_rollup`, `credit.close_date`, `credit.product`, `credit.customer`. Refused
   → `RULE_REFUSED`; not matched → the rule does not apply to this credit.

## Flat rate

One Earning per (credit, rule), when the credit's type is in `values.creditTypes`
(or `creditTypes` is unset):

```
amount        = HALF_UP(credit.amount × rateBps / 10000)     the one rounding point
rateApplied   = rateBps      creditId = credit      componentKey = ruleId
earnedToDate  = amount       previouslyPaid = 0     resultId = ""
```

## Tiered

One MeasureResult and one Earning per (payee, rule).

**Which payees.** Every payee with at least one credit that resolved to a plan listing
the rule and matched its conditions.

**Measure total.** Sum of `amount` over that payee's credits in this run whose credit
type is in `measure.creditTypes` and which resolved to the rule (step 2–4 above).
Unknown measure → `NO_MEASURE`.

**Quota.**
- `values.quotaId` set → that Quota. Missing → `NO_QUOTA`.
- Otherwise the payee's quota: Quota with `positionId` = the seat on the payee's
  latest-dated credit, `measureId` = the measure's record id, in force at the period end,
  and `periodId` = this period. When no quota sits on this period, one on an ancestor
  period (QUARTER, YEAR) is used as-is — no proration — and `trace.quotaPeriodId` says so.
- None, or `amount <= 0` → `NO_QUOTA`; more than one on the same period → `AMBIGUOUS_QUOTA`.

**Attainment.** `attainment = measureTotal × 10000 / quota.amount` bps, full precision.
`MeasureResult.attainmentPct` stores it rounded HALF_UP for display only.

**Tier.** Rate table by `rateTableId`, in force at the period end; missing →
`NO_RATE_TABLE`. Bands sorted by `fromPct`; any `fromPct >= toPct`, overlap or gap →
`RATE_TABLE_INVALID`. The tier is the band with `fromPct <= attainment < toPct`; at or
above the top band's `toPct` the top band applies; below the lowest `fromPct` →
`NO_TIER` (nothing earned, reported).

```
amount        = HALF_UP(measureTotal × tier.value / 10000)
rateApplied   = tier.value   bandHit = tier.label || tier.bandId
earnedToDate  = amount       previouslyPaid = 0     resultId = MeasureResult
creditId      = ""           componentKey = ruleId
```

Every Earning is written `holdStatus = Payable`, `payablePeriodId = periodId`.

## Node plan

Generated by `scripts/build-calculate-payouts.mjs` with derived groupIds, pushed with a
round-trip check. Every read is keyed on the previous stage's keys; the tiered reads sit
behind a branch lane that stays closed when no tiered rule applies.

1. **Normalise** input (as Calculate Credits).
2. **Period** fetch + guard: not found / not OPEN.
3. **Credit run**: `CalculationRun` with `periodId`, Succeeded, `dryRun = false`; the
   latest credit run is picked in Groovy. None → `NO_CREDIT_RUN`.
4. **Credits** of that run, one page (paging not built; truncation refuses).
5. **Resolution reads, keyed**: Transaction (`id IN`), CreditType, PositionAttribute,
   Position, Title, PlanAssignment (one OR), Plan, Rule (`ruleId IN`, `stage = payout`).
6. **Need decision** (Groovy): which tiered rules apply, and their measure, rate table,
   quota ids and seats.
7. **Tiered lane** (closed when no tiered rule applies): AttainmentMeasure, RateTable,
   RateTableBand, Quota.
8. **Fold** (Groovy, no I/O): earnings, measure results, exceptions, stats.
9. Refuse / dry-run respond, as Calculate Credits.
10. **Write path** (`dryRun = false`): create CalculationRun (`Running`,
    `scope: {stage: "payout", creditRunId}`) → stamp ids → bulk upsert MeasureResult →
    bulk upsert Earning → compare landed counts → close run Succeeded/Failed → when
    Succeeded, mark the period's previous Succeeded payout runs `Superseded` with
    `supersededBy`.

**Row counts at target scale.** NA exports ~2,900 rows a month, ~6,000 credits: two
pages at 5,000. Flat Earnings ≤ credits × flat rules on the plan (~6,000); tiered
Earnings ≤ payees × tiered rules (hundreds).

**Fetch calls.** Flat only: ~12 plus one per extra credit page. With tiered rules: ~16.

### The four questions for nodes that leave the automation

| node | sent | not sent | when | never when |
|---|---|---|---|---|
| create CalculationRun | runId, periodId, status Running, startedAt, dryRun false, stats, scope {stage, creditRunId} | supersededBy | fold OK and dryRun false | any refusal, any dry run |
| bulk upsert MeasureResult | minted resultId, runId, employeeId, positionId, measureId, periodId, creditTotal, quota, attainmentPct | proration | after the run exists, when any tiered earning exists | fold refused, dry run |
| bulk upsert Earning | minted earningId, runId, employeeId, componentKey, periodId, creditId or resultId, earnedToDate, previouslyPaid, amount, rateApplied, bandHit, holdStatus, payablePeriodId, trace | componentId, capApplied, clampedAmount, clampReason, uncappedEarnedToDate | after MeasureResults landed | MeasureResult write incomplete |
| close CalculationRun | status Succeeded/Failed, stats, exceptions | — | always after the writes | never skipped once the run exists |
| supersede previous payout runs | status Superseded, supersededBy | — | this run Succeeded | this run Failed |

## Errors

- A refusal before the write path writes nothing.
- A write that lands short closes the run `Failed`, answers `EARNING_WRITE_INCOMPLETE`,
  and supersedes nothing. Retry = a new run; readers filter by Succeeded run, so the
  partial rows are ignored.
- **Re-running is not double pay.** Each wet run writes a new run and supersedes the
  previous Succeeded payout run for the period; readers take only the latest Succeeded.

## Changes — the system of changes

| thing | verb | verdict | how would we notice if this is wrong? |
|---|---|---|---|
| `Rule.result.values` | new `rateType "Tiered"` with `measureId`, `rateTableId`, `quotaId` | *cascade*: the rule builder page must offer them; until then TEST rules are seeded by script | suite: tiered rule without `measureId` → `NO_MEASURE` |
| `CalculationRun.scope` | new key `stage` | *accepted*: credit runs keep `{}`, read as credit | suite: a payout run is never picked as the credit run |
| `Calculate Credits` | read its output | *unaffected* | `NO_CREDIT_RUN` case |
| two wet credit runs for one period | read "latest Succeeded" | *accepted*: picked by `startedAt` | suite case with two runs |
| `Earning`, `MeasureResult` | first writer | *unaffected*: 0 rows today | — |
| period guard | copy of Calculate Credits' inline guard | *accepted*: both move to `ICM \| Check Period Writable` together, later | `PERIOD_NOT_OPEN` case |
| concurrency | no CAS claim | *accepted*: same gap as Calculate Credits; the later run supersedes | Notes |
| `Earning.amount` integer | money in an int column | *accepted*: same divergence as `Credit.amount` | Notes |

## Tests

`tests/<workflowId>.json`, on TEST- fixtures, dry run unless named:

- all-empty-strings payload · `INVALID_INPUT` · `PERIOD_NOT_FOUND` · `PERIOD_NOT_OPEN`
  (JAN-2026 PAID) · `NO_CREDIT_RUN` · `FETCH_TRUNCATED`
- flat: 500 bps on NEW_BOOKING pays, MGR_ROLLUP does not · creditTypes filter ·
  condition refused · `UNSUPPORTED_PAY_WHEN` · `UNSUPPORTED_RATE_TYPE`
- tiered: hand-computed amounts for attainment inside a middle tier, exactly on a
  `fromPct` edge (inclusive), exactly on a `toPct` edge (exclusive), above the top tier,
  and below the lowest (`NO_TIER`)
- tiered quota: rule `quotaId` wins over the payee's quota · payee quota on the period ·
  payee quota on an ancestor period · `NO_QUOTA` · `AMBIGUOUS_QUOTA`
- `NO_MEASURE`, `NO_RATE_TABLE`, `RATE_TABLE_INVALID` (gap, overlap)
- wet: a payout run lands, run Succeeded, landed counts equal; a second wet run
  supersedes the first and nothing doubles

**Fixtures** (idempotent TEST- seeder, never shared data): a TEST period with a wet
credit run; a TEST title, seat and plan; flat and tiered payout rules; a TEST
AttainmentMeasure, Quota, and a RateTable with bands.

## Notes

- **Fixture drift.** Title `T-AE` was re-coded `T-AE1` on tool and TEST-NA hierarchy rows
  were deleted outside this work (see `calculate-credits.md`). Payout fixtures use their
  own TEST title and plan, not shared ones.
- **Next, when asked for:** measure filters on product / customer / geography (geography
  from a Transaction attribute); YTD/QTD windows with true-up; eligibility hold; bonus
  and cliff.
- **PROBE:** the largest `bulk_upsert_records_by_id` batch that lands in one call —
  ~6,000 Earnings a month may need chunking. 20 is proven.
- **Next build step:** page the credit read with `loop_while`; until then a period with
  more credits than `pageLimit` (max 5,000) refuses with `FETCH_TRUNCATED`.
- An empty MeasureResult batch (a flat-only period) answers `successCount: 0` without
  throwing, so no IF guards the write; the run closes on counts.
- **Not covered by the suite**, because one plan cannot vary per case: `RULE_MISSING`,
  `RULE_REFUSED`, `UNSUPPORTED_RATE_TYPE`, `UNSUPPORTED_PAY_WHEN`, `NO_MEASURE`,
  `NO_RATE_TABLE`, `RATE_TABLE_INVALID`, a quota on an ancestor period, `KEY_SET_TOO_LARGE`.
- A quota on an ancestor period is divided into one month's credits as-is. With the
  YEAR-2026 quotas on tool, monthly attainment will read low until quotas are set per
  period.
