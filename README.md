# ua-icm

Toolbox for building the **ICM** (Incentive Compensation Management) product on
UnifyApps from Claude Code — its automations, its objects, and its application
pages. Read `CLAUDE.md` for the full working procedure and safety rules.

Descended from [`ua-automationkit`](https://github.com/unify-apps/ua-automationkit)
(the Axis kit). The scripts, the spec-first discipline, the deploy gates, and
`notes/runtime-facts.md` all come from there and are proven in production. What
is new here: product identifiers live in one config file instead of being
hardcoded, and `docs/pages/` covers application pages, which the Axis kit does
not model.

## Prerequisites

Node 18+ (the scripts use only Node built-ins — there is nothing to `npm install`).

```
node --version
```

## Setup

Auth is a browser session cookie.

1. Create your local env file from the template:

   ```
   cp .env.example .env.local
   chmod 600 .env.local
   ```

   `.env.local` is git-ignored. Never commit it, and never paste a cookie into
   `.env.example`.

2. Grab the cookie from Chrome:

   - Open <https://orbit.uat.unifyapps.com> and make sure you are logged in.
   - DevTools → **Application** → **Storage** → **Cookies** → the orbit origin.
   - Copy the **Value** of the cookie named `_at`.

3. Paste it into `.env.local` between the quotes:

   ```
   UA_ORBIT_COOKIE="<paste here>"
   ```

   The value must not contain a double quote, and nothing may follow the
   closing quote on that line — the parser is a small regex, not dotenv.

4. Check it:

   ```
   node scripts/ua.mjs whoami
   ```

   Success prints the environment and a schema id. `not logged in ... cookie is
   stale` means the cookie expired — repeat step 2 with a fresh one.

Leave `UA_TOOL_COOKIE` blank. Tool is production and is read-only unless a
human explicitly asks for it.

## Before the first build: confirm the identifiers

`kit.config.json` is the only place product-specific names live — the
application id, the tags that define membership, the object-type prefix. The
values committed today are **placeholders inherited by convention from the Axis
kit**, not values read off the platform. Confirm them first:

```
node scripts/ua.mjs search --tag icm     # do any ICM automations exist yet?
node scripts/ua.mjs types  --tag icm     # do any ICM object types exist yet?
```

A wrong `applicationId` does not raise an error. It silently matches nothing —
the single most expensive class of mistake in the Axis repo's history. Fix
`kit.config.json` before building, and everything downstream follows.

## Layout

| path | what |
| --- | --- |
| `CLAUDE.md` | the working procedure. Read it before touching anything |
| `kit.config.json` | app id, tags, entity prefix — the only product-specific identifiers |
| `docs/model/` | the ICM domain model, the glossary, and the money/period rules |
| `docs/automations/` | one spec per automation + the shared contract every spec inherits |
| `docs/pages/` | one spec per application page + the shared page contract |
| `docs/api/` | typed contracts for the UI (`icm-types.ts` generated, `icm-callables.ts` hand-written) |
| `notes/` | platform runtime facts, the incremental build loop, open questions |
| `scripts/` | the kit itself (see below) |
| `snapshots/` | one JSON per automation and per object schema — the review baseline |
| `tests/` | one regression suite per automation, named `<workflowId>.json` |

## Scripts

| Script | Can it change the platform? |
| --- | --- |
| `scripts/ua.mjs` | No. Read-only by design: whoami, search, fetch, snapshot, validate, inventory |
| `scripts/lint.mjs` | No. Kit rules the platform does not enforce |
| `scripts/regress.mjs` | Runs test executions — treat as "yes", it executes nodes against real data |
| `scripts/testrun.mjs` | Same: test-runs a draft against real data |
| `scripts/debugrun.mjs` | No. Reads a run's per-node inputs/outputs |
| `scripts/agent.mjs` | **Yes.** Sends messages to the builder copilot, which edits the automation's draft |
| `scripts/ua-write.mjs` | **Yes.** Direct workflow-definition update. Orbit only, refuses production |
| `scripts/ua-schema.mjs` | **Yes.** Adds properties to an object schema — changes the data model for everyone |
| `scripts/deploy.mjs` | **Yes.** The only sanctioned way to deploy. Enforces the four gates |
| `scripts/gen-types.mjs` | No. Regenerates `docs/api/icm-types.ts` from the entity snapshots |

Usage for each is in the header comment of the file and in `CLAUDE.md`.

## Navigating the corpus with graphify

[graphify](https://github.com/Graphify-Labs/graphify) is registered for this
project. It maps the repo — specs, notes, snapshots, scripts — into a graph you
query instead of grepping:

```
/graphify .                       (in Claude Code) build the graph
graphify query "how does a transaction become a payout"
graphify path "icmTransaction" "icmPayout"
graphify explain "icmCalculationRun"
```

Output lands in `graphify-out/` (git-ignored). Rebuild it after a batch of spec
changes; a stale graph answers yesterday's question.

## Pointing at a different instance

The two environment slots are named `ORBIT` and `TOOL` in code, but nothing is
hardcoded to those hostnames. To work against another instance, change the URL:

```
UA_ORBIT_URL="https://your-instance.example.com"
UA_ORBIT_COOKIE="<the _at cookie from that host>"
```

Cookies are per-host — a cookie from one instance will not authenticate
against another.
