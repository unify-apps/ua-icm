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
   **answer (2026-09-02)**: the `icm` tag was UNUSED on orbit, so we claimed it.
   `search --tag icm` and `types --tag icm` both returned 0. Confirmed working:
   `icmPeriod` and one automation now carry it and are found by tag.
7. **Does anything exist already?** Are there ICM automations or object types on
   orbit today, or is this greenfield? Answer with
   `node scripts/ua.mjs search --tag <tag>` and `types --tag <tag>` once
   question 6 is settled. · asked — · **blocks**: whether the domain model is a
   proposal or a description · **answer (2026-09-02)**: GREENFIELD. 0 automations
   and 0 object types tagged `icm` on orbit. The domain model is a proposal and
   we own every object we create.

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
    any page tooling in `scripts/` · **answer**: — · *lead found 2026-09-02*:
    the Axis kit points at `~/frontend/www3`, whose
    `packages/network/src/generated` holds a generated client for EVERY
    platform endpoint, and `ua-agentic-editing` records that its
    `packages/llm-tools` is served as a live MCP server at `/mcp/page-builder`
    which reads and writes REAL pages against the real backend.
    **ANSWERED 2026-09-02**: there is NO plain REST path for a page, and none is
    needed. The supported route is `ua-agent-devkit`, which runs
    `www/packages/llm-tools` as a local MCP server (35 page-builder tools) bound
    to one platform. Proven working against orbit on port 3002: health OK,
    `tools/list` returns the full set. Pages are built in a Claude Code session
    opened in the devkit folder; `docs/pages/` records what each page depends on.
    Caveat: the tools create PAGES inside an app — there is no `create_app`
    tool, so the ICM application itself is made once in the builder.

## Blocking "everything driven from Claude" (added 2026-09-02)

11. **Object-type CREATE body.** `POST /api/entity-type` is recorded in
    `ua-schema.mjs`'s header as probed 2026-08-23, but no script calls it and
    no sample body exists here. · asked — · **blocks**: creating any ICM object
    from the kit; today objects must be hand-made in the builder ·
    **ANSWERED 2026-09-02**: `POST /api/entity-type` WORKS with a full definition
    body (id, name, pluralName, lcName, tags, input{SCHEMA_AND_LAYOUT},
    schema{SCHEMA}, metadata). Returned HTTP 200 and created `icmPeriod`, which
    then appeared under `types --tag icm`. Body shape copied from an Axis
    entity-type snapshot. See `snapshots/orbit/entity-types/icmPeriod.json`.
12. **Automation CLONE body.** `POST /api/workflow-definition/clone/{id}` is
    the only viable create path (the copilot refuses workflows with no valid
    nodes), but this repo has never called it and the request body is guessed.
    · asked — · **blocks**: creating the first ICM automation ·
    **OBSOLETE 2026-09-02 — the clone path is not needed.**
    `POST /api/workflow-definition/saveAndReturnViolations?strict=true` with a
    full definition (name, tags, nodes, edges and NO id) CREATED a 7-node
    callable in ONE call, returned the new id, and reported `violations: []`.
    Axis's "raw create produced an unfetchable workflow" warning did not
    reproduce. Clone remains available but is no longer the way in.
