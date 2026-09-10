# Condition grammar — moved

This spec, `ConditionMatcher.groovy` and its case table now live in the
**Sales-Commission-Management** repo, under `engine/`.

They moved on 2026-09-10 for one reason: this kit is scaffolding and will be
retired, and the app repo is what survives. Anything needed to understand or
repair the engine has to outlive the tools that built it.

It also removed a coupling this repo could not police. The grammar is the dual of
`app/src/components/plan/condition-namespace.ts` — one decides what a rule can be
authored to say, the other what the engine can evaluate — and with the two in one
repo, `condition-namespace.test.ts` holds them together in a single PR. Across
repos, nothing would have noticed them drifting.

What stays here is the kit's job: building and running the automation.

```
node scripts/testrun.mjs 6aa27c908f78990409f2b9ea --env tool
```

`ICM | Probe Condition Matcher (KIT TEST - safe to delete)` runs the case table on
the platform's own Groovy. **It is the piece that does not survive this kit** —
before the kit is retired, that job needs to move to a `dryRun` mode on the real
engine automation.
