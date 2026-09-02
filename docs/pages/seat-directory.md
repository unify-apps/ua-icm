# Page | Seat Directory

**Built state**: **specified, not built.** The build runs **here** —
`/start <builder-url>` → build → update this file → `/done` — via
`scripts/page.mjs`, which drives the devkit's own bin scripts so the snapshot
and `/restore` guarantees are unchanged. Nothing has been created in the builder
yet, so the "Platform page id" and "Devkit session" rows below are deliberately
empty rather than guessed.

Its callable, `ICM | Resolve Seat Occupant`, **is deployed** as of 2026-09-03,
so this page has something real to call.

| field | value |
|---|---|
| Route / id | `seat-directory` in app `sales-commission-management` |
| Platform page id | — not built |
| Devkit session | — not built |
| Audience | comp ops, and comp admins |
| Purpose | Answer "who held this seat on this date, and who holds it now" — and make a broken assignment visible instead of letting it surface later as a wrong payout. |
| Authorization | Any authenticated user of the app. **This page shows org structure, never money** — no amount, quota, attainment or payout appears on it. That is why it can be open, and it is the reason the callable it uses is open too. The moment a money column is wanted here, this row and the callable's Authorization row both change together, or the change is refused. |

## Why this page exists first

It is the cheapest possible proof of the whole stack — object → callable →
screen — and it exercises the decision the data model now rests on: that credit
attaches to a **seat**, and the person is resolved *as of a date*. A screen where
you change the date and watch the occupant change is worth more than any amount
of prose about effective dating, because it is the thing a product person can
disagree with.

It also has no money on it, which makes it the right first page: the
authorization design can be reviewed on a page where being wrong is not
catastrophic.

## Callables it invokes

| token | why this page calls it | statuses this page must handle |
|---|---|---|
| `ICM \| List Seats` (`6a988a792ada0c631038457a`) | the seat picker, the filter chips and the counts — **and each seat's occupancy for the chosen date, resolved in bulk** | `OK` · `INVALID_INPUT` |
| `ICM \| Resolve Seat Occupant` (`6a9879742ada0c631031e64b`) | the detail panel for the one seat the user selected | `RESOLVED` · `VACANT` · `AMBIGUOUS` · `POSITION_NOT_FOUND` · `PAYEE_NOT_FOUND` · `INVALID_INPUT` |

**Why two callables and not one.** `List Seats` answers "what is the state of
these 50 seats" in three fetches; `Resolve Seat Occupant` answers "tell me
everything about this ONE seat" including the payee's currency and the exact
assignment window. Calling the second once per row would be the per-item-loop
trap; calling only the first would leave the detail panel without the fields it
shows. The list is the sweep, the detail is the drill.

The automation's spec (`docs/automations/resolve-seat-occupant.md`) names this
page in its **Callers** row. Both sides, or the dependency is invisible — nothing
on the platform records that a page depends on an automation.

**The page never reads `Position`, `PayeePositionAssignment` or `Payee`
directly.** It could — they are storage objects and a data source over them
would be quicker to build. It does not, because the layer rule in
`docs/architecture.md` says authorization lives in the callable, and a page that
reaches around the callable for the easy case is a page that will reach around
it for the hard one. The seat list itself is the one exception under review — see
Open questions.

## Layout and states

**Primary content.** A seat picker and a date, then one answer panel. The date
defaults to today but is the most important control on the screen, so it is
placed beside the answer, not buried in a filter drawer.

| state | what shows |
|---|---|
| **Loading** | the answer panel skeletons; the seat and date controls stay live so a slow call never traps the user on a stale query |
| **Empty** (no seats exist yet) | "No positions have been created." A new customer's first screen is empty, and it is what a demo hits first |
| **`RESOLVED`** | payee name, employee id, the assignment window (`effectiveStart` – `effectiveEnd`, or "– present" when open-ended), and the currency they are paid in |
| **`VACANT`** | "Nobody held **KITFIX-POS-01** on 15 Feb 2026." **Styled as information, not as an error** — a seat being empty on a date is a normal fact about history, and colouring it red teaches people to ignore red |
| **`AMBIGUOUS`** | a warning panel: "2 overlapping assignments cover this date. This is a data problem — pay calculated from it would be wrong." Shows `matchCount` and links to the assignment records. This is the state the page exists to surface |
| **`PAYEE_NOT_FOUND`** | "This seat's assignment points at a person who no longer exists." Same treatment as AMBIGUOUS — a data bug, shown as one |
| **`POSITION_NOT_FOUND`** | "That seat no longer exists" — reachable via a stale bookmark or a deleted seat |
| **`INVALID_INPUT`** | inline validation on the date control, using the callable's `message` verbatim rather than a second copy of the rule |

**Branch on `status`, never on the transport.** A 200 means the automation ran,
not that a person was found — four of the six statuses above arrive as a
perfectly healthy 200.

## Drill-down path

No amounts on this page, so the explainability rule applies in its structural
form rather than its money form:

- occupant → the `Payee` record
- the assignment window → the `PayeePositionAssignment` record behind it
- `AMBIGUOUS` → **both** conflicting assignments, because "which two?" is the
  only useful next question and a page that says "there are 2" without saying
  which two has moved the problem rather than surfaced it

This is a dead end today: neither callable returns the conflicting rows
themselves — `Resolve Seat Occupant` returns `matchCount`, and `List Seats`
returns `occupancy: "CONFLICT"` with the same count. **Saying so is the point**
— it is a known gap with a named fix (a `conflicts[]` array on
`Resolve Seat Occupant`'s result), not a detail to discover mid-build. Until it
lands, the conflict panel says how many and names the seat, and the two people
are found by opening the assignments.

## Money and dates on screen

No money. The payee's currency **code** is shown beside their name so the page
never implies a person is paid in the reader's currency — the callable resolves
the `Currency` lookup to a printable code precisely so the page does not have to
reach for the object itself.

Every answer is stamped with the as-of date it was computed for. A screenshot of
this page with no date on it is unreadable, and screenshots are how these
questions get escalated.

Dates display in the user's locale; the **query** is sent as `YYYY-MM-DD` and is
interpreted by the callable as midnight UTC. That rule lives in the automation
spec and must not be re-implemented here.

## Open questions

1. ~~**How does the seat picker get its list of seats?**~~ **ANSWERED
   2026-09-03: build the callable.** `ICM | List Seats`
   (`6a988a792ada0c631038457a`) exists, paged and searchable, and the layer rule
   stays absolute — **no data source over `Position` is created for this page,
   deliberately.** The decision was taken before the build rather than during
   it, which was the point of writing it down. If a data source over a comp
   object ever appears in this app, `get_data_sources` will show it and the rule
   was abandoned quietly.
2. **Should `AMBIGUOUS` be actionable from here** — a "fix assignments" link, or
   is that a separate comp-ops screen? Owner: product.
3. **Does anyone need seat *history*** ("show every occupant this seat has had")
   rather than one date at a time? That is a different callable, not a bigger
   response from this one.

---

**Before `/done` in the devkit**: fill in the platform page id and session rows
above, and confirm `docs/automations/resolve-seat-occupant.md` still names this
page in its Callers row.
