# Page | Rules Library

**Built state (2026-09-07): LIVE.** `/plan/rules` in the
`Sales-Commission-Management` code app reads real `Rule` records through two list
callables, and `/plan/rules/new` writes them through two create callables. The
page carries no seed data.

## What the page calls

| page | callable | dataSource | binding |
|---|---|---|---|
| `/plan/rules` — Credit tab | `ICM \| List Credit Rules` | `ds_list_credit_rules` `e_6a9ebc0f561c60372d54e21d` | `LIST_CREDIT_RULES` |
| `/plan/rules` — Payout tab | `ICM \| List Payout Rules` | `ds_list_payout_rules` `e_6a9ebc10561c60372d54e223` | `LIST_PAYOUT_RULES` |
| `/plan/rules/new?type=credit` | `ICM \| Create Credit Rule` | `ds_create_credit_rule` `e_6a9ebc0f06e24f215ba85b1d` | `CREATE_CREDIT_RULE` |
| `/plan/rules/new?type=payout` | `ICM \| Create Payout Rule` | `ds_create_payout_rule` `e_6a9ebc0f06e24f215ba85b22` | `CREATE_PAYOUT_RULE` |

All four rows were provisioned against this app's global page
(`e_global_app-1621b11a65c8`) with `scripts/ua-datasource.mjs`, and every value in
`app/src/data/callables.ts` was read back off the stored row rather than typed.

**The stage is the binding, not an input.** Both stages live in one `Rule` object
separated by `stage`, so the tab picks which callable to call and the page never
sends a stage. That is also why switching tabs is a different query id
(`icm-rules-credit` / `icm-rules-payout`) — the two lists never share a cache
entry.

## Paging and filters are SERVER-side

`search` (name or ruleId), `name`, `ruleType`, `limit`, `offset` all narrow inside
the automation, so `total` and `hasMore` describe the FILTERED set. The pager
therefore only offers pages that exist, and any change to search, filters or tab
resets to page 1 — otherwise narrowing 80 rules to 3 leaves you on page 5 of a
1-page list looking at an empty table that is not actually empty.

`PAGE_SIZE` is 10. The callables clamp `limit` to 200 rather than trusting it.

## The create-then-see problem, and what the page does about it

A rule written **through a callable** takes **3 to 11 seconds** to become
searchable. Measured, four trials, each timed from the moment the create
automation returned `OK` with a recordId: **3021 / 3624 / 8153 / 10685 ms**. The
write itself is immediate and fetch-by-id finds it at once; only SEARCH lags. A
direct entity write indexes in ~330ms, so this is a property of the write PATH,
not of the platform. See `notes/runtime-facts.md`.

So a plain "create, then refetch the list" shows a stale list, and a fixed
`setTimeout` cannot fix it — a delay long enough for the 10.7s case is longer than
anyone will sit still.

**What the page does instead**: the create screen navigates to
`/plan/rules?stage=<stage>&awaiting=<ruleId>`. While that id is absent from the
list, the page refetches every 1.5s and says on screen that the rule is saved and
being indexed. After 24s it stops and says so — a spinner that never resolves
teaches people the page is broken, while "it is saved, it has not been indexed
yet" is true and tells them a refresh will work.

## What the page deliberately does NOT do

**No editing.** The old sheet had a Save button over seed data. There is no
fetch-one-rule callable and no update callable, so a Save button here would be a
button that lies; the sheet is a read-only detail panel now. Authoring happens on
the create screen.

**No clauses in the detail panel.** The list callables return `conditionCount` and
`resultCount`, not the conditions and results, so a page of 200 rules does not drag
200 nested arrays across the wire. Showing the clauses needs the fetch-one callable
that would also unblock editing.

**Rule-type vocabularies stay in the page.** `Rule.ruleType` is a free string on the
object, so there is no server-side vocabulary to read. They live in
`app/src/components/plan/rule-vocab.ts` — one place, because the create form OFFERS
them and the list filter FILTERS BY them, and two lists that drift are how a filter
ends up unable to select a value the form can produce.

## Still on seed

`app/src/routes/simulator/use-payout-sim-rules.ts` still reads `RULES` from
`plan-seed`. Moving the Simulator across needs the conditions and results
themselves, which the list callable returns as counts — the same missing
fetch-one-rule callable. The stale `RULES_TOTAL = 82` was removed; it was the
number showing above an empty object.
