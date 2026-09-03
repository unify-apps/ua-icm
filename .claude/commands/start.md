---
description: Snapshot the page and begin a page-building session
argument-hint: <builder URL> [short name for this session]
allowed-tools: Bash(node scripts/page.mjs:*), Bash(sed:*), Bash(grep:*), Read
---

Open a session on the page the user named. **This runs here — there is no
second Claude Code session to open.**

1. Run `node scripts/page.mjs start $ARGUMENTS`. It starts the tool server if it
   is down, then snapshots the page BEFORE anything touches it.
2. Report what it printed — which page, how many blocks, and the build.
3. **Load the builder brief.** The devkit's `agent/instructions.md` is the
   platform agent's own configuration — the app model, the runtime's behaviour,
   the knowledge-sheet rules, where a look can live, and twelve worked examples.
   It auto-loads in the devkit and NOT here, which is the whole reason a page
   built from this repo comes out plainer and more guess-prone than one built
   there. So read it now, in full, before building anything:
   `node scripts/page.mjs` prints `devkit: <path>`, and the file is
   `<path>/agent/instructions.md`. It is read-only — regenerated there from the
   lab repo — so never edit it and never copy it into this repo.

   Where it and this repo's CLAUDE.md differ, **this repo wins** on the layer
   rules, the spec-first discipline and the ICM safety rules; the brief wins on
   everything about how the platform itself behaves.

   If the task is about how the page LOOKS, use the `page-design` skill as
   well — it loads the craft half and names the traps this repo has already hit.

If it says the URL carries no page, show the page list it printed and ask which
one they mean, then re-run with `--page <id>`.

If it fails on the cookie, say plainly that the platform session expired: paste
a fresh `_at` into the devkit's `.env.local`, then `node scripts/page.mjs up`.

If a session is already open on that page, do NOT use `--force` on your own
initiative — another window is probably building it. Tell the user and let them
decide.

Once it succeeds, **hold on to the `host`, `interfaceId` and `pageId` it
printed for the rest of this conversation.** Every page-touching tool needs
`host` and `interfaceId` on every call, and `/done` and `/restore` need
`--page <pageId>` when more than one session is open.

If the page-builder tools are not available, `.mcp.json` is missing or Claude
Code has not reloaded it — run `node scripts/page.mjs up` and restart.

Then ask what they want built.
