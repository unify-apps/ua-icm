---
description: Is the page tooling wired up, and what session am I in?
allowed-tools: Bash(node scripts/page.mjs:*), Bash(git status:*), Read
---

Report the state of the page setup in a few lines:

1. `node scripts/page.mjs status` — is the tool server up, how many tools, and
   which sessions are open on this machine.
2. Which one is THIS conversation's, using the `pageId` from `/start`. If there
   are none, point at `/start`.
3. Whether `.mcp.json` exists here and the page-builder tools are actually
   loaded. If not: `node scripts/page.mjs up`, then restart Claude Code.
4. `git status --short docs/pages/` — any page specs not yet committed.

Keep it short. If the server is down, the first thing to say is
`node scripts/page.mjs up`.
