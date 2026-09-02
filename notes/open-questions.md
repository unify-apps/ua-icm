# Open questions

Every question here blocks or reshapes something. A question with no name
against it is nobody's, and it will be answered by whoever builds first — which
is the expensive way to answer it. Add the date asked, the person, and the
answer when it lands.

Format: `**Q**: … · asked <date> of <name> · **blocks**: … · **answer**: …`

## Blocking the data model

1. **Multi-currency.** Do participants get paid in their own currency? If yes,
   where do FX rates live and as of what date (deal close / period end /
   payment date)? · asked — · **blocks**: every money field in
   `docs/model/00-domain-model.md`, and whether an `icmFxRate` object exists ·
   **answer**: —
2. **Credit splits.** Does the source system send splits, or are they computed
   here by rule? · asked — · **blocks**: `icmCredit` write path and whether
   `icmCreditRule` needs a SPLIT type at all · **answer**: —
3. **Mid-period plan changes.** Retroactive to the period start, or effective
   from the change date? · asked — · **blocks**: whether `icmPlanAssignment`
   needs sub-period granularity · **answer**: —
4. **Reopening closed periods.** Is CLOSED terminal? How are clawbacks against
   a closed period booked? · asked — · **blocks**: the period state machine in
   `docs/model/money-and-time.md` · **answer**: —
5. **Transaction source.** Salesforce connector, file upload, or API push? ·
   asked — · **blocks**: the ingestion automation and its idempotency story ·
   **answer**: —

## Blocking the kit itself

6. **Platform identifiers.** What are the real `applicationId` and tags for the
   ICM app on orbit? `kit.config.json` currently holds placeholders (`icm`)
   copied by convention from the Axis kit. · asked — · **blocks**: literally
   every script invocation; a wrong app id silently matches nothing ·
   **answer**: —
7. **Does anything exist already?** Are there ICM automations or object types on
   orbit today, or is this greenfield? Answer with
   `node scripts/ua.mjs search --tag <tag>` and `types --tag <tag>` once
   question 6 is settled. · asked — · **blocks**: whether the domain model is a
   proposal or a description · **answer**: —

## Blocking the first calculation

8. **Numeric types.** What does a UnifyApps storage `number` property return
   into a Groovy node — `Double`, `BigDecimal`, or `String`? · asked — ·
   **blocks**: every money field; see the PROBE in
   `docs/model/money-and-time.md` · **answer**: —
9. **CAS semantics.** Does `update_records` SINGLE mode genuinely fail on a
   stale version rather than overwriting? The period claim depends on it. ·
   asked — · **blocks**: concurrency guard for calculation runs · **answer**: —

## Application pages

10. **How are UnifyApps application pages read and written from outside the
    builder?** The Axis kit never modelled pages, so there is no proven API
    path here yet. Until this is answered, `docs/pages/` specifies intent and
    the pages are built by hand in the builder. · asked — · **blocks**:
    any page tooling in `scripts/` · **answer**: —
