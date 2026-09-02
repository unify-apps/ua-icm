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

Get the cookie: open <https://orbit.uat.unifyapps.com>, log in, then
**DevTools → Application → Cookies → the orbit origin → copy the value of `_at`**.
Paste it between the quotes:

```
UA_ORBIT_COOKIE="<paste here>"
```

The value must not contain a double quote, and nothing may follow the closing
quote — the parser is a small regex, not dotenv. Check it:

```bash
node scripts/ua.mjs whoami
```

Success prints the environment and a schema id. `cookie is stale` means it
expired — grab a fresh one. **It expires every few days; that is normal.**

Leave `UA_TOOL_COOKIE` blank. Tool is production and is read-only.

### 2. Application pages — 20 minutes, once

Pages are built through the **`ua-agent-devkit`**, which runs a local MCP server.
You need `git`, `pnpm` and `bun`.

```bash
brew install pnpm oven-sh/bun/bun

git clone git@github.com:unify-apps/www.git            # the frontend monorepo
cd www && git checkout feat/more-tools && pnpm install # ~4 min

git clone git@github.com:unify-apps/ua-agent-devkit.git
cd ua-agent-devkit && bin/setup                        # asks where www is, and for the cookie
```

`bin/setup` writes `.env.local`, starts the server, and generates `.mcp.json`.
Verify:

```bash
curl -s http://127.0.0.1:3002/internal/health     # -> ok
```

Then open Claude Code **in the devkit folder** and approve the `page-builder`
server when prompted. Build with `/start <builder-url>`, `/done`, `/restore`.

> **One devkit clone serves one platform.** Ours is bound to orbit on port 3002.
> For prod, clone the devkit again with its own port and cookie.

---

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

| what exists, what's planned, what's next | `docs/architecture.md` |
| every platform call, as curl | `docs/api/platform-endpoints.md` |
| how the runtime really behaves | `notes/runtime-facts.md` |
| what nobody has answered yet | `notes/open-questions.md` |

## The scripts

| script | changes the platform? |
|---|---|
| `ua.mjs` | No — read-only by design |
| `lint.mjs` | No — kit rules the platform doesn't enforce |
| `debugrun.mjs` | No — reads a run's per-node data |
| `gen-types.mjs` | No — regenerates typed contracts |
| `testrun.mjs` · `regress.mjs` | **Executes nodes against real data** |
| `agent.mjs` | **Yes** — drives the builder copilot |
| `ua-write.mjs` · `ua-schema.mjs` | **Yes** — orbit only, refuse production |
| `deploy.mjs` | **Yes** — the only sanctioned deploy, four gates |

Usage is in each file's header comment.
