# ua-icm

Toolbox for building the **ICM** (Incentive Compensation Management) product on
UnifyApps from Claude Code — its objects, its automations, and its application
pages.

**New here? Open [`docs/START-HERE.html`](docs/START-HERE.html) in a browser.**
It explains how the repo is organised and how assets get built, in about five
minutes. Then read `CLAUDE.md` for the working procedure and the safety rules.

---

## Setup

### 1. Objects and automations — 2 minutes

Needs **Node 18+**. Nothing to `npm install`; the scripts use only built-ins.

```bash
cp .env.example .env.local && chmod 600 .env.local
```

You need **two** cookies, because the product is built on tool prod and proved
on orbit. For each of <https://orbit.uat.unifyapps.com> and
<https://tool.prod-aps1.unifyapps.com>: log in, then **DevTools → Application →
Cookies → that origin → copy the value of `_at`**. Paste each between the quotes:

```
UA_ORBIT_COOKIE="<paste here>"
UA_TOOL_COOKIE="<paste here>"
```

The value must not contain a double quote, and nothing may follow the closing
quote — the parser is a small regex, not dotenv. Check both:

```bash
node scripts/ua.mjs whoami
node scripts/ua.mjs whoami --env tool
```

Success prints the environment and a schema id. `cookie is stale` means it
expired — grab a fresh one. **They expire every few days; that is normal.**

Leave `UA_DEFAULT_ENV="orbit"`. Production is reached by typing `--env tool` on
the command, never by changing that default — see *Two environments* below.

### 2. Application pages — 20 minutes, once

Pages are built **in this repo**, using tools from a `ua-agent-devkit` clone.
You need `git`, `pnpm` and `bun`.

```bash
brew install pnpm oven-sh/bun/bun

git clone git@github.com:unify-apps/www.git            # the frontend monorepo
cd www && git checkout feat/more-tools && pnpm install # ~4 min

git clone git@github.com:unify-apps/ua-agent-devkit.git   # next to this repo
cd ua-agent-devkit && bin/setup                           # asks where www is, and for the cookie
```

Then, back here:

```bash
node scripts/page.mjs up      # starts the server, writes .mcp.json
claude plugin install frontend-design@claude-plugins-official
                              # then RESTART Claude Code so it loads both
```

The plugin is the design craft half. The devkit's own brief tells the builder to
load a Designer skill before the first visual decision, and that skill is
platform-side — it is not in the clone, so without this the page comes out
plainly. The other half, the devkit's `agent/instructions.md`, is loaded by
`/start` itself; it is read-only and never copied into this repo.

Build with `/start <builder-url>`, `/restore`, `/done` — all from this session.
Use the `page-design` skill whenever the task is about how a page LOOKS.

> **One devkit clone serves one platform.** Ours is bound to orbit on port 3002.
> For prod, clone the devkit again with its own port and cookie.

---

## Two environments

The ICM objects and callables were built and proved on **orbit** (UAT), then
replicated to **tool prod** on 2026-09-05, which is where the app runs. Both
copies exist; orbit stays the place to prove anything you are unsure of.

One rule covers every script, and it lives in `scripts/env.mjs` so it cannot
drift:

| | |
|---|---|
| `--env orbit\|tool` | on the command line, wins over everything |
| `UA_DEFAULT_ENV` | otherwise |
| `orbit` | otherwise |

**Anything that writes — create, update, deploy — additionally refuses to touch
production unless `--env tool` is literally typed.** `UA_DEFAULT_ENV="tool"` on
its own is not enough and never will be, so a stale default in your `.env.local`
cannot point a deploy at prod. Reads are not gated that way, because reading
prod changes nothing and making it awkward only teaches people to flip the
default.

`fixtures.mjs` is the single exception: orbit-only, no `--env`, on purpose. It
deletes by prefix match, and test data does not belong on production.

```bash
node scripts/ua.mjs drift --tag icm              # orbit
node scripts/ua.mjs drift --tag icm --env tool   # prod — run both
```

## Before you build anything

`kit.config.json` holds the app id, the tags and the object prefix — the only
place they live. Confirmed 2026-09-02: the `icm` tag is ours and the platform is
greenfield. A wrong app id does not error; it silently matches nothing.

```bash
node scripts/ua.mjs search --tag icm     # what automations exist
node scripts/ua.mjs types  --tag icm     # what objects exist
node scripts/ua.mjs drift  --tag icm     # start every session with this
```

---

## Where to look next

| you want | read |
|---|---|
| how the repo is organised | `docs/START-HERE.html` |
| the working procedure and safety rules | `CLAUDE.md` |
| what exists, what it calls, how far along | `docs/architecture.html` (open in a browser) |
| what each automation takes and returns | `docs/automations/` — one spec per callable |
| what each page depends on | `docs/pages/` — the ONLY record that a page calls a callable |
| the objects, their keys and their invariants | `docs/model/00-domain-model.md` |
| money, periods and effective dating | `docs/model/money-and-time.md` |
| every platform call, as curl | `docs/api/platform-endpoints.md` |
| how the runtime really behaves | `notes/runtime-facts.md` |
| what nobody has answered yet | `notes/open-questions.md` |

**The specs are not notes about the product — they ARE the product's
description.** `docs/automations/` and `docs/pages/` are maintained so that
reading them start to end arrives at the current state. A spec that no longer
matches what is deployed is a bug to fix, not a stale doc to ignore.

## The scripts

| script | changes the platform? |
|---|---|
| `env.mjs` | No — shared library: how a script picks its environment |
| `ua.mjs` | No — read-only by design |
| `lint.mjs` | No — kit rules the platform doesn't enforce |
| `debugrun.mjs` | No — reads a run's per-node data |
| `gen-types.mjs` | No — regenerates typed contracts |
| `graph.mjs` | No — regenerates the dependency graph from the repo |
| `page.mjs` | Starts the page tool server and drives the devkit's safety commands |
| `check-docs.mjs` | No — fails when something exists that the docs don't describe |
| `testrun.mjs` · `regress.mjs` | **Executes nodes against real data** |
| `fixtures.mjs` | **Yes** — seeds and resets `KITFIX-` test records |
| `agent.mjs` | **Yes** — drives the builder copilot |
| `ua-object.mjs` · `ua-write.mjs` · `ua-schema.mjs` | **Yes** — prod needs an explicit `--env tool` |
| `ua-automation.mjs` | **Yes** — creates an automation from a snapshot; this is how one environment's work is replicated onto another. Creates a DRAFT, never deploys |
| `ua-datasource.mjs` | **Yes** — creates the data source that lets a page call a callable |
| `deploy.mjs` | **Yes** — the only sanctioned deploy, four gates, and it passes the target env down to all four |

`field-types.mjs` is a shared library, not a command: the one definition of how
a field spec becomes a platform property, used by `ua-object.mjs` and
`ua-schema.mjs` so the two can never drift.

Usage is in each file's header comment.
