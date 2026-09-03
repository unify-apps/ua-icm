# ICM application pages — shared contract

**Status: the tooling works (proven 2026-09-02).** Pages are built through the
**`ua-agent-devkit`**, which runs `www/packages/llm-tools` as a local MCP server
bound to one platform. Open question 10 is answered: there is no plain REST path
for a page, and there does not need to be — the devkit's typed tools are the
supported route, and they refuse a bad write instead of rendering an empty
screen.

This folder stays the place a page's contract is agreed FIRST — same discipline
as automations, same reason: a page is a caller, and callers that were never
specified are how contracts drift. The tools build the page; this folder is the
only record of what it depends on.

## How a page actually gets built

**Pages are built HERE** (changed 2026-09-03 — previously this said a second
Claude Code session had to be opened in the devkit folder). `scripts/page.mjs`
runs the devkit's own bin scripts with the devkit as its working directory, so
the snapshot, restore and trace guarantees are exactly the devkit's — nothing is
reimplemented or forked — but the page work happens in the same session, and the
same context, as the automations and specs it depends on.

The devkit clone is located by `pages.devkitDir` in `kit.config.json` (or
`UA_DEVKIT_DIR`). `node scripts/page.mjs up` starts the tool server and writes
the `.mcp.json` that hands the 35 page-builder tools to Claude Code; that file
carries a live platform session cookie and is git-ignored. **Claude Code reads
`.mcp.json` at startup**, so a session that was already open when it was written
does not have the tools — restart it.

The commands that matter, all of them running here:

| command | what it does |
|---|---|
| `/start <builder-url>` | snapshots the page BEFORE any edit — page, interface, data sources |
| `/done "note"` | writes the session record and commits it: what was asked, what happened, where it went wrong, plus a full trace of every tool call |
| `/restore` | puts the page back exactly as it was at `/start` |

**`/restore` is the only per-page undo that exists.** The platform's own version
history restores the WHOLE app, not one page. A page edited without `/start` has
no small way back — so `/start` is not optional.

### The rule that keeps this repo honest

**The page spec in this folder is written or updated BEFORE `/done`.** `/done`
enforces the order: the spec first, then the session record, then the
regenerated map. The session TRANSCRIPT lives in the devkit; the record of what
the page DEPENDS ON lives here, and nowhere else — nothing on the platform
records that a page calls a callable.

`/page-status` answers "is this wired up, and what session am I in" — run it
first when anything looks wrong. Setup for the devkit clone lives in its own
README. One clone serves one platform; ours is bound to **orbit** on port 3002.

## A page is a caller, and that is the whole point of specifying it

Every page calls callables. The moment a page exists, the automations it calls
have a consumer that will break if their contract changes — and unlike an
automation-to-automation call, nothing in the snapshots records the dependency.
So the record is here:

- Every page spec lists the callables it invokes, by token.
- Every automation spec's **Callers** row names the pages that call it.
- Changing a callable's contract means walking `docs/pages/` as well as the
  automation corpus. A page is not a softer dependency than a CallWorkflow node;
  it is a harder one, because it fails in front of a user.

## What every page owes

| obligation | why |
|---|---|
| **Names its audience and its authorization rule** | comp data is need-to-know. A page that shows earnings states who may open it and what a user who may not sees. The page hiding a widget is not authorization — the *callable* refuses, and the page reflects the refusal |
| **Handles every status the callables return** | a transport 200 means the automation ran, not that the work happened. Branch on `status`, always |
| **Has an empty state, a loading state, and an error state** | the first period of a new customer's data is empty, and the calculation page is the one people watch while it runs |
| **Shows money with its currency and its as-of date** | a number on a comp screen with no period and no currency is unreadable and will be screenshotted into a complaint |
| **Explains, not just displays** | see below |

## Explainability is the product's core feature

Reps do not trust a number they cannot trace. Every screen showing an amount
answers "why is this the number?" within one click: a payout opens its earnings,
an earning opens its attainment and the rate tier applied, an attainment opens
the credits, a credit opens its transaction. That path is the product. If a
page shows a total that cannot be drilled into, either the page is incomplete or
the model is — say which in the spec rather than shipping a dead end.

The corollary for automations: read callables are designed so this drill-down
does not require N+1 calls per row. Design the read path with the page's
interaction in mind, not just its first paint.

## Pages this product needs

A starting list, to be argued with rather than accepted. One spec file per page
once it is real.

| page | audience | shows |
|---|---|---|
| My earnings | participant | current period attainment, earnings by component, projected payout |
| My statement | participant | the published statement for a period, with drill-down and a dispute action |
| Plan explorer | participant | the plan they are on: components, rate tiers, quota, in plain language |
| Team dashboard | manager | reports' attainment and payouts, rollup credit, outliers |
| Plan builder | comp admin | create/version plans, components, rate tables |
| Quota management | comp admin | bulk quota assignment per period and measure |
| Calculation console | comp admin | trigger a run, watch status, diff against the previous run |
| Payout approval | finance | payouts pending approval, approve/hold/release, period close |
| Dispute queue | comp ops | open disputes, assignment, resolution |
| Transaction explorer | comp ops | ingested transactions, their credits, unmatched rows |

## What goes in a page spec

See `_TEMPLATE.md`. The parts that matter most and get skipped most: the
callables list, the authorization rule, and the status-by-status behaviour.
