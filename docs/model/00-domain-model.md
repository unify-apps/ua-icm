# ICM domain model

**Status: PART BUILT, part proposal — and the two are marked.** Nine objects now
exist on orbit (2026-09-03); `snapshots/orbit/entity-types/` is their truth and
`objects/*.json` are the specs that created them. Everything else here is still a
proposal to argue about with the product team. Where this file and a snapshot
disagree, **the snapshot is right and this file is the bug**.

| section | state |
|---|---|
| Calendar and money — `Period`, `Currency`, `FxRate` | **built** |
| People and org — `Payee`, `Position`, `Title`, `PositionAttribute`, `PayeePositionAssignment`, `Territory` | **built** |
| Plans, rates, transactions, credit, calculation, payout, disputes | **proposal** |

## Naming and typing conventions

Three rules, all of them decided rather than inherited, and all three visible in
the built objects:

1. **No prefix on object names.** `Payee`, not `icmPayee`. Membership in the
   product is by the **`icm` tag**, never by name — a name-based convention
   breaks the moment somebody creates `IcmPayee`.
2. **camelCase fields.** `effectiveStart`, not `effective_start`.
3. **Anything with a fixed vocabulary is a LOOKUP, not a string.** A currency is
   a lookup to `Currency`; a territory is a lookup to `Territory`; a job title is
   a lookup to `Title`. The reason is not tidiness: a credit rule matching
   `"WEST"` against a seat someone typed as `"West"` pays nobody, and it fails
   silently. Status enums stay as strings because they are closed sets defined in
   `glossary.md`, not user-extensible reference data.

## The seat is the unit, not the person

**This is the load-bearing decision of the whole model** (taken 2026-09-03,
adopting the shape of `UNIFYAPPS_BUILD_SPEC.md` over this file's original
participant-centric draft).

Credit attaches to a **`Position`** — a seat — and the person who gets paid is
resolved by asking *who held that seat on the transaction's close date*. The
alternative, crediting a `Payee` directly, looks simpler and is wrong: it makes
"who owned the West territory in March" unanswerable the moment somebody is
promoted, and it makes a mid-quarter territory move impossible to prorate.

Almost nothing is stored *on* a seat. A seat's title, its territory, its
occupant and its parent are each effective-dated in their own object, because a
seat outlives its occupants and history has to stay answerable as of any date:

```
Position ──< PositionAttribute        ⌛ title, territory, over a date range
         ──< PayeePositionAssignment  ⌛ which Payee held it, over a date range
                                      └──> Payee ──> Currency
```

⌛ marks an effective-dated object. **None of them can carry a unique index for
the invariant that matters** — "no two rows for the same seat with overlapping
date ranges" is not expressible in Mongo. So overlap is an automation guard with
its own status and its own regression case, and `ICM | Resolve Seat Occupant`
returns `AMBIGUOUS` rather than picking one when it finds two.

## The one-paragraph version

Money flows in one direction, and every object below sits somewhere on that
line: a **transaction** (a closed deal) is **credited** to one or more
**positions** by a credit rule; each credit resolves to the **payee** who held
that seat on the close date; a **calculation run** reads those credits against
the seat's **plan** for a **period**, measures attainment against a **quota**,
applies a **rate table**, and writes **earnings**; earnings roll into a
**payout**, which is approved and paid, and appears to the rep as a
**statement** they can **dispute**. Everything else — draws, adjustments,
clawbacks — is a correction applied at a named point on that line.

```
Transaction ──credit rule──> Credit ──┐   (credit lands on a POSITION)
                                      │
Position ⌛─> PayeePositionAssignment ─┴─> Payee ──> Currency
   │                                                    ▲
   └─⌛ PositionAttribute ─> Title, Territory            │
                                                        │
PlanAssignment ─> Plan ─> PlanComponent ─> RateTable ────┤
Quota ───────────────────────────────────────────────────┤
                                                         ▼
                    CalculationRun ──> Earning ──> Payout ──> Statement ──> Dispute
                                                     ▲
                                          Period ────┘  (state machine: the audit boundary)
```

## Core objects

### People and org — **BUILT 2026-09-03**

| object | purpose | key fields | uniqueness |
|---|---|---|---|
| `Payee` | a person who can be paid. The bridge from a platform user to comp | `employeeId`, `name`, `email`, `userId` (FK USER), `currencyId` (FK Currency), `hireDate`, `terminationDate`, `status` | `employeeId` UNIQUE |
| `Position` | a SEAT — the unit that gets credited and quota'd | `positionCode`, `name`, `active` | `positionCode` UNIQUE |
| `Title` | a job title a seat can carry | `titleCode`, `name` | `titleCode` UNIQUE |
| `Territory` | a named sales territory a seat can carry | `territoryCode`, `name`, `active` | `territoryCode` UNIQUE |
| `PositionAttribute` ⌛ | what a seat WAS over a date range: its title and territory | `positionId`, `titleId`, `territoryId`, `effectiveStart`, `effectiveEnd` | none — overlap is a *rule* |
| `PayeePositionAssignment` ⌛ | who held which seat over which date range | `payeeId`, `positionId`, `effectiveStart`, `effectiveEnd`, `allocationPct` | none — overlap is a *rule* |

**Still to build here**: `PositionHierarchy` ⌛ (`positionId`,
`parentPositionId`, effective-dated) — the manager rollup that rollup credit
walks. It is deliberately its own effective-dated object rather than a
`managerId` on `Payee`, for the same reason the seat model exists: a payout for
March must ask who the seat reported to *in March*.

**Known debt (2026-09-03).** `Payee` still carries a dead `currency` string
beside its `currencyId` lookup, and `PositionAttribute` a dead `territory`
string beside `territoryId`. Both are leftovers of retyping-by-addition — the
platform refuses to retype a property once an object holds records, and
`ua-schema.mjs` never retypes by design. `Payee.currency` is still marked
`required`, so writes must fill a field nothing reads. See the "Now" list in
`docs/architecture.md`.

### Calendar and money — **BUILT 2026-09-03**

| object | purpose | key fields | uniqueness |
|---|---|---|---|
| `Period` | one fiscal period | `name`, `periodType`, `startDate`, `endDate`, `status`, `parentPeriodId` | `name` UNIQUE |
| `Currency` | a currency the product can pay in | `code`, `name`, `symbol`, `minorUnits`, `isBase`, `active` | `code` UNIQUE |
| `FxRate` | the rate converting one currency to base FOR ONE PERIOD | `currencyId`, `periodId`, `rateToBase`, `source` | none — see below |

**Why the rate is not a field on `Currency`.** A rate is a fact about a currency
*and a point in time*. Stored on `Currency`, every finance update would silently
rewrite history and March would recalculate at today's rate. `FxRate` needs a
uniqueness guard on (`currencyId`, `periodId`) that Mongo can express as a
compound key — that is not yet applied and is a gap, not a decision.

`Period.status` is the product's most important state machine, because it is
what makes the numbers trustworthy. See `docs/model/money-and-time.md`.

**Amounts.** Every money field is `number` in storage and `BigDecimal` in code,
coerced through one `dec()` helper at the boundary. This is not a style
preference — a storage `number` returns a `Double` above ₹1 crore and a
`BigDecimal` below it, so uncoerced arithmetic is exact or inexact depending on
the data. Money never goes in an `integer` field. Evidence in
`notes/runtime-facts.md`.

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
