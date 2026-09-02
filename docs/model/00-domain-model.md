# ICM domain model — proposed

**Status: PROPOSAL, not yet built.** Nothing here has been read off the
platform. This is the model to argue about with the product team and then
create; once objects exist, `node scripts/ua.mjs snap-types --tag icm` makes
`snapshots/orbit/entity-types/` the source of truth and this file becomes the
narrative that explains it. Where the two disagree, the snapshot wins and this
file is the bug.

Naming convention: every object type starts with the `icm` prefix from
`kit.config.json` (`icmParticipant`, `icmPlan`, …), the way the Axis model uses
`axisNoCode*`. `gen-types.mjs` keys off that prefix.

## The one-paragraph version

Money flows in one direction, and every object below sits somewhere on that
line: a **transaction** (a closed deal) is **credited** to one or more
**participants** by a credit rule; a **calculation run** reads those credits
against the participant's **plan** for a **period**, measures attainment
against a **quota**, applies a **rate table**, and writes **earnings**;
earnings roll into a **payout**, which is approved and paid, and appears to the
rep as a **statement** they can **dispute**. Everything else — draws,
adjustments, clawbacks — is a correction applied at a named point on that line.

```
icmTransaction ──credit rule──> icmCredit ──┐
                                            ├──> icmCalculationRun ──> icmEarning ──> icmPayout ──> icmStatement
icmPlanAssignment ─> icmPlan ─> icmPlanComponent ─> icmRateTable ──┘         ▲              │
icmQuota ───────────────────────────────────────────────────────────────────┘              └──> icmDispute
```

## Core objects

### People and org

| object | purpose | key fields | uniqueness |
|---|---|---|---|
| `icmParticipant` | a payee. The bridge from a platform user to comp | `userId` (FK USER), `employeeId`, `managerId` (self FK), `hireDate`, `terminationDate`, `currency`, `status` | `employeeId` UNIQUE |
| `icmPosition` | the role a participant holds; drives plan eligibility | `name`, `level`, `defaultPlanId` (FK plan) | `name` UNIQUE |
| `icmHierarchy` | manager rollup used for rollup credit, kept as its own object so it can be effective-dated independently of `managerId` | `participantId`, `parentParticipantId`, `effectiveStart`, `effectiveEnd` | none (a junction) |

`managerId` on the participant is "who they report to *today*". `icmHierarchy`
is "who they reported to *on the day that deal closed*", which is what rollup
credit must use. Keeping only the first makes retroactive recalculation
impossible — a mistake that is very hard to undo once payouts exist.

### Plans and rates

| object | purpose | key fields | uniqueness |
|---|---|---|---|
| `icmPlan` | a comp plan, versioned | `name`, `version`, `effectiveStart`, `effectiveEnd`, `currency`, `status` (DRAFT/ACTIVE/ARCHIVED) | `name`+`version` |
| `icmPlanComponent` | one payable component of a plan | `planId` (FK), `name`, `type` (COMMISSION/BONUS/MBO/SPIF), `measure` (what is measured: REVENUE/BOOKINGS/UNITS/MARGIN), `weight`, `rateTableId` (FK), `creditRuleId` (FK) | none |
| `icmPlanAssignment` | participant ↔ plan for a date range, with their number | `participantId`, `planId`, `effectiveStart`, `effectiveEnd`, `ote`, `targetIncentive`, `prorationPct` | none — overlap is a *rule*, not an index (see below) |
| `icmRateTable` | a named set of tiers | `name`, `type` (FLAT/TIERED/CUMULATIVE) | `name` UNIQUE |
| `icmRateTier` | one tier of a table | `rateTableId` (FK), `fromPct`, `toPct`, `rate`, `sortOrder` | none |

**`icmPlanAssignment` overlap is the model's sharpest edge.** Two assignments
for the same participant with overlapping date ranges means a deal gets paid
twice, and Mongo cannot express "no overlapping ranges" as a unique index. So
it must be a guard inside the automation that writes assignments, with its own
`OVERLAPPING_ASSIGNMENT` status — and a regression case that proves it. Any
plan for enforcing this in the schema instead is wrong; the schema cannot.

### Targets and calendar

| object | purpose | key fields | uniqueness |
|---|---|---|---|
| `icmPeriod` | one fiscal period | `name`, `type` (MONTH/QUARTER/YEAR), `startDate`, `endDate`, `status` (OPEN/CALCULATING/CLOSED/PAID), `parentPeriodId` | `name` UNIQUE |
| `icmQuota` | one participant's target for one period and measure | `participantId`, `periodId`, `measure`, `targetAmount`, `prorationPct` | `participantId`+`periodId`+`measure` UNIQUE |

`icmPeriod.status` is the product's most important state machine, because it is
what makes the numbers trustworthy. See `docs/model/money-and-time.md`.

### Transactions and credit

| object | purpose | key fields | uniqueness |
|---|---|---|---|
| `icmTransaction` | the raw revenue event ingested from CRM/ERP | `externalId`, `sourceSystem`, `type` (BOOKING/INVOICE/PAYMENT/REFUND), `amount`, `currency`, `closeDate`, `accountId`, `productId`, `ownerUserId`, `status` | `sourceSystem`+`externalId` UNIQUE — this is what makes re-ingest safe |
| `icmCreditRule` | how a transaction is split into credits | `name`, `type` (DIRECT/ROLLUP/SPLIT/TERRITORY), `definition`, `priority` | `name` UNIQUE |
| `icmCredit` | one participant's share of one transaction | `transactionId` (FK), `participantId` (FK), `creditType` (DIRECT/ROLLUP/SPLIT), `creditPct`, `creditAmount`, `periodId`, `ruleId` | none — a junction; read paths dedupe |
| `icmTerritory` | the account/geo/product scope that assigns ownership | `name`, `definition`, `participantId`, `effectiveStart`, `effectiveEnd` | `name` UNIQUE |

`icmCredit` is the join the whole product turns on. It is also the answer to
"why am I being paid this?" — a statement line traces back through credits to
transactions, and if that path is not walkable the product has no explainability
story. Design the read path for it before building the write path.

### Calculation and payout

| object | purpose | key fields | uniqueness |
|---|---|---|---|
| `icmCalculationRun` | one execution of the engine over a period + scope | `periodId`, `scope`, `status` (QUEUED/RUNNING/SUCCEEDED/FAILED), `startedAt`, `completedAt`, `triggeredBy`, `participantCount`, `earningTotal`, `isFinal` | none |
| `icmEarning` | one computed amount, for one participant, component, period | `calculationRunId` (FK), `participantId`, `planComponentId`, `periodId`, `attainmentPct`, `rateApplied`, `creditBase`, `earnedAmount` | `calculationRunId`+`participantId`+`planComponentId` UNIQUE |
| `icmPayout` | what is actually paid, for one participant and pay period | `participantId`, `periodId`, `grossAmount`, `adjustmentAmount`, `drawAmount`, `netAmount`, `currency`, `status` (PENDING/APPROVED/HELD/PAID/CANCELLED) | `participantId`+`periodId` UNIQUE |
| `icmAdjustment` | a manual correction with a reason and an approver | `participantId`, `periodId`, `amount`, `reason`, `requestedBy`, `approvedBy`, `status` | none |
| `icmDraw` | guaranteed minimum and its balance | `participantId`, `periodId`, `amount`, `recoverable` (bool), `recoveredAmount`, `balance` | `participantId`+`periodId` UNIQUE |
| `icmClawback` | a reversal of earnings when a deal is refunded or churns | `originalEarningId` (FK), `transactionId`, `amount`, `reason`, `periodId` | none |

**`icmEarning` carries `calculationRunId` and that is not decoration.** It is
what lets the product answer "my commission changed since Tuesday — why": diff
two runs. Earnings are written *per run*, never updated in place. A model where
recalculating overwrites last week's number cannot explain itself, and
explainability is the feature reps actually judge an ICM product on.

### Visibility, approval, audit

| object | purpose | key fields | uniqueness |
|---|---|---|---|
| `icmStatement` | the per-participant, per-period document the rep sees | `participantId`, `periodId`, `payoutId`, `status` (DRAFT/PUBLISHED/ACKNOWLEDGED), `publishedAt`, `acknowledgedAt` | `participantId`+`periodId` UNIQUE |
| `icmDispute` | a participant's query against a statement line | `statementId` (FK), `participantId`, `subject`, `description`, `disputedAmount`, `status` (OPEN/IN_REVIEW/RESOLVED/REJECTED), `resolution`, `assignedTo` | none |
| `icmApproval` | one step of an approval chain on a payout or plan | `targetType` (PAYOUT/PLAN/ADJUSTMENT), `targetId`, `approverUserId`, `sequence`, `status`, `decidedAt`, `comment` | none |
| `icmAuditLog` | append-only trail of who changed what | `entityType`, `entityId`, `action`, `actorUserId`, `before`, `after`, `occurredAt` | none — append only, never updated |

## Invariants the schema cannot enforce

Mongo unique indexes cover the "UNIQUE" column above and nothing else. Every
rule below is an automation guard with its own respond status and its own
regression case, or it is not enforced at all:

| invariant | why it matters | enforced by |
|---|---|---|
| No overlapping `icmPlanAssignment` per participant | overlapping plans pay the same deal twice | guard + `OVERLAPPING_ASSIGNMENT` |
| Credits on one transaction sum to ≤ 100% per credit type | over-crediting silently inflates payouts | guard + `CREDIT_OVER_ALLOCATED` |
| No write to any object scoped to a CLOSED or PAID period | closed periods are the audit boundary | guard + `PERIOD_LOCKED` |
| `icmRateTier` ranges within a table are contiguous and non-overlapping | a gap means attainment lands on no tier and earns zero, silently | guard + `RATE_TABLE_INVALID` |
| An `icmEarning` is never updated, only superseded by a newer run | history is the explainability story | write path only ever inserts |
| A payout's `netAmount` equals gross + adjustments − draw recovery | the arithmetic is the product | computed in one code node, asserted in the suite |
| `icmTransaction` re-ingest updates, never duplicates | CRM sync re-sends the same rows constantly | `sourceSystem`+`externalId` unique + upsert |

## Open questions for the product team

These change the model, so they are worth answering before objects are created.
They are tracked in `notes/open-questions.md` and each needs a name against it.

1. **Multi-currency**: do participants get paid in their own currency, and if so
   where does the FX rate live and as of what date — deal close, period end, or
   payment? This adds an `icmFxRate` object and a rate-date rule to every
   money field, or it does not exist at all. It cannot be added cheaply later.
2. **Splits**: are credit splits a property of the transaction (the CRM sends
   them) or computed by a rule here? Both exist in the market and they lead to
   different objects.
3. **Plan versioning**: when a plan changes mid-period, does the change apply
   retroactively to the whole period or from the change date? This decides
   whether `icmPlanAssignment` needs sub-period granularity.
4. **How far back can a period reopen?** Determines whether "closed" is truly
   terminal and how clawbacks against closed periods are booked.
5. **Where do transactions come from** — a UnifyApps connector to Salesforce, a
   file upload, or an API push? This is the single biggest input to the
   ingestion automation's design and its idempotency story.
