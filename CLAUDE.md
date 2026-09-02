# ICM kit

This repo is the toolbox for building the **ICM** (Incentive Compensation
Management) product on UnifyApps — its automations, its objects, and its
application pages — driven from Claude Code. Read this whole file before
touching anything.

## Where this came from, and what that means for trust

This kit descends from `ua-automationkit`, the Axis kit. The scripts, the
spec-first discipline, the deploy gates, and `notes/runtime-facts.md` all come
from there, and every hard rule in them was paid for by a real failure on this
platform. They are trustworthy as **platform** behaviour.

They are not yet proven *here*, because this repo has built nothing. So:

- A rule inherited from the Axis kit is a strong prior, not a local receipt.
- When something built here confirms or contradicts an inherited rule, write
  that down inline with the date. The value of these files is that every claim
  has a source.
- **ICM-specific doctrine** — money, periods, authorization — is in
  `docs/model/money-and-time.md` and marked **ICM** in the shared contract. None
  of it is proven yet either. The items marked **PROBE** are the ones to settle
  before the first calculation node exists.

## Setup (once per person)

Node 18+ and a browser cookie in `.env.local` (git-ignored, never commit it):

```
UA_ORBIT_URL="https://orbit.uat.unifyapps.com"
UA_ORBIT_COOKIE="<value of the _at cookie from Chrome dev tools>"
UA_DEFAULT_ENV="orbit"
```

Check it works: `node scripts/ua.mjs whoami`. A 401 means the cookie went stale
— paste a fresh one.

## Before anything: the identifiers are placeholders

`kit.config.json` holds the application id, the tags, and the entity prefix, and
it is the ONLY place they live. The committed values (`icm`) were chosen by
convention from the Axis kit (`axis-no-code`, `axisNocode`). **Nobody has
checked them against the platform.**

```
node scripts/ua.mjs search --tag icm      # do any ICM automations exist?
node scripts/ua.mjs types  --tag icm      # do any ICM object types exist?
```

A wrong `applicationId` does not raise an error — it silently matches nothing.
That failure mode cost the Axis repo real debugging time twice. Settle open
questions 6 and 7 in `notes/open-questions.md` before building, and never type a
literal app id or tag anywhere except `kit.config.json`.

## Safety rules (non-negotiable)

- Orbit (UAT) is the working environment. Tool (prod) is look-but-don't-touch
  unless a human explicitly says otherwise (`--env tool` to read).
- Never deploy, delete, or publish anything without an explicit human yes in the
  current conversation. Agent edits only change the draft — that's fine;
  deploying is a separate, gated act.
- Experimental or demo edits go on a CLONE, never the real automation. Name
  clones loudly ("... (KIT TEST - safe to delete)"), tag them with `tags.test`
  from the config, and NEVER tag them with a real product tag. Delete them when
  done (`POST /api/workflow-definition/delete/{id}`).
- Membership is by TAG, not name. Name search is for exploring only.
- **Schema changes change the data model for everyone.** `ua-schema.mjs` only
  ever adds properties; it never removes or retypes. Removing a field is a
  product-team decision, not a kit action.
- **ICM: never test against real pay data.** Fixtures are loudly-named
  participants and periods of our own. A test run that recalculates a real
  period, or writes a real payout, is the one mistake in this repo that reaches
  someone's bank account.

## How we work: automations are API endpoints, you are the backend developer

You are the architect of the ICM automation suite. The text-to-workflow copilot
is your HANDS, not your brain: it configures nodes for you, but the thinking —
what nodes exist, how they're wired, what each one handles, what happens on
every path — is done here first, in full clarity, before the agent hears a word.
Anything about the data model you don't know, ask the humans; it helps everyone.

Three kinds of work, one pipeline:

1. **Requirements.** The teammate says what they need.
2. **Contract.** Agree end-to-end on exactly what it takes in and returns in
   every outcome — like an API endpoint spec. Written down before any building,
   as a file in `docs/automations/` (or `docs/pages/` for a page).
3. **Design.** Node list, per-node handling, error paths, which EXISTING
   automations to reuse as sub-automations, and a performance pass. Check the
   inventory first — automations call other automations:
   `node scripts/ua.mjs inventory --tag <tag>`, and the callable contracts in
   `snapshots/orbit/automations/REGISTRY.md`. Start any working session with
   `ua.mjs drift --tag <tag>`; designing against a stale picture wastes the day.
4. **Build incrementally** with the agent — or skip the agent for mechanical
   edits (renames, one-field fixes) and go straight to the direct update API
   (snapshot + commit first).
5. **Test end-to-end.** Every automation has a regression suite in
   `tests/<workflowId>.json`. `node scripts/regress.mjs <workflowId>` must be
   all green, AND `node scripts/ua.mjs validate <id>` must print `clean` —
   tests interrogate the runtime, validate interrogates what a human sees in the
   builder, and they catch DIFFERENT bugs. **A suite is not optional and not
   deferrable**: `deploy.mjs` refuses to ship an automation without a green one.
6. **Critique** (see below) — a scalability, performance, and configuration
   audit grounded in `notes/runtime-facts.md`. Findings become incremental fix
   prompts; loop back to step 4.
7. **Type the contract.** Make the `result` schema say exactly what the caller
   receives — every field typed, every array's `items` carrying named
   properties, `required` limited to what is always present. Part of building,
   not a polish pass.
8. **Name everything.** Two label fields per node: `subTitle` carries the
   BUSINESS purpose ("Claim the period for this run"), `title` carries the
   ACTION name ("Update records"). Keep them DIFFERENT — identical values
   collapse to one line in the builder — and never leave `subTitle` unset.
   Anyone opening the automation should follow it top to bottom without clicking
   into a single node.
9. **Snapshot + commit.** The spec file updates in the same commit, so the
   corpus stays equal to the current state.

Before editing any automation: understand it completely first — its nodes, its
contract, and which automations and pages call it. Only then design the change.

**Architecture duties** (you own these, nobody has to ask):
- Performance at scale: a quarter's calculation for a few hundred reps is
  hundreds of thousands of credit rows. No API call inside a per-item loop;
  bulk-fetch once, compute in one code step. Flag anything that grows linearly
  with transaction volume, and state the row-count estimate before building.
- Don't repeat logic: a check used in many places (the period-writable guard is
  the obvious one) becomes ONE callable sub-automation reused everywhere.
- Every outcome path ends in a distinct, caller-actionable respond status.

## Spec first, prompt second

Steps 2 and 3 produce a FILE, not a paragraph in chat. Not one line of prompt
goes to the text-to-workflow agent until the spec exists. Start from
`docs/automations/_TEMPLATE.md`; `docs/automations/00-shared-contract.md` holds
what every automation shares, written ONCE, because a rule copied into N specs
drifts in N places.

**The corpus rule.** `docs/automations/` and `docs/pages/` are maintained so
that reading them start to end arrives at the CURRENT state of the product. A
spec that no longer matches the deployed automation is a bug, not a stale doc.

## Think in the system of changes

Every change is a change to something that already points at it. Write that list
down before the first prompt, and give every entry a verdict — a written row
with evidence, not "I thought about it".

| verb | what every referencing thing must answer |
|---|---|
| create | who will call this, and does an existing callable already do the job? |
| change the contract | every caller of the old input/output/status keeps sending and reading the OLD shape. Which automations, which **pages**, which regression cases? each is updated with it, or the change is refused |
| rename / retag | membership is by TAG and the registry token is the callers' handle. What resolves this by tag or token? |
| delete | which CallWorkflow nodes and page calls still point here? each one dangles — "blocks" is often the right verdict |
| deploy | callers only ever hit the DEPLOYED copy. What changes for them the moment this ships? |
| split / merge | which token survives, and which spec file now owns each behaviour? |

**Verdicts are a closed set:** *unaffected* (say why) · *cascade* (name the edit
that carries it) · *reassign* (name the edit) · *blocks* (refuse; say what the
caller is told) · *handled already* (name where) · *accepted* (written into the
spec's Notes with the reason). Never bare "handled".

**Every row also answers: how would we notice if this is wrong?** A row with no
detection story — no regression case, no distinct respond status, no drift check
— is not handled. It is accepted with the risk hidden.

**Pages are callers too.** Nothing in the snapshots records a page's dependency
on a callable, so the record lives in `docs/pages/`. Changing a contract means
walking that folder as well.

## The scripts

`scripts/ua.mjs` — read-only, can never change the platform:

```
node scripts/ua.mjs whoami                  check login
node scripts/ua.mjs validate <id> [...]     builder violations for current defs
node scripts/ua.mjs search --tag <tag>      automations by tag
node scripts/ua.mjs search <text>           loose name search (exploring only)
node scripts/ua.mjs fetch <id>              print one automation's JSON
node scripts/ua.mjs snap <id> [<id>...]     save snapshots + rebuild INDEX.md
node scripts/ua.mjs inventory [--tag <tag>] list automations; with --tag probes deployed vs draft
node scripts/ua.mjs types --tag <tag>       list object types by tag
node scripts/ua.mjs snap-types --tag <tag>  save those object schemas
```

`scripts/agent.mjs` — talks to the text-to-workflow copilot. This CAUSES EDITS
on whatever workflow you point it at, so aim it carefully:

```
node scripts/agent.mjs send --workflow <id> "message"                 new chat
node scripts/agent.mjs send --workflow <id> --case <caseId> "reply"   continue
```

A new chat prints the real case id — reuse it with `--case` for every follow-up
so the agent keeps its memory of the conversation.

`scripts/regress.mjs` — the regression suites, one JSON per automation in
`tests/`. Run after EVERY change, and `--all` after platform upgrades.

`scripts/testrun.mjs` — test-runs a DRAFT (no deploy needed) and prints every
node's real output or error. It EXECUTES nodes against real data: treat it with
the same care as running for real.

`scripts/debugrun.mjs` — prints every node's real inputs/outputs/error for any
run, and can turn a failing run's payload straight into a regression case
(`--save-case`).

`scripts/lint.mjs` — kit rules the platform does not enforce. R9 reads the app
id from `kit.config.json` and now flags a WRONG applicationId, not just a
missing one.

`scripts/ua-write.mjs` — direct workflow-definition update. Orbit only; refuses
production outright.

`scripts/ua-schema.mjs` — adds properties to an object schema. Changes the data
model for everyone. Never removes or retypes.

`scripts/deploy.mjs` — the ONLY sanctioned way to deploy (see the gates below).

`scripts/gen-types.mjs` — regenerates `docs/api/icm-types.ts` from the entity
snapshots, driven by `kit.config.json`.

There is deliberately no `fixtures.mjs` yet. The Axis one was entirely
product-specific, so it was not copied. Suites that CREATE need their own
loudly-named fixture family, and the script to reset it gets written with the
first such suite — see the ICM safety rule about real pay data.

## Objects: the data model you own

ICM object types are the ones tagged per `kit.config.json`, and that family is
the only one we snapshot into `snapshots/orbit/entity-types/`. Refresh with
`node scripts/ua.mjs snap-types --tag <tag>`; re-run it when the team adds
objects.

The proposed model, its invariants, and the questions still open on it are in
`docs/model/00-domain-model.md`. Until objects exist on the platform, that file
is a proposal; once they do, the snapshots are the truth and the file is the
narrative that explains them.

How to read a schema: fields live under `schema.schema.properties`; a foreign key
is declared as `foreignKey.reference: "ENTITY_ID:<type>"` (or `"USER"` for
platform users), so the snapshots double as the ER diagram. Schemas also declare
UNIQUENESS: top-level `uniqueKeyFields` and per-field `uniqueKey: true` are real
Mongo unique indexes — writing a duplicate does not fail at save time, it throws
a raw E11000 at RUN time and kills the run. Every record also carries system
fields the properties don't show: `id`, `createdTime`, `modifiedTime`,
`lastModifiedBy`. A boolean property never set is MISSING, not false.

Records are read three ways, and the FILTER DIALECT DIFFERS — getting this wrong
crashes at runtime, not save time:
- Inside automations, storage objects: `storage_by_unifyapps_fetch_records` with
  `{operator, filters:[{property:"properties.x", filter:{operator, value}}]}`.
- Inside automations, platform entities (users, roles): standard_entities actions
  with `{op, values:[{field, op, values}]}`. Wrong dialect = "Filter$Op ... op is
  null" at run time.
- From the kit, ad hoc: `POST /api/entity/{entityType}`.

Schema CHANGES are made deliberately and with the product team. When a contract
needs a field the model doesn't store, either compute it in the automation (the
usual answer) or ask. Never guess a field into existence.

## Application pages

The third pillar, and the one the Axis kit never modelled. There is no proven
API path for reading or writing a page from outside the builder yet (open
question 10), so pages are built by hand in the builder and their contracts are
agreed first in `docs/pages/`. Read `docs/pages/00-page-contract.md` before
specifying one.

Two things carry over into automation work regardless:
- **A page is a caller.** Its dependency on a callable is recorded nowhere but
  `docs/pages/`, so that folder is part of every contract change.
- **Explainability is the product.** Every amount a page shows must be
  drillable down to the transactions behind it, which means read callables are
  designed for that interaction, not just for first paint.

## Build INCREMENTALLY, not in one shot

One-shot "build these 9 nodes" prompts make the copilot work 5-7 minutes in a
single turn, which is where the platform's flaky save error lives — and twice it
silently built into the WRONG automation. The proven recipe
(`notes/incremental-agent-building.md`): one NEW chat per small step, each
prompt naming the workflow id, pre-confirming the apply, and demanding the agent
re-fetch to verify its own save. After every step WE re-fetch and check the
version moved — the agent has both claimed success on saves that never happened
and claimed failure on saves that landed. Between steps, run `testrun.mjs` and
feed the exact node error back in a fresh chat.

Creating a NEW automation: the agent can only edit workflows that already have
VALID nodes. A workflow created empty via the API cannot be edited by the agent,
and a UI-created placeholder is rejected too. What WORKS: clone a small healthy
callable with the target name/tags
(`POST /api/workflow-definition/clone/{id}`), then rebuild it. A placeholder can
also be seeded directly with `ua-write.mjs update <id> <definition.json>` — the
placeholder restriction is the COPILOT editor's, not the update API's.

MISPLACED-SAVE trap: a chat can report "success: true" while the target workflow
never changes, because the build was upserted into a brand-new automation whose
id equals the chat's case id. After every "applied" claim, re-fetch the target
and check `version`/`modifiedTime` moved. If not, look for a stray new
automation holding the build, and start a fresh chat.

## The critique gate

After the tests go green and before anything is called done, audit it like a
staff engineer reviewing a service.

- Every finding stands on a runtime fact (`notes/runtime-facts.md`), a measured
  number from a test run, or a fresh read of the backend source — never a hunch.
  If the runtime's behaviour is unknown, go read it, and add what you learn to
  `runtime-facts.md` so the next critique is cheaper.
- Each finding becomes ONE incremental fix, then re-test, then re-critique.
- A finding we decide to live with gets written into the spec's Notes with the
  reason. Accepted debt is fine; silent debt is not.

The questions, in order of how often they bite:

1. **Latency shape.** Count the external calls on the critical path. Independent
   fetches belong on parallel BRANCH arms that join before the compute step.
2. **Data volume ceiling.** For every bulk fetch: what happens when the data
   outgrows the limit? Silent truncation = wrong answers. **ICM: state the row
   count at target scale**, not at today's test data.
3. **Memory.** One code node holding all records of many object types sums their
   sizes in the run's memory.
4. **Caching.** Slowly-changing reads can use `options.cacheConfig` (TTL
   seconds). Never cache what the same flow writes.
5. **Field discipline.** Fetches project only the fields the flow uses.
6. **Failure model.** Is `fallbackMode: STOP` actually right per node? Optional
   enrichments should not kill the response. For every unique field written: is
   there a pre-check with a distinct `DUPLICATE_*` status, and does the suite
   prove the same-payload-twice call returns it cleanly?
7. **Configuration.** Filter dialect per app, blank-string hardening, respond
   node TYPE = STOP, distinct statuses, applicationId from config, defaults
   applied inside the automation.
8. **Reuse.** Logic in 2+ automations becomes a callable sub-automation now.
9. **ICM — money and periods.** Every rounding point named and justified; the
   period-writable guard present on every write carrying a `periodId`; every
   effective-dated read asking "as of when?"; a second concurrent run refused
   rather than racing. `docs/model/money-and-time.md` is the checklist.
10. **ICM — authorization.** Who may call this, and what does it do when the
    caller may not? A read that returns another person's pay because nobody
    specified the rule is the worst bug this product can have.

## Deploying (gated on an explicit human yes AND a green suite, every time)

Drafts and deployments are separate copies. Callers only ever hit the DEPLOYED
copy.

**THE SUITE GATE — NON-NEGOTIABLE.** Four things must be true, all mechanical:

1. `tests/<workflowId>.json` EXISTS;
2. `node scripts/regress.mjs <workflowId>` prints `all green`;
3. `node scripts/ua.mjs validate <workflowId>` prints `clean`;
4. `node scripts/lint.mjs <workflowId>` prints `clean`.

Deploy through the script that enforces them, never by hand:

```
node scripts/deploy.mjs <workflowId> "what changed and who approved"
```

It refuses on any failed gate, deploys only when all four pass, then VERIFIES by
reading `deploymentState` back. There is deliberately no bypass flag: if you must
ship without a suite, edit `deploy.mjs` on purpose and say so in the commit, so
skipping is a visible act rather than an invisible shortcut.

The Axis repo inherited 21 deployed automations with no suite, and calls that
"a debt somebody will pay at 2am". This repo starts at zero. Keep it there — in
a product that moves money, the suite is the whole safety argument.

**WHAT IS ACTUALLY LIVE.** The authority is `deploymentState` on the workflow
record (`ua.mjs fetch <id>`): compare `deploymentState.workflowVersion` against
the record's `version`. The inventory's draft-vs-deployed column is a hint, not
evidence, and `GET .../deployed-workflow/{id}?latest=true` has returned DRAFT
content. Read `deploymentState` before saying anything is — or is not — live. A
teammate can deploy at any moment, so "I did not deploy it" never means "it is
not deployed".

## Review checklist for automation diffs

- **Branch polarity.** On IF_ELSE the `if` edge fires when the condition is
  TRUE, `next` is the else path. Check every condition against its edges.
- **Builder-clean gate, after EVERY change.** BOTH `ua.mjs validate <id>` AND
  `lint.mjs <id>`. The runtime, the validator, and the builder each see a
  DIFFERENT layer.
- **IF_ELSE and BRANCH config.** IF_ELSE inputs must be `{operator, filters}` at
  the TOP level (a `conditions:` wrapper = silently always false); every BRANCH
  arm needs non-empty filters; nodes after a branch join carry the branch node's
  PARENT groupId, not `...@default`.
- **Hand-made edges carry the builder's vocabulary.** IF edges are named
  `yes`/`no`, branch edges by branch id; every arm's last node has an explicit
  `next` edge to the join node. Never invent edge `id` fields.
- **Sibling consistency.** Checks doing the same kind of job are wired the same
  way.
- **Loops.** API calls inside a for-each are a slowdown multiplier.
- **Half-done states.** Multi-write flows: what happens if step 2 fails?
- **Unique keys.** Every create/update checks the schema snapshot's
  `uniqueKeyFields`; each has a pre-check and a `DUPLICATE_*` path.
- **Failure mode.** Nodes default to `fallbackMode: STOP`. Does a fetch that
  finds nothing error out or return empty? Test both branches.
- **applicationId.** From `kit.config.json`, never a literal. Watch for mixes of
  hard-coded strings and `{{ __USER__.outputs.applicationId }}`.
- **The four questions** — every node that leaves the automation: what is sent ·
  what is NOT sent and why the omission is safe · when it is called · when it is
  NOT called. A node any of whose four answers is unknown does not ship.
- **Filter dialect.** Storage shape vs platform shape. Wrong one crashes at RUN
  time.
- **Blank-string inputs.** Real callers send `""`, not null. Test the
  all-empty-strings payload for every callable.
- **STOP nodes.** Every path ends in a "Respond to automation" with a distinct
  status, and its TYPE must be STOP, not ACTION.
- **Node `type` vs `resourceName`.** A node saved with NO type passes validation
  and then makes the whole workflow unrunnable. `callables_return_to_automation`
  needs STOP; `callables_call_automation` needs CALL_WORKFLOW.
- **Verify writes by RE-READING.** `{"success": true}` is a claim about the
  call, not about the data.
- **TYPED RESPONSES — arrays especially.** Every array declares `items` with
  named `properties`, in BOTH the trigger's `result` schema and the code node's
  output schema. Walk nested arrays too. `required` is what is ALWAYS present.
  Derive the field list from a LIVE RUN, not from the spec.
- **Node names.** Every node's title says what IT does in THIS flow.
- **ICM — money.** No float arithmetic on amounts; one rounding point; every
  amount beside its currency.
- **ICM — periods.** Every write carrying a `periodId` checked the period first.
- **ICM — authorization.** The refusal happens in the callable, not in the page.

## Navigating this repo with graphify

[graphify](https://github.com/Graphify-Labs/graphify) is installed project-scoped
(`.claude/skills/graphify/`). Its operating rules are in the **graphify** section
at the end of this file — that section is written by `graphify install`, so edit
around it, not inside it.

Two things specific to this repo:

- **Useful questions here** are about the money path, not the call graph:
  `graphify query "how does a transaction become a payout"`,
  `graphify path "icmTransaction" "icmPayout"`,
  `graphify explain "icmCalculationRun"`. Most of this repo is prose, so the
  graph's value is connecting a spec to the runtime fact and the snapshot behind
  it.
- **It is a navigation aid, never a source of truth.** When the graph and a
  snapshot disagree, the snapshot is right and the graph is stale. `graphify-out/`
  is git-ignored precisely so nobody reviews it as if it were a document.

## Where deeper knowledge lives

- `docs/model/00-domain-model.md` — the proposed ICM objects, their uniqueness,
  and the invariants the schema cannot enforce.
- `docs/model/money-and-time.md` — **ICM doctrine.** Money arithmetic, the
  period state machine, effective dating, retroactivity, calculation
  concurrency. Read before designing anything that computes pay.
- `docs/model/glossary.md` — the shared vocabulary and the status enums.
- `docs/automations/00-shared-contract.md` — what every automation inherits.
- `docs/pages/00-page-contract.md` — what every page owes.
- `notes/runtime-facts.md` — **inherited, and the most valuable file here.** How
  the UnifyApps runtime actually executes: parallelism, caching, filter
  dialects, write primitives, storage operators, aggregation, loops. Its
  examples are Axis's; its facts are the platform's.
- `notes/incremental-agent-building.md` — the incremental build/test/fix loop.
- `notes/text-to-workflow-agent-call.md` — the full copilot protocol.
- `notes/open-questions.md` — what is still unanswered, and who owes it.
- `snapshots/orbit/automations/` — one JSON per automation + INDEX.md.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
