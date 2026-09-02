# ICM automations — shared contract

**Read this before writing or editing any spec in this folder.** Everything
here applies to every automation, is written once, and is not repeated in the
per-automation specs. `docs/model/money-and-time.md` adds the rules that exist
because this product computes pay; read that too.

**Provenance.** Most rules below are INHERITED from `ua-automationkit`, where
each was proven by a real failure on the same platform. They are trustworthy as
platform behaviour and they are not yet proven *here*, because this repo has
built nothing yet. Rules that are ICM-specific are marked **ICM**. When a rule
is confirmed or contradicted by something built in this repo, say so inline with
the date — the value of these files is that every line has a receipt.

This folder is the corpus: reading it start to end must arrive at the current
state of the ICM automations. One spec file per automation (or tight family),
named after its token, updated in the same commit as the snapshot it describes.

## Identity and scope

- The ICM application id and the tags that define membership live in
  `kit.config.json`, and nowhere else. Never type a literal app id or tag into
  a spec, a script, or a node — read it from the config.
- **The committed app id is a placeholder** until open question 6 in
  `notes/open-questions.md` is answered. A wrong `applicationId` does not
  error; it silently matches nothing.
- Membership is by TAG, not by name. Name search is for exploring only.
- Throwaway clones are named loudly (`... (KIT TEST - safe to delete)`), tagged
  with `tags.test` from the config, never tagged with a real product tag, and
  deleted when done.

## Inputs

- Real callers send EMPTY STRINGS for optional inputs they don't fill, never
  nulls. Every default treats `""` as missing; every number coercion survives
  `""`. Every callable's suite includes the all-empty-strings payload.
  (Inherited: `"" as Integer` crashed a live Axis run.)
- Defaults are applied INSIDE the automation, never assumed from the caller.
- **ICM** — every input that is an amount is accompanied by its currency, and
  every input that is a date is unambiguous about its timezone. "2026-03-31" is
  a different period in two timezones, and period boundaries decide pay.

## Outputs and errors

- Every outcome path ends in a "Respond to automation" node with a distinct,
  caller-actionable status. The respond node's TYPE is STOP, not ACTION.
- A callable's `result` schema is the contract the UI builds against: every
  field typed, every array's `items` carrying named properties, `required`
  limited to what is always present. An untyped array is a bug a UI developer
  finds later by guessing.
- Multi-write flows say in their spec what state is left when a middle write
  fails, and whether a full retry mints duplicates.

## Writes are hostile territory

Inherited doctrine, from a real Create Team run where a create node hit Mongo's
unique index, the caller got a raw `E11000`, and a side effect from the previous
node was left orphaned. The unique key had been in the schema snapshot the whole
time.

- **Read the object's uniqueness before writing it.** Every entity snapshot
  carries `uniqueKeyFields` and per-field `uniqueKey: true`. Every unique field
  an automation writes gets a pre-check (server-side filtered fetch) and its own
  distinct respond status (`DUPLICATE_<FIELD>`). A unique-key hit at write time
  is NOT save-time-visible — it is a raw Mongo error that kills the run.
- **Assume users repeat themselves.** Sending the same create twice (double
  click, retry after timeout) is normal. Every creating callable's suite
  includes a "same payload again" case, and the second call must return a clean
  status, never an engine error.
- **Every node can fail; no raw engine error may reach a caller.** The spec's
  node plan states, for every WRITE node and every side-effecting CallWorkflow,
  what the caller receives if that node fails. "The run dies with the platform's
  error" is acceptable only when written down as accepted debt.
- **Order multi-writes for recoverability.** Side effects run AFTER the guards
  that can refuse the request.
- **The four questions, for every node that leaves the automation** (CallWorkflow,
  storage node, platform-entity action): what is SENT (each field justified
  against the callee's setup schema or the object's schema) · what is NOT sent
  (each omission justified against the default that then decides) · WHEN it is
  called (which guards passed first) · when it is NOT called (which outcomes
  skip it, and whether skipping is correct). A node with an unknown answer is
  not understood and does not ship.
- **Know the entity end to end before touching it**: fields, unique keys, both
  directions of its foreign keys, and which other automations write it (grep the
  snapshots for the object_type).

## ICM: the guards that are not optional

These are this product's version of "hostile territory". Each is a guard with
its own status and its own regression case; the full list of invariants and why
the schema cannot enforce them is in `docs/model/00-domain-model.md`.

| guard | status | applies to |
|---|---|---|
| period is writable (not CLOSED/PAID/CALCULATING) | `PERIOD_LOCKED` | every write carrying a `periodId` |
| no overlapping plan assignment for the participant | `OVERLAPPING_ASSIGNMENT` | assignment writes |
| credits on a transaction sum to ≤ 100% per type | `CREDIT_OVER_ALLOCATED` | credit writes |
| rate tiers contiguous, non-overlapping | `RATE_TABLE_INVALID` | rate table writes |
| a calculation is not already running for the period | `CALCULATION_IN_PROGRESS` | calculation runs |
| the caller may see this participant's money | `FORBIDDEN` | every read of earnings, payouts, statements |

The period check appears in nearly every write, which by the reuse rule makes it
ONE callable sub-automation (`ICM | Assert Period Writable`), built before the
second automation needs it — not copied nodes.

**ICM — authorization is a first-class outcome, not an afterthought.** Comp data
is need-to-know: a rep sees their own numbers, a manager sees their reports', an
admin sees everything. Every read automation states in its spec who may call it
and what it does when the caller may not. A read that returns another person's
pay because nobody specified the rule is the worst bug this product can have,
and it will not announce itself.

## Data access

- Filter dialects differ by app and crash at RUN time, not save time: storage
  objects use `{operator, filters:[{property:"properties.x", filter:{operator,
  value}}]}`; standard_entities (users, roles) use `{op, values:[{field, op,
  values}]}`.
- A boolean property never set is MISSING, not false — treat missing as the
  default. `createdTime` is what "createdAt" means in contracts.
- No API call inside a per-item loop: bulk-fetch once, compute in one code step,
  and project only the fields the flow uses.
- Slowly-changing reads may use node `options.cacheConfig` (TTL seconds); never
  cache what the same flow writes.
- **ICM** — the volumes here are transactions and credits, not teams. A
  calculation over one quarter for a few hundred reps is easily hundreds of
  thousands of credit rows. Every calculation design states its row-count
  estimate at target scale before it is built, and "fetch everything into one
  code node" needs a number behind it or it is a finding.

## Knowing what is actually LIVE

Callers only ever hit the DEPLOYED copy. The authority is `deploymentState` on
the workflow record (`ua.mjs fetch <id>`) — compare
`deploymentState.workflowVersion` against the record's own `version`. The
inventory listing's draft-vs-deployed column is a hint, not evidence, and
`GET /api/workflow-definition/deployed-workflow/{id}?latest=true` has returned
node content matching the DRAFT. Read `deploymentState` before telling anyone a
change is, or is not, live. A teammate can deploy at any moment, so "I did not
deploy it" never means "it is not deployed".

## Reuse

Logic used by 2+ automations is ONE callable sub-automation (CallWorkflow), not
copied nodes. Check `snapshots/orbit/automations/REGISTRY.md` before building
anything that sounds like it already exists.
