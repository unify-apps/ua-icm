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

Node 18+ and **two** browser cookies in `.env.local` (git-ignored, never commit
it). Both, because the product is built on tool prod and proved on orbit:

```
UA_ORBIT_URL="https://orbit.uat.unifyapps.com"
UA_ORBIT_COOKIE="<the _at cookie from orbit>"
UA_TOOL_URL="https://tool.prod-aps1.unifyapps.com"
UA_TOOL_COOKIE="<the _at cookie from tool prod>"
UA_DEFAULT_ENV="orbit"
```

Check both: `node scripts/ua.mjs whoami` and `node scripts/ua.mjs whoami --env
tool`. A 401 means that cookie went stale — paste a fresh one. They expire every
few days; that is normal.

Leave `UA_DEFAULT_ENV="orbit"`. It is the safe default, and it is deliberately
**not** how you reach production — see the environment rule below.

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

- **The product lives on tool (production).** That changed on 2026-09-05: the
  ICM objects and callables were built and proved on orbit, then replicated to
  tool prod, which is where the app `app-1621b11a65c8` ("Ledger") runs. Orbit
  keeps its copy and is still where you prove anything you are unsure of.
- **Production must be typed, never inherited.** Every script that writes takes
  `--env tool` on the command line, and `UA_DEFAULT_ENV` alone can never select
  it. That is enforced in `scripts/env.mjs`, in one place, so it cannot drift:
  a stale default in somebody's `.env.local` can never point a create, an
  update or a deploy at prod. Reads are not gated that way — reading prod
  changes nothing, and making it awkward only teaches people to flip the
  default, which is the accident being prevented.
- **`fixtures.mjs` is orbit-only and stays that way.** It is the one write
  script with no `--env`. `reset` deletes by prefix match, and test data does
  not belong on production.
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

`scripts/env.mjs` — the ONE definition of how a script chooses an environment,
and of the rule that production must be typed rather than inherited. Shared by
every script that talks to the platform. Not a command.

`scripts/ua-write.mjs` — direct workflow-definition update. A FULL REPLACE with
no undo: snapshot and commit first.

`scripts/ua-object.mjs` — CREATES an object type from a compact spec. Changes
the data model for everyone. `plan` prints the body without calling anything;
`create` POSTs it. Never updates, retypes or deletes.

`scripts/ua-automation.mjs` — CREATES an automation from a snapshot, via
`POST /api/workflow-definition`. This is how an automation proved on one
environment is replicated onto another: it strips the fields the server owns
(`id`, `version`, timestamps, ownership, `deploymentState`), takes tags from
`kit.config.json` rather than the snapshot, and refuses a duplicate name on the
target. It creates a DRAFT and never deploys — that is `deploy.mjs` and its
gates. `plan` prints what would be sent without calling anything.

`scripts/ua-schema.mjs` — adds properties to an object schema that already
exists. Changes the data model for everyone. Never removes or retypes.

`scripts/ua-datasource.mjs` — CREATES the page data source that lets a PAGE
call a deployed automation. It exists because the devkit's own
`create_data_source` hardcodes `entityType: 'e_data_source_deployed'`, which
does not exist on orbit — the failure reads as a permissions error and is not
one. This script PROBES which data-source type the platform actually has and
uses that, rather than inheriting the same hardcoded literal — and that probe
matters more across two environments, not less, since nothing says prod answers
the way orbit does. `plan` prints the body without calling anything; `create`
POSTs it.

`scripts/field-types.mjs` — the ONE definition of how a field spec becomes a
platform property, shared by the two above. Not a command.

`scripts/fixtures.mjs` — seeds and resets the loudly-named (`KITFIX-`) record
families the suites run against. This is the mechanism behind the ICM rule
about never testing on real pay data.

`scripts/graph.mjs` — regenerates `docs/architecture.html` from snapshots,
specs and suites. `--check` fails when it is stale; `--json <path>` dumps the
raw graph for ad-hoc querying.

`scripts/check-docs.mjs` — fails when a script or docs area exists that
`docs/START-HERE.html` does not describe.

`scripts/deploy.mjs` — the ONLY sanctioned way to deploy (see the gates below).

`scripts/gen-types.mjs` — regenerates `docs/api/icm-types.ts` from the entity
snapshots, driven by `kit.config.json`.

The fixture families themselves live in `tests/fixtures/`. `fixtures.mjs` only
ever deletes records whose business key carries the family's loud prefix, which
is the mechanism behind the ICM rule about never testing on real pay data.

## Objects: the data model you own

ICM object types are the ones tagged per `kit.config.json`, and that family is
the only one we snapshot. Snapshots are **per environment** —
`snapshots/orbit/…` and `snapshots/tool/…` — because the two can legitimately
differ while something is being proved on orbit before it reaches prod. Refresh
with `node scripts/ua.mjs snap-types --tag <tag> [--env tool]`; re-run it when
the team adds objects.

Run `drift` against BOTH before designing anything. A drift check that only
looks at orbit will happily tell you a change is safe while prod says otherwise.

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

Pages are built **here, in this repo, in this conversation** — not in a second
Claude Code session with its own context. `scripts/page.mjs` drives the
`ua-agent-devkit` clone (path in `kit.config.json`, `pages.devkitDir`), so the
tools and the safety come from there while the thinking stays here.

```
node scripts/page.mjs up      start the tool server, wire .mcp.json, then RESTART Claude Code
```

That gives this session two MCP servers: `page-builder` (35 typed page tools)
and `preview-browser` (a logged-in Chrome for looking at the result).
`.mcp.json` carries a live cookie — it is `chmod 600` and git-ignored.

Four commands, and they are not optional:

| command | what it does |
|---|---|
| `/start <builder-url>` | **snapshots the page BEFORE any edit**, prints the `host`/`interfaceId`/`pageId` every page tool needs, and **loads the devkit's builder brief** |
| `/restore` | puts the page back exactly as it was at `/start` |
| `/done "note"` | writes the page spec here, the session record in the devkit, and regenerates the map |
| `/page-status` | is the server up, which session am I in, is anything uncommitted |

**`/restore` is the only per-page undo that exists.** The platform's own version
history restores the WHOLE app, not one page. So `/start` is not optional: a
page edited without it has no small way back.

**The page spec in `docs/pages/` is written or updated BEFORE `/done`.** The
build happens through the devkit's tools; the record of what a page depends on
lives here, and nowhere else — nothing on the platform stores it. `/done`
regenerates `docs/architecture.html` so a page that does not appear wired to its
callables is a spec that is wrong.

Session transcripts stay in the devkit (that is where the team collects them);
the spec and the map stay here. Two records, deliberately: one is how it was
built, the other is what it depends on.

**The tools come across; the brief does not.** The devkit's
`agent/instructions.md` is the platform agent's own configuration — the app
model, the runtime's behaviour, the knowledge-sheet rules, where a look can
live, twelve worked examples — and it auto-loads from that repo's `CLAUDE.md`
only when Claude Code runs in that directory. Building pages from here without
it is why the first page came out plainer and more guess-prone than one built in
the devkit. So `/start` reads it, in full, as step 3 of every page session. It
is read-only: regenerated there from the lab repo by `bin/sync-prompt.mjs`, so
it is never edited and never copied into this repo. Where it and this file
differ, **this file wins** on the layer rules, the spec-first discipline and the
ICM safety rules; the brief wins on everything about how the platform behaves.

**Design work has a second half, and it is a skill.** When the task is about how
a page READS rather than what it does, use `page-design`
(`.claude/skills/page-design/`) **before the first visual decision.** It loads
the `frontend-design` craft skill, points at the brief's design section (the
three rungs: block tokens → conditional values → custom CSS, and "match the
relationship, not the number"), and names the traps this repo has already paid
for — `rounded-lg` is not a token, icon names carry the `Svg` prefix, and the
app sits on the pre-retheme cool palette, which is a THEME fix and never a
per-block one.

Not ported: the devkit's `run-tests` and `write-tests` skills, which need its
`qa/` apparatus. Use them from the devkit if you need them. `preview-pixel-perfect`
works here, and is how a design task is verified rather than assumed.

## The architecture map, and the layer rules it draws

`docs/architecture.html` is the one picture of the system — every object,
automation and page, what depends on what, and how far along each is. Open it in
a browser: drag to pan, scroll to zoom, hover a card to trace its dependencies,
click for the detail.

**It is generated, never drawn.** `scripts/graph.mjs` derives it from entity
snapshots (objects and their foreign keys), automation snapshots (what each
reads, what it calls, its real `deploymentState`), `docs/pages/` (the
page→callable dependencies the platform records NOWHERE else), `tests/` (which
have suites) and the domain model (what is proposed but unbuilt). If an asset is
missing from the picture, record it in one of those places — never edit the
output. A node shown as **missing** is referenced but not snapshotted: a
dangling reference, which is the whole reason the picture exists.

There is deliberately ONE file. A separate diagram, data file and status board
describing the same assets is three places for one truth to rot in.
`node scripts/graph.mjs --json <path>` dumps the raw graph when something needs
to query it.

**Layer rules the map exists to enforce:**

- **Pages never touch objects directly.** A page calls a callable; the callable
  reads and writes. Not style — authorization lives in the callable, so a page
  reaching around it is a page that can show somebody else's pay.
- **Shared logic is a callable, not a copy.** When the same check appears in a
  second automation, it becomes a callable then, not later.
- **Automations are the only writers.** Ad hoc record writes through
  `/api/entity/create-update-or-delete/hierarchical` are for fixtures and
  debugging only, and never against real pay data.
- **Nothing is reachable until it is DEPLOYED.** Callers only ever hit the
  deployed copy, so a card that is not green is not in the product yet.

When the map and a snapshot disagree, the snapshot is right. Start every session
with `ua.mjs drift --tag icm` **and** `ua.mjs drift --tag icm --env tool` — the
product runs on prod, so an orbit-only drift check is half a picture.

## Keeping the repo describable (you run the regenerators; one check runs itself)

**The map and the knowledge graph are regenerated ON REQUEST, not on a timer.**
They used to run from a `Stop` hook at the end of every session. That is off,
deliberately (2026-09-03): regenerating unasked rewrote `docs/architecture.html`
on every single session — usually only its timestamp — so every session ended
with a dirty file nobody had changed, and a commit's diff stopped meaning
anything. A generated file that changes when nothing changed is noise, and the
team reads these.

```
node scripts/graph.mjs           regenerate docs/architecture.html + .json
node scripts/graph.mjs --check   FAIL if it is stale — this is the gate
graphify update .                rebuild the knowledge graph (AST-only, no API cost)
```

**The cost of that choice, stated plainly: the map CAN now be stale.** It could
not before. So `graph.mjs --check` stops being a formality and becomes the thing
that catches it — run it before you commit anything that changes an automation, a
page spec or an object, and regenerate when it fails. The rule that the picture
is never hand-drawn is unchanged; only when it is redrawn has changed.

Regenerate whenever you have changed what the map is derived FROM: an automation
snapshot, a file in `docs/pages/`, a suite, an entity snapshot, or the domain
model. `/done` still regenerates it for you at the end of a page session, because
a page's callable dependencies exist nowhere else.

**One thing still runs itself**, from the `Stop` hook in `.claude/settings.json`:

- **`node scripts/check-docs.mjs --warn`** — reports anything that exists in the
  repo but is not described in `docs/START-HERE.html`. It is kept automatic
  because it WRITES NOTHING. It only reads and reports, so it can never dirty
  the tree the way the regenerators did.

**The rule it enforces: a new script, a new `docs/` area, or a new process is
not finished until `docs/START-HERE.html` says what it is and when you would
reach for it.** The check can only see whether the name appears somewhere — it
cannot tell whether you explained it. Adding a name to silence the check,
without saying what the thing is for, is worse than the gap, because it turns a
visible hole into an invisible one.

Anything that WRITES to the platform also goes in the script list above, since
that list is the safety contract rather than a convenience index. `check-docs`
fails, not warns, on that one.

All three are idempotent, so running one by hand is always safe.

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
- **It is refreshed on request, not on a timer** (changed 2026-09-03). Nothing
  rebuilds it at session end any more, so assume it is as old as the last person
  who ran `graphify update .`. That is fine for a navigation aid and it is the
  reason the line above matters: reach for a snapshot or a spec when the answer
  has to be right, and reach for the graph when you are still looking for where
  the answer lives.

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
