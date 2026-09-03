---
description: Write the page spec, save the session record, and stage both
argument-hint: [one line on how it went]
allowed-tools: Bash(node scripts/page.mjs:*), Bash(git:*), Read, Write, Edit
---

Close out this page session. **Two records, not one** — the session transcript
lives in the devkit, and what the page DEPENDS ON lives in this repo, because
nothing on the platform records that a page calls a callable.

1. **The page spec, first.** Create or update `docs/pages/<page>.md` from
   `docs/pages/_TEMPLATE.md`. It must name every callable the page invokes, by
   token and workflow id, and every status the page handles. Each of those
   automations' specs names this page in its **Callers** row in return. Both
   sides, or the dependency is invisible.
2. **The session record.** Run
   `node scripts/page.mjs trace --page <pageId> --note "$ARGUMENTS"`, then write
   `<dir>/session.md` from the template below, filled in from what ACTUALLY
   happened in this conversation — not from what was intended.
3. **Regenerate the map**: `node scripts/graph.mjs`. The new page should appear
   in `docs/architecture.html` wired to the callables you listed in step 1. If
   it does not, step 1 is wrong.
4. `git add` the page spec and the regenerated map here, and the session folder
   in the devkit. Commit each in its own repo. **Do not push for them.**

Template for `session.md`:

```markdown
# <page name> — <date>

**App:** <interfaceId> · **Page:** <pageId>
**Build:** <branch> @ <sha>

## What was asked for
<the user's request, in their words>

## What actually happened
<what got built, and what did not>

## Where it went wrong
<every refusal, wrong result, missing tool or confusing message — one bullet
each. If nothing went wrong, say so.>

## Would the platform agent have managed this?
<Claude Code here has tools the real agent does not. Say whether anything in
this session depended on those.>
```

Be honest in "Where it went wrong". A record whose notes say it went fine, next
to one full of refusals, is worse than no notes at all.
