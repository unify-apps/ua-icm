# Page | Positions

**Built state (2026-09-03)**: **BUILT AND WORKING — the position list is live.**
The page at `/positions` reads `ICM | List Positions` through the `listPositions`
data source and renders real positions with their occupancy for the chosen date.
Verified in the live preview, not assumed — all six fixture positions appear with
the right state, including the two that matter most:

| position | shows | why that is correct |
|---|---|---|
| KITFIX-POS-01 / 02 | `OCCUPIED` with the payee's name | one assignment covers 2026-03-14 |
| **KITFIX-POS-03** | **`CONFLICT`**, no name | two assignments overlap that day — the callable refuses to pick, and the page shows the refusal |
| KITFIX-POS-04 | `VACANT` | never assigned |
| **KITFIX-POS-05** | `OCCUPIED`, name blank | the dangling `payeeId` degrades to an empty name rather than crashing the page |
| **KITFIX-POS-06** | `VACANT` | its assignment ended 2026-02-28, so on 2026-03-14 the position was empty. Effective dating, visible on screen |

Every value is a design-system token (`bg-workspace`, `text-tertiary`,
`text-xsm`, `gap-lg`), never a hex from the mockup. The empty state is hidden by
a real condition object on `total == 0`, so it appears only when there genuinely
are no positions.

**The data source was the hard part, and it was not an entitlement problem.**
`create_data_source` fails on orbit with `ENTITY_TYPE with id
e_data_source_deployed not found … check if you have the permissions`, which
reads like a missing grant. It is a hardcoded literal in the devkit's own tool:
orbit has `e_data_source`, not `e_data_source_deployed`, and a missing entity
type answers **HTTP 200 with an empty body** rather than 404. `scripts/ua-datasource.mjs`
probes for the type that exists instead of assuming one. Full evidence in
`notes/runtime-facts.md`.

**The list is a Table, and the detail panel is inline.** The card Repeatable was
replaced by a `Table` (`b_nTuid`) whose columns follow the Ledger prototype's
Positions screen: POSITION as code over name (`TEXT_DESCRIPTION`), PERSON,
EMPLOYEE ID, and OCCUPANCY as a `TAG` mapping `OCCUPIED`→success,
`VACANT`→gray ("Open seat"), `CONFLICT`→error. `TAG` rather than `STATUS`
deliberately: a maker cannot select `STATUS` from the column menu at all, so a
status column is config nobody on the team can later open and change.

**The detail is NOT a drawer, and that was not a choice.** The prototype opens a
right-hand drawer. `create_block` refuses every `Drawer` on this build —
`component.content.allowResize is not a Drawer content key` — and the key it
names is seeded by the block's own registry defaults, so the refusal fires with
`compose: false` too. The Drawer sheet lists `allowResize` in its key table and
omits it from the allowed `content` list; the validator sides with the shorter
list. Until that is fixed a Drawer cannot be created through this toolset at
all. The detail therefore renders as a panel below the table, revealed by a
condition on `selectedPositionId` having length. Moving it into a real Drawer
later is a re-parent, not a rebuild.

**Selecting a row triggers the resolve source explicitly.** `onRowSelect` writes
`var_ccGER` and then fires `controlDataSource` `trigger`. The trigger is not
belt-and-braces: with the setPageVariable alone the source ran **once** and never
again — three row clicks produced one `resolvePositionOccupant` call in the
network log, and the panel stayed on the first position it had answered. An
automatic source is documented to re-run when its bound inputs change; here it
did not, and the explicit trigger is what makes row-to-row selection work.

| field | value |
|---|---|
| Route / id | **`/seat-directory`** in app `sales-commission-management` — the address and the builder's page NAME are still the old ones. `update_page` refuses with a stale-version race (reads interface-record version N while the server is at N+1, and each attempt bumps it); three corrected attempts, same refusal. **Rename it by hand in the page settings panel.** Everything a user reads on the page already says Positions. |
| Platform page id | `e_6a988d297f7cff32ea8e8a4a` — what `/start` and `/restore` act on |
| Devkit session | `sessions/sarthak-ray/2026-09-03-0225-session` |
| Page variables | `var_jqj3Z` positionSearch · `var_xIGkZ` asOfDate · `var_ccGER` selectedPositionId |
| Data sources | `e_6a99098a7f7cff32ea921799` `listPositions` → `6a988a792ada0c631038457a`, automatic, runs on page load · `e_6a991e6dc6dbc2241dea9794` `resolvePositionOccupant` → `6a9879742ada0c631031e64b`, automatic, does NOT run on page load, triggered explicitly on row select |
| Key blocks | `b_DQZ7E` pageHeader · `b_1rH11` asOfControls · `b_EBwtj` positionListPanel holding `b_nTuid` positionsTable · `b_V22z8` detailStates holding the four banners and `b_OhEw4` detailFacts |
| Audience | comp ops, and comp admins |
| Purpose | Answer "who held this position on this date, and who holds it now" — and make a broken assignment visible instead of letting it surface later as a wrong payout. |
| Authorization | Any authenticated user of the app. **This page shows org structure, never money** — no amount, quota, attainment or payout appears on it. That is why it can be open, and it is the reason the callable it uses is open too. The moment a money column is wanted here, this row and the callable's Authorization row both change together, or the change is refused. |

## Why this page exists first

It is the cheapest possible proof of the whole stack — object → callable →
screen — and it exercises the decision the data model now rests on: that credit
attaches to a **position**, and the person is resolved *as of a date*. A screen where
you change the date and watch the occupant change is worth more than any amount
of prose about effective dating, because it is the thing a product person can
disagree with.

It also has no money on it, which makes it the right first page: the
authorization design can be reviewed on a page where being wrong is not
catastrophic.

## Callables it invokes

| token | why this page calls it | statuses this page must handle |
|---|---|---|
| `ICM \| List Positions` (`6a988a792ada0c631038457a`) | the position picker, the filter chips and the counts — **and each position's occupancy for the chosen date, resolved in bulk** | `OK` · `INVALID_INPUT` |
| `ICM \| Resolve Position Occupant` (`6a9879742ada0c631031e64b`) | the detail panel for the one position the user selected | `RESOLVED` → `b_OCqVU` · `VACANT` → `b_EHMr9` · `AMBIGUOUS` → `b_pEQmM` · `POSITION_NOT_FOUND` / `PAYEE_NOT_FOUND` / `INVALID_INPUT` → `b_tXXkU`, one banner carrying the callable's own `message`. Every status the contract can return has a banner; none falls through to a blank panel. |

**Why two callables and not one.** `List Positions` answers "what is the state of
these 50 positions" in three fetches; `Resolve Position Occupant` answers "tell me
everything about this ONE position" including the payee's currency and the exact
assignment window. Calling the second once per row would be the per-item-loop
trap; calling only the first would leave the detail panel without the fields it
shows. The list is the sweep, the detail is the drill.

The automation's spec (`docs/automations/resolve-position-occupant.md`) names this
page in its **Callers** row. Both sides, or the dependency is invisible — nothing
on the platform records that a page depends on an automation.

**The page never reads `Position`, `PayeePositionAssignment` or `Payee`
directly.** It could — they are storage objects and a data source over them
would be quicker to build. It does not, because the layer rule in
`docs/architecture.html` says authorization lives in the callable, and a page that
reaches around the callable for the easy case is a page that will reach around
it for the hard one. The position list itself is the one exception under review — see
Open questions.

## Layout and states

**Primary content.** A position picker and a date, then one answer panel. The date
defaults to today but is the most important control on the screen, so it is
placed beside the answer, not buried in a filter drawer.

| state | what shows |
|---|---|
| **Loading** | the answer panel skeletons; the position and date controls stay live so a slow call never traps the user on a stale query |
| **Empty** (no positions exist yet) | "No positions have been created." A new customer's first screen is empty, and it is what a demo hits first |
| **`RESOLVED`** | payee name, employee id, the assignment window (`effectiveStart` – `effectiveEnd`, or "– present" when open-ended), and the currency they are paid in |
| **`VACANT`** | "Nobody held **KITFIX-POS-01** on 15 Feb 2026." **Styled as information, not as an error** — a position being empty on a date is a normal fact about history, and colouring it red teaches people to ignore red |
| **`AMBIGUOUS`** | a warning panel: "2 overlapping assignments cover this date. This is a data problem — pay calculated from it would be wrong." Shows `matchCount` and links to the assignment records. This is the state the page exists to surface |
| **`PAYEE_NOT_FOUND`** | "This position's assignment points at a person who no longer exists." Same treatment as AMBIGUOUS — a data bug, shown as one |
| **`POSITION_NOT_FOUND`** | "That position no longer exists" — reachable via a stale bookmark or a deleted position |
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
themselves — `Resolve Position Occupant` returns `matchCount`, and `List Positions`
returns `occupancy: "CONFLICT"` with the same count. **Saying so is the point**
— it is a known gap with a named fix (a `conflicts[]` array on
`Resolve Position Occupant`'s result), not a detail to discover mid-build. Until it
lands, the conflict panel says how many and names the position, and the two people
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

1. ~~**How does the position picker get its list of positions?**~~ **ANSWERED
   2026-09-03: build the callable.** `ICM | List Positions`
   (`6a988a792ada0c631038457a`) exists, paged and searchable, and the layer rule
   stays absolute — **no data source over `Position` is created for this page,
   deliberately.** The decision was taken before the build rather than during
   it, which was the point of writing it down. If a data source over a comp
   object ever appears in this app, `get_data_sources` will show it and the rule
   was abandoned quietly.
2. **Should `AMBIGUOUS` be actionable from here** — a "fix assignments" link, or
   is that a separate comp-ops screen? Owner: product.
3. **The app is not on the UnifyApps Design System.** Measured from the live
   page: the ground is `oklch(0.995 0.002 250)` and the title
   `oklch(0.25 0.03 255)` — hue ~250-255 is the COOL palette. The published
   design system is warm (`brand-secondary-25` `#fbfaf9`, gray-900 `#201f1e`),
   and its own note says the 2026 retheme "moved it off cool gray". So the
   tokens this page stores are right and resolve correctly — they just resolve
   against the app's current theme, which is the pre-retheme one. Making the app
   match the design system is a THEME-level change (theme manager, app theme
   `e_6a8e91f922e51f30962be140`), not a per-block one, and doing it there fixes
   every page at once. Owner: needs a decision — it is not something to patch
   block by block.
4. **Does anyone need position *history*** ("show every occupant this position has had")
   rather than one date at a time? That is a different callable, not a bigger
   response from this one.

---

**Before `/done` in the devkit**: fill in the platform page id and session rows
above, and confirm `docs/automations/resolve-position-occupant.md` still names this
page in its Callers row.
