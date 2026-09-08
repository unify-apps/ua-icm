# ICM | List Credit Types / Attainment Measures / Quotas

Three listers built for one caller: the Create Rule screens, where a field that
points at a record must offer real records rather than a typed name.

| callable | id | data source | suite |
|---|---|---|---|
| `ICM \| List Credit Types` | `6a9ee2fc00191677c2ead441` | `e_6a9ee47e06e24f215ba90ebb` | 12/12 |
| `ICM \| List Attainment Measures` | `6a9ee2fd3aa7845ea194eaa3` | `e_6a9ee47f561c60372d559079` | 11/11 |
| `ICM \| List Quotas` | `6a9ee2fd8f78990409ff3fb5` | `e_6a9ee47f561c60372d55907b` | 11/11 |

All three share one shape: `search`, object-specific filters, `limit` (default 50,
clamped 1..200), `offset`, and a `status`/`total`/`hasMore` envelope. Every filter
narrows server-side.

**Rate tables are NOT in this family.** The rule editor's Rate Table picker reads
`ICM | Query Rate Tables` — the same callable the Reference Tables page uses, so the
picker offers exactly the tables authored there. Its inputs are `search`, `mode`,
`filter`, `sort`, `limit`, `offset`; there is **no `tiering` input**, though rows do
carry `tiering`. Narrowing by tiering goes through the `filter` argument, not a
dedicated parameter.

## Credit Types

`activeOnly` is a **caller choice, not a permanent filter**. A retired type must
still RESOLVE for historical credits; it must never be OFFERED for a new rule. The
rule editors pass `true`.

The suite filters every case by a `KITFIX-` prefix because this object holds five
REAL records on tool. It asserts the real registry is still reachable without
asserting anything about its contents.

The stored value is `creditTypeCode`, never the name. The object's own description
spells out why: a rule writes a creditType and a measure reads one, so
`NEW_BOOKING` and `NEW_BOOKINGS` as free strings are two buckets — the rule fires,
credits are written, no measure sums them, and attainment is quietly low until
quarter end. That failure has no error and no zero.

## Attainment Measures

`periodType` (`Month` | `QTD` | `YTD`) rides along in the projection because the
editor renders the grain beside the Quota picker. A measure read at QTD and one
read at YTD are different questions.

Note for anyone reading the spec this was built from: there is no `Quarterly`
value. The editor shows what the record says.

## Quotas

A `Quota` is ONE position's target for ONE measure in ONE period, so `measureId` is
the filter that keeps the picker from offering targets against a measure the rule
does not read. The rule editor passes the measure already chosen.

**This one carries a modelling question that was raised and deliberately deferred**:
a payout rule applies to many people over many periods, so a rule that names a
single quota names one person's number. Keeping the picker was an explicit call;
the alternative is for the rule to name only the measure and let the engine resolve
each payee's own quota at run time.

## State on tool

`CreditType` has 5 records. `AttainmentMeasure`, `Quota` and `RateTable` have
**none**, so their pickers render an empty state rather than an empty dropdown.
That is the expected state until those are authored, not a fault.

All three data sources are created and **NOT DEPLOYED**, like the rest — they need
the application deploy that pulls its data sources in.
