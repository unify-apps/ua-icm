# ICM glossary

The vocabulary the product team, the specs, and the object names all have to
share. Where a term has two common meanings in the market, the meaning this
repo uses is stated and the other one is named so nobody assumes it.

| term | means here | not to be confused with |
|---|---|---|
| **Attainment** | achieved ÷ quota, as a percentage, for one measure and period | "achievement", used interchangeably in the market |
| **Accelerator** | a rate that increases above a threshold (e.g. 1.5× past 100%) | a SPIF, which is a one-off campaign, not a tier |
| **Clawback** | reversal of earnings already paid, when the underlying deal refunds or churns | an adjustment, which is a deliberate correction, not a reversal |
| **Credit** | one participant's share of one transaction. The join between revenue and people | quota credit vs. payment credit — this repo means *payment* credit unless the field says otherwise |
| **Draw** | a guaranteed minimum payment. **Recoverable** draws are repaid out of later commissions; **non-recoverable** are not | a base salary, which is outside this product |
| **Measure** | what a component is computed on: revenue, bookings, units, margin | metric, KPI — same idea, different word |
| **OTE** | On-Target Earnings: base + target incentive at 100% attainment | target incentive alone, which is the variable half only |
| **Payee** | the person receiving money. Modelled as `icmParticipant` | the platform user record, which is a different id space |
| **Period** | one fiscal window with a status. The audit boundary | a pay period, which may differ from the calculation period |
| **Plan** | the versioned set of components a participant is paid under | a plan *assignment*, which is one participant's link to it |
| **Quota** | a participant's target for one period and measure | a territory target or a team target, which roll up differently |
| **Rollup credit** | credit a manager receives because a report closed a deal | split credit, which divides one deal between peers |
| **SPIF** | a short-term incentive campaign, outside the standard plan | an accelerator |
| **Statement** | the per-participant, per-period document showing how pay was derived | a payout, which is the money; the statement is the explanation |
| **True-up** | a correction paying the difference when a later recalculation raises an earlier figure | a clawback, which moves money the other way |

## Status vocabularies

Reused across objects so a reader learns them once. When a new status is
needed, add it here in the same commit.

- **Period**: `OPEN` · `CALCULATING` · `CLOSED` · `PAID`
- **Plan**: `DRAFT` · `ACTIVE` · `ARCHIVED`
- **Calculation run**: `QUEUED` · `RUNNING` · `SUCCEEDED` · `FAILED`
- **Payout**: `PENDING` · `APPROVED` · `HELD` · `PAID` · `CANCELLED`
- **Statement**: `DRAFT` · `PUBLISHED` · `ACKNOWLEDGED`
- **Dispute**: `OPEN` · `IN_REVIEW` · `RESOLVED` · `REJECTED`
- **Approval**: `PENDING` · `APPROVED` · `REJECTED`
