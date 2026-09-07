# ICM | List Rate Tables

`6a9ed01e3aa7845ea1903d9b` — deployed on tool 2026-09-07 (v2), suite 21/21.
Data source `ds_list_rate_tables` = `e_6a9ed1fe06e24f215ba8d8db`.

The rate tables a payout rule can point at. Built for one caller: the Create Rule
screen, where choosing **Result Rate Type = Tiered Rate** has to offer real tables
rather than a typed name.

## Inputs

| field | note |
|---|---|
| `search` | matches `name` OR `rateTableId`, `ICONTAINS` |
| `mode` | `EQUAL` — `Rate` or `PctOfTarget` |
| `tiering` | `EQUAL` — `Marginal` or `Cliff` |
| `limit` | default 50, clamped 1..200 |
| `offset` | |

All narrow **server-side**, so `total` and `hasMore` describe the filtered set.
`mode` and `tiering` combine as AND — asserted, because an OR here would quietly
widen every picker.

Rows carry `rateTableId`, `recordId`, `name`, `mode`, `tiering`.

Unlike the two rule lists there is **no identity filter**: a rate table has no
stage and no active window, so an empty filter set legitimately means "all of
them".

## The trap this build walked into

The automation was cloned from `ICM | List Credit Rules` and its Groovy was
rewritten — but a Groovy node's `inputs.parameters` map is what BINDS variables
into the script, and it still named the old inputs. `mode` and `tiering` arrived
at the START node and never reached the code.

Nothing failed. `opt()` reads an unbound variable as blank, so the filters were
simply skipped and every query returned all three fixtures. Only the suite caught
it, because it asserted what each filter EXCLUDES rather than only what it matches.

Same class as a stale `fields` projection: **rewriting a node's code is not
rewriting its contract.**

## Note on the caller

`RateTable` has **zero records** on tool. The picker therefore renders "No rate
tables defined yet — create one first" rather than an empty dropdown, and that is
the expected state until rate tables are authored — not a fault.
