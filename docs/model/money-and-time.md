# Money and time — the two things ICM cannot get wrong

Everything in `docs/automations/00-shared-contract.md` applies to every
automation. This file is the extra contract that applies because this product
computes people's pay. A bug in an issue tracker is an annoyance; a bug here is
someone's mortgage payment, and it is found by the person it shortchanged.

**Status: doctrine, not yet proven on this platform.** The rules below are what
the design must satisfy. Each one needs a probe against the UnifyApps runtime
before it is treated as fact, and the probe result lands in
`notes/runtime-facts.md` with its date. The rules marked **PROBE** have no
result yet.

## Money

### Never use floating point for money

`0.1 + 0.2` is `0.30000000000000004` in Groovy as in everything else, and a
commission run that sums a hundred thousand credits will visibly disagree with
the finance team's spreadsheet. Two workable options; pick one and use it
everywhere, because mixing them is worse than either:

- **Minor units as integers** — store cents (or the currency's minor unit) in an
  integer field. Exact, boring, and the arithmetic is plain addition. Costs a
  conversion at every UI boundary and a decision for currencies with three
  decimal places.
- **`BigDecimal` in Groovy with an explicit scale and rounding mode** — Groovy's
  `1.10` literal is already a `BigDecimal`, so this is more natural than it
  sounds, but only if every value entering the computation is parsed with
  `new BigDecimal(String)` and never via a double.

**PROBE, before the first calculation node is built:** what does a UnifyApps
storage `number` property actually hold, and what comes back into a Groovy node
— a `Double`, a `BigDecimal`, or a `String`? Write a record with
`0.1`/`0.2`/`12345678.91`, read it back, sum it in a code node, and record the
exact types and values in `notes/runtime-facts.md`. Every rule below depends on
that answer, and no money field gets designed until it exists.

### Rounding is a decision, made once, written down

Rounding half-up at the payout and rounding half-up at every intermediate
earning give different totals. State for each: rate application, per-component
earning, per-participant payout, and the period total. The rule this repo
starts from, until someone with authority says otherwise: **carry full
precision through the calculation, round exactly once, at `icmPayout.netAmount`,
half-up.** Every rounding point that is not that one is a finding in review.

### Amounts always travel with their currency

No money field exists without a currency field beside it, even while the product
is single-currency. Adding a currency later means backfilling every record and
every contract; adding it now costs a column. Sums across mixed currencies are a
bug the model should make visible rather than silently produce.

## Time

### Periods are a state machine, and it is the audit boundary

```
OPEN ──> CALCULATING ──> CLOSED ──> PAID
 ▲            │
 └────────────┘  (recalculation while still open)
```

- **OPEN** — credits and transactions may land, calculations may run and re-run.
- **CALCULATING** — a run is in flight. No writes to anything scoped to the
  period; concurrent runs are refused, not queued (see below).
- **CLOSED** — the numbers are final. Nothing scoped to this period may be
  written. Corrections land as an `icmAdjustment` in the *next* open period,
  never as an edit to history.
- **PAID** — money has left the building. Same as CLOSED, and it is terminal
  unless a named human reopens it, which is an audited event of its own.

**Every automation that writes anything carrying a `periodId` checks the
period's status first and refuses with `PERIOD_LOCKED`.** This is the single
most repeated guard in the product, which by the reuse rule makes it exactly the
thing that should be ONE callable sub-automation (`ICM | Assert Period Writable`)
called everywhere, not a copied node. Build it before the second automation
needs it.

### Effective dating beats current state

`icmParticipant.managerId` answers "who do they report to now". A payout for
March must ask "who did they report to in March", and those differ the moment
anyone is promoted. The same holds for territories, plan assignments, and
quotas. Any read in a calculation path that uses a current-state field where an
effective-dated one exists is a defect, and it is invisible until someone
changes jobs.

### Retroactivity is normal, not an edge case

Deals get re-dated, quotas get corrected in week three, plans get signed late.
The design assumption is that **any period may be recalculated** while it is
open, and that recalculation produces a *new* `icmCalculationRun` rather than
mutating the last one. This is why `icmEarning` is insert-only. "We will handle
retro later" means "we will rebuild the calculation engine later".

### One calculation run at a time, per period

Two concurrent runs over the same period write two sets of earnings and the
payout picks up an arbitrary mix. There is no transaction spanning nodes on this
platform, so the guard is a status check plus a compare-and-set:

- `update_records` in SINGLE mode is an atomic compare-and-set on id+version
  (`notes/runtime-facts.md`) — that is the primitive for claiming a period.
- Claim: CAS `icmPeriod.status` OPEN → CALCULATING. If the CAS loses, another
  run has it: respond `CALCULATION_IN_PROGRESS`. Do not poll, do not proceed.
- Release in every exit path, including the failure ones. A run that dies
  leaving a period stuck in CALCULATING blocks the product until someone
  clears it by hand, so the release path needs a regression case of its own,
  and the period needs a `calculationStartedAt` so a stuck claim is detectable.

**PROBE:** confirm the CAS actually fails (rather than silently overwriting)
when the version has moved, and record it.

## What this means for every spec

The spec template's Errors section must answer, for anything touching money or
periods:

- which period does this write to, and what does it do if that period is not
  writable?
- what rounding happens here, and is this the one rounding point?
- if this is a calculation, what happens when it runs twice — same result, or
  double payment?
- if this reads a participant, manager, territory, or quota: as of *when*?
