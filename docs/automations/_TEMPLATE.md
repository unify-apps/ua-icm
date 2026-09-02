# ICM | <Name>

<!--
Copy to docs/automations/<token-in-kebab-case>.md and fill in. Delete this
comment and any section that genuinely does not apply — but deleting a section
because it is hard to answer is how the answer gets discovered in a failing run.

The spec exists BEFORE any prompt goes to the builder copilot. No exceptions.
-->

**Built state**: not built. <!-- once built: draft vN, validate clean, lint
clean, suite tests/<workflowId>.json N/N green, deployed y/n + who approved -->

| field | value |
|---|---|
| Token / name | `ICM \| <Name>` (`<workflowId>`), tags `<from kit.config.json>`, CALLABLE |
| Purpose | one sentence |
| Replaces | what happens today without it — the sanity check on scope |
| Callers | which automations (CallWorkflow), which pages/frontend paths, and what a caller must NOT assume |
| Authorization | who may call this; what happens when the caller may not (see the shared contract — reads of pay data always answer this) |

## Entity study

For every object this flow reads or writes, from the schema snapshot, never
assumed:

- `<icmObject>` — required fields · `uniqueKeyFields` · FKs in both directions ·
  who else writes it (grep the snapshots for the object_type).

## Period and money

<!-- Delete only if the flow touches neither. Most do. -->

- Which `periodId` does this write to, and what does it do when that period is
  not writable? (`PERIOD_LOCKED`)
- Which reads are effective-dated, and as of what date?
- Where does rounding happen, and is that the single rounding point?
- If it runs twice: same result, or double payment?

## Input (`setup`)

Each parameter: type, required/optional, default, and how a blank string is
treated. Amounts name their currency field; dates name their timezone rule.

## Output

The exact response per outcome. Every field typed; every array declares `items`
with named properties; `required` limited to what is always present.

Statuses: `SUCCESS` · `INVALID_INPUT` · `FORBIDDEN` · `PERIOD_LOCKED` · …
Every non-success returns `success:false` + `status` + a human `message`.

## Node plan

Numbered node list in order. For each node: what it does, and for every node
that LEAVES the automation, the four questions —

1. what is SENT, and why each field
2. what is NOT sent, and why each omission is safe
3. WHEN it runs (which guards passed first)
4. when it must NOT run (which outcomes skip it)

Name the EXISTING callables reused rather than rebuilding them.

## Errors

Named failure cases. For EVERY write node and side-effecting CallWorkflow: what
the caller sees if it fails. For multi-write flows: the state left when a middle
write fails, and whether a full retry mints duplicates.

## Changes — the system of changes

One row per thing this touches. Verdicts are a closed set: *unaffected* (say
why) · *cascade* (name the edit that carries it) · *reassign* (name the edit) ·
*blocks* (refuse; say what the caller is told) · *handled already* (name where) ·
*accepted* (written into Notes with the reason).

| thing | verb | verdict | how would we notice if this is wrong? |
|---|---|---|---|
| | | | |

A row with no detection story — no regression case, no distinct respond status,
no drift check — is not handled. It is accepted with the risk hidden.

## Tests

`tests/<workflowId>.json`. At minimum: happy path · all-empty-strings payload ·
each named error status · for anything that CREATES, the same payload sent twice
· for anything touching a period, a locked-period case.

## Notes

Accepted debt with reasons. Open questions by name. Probed facts with the date
they were probed.
