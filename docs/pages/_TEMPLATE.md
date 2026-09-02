# Page | <Name>

<!-- Copy to docs/pages/<name-in-kebab-case>.md. Written before the page is
built, same as an automation spec. -->

**Built state**: not built.

| field | value |
|---|---|
| Route / id | |
| Platform page id | `e_…` — from the builder URL; what `/start` and `/restore` act on |
| Devkit session | `sessions/<who>/<timestamp>-session` in `ua-agent-devkit` |
| Audience | participant / manager / comp admin / finance / comp ops |
| Purpose | one sentence: the decision or task this page serves |
| Authorization | who may open it; what a user who may not see this data gets. The refusal happens in the CALLABLE, not in the page |

## Callables it invokes

| token | why this page calls it | statuses this page must handle |
|---|---|---|
| `ICM \| <Name>` | | `SUCCESS`, `FORBIDDEN`, … |

Each automation spec's **Callers** row names this page in return. Both sides, or
the dependency is invisible.

## Layout and states

- **Primary content**: what the user came for, above everything else.
- **Loading**: what shows while the calls are in flight.
- **Empty**: the new-customer and new-period case, which is what a demo hits.
- **Error**: per status, what the user is told and what they can do next.

## Drill-down path

Every amount on this page, and what it opens. If an amount cannot be drilled
into, say why here rather than leaving a dead end.

## Money and dates on screen

Which currency is shown, whether values are converted, and the as-of date for
every figure.

## Open questions

Named, with who owes the answer.

---

<!-- Before running /done in the devkit: everything above is filled in, and every
callable named in "Callables it invokes" has this page in its spec's Callers row.
The build is in the devkit; this file is the only record of the dependency. -->
